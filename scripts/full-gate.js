'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');
const { finished: streamFinished } = require('node:stream/promises');

const SCRATCH_ROOT = 'DISCORD_SURFACE_GATE_SCRATCH';
const NO_VERDICT_SECRET = 'DISCORD_SURFACE_GATE_NO_VERDICT_SECRET';
const NO_VERDICT = 98;
const MARKER = 'APERTURE-GATE-INDETERMINATE';
const MESSAGES = Object.freeze({ READY: 'ready', ADMIT: 'admit', ADMISSION_EXIT: 'admission-exit', START: 'start', BODY_EXIT: 'body-exit', CLOSE: 'close', DRAIN: 'drain', STOP: 'stop' });
const SETTINGS = Object.freeze({ COMMAND: 'APERTURE_GATE_ADMISSION_COMMAND', BUDGET: 'APERTURE_GATE_TIME_LEFT_S', SLOWEST: 'APERTURE_GATE_SLOWEST_RUN_S' });
const REASONS = Object.freeze({ CAPACITY: 'capacity', SETUP: 'queue-missing', ADMISSION: 'setup', STALE: 'stale', INTERRUPTED: 'interrupted', TIMEOUT: 'timeout', CLEANUP: 'cleanup' });

function nodeOptionTokens(value) {
  const tokens = [];
  let quoted = false;
  let fresh = true;
  for (let index = 0; index < value.length; index += 1) {
    let character = value[index];
    if (character === '\\' && quoted) {
      if (++index === value.length) throw new Error('invalid escape in NODE_OPTIONS');
      character = value[index];
    } else if (character === ' ' && !quoted) {
      fresh = true;
      continue;
    } else if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (fresh) { tokens.push(character); fresh = false; }
    else tokens[tokens.length - 1] += character;
  }
  if (quoted) throw new Error('unterminated string in NODE_OPTIONS');
  return tokens;
}

function hasNodePreload(value) {
  const preloadOptions = ['--require', '--import', '-r', '--experimental-loader', '--loader'];
  return nodeOptionTokens(value).some(token => preloadOptions.some(option => token === option || token.startsWith(option + '=')));
}

function noVerdict(reason, detail, scratch, output = 2, secret = process.env[NO_VERDICT_SECRET]) {
  if (scratch && secret) {
    const sentinel = path.join(scratch, 'declined-' + crypto.createHmac('sha256', secret).update('gate-no-verdict').digest('hex'));
    try { fs.closeSync(fs.openSync(sentinel, 'wx', 0o600)); }
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

function deadlineError() {
  const error = new Error('source verification exceeded the gate deadline');
  error.code = 'ETIMEDOUT';
  return error;
}

function repositoryEnvironment(deadline) {
  const env = { ...process.env };
  const options = { encoding: 'utf8' };
  if (deadline !== undefined) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw deadlineError();
    options.timeout = Math.ceil(remaining);
  }
  const names = spawnSync('git', ['rev-parse', '--local-env-vars'], options);
  if (names.error?.code === 'ETIMEDOUT') throw names.error;
  if (names.status !== 0) throw new Error('cannot isolate repository environment');
  if (deadline !== undefined && Date.now() >= deadline) throw deadlineError();
  for (const name of names.stdout.trim().split('\n')) delete env[name];
  return env;
}

function git(root, args, optional = false, deadline) {
  const env = { ...repositoryEnvironment(deadline), LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };
  const options = { encoding: 'utf8', env };
  if (deadline !== undefined) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw deadlineError();
    options.timeout = Math.ceil(remaining);
  }
  const result = spawnSync('git', ['--no-optional-locks', '-C', root, ...args], options);
  if (result.error?.code === 'ETIMEDOUT') throw result.error;
  if (result.status !== 0) {
    if (optional && !result.error) return null;
    throw new Error('cannot read the gate repository: ' + (result.stderr || result.error?.message || '').trim());
  }
  if (deadline !== undefined && Date.now() >= deadline) throw deadlineError();
  return result.stdout;
}

function digestField(digest, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  digest.update(length);
  digest.update(bytes);
}

function revision(root, deadline) {
  const checkDeadline = () => {
    if (deadline !== undefined && Date.now() >= deadline) throw deadlineError();
  };
  checkDeadline();
  const digest = crypto.createHash('sha256');
  const realRoot = fs.realpathSync(root);
  checkDeadline();
  const repositoryRoot = git(root, ['rev-parse', '--show-toplevel'], true, deadline);
  const isRepositoryRoot = repositoryRoot !== null
    && fs.realpathSync(repositoryRoot.replace(/(?:\r?\n)+$/, '')) === realRoot;
  checkDeadline();
  const listed = isRepositoryRoot ? git(root, ['ls-files', '-c', '--others', '--exclude-standard', '-z'], true, deadline) : null;
  const archiveFiles = (directory, prefix = '') => fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    checkDeadline();
    if (item.isDirectory() && item.name === '__pycache__') return [];
    if (!prefix && ['.git', 'node_modules', 'dist'].includes(item.name)) return [];
    const name = prefix + item.name;
    return item.isDirectory() ? archiveFiles(path.join(directory, item.name), name + '/') : [name];
  });
  const files = [...new Set(listed === null ? archiveFiles(root) : listed.split('\0').filter(Boolean))].sort();
  const fileSet = new Set(files);
  for (const file of files) {
    checkDeadline();
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
    ? git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true, deadline)?.trim() || null
    : null;
  const commonDirectory = isRepositoryRoot
    ? git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], true, deadline)?.trim()
    : null;
  const repository = commonDirectory ? fs.realpathSync(commonDirectory) : realRoot;
  return JSON.stringify({
    kind: isRepositoryRoot ? 'git' : 'archive',
    head: isRepositoryRoot ? git(root, ['rev-parse', '--verify', 'HEAD'], true, deadline)?.trim() || null : null,
    target: isRepositoryRoot ? git(root, ['rev-parse', '--verify', 'origin/main'], true, deadline)?.trim() || null : null,
    index: isRepositoryRoot ? git(root, ['ls-files', '--stage', '-z'], true, deadline) : null,
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

async function runFullGate(root, label, entry, args) {
  let scratch;
  let sentinelSecret;
  let declined = false;
  const decline = (reason, detail) => {
    if (!declined) { declined = true; noVerdict(reason, detail, scratch, 2, sentinelSecret); }
    return NO_VERDICT;
  };
  const started = Date.now();
  if (hasNodePreload(process.env.NODE_OPTIONS || '')) return decline(REASONS.ADMISSION, 'NODE_OPTIONS loaders and module preloads are unsupported for full gates; admission and body did not start');
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
  let stopped;
  let timer;
  let outputDrain;
  let outputTimer;
  let finishOutputWait;
  let ticket;
  let premise;
  let bodyResult;
  let finalSnapshotRequired = false;
  const stop = signal => {
    stopped ||= signal;
    finishOutputWait?.(false);
    if (worker?.connected) worker.send({ kind: MESSAGES.STOP, reason: signal });
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
    if (stopped) return decline(stopped === REASONS.TIMEOUT ? REASONS.TIMEOUT : REASONS.INTERRUPTED, stopped + ' before admission; nothing ran');
    if (Math.floor((deadline - Date.now()) / 1000) - slowest < 1) {
      return decline(REASONS.CAPACITY, 'caller budget leaves no time for admission plus execution');
    }
    try { premise = revision(root, deadline); }
    catch (error) {
      if (error.code === 'ETIMEDOUT' || Date.now() >= deadline) return decline(REASONS.TIMEOUT, 'source snapshot exceeded the gate deadline');
      throw error;
    }
    const snapshot = JSON.parse(premise);
    const branchIdentity = snapshot.kind === 'archive'
      ? 'archive'
      : snapshot.branch === null ? 'detached' : 'branch:' + snapshot.branch;
    ticket = 'discord:' + label + ':' + crypto.createHash('sha256').update(snapshot.repository + '\0' + branchIdentity + '\0' + (snapshot.head || snapshot.files)).digest('hex').slice(0, 32);
    sentinelSecret = crypto.randomBytes(32).toString('hex');
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-gate-'));
    worker = fork(path.join(__dirname, 'full-gate-worker.js'), [String(deadline), entry, ...args], {
      cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc', 2], env: { ...repositoryEnvironment(), [NO_VERDICT_SECRET]: sentinelSecret, [SCRATCH_ROOT]: scratch }
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
    if (revision(root, deadline) !== premise) return decline(REASONS.STALE, 'source changed during admission; nothing ran');
    const captured = JSON.parse(premise);
    process.stdout.write('FULL_GATE_SOURCE=' + JSON.stringify({ head: captured.head, target: captured.target, source: captured.files }) + '\n');
    const finished = new Promise(resolve => worker.on('message', message => {
      if (message.kind === MESSAGES.BODY_EXIT) { bodyFinished = true; resolve(message); }
    }));
    worker.send({ kind: MESSAGES.START }); bodyStarted = true;
    const result = await Promise.race([finished, workerExit.then(value => ({ workerExited: true, signal: value.signal }))]);
    if (stopped || result.workerExited) return decline(stopped === REASONS.TIMEOUT ? REASONS.TIMEOUT : REASONS.INTERRUPTED, stopped || result.signal || 'worker exited before reporting the body result');
    bodyResult = result.code;
    finalSnapshotRequired = true;
  } catch (error) {
    if (error.code === 'ETIMEDOUT' || Date.now() >= deadline) return decline(REASONS.TIMEOUT, 'gate work exceeded the caller deadline');
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
    if (!released) {
      clearTimeout(timer);
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      return decline(REASONS.CLEANUP, 'owned scratch removal failed; teardown completed');
    }
    if (!finalSnapshotRequired) {
      clearTimeout(timer);
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    }
  }
  if (finalSnapshotRequired) {
    try {
      const finalRevision = revision(root, deadline);
      const sourceChanged = !sameSource(premise, finalRevision);
      if (stopped === REASONS.TIMEOUT || Date.now() >= deadline) return decline(REASONS.TIMEOUT, 'source verification exceeded the gate deadline');
      if (sourceChanged) return decline(REASONS.STALE, 'source changed during execution');
    } catch (error) {
      if (error.code === 'ETIMEDOUT' || stopped === REASONS.TIMEOUT || Date.now() >= deadline) {
        return decline(REASONS.TIMEOUT, 'source verification exceeded the gate deadline');
      }
      return decline(REASONS.STALE, 'unable to verify source after execution: ' + error.message);
    } finally {
      clearTimeout(timer);
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    }
  }
  return bodyResult;
}

module.exports = { canFinish, releaseScratch, noVerdict, REASONS, runFullGate, SCRATCH_ROOT, NO_VERDICT_SECRET, NO_VERDICT, MESSAGES, revision, relay, groupPeers, nodeOptionTokens };
