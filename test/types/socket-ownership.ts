import * as http from 'node:http';
import * as net from 'node:net';
import {
  acquireSocketLock,
  boundSocketIdentity,
  prepareSocket,
  withSocketLock,
  type SocketLockRelease,
  type SocketPathIdentity
} from '../../src/claude/socket-ownership';

export async function typecheckSocketOwnership(socketPath: string): Promise<void> {
  const release: SocketLockRelease = acquireSocketLock(socketPath);
  const prepared: Promise<void> = prepareSocket(socketPath);
  const result: Promise<string> = withSocketLock(socketPath, async () => 'locked');
  const listener: http.Server = http.createServer();
  const identity: Promise<SocketPathIdentity> = boundSocketIdentity(listener, socketPath);

  await prepared;
  await result;
  await identity;
  release();
}

export function typecheckBoundSocketIdentityRejectsBadCalls(
  socketPath: string,
  listener: http.Server,
  netListener: net.Server
): void {
  // @ts-expect-error socketPath is required
  void boundSocketIdentity(listener);
  // @ts-expect-error a plain net.Server is not an http.Server
  void boundSocketIdentity(netListener, socketPath);
}
