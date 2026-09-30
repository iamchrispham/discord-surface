import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalSocketPath, pathsOverlap } from './path';
import {
  assertLockNamespaceIsUsable,
  LOCK_NAMESPACE,
  lockNamespaceCandidate,
  ownerControlledNamespaceRoot
} from './rendezvous';
import {
  effectiveUserId,
  fileGeneration,
  isSocketLockOwnerAlive,
  ownerIdentity,
  processIdentity,
  readSocketLockOwner,
  readSocketLockOwnerSnapshot,
  sameFile,
  sameGeneration,
  sameOwnerMarker,
  sameOwnerRecord,
  writeOwnerMarker
} from './lock-owner';
import type { FileGeneration, OwnerMarkerSnapshot, OwnerRecord } from './types';

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

export function lockPathForSocket(socketPath: string): string {
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

function unlinkIfPresent(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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

export function acquireSocketLock(socketPath: string): () => void {
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
