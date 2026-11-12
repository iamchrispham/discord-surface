'use strict';

const { spawn } = require('node:child_process');
const { createWatchdogCollector, COLLECTOR_CHECKPOINTS, COLLECTOR_CHECKPOINT_PREFIX } = require('./full-gate/watchdog-collector');
const fs = require('node:fs');
const { MESSAGES, CUSTODY, WATCHDOG_STOP_EVENTS, gateSyscallObservation, watchdogStopObservation, REASONS, NO_VERDICT, canFinish, releaseScratch, NO_VERDICT_SECRET, SCRATCH_ROOT } = require('./full-gate');
const [deadline, callerDeadline, leader, entry, ...args] = process.argv.slice(2);
const group = Number(leader);
const PROCESS_MONITOR_INTERVAL_MS = 1000;
const PROCESS_OBSERVATION_CAP_MS = 1000;
const OBSERVATION_PHASE_BOUNDS = Object.freeze({
  monitor: 'work',
  drain: 'work',
  'body-complete': 'work',
  SIGTERM: 'cleanup',
  SIGKILL: 'cleanup',
  orphan: 'cleanup'
});
const DARWIN_PROCESS_IDENTITY_FLAGS = Object.freeze(['-I', '-S', '-B']);
const DARWIN_PROCESS_IDENTITY_SCRIPT = `
import sys
if sys.argv[1:2] == ['--table']:
    print('${COLLECTOR_CHECKPOINT_PREFIX}${COLLECTOR_CHECKPOINTS.ENTERED}', flush=True)
import ctypes
import errno
import json
import os
import struct

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

libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
proc_pidinfo = libproc.proc_pidinfo
proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_uint32, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
proc_pidinfo.restype = ctypes.c_int
PROC_PPID_ONLY = 6

def unique_identity(pid):
    buffer = ctypes.create_string_buffer(56)
    if proc_pidinfo(pid, 17, 0, buffer, 56) != 56:
        return None
    unique_id = int.from_bytes(buffer.raw[16:24], byteorder=sys.byteorder)
    pid_version = int.from_bytes(buffer.raw[32:36], byteorder=sys.byteorder, signed=True)
    if unique_id <= 0 or pid_version <= 0:
        return None
    return unique_id, pid_version

def bsd_identity(pid):
    before = unique_identity(pid)
    if before is None:
        return None
    info = ProcBsdInfo()
    if proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info):
        return None
    after = unique_identity(pid)
    if (before != after or info.pbi_pid != pid or info.pbi_start_tvsec <= 0
            or info.pbi_start_tvusec >= 1000000):
        return None
    identity = ':'.join(map(str, (
        info.pbi_start_tvsec, info.pbi_start_tvusec, before[0], before[1]
    )))
    return info, identity

if sys.argv[1:2] == ['--table']:
    print('${COLLECTOR_CHECKPOINT_PREFIX}${COLLECTOR_CHECKPOINTS.IMPORTS}', flush=True)
    if len(sys.argv) < 4 or any(not value.isascii() or not value.isdecimal() for value in sys.argv[2:]):
        raise ValueError('invalid process scope')
    scope = [int(value) for value in sys.argv[2:]]
    unresolved_scope = set(scope[2:])
    if any(pid <= 1 or pid > 0x7fffffff for pid in scope) or scope[1] != os.getppid():
        raise ValueError('process scope does not match its caller')
    list_pids = libproc.proc_listallpids
    list_pids.argtypes = [ctypes.c_void_p, ctypes.c_int]
    list_pids.restype = ctypes.c_int
    ctypes.set_errno(0)
    capacity = list_pids(None, 0)
    if capacity <= 0:
        raise OSError(ctypes.get_errno() or errno.EIO, 'process enumeration failed')
    pids = (ctypes.c_int * (capacity * 2))()
    ctypes.set_errno(0)
    count = list_pids(pids, ctypes.sizeof(pids))
    if count <= 0 or count >= len(pids):
        raise OSError(ctypes.get_errno() or errno.EIO, 'process enumeration incomplete')
    all_pids = set()
    for pid in pids[:count]:
        if pid < 0:
            raise ValueError('invalid process identifier')
        if pid:
            all_pids.add(pid)
    list_children = libproc.proc_listpids
    list_children.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
    list_children.restype = ctypes.c_int
    children = (ctypes.c_int * len(pids))()
    pending = list(dict.fromkeys(scope[:2]))
    discovered = set(pending)
    candidates = set(scope[2:]) & all_pids
    while pending:
        parent = pending.pop()
        if parent in all_pids:
            candidates.add(parent)
        ctypes.set_errno(0)
        size = list_children(PROC_PPID_ONLY, parent, children, ctypes.sizeof(children))
        code = ctypes.get_errno()
        if size < 0 or (size == 0 and code) or size >= ctypes.sizeof(children) or size % ctypes.sizeof(ctypes.c_int):
            raise OSError(code or errno.EIO, 'child process enumeration incomplete')
        for pid in children[:size // ctypes.sizeof(ctypes.c_int)]:
            if pid < 0:
                raise ValueError('invalid child process identifier')
            if pid in all_pids and pid not in discovered:
                discovered.add(pid)
                pending.append(pid)
    print('${COLLECTOR_CHECKPOINT_PREFIX}${COLLECTOR_CHECKPOINTS.PID_LIST}', flush=True)
    rows = []
    for pid in sorted(candidates):
        info = ctypes.create_string_buffer(64)
        ctypes.set_errno(0)
        size = proc_pidinfo(pid, 13, 0, info, 64)
        if size != 64:
            code = ctypes.get_errno()
            if size <= 0 and code == errno.ESRCH:
                continue
            raise OSError(code or errno.EIO, 'process metadata unavailable')
        actual, parent, group, status = struct.unpack_from('=IIII', info.raw)
        if actual != pid:
            raise ValueError('process identifier changed')
        identity = None
        if pid != scope[1] and status != 5 and (group != scope[0] or pid in unresolved_scope):
            observed = bsd_identity(pid)
            if observed is not None:
                captured_info, captured = observed
                if (captured_info.pbi_pid, captured_info.pbi_ppid,
                        captured_info.pbi_pgid, captured_info.pbi_status) == (pid, parent, group, status):
                    identity = 'darwin:' + captured
        row = str(pid) + ' ' + str(parent) + ' ' + str(group) + ' ' + ('Z' if status == 5 else '?')
        rows.append(row + (' ' + identity if identity is not None else ''))
    print('${COLLECTOR_CHECKPOINT_PREFIX}${COLLECTOR_CHECKPOINTS.ROWS}', flush=True)
    print('\\n'.join(rows))
    sys.exit(0)

identities = {}
for raw_pid in sys.argv[1:]:
    pid = int(raw_pid)
    observed = bsd_identity(pid)
    if observed is not None:
        identities[raw_pid] = observed[1]
print(json.dumps(identities))
`;
let stopping = false;
let draining = false;
let body = false;
let admission = false;
let bodyScanned = false;
let bodyScanRequested = false;
let completionSent = false;
let admissionSucceeded = false;
let bodyExited = false;
let orphan = false;
const escapedDescendants = new Map();
let processMonitor;
let processTableObservation = null;
let identityObservation = null;
const collector = createWatchdogCollector({ spawn });
let observationGeneration = 0;
let boundaryRequest = 0;
let boundaryPending = false;
let terminationStage = null;
let custodySequence = 0;
let custodyWait;
function observationDeadline(kind) {
  const workEnd = Number(deadline);
  const cleanupEnd = Number(callerDeadline);
  if (!Number.isFinite(workEnd) || workEnd <= 0 || !Number.isFinite(cleanupEnd)
      || cleanupEnd <= workEnd || !Object.hasOwn(OBSERVATION_PHASE_BOUNDS, kind)) return null;
  const scope = OBSERVATION_PHASE_BOUNDS[kind];
  if (scope === 'work' && !stopping) return workEnd;
  if (scope === 'cleanup' && stopping) return cleanupEnd;
  return null;
}
function beginObservation(kind, phaseDeadline) {
  const end = observationDeadline(kind);
  const requestedEnd = phaseDeadline === undefined ? end : phaseDeadline;
  if (end === null || !Number.isFinite(requestedEnd)) return null;
  const phase = collector.begin(Math.min(Date.now() + PROCESS_OBSERVATION_CAP_MS, requestedEnd, end, Number(callerDeadline)));
  if (phase) Object.assign(phase, { kind, generation: observationGeneration, custody: ++custodySequence });
  return phase;
}
function currentObservation(phase) {
  return collector.valid(phase) && phase.generation === observationGeneration;
}
async function freshObservation(kind) {
  const request = ++boundaryRequest;
  boundaryPending = true;
  await collector.whenClosed();
  if (stopping || request !== boundaryRequest) return null;
  boundaryPending = true;
  ++observationGeneration;
  return beginObservation(kind);
}
function finishObservation(phase) {
  if (custodyWait?.phase === phase) custodyWait.finish(false);
  if (phase?.custodyHeld && phase.tableComplete && currentObservation(phase) && !escapedDescendants.size) {
    try { if (process.connected) process.send({ kind: MESSAGES.CUSTODY, state: CUSTODY.CLEAR, phase: phase.custody }, () => {}); } catch {}
  }
  collector.finish(phase);
  if (phase?.generation === observationGeneration) boundaryPending = false;
}
async function holdCustody(phase) {
  if (!currentObservation(phase)) return false;
  if (orphan || !process.connected) return true;
  if (phase.custodyHeld) return true;
  custodyWait?.finish(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(false), Math.max(0, phase.end - Date.now()));
    const finish = held => {
      clearTimeout(timer);
      if (custodyWait?.phase === phase) custodyWait = undefined;
      phase.custodyHeld = held && currentObservation(phase);
      phase.timing.custody = Date.now() - phase.startedAt;
      resolve(phase.custodyHeld);
    };
    custodyWait = { phase, finish };
    try {
      process.send({ kind: MESSAGES.CUSTODY, state: CUSTODY.BEGIN, phase: phase.custody }, error => { if (error) finish(false); });
    } catch { finish(false); }
  });
}
async function readProcessIdentities(pids, phase) {
  identityObservation = null;
  const uniquePids = [...new Set(pids)];
  const identities = new Map();
  if (!uniquePids.length || !currentObservation(phase)) return identities;
  if (process.platform === 'linux') {
    for (const pid of uniquePids) {
      if (!currentObservation(phase)) return new Map();
      try {
        const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (fields[19]) identities.set(pid, 'linux:' + fields[19]);
      } catch {}
    }
    return currentObservation(phase) ? identities : new Map();
  }
  if (process.platform !== 'darwin') return identities;
  const result = await collector.run(phase, process.env.PYTHON || 'python3', [...DARWIN_PROCESS_IDENTITY_FLAGS, '-c', DARWIN_PROCESS_IDENTITY_SCRIPT, ...uniquePids.map(String)], { ...process.env, LC_ALL: 'C' });
  try {
    identityObservation = gateSyscallObservation({ outcome: result.status === 0 ? 'subprocess-complete' : 'command-failed', pid: result.pid, status: result.status, signal: result.signal, errorCode: result.error?.code, childErrorCode: result.childErrorCode, failureOrigin: result.failureOrigin, timing: result.timing });
  } catch {}
  if (result.status !== 0 || !currentObservation(phase)) return identities;
  try {
    for (const [rawPid, identity] of Object.entries(JSON.parse(result.stdout))) {
      const pid = Number(rawPid);
      if (uniquePids.includes(pid) && typeof identity === 'string' && identity) identities.set(pid, 'darwin:' + identity);
    }
  } catch { if (identityObservation) identityObservation.outcome = 'parse-failed'; }
  return identities;
}
function sameProcessIdentity(expected, actual) {
  return typeof expected === 'string' && expected.length > 0 && expected === actual;
}
async function readProcessTable(phase) {
  processTableObservation = null;
  const nativeMonitor = process.platform === 'darwin' && phase.kind === 'monitor';
  phase.nativeMonitor = nativeMonitor;
  if (nativeMonitor) identityObservation = null;
  if (!await holdCustody(phase)) return null;
  const unresolvedScope = new Set([...escapedDescendants].filter(([, identity]) => identity === null).map(([pid]) => pid));
  const command = nativeMonitor ? process.env.PYTHON || 'python3' : 'ps';
  const args = nativeMonitor
    ? [...DARWIN_PROCESS_IDENTITY_FLAGS, '-c', DARWIN_PROCESS_IDENTITY_SCRIPT, '--table', String(group), String(process.pid),
      ...[...unresolvedScope].map(String)]
    : ['-A', '-o', 'pid=,ppid=,pgid=,stat='];
  const result = await collector.run(phase, command, args, { ...process.env, LC_ALL: 'C' });
  try {
    processTableObservation = gateSyscallObservation({ outcome: result.status === 0 ? 'subprocess-complete' : 'command-failed', pid: result.pid, status: result.status, signal: result.signal, errorCode: result.error?.code, childErrorCode: result.childErrorCode, failureOrigin: result.failureOrigin, timing: result.timing });
  } catch {}
  if (result.status !== 0 || !currentObservation(phase)) return null;
  const identities = new Map();
  const rows = result.stdout.split('\n').map(line => {
    const match = line.trim().match(nativeMonitor
      ? /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)(?:\s+(\S+))?$/
      : /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/);
    if (!match) return null;
    const row = { pid: Number(match[1]), parent: Number(match[2]), pgid: Number(match[3]), state: match[4] };
    const rememberedUnresolved = unresolvedScope.has(row.pid) && escapedDescendants.get(row.pid) === null;
    if (nativeMonitor && row.pid !== process.pid && row.pid !== result.pid && (row.pgid !== group || rememberedUnresolved) && !row.state.startsWith('Z')
        && /^darwin:[1-9]\d*:\d{1,6}:[1-9]\d*:[1-9]\d*$/.test(match[5] || '')) identities.set(row.pid, match[5]);
    return row;
  }).filter(Boolean).filter(row => row.pid !== result.pid);
  if (!rows.some(row => row.pid === process.pid)) {
    if (processTableObservation) processTableObservation.outcome = 'self-missing';
    return null;
  }
  // Native enumeration can truncate during churn, so only a full ps boundary may clear custody.
  phase.tableComplete = !nativeMonitor;
  const monitorIdentities = nativeMonitor ? Object.freeze({ phase, generation: phase.generation, rows, identities }) : undefined;
  phase.monitorIdentities = monitorIdentities;
  return { rows, scannerPid: result.pid, monitorIdentities };
}
async function rememberEscapedDescendants(rows, phase, monitorIdentities) {
  const descendants = new Set([group, process.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.parent) && !descendants.has(row.pid) && !row.state.startsWith('Z')) {
        descendants.add(row.pid);
        changed = true;
        if (row.pid !== process.pid && row.pgid !== group && !escapedDescendants.has(row.pid)) {
          escapedDescendants.set(row.pid, null);
          try { if (process.connected) process.send({ kind: MESSAGES.CUSTODY, phase: phase.custody, escaped: true }, () => {}); } catch {}
        }
      }
    }
  }
  const unresolved = [...escapedDescendants]
    .filter(([pid, identity]) => identity === null && descendants.has(pid)
      && rows.some(row => row.pid === pid && !row.state.startsWith('Z')))
    .map(([pid]) => pid);
  let identities;
  if (phase.nativeMonitor) {
    identities = new Map();
    if (monitorIdentities === phase.monitorIdentities && monitorIdentities?.phase === phase
        && monitorIdentities.generation === phase.generation && monitorIdentities.rows === rows && currentObservation(phase)) {
      for (const pid of unresolved) {
        const identity = monitorIdentities.identities.get(pid);
        if (identity) identities.set(pid, identity);
      }
    }
  } else identities = await readProcessIdentities(unresolved, phase);
  if (!currentObservation(phase)) return;
  for (const [pid, identity] of identities) escapedDescendants.set(pid, identity);
}
async function signalEscapedDescendants(signal, rows, phase) {
  if (!rows) return;
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const candidates = [...escapedDescendants].filter(([pid, identity]) => identity && byPid.has(pid));
  const identities = await readProcessIdentities(candidates.map(([pid]) => pid), phase);
  if (!currentObservation(phase)) return;
  for (const [pid, expected] of candidates) {
    if (!currentObservation(phase)) return;
    const row = byPid.get(pid);
    if (!row || row.state.startsWith('Z') || !sameProcessIdentity(expected, identities.get(pid))) continue;
    try { process.kill(pid, signal); } catch {}
  }
}
async function hasLiveEscapedDescendants(rows, phase) {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const candidates = [...escapedDescendants].filter(([pid]) => byPid.has(pid));
  const identities = await readProcessIdentities(candidates.map(([pid]) => pid), phase);
  if (!currentObservation(phase)) return true;
  return candidates.some(([pid, expected]) => {
    const row = byPid.get(pid);
    if (!row || row.state.startsWith('Z')) return false;
    return !expected || !identities.has(pid) || sameProcessIdentity(expected, identities.get(pid));
  });
}
async function hasOwnedProcesses(table, phase) {
  if (!table) return true;
  const peers = table.rows.some(row => row.pgid === group && ![process.pid, group, table.scannerPid].includes(row.pid) && !row.state.startsWith('Z'));
  return peers || await hasLiveEscapedDescendants(table.rows, phase);
}
async function monitorDescendants() {
  if (!body || stopping || boundaryPending || collector.owned()) return;
  const phase = beginObservation('monitor');
  if (!phase) return stop(WATCHDOG_STOP_EVENTS.MONITOR_TABLE);
  try {
    const snapshot = await readProcessTable(phase);
    if (stopping || phase.generation !== observationGeneration) return;
    if (!snapshot) return stop(WATCHDOG_STOP_EVENTS.MONITOR_TABLE);
    await rememberEscapedDescendants(snapshot.rows, phase, snapshot.monitorIdentities);
    if (!stopping && phase.generation === observationGeneration && !currentObservation(phase)) stop(WATCHDOG_STOP_EVENTS.MONITOR_TABLE);
  } catch (error) { stop(WATCHDOG_STOP_EVENTS.MONITOR_TABLE, error); }
  finally { finishObservation(phase); }
}
async function stopObservation(signal, phaseDeadline) {
  await collector.whenClosed();
  if (terminationStage !== signal) return;
  const phase = beginObservation(signal, phaseDeadline);
  try {
    const snapshot = phase ? await readProcessTable(phase) : null;
    if (snapshot) {
      await rememberEscapedDescendants(snapshot.rows, phase);
      await signalEscapedDescendants(signal, snapshot.rows, phase);
    }
  } catch {}
  finally { finishObservation(phase); }
  if (signal === 'SIGKILL') finishStop();
}
async function completeCleanup(code) {
  await collector.whenClosed();
  if (completionSent || (code === 0 && stopping)) return;
  const completionDeadline = observationDeadline(code === 0 ? 'drain' : 'orphan');
  if (completionDeadline === null || Date.now() >= completionDeadline) return process.exit(NO_VERDICT);
  completionSent = true;
  if (orphan || !process.connected) {
    releaseScratch(process.env[SCRATCH_ROOT], completionDeadline);
    return process.exit(NO_VERDICT);
  }
  try {
    process.send({ kind: MESSAGES.CLEANUP_COMPLETE, code }, error => process.exit(error ? NO_VERDICT : code));
  } catch { process.exit(NO_VERDICT); }
}
async function finishStop() {
  await collector.whenClosed();
  setTimeout(async () => {
    const phase = beginObservation('orphan');
    let complete = false;
    try {
      const table = phase ? await readProcessTable(phase) : null;
      if (table) await rememberEscapedDescendants(table.rows, phase);
      const owned = await hasOwnedProcesses(table, phase);
      complete = !owned && currentObservation(phase);
    } catch {}
    finally { finishObservation(phase); }
    await collector.whenClosed();
    const cleanupDeadline = observationDeadline('orphan');
    if (complete && cleanupDeadline !== null && Date.now() < cleanupDeadline) await completeCleanup(NO_VERDICT);
    else process.exit(NO_VERDICT);
  }, 50);
}
function stop(event, error) {
  if (stopping) return;
  stopping = true;
  const killAt = Date.now() + 2000;
  ++observationGeneration;
  boundaryPending = false;
  let observation;
  try { observation = watchdogStopObservation({ event, errorCode: error?.code, lastTable: processTableObservation, lastIdentity: identityObservation }); } catch {}
  clearInterval(processMonitor);
  process.on('SIGTERM', () => {});
  collector.cancel();
  terminationStage = 'SIGTERM';
  try { process.kill(-group, 'SIGTERM'); } catch {}
  setTimeout(() => {
    ++observationGeneration;
    collector.cancel();
    terminationStage = 'SIGKILL';
    try { process.kill(-group, 'SIGKILL'); } catch {}
    collector.signal('SIGKILL');
    stopObservation('SIGKILL');
  }, Math.max(0, killAt - Date.now()));
  stopObservation('SIGTERM', killAt);
  try { if (process.connected && observation) process.send({ kind: MESSAGES.STOP, observation }, () => {}); } catch {}
}
async function check() {
  if (!canFinish(stopping)) return;
  if (Date.now() >= Number(deadline)) return stop(WATCHDOG_STOP_EVENTS.CHECK_DEADLINE);
  if (!draining) return;
  const phase = await freshObservation('drain');
  if (stopping) return;
  if (!phase) return stop(WATCHDOG_STOP_EVENTS.DRAIN_TABLE);
  try {
    const table = await readProcessTable(phase);
    if (stopping || phase.generation !== observationGeneration) return;
    if (!table) return stop(WATCHDOG_STOP_EVENTS.DRAIN_TABLE);
    await rememberEscapedDescendants(table.rows, phase);
    const peers = table.rows.filter(row => row.pgid === group && ![process.pid, group, table.scannerPid].includes(row.pid) && !row.state.startsWith('Z'));
    if (peers.length) return stop(WATCHDOG_STOP_EVENTS.DRAIN_PEERS);
    const liveEscapes = await hasLiveEscapedDescendants(table.rows, phase);
    if (stopping || phase.generation !== observationGeneration) return;
    if (liveEscapes || !currentObservation(phase)) return stop(WATCHDOG_STOP_EVENTS.DRAIN_ESCAPES);
    finishObservation(phase);
    await completeCleanup(0);
  } catch (error) { stop(WATCHDOG_STOP_EVENTS.DRAIN_TABLE, error); }
  finally { finishObservation(phase); }
}
async function scanBody() {
  if (bodyScanned || bodyScanRequested || stopping || draining || !body) return;
  bodyScanRequested = true;
  const phase = await freshObservation('body-complete');
  if (stopping || draining) return;
  if (!phase) return stop(WATCHDOG_STOP_EVENTS.BODY_TABLE);
  try {
    const snapshot = await readProcessTable(phase);
    if (stopping || phase.generation !== observationGeneration) return;
    if (!snapshot) return stop(WATCHDOG_STOP_EVENTS.BODY_TABLE);
    await rememberEscapedDescendants(snapshot.rows, phase);
    if (stopping || draining || phase.generation !== observationGeneration) return;
    if (!currentObservation(phase) || !process.connected) return stop(WATCHDOG_STOP_EVENTS.BODY_SCAN_UNAVAILABLE);
    bodyScanned = true;
    process.send({ kind: MESSAGES.BODY_SCAN_COMPLETE }, error => { if (error) stop(WATCHDOG_STOP_EVENTS.BODY_SCAN_SEND, error); });
  } catch (error) { stop(WATCHDOG_STOP_EVENTS.BODY_SCAN_SEND, error); }
  finally { finishObservation(phase); }
}
process.on('message', message => {
  if (message.kind === MESSAGES.CUSTODY && message.state === CUSTODY.ACK && custodyWait?.phase.custody === message.phase) custodyWait.finish(true);
  if (message.kind === MESSAGES.ADMIT && !admission && !stopping && !draining) admission = true;
  if (message.kind === MESSAGES.ADMISSION_EXIT && admission && !body && !stopping && !draining) admissionSucceeded = message.code === 0;
  if (message.kind === MESSAGES.START && !body && !stopping && !draining) {
    if (!admissionSucceeded) return stop(WATCHDOG_STOP_EVENTS.START_UNADMITTED);
    body = true;
    try { process.send({ kind: MESSAGES.START }, error => { if (error) stop(WATCHDOG_STOP_EVENTS.PARENT_STOP, error); }); }
    catch (error) { stop(WATCHDOG_STOP_EVENTS.PARENT_STOP, error); }
    processMonitor = setInterval(monitorDescendants, PROCESS_MONITOR_INTERVAL_MS);
    processMonitor.unref();
  }
  if (message.kind === MESSAGES.BODY_COMPLETE) scanBody();
  if (message.kind === MESSAGES.BODY_EXIT && body) bodyExited = true;
  if (message.kind === MESSAGES.DRAIN && !draining && (!body || bodyExited)) { draining = true; check(); }
  if (message.kind === MESSAGES.STOP) { orphan ||= Boolean(message.orphan); stop(WATCHDOG_STOP_EVENTS.PARENT_STOP); }
});
process.on('disconnect', () => { orphan = true; custodyWait?.finish(true); stop(WATCHDOG_STOP_EVENTS.PARENT_DISCONNECT); });
process.on('SIGTERM', () => stop(WATCHDOG_STOP_EVENTS.SIGTERM));
setTimeout(() => stop(WATCHDOG_STOP_EVENTS.TIMER), Math.max(1, Number(deadline) - Date.now()));
process.send({ kind: MESSAGES.READY });
