import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

type OwnerRecord = {
  pid: number;
  identity?: string;
};

type FileIdentity = {
  dev: bigint;
  ino: bigint;
};

export type SocketLockRelease = () => void;

const LOCK_NAMESPACE = '.discord-surface-locks';
const ownerIdentity = processIdentity(process.pid);

function processIdentity(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const endOfCommand = stat.lastIndexOf(')');
    const fields = stat.slice(endOfCommand + 2).trim().split(/\s+/);
    const startTime = fields[19];
    if (startTime) return `proc:${startTime}`;
  } catch {}
  try {
    const startTime = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (startTime) return `ps:${startTime}`;
  } catch {}
  return undefined;
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fileIdentity(filePath: string): FileIdentity {
  const stats = fs.lstatSync(filePath, { bigint: true });
  return { dev: stats.dev, ino: stats.ino };
}

function lockPathForSocket(socketPath: string): string {
  const key = createHash('sha256').update(socketPath).digest('hex').slice(0, 32);
  return path.join(path.dirname(socketPath), LOCK_NAMESPACE, `${key}.lock`);
}

function ownerPathForLock(lockPath: string): string {
  return path.join(lockPath, 'owner');
}

function transitionPathForLock(lockPath: string): string {
  return path.join(lockPath, `.transition-${process.pid}`);
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
  if (socketPath.length > 90) throw new Error('Claude channel socket path is too long for macOS');
}

export function assertSocketDirectory(socketPath: string): void {
  ensureDirectoryOwnerOnly(path.dirname(socketPath));
  ensureDirectoryOwnerOnly(path.dirname(lockPathForSocket(socketPath)));
}

function readSocketLockOwner(ownerPath: string): OwnerRecord {
  let ownerValue: string;
  try {
    ownerValue = fs.readFileSync(ownerPath, 'utf8').trim();
  } catch {
    throw new Error('Claude channel socket preparation is already in progress');
  }
  try {
    const owner = JSON.parse(ownerValue) as Partial<OwnerRecord>;
    const pid = owner.pid;
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && (owner.identity === undefined || typeof owner.identity === 'string')) {
      return { pid, identity: owner.identity };
    }
  } catch {}
  const ownerPid = Number(ownerValue);
  if (Number.isInteger(ownerPid) && ownerPid > 0) return { pid: ownerPid };
  throw new Error('Claude channel socket preparation lock is invalid');
}

function isSocketLockOwnerAlive(owner: OwnerRecord): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (probeError) {
    if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((probeError as NodeJS.ErrnoException).code !== 'EPERM') throw probeError;
  }
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

function writeOwnerMarker(ownerPath: string): void {
  const temporaryPath = path.join(path.dirname(ownerPath), `.owner-${process.pid}-${randomUUID()}`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, identity: ownerIdentity }));
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
}

function transitionOwner(transitionPath: string): OwnerRecord | null {
  try { return readSocketLockOwner(path.join(transitionPath, 'claim')); } catch {
    return null;
  }
}

function isTransitionAlive(transitionPath: string): boolean {
  const owner = transitionOwner(transitionPath);
  if (owner) return isSocketLockOwnerAlive(owner);
  const match = path.basename(transitionPath).match(/^\.transition-(\d+)$/);
  if (!match) return true;
  return isSocketLockOwnerAlive({ pid: Number(match[1]) });
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
    const identity = processIdentity(pid);
    if (isSocketLockOwnerAlive({ pid, identity })) return false;
    unlinkIfPresent(path.join(lockPath, entry));
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
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
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
      if (isTransitionAlive(transitionPath)) return null;
      removeTransition(transitionPath);
    }
  }
}

function reclaimOwnerFile(lockPath: string, ownerPath: string, expected?: FileIdentity): boolean {
  const transitionPath = claimTransition(lockPath);
  if (!transitionPath) return false;
  const tombstonePath = path.join(transitionPath, 'owner');
  try {
    let observed: FileIdentity | undefined;
    try { observed = fileIdentity(ownerPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return clearOrphanOwnerTemps(lockPath);
      throw error;
    }
    if (expected && !sameFile(observed, expected)) return false;
    try { fs.renameSync(ownerPath, tombstonePath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return clearOrphanOwnerTemps(lockPath);
      throw error;
    }
    const moved = fileIdentity(tombstonePath);
    if (!sameFile(moved, observed)) {
      fs.renameSync(tombstonePath, ownerPath);
      return false;
    }
    fs.unlinkSync(tombstonePath);
    return true;
  } finally {
    removeTransition(transitionPath);
  }
}

function reclaimOwnerlessLock(lockPath: string, ownerPath: string, expected?: FileIdentity): boolean {
  if (!reclaimOwnerFile(lockPath, ownerPath, expected)) return false;
  if (!clearOrphanOwnerTemps(lockPath)) return false;
  try { fs.rmdirSync(lockPath); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
    throw error;
  }
  return true;
}

function publishOwner(lockPath: string): { ownerPath: string; identity: FileIdentity } {
  const ownerPath = ownerPathForLock(lockPath);
  writeOwnerMarker(ownerPath);
  return { ownerPath, identity: fileIdentity(ownerPath) };
}

function releaseSocketLock(lockPath: string, ownerPath: string, identity: FileIdentity): void {
  if (!reclaimOwnerFile(lockPath, ownerPath, identity)) {
    throw new Error('Claude channel socket preparation lock owner changed before release');
  }
  try { fs.rmdirSync(lockPath); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
  }
}

function reclaimLegacyLockFile(lockPath: string, expected: FileIdentity): boolean {
  const tombstonePath = `${lockPath}.reclaim-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(lockPath, tombstonePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    if ((error as NodeJS.ErrnoException).code === 'EISDIR') return false;
    throw error;
  }
  try {
    const moved = fileIdentity(tombstonePath);
    if (!sameFile(moved, expected)) {
      fs.renameSync(tombstonePath, lockPath);
      return false;
    }
    fs.unlinkSync(tombstonePath);
    return true;
  } catch (error) {
    try { fs.renameSync(tombstonePath, lockPath); } catch {}
    throw error;
  }
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
      const owner = { ownerPath, identity: stagedOwner.identity };
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseSocketLock(lockPath, owner.ownerPath, owner.identity);
      };
    } catch (error) {
      removeLockDirectory(stagingPath);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'ENOTDIR') throw error;
      let lockStats: fs.Stats;
      try { lockStats = fs.lstatSync(lockPath); } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw statError;
      }
      if (lockStats.isDirectory()) {
        let owner: OwnerRecord;
        try { owner = readSocketLockOwner(ownerPath); } catch (ownerError) {
          if (errorMessage(ownerError) !== 'Claude channel socket preparation is already in progress') throw ownerError;
          if (reclaimOwnerlessLock(lockPath, ownerPath)) continue;
          throw ownerError;
        }
        let ownerIdentityAtCheck: FileIdentity;
        try { ownerIdentityAtCheck = fileIdentity(ownerPath); } catch (identityError) {
          if ((identityError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw identityError;
        }
        if (isSocketLockOwnerAlive(owner)) {
          throw new Error('Claude channel socket preparation is already in progress');
        }
        if (!reclaimOwnerlessLock(lockPath, ownerPath, ownerIdentityAtCheck)) {
          throw new Error('Claude channel socket preparation is already in progress');
        }
        continue;
      }
      if (!lockStats.isFile()) throw new Error('Claude channel socket preparation lock is invalid');
      const owner = readSocketLockOwner(lockPath);
      const lockIdentity = fileIdentity(lockPath);
      if (isSocketLockOwnerAlive(owner)) {
        throw new Error('Claude channel socket preparation is already in progress');
      }
      if (!reclaimLegacyLockFile(lockPath, lockIdentity)) {
        throw new Error('Claude channel socket preparation is already in progress');
      }
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
