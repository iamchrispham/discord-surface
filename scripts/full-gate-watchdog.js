'use strict';

const { fork, spawn, spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { MESSAGES, REASONS, NO_VERDICT, canFinish, releaseScratch, NO_VERDICT_SECRET, SCRATCH_ROOT } = require('./full-gate');
const [deadline, leader, entry, ...args] = process.argv.slice(2);
const group = Number(leader);
let stopping = false;
let draining = false;
let body;
let admission;
let admissionSucceeded = false;
let bodyExited = false;
let orphan = false;
const escapedDescendants = new Map();
let processMonitor;
function readProcessTable(timeout = Math.max(1, Number(deadline) - Date.now())) {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='], {
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout
  });
  if (result.status !== 0) return null;
  const rows = result.stdout.split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) return null;
    return { pid: Number(match[1]), parent: Number(match[2]), pgid: Number(match[3]), state: match[4], started: match[5] };
  }).filter(Boolean);
  if (!rows.some(row => row.pid === process.pid) || !rows.some(row => row.pid === group)) return null;
  return { rows, scannerPid: result.pid };
}
function rememberEscapedDescendants(rows) {
  const descendants = new Set([group]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.parent) && !descendants.has(row.pid) && !row.state.startsWith('Z')) {
        descendants.add(row.pid);
        changed = true;
        if (row.pgid !== group) escapedDescendants.set(row.pid, row.started);
      }
    }
  }
}
function signalEscapedDescendants(signal, rows) {
  if (!rows) return;
  const byPid = new Map(rows.map(row => [row.pid, row]));
  for (const [pid, started] of escapedDescendants) {
    const row = byPid.get(pid);
    if (!row || row.started !== started || row.state.startsWith('Z')) continue;
    try { process.kill(pid, signal); } catch {}
  }
}
function monitorDescendants() {
  if (!body || stopping) return;
  const snapshot = readProcessTable(1000);
  if (!snapshot) return stop();
  rememberEscapedDescendants(snapshot.rows);
}
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(processMonitor);
  process.on('SIGTERM', () => {});
  const snapshot = readProcessTable();
  if (snapshot) {
    rememberEscapedDescendants(snapshot.rows);
    signalEscapedDescendants('SIGTERM', snapshot.rows);
  }
  try { process.kill(-group, 'SIGTERM'); } catch {}
  setTimeout(() => {
    if (orphan) releaseScratch(process.env[SCRATCH_ROOT], Number(deadline));
    const remaining = readProcessTable(1000);
    if (remaining) signalEscapedDescendants('SIGKILL', remaining.rows);
    try { process.kill(-group, 'SIGKILL'); } catch {}
    process.exit(NO_VERDICT);
  }, 2000);
}
function check() {
  if (!canFinish(stopping)) return;
  if (Date.now() >= Number(deadline)) return stop();
  if (!draining) return;
  const table = readProcessTable();
  if (!table) return stop();
  rememberEscapedDescendants(table.rows);
  const peers = table.rows.filter(row => row.pgid === group && ![process.pid, group, table.scannerPid].includes(row.pid) && !row.state.startsWith('Z'));
  if (peers.length) return stop();
  const liveEscapes = [...escapedDescendants].some(([pid, started]) => {
    const row = table.rows.find(candidate => candidate.pid === pid);
    return row && row.started === started && !row.state.startsWith('Z');
  });
  if (liveEscapes) return stop();
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
    body = fork(path.join(__dirname, 'full-gate', 'body-runner.js'), [entry, ...args], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env
    });
    let bodyScanned = false;
    body.on('message', message => {
      if (message.kind !== MESSAGES.BODY_COMPLETE || bodyScanned) return;
      const snapshot = readProcessTable();
      if (!snapshot) return stop();
      rememberEscapedDescendants(snapshot.rows);
      if (stopping || !body.connected) return stop();
      bodyScanned = true;
      body.send({ kind: MESSAGES.BODY_SCAN_COMPLETE }, error => { if (error) stop(); });
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
    processMonitor = setInterval(monitorDescendants, 50);
    processMonitor.unref();
  }
  if (message.kind === MESSAGES.DRAIN && (!body || bodyExited)) { draining = true; check(); }
  if (message.kind === MESSAGES.STOP) { orphan ||= Boolean(message.orphan); stop(); }
});
process.on('disconnect', () => { orphan = true; stop(); });
process.on('SIGTERM', () => stop());
setTimeout(() => stop(REASONS.TIMEOUT), Math.max(1, Number(deadline) - Date.now()));
process.send({ kind: MESSAGES.READY });
