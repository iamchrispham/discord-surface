import * as fs from 'node:fs';
import * as socketOwnership from './socket-ownership';
import { probeClaudeChannel } from '../native/claude-identity';
import type { ClaudeBinding } from './channel-contracts';
import type { ClaudeChannelIdentity } from '../native/contracts';

export const STARTUP_RECHECK_DELAY_MS = 1000;

export type StartupRecoveryScheduler = {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type StartupRecoveryOptions = {
  socketPath: string;
  binding: ClaudeBinding;
  readBinding: () => ClaudeBinding | null | undefined;
  signal: AbortSignal;
  startupCancellation: Promise<never>;
  scheduler?: StartupRecoveryScheduler;
};

export type IncumbentPin = {
  binding: ClaudeBinding;
  listenerInstanceId: string;
  socketIdentity: socketOwnership.SocketPathIdentity;
  lockPath: string;
  lockOwner: socketOwnership.OwnerMarkerSnapshot;
};

const defaultScheduler: StartupRecoveryScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout)
};

function sameSocketIdentity(left: socketOwnership.SocketPathIdentity, right: socketOwnership.SocketPathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.ctimeNs === right.ctimeNs && left.birthtimeNs === right.birthtimeNs;
}

function sameBinding(left: ClaudeBinding | null | undefined, right: ClaudeBinding): boolean {
  return Boolean(left && left.active && left.channelId === right.channelId && left.guildId === right.guildId &&
    left.provider === right.provider && left.nativeId === right.nativeId && left.workspace === right.workspace &&
    left.endpoint === right.endpoint && left.generation === right.generation);
}

function assertNotAborted(options: StartupRecoveryOptions): void {
  if (options.signal.aborted) throw new Error('Claude channel startup recovery was cancelled');
}

function assertBinding(options: StartupRecoveryOptions): void {
  assertNotAborted(options);
  if (!sameBinding(options.readBinding(), options.binding)) {
    throw new Error('Claude channel binding changed during startup recovery');
  }
}

function readSocketIdentity(socketPath: string): socketOwnership.SocketPathIdentity | undefined {
  try {
    const stats = fs.lstatSync(socketPath, { bigint: true });
    if (!stats.isSocket()) return undefined;
    return { dev: stats.dev, ino: stats.ino, ctimeNs: stats.ctimeNs, birthtimeNs: stats.birthtimeNs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function readLock(lockPath: string): socketOwnership.OwnerMarkerSnapshot | undefined {
  return socketOwnership.readSocketLockOwnerSnapshot(lockPath);
}

async function probe(options: StartupRecoveryOptions): Promise<ClaudeChannelIdentity> {
  const expected = {
    nativeId: options.binding.nativeId,
    generation: options.binding.generation,
    workspace: options.binding.workspace,
    endpoint: options.socketPath
  };
  const pending = probeClaudeChannel(options.socketPath, expected, { timeoutMs: 1000, signal: options.signal });
  try {
    return await Promise.race([pending, options.startupCancellation]);
  } catch (error) {
    if (options.signal.aborted) {
      try { await pending; } catch {}
    }
    throw error;
  }
}

function expectedProbeFailure(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOENT', 'ETIMEDOUT'].includes(String(code))) return true;
  return /Claude channel identity probe timed out|Claude channel identity endpoint returned HTTP 503/.test(String((error as { message?: unknown }).message));
}

function samePinnedLock(pin: IncumbentPin, lock: socketOwnership.OwnerMarkerSnapshot): boolean {
  return socketOwnership.sameSocketLockOwnerSnapshot(pin.lockOwner, lock);
}

async function waitForDelay(options: StartupRecoveryOptions): Promise<void> {
  assertNotAborted(options);
  const scheduler = options.scheduler || defaultScheduler;
  await Promise.race([
    new Promise<void>(resolve => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        options.signal.removeEventListener('abort', onAbort);
        scheduler.clearTimeout(handle);
        resolve();
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        scheduler.clearTimeout(handle);
        options.signal.removeEventListener('abort', onAbort);
      };
      const handle = scheduler.setTimeout(finish, STARTUP_RECHECK_DELAY_MS);
      options.signal.addEventListener('abort', onAbort, { once: true });
    }),
    options.startupCancellation
  ]);
  assertNotAborted(options);
}

export async function pinIncumbent(options: StartupRecoveryOptions): Promise<IncumbentPin | null> {
  assertBinding(options);
  const socketIdentity = readSocketIdentity(options.socketPath);
  if (!socketIdentity) return null;
  const lockPath = socketOwnership.lockPathForSocket(options.socketPath);
  let lockOwner: socketOwnership.OwnerMarkerSnapshot | undefined;
  try { lockOwner = readLock(lockPath); } catch { return null; }
  if (!lockOwner || !lockOwner.owner.identity || !lockOwner.owner.generation || !socketOwnership.socketLockOwnerAlive(lockOwner.owner)) return null;
  let listener: ClaudeChannelIdentity;
  try { listener = await probe(options); }
  catch (error) {
    if (options.signal.aborted) throw error;
    if (expectedProbeFailure(error)) return null;
    throw error;
  }
  assertBinding(options);
  if (!listener.listenerInstanceId) return null;
  const currentSocket = readSocketIdentity(options.socketPath);
  const currentLock = readLock(lockPath);
  if (!currentSocket && !currentLock) return null;
  if (!currentSocket || !sameSocketIdentity(socketIdentity, currentSocket)) {
    throw new Error('Claude channel incumbent socket was replaced during startup recovery');
  }
  if (!currentLock || !samePinnedLock({ binding: options.binding, listenerInstanceId: listener.listenerInstanceId, socketIdentity, lockPath, lockOwner }, currentLock)) {
    throw new Error('Claude channel incumbent lock was replaced during startup recovery');
  }
  if (!socketOwnership.socketLockOwnerAlive(currentLock.owner)) return null;
  return { binding: { ...options.binding }, listenerInstanceId: listener.listenerInstanceId, socketIdentity, lockPath, lockOwner };
}

export async function waitForIncumbentVacancy(options: StartupRecoveryOptions, pin: IncumbentPin): Promise<void> {
  for (;;) {
    assertBinding(options);
    const socketIdentity = readSocketIdentity(options.socketPath);
    const lockOwner = readLock(pin.lockPath);
    if (!socketIdentity) {
      if (!lockOwner) return;
      if (!samePinnedLock(pin, lockOwner)) throw new Error('Claude channel incumbent lock was replaced during startup recovery');
      if (!socketOwnership.socketLockOwnerAlive(lockOwner.owner)) return;
      await waitForDelay(options);
      continue;
    }
    if (!sameSocketIdentity(pin.socketIdentity, socketIdentity)) {
      throw new Error('Claude channel incumbent socket was replaced during startup recovery');
    }
    if (lockOwner && !samePinnedLock(pin, lockOwner)) {
      throw new Error('Claude channel incumbent lock was replaced during startup recovery');
    }
    if (lockOwner && !socketOwnership.socketLockOwnerAlive(lockOwner.owner)) return;
    let listener: ClaudeChannelIdentity | undefined;
    try { listener = await probe(options); }
    catch (error) {
      if (options.signal.aborted) throw error;
      if (!sameBinding(options.readBinding(), options.binding) || !expectedProbeFailure(error)) throw error;
    }
    if (listener && listener.listenerInstanceId !== pin.listenerInstanceId) {
      throw new Error('Claude channel incumbent listener was replaced during startup recovery');
    }
    await waitForDelay(options);
  }
}
