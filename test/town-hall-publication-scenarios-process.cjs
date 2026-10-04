'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const selfDestruct = setTimeout(() => process.exit(1), workerData.timeoutMs);
selfDestruct.unref();
let state = null;
try {
  const { SurfaceState } = require(workerData.statePath);
  state = new SurfaceState(workerData.dbPath);
  const result = state.reserveTownHallPublication(workerData.journalKey);
  parentPort.postMessage({
    ok: true,
    claimed: result.claimed,
    status: result.publication.status,
    attemptId: result.publication.attemptId
  });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    kind: error && error.constructor ? error.constructor.name : null,
    message: error && error.message ? error.message : String(error)
  });
} finally {
  clearTimeout(selfDestruct);
  if (state) { try { state.close(); } catch {} }
}
`;

const CHILD_SOURCE = `
// The referenced self-destruct timer is armed BEFORE any require so a child
// that hangs in module loading or holds the reservation cannot outlive its
// deadline. It is cleared only on actual normal completion.
const CHILD_DEADLINE_MS = Number(process.env.DOWN_CHILD_DEADLINE_MS || 8000);
const selfDestruct = setTimeout(() => {
  process.stderr.write('publication child deadline elapsed before completion');
  process.exit(97);
}, CHILD_DEADLINE_MS);
let state = null;
let result = null;
let failed = false;
try {
  const { SurfaceState } = require(process.env.DOWN_STATE);
  state = new SurfaceState(process.env.DOWN_DB);
  const reserved = state.reserveTownHallPublication(process.env.DOWN_JOURNAL_KEY);
  result = {
    claimed: reserved.claimed,
    status: reserved.publication.status,
    attemptId: reserved.publication.attemptId,
    journalKey: reserved.publication.journalKey
  };
} catch (error) {
  failed = true;
  process.stderr.write(String((error && error.stack) || error));
} finally {
  if (state) { try { state.close(); } catch {} }
}
if (failed) {
  // The failure path exits immediately; the timer stays armed (never cleared).
  process.exit(1);
} else if (process.env.DOWN_CHILD_KEEP_ALIVE === '1') {
  // Fixture keeps the child alive until the self-destruct deadline or SIGKILL.
} else {
  if (process.env.DOWN_CHILD_EMPTY_OUTPUT !== '1') {
    process.stdout.write(JSON.stringify(result));
  }
  clearTimeout(selfDestruct);
}
`;

function reserveWithChild(dbPath, journalKey, options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? 10000 : options.timeoutMs;
  const childDeadlineMs = options.childDeadlineMs === undefined ? 8000 : options.childDeadlineMs;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, ['-e', CHILD_SOURCE], {
        env: {
          ...process.env,
          DOWN_DB: dbPath,
          DOWN_JOURNAL_KEY: journalKey,
          DOWN_STATE: require.resolve('../src/state'),
          DOWN_CHILD_DEADLINE_MS: String(childDeadlineMs),
          DOWN_CHILD_KEEP_ALIVE: options.keepAlive ? '1' : '0',
          DOWN_CHILD_EMPTY_OUTPUT: options.emptyOutput ? '1' : '0'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      // A synchronous spawn failure has no PID, so there is nothing to reap.
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let spawnError = null;
    let killError = null;
    let timer = null;
    let stdoutEnded = false;
    let stderrEnded = false;
    // `closeObserved` is set only by the event-loop 'close' event, never by the
    // timeout callback and never by 'exit'. It is captured at settle time, so a
    // rejection that fires before 'close' carries closeObserved === false.
    let closeObserved = false;

    // The fixture database state is untouched until the child 'close' event
    // proves the process has actually exited and been reaped.
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const fail = error => {
      if (child.pid !== undefined) error.pid = child.pid;
      error.closeObserved = closeObserved && stdoutEnded && stderrEnded;
      settle(reject, error);
    };
    const requestKill = () => {
      try {
        if (!child.kill('SIGKILL')) {
          killError = new Error('child.kill(SIGKILL) returned false');
        }
      } catch (error) {
        killError = error;
      }
    };

    // The parent deadline starts at spawn. It records the timeout and requests
    // SIGKILL, but never settles: only 'close' proves the child exited.
    timer = setTimeout(() => {
      timedOut = true;
      requestKill();
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('end', () => { stdoutEnded = true; });
    child.stderr.on('end', () => { stderrEnded = true; });
    // Independent close observation registered before the settling handler so
    // the marker is already true when the genuine 'close' handler runs.
    child.once('close', () => { closeObserved = true; });

    // A spawn error without a PID settles safely with no kill. With a PID the
    // reap obligation remains and 'close' settles the promise.
    child.once('error', error => {
      spawnError = error;
      if (child.pid === undefined) fail(error);
    });

    child.once('close', (code, signal) => {
      if (timedOut) {
        const killNote = killError ? `; kill failed: ${killError.message}` : '';
        const spawnNote = spawnError ? `; spawn error: ${spawnError.message}` : '';
        fail(new Error(
          `publication child reservation timed out after ${timeoutMs}ms (code ${code} signal ${signal})`
          + `${killNote}${spawnNote}`
        ));
        return;
      }
      if (spawnError) {
        fail(spawnError);
        return;
      }
      if (code !== 0) {
        fail(new Error(`publication child exited code ${code} signal ${signal}: ${stderr}`));
        return;
      }
      const output = stdout.trim();
      if (output === '') {
        fail(new Error(`publication child produced unusable output ${JSON.stringify(stdout)}: empty output`));
        return;
      }
      try {
        settle(resolve, { pid: child.pid, result: JSON.parse(output) });
      } catch (error) {
        fail(new Error(`publication child produced unusable output ${JSON.stringify(stdout)}: ${error.message}`));
      }
    });
  });
}

// Bounded ESRCH proof: after a rejection, the child PID must be gone.
async function waitForChildGone(pid, label) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      assert.equal(error.code, 'ESRCH', `${label}: expected ESRCH for pid ${pid}, got ${error.code || error.message}`);
      return;
    }
    if (Date.now() >= deadline) {
      assert.fail(`${label}: pid ${pid} still exists after rejection`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

module.exports = { reserveWithChild, waitForChildGone, WORKER_SOURCE, CHILD_SOURCE };
