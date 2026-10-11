'use strict';

const path = require('node:path');
const { fork } = require('node:child_process');
const { MESSAGES, NO_VERDICT, canFinish, releaseScratch, SCRATCH_ROOT } = require('./full-gate');
const [deadline, entry, ...args] = process.argv.slice(2);
const guard = fork(path.join(__dirname, 'full-gate-watchdog.js'), [deadline, String(process.pid), entry, ...args], {
  stdio: ['ignore', 'inherit', 'inherit', 'ipc']
});
guard.on('message', message => {
  if (!process.connected) return;
  if (message.kind === MESSAGES.READY) process.send({ kind: MESSAGES.READY, holder: process.pid });
  if ([MESSAGES.BODY_EXIT, MESSAGES.ADMISSION_EXIT].includes(message.kind)) process.send(message);
});
process.on('message', message => {
  if ([MESSAGES.START, MESSAGES.ADMIT].includes(message.kind) && guard.connected) guard.send(message);
  if (message.kind === MESSAGES.CLOSE && guard.connected) guard.send({ kind: MESSAGES.DRAIN });
  if (message.kind === MESSAGES.STOP && guard.connected) guard.send(message);
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  try { process.kill(-process.pid, 'SIGTERM'); } catch {}
  setTimeout(() => {
    if (!process.connected) releaseScratch(process.env[SCRATCH_ROOT]);
    try { process.kill(-process.pid, 'SIGKILL'); } catch {}
    process.exit(NO_VERDICT);
  }, 2000);
}
process.on('SIGTERM', () => { if (guard.connected) guard.send({ kind: MESSAGES.STOP }); else stop(); });
process.on('disconnect', () => { if (guard.connected) guard.send({ kind: MESSAGES.STOP, orphan: true }); else stop(); });
guard.once('exit', code => { if (code === 0 && canFinish(stopping)) process.exit(0); else stop(); });
