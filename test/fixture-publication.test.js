'use strict';

// Issue 119 fixture-publication rung. These two cases are deliberately red until
// test/fixture-publication.js exists and publishes atomically. They run the raw
// writeFileSync fallback, whose write window is still observable, so the negative
// assertion fails with a real AssertionError instead of a timeout.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const OWNER_MODULE = path.join(__dirname, 'fixture-publication.js');

function buildWorkerSource() {
  return `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, finalPath, payloadKind, releaseBuffer, ownerModule } = workerData;

function selectPublisher() {
  if (fs.existsSync(ownerModule)) {
    const mod = require(ownerModule);
    return (file, text) => mod.publishFixtureFile(file, text);
  }
  return (file, text) => fs.writeFileSync(file, text);
}
const publishFixtureFile = selectPublisher();

const cell = new Int32Array(releaseBuffer);
const originalOpenSync = fs.openSync;
const originalWriteFileSync = fs.writeFileSync;
let intercepted = false;

function isUnderTempDir(file) {
  try {
    return path.dirname(path.resolve(String(file))) === path.resolve(tempDir);
  } catch {
    return false;
  }
}

fs.openSync = function wrappedOpenSync(file, flags, mode) {
  const fd = originalOpenSync.call(fs, file, flags, mode);
  if (!intercepted && isUnderTempDir(file)) {
    intercepted = true;
    parentPort.postMessage({ type: 'partial-write', pid: process.pid });
    Atomics.wait(cell, 0, 0, 3000);
  }
  return fd;
};

fs.writeFileSync = function wrappedWriteFileSync(file, data, options) {
  if (!intercepted && isUnderTempDir(file)) {
    const flag = options && typeof options === 'object' && options.flag ? options.flag : 'w';
    const fd = fs.openSync(file, flag);
    try {
      fs.writeSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    return;
  }
  return originalWriteFileSync.call(fs, file, data, options);
};

const selfDeadline = setTimeout(() => { process.exit(0); }, 4000);
try {
  if (payloadKind === 'pid') {
    publishFixtureFile(finalPath, String(process.pid));
  } else if (payloadKind === 'json') {
    publishFixtureFile(finalPath, JSON.stringify({ ready: true, pid: process.pid }));
  } else {
    throw new Error('unknown payloadKind: ' + payloadKind);
  }
} finally {
  clearTimeout(selfDeadline);
}
`;
}

async function race(tempDir, kind) {
  const finalPath = path.join(tempDir, kind === 'pid' ? 'runtime.pid' : 'runtime.json');
  const releaseBuffer = new SharedArrayBuffer(4);
  const cell = new Int32Array(releaseBuffer);
  let worker;
  let observedDuringWindow;
  let workerPid;
  let released = false;

  const release = () => {
    if (!released) {
      released = true;
      Atomics.store(cell, 0, 1);
      Atomics.notify(cell, 0);
    }
  };

  try {
    worker = new Worker(buildWorkerSource(), {
      eval: true,
      workerData: { tempDir, finalPath, payloadKind: kind, releaseBuffer, ownerModule: OWNER_MODULE },
    });

    await new Promise((resolve, reject) => {
      const onMessage = (msg) => {
        if (msg && msg.type === 'partial-write') {
          if (workerPid === undefined) workerPid = msg.pid;
          observedDuringWindow = fs.existsSync(finalPath);
          release();
        }
      };
      const onError = (err) => {
        release();
        reject(err);
      };
      const onExit = (code) => {
        release();
        if (code === 0) resolve();
        else reject(new Error('worker exited with code ' + code));
      };
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
    });
  } finally {
    if (worker) {
      worker.removeAllListeners('message');
      worker.removeAllListeners('error');
      worker.removeAllListeners('exit');
      await worker.terminate();
    }
  }

  return { finalPath, observedDuringWindow, workerPid };
}

test('atomic fixture PID publication hides its pathname until complete', { todo: 'issue119 atomic fixture publication is not implemented', timeout: 8000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-pub-pid-'));
  try {
    const result = await race(tempDir, 'pid');
    assert.equal(result.observedDuringWindow, false);
    const parsed = Number.parseInt(fs.readFileSync(result.finalPath, 'utf8'), 10);
    assert.ok(Number.isInteger(parsed) && parsed > 0);
    assert.equal(parsed, result.workerPid);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('atomic fixture JSON publication hides its pathname until complete', { todo: 'issue119 atomic fixture publication is not implemented', timeout: 8000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-pub-json-'));
  try {
    const result = await race(tempDir, 'json');
    assert.equal(result.observedDuringWindow, false);
    const parsed = JSON.parse(fs.readFileSync(result.finalPath, 'utf8'));
    assert.deepEqual(parsed, { ready: true, pid: result.workerPid });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
