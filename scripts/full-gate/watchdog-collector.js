'use strict';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const COLLECTOR_TIMING_FIELDS = Object.freeze(['budget', 'custody', 'run', 'returned', 'spawn', 'data', 'exit', 'close', 'elapsed', 'wallStarted', 'monoElapsed', 'stderr', 'error', 'checkpoint']);
const COLLECTOR_CHECKPOINTS = Object.freeze({ ENTERED: 1, IMPORTS: 2, PID_LIST: 3, ROWS: 4 });
const COLLECTOR_CHECKPOINT_PREFIX = 'WQ';
const CHECKPOINT_PREFIX_BYTES = Object.values(COLLECTOR_CHECKPOINTS).map(value => COLLECTOR_CHECKPOINT_PREFIX + value + '\n').join('').length;
const COLLECTOR_FAILURE_ORIGINS = Object.freeze({
  RUN_EXPIRED: 'run-expired', RUN_BUSY: 'run-busy', PHASE_TIMER: 'phase-timer',
  CANCEL_REQUEST: 'cancel-request', FINISH_CANCEL: 'finish-cancel', SPAWN_THROW: 'spawn-throw',
  STDOUT_LIMIT: 'stdout-limit', STDERR_LIMIT: 'stderr-limit',
  STDOUT_ERROR: 'stdout-error', STDERR_ERROR: 'stderr-error',
  CHILD_ERROR: 'child-error', CLOSE_INVALID: 'close-invalid', CHILD_EXIT: 'child-exit'
});

function createWatchdogCollector({ spawn, now = Date.now, monotonicNow = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let owner = null;
  const failure = (phase, code, failureOrigin) => ({ status: null, signal: null, pid: phase?.child?.pid, stdout: '', error: { code }, childErrorCode: phase?.childErrorCode, failureOrigin,
    timing: phase ? { ...phase.timing, elapsed: now() - phase.startedAt, monoElapsed: Math.round(monotonicNow() - phase.monotonicStartedAt) } : null });
  const valid = phase => Boolean(phase) && owner === phase && phase.live && now() < phase.end;
  function release(phase) {
    if (!phase.live && !phase.child && owner === phase) {
      owner = null;
      phase.closed();
    }
  }
  function signal(signal) {
    try { owner?.child?.kill(signal); } catch {}
  }
  function cancel(code = 'ECANCELED', origin = COLLECTOR_FAILURE_ORIGINS.CANCEL_REQUEST) {
    const phase = owner;
    if (!phase || !phase.live) return;
    phase.live = false;
    clearTimer(phase.timer);
    phase.pending?.(failure(phase, code, origin));
    signal('SIGTERM');
    release(phase);
  }
  function begin(end) {
    if (owner || !Number.isFinite(end) || end <= now()) return null;
    const startedAt = now();
    const phase = { end, startedAt, monotonicStartedAt: monotonicNow(), live: true, child: null, pending: null,
      timing: Object.fromEntries(COLLECTOR_TIMING_FIELDS.map(field => [field, null])) };
    phase.timing.budget = end - startedAt;
    phase.timing.wallStarted = startedAt;
    phase.closure = new Promise(resolve => { phase.closed = resolve; });
    owner = phase;
    phase.timer = setTimer(() => { if (owner === phase) cancel('ETIMEDOUT', COLLECTOR_FAILURE_ORIGINS.PHASE_TIMER); }, end - now());
    return phase;
  }
  function finish(phase) {
    if (!phase || owner !== phase) return;
    if (phase.child) return cancel('ECANCELED', COLLECTOR_FAILURE_ORIGINS.FINISH_CANCEL);
    phase.live = false;
    clearTimer(phase.timer);
    release(phase);
  }
  function run(phase, command, args, env) {
    if (!valid(phase)) {
      if (owner === phase) cancel('ETIMEDOUT', COLLECTOR_FAILURE_ORIGINS.RUN_EXPIRED);
      return Promise.resolve(failure(phase, 'ETIMEDOUT', COLLECTOR_FAILURE_ORIGINS.RUN_EXPIRED));
    }
    if (phase.child || phase.pending) return Promise.resolve(failure(phase, 'EBUSY', COLLECTOR_FAILURE_ORIGINS.RUN_BUSY));
    return new Promise(resolve => {
      Object.assign(phase.timing, { run: now() - phase.startedAt, returned: null, spawn: null, data: null, exit: null, close: null, stderr: null, error: null, checkpoint: null });
      phase.childErrorCode = undefined;
      let settled = false;
      const settle = result => {
        if (settled) return;
        settled = true;
        phase.pending = null;
        resolve(result);
      };
      phase.pending = settle;
      let child;
      try { child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) { return settle(failure(phase, error.code || 'EIO', COLLECTOR_FAILURE_ORIGINS.SPAWN_THROW)); }
      phase.timing.returned = now() - phase.startedAt;
      phase.child = child;
      let bytes = 0;
      const output = [];
      let checkpointPrefix = '';
      let errorCode;
      const stdout = chunk => {
        if (!valid(phase)) return;
        const buffer = Buffer.from(chunk);
        if (!buffer.length) return;
        phase.timing.data ??= now() - phase.startedAt;
        bytes += buffer.length;
        if (bytes > MAX_OUTPUT_BYTES) return cancel('ENOBUFS', COLLECTOR_FAILURE_ORIGINS.STDOUT_LIMIT);
        output.push(buffer);
        checkpointPrefix += buffer.subarray(0, Math.max(0, CHECKPOINT_PREFIX_BYTES - checkpointPrefix.length)).toString('latin1');
        for (const line of checkpointPrefix.split('\n').slice(0, -1)) {
          const value = Number(line.slice(COLLECTOR_CHECKPOINT_PREFIX.length));
          if (line.startsWith(COLLECTOR_CHECKPOINT_PREFIX) && line.length === COLLECTOR_CHECKPOINT_PREFIX.length + 1
              && Object.values(COLLECTOR_CHECKPOINTS).includes(value)) phase.timing.checkpoint = value;
        }
      };
      const stderr = chunk => {
        if (!valid(phase)) return;
        if (chunk.length) phase.timing.stderr ??= now() - phase.startedAt;
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) cancel('ENOBUFS', COLLECTOR_FAILURE_ORIGINS.STDERR_LIMIT);
      };
      const error = value => {
        phase.timing.error ??= now() - phase.startedAt;
        errorCode ||= value.code || 'EIO';
        phase.childErrorCode = errorCode;
      };
      const stdoutError = value => cancel(value.code || 'EIO', COLLECTOR_FAILURE_ORIGINS.STDOUT_ERROR);
      const stderrError = value => cancel(value.code || 'EIO', COLLECTOR_FAILURE_ORIGINS.STDERR_ERROR);
      // Callback offsets distinguish observed stages, not OS scheduling times.
      const spawned = () => { phase.timing.spawn = now() - phase.startedAt; };
      const exited = () => { phase.timing.exit = now() - phase.startedAt; };
      child.stdout.on('error', stdoutError);
      child.stderr.on('error', stderrError);
      child.stdout.on('data', stdout);
      child.stderr.on('data', stderr);
      child.on('error', error);
      child.once('spawn', spawned);
      child.once('exit', exited);
      child.once('close', (status, signal) => {
        phase.timing.close = now() - phase.startedAt;
        child.stdout.removeListener('error', stdoutError);
        child.stderr.removeListener('error', stderrError);
        child.stdout.removeListener('data', stdout);
        child.stderr.removeListener('data', stderr);
        child.removeListener('error', error);
        child.removeListener('spawn', spawned);
        child.removeListener('exit', exited);
        phase.child = null;
        if (!valid(phase)) settle(failure(phase, 'ECANCELED', COLLECTOR_FAILURE_ORIGINS.CLOSE_INVALID));
        else {
          let failureOrigin = null;
          if (errorCode) failureOrigin = COLLECTOR_FAILURE_ORIGINS.CHILD_ERROR;
          else if (status !== 0) failureOrigin = COLLECTOR_FAILURE_ORIGINS.CHILD_EXIT;
          settle({ status: errorCode ? null : status, signal, pid: child.pid, stdout: Buffer.concat(output).toString('utf8'), error: errorCode ? { code: errorCode } : undefined, failureOrigin });
        }
        release(phase);
      });
    });
  }
  return { begin, run, valid, finish, cancel, signal, owned: () => owner !== null, whenClosed: () => owner ? owner.closure : Promise.resolve() };
}

module.exports = { createWatchdogCollector, COLLECTOR_FAILURE_ORIGINS, COLLECTOR_TIMING_FIELDS, COLLECTOR_CHECKPOINTS, COLLECTOR_CHECKPOINT_PREFIX };
