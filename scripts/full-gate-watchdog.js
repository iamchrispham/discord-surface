'use strict';

const { spawn, spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { MESSAGES, NO_VERDICT, canFinish, releaseScratch, NO_VERDICT_SECRET, SCRATCH_ROOT } = require('./full-gate');
const [deadline, leader, entry, ...args] = process.argv.slice(2);
const group = Number(leader);
let stopping = false;
let draining = false;
let body;
let admission;
let admissionSucceeded = false;
let bodyExited = false;
let orphan = false;
function stop() {
  if (stopping) return;
  stopping = true;
  process.on('SIGTERM', () => {});
  try { process.kill(-group, 'SIGTERM'); } catch {}
  setTimeout(() => {
    if (orphan) releaseScratch(process.env[SCRATCH_ROOT], Number(deadline));
    try { process.kill(-group, 'SIGKILL'); } catch {}
    process.exit(NO_VERDICT);
  }, 2000);
}
function check() {
  if (!canFinish(stopping)) return;
  if (Date.now() >= Number(deadline)) return stop();
  if (!draining) return;
  const table = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], {
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: Math.max(1, Number(deadline) - Date.now())
  });
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
    admission.once('exit', code => {
      admissionSucceeded = code === 0;
      if (process.connected) process.send({ kind: MESSAGES.ADMISSION_EXIT, code });
    });
  }
  if (message.kind === MESSAGES.START && !body) {
    if (!admissionSucceeded) return stop(REASONS.ADMISSION);
    const env = { ...process.env };
    delete env[NO_VERDICT_SECRET];
    delete env.DISCORD_SURFACE_GATE_BODY;
    delete env.DISCORD_SURFACE_GATE_BODY_TOKEN;
    body = spawn(process.execPath, [path.join(__dirname, 'full-gate', 'body-runner.js'), entry, ...args], {
      stdio: ['ignore', 'inherit', 'inherit', 'ignore', 'ignore'], env
    });
    let bodyResultSent = false;
    const reportBodyExit = code => {
      if (bodyResultSent) return;
      bodyResultSent = true;
      bodyExited = true;
      if (process.connected) process.send({ kind: MESSAGES.BODY_EXIT, code });
    };
    body.once('error', () => reportBodyExit(1));
    body.once('close', (code, signal) => {
      reportBodyExit(signal ? 128 + os.constants.signals[signal] : code);
    });
  }
  if (message.kind === MESSAGES.DRAIN && (!body || bodyExited)) { draining = true; check(); }
  if (message.kind === MESSAGES.STOP) { orphan ||= Boolean(message.orphan); stop(); }
});
process.on('disconnect', () => { orphan = true; stop(); });
process.on('SIGTERM', () => stop());
setTimeout(() => stop(REASONS.TIMEOUT), Math.max(1, Number(deadline) - Date.now()));
process.send({ kind: MESSAGES.READY });
