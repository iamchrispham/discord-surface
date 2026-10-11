'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');
const { finished: streamFinished } = require('node:stream/promises');

const BODY_LABEL = 'DISCORD_SURFACE_GATE_BODY';
const BODY_TOKEN = 'DISCORD_SURFACE_GATE_BODY_TOKEN';
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

function digestField(digest, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  digest.update(length);
  digest.update(bytes);
}

function revision(root) {
  const digest = crypto.createHash('sha256');
  const realRoot = fs.realpathSync(root);
  const repositoryRoot = git(root, ['rev-parse', '--show-toplevel'], true);
  const isRepositoryRoot = repositoryRoot !== null
    && fs.realpathSync(repositoryRoot.replace(/(?:\r?\n)+$/, '')) === realRoot;
  const listed = isRepositoryRoot ? git(root, ['ls-files', '-c', '--others', '--exclude-standard', '-z'], true) : null;
  const archiveFiles = (directory, prefix = '') => fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    if (item.isDirectory() && item.name === '__pycache__') return [];
    if (!prefix && ['.git', 'node_modules', 'dist'].includes(item.name)) return [];
    const name = prefix + item.name;
    return item.isDirectory() ? archiveFiles(path.join(directory, item.name), name + '/') : [name];
  });
  const files = [...new Set(listed === null ? archiveFiles(root) : listed.split('\0').filter(Boolean))].sort();
  const fileSet = new Set(files);
  for (const file of files) {
    const absolute = path.join(root, file);
    digestField(digest, 'entry');
    digestField(digest, file);
    let stat;
    try { stat = fs.lstatSync(absolute); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      digestField(digest, 'missing');
      continue;
    }
    digestField(digest, String(stat.mode));
    if (stat.isSymbolicLink()) {
      let resolved;
      let targetStat;
      try {
        resolved = fs.realpathSync(absolute);
        targetStat = fs.statSync(absolute);
      } catch {
        throw new Error('unsupported source symlink: ' + file);
      }
      const relativeTarget = path.relative(realRoot, resolved);
      const targetName = relativeTarget.split(path.sep).join('/');
      const remainsInside = relativeTarget !== ''
        && relativeTarget !== '..'
        && !relativeTarget.startsWith('..' + path.sep)
        && !path.isAbsolute(relativeTarget);
      if (!remainsInside || !targetStat.isFile() || !fileSet.has(targetName)) {
        throw new Error('unsupported source symlink: ' + file);
      }
      digestField(digest, 'symlink');
      digestField(digest, fs.readlinkSync(absolute));
      digestField(digest, targetName);
    } else if (stat.isFile()) {
      digestField(digest, 'file');
      digestField(digest, fs.readFileSync(absolute));
    } else throw new Error('unsupported source path: ' + file);
  }
  const branch = isRepositoryRoot
    ? git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true)?.trim() || null
    : null;
  const commonDirectory = isRepositoryRoot
    ? git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], true)?.trim()
    : null;
  const repository = commonDirectory ? fs.realpathSync(commonDirectory) : realRoot;
  return JSON.stringify({
    kind: isRepositoryRoot ? 'git' : 'archive',
    head: isRepositoryRoot ? git(root, ['rev-parse', '--verify', 'HEAD'], true)?.trim() || null : null,
    target: isRepositoryRoot ? git(root, ['rev-parse', '--verify', 'origin/main'], true)?.trim() || null : null,
    index: isRepositoryRoot ? git(root, ['ls-files', '--stage', '-z'], true) : null,
    branch,
    repository,
    files: digest.digest('hex')
  });
}

function sameSource(before, after) {
  const expected = JSON.parse(before);
  const actual = JSON.parse(after);
  return ['kind', 'head', 'index', 'branch', 'repository', 'files'].every(key => expected[key] === actual[key]);
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

function requestBodyAuthorization(label, token) {
  if (!token) return { promise: Promise.resolve({ authorized: false, disconnected: false }), cancel() {} };
  if (typeof process.send !== 'function' || !process.connected) {
    return { promise: Promise.resolve({ authorized: false, disconnected: true }), cancel() {} };
  }
  let resolvePromise;
  let settled = false;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  const finish = result => {
    if (settled) return;
    settled = true;
    process.removeListener('message', onMessage);
    process.removeListener('disconnect', onDisconnect);
    resolvePromise(result);
  };
  const onMessage = message => {
    if (message?.kind !== MESSAGES.BODY_AUTHORIZED || message.label !== label) return;
    finish({ authorized: message.authorized === true && message.token === token, disconnected: false });
  };
  const onDisconnect = () => finish({ authorized: false, disconnected: true });
  process.on('message', onMessage);
  process.once('disconnect', onDisconnect);
  try {
    process.send({ kind: MESSAGES.BODY_AUTH_REQUEST, label }, error => {
      if (error) finish({ authorized: false, disconnected: true });
    });
  } catch {
    finish({ authorized: false, disconnected: true });
  }
  return {
    promise,
    cancel() { finish({ authorized: false, disconnected: true }); }
  };
}

async function runFullGate(root, label, entry, args, body) {
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
  let worker;
  let workerExit;
  let bodyStarted = false;
  let bodyFinished = false;
  let authorizedBodyStarted = false;
  let stopped;
  let timer;
  let outputDrain;
  let outputTimer;
  let finishOutputWait;
  let authorizationWait;
  let ticket;
  const stop = signal => {
    stopped ||= signal;
    authorizationWait?.();
    finishOutputWait?.(false);
    if (worker?.connected) worker.send({ kind: MESSAGES.STOP });
  };
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => {
    const handler = () => stop(signal); process.on(signal, handler); return [signal, handler];
  });
  const onDisconnect = () => stop(REASONS.INTERRUPTED);
  process.on('disconnect', onDisconnect);
  timer = setTimeout(() => stop(REASONS.TIMEOUT), Math.max(1, deadline - Date.now()));
  const runAdmission = () => new Promise(resolve => {
    const received = message => {
      if (message.kind === MESSAGES.ADMISSION_EXIT) {
        worker.removeListener('message', received);
        resolve(message);
      }
    };
    worker.on('message', received);
    workerExit.then(() => { worker.removeListener('message', received); resolve({ code: NO_VERDICT, interrupted: true }); });
    const maxWait = Math.floor((deadline - Date.now()) / 1000) - slowest;
    if (maxWait < 1) {
      worker.removeListener('message', received);
      resolve({ capacity: true });
      return;
    }
    worker.send({
      kind: MESSAGES.ADMIT,
      command,
      args: ['discord-surface-' + label, '--full-gate', '--holder', String(worker.pid), '--max-wait', String(maxWait), '--ticket', ticket]
    });
  });
  try {
    if (process.env[BODY_LABEL] === label) {
      const token = process.env[BODY_TOKEN];
      delete process.env[BODY_LABEL];
      delete process.env[BODY_TOKEN];
      if (token) {
        const authorization = requestBodyAuthorization(label, token);
        authorizationWait = authorization.cancel;
        const result = await authorization.promise;
        authorizationWait = undefined;
        if (stopped) return decline(stopped === REASONS.TIMEOUT ? REASONS.TIMEOUT : REASONS.INTERRUPTED, stopped + ' before body authorization');
        if (result.disconnected) return decline(REASONS.INTERRUPTED, 'parent disconnected before body authorization');
        if (result.authorized) {
          clearTimeout(timer);
          for (const [signal, handler] of handlers) process.removeListener(signal, handler);
          process.removeListener('disconnect', onDisconnect);
          authorizedBodyStarted = true;
          return await body();
        }
      }
    }
    if (stopped) return decline(stopped === REASONS.TIMEOUT ? REASONS.TIMEOUT : REASONS.INTERRUPTED, stopped + ' before admission; nothing ran');
    if (Math.floor((deadline - Date.now()) / 1000) - slowest < 1) {
      return decline(REASONS.CAPACITY, 'caller budget leaves no time for admission plus execution');
    }
    const premise = revision(root);
    const snapshot = JSON.parse(premise);
    const branchIdentity = snapshot.kind === 'archive'
      ? 'archive'
      : snapshot.branch === null ? 'detached' : 'branch:' + snapshot.branch;
    ticket = 'discord:' + label + ':' + crypto.createHash('sha256').update(snapshot.repository + '\0' + branchIdentity + '\0' + (snapshot.head || snapshot.files)).digest('hex').slice(0, 32);
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-gate-'));
    const bodyToken = crypto.randomBytes(32).toString('hex');
    worker = fork(path.join(__dirname, 'full-gate-worker.js'), [String(deadline), entry, ...args], {
      cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc', 2], env: { ...repositoryEnvironment(), [BODY_LABEL]: label, [BODY_TOKEN]: bodyToken, [SCRATCH_ROOT]: scratch }
    });
    relay(worker.stdout, process.stdout); relay(worker.stderr, process.stderr);
    outputDrain = Promise.all([streamFinished(worker.stdout, { cleanup: true }), streamFinished(worker.stderr, { cleanup: true })]).then(() => true, () => false);
    workerExit = new Promise(resolve => {
      worker.once('error', error => resolve({ error }));
      worker.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const ready = await Promise.race([
      new Promise(resolve => worker.on('message', message => { if (message.kind === MESSAGES.READY) resolve(message); })),
      workerExit.then(() => null)
    ]);
    if (!ready || stopped) {
      const reason = stopped === REASONS.TIMEOUT ? REASONS.TIMEOUT : REASONS.INTERRUPTED;
      return decline(reason, stopped || 'watchdog unavailable; nothing ran');
    }
    const admitted = await runAdmission();
    if (stopped) return decline(stopped === REASONS.TIMEOUT ? REASONS.TIMEOUT : REASONS.INTERRUPTED, stopped + ' before admission; nothing ran');
    if (admitted.capacity) return decline(REASONS.CAPACITY, 'caller budget leaves no time for admission plus execution');
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
  } catch (error) {
    if (authorizedBodyStarted) throw error;
    return decline(REASONS.SETUP, error.message);
  }
  finally {
    process.removeListener('disconnect', onDisconnect);
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

module.exports = { canFinish, releaseScratch, noVerdict, REASONS, runFullGate, BODY_LABEL, BODY_TOKEN, SCRATCH_ROOT, NO_VERDICT, MESSAGES, revision, relay, groupPeers };
