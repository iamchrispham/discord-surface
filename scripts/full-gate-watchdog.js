'use strict';

const { fork, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MESSAGES, REASONS, NO_VERDICT, canFinish, releaseScratch, NO_VERDICT_SECRET, SCRATCH_ROOT } = require('./full-gate');
const [deadline, leader, entry, ...args] = process.argv.slice(2);
const group = Number(leader);
const PROCESS_MONITOR_INTERVAL_MS = 1000;
const DARWIN_PROCESS_IDENTITY_SCRIPT = `
import ctypes
import json
import sys

class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ('pbi_flags', ctypes.c_uint32), ('pbi_status', ctypes.c_uint32),
        ('pbi_xstatus', ctypes.c_uint32), ('pbi_pid', ctypes.c_uint32),
        ('pbi_ppid', ctypes.c_uint32), ('pbi_uid', ctypes.c_uint32),
        ('pbi_gid', ctypes.c_uint32), ('pbi_ruid', ctypes.c_uint32),
        ('pbi_rgid', ctypes.c_uint32), ('pbi_svuid', ctypes.c_uint32),
        ('pbi_svgid', ctypes.c_uint32), ('rfu_1', ctypes.c_uint32),
        ('pbi_comm', ctypes.c_char * 16), ('pbi_name', ctypes.c_char * 32),
        ('pbi_nfiles', ctypes.c_uint32), ('pbi_pgid', ctypes.c_uint32),
        ('pbi_pjobc', ctypes.c_uint32), ('e_tdev', ctypes.c_uint32),
        ('e_tpgid', ctypes.c_uint32), ('pbi_nice', ctypes.c_int32),
        ('pbi_start_tvsec', ctypes.c_uint64), ('pbi_start_tvusec', ctypes.c_uint64),
    ]

proc_pidinfo = ctypes.CDLL('/usr/lib/libproc.dylib').proc_pidinfo
proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_uint32, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
proc_pidinfo.restype = ctypes.c_int

def unique_identity(pid):
    buffer = ctypes.create_string_buffer(56)
    if proc_pidinfo(pid, 17, 0, buffer, 56) != 56:
        return None
    unique_id = int.from_bytes(buffer.raw[16:24], byteorder=sys.byteorder)
    pid_version = int.from_bytes(buffer.raw[32:36], byteorder=sys.byteorder, signed=True)
    if unique_id <= 0 or pid_version <= 0:
        return None
    return unique_id, pid_version

identities = {}
for raw_pid in sys.argv[1:]:
    pid = int(raw_pid)
    before = unique_identity(pid)
    if before is None:
        continue
    info = ProcBsdInfo()
    if proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info):
        continue
    after = unique_identity(pid)
    if (before != after or info.pbi_pid != pid or info.pbi_start_tvsec <= 0
            or info.pbi_start_tvusec >= 1000000):
        continue
    identities[raw_pid] = ':'.join(map(str, (
        info.pbi_start_tvsec, info.pbi_start_tvusec, before[0], before[1]
    )))
print(json.dumps(identities))
`;
let stopping = false;
let draining = false;
let body;
let admission;
let admissionSucceeded = false;
let bodyExited = false;
let orphan = false;
const escapedDescendants = new Map();
let processMonitor;
function readProcessIdentities(pids) {
  const uniquePids = [...new Set(pids)];
  const identities = new Map();
  if (!uniquePids.length) return identities;
  if (process.platform === 'linux') {
    for (const pid of uniquePids) {
      try {
        const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (fields[19]) identities.set(pid, 'linux:' + fields[19]);
      } catch {}
    }
    return identities;
  }
  if (process.platform !== 'darwin') return identities;
  const result = spawnSync(process.env.PYTHON || 'python3', ['-c', DARWIN_PROCESS_IDENTITY_SCRIPT, ...uniquePids.map(String)], {
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 1000
  });
  if (result.status !== 0) return identities;
  try {
    for (const [rawPid, identity] of Object.entries(JSON.parse(result.stdout))) {
      const pid = Number(rawPid);
      if (uniquePids.includes(pid) && typeof identity === 'string' && identity) identities.set(pid, 'darwin:' + identity);
    }
  } catch {}
  return identities;
}
function sameProcessIdentity(expected, actual) {
  return typeof expected === 'string' && expected.length > 0 && expected === actual;
}
function readProcessTable(timeout = Math.max(1, Number(deadline) - Date.now())) {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat='], {
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout
  });
  if (result.status !== 0) return null;
  const rows = result.stdout.split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/);
    if (!match) return null;
    return { pid: Number(match[1]), parent: Number(match[2]), pgid: Number(match[3]), state: match[4] };
  }).filter(Boolean).filter(row => row.pid !== result.pid);
  if (!rows.some(row => row.pid === process.pid)) return null;
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
        if (row.pid !== process.pid && row.pgid !== group && !escapedDescendants.has(row.pid)) escapedDescendants.set(row.pid, null);
      }
    }
  }
  const unresolved = [...escapedDescendants]
    .filter(([pid, identity]) => identity === null && rows.some(row => row.pid === pid && !row.state.startsWith('Z')))
    .map(([pid]) => pid);
  for (const [pid, identity] of readProcessIdentities(unresolved)) escapedDescendants.set(pid, identity);
}
function signalEscapedDescendants(signal, rows) {
  if (!rows) return;
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const candidates = [...escapedDescendants].filter(([pid, identity]) => identity && byPid.has(pid));
  const identities = readProcessIdentities(candidates.map(([pid]) => pid));
  for (const [pid, expected] of candidates) {
    const row = byPid.get(pid);
    if (!row || row.state.startsWith('Z') || !sameProcessIdentity(expected, identities.get(pid))) continue;
    try { process.kill(pid, signal); } catch {}
  }
}
function hasLiveEscapedDescendants(rows) {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const candidates = [...escapedDescendants].filter(([pid]) => byPid.has(pid));
  const identities = readProcessIdentities(candidates.map(([pid]) => pid));
  return candidates.some(([pid, expected]) => {
    const row = byPid.get(pid);
    if (!row || row.state.startsWith('Z')) return false;
    return !expected || !identities.has(pid) || sameProcessIdentity(expected, identities.get(pid));
  });
}
function hasOwnedProcesses(table) {
  if (!table) return true;
  const peers = table.rows.some(row => row.pgid === group && ![process.pid, group, table.scannerPid].includes(row.pid) && !row.state.startsWith('Z'));
  return peers || hasLiveEscapedDescendants(table.rows);
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
    const remaining = readProcessTable(1000);
    if (remaining) {
      rememberEscapedDescendants(remaining.rows);
      signalEscapedDescendants('SIGKILL', remaining.rows);
    }
    try { process.kill(-group, 'SIGKILL'); } catch {}
    if (orphan) {
      setTimeout(() => {
        const verified = readProcessTable(1000);
        if (hasOwnedProcesses(verified)) return process.exit(NO_VERDICT);
        if (!releaseScratch(process.env[SCRATCH_ROOT], Number(deadline))) return process.exit(NO_VERDICT);
        process.exit(NO_VERDICT);
      }, 50);
      return;
    }
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
  const liveEscapes = hasLiveEscapedDescendants(table.rows);
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
    processMonitor = setInterval(monitorDescendants, PROCESS_MONITOR_INTERVAL_MS);
    processMonitor.unref();
  }
  if (message.kind === MESSAGES.DRAIN && (!body || bodyExited)) { draining = true; check(); }
  if (message.kind === MESSAGES.STOP) { orphan ||= Boolean(message.orphan); stop(); }
});
process.on('disconnect', () => { orphan = true; stop(); });
process.on('SIGTERM', () => stop());
setTimeout(() => stop(REASONS.TIMEOUT), Math.max(1, Number(deadline) - Date.now()));
process.send({ kind: MESSAGES.READY });
