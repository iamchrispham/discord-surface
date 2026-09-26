import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

type OwnerRecord = {
  pid: number;
  identity?: string;
  generation?: string;
};

type FileIdentity = {
  dev: bigint;
  ino: bigint;
};

type FileGeneration = FileIdentity & { ctimeNs: bigint };

type SocketIdentity = FileIdentity & { ctimeNs: bigint };

type OwnerMarkerSnapshot = {
  owner: OwnerRecord;
  identity: FileGeneration;
};

export type SocketPathIdentity = SocketIdentity;

export type SocketLockRelease = () => void;

const LOCK_NAMESPACE = '.discord-surface-locks';
const SOCKET_ENDPOINT_MAX_LENGTH = 90;
const LOCK_NAMESPACE_SUFFIX = 'coordination';
const caseSensitivityByDirectory = new Map<string, boolean>();
const normalizationSensitivityByDirectory = new Map<string, boolean>();
const linuxBootId = readLinuxBootId();
const ownerIdentity = processIdentity(process.pid);

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
  return sameFile(left, right) && left.ctimeNs === right.ctimeNs;
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
  return { dev: stats.dev, ino: stats.ino, ctimeNs: stats.ctimeNs };
}

export function socketPathIdentity(socketPath: string): SocketPathIdentity | undefined {
  try { return socketIdentity(socketPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function unlinkSocketIfOwned(socketPath: string, expected: SocketPathIdentity | null | undefined): void {
  if (!expected) return;
  let observed: SocketIdentity;
  try { observed = socketIdentity(socketPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!sameSocket(observed, expected)) return;
  try { fs.unlinkSync(socketPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function alternateCase(value: string): string {
  const index = value.search(/[A-Za-z]/);
  if (index < 0) return value;
  const character = value[index];
  const replacement = character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase();
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

function isCaseInsensitiveDirectory(directoryPath: string): boolean {
  const cached = caseSensitivityByDirectory.get(directoryPath);
  if (cached !== undefined) return cached;
  const probeName = `.discord-surface-case-${randomUUID()}`;
  const probePath = path.join(directoryPath, probeName);
  const alternatePath = path.join(directoryPath, alternateCase(probeName));
  let descriptor: number | undefined;
  let insensitive = false;
  try {
    descriptor = fs.openSync(probePath, 'wx', 0o600);
    try {
      insensitive = sameFile(fileIdentity(probePath), fileIdentity(alternatePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(probePath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  caseSensitivityByDirectory.set(directoryPath, insensitive);
  return insensitive;
}

function isNormalizationInsensitiveDirectory(directoryPath: string): boolean {
  const cached = normalizationSensitivityByDirectory.get(directoryPath);
  if (cached !== undefined) return cached;
  const probeName = `.discord-surface-normalization-${randomUUID()}`;
  const composedPath = path.join(directoryPath, `${probeName}-é`);
  const decomposedPath = path.join(directoryPath, `${probeName}-e\u0301`);
  let descriptor: number | undefined;
  let insensitive = false;
  try {
    descriptor = fs.openSync(composedPath, 'wx', 0o600);
    try {
      insensitive = sameFile(fileIdentity(composedPath), fileIdentity(decomposedPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(composedPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try { fs.unlinkSync(decomposedPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  normalizationSensitivityByDirectory.set(directoryPath, insensitive);
  return insensitive;
}

function canonicalSocketPath(socketPath: string): string {
  const parentPath = path.dirname(socketPath);
  let canonicalParentPath = parentPath;
  try {
    canonicalParentPath = fs.realpathSync(parentPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const basename = path.basename(socketPath);
  const caseInsensitive = isCaseInsensitiveDirectory(canonicalParentPath);
  const normalizationInsensitive = isNormalizationInsensitiveDirectory(canonicalParentPath);
  const normalizedBasename = normalizationInsensitive ? basename.normalize('NFC') : basename;
  if (!caseInsensitive && !normalizationInsensitive) return path.join(canonicalParentPath, basename);
  const comparableBasename = caseInsensitive ? normalizedBasename.toLowerCase() : normalizedBasename;
  return path.join(canonicalParentPath, comparableBasename);
}

function pathIsWithin(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

function pathsOverlap(leftPath: string, rightPath: string): boolean {
  return pathIsWithin(leftPath, rightPath) || pathIsWithin(rightPath, leftPath);
}

function lockNamespaceCandidate(parentPath: string, prefix: string): string {
  const componentPrefix = `${prefix}-${LOCK_NAMESPACE_SUFFIX}`;
  const minimumComponentLength = SOCKET_ENDPOINT_MAX_LENGTH + 1 - parentPath.length - path.sep.length;
  const component = componentPrefix.length >= minimumComponentLength
    ? componentPrefix
    : `${componentPrefix}${'x'.repeat(minimumComponentLength - componentPrefix.length)}`;
  return path.join(parentPath, component);
}

function lockNamespacePath(socketPath: string): string {
  let root: string;
  try {
    root = fs.realpathSync('/tmp');
  } catch {
    throw new Error('Claude channel socket lock namespace root is unavailable');
  }
  const owner = process.getuid?.();
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
  const directory = fs.lstatSync(namespacePath);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
    (owner !== undefined && directory.uid !== owner)) {
    throw new Error('Claude channel socket lock namespace is unusable');
  }
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

function ensureDirectoryOwnerOnly(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const directory = fs.statSync(directoryPath);
  if ((directory.mode & 0o077) || directory.uid !== process.getuid?.()) {
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
      if (fs.lstatSync(entryPath).isFile()) unlinkIfPresent(entryPath);
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
    let marker: unknown;
    try {
      marker = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    } catch {
      continue;
    }
    if (!marker || typeof marker !== 'object') continue;
    const markerRecord = marker as { pid?: unknown; identity?: unknown };
    if (markerRecord.pid !== pid || typeof markerRecord.identity !== 'string') continue;
    if (isSocketLockOwnerAlive({ pid, identity: markerRecord.identity })) return false;
    unlinkIfPresent(ownerPath);
  }
  return true;
}

function clearOrphanStagingDirs(namespacePath: string): void {
  let entries: string[];
  try { entries = fs.readdirSync(namespacePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const match = entry.match(/^\.staging-(\d+)-/);
    if (!match) continue;
    const pid = Number(match[1]);
    const identity = processIdentity(pid);
    if (isSocketLockOwnerAlive({ pid, identity })) continue;
    removeLockDirectory(path.join(namespacePath, entry));
  }
}

function createStagingLock(namespacePath: string): string {
  for (;;) {
    const stagingPath = stagingPathForNamespace(namespacePath);
    try {
      fs.mkdirSync(stagingPath, { mode: 0o700 });
      return stagingPath;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        try { fs.mkdirSync(namespacePath, { mode: 0o700 }); } catch (recreateError) {
          if ((recreateError as NodeJS.ErrnoException).code !== 'EEXIST') throw recreateError;
        }
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
  try {
    if (expectedLockGeneration) {
      let observedLock: FileIdentity;
      try { observedLock = fileIdentity(lockPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      if (!sameFile(observedLock, expectedLockGeneration)) return false;
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
    release();
  }
}

export async function prepareSocket(socketPath: string, signal?: AbortSignal): Promise<void> {
  let original: fs.Stats;
  try { original = fs.lstatSync(socketPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!original.isSocket()) throw new Error('Claude channel path exists and is not a socket');
  if (original.uid !== process.getuid?.()) throw new Error('Claude channel socket belongs to another owner');
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
      let current: fs.Stats;
      try { current = fs.lstatSync(socketPath); } catch (statError) {
        reject(statError);
        return;
      }
      if (!current.isSocket() || current.uid !== original.uid || current.dev !== original.dev ||
        current.ino !== original.ino || current.ctimeMs !== original.ctimeMs) {
        reject(new Error('Claude channel socket changed during stale probe'));
        return;
      }
      try {
        fs.unlinkSync(socketPath);
        resolve();
      } catch (unlinkError) {
        reject(unlinkError);
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    probe.once('connect', () => finish(new Error('Claude channel socket already exists; stop its owner first')));
    probe.once('error', (error: Error) => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') finish();
      else finish(error as Error);
    });
  });
}
