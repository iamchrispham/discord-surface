import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import type { ClaudeMetadataRow, ClaudeSessionIdentity, ClaudeBindingExpectation, ClaudeChannelIdentity, NativeStateExports } from './contracts';
import { CLAUDE_METADATA_RECORD_MAX_BYTES, TRANSCRIPT_BLOCK_BYTES } from '../native-transcript';
import { asNativeError } from './errors';
const { validateNativeId } = require('../../src/state') as NativeStateExports;

function* readClaudeSessionMetadata(file: string): Generator<ClaudeMetadataRow | null> {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) throw new Error('Claude transcript metadata is empty');
    const chunk = Buffer.allocUnsafe(TRANSCRIPT_BLOCK_BYTES);
    let recordParts: Buffer[] = [];
    let recordLength = 0;
    let position = 0;
    const parseLine = (line: string): ClaudeMetadataRow | null => {
      if (!line.trim()) return null;
      try { return JSON.parse(line) as ClaudeMetadataRow; } catch { return null; }
    };
    const consumeRecord = (part: Uint8Array, complete: boolean): ClaudeMetadataRow | null => {
      if (recordLength + part.length > CLAUDE_METADATA_RECORD_MAX_BYTES) {
        throw new Error('Claude transcript metadata record is too large');
      }
      if (part.length) recordParts.push(Buffer.from(part));
      recordLength += part.length;
      if (!complete) return null;
      const row = parseLine(Buffer.concat(recordParts, recordLength).toString('utf8'));
      recordParts = [];
      recordLength = 0;
      return row;
    };
    while (position < size) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
      if (!count) throw new Error('transcript shortened during read');
      position += count;
      let start = 0;
      while (start < count) {
        const newline = chunk.indexOf(0x0a, start);
        if (newline < 0) {
          consumeRecord(chunk.subarray(start, count), false);
          break;
        }
        const row = consumeRecord(chunk.subarray(start, newline), true);
        if (row !== null) yield row;
        start = newline + 1;
      }
    }
    const row = consumeRecord(Buffer.alloc(0), true);
    if (row !== null) yield row;
  } finally {
    fs.closeSync(fd);
  }
}

export function readClaudeSessionIdentity(nativeId: string, transcriptFile: string): ClaudeSessionIdentity {
  validateNativeId(nativeId);
  if (typeof transcriptFile !== 'string' || !path.isAbsolute(transcriptFile)) {
    throw new Error('Claude transcript path must be absolute');
  }
  const stat = fs.statSync(transcriptFile);
  if (!stat.isFile()) throw new Error('Claude transcript path must be a regular file');
  let hasMatch = false;
  const sessionIds = new Set();
  let workspace = null;
  for (const row of readClaudeSessionMetadata(transcriptFile)) {
    const sessionId = row?.sessionId;
    const payloadSessionId = row?.payload?.session_id;
    const hasSessionId = sessionId !== undefined && sessionId !== null;
    const hasPayloadSessionId = payloadSessionId !== undefined && payloadSessionId !== null;
    if (row?.entrypoint !== 'cli' || typeof row?.version !== 'string' ||
      typeof row?.cwd !== 'string' || !path.isAbsolute(row.cwd)) continue;
    if (hasSessionId && hasPayloadSessionId && sessionId !== payloadSessionId) {
      throw new Error('Claude transcript identity is ambiguous');
    }
    let candidateSessionId = null;
    if (hasSessionId) candidateSessionId = sessionId;
    else if (hasPayloadSessionId) candidateSessionId = payloadSessionId;
    if (candidateSessionId === null) continue;
    sessionIds.add(candidateSessionId);
    if (sessionIds.size > 1) throw new Error('Claude transcript identity is ambiguous');
    if (candidateSessionId === nativeId) {
      hasMatch = true;
      const candidateWorkspace = path.resolve(row.cwd);
      if (workspace !== null && workspace !== candidateWorkspace) {
        throw new Error('Claude transcript workspace is ambiguous');
      }
      workspace = candidateWorkspace;
    }
  }
  if (!hasMatch) throw new Error('Claude transcript identity or workspace is unavailable');
  return { file: transcriptFile, sessionId: nativeId, threadId: nativeId, workspace: workspace as string };
}

export function validateClaudeSessionIdentity(nativeId: string, transcriptFile: string, workspace?: string): ClaudeSessionIdentity {
  if (workspace !== undefined && (typeof workspace !== 'string' || !path.isAbsolute(workspace))) {
    throw new Error('Claude workspace must be absolute');
  }
  const identity = readClaudeSessionIdentity(nativeId, transcriptFile);
  if (workspace !== undefined && path.resolve(identity.workspace) !== path.resolve(workspace)) {
    throw new Error('Claude transcript workspace does not match the supplied workspace');
  }
  return identity;
}

export function probeUnixSocket(socketPath: string, { timeoutMs = 1000 }: { timeoutMs?: number } = {}): Promise<{ socketPath: string }> {
  return new Promise<{ socketPath: string }>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => socket.destroy(new Error('native channel probe timed out')), timeoutMs);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      socket.destroy();
      if (error) reject(error);
      else resolve({ socketPath });
    };
    const onConnect = () => finish();
    const onError = (error: Error) => finish(error);
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

export function probeClaudeChannel(
  socketPath: string,
  expected: ClaudeBindingExpectation,
  { timeoutMs = 1000, maxBytes = 16384 }: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<ClaudeChannelIdentity> {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) throw new Error('Claude channel endpoint must be absolute');
  if (!expected || typeof expected !== 'object' || typeof expected.nativeId !== 'string' ||
    !Number.isInteger(expected.generation) || expected.generation < 1 || expected.endpoint !== socketPath ||
    typeof expected.workspace !== 'string' || !path.isAbsolute(expected.workspace)) {
    throw new Error('Claude channel identity probe requires the expected binding');
  }
  return new Promise<ClaudeChannelIdentity>((resolve, reject) => {
    let settled = false;
    let request: http.ClientRequest | undefined;
    const deadlineMs = Math.max(1, Number(timeoutMs));
    let deadlineTimer: NodeJS.Timeout;
    const finish = (error: Error | null, proof: ClaudeChannelIdentity | null = null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (error) reject(error);
      else if (proof) resolve(proof);
    };
    deadlineTimer = setTimeout(() => {
      const error = new Error('Claude channel identity probe timed out');
      request?.destroy(error);
      finish(error);
    }, deadlineMs);
    try {
      request = http.request({ agent: false, socketPath, path: '/identity', method: 'GET',
        headers: { accept: 'application/json' } }, response => {
        let output = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          output += chunk;
          if (Buffer.byteLength(output, 'utf8') > maxBytes) {
            request?.destroy(new Error('Claude channel identity response is too large'));
          }
        });
        response.on('error', (error: Error) => finish(error));
        response.on('end', () => {
          if (response.statusCode !== 200) {
            finish(new Error(`Claude channel identity endpoint returned HTTP ${response.statusCode}`));
            return;
          }
          let identity: {
            provider?: unknown;
            nativeId?: unknown;
            generation?: unknown;
            endpoint?: unknown;
            workspace?: unknown;
            channelReady?: unknown;
          };
          try { identity = JSON.parse(output); }
          catch { finish(new Error('Claude channel identity response is invalid JSON')); return; }
          if (identity?.provider !== 'claude' || identity.nativeId !== expected.nativeId ||
            identity.generation !== expected.generation || identity.endpoint !== expected.endpoint ||
            identity.workspace !== expected.workspace || identity.channelReady !== true) {
            finish(new Error('Claude channel identity does not match the ordinary binding'));
            return;
          }
          finish(null, {
            file: socketPath,
            sessionId: expected.nativeId,
            threadId: expected.nativeId,
            workspace: expected.workspace,
            endpoint: socketPath,
            harness: 'claude-code',
            generation: expected.generation,
            channelReady: true
          });
        });
      });
      request.once('error', (error: Error) => finish(error));
      request.end();
    } catch (error) {
      finish(asNativeError(error));
    }
  });
}

