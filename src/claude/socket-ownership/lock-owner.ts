import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileGeneration, FileIdentity, OwnerMarkerSnapshot, OwnerRecord } from './types';

export function effectiveUserId(): number | undefined {
  return process.geteuid?.() ?? process.getuid?.();
}

const linuxBootId = readLinuxBootId();
export const ownerIdentity = processIdentity(process.pid);

type ProcStat = {
  state: string;
  startTime: string;
};

function readLinuxBootId(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return bootId || undefined;
  } catch {}
  return undefined;
}

function readProcStat(pid: number): ProcStat | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const endOfCommand = stat.lastIndexOf(')');
    if (endOfCommand < 0) return undefined;
    const fields = stat.slice(endOfCommand + 2).trim().split(/\s+/);
    const state = fields[0];
    const startTime = fields[19];
    if (state && startTime) return { state, startTime };
  } catch {}
  return undefined;
}

export function processIdentity(pid: number): string | undefined {
  const procStat = readProcStat(pid);
  if (procStat) {
    if (linuxBootId) return `proc:${linuxBootId}:${procStat.startTime}`;
    return `proc:${procStat.startTime}`;
  }
  try {
    const startTime = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }
    }).trim();
    if (startTime) return `${linuxBootId ? `ps:${linuxBootId}:` : 'ps:'}${startTime}`;
  } catch {}
  return undefined;
}

function processState(pid: number): string | undefined {
  const procStat = readProcStat(pid);
  if (procStat) return procStat.state;
  try {
    const state = execFileSync('ps', ['-p', String(pid), '-o', 'state='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }
    }).trim();
    return state.charAt(0) || undefined;
  } catch {}
  return undefined;
}

export function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function sameGeneration(left: FileGeneration, right: FileGeneration): boolean {
  return sameFile(left, right) && left.ctimeNs === right.ctimeNs;
}

export function sameOwnerRecord(left: OwnerRecord, right: OwnerRecord): boolean {
  return left.pid === right.pid && left.identity === right.identity && left.generation === right.generation;
}

export function sameOwnerMarker(left: OwnerMarkerSnapshot, right: OwnerMarkerSnapshot): boolean {
  if (!sameFile(left.identity, right.identity) || !sameOwnerRecord(left.owner, right.owner)) return false;
  return left.owner.generation !== undefined || right.owner.generation !== undefined ||
    left.identity.ctimeNs === right.identity.ctimeNs;
}

export function fileGeneration(filePath: string): FileGeneration {
  const stats = fs.lstatSync(filePath, { bigint: true });
  return { dev: stats.dev, ino: stats.ino, ctimeNs: stats.ctimeNs };
}

export function parseSocketLockOwner(ownerValue: string): OwnerRecord {
  try {
    const owner = JSON.parse(ownerValue) as Partial<OwnerRecord>;
    const pid = owner.pid;
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 &&
      (owner.identity === undefined || typeof owner.identity === 'string') &&
      (owner.generation === undefined || typeof owner.generation === 'string')) {
      return { pid, identity: owner.identity, generation: owner.generation };
    }
  } catch {}
  const ownerPid = Number(ownerValue);
  if (Number.isInteger(ownerPid) && ownerPid > 0) return { pid: ownerPid };
  throw new Error('Claude channel socket preparation lock is invalid');
}

export function readSocketLockOwner(ownerPath: string): OwnerRecord {
  let ownerValue: string;
  try {
    ownerValue = fs.readFileSync(ownerPath, 'utf8').trim();
  } catch {
    throw new Error('Claude channel socket preparation is already in progress');
  }
  return parseSocketLockOwner(ownerValue);
}

export function readSocketLockOwnerSnapshot(ownerPath: string): OwnerMarkerSnapshot {
  let descriptor: number | undefined;
  let ownerValue: string;
  let identity: FileGeneration;
  try {
    descriptor = fs.openSync(ownerPath, 'r');
    const stats = fs.fstatSync(descriptor, { bigint: true });
    ownerValue = fs.readFileSync(descriptor, 'utf8').trim();
    identity = { dev: stats.dev, ino: stats.ino, ctimeNs: stats.ctimeNs };
  } catch (error) {
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
  return { owner: parseSocketLockOwner(ownerValue), identity };
}

export function isSocketLockOwnerAlive(owner: OwnerRecord): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (probeError) {
    if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((probeError as NodeJS.ErrnoException).code !== 'EPERM') throw probeError;
  }
  if (processState(owner.pid)?.startsWith('Z')) return false;
  if (!owner.identity) return true;
  const currentIdentity = processIdentity(owner.pid);
  if (!currentIdentity) return true;
  return currentIdentity === owner.identity;
}

export function writeOwnerMarker(ownerPath: string): OwnerRecord {
  const owner = { pid: process.pid, identity: ownerIdentity, generation: randomUUID() };
  const temporaryPath = path.join(path.dirname(ownerPath), `.owner-${process.pid}-${randomUUID()}`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(owner));
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, ownerPath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
  return owner;
}
