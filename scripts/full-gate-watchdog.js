'use strict';

const { spawn, spawnSync } = require('node:child_process');
const os = require('node:os');
const { MESSAGES, NO_VERDICT, REASONS, noVerdict, canFinish, releaseScratch, SCRATCH_ROOT } = require('./full-gate');
const [deadline, leader, entry, ...args] = process.argv.slice(2);
const group = Number(leader);
let stopping = false;
let draining = false;
let body;
let admission;
let bodyExited = false;
let orphan = false;
function stop(reason = REASONS.INTERRUPTED) {
  if (stopping) return;
  stopping = true;
  noVerdict(reason, 'watchdog stopping its owned group', process.env[SCRATCH_ROOT], 4);
  process.on('SIGTERM', () => {});
  try { process.kill(-group, 'SIGTERM'); } catch {}
  setTimeout(() => {
    if (orphan) releaseScratch(process.env[SCRATCH_ROOT]);
    try { process.kill(-group, 'SIGKILL'); } catch {}
    process.exit(NO_VERDICT);
  }, 2000);
}
function check() {
  if (!canFinish(stopping)) return;
  if (Date.now() >= Number(deadline)) return stop(REASONS.TIMEOUT);
  if (!draining) return;
  const table = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  if (table.status !== 0) return stop();
  const peers = table.stdout.split('\n').map(line => line.trim().split(/\s+/)).filter(([pid, pgid, state]) =>
    Number(pgid) === group && ![process.pid, group, table.pid].includes(Number(pid)) && !state?.startsWith('Z'));
  if (peers.length) return stop();
  process.exit(0);
}
process.on('message', message => {
  if (message.kind === MESSAGES.ADMIT && !admission) {
    admission = spawn(message.command, message.args, { stdio: 'inherit' });
    admission.once('error', error => { if (process.connected) process.send({ kind: MESSAGES.ADMISSION_EXIT, error: error.message }); });
    admission.once('exit', code => { if (process.connected) process.send({ kind: MESSAGES.ADMISSION_EXIT, code }); });
  }
  if (message.kind === MESSAGES.START && !body) {
    body = spawn(process.execPath, [entry, ...args], { stdio: 'inherit' });
    body.once('error', () => { bodyExited = true; if (process.connected) process.send({ kind: MESSAGES.BODY_EXIT, code: 1 }); });
    body.once('close', (code, signal) => {
      bodyExited = true;
      if (process.connected) process.send({ kind: MESSAGES.BODY_EXIT, code: signal ? 128 + os.constants.signals[signal] : code });
    });
  }
  if (message.kind === MESSAGES.DRAIN && (!body || bodyExited)) { draining = true; check(); }
  if (message.kind === MESSAGES.STOP) { orphan ||= Boolean(message.orphan); stop(); }
});
process.on('disconnect', () => { orphan = true; stop(); });
process.on('SIGTERM', () => stop());
setTimeout(() => stop(REASONS.TIMEOUT), Math.max(1, Number(deadline) - Date.now()));
process.send({ kind: MESSAGES.READY });
