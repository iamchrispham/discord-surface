import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { boundSocketFileIdentity, captureBoundSocketIdentity, chmodBoundSocket } from './socket-ownership/bound-identity';
import { SOCKET_ENDPOINT_MAX_LENGTH } from './socket-ownership/rendezvous';
import {
  clearSocketQuarantines,
  prepareSocketQuarantine,
  removeSocketQuarantine,
  restoreQuarantinedSocket,
  unlinkSocketIfOwned as unlinkSocketIfOwnedQuarantine,
  type QuarantineDependencies
} from './socket-ownership/quarantine';
import { acquireSocketLock as acquireSocketLockImpl, lockPathForSocket } from './socket-ownership/lock';
import {
  effectiveUserId,
  isSocketLockOwnerAlive,
  ownerIdentity,
  parseSocketLockOwner,
  sameFile,
  writeOwnerMarker
} from './socket-ownership/lock-owner';
import type { SocketIdentity } from './socket-ownership/types';

export type { SocketIdentity } from './socket-ownership/types';

export type SocketPathIdentity = SocketIdentity;

export type SocketLockRelease = () => void;

// Re-exported at the existing public path. Local binding form (rather than a
// `export ... from` specifier) keeps the emitted CommonJS export a writable
// data property, matching the baseline public surface for test mocking.
const acquireSocketLock = acquireSocketLockImpl;
export { acquireSocketLock };

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

export function chmodBoundSocketPath(socketPath: string, mode: number): boolean {
  return chmodBoundSocket(socketPath, mode);
}

export async function boundSocketIdentity(server: http.Server, socketPath: string, signal?: AbortSignal): Promise<SocketPathIdentity> { return captureBoundSocketIdentity(server, socketPath, { owner: effectiveUserId(), sameSocket, signal }); }

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
