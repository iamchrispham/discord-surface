'use strict';

const path = require('node:path');
const os = require('node:os');
const { fork, spawn } = require('node:child_process');
const { MESSAGES, WORKER_STOP_EVENTS, workerStopObservation, NO_VERDICT, canFinish, noVerdict, REASONS, SCRATCH_ROOT, NO_VERDICT_SECRET } = require('./full-gate');
const [deadline, entry, ...args] = process.argv.slice(2);
let admission;
let admissionExited = false;
let admissionSucceeded = false;
let body;
let bodyExited = false;
let bodyScanRequested = false;
let stopping = false;
let stopReason = REASONS.INTERRUPTED;
let workerObservation;
let workerObservationSent = false;
function observeWorker(event, error) {
  try { workerObservation ||= workerStopObservation({ event, errorCode: error?.code }); } catch {}
}
function sendWorkerObservation() {
  if (!process.connected || !workerObservation || workerObservationSent) return;
  workerObservationSent = true;
  try { process.send({ kind: MESSAGES.STOP, workerObservation }, () => {}); } catch {}
}
function stop(reason = stopReason) {
  if (stopping) return;
  stopping = true;
  noVerdict(reason, 'worker stopped before teardown completed', process.env[SCRATCH_ROOT], reason === REASONS.TIMEOUT ? 1 : 2);
  try { process.kill(-process.pid, 'SIGTERM'); } catch {}
  setTimeout(() => {
    try { process.kill(-process.pid, 'SIGKILL'); } catch {}
    process.exit(NO_VERDICT);
  }, 2000);
  sendWorkerObservation();
}
function report(message) {
  if (!process.connected) return stop();
  try { process.send(message, error => { if (error) stop(); }); } catch { stop(); }
}
process.on('message', message => {
  if (message.kind === MESSAGES.ADMIT && !admission && !stopping) {
    admission = spawn(message.command, message.args, { stdio: 'inherit' });
    admission.once('error', error => report({ kind: MESSAGES.ADMISSION_EXIT, error: error.message }));
    admission.once('exit', code => {
      admissionExited = true;
      admissionSucceeded = code === 0;
      report({ kind: MESSAGES.ADMISSION_EXIT, code });
    });
  }
  if (message.kind === MESSAGES.START && !body && !stopping) {
    if (!admissionSucceeded) return stop();
    const env = { ...process.env };
    delete env[NO_VERDICT_SECRET];
    delete env.DISCORD_SURFACE_GATE_BODY;
    delete env.DISCORD_SURFACE_GATE_BODY_TOKEN;
    body = fork(path.join(__dirname, 'full-gate', 'body-runner.js'), [entry, ...args], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc', 'ignore'], env
    });
    body.on('message', message => {
      if (message.kind !== MESSAGES.BODY_COMPLETE || bodyScanRequested || stopping) return;
      bodyScanRequested = true;
      report({ kind: MESSAGES.BODY_COMPLETE });
    });
    let bodyResultSent = false;
    const reportBodyExit = code => {
      if (bodyResultSent) return;
      bodyResultSent = true;
      bodyExited = true;
      report({ kind: MESSAGES.BODY_EXIT, code });
    };
    body.once('error', () => reportBodyExit(1));
    body.once('close', (code, signal) => reportBodyExit(signal ? 128 + os.constants.signals[signal] : code));
  }
  if (message.kind === MESSAGES.BODY_SCAN_COMPLETE && bodyScanRequested && body?.connected && !stopping) {
    try { body.send({ kind: MESSAGES.BODY_SCAN_COMPLETE }, error => { if (error) stop(); }); } catch { stop(); }
  }
  if (message.kind === MESSAGES.CLOSE) {
    if (canFinish(stopping) && (!body || bodyExited) && (!admission || admissionExited)) process.exit(0);
    else stop();
  }
  if (message.kind === MESSAGES.STOP) {
    observeWorker(WORKER_STOP_EVENTS.PARENT_STOP);
    stopReason = message.reason || REASONS.INTERRUPTED;
    stop();
  }
});
process.on('SIGTERM', () => { observeWorker(WORKER_STOP_EVENTS.SIGTERM); stopReason = REASONS.INTERRUPTED; stop(); });
process.on('disconnect', () => { observeWorker(WORKER_STOP_EVENTS.PARENT_DISCONNECT); stopReason = REASONS.INTERRUPTED; stop(); });
setTimeout(() => stop(REASONS.TIMEOUT), Math.max(1, Number(deadline) - Date.now()));
report({ kind: MESSAGES.READY, holder: process.pid });
