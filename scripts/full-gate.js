'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');
const { finished: streamFinished } = require('node:stream/promises');

const BODY_LABEL = 'DISCORD_SURFACE_GATE_BODY';
const SCRATCH_ROOT = 'DISCORD_SURFACE_GATE_SCRATCH';
const NO_VERDICT = 98;
const MARKER = 'APERTURE-GATE-INDETERMINATE';
const MESSAGES = Object.freeze({ READY: 'ready', ADMIT: 'admit', ADMISSION_EXIT: 'admission-exit', START: 'start', BODY_AUTH_REQUEST: 'body-auth-request', BODY_AUTHORIZED: 'body-authorized', BODY_EXIT: 'body-exit', CLOSE: 'close', DRAIN: 'drain', STOP: 'stop' });
const SETTINGS = Object.freeze({ COMMAND: 'APERTURE_GATE_ADMISSION_COMMAND', BUDGET: 'APERTURE_GATE_TIME_LEFT_S', SLOWEST: 'APERTURE_GATE_SLOWEST_RUN_S' });
const REASONS = Object.freeze({ CAPACITY: 'capacity', SETUP: 'queue-missing', ADMISSION: 'setup', STALE: 'stale', INTERRUPTED: 'interrupted', TIMEOUT: 'timeout', CLEANUP: 'cleanup' });

function noVerdict(reason, detail, scratch, output = 2) {
  if (scratch) {
    try { fs.closeSync(fs.openSync(path.join(scratch, 'declined'), 'wx', 0o600)); }
    catch (error) { if (error.code === 'EEXIST') return NO_VERDICT; }
  }
  try { fs.writeSync(output, MARKER + ' reason=' + reason + ': ' + String(detail).replace(/[\r\n]+/g, ' ') + '\n'); } catch {}
  return NO_VERDICT;
}

function canFinish(stopping) {
  return !stopping;
}

function releaseScratch(scratch) {
  if (!scratch) return true;
  try { fs.rmSync(scratch, { recursive: true, force: true }); return true; }
  catch (error) {
    try { fs.writeSync(2, 'GATE_SCRATCH_CLEANUP_FAILED ' + (error.code || 'UNKNOWN') + '\n'); } catch {}
    return false;
  }
}

function wholeSeconds(env, key, fallback) {
  const raw = env[key] || String(fallback);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(key + ' must be a positive whole number');
  return Number(raw);
}

function repositoryEnvironment() {
  const env = { ...process.env };
  const names = spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' });
  if (names.status !== 0) throw new Error('cannot isolate repository environment');
  for (const name of names.stdout.trim().split('\n')) delete env[name];
  return env;
}

function git(root, args, optional = false) {
  const env = { ...repositoryEnvironment(), LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };
  const result = spawnSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: 'utf8', env
  });
  if (result.status !== 0) {
    if (optional && !result.error) return null;
    throw new Error('cannot read the gate repository: ' + (result.stderr || result.error?.message || '').trim());
  }
  return result.stdout;
}

function revision(root) {
  const digest = crypto.createHash('sha256');
  const repositoryRoot = git(root, ['rev-parse', '--show-toplevel'], true);
  const isRepositoryRoot = repositoryRoot !== null
    && fs.realpathSync(repositoryRoot.replace(/(?:\r?\n)+$/, '')) === fs.realpathSync(root);
  const listed = isRepositoryRoot ? git(root, ['ls-files', '-c', '--others', '--exclude-standard', '-z'], true) : null;
  const archiveFiles = (directory, prefix = '') => fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    if (item.isDirectory() && item.name === '__pycache__') return [];
    if (!prefix && ['.git', 'node_modules', 'dist'].includes(item.name)) return [];
    const name = prefix + item.name;
    return item.isDirectory() ? archiveFiles(path.join(directory, item.name), name + '/') : [name];
  });
  const files = [...new Set(listed === null ? archiveFiles(root) : listed.split('\0').filter(Boolean))].sort();
  for (const file of files) {
    const absolute = path.join(root, file);
    digest.update(file + '\0');
    let stat;
    try { stat = fs.lstatSync(absolute); }
    catch (error) { if (error.code !== 'ENOENT') throw error; digest.update('missing\0'); continue; }
    digest.update(String(stat.mode) + '\0');
    if (stat.isSymbolicLink()) digest.update(fs.readlinkSync(absolute));
    else if (stat.isFile()) digest.update(fs.readFileSync(absolute));
    else throw new Error('unsupported source path: ' + file);
  }
  return JSON.stringify({
    head: git(root, ['rev-parse', '--verify', 'HEAD'], true)?.trim() || null,
    target: git(root, ['rev-parse', '--verify', 'origin/main'], true)?.trim() || null,
    index: git(root, ['ls-files', '--stage', '-z'], true), files: digest.digest('hex')
  });
}

function sameSource(before, after) {
  const expected = JSON.parse(before);
  const actual = JSON.parse(after);
  return ['head', 'index', 'files'].every(key => expected[key] === actual[key]);
}

function groupPeers(group) {
  const table = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  if (table.status !== 0) throw new Error('cannot inspect owned process group');
  return table.stdout.split('\n').map(line => line.trim().split(/\s+/)).filter(([pid, pgid, state]) =>
    Number(pgid) === group && Number(pid) !== table.pid && !state?.startsWith('Z'));
}

function relay(source, sink) {
  let held = '';
  source.setEncoding('utf8');
  source.on('data', chunk => {
    const text = held + chunk;
    let suffix = Math.min(text.length, MARKER.length - 1);
    while (suffix && !MARKER.startsWith(text.slice(-suffix))) suffix -= 1;
    held = suffix ? text.slice(-suffix) : '';
    if (!sink.destroyed) sink.write(text.slice(0, text.length - suffix).split(MARKER).join('CHILD-GATE-INDETERMINATE'));
  });
  source.on('end', () => { if (held && !sink.destroyed) sink.write(held); });
}

function requestBodyAuthorization(label) {
  if (typeof process.send !== 'function' || !process.connected) return Promise.resolve(false);
  return new Promise(resolve => {
    const finish = authorized => {
      process.removeListener('message', onMessage);
      process.removeListener('disconnect', onDisconnect);
      resolve(authorized);
    };
    const onMessage = message => {
      if (message?.kind !== MESSAGES.BODY_AUTHORIZED || message.label !== label) return;
      finish(message.authorized === true);
    };
    const onDisconnect = () => finish(false);
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
    process.send({ kind: MESSAGES.BODY_AUTH_REQUEST, label }, error => {
      if (error) finish(false);
    });
  });
}

async function runFullGate(root, label, entry, args, body) {
  if (process.env[BODY_LABEL] === label) {
    delete process.env[BODY_LABEL];
    if (await requestBodyAuthorization(label)) return await body();
  }
  let scratch;
  let declined = false;
  const decline = (reason, detail) => {
    if (!declined) { declined = true; noVerdict(reason, detail, scratch); }
    return NO_VERDICT;
  };
  const started = Date.now();
  const command = process.env[SETTINGS.COMMAND];
  if (!command) return decline(REASONS.SETUP, SETTINGS.COMMAND + ' is unset; nothing ran');
  if (process.platform === 'win32') return decline(REASONS.SETUP, 'a process-group gate supervisor is required on this host');
  let budget;
  let slowest;
  try {
    budget = wholeSeconds(process.env, SETTINGS.BUDGET, 7200);
    slowest = wholeSeconds(process.env, SETTINGS.SLOWEST, 3600);
  } catch (error) { process.stderr.write(error.message + '\n'); return 4; }
  const deadline = started + budget * 1000 - 5000;
  const maxWait = Math.floor((deadline - Date.now()) / 1000) - slowest;
  if (maxWait < 1) return decline(REASONS.CAPACITY, 'caller budget leaves no time for admission plus execution');
  let worker;
  let workerExit;
  let bodyStarted = false;
  let bodyFinished = false;
  let stopped;
  let timer;
  let outputDrain;
  let outputTimer;
  let finishOutputWait;
  const stop = signal => {
    stopped ||= signal;
    finishOutputWait?.(false);
    if (worker?.connected) worker.send({ kind: MESSAGES.STOP });
  };
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => {
    const handler = () => stop(signal); process.on(signal, handler); return [signal, handler];
  });
  const runAdmission = argv => new Promise(resolve => {
    const received = message => {
      if (message.kind === MESSAGES.ADMISSION_EXIT) {
        worker.removeListener('message', received);
        resolve(message);
      }
    };
    worker.on('message', received);
    workerExit.then(() => { worker.removeListener('message', received); resolve({ code: NO_VERDICT, interrupted: true }); });
    worker.send({ kind: MESSAGES.ADMIT, command, args: argv });
  });
  try {
    const premise = revision(root);
    const snapshot = JSON.parse(premise);
    const branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true)?.trim() || 'detached';
    const repository = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], true)?.trim() || fs.realpathSync(root);
    const ticket = 'discord:' + label + ':' + crypto.createHash('sha256').update(repository + '\0' + branch + '\0' + (snapshot.head || snapshot.files)).digest('hex').slice(0, 32);
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-gate-'));
    worker = fork(path.join(__dirname, 'full-gate-worker.js'), [String(deadline), entry, ...args], {
      cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc', 2], env: { ...repositoryEnvironment(), [BODY_LABEL]: label, [SCRATCH_ROOT]: scratch }
    });
    relay(worker.stdout, process.stdout); relay(worker.stderr, process.stderr);
    outputDrain = Promise.all([streamFinished(worker.stdout, { cleanup: true }), streamFinished(worker.stderr, { cleanup: true })]).then(() => true, () => false);
    workerExit = new Promise(resolve => {
      worker.once('error', error => resolve({ error }));
      worker.once('exit', (code, signal) => resolve({ code, signal }));
    });
    timer = setTimeout(() => stop(REASONS.TIMEOUT), Math.max(1, deadline - Date.now()));
    const ready = await Promise.race([
      new Promise(resolve => worker.on('message', message => { if (message.kind === MESSAGES.READY) resolve(message); })),
      workerExit.then(() => null)
    ]);
    if (!ready || stopped) return decline(REASONS.INTERRUPTED, stopped || 'watchdog unavailable; nothing ran');
    const admitted = await runAdmission(['discord-surface-' + label, '--full-gate', '--holder', String(ready.holder), '--max-wait', String(maxWait), '--ticket', ticket]);
    if (stopped) return decline(stopped === REASONS.TIMEOUT ? REASONS.TIMEOUT : REASONS.INTERRUPTED, stopped + ' before admission; nothing ran');
    if (admitted.interrupted) return decline(REASONS.INTERRUPTED, 'worker exited during admission; nothing ran');
    if (admitted.code === 4) return 4;
    if (admitted.error) return decline(REASONS.SETUP, admitted.error + '; nothing ran');
    if (admitted.code === 3) return decline(REASONS.CAPACITY, 'not admitted; nothing ran');
    if (admitted.code !== 0) {
      const reason = admitted.code == null ? REASONS.INTERRUPTED : REASONS.ADMISSION;
      const outcome = admitted.code == null ? 'signal' : 'exit ' + admitted.code;
      return decline(reason, 'admission ended unexpectedly (' + outcome + '); nothing ran');
    }
    if (revision(root) !== premise) return decline(REASONS.STALE, 'source changed during admission; nothing ran');
    const captured = JSON.parse(premise);
    process.stdout.write('FULL_GATE_SOURCE=' + JSON.stringify({ head: captured.head, target: captured.target, source: captured.files }) + '\n');
    const finished = new Promise(resolve => worker.on('message', message => {
      if (message.kind === MESSAGES.BODY_EXIT) { bodyFinished = true; resolve(message); }
    }));
    worker.send({ kind: MESSAGES.START }); bodyStarted = true;
    const result = await Promise.race([finished, workerExit.then(value => ({ workerExited: true, signal: value.signal }))]);
    if (stopped || result.workerExited) return decline(stopped === REASONS.TIMEOUT ? REASONS.TIMEOUT : REASONS.INTERRUPTED, stopped || result.signal || 'worker exited before reporting the body result');
    if (!sameSource(premise, revision(root))) return decline(REASONS.STALE, 'source changed during execution');
    return result.code;
  } catch (error) { return decline(REASONS.SETUP, error.message); }
  finally {
    if (worker) {
      if (bodyStarted && !bodyFinished) stop(stopped || REASONS.INTERRUPTED);
      else {
        if (worker.connected) worker.send({ kind: MESSAGES.CLOSE });
      }
      const closed = await workerExit;
      let peers;
      try { peers = groupPeers(worker.pid); } catch { peers = [null]; }
      const hadPeers = peers.length > 0;
      if (peers.length) {
        try { process.kill(-worker.pid, 'SIGKILL'); } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
        try { peers = groupPeers(worker.pid); } catch { peers = [null]; }
      }
      if (closed.code !== 0 || hadPeers || peers.length) {
        worker.stdout.destroy(); worker.stderr.destroy();
        const code = decline(REASONS.INTERRUPTED, 'owned process group did not finish cleanly');
        releaseScratch(scratch);
        clearTimeout(timer);
        for (const [signal, handler] of handlers) process.removeListener(signal, handler);
        return code;
      }
      if (!releaseScratch(scratch)) {
        worker.stdout.destroy(); worker.stderr.destroy();
        clearTimeout(timer);
        for (const [signal, handler] of handlers) process.removeListener(signal, handler);
        return decline(REASONS.CLEANUP, 'owned scratch removal failed; teardown completed');
      }
      const drained = await Promise.race([outputDrain, new Promise(resolve => {
        finishOutputWait = resolve;
        outputTimer = setTimeout(() => resolve(false), Math.max(1, deadline - Date.now()));
        if (stopped) resolve(false);
      })]);
      clearTimeout(outputTimer); finishOutputWait = undefined;
      if (!drained || Date.now() >= deadline) {
        worker.stdout.destroy(); worker.stderr.destroy();
        const reason = stopped && stopped !== REASONS.TIMEOUT ? REASONS.INTERRUPTED : REASONS.TIMEOUT;
        const code = decline(reason, 'owned output did not finish within the gate deadline');
        releaseScratch(scratch);
        clearTimeout(timer);
        for (const [signal, handler] of handlers) process.removeListener(signal, handler);
        return code;
      }
    }
    const released = releaseScratch(scratch);
    clearTimeout(timer);
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    if (!released) return decline(REASONS.CLEANUP, 'owned scratch removal failed; teardown completed');
  }
}

module.exports = { canFinish, releaseScratch, noVerdict, REASONS, runFullGate, BODY_LABEL, SCRATCH_ROOT, NO_VERDICT, MESSAGES, revision, relay, groupPeers };
