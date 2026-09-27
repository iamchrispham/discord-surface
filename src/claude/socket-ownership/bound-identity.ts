import type { SocketIdentity } from '../socket-ownership';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';

const SOCKET_QUALIFICATION_TIMEOUT_MS = 1000;
const QUALIFICATION_HEADER = 'x-discord-socket-qualification';

type CaptureOptions = {
  owner: number | undefined;
  sameSocket: (left: SocketIdentity, right: SocketIdentity) => boolean;
  signal?: AbortSignal;
};

function unavailable(detail: string): Error {
  return new Error(`Claude channel bound socket identity is unavailable: ${detail}`);
}

function refused(detail: string): Error {
  return new Error(`Claude channel bound socket qualification refused: ${detail}`);
}

function aborted(): Error {
  return new Error('Claude channel bound socket qualification aborted');
}

function readOwnedSocket(socketPath: string, owner: number | undefined): SocketIdentity {
  let stats: fs.BigIntStats;
  try {
    stats = fs.lstatSync(socketPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw unavailable('path is missing');
    throw unavailable(`path could not be read: ${String((error as Error).message)}`);
  }
  if (stats.isSymbolicLink()) throw unavailable('path is a symlink');
  if (!stats.isSocket()) throw unavailable('path is not a socket');
  if (owner !== undefined && stats.uid !== BigInt(owner)) throw unavailable('path is owned by another user');
  return { dev: stats.dev, ino: stats.ino, ctimeNs: stats.ctimeNs, birthtimeNs: stats.birthtimeNs };
}

/**
 * Qualify a filesystem identity as belonging to this exact bound HTTP listener.
 *
 * Reads the owned-socket lstat snapshot, requires the supplied server to witness
 * one nonce-tagged HEAD /identity request, then re-reads the same pathname and
 * requires full identity equality. Only proof resources are disposed; unrelated
 * accepted connections are left alone.
 */
export function captureBoundSocketIdentity(
  server: http.Server,
  socketPath: string,
  options: CaptureOptions
): Promise<SocketIdentity> {
  const { owner, sameSocket, signal } = options;
  return new Promise<SocketIdentity>((resolve, reject) => {
    if (server.listening !== true) {
      reject(unavailable('listener is not accepting connections'));
      return;
    }
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    let candidate: SocketIdentity;
    try {
      candidate = readOwnedSocket(socketPath, owner);
    } catch (error) {
      reject(error);
      return;
    }

    const nonce = randomUUID();
    let settled = false;
    let witnessed = false;
    let proofConnection: net.Socket | undefined;
    let clientRequest: http.ClientRequest | undefined;
    let clientResponse: http.IncomingMessage | undefined;
    let deadline: NodeJS.Timeout | undefined;

    const onRequest = (request: http.IncomingMessage): void => {
      if (witnessed) return;
      if (request.method !== 'HEAD' || request.url !== '/identity') return;
      if (request.headers[QUALIFICATION_HEADER] !== nonce) return;
      witnessed = true;
      proofConnection = request.socket;
    };
    const onServerClose = (): void => finish(refused('listener closed during qualification'));
    const onServerError = (error: Error): void => finish(refused(`listener error during qualification: ${error.message}`));
    const onAbort = (): void => finish(aborted());

    function finish(error?: Error, value?: SocketIdentity): void {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      server.removeListener('request', onRequest);
      server.removeListener('close', onServerClose);
      server.removeListener('error', onServerError);
      try { clientResponse?.destroy(); } catch {}
      try { clientRequest?.destroy(); } catch {}
      if (proofConnection && !proofConnection.destroyed) {
        try { proofConnection.destroy(); } catch {}
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(value as SocketIdentity);
    }

    function complete(): void {
      if (settled) return;
      if (server.listening !== true) {
        finish(refused('listener stopped before qualification completed'));
        return;
      }
      if (signal?.aborted) {
        finish(aborted());
        return;
      }
      let current: SocketIdentity;
      try {
        current = readOwnedSocket(socketPath, owner);
      } catch (error) {
        finish(refused(`qualified pathname changed: ${String((error as Error).message)}`));
        return;
      }
      if (!sameSocket(candidate, current)) {
        finish(refused('pathname identity changed during qualification'));
        return;
      }
      finish(undefined, candidate);
    }

    server.on('request', onRequest);
    server.on('close', onServerClose);
    server.on('error', onServerError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    let request: http.ClientRequest;
    try {
      request = http.request({
        socketPath,
        path: '/identity',
        method: 'HEAD',
        agent: false,
        headers: {
          [QUALIFICATION_HEADER]: nonce,
          connection: 'close'
        }
      });
    } catch (error) {
      finish(refused(`qualification request could not be created: ${String((error as Error).message)}`));
      return;
    }
    clientRequest = request;
    request.on('response', response => {
      clientResponse = response;
      response.resume();
      response.on('end', () => {
        if (settled) return;
        if (!witnessed) {
          finish(refused('supplied listener did not witness the qualification request'));
          return;
        }
        complete();
      });
      response.on('aborted', () => finish(refused('qualification response was aborted')));
      response.on('error', (error: Error) => finish(refused(`qualification response failed: ${error.message}`)));
      response.on('close', () => {
        if (settled) return;
        finish(refused('qualification response closed before completion'));
      });
    });
    request.on('error', (error: Error) => finish(refused(`qualification request failed: ${error.message}`)));

    deadline = setTimeout(() => finish(new Error('Claude channel bound socket qualification timed out')), SOCKET_QUALIFICATION_TIMEOUT_MS);
    request.end();
  });
}
