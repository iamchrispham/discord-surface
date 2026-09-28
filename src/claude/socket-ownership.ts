import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalSocketPath, pathsOverlap } from './socket-ownership/path';
import { boundSocketFileIdentity, captureBoundSocketIdentity, chmodBoundSocket } from './socket-ownership/bound-identity';
import {
  assertLockNamespaceIsUsable,
  LOCK_NAMESPACE,
  lockNamespaceCandidate,
  ownerControlledNamespaceRoot,
  SOCKET_ENDPOINT_MAX_LENGTH
} from './socket-ownership/rendezvous';
import {
  clearSocketQuarantines,
  prepareSocketQuarantine,
  removeSocketQuarantine,
  restoreQuarantinedSocket,
  unlinkSocketIfOwned as unlinkSocketIfOwnedQuarantine,
  type QuarantineDependencies
} from './socket-ownership/quarantine';
import type { FileGeneration, FileIdentity, OwnerMarkerSnapshot, OwnerRecord, SocketIdentity } from './socket-ownership/types';

export type { SocketIdentity } from './socket-ownership/types';

export type SocketPathIdentity = SocketIdentity;

export type SocketLockRelease = () => void;

const linuxBootId = readLinuxBootId();
const ownerIdentity = processIdentity(process.pid);

function effectiveUserId(): number | undefined {
  return process.geteuid?.() ?? process.getuid?.();
}

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

function processIdentity(pid: number): string | undefined {
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

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameGeneration(left: FileGeneration, right: FileGeneration): boolean {
  return sameFile(left, right) && left.ctimeNs === right.ctimeNs;
}

function sameSocket(left: SocketIdentity, right: SocketIdentity): boolean {
  return sameFile(left, right) && left.ctimeNs === right.ctimeNs && left.birthtimeNs === right.birthtimeNs;
}

function sameSocketPath(left: SocketIdentity, right: SocketIdentity): boolean {
  return sameFile(left, right) && left.birthtimeNs === right.birthtimeNs;
}

function sameQuarantinedSocket(left: SocketIdentity, right: SocketIdentity): boolean {
  return sameFile(left, right) && left.birthtimeNs !== undefined && right.birthtimeNs !== undefined &&
    left.birthtimeNs === right.birthtimeNs;
}

function sameOwnerRecord(left: OwnerRecord, right: OwnerRecord): boolean {
  return left.pid === right.pid && left.identity === right.identity && left.generation === right.generation;
}

function sameOwnerMarker(left: OwnerMarkerSnapshot, right: OwnerMarkerSnapshot): boolean {
  if (!sameFile(left.identity, right.identity) || !sameOwnerRecord(left.owner, right.owner)) return false;
  return left.owner.generation !== undefined || right.owner.generation !== undefined ||
    left.identity.ctimeNs === right.identity.ctimeNs;
}

function fileIdentity(filePath: string): FileIdentity {
  const stats = fs.lstatSync(filePath, { bigint: true });
  return { dev: stats.dev, ino: stats.ino };
}

function fileGeneration(filePath: string): FileGeneration {
  const stats = fs.lstatSync(filePath, { bigint: true });
  return { dev: stats.dev, ino: stats.ino, ctimeNs: stats.ctimeNs };
}

function socketIdentity(filePath: string): SocketIdentity {
  const stats = fs.lstatSync(filePath, { bigint: true });
  return { dev: stats.dev, ino: stats.ino, ctimeNs: stats.ctimeNs, birthtimeNs: stats.birthtimeNs };
}

export function socketPathIdentity(socketPath: string): SocketPathIdentity | undefined {
  try { return socketIdentity(socketPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function boundSocketPathIdentity(server: http.Server): SocketPathIdentity | undefined {
  return boundSocketFileIdentity(server);
}

export function chmodBoundSocketPath(server: http.Server, mode: number): boolean {
  return chmodBoundSocket(server, mode);
}

export async function boundSocketIdentity(server: http.Server, socketPath: string, signal?: AbortSignal): Promise<SocketPathIdentity> { return captureBoundSocketIdentity(server, socketPath, { owner: effectiveUserId(), sameSocket, signal }); }

function lockNamespacePath(socketPath: string): string {
  const root = ownerControlledNamespaceRoot({
    effectiveUserId,
    fileGeneration,
    sameGeneration
  });
  const owner = effectiveUserId();
  const ownerName = owner === undefined ? 'shared' : String(owner);
  const namespacePath = lockNamespaceCandidate(root, `${LOCK_NAMESPACE}-${ownerName}`);
  if (pathsOverlap(socketPath, namespacePath)) {
    throw new Error('Claude channel socket lock namespace conflicts with socket path');
  }
  try {
    fs.mkdirSync(namespacePath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  assertLockNamespaceIsUsable(namespacePath, owner);
  return namespacePath;
}

function lockPathForSocket(socketPath: string): string {
  const identityPath = canonicalSocketPath(socketPath);
  const key = createHash('sha256').update(identityPath).digest('hex').slice(0, 32);
  return path.join(lockNamespacePath(identityPath), `${key}.lock`);
}

function ownerPathForLock(lockPath: string): string {
  return path.join(lockPath, 'owner');
}

function transitionPathForLock(lockPath: string): string {
  const identity = ownerIdentity ? Buffer.from(ownerIdentity).toString('base64url') : 'unknown';
  return path.join(lockPath, `.transition-${process.pid}-${identity}`);
}

function stagingPathForNamespace(namespacePath: string): string {
  return path.join(namespacePath, `.staging-${process.pid}-${randomUUID()}`);
}

function validateSocketDirectoryPath(directoryPath: string): void {
  const owner = effectiveUserId();
  const root = path.parse(directoryPath).root;
  let current = root;
  for (const component of directoryPath.slice(root.length).split(path.sep).filter(Boolean)) {
    const next = path.join(current, component);
    let entry: fs.Stats;
    try { entry = fs.lstatSync(next); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    const parent = fs.statSync(current);
    const parentIsSticky = (parent.mode & 0o1000) !== 0;
    const parentIsMutable = ((parent.mode & 0o022) !== 0 && !parentIsSticky) ||
      (owner !== undefined && parent.uid !== 0 && parent.uid !== owner);
    if (parentIsMutable) throw new Error('Claude channel socket directory contains a mutable path component');
    const entryIsForeign = owner !== undefined && entry.uid !== 0 && entry.uid !== owner;
    const entryIsOwnerWritable = (entry.mode & 0o200) !== 0;
    if (entryIsForeign && entryIsOwnerWritable) {
      if (entry.isSymbolicLink()) throw new Error('Claude channel socket directory contains a foreign-owned symlink');
      if (entry.isDirectory()) throw new Error('Claude channel socket directory contains a foreign-owned directory');
    }
    if (entry.isSymbolicLink()) {
      if (parentIsSticky && owner !== undefined && entry.uid !== owner) {
        throw new Error('Claude channel socket directory contains a foreign-owned symlink');
      }
      const target = fs.statSync(next);
      if (!target.isDirectory()) throw new Error('Claude channel socket directory must resolve to a directory');
    } else if (!entry.isDirectory()) {
      throw new Error('Claude channel socket directory must be a directory');
    } else if (parentIsSticky && owner !== undefined && entry.uid !== owner) {
      throw new Error('Claude channel socket directory contains a foreign-owned directory');
    }
    current = next;
  }
}

function ensureDirectoryOwnerOnly(directoryPath: string): void {
  validateSocketDirectoryPath(directoryPath);
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  validateSocketDirectoryPath(directoryPath);
  const directory = fs.statSync(directoryPath);
  if ((directory.mode & 0o077) || directory.uid !== effectiveUserId()) {
    throw new Error('Claude channel socket directory must be owner-only');
  }
}

export function assertSocketPath(socketPath: string): void {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) {
    throw new Error('Claude channel socket must be an absolute path');
  }
  if (socketPath.length > SOCKET_ENDPOINT_MAX_LENGTH) throw new Error('Claude channel socket path is too long for macOS');
}

export function assertSocketDirectory(socketPath: string): void {
  ensureDirectoryOwnerOnly(path.dirname(socketPath));
  ensureDirectoryOwnerOnly(path.dirname(lockPathForSocket(socketPath)));
}

function parseSocketLockOwner(ownerValue: string): OwnerRecord {
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

function readSocketLockOwner(ownerPath: string): OwnerRecord {
  let ownerValue: string;
  try {
    ownerValue = fs.readFileSync(ownerPath, 'utf8').trim();
  } catch {
    throw new Error('Claude channel socket preparation is already in progress');
  }
  return parseSocketLockOwner(ownerValue);
}

function readSocketLockOwnerSnapshot(ownerPath: string): OwnerMarkerSnapshot {
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

function isSocketLockOwnerAlive(owner: OwnerRecord): boolean {
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

function quarantineDependencies(): QuarantineDependencies {
  return {
    ownerIdentity,
    effectiveUserId,
    parseOwner: parseSocketLockOwner,
    isOwnerAlive: isSocketLockOwnerAlive,
    writeOwnerMarker,
    socketIdentity,
    sameSocket: sameSocketPath,
    sameQuarantinedSocket
  };
}

export function unlinkSocketIfOwned(socketPath: string, expected: SocketPathIdentity | null | undefined): void {
  unlinkSocketIfOwnedQuarantine(socketPath, expected, quarantineDependencies());
}

export type SocketPathQuarantine = {
  restore: () => boolean;
};

export function quarantineMismatchedSocket(
  socketPath: string,
  expected: SocketPathIdentity | null | undefined
): SocketPathQuarantine | undefined {
  if (!expected) return undefined;
  let observedStats: fs.BigIntStats;
  try { observedStats = fs.lstatSync(socketPath, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const observed: SocketIdentity = {
    dev: observedStats.dev,
    ino: observedStats.ino,
    ctimeNs: observedStats.ctimeNs,
    birthtimeNs: observedStats.birthtimeNs
  };
  if (sameSocketPath(observed, expected)) return undefined;
  if (observedStats.isDirectory()) {
    throw new Error('Claude channel socket replacement is a directory');
  }
  if (!observedStats.isSymbolicLink() && !observedStats.isSocket() && !observedStats.isFile()) {
    throw new Error('Claude channel socket replacement has an unsupported type');
  }

  const entryType = observedStats.isSymbolicLink() ? 'symlink' : observedStats.isSocket() ? 'socket' : 'file';
  const quarantineDeps = quarantineDependencies();
  const quarantine = prepareSocketQuarantine(socketPath, observed, quarantineDeps, entryType);
  const quarantinedPath = path.join(quarantine.directory, 'socket');
  let moved = false;
  try {
    fs.renameSync(socketPath, quarantinedPath);
    moved = true;
    const quarantined = socketIdentity(quarantinedPath);
    if (!sameQuarantinedSocket(quarantined, observed)) {
      if (!restoreQuarantinedSocket(quarantinedPath, socketPath, entryType)) {
        throw new Error('Claude channel socket restore is unavailable');
      }
      removeSocketQuarantine(quarantine.directory);
      throw new Error('Claude channel socket changed during stop');
    }
  } catch (error) {
    if (!moved) removeSocketQuarantine(quarantine.directory);
    throw error;
  }

  let restored = false;
  return {
    restore: (): boolean => {
      if (restored) return true;
      const didRestore = restoreQuarantinedSocket(quarantinedPath, socketPath, entryType);
      if (!didRestore) return false;
      removeSocketQuarantine(quarantine.directory);
      restored = true;
      return true;
    }
  };
}

function unlinkIfPresent(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function writeOwnerMarker(ownerPath: string): OwnerRecord {
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

function transitionOwner(transitionPath: string): OwnerRecord | null {
  try { return readSocketLockOwner(path.join(transitionPath, 'claim')); } catch {
    return null;
  }
}

function isTransitionAlive(transitionPath: string): boolean {
  const owner = transitionOwner(transitionPath);
  if (owner) return isSocketLockOwnerAlive(owner);
  const match = path.basename(transitionPath).match(/^\.transition-(\d+)-([A-Za-z0-9_-]+)$/);
  if (!match) return true;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  if (match[2] === 'unknown') return isSocketLockOwnerAlive({ pid });
  let identity: string;
  try { identity = Buffer.from(match[2], 'base64url').toString('utf8'); } catch { return true; }
  return isSocketLockOwnerAlive({ pid, identity });
}

function removeLockDirectory(directoryPath: string): void {
  try {
    for (const entry of fs.readdirSync(directoryPath)) {
      const entryPath = path.join(directoryPath, entry);
      try {
        if (fs.lstatSync(entryPath).isFile()) unlinkIfPresent(entryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try { fs.rmdirSync(directoryPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function removeEmptyDirectory(directoryPath: string): void {
  try { fs.rmdirSync(directoryPath); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
  }
}

function removeTransition(transitionPath: string): void {
  removeLockDirectory(transitionPath);
}

function clearOrphanOwnerTemps(lockPath: string): boolean {
  let entries: string[];
  try { entries = fs.readdirSync(lockPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  for (const entry of entries) {
    const match = entry.match(/^\.owner-(\d+)-/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ownerPath = path.join(lockPath, entry);
    let contents: string;
    try {
      contents = fs.readFileSync(ownerPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let marker: unknown;
    try { marker = JSON.parse(contents); } catch {
      if (!Number.isSafeInteger(pid) || pid < 1 || isSocketLockOwnerAlive({ pid })) return false;
      unlinkIfPresent(ownerPath);
      continue;
    }
    if (!marker || typeof marker !== 'object') continue;
    const markerRecord = marker as { pid?: unknown; identity?: unknown };
    if (markerRecord.pid !== pid) continue;
    if (typeof markerRecord.identity === 'string') {
      if (isSocketLockOwnerAlive({ pid, identity: markerRecord.identity })) return false;
    } else if (markerRecord.identity === undefined) {
      if (isSocketLockOwnerAlive({ pid })) return false;
    } else {
      continue;
    }
    unlinkIfPresent(ownerPath);
  }
  return true;
}

function stagingPathForCurrentCreator(namespacePath: string): string {
  const stagingPath = stagingPathForNamespace(namespacePath);
  const identity = processIdentity(process.pid);
  const identityToken = identity === undefined
    ? 'u'
    : Buffer.from(identity, 'utf8').toString('hex') || 'u';
  const name = path.basename(stagingPath);
  return path.join(namespacePath, name.replace(/^(\.staging-\d+-)/, `$1i${identityToken}-`));
}

function clearOrphanStagingDirs(namespacePath: string): void {
  try {
    assertLockNamespaceIsUsable(namespacePath, effectiveUserId());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  let entries: string[];
  try { entries = fs.readdirSync(namespacePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const legacyMatch = entry.match(/^\.staging-(\d+)-/);
    if (!legacyMatch) continue;
    const identityMatch = entry.match(/^\.staging-(\d+)-i([0-9a-f]+|u)-/);
    const pid = Number(legacyMatch[1]);
    const identityToken = identityMatch?.[2];
    const identity = identityToken && identityToken !== 'u'
      ? Buffer.from(identityToken, 'hex').toString('utf8')
      : identityToken === 'u' ? undefined : processIdentity(pid);
    if (isSocketLockOwnerAlive({ pid, identity })) continue;
    removeLockDirectory(path.join(namespacePath, entry));
  }
}

function createStagingLock(namespacePath: string): string {
  for (;;) {
    const stagingPath = stagingPathForCurrentCreator(namespacePath);
    try {
      fs.mkdirSync(stagingPath, { mode: 0o700 });
      return stagingPath;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        try { fs.mkdirSync(namespacePath, { mode: 0o700 }); } catch (recreateError) {
          if ((recreateError as NodeJS.ErrnoException).code !== 'EEXIST') throw recreateError;
        }
        assertLockNamespaceIsUsable(namespacePath, effectiveUserId());
        continue;
      }
      if (code !== 'EEXIST') throw error;
    }
  }
}

function clearStaleTransitions(lockPath: string, currentPath: string): boolean {
  let entries: string[];
  try { entries = fs.readdirSync(lockPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.startsWith('.transition-')) continue;
    const transitionPath = path.join(lockPath, entry);
    if (transitionPath === currentPath) continue;
    if (isTransitionAlive(transitionPath)) return false;
    removeTransition(transitionPath);
  }
  return true;
}

function claimTransition(lockPath: string): string | null {
  const transitionPath = transitionPathForLock(lockPath);
  for (;;) {
    if (!clearStaleTransitions(lockPath, transitionPath)) return null;
    try {
      fs.mkdirSync(transitionPath, { mode: 0o700 });
      writeOwnerMarker(path.join(transitionPath, 'claim'));
      return transitionPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Resume this process's deterministic transition after cleanup failed.
      return transitionPath;
    }
  }
}

function reclaimOwnerFile(
  lockPath: string,
  ownerPath: string,
  expected?: OwnerMarkerSnapshot,
  expectedLockGeneration?: FileGeneration
): boolean {
  if (expectedLockGeneration) {
    let observedLock: FileGeneration;
    try { observedLock = fileGeneration(lockPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (!sameGeneration(observedLock, expectedLockGeneration)) return false;
  }
  const transitionPath = claimTransition(lockPath);
  if (!transitionPath) return false;
  const tombstonePath = path.join(transitionPath, 'owner');
  let transitionGeneration: FileGeneration | undefined;
  if (expectedLockGeneration) {
    try { transitionGeneration = fileGeneration(transitionPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  try {
    if (expectedLockGeneration) {
      let observedLock: FileGeneration;
      try { observedLock = fileGeneration(lockPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      if (!sameFile(observedLock, expectedLockGeneration)) return false;
      let observedTransition: FileGeneration;
      try { observedTransition = fileGeneration(transitionPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      if (!transitionGeneration || !sameGeneration(observedTransition, transitionGeneration)) return false;
    }
    let observed: OwnerMarkerSnapshot | undefined;
    try { observed = readSocketLockOwnerSnapshot(ownerPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return clearOrphanOwnerTemps(lockPath);
      throw error;
    }
    if (expectedLockGeneration && observed) return false;
    if (expected && !sameOwnerMarker(observed, expected)) return false;
    try { fs.renameSync(ownerPath, tombstonePath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return clearOrphanOwnerTemps(lockPath);
      throw error;
    }
    const moved = readSocketLockOwnerSnapshot(tombstonePath);
    if (!sameFile(moved.identity, observed.identity) || !sameOwnerRecord(moved.owner, observed.owner)) {
      fs.renameSync(tombstonePath, ownerPath);
      return false;
    }
    fs.unlinkSync(tombstonePath);
    return true;
  } finally {
    removeTransition(transitionPath);
  }
}

function reclaimOwnerlessLock(
  lockPath: string,
  ownerPath: string,
  expectedOwner?: OwnerMarkerSnapshot,
  expectedLockGeneration?: FileGeneration
): boolean {
  if (!reclaimOwnerFile(lockPath, ownerPath, expectedOwner, expectedLockGeneration)) return false;
  if (!clearOrphanOwnerTemps(lockPath)) return false;
  try { fs.rmdirSync(lockPath); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
    throw error;
  }
  return true;
}

function publishOwner(lockPath: string): { ownerPath: string; marker: OwnerMarkerSnapshot } {
  const ownerPath = ownerPathForLock(lockPath);
  const owner = writeOwnerMarker(ownerPath);
  return { ownerPath, marker: { owner, identity: fileGeneration(ownerPath) } };
}

function releaseSocketLock(lockPath: string, ownerPath: string, marker: OwnerMarkerSnapshot): void {
  if (!reclaimOwnerFile(lockPath, ownerPath, marker)) {
    throw new Error('Claude channel socket preparation lock owner changed before release');
  }
  removeEmptyDirectory(lockPath);
}

export function acquireSocketLock(socketPath: string): SocketLockRelease {
  const lockPath = lockPathForSocket(socketPath);
  const ownerPath = ownerPathForLock(lockPath);
  const namespacePath = path.dirname(lockPath);
  for (;;) {
    clearOrphanStagingDirs(namespacePath);
    const stagingPath = createStagingLock(namespacePath);
    try {
      const stagedOwner = publishOwner(stagingPath);
      fs.renameSync(stagingPath, lockPath);
      const owner = { ownerPath, marker: stagedOwner.marker };
      let released = false;
      return () => {
        if (released) return;
        releaseSocketLock(lockPath, owner.ownerPath, owner.marker);
        released = true;
      };
    } catch (error) {
      removeLockDirectory(stagingPath);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'ENOTDIR') throw error;
      let lockStats: fs.BigIntStats;
      try { lockStats = fs.lstatSync(lockPath, { bigint: true }); } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw statError;
      }
      if (lockStats.isDirectory()) {
        const lockGeneration: FileGeneration = { dev: lockStats.dev, ino: lockStats.ino, ctimeNs: lockStats.ctimeNs };
        let ownerSnapshot: OwnerMarkerSnapshot;
        try { ownerSnapshot = readSocketLockOwnerSnapshot(ownerPath); } catch (ownerError) {
          if ((ownerError as NodeJS.ErrnoException).code !== 'ENOENT') throw ownerError;
          if (reclaimOwnerlessLock(lockPath, ownerPath, undefined, lockGeneration)) continue;
          throw new Error('Claude channel socket preparation is already in progress');
        }
        const owner = ownerSnapshot.owner;
        if (isSocketLockOwnerAlive(owner)) {
          throw new Error('Claude channel socket preparation is already in progress');
        }
        if (!reclaimOwnerlessLock(lockPath, ownerPath, ownerSnapshot)) {
          throw new Error('Claude channel socket preparation is already in progress');
        }
        continue;
      }
      throw new Error('Claude channel socket preparation is already in progress');
    }
  }
}

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown }).message);
}

export async function withSocketLock<T>(socketPath: string, action: () => Promise<T>): Promise<T> {
  assertSocketPath(socketPath);
  assertSocketDirectory(socketPath);
  const release = acquireSocketLock(socketPath);
  try {
    return await action();
  } finally {
    let releaseError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        release();
        releaseError = undefined;
        break;
      } catch (error) {
        releaseError = error;
      }
    }
    if (releaseError) throw releaseError;
  }
}

export async function prepareSocket(socketPath: string, signal?: AbortSignal): Promise<void> {
  const quarantineDeps = quarantineDependencies();
  clearSocketQuarantines(path.dirname(socketPath), quarantineDeps, path.basename(socketPath));
  let original: fs.BigIntStats;
  try { original = fs.lstatSync(socketPath, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!original.isSocket()) throw new Error('Claude channel path exists and is not a socket');
  const owner = effectiveUserId();
  if (owner !== undefined && original.uid !== BigInt(owner)) throw new Error('Claude channel socket belongs to another owner');
  if (signal?.aborted) throw new Error('Claude channel stopped during socket preparation');
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Claude channel stopped during socket preparation'));
      return;
    }
    const probe = net.createConnection(socketPath);
    const timer = setTimeout(() => finish(new Error('Claude channel socket probe timed out')), 1000);
    let settled = false;
    const onAbort = (): void => finish(new Error('Claude channel stopped during socket preparation'));
    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      probe.destroy();
      if (error) {
        reject(error);
        return;
      }
      let current: fs.BigIntStats;
      try { current = fs.lstatSync(socketPath, { bigint: true }); } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve();
          return;
        }
        reject(statError);
        return;
      }
      if (!current.isSocket() || current.uid !== original.uid || current.dev !== original.dev ||
        current.ino !== original.ino || current.ctimeNs !== original.ctimeNs ||
        current.birthtimeNs !== original.birthtimeNs) {
        reject(new Error('Claude channel socket changed during stale probe'));
        return;
      }
      let quarantineDirectory: string | undefined;
      let quarantineMoved = false;
      try {
        const expected: SocketIdentity = {
          dev: original.dev,
          ino: original.ino,
          ctimeNs: original.ctimeNs,
          birthtimeNs: original.birthtimeNs
        };
        const quarantine = prepareSocketQuarantine(socketPath, expected, quarantineDeps);
        quarantineDirectory = quarantine.directory;
        const quarantinedPath = path.join(quarantineDirectory, 'socket');
        fs.renameSync(socketPath, quarantinedPath);
        quarantineMoved = true;
        const quarantined = fs.lstatSync(quarantinedPath);
        if (!quarantined.isSocket() || (owner !== undefined && quarantined.uid !== owner) ||
          !sameQuarantinedSocket(socketIdentity(quarantinedPath), expected)) {
          if (!restoreQuarantinedSocket(quarantinedPath, socketPath)) {
            reject(new Error('Claude channel socket restore is unavailable'));
            return;
          }
          removeSocketQuarantine(quarantineDirectory);
          quarantineDirectory = undefined;
          reject(new Error('Claude channel socket changed during stale probe'));
          return;
        }
        fs.unlinkSync(quarantinedPath);
        removeSocketQuarantine(quarantineDirectory);
        quarantineDirectory = undefined;
        resolve();
      } catch (cleanupError) {
        if (quarantineDirectory !== undefined && !quarantineMoved) {
          removeSocketQuarantine(quarantineDirectory);
          quarantineDirectory = undefined;
        }
        if ((cleanupError as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve();
          return;
        }
        reject(cleanupError);
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    probe.once('connect', () => finish(new Error('Claude channel socket already exists; stop its owner first')));
    probe.once('error', (error: Error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED' || code === 'ENOENT') finish();
      else finish(error as Error);
    });
  });
}
