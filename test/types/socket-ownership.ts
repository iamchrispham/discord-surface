import {
  acquireSocketLock,
  prepareSocket,
  withSocketLock,
  type SocketLockRelease
} from '../../src/claude/socket-ownership';

export async function typecheckSocketOwnership(socketPath: string): Promise<void> {
  const release: SocketLockRelease = acquireSocketLock(socketPath);
  const prepared: Promise<void> = prepareSocket(socketPath);
  const result: Promise<string> = withSocketLock(socketPath, async () => 'locked');

  await prepared;
  await result;
  release();
}
