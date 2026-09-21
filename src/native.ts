import { DISPATCH_STATUSES } from './native/contracts';
import type {
  NativeStateExports,
  NativeProviderName,
  MessageState,
  PersistedObserverCursor,
  ObserverCursor,
  NativeMessage,
  NativeBinding,
  CurrentBinding,
  DispatchClaim,
  NativeReplyInput,
  NativeState,
  NativeReplyReceipt,
  DispatchStatus,
  DispatchOutcome,
  DispatchOptions,
  CourierDispatchEnvelope,
  CourierDispatchOptions,
  CodexRunOptions,
  CodexRunResult,
  ObserveCodexOptions,
  CodexObservation,
  WaitForReplyOptions,
  WaitForReplyResult,
  ObserveOutcome,
  ProviderObservation,
  NativeProvider,
  ClaudeSessionIdentity,
  ClaudeMetadataRow,
  ClaudeBindingExpectation,
  ClaudeChannelIdentity,
  UnixJsonResponse,
  NativeError,
  DispatchReport
} from './native/contracts';
export { DISPATCH_STATUSES } from './native/contracts';
export type {
  NativeProviderName,
  MessageState,
  PersistedObserverCursor,
  ObserverCursor,
  NativeMessage,
  NativeBinding,
  CurrentBinding,
  DispatchClaim,
  NativeReplyInput,
  NativeState,
  NativeReplyReceipt,
  DispatchStatus,
  DispatchOutcome,
  DispatchOptions,
  CourierDispatchEnvelope,
  CourierDispatchOptions,
  CodexRunOptions,
  CodexRunResult,
  ObserveCodexOptions,
  CodexObservation,
  WaitForReplyOptions,
  WaitForReplyResult,
  ObserveOutcome,
  ProviderObservation,
  NativeProvider,
  ClaudeSessionIdentity,
  ClaudeBindingExpectation,
  ClaudeChannelIdentity,
  UnixJsonResponse,
  DispatchReport
} from './native/contracts';
import { parseFinalAnswer, type FinalAnswer } from './native/final-answer';
export { finalText } from './native/final-answer';
export type { TranscriptPart, TranscriptItem, TranscriptPayload, TranscriptRow } from './native/final-answer';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import {
  CODEX_VALIDATION_KINDS,
  CLAUDE_METADATA_RECORD_MAX_BYTES,
  TRANSCRIPT_BLOCK_BYTES,
  codexHomeForSessionRoot,
  findCodexSessionFile,
  readCodexSessionIdentity,
  readCodexSessionIdentityAsync,
  readTranscriptBlock,
  sessionRoot,
  validateCodexSessionIdentity,
  validateCodexSessionIdentityAsync,
  walk,
  walkAsync
} from './native-transcript';
import {
  agentCompletionCommand,
  attachmentPrompt,
  claudeEvent,
  codexPrompt,
  courierForwardingPrompt,
  messageRequest,
  watcherNoticeCompletionCommand
} from './native/prompts';

export {
  CODEX_VALIDATION_KINDS,
  findCodexSessionFile,
  readCodexSessionIdentity,
  readCodexSessionIdentityAsync,
  sessionRoot,
  validateCodexSessionIdentity,
  validateCodexSessionIdentityAsync,
  walk,
  walkAsync
};

export {
  agentCompletionCommand,
  attachmentPrompt,
  claudeEvent,
  codexPrompt,
  courierForwardingPrompt,
  messageRequest,
  watcherNoticeCompletionCommand
};

const { MESSAGE_STATES, PROVIDERS, validateNativeId } = require('../src/state') as NativeStateExports;

function asNativeError(error: unknown): NativeError {
  if (error instanceof Error) return error as NativeError;
  const typed = Object.assign(new Error(String(error)), { cause: error }) as NativeError;
  if (error && typeof error === 'object' && typeof (error as { wrote?: unknown }).wrote === 'boolean') {
    typed.wrote = (error as { wrote: boolean }).wrote;
  }
  return typed;
}

function errorCode(error: unknown): string | number | undefined {
  return error && typeof error === 'object' ? (error as { code?: string | number }).code : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>(resolve => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => finish();
    timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function cursorTailBytes(cursor: PersistedObserverCursor | null | undefined): Buffer {
  if (typeof cursor?.tailBytes === 'string') {
    try { return Buffer.from(cursor.tailBytes, 'base64'); } catch {}
  }
  return typeof cursor?.tail === 'string' ? Buffer.from(cursor.tail, 'utf8') : Buffer.alloc(0);
}

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

function readTranscriptTail(fd: number, size: number): Buffer<ArrayBufferLike> {
  const parts: Buffer<ArrayBufferLike>[] = [];
  for (let end = size; end > 0;) {
    const start = Math.max(0, end - TRANSCRIPT_BLOCK_BYTES);
    const bytes = readTranscriptBlock(fd, start, end - start);
    const newline = bytes.lastIndexOf(0x0a);
    parts.push(bytes.subarray(newline + 1));
    if (newline >= 0) break;
    end = start;
  }
  // Copy the suffix; a tiny tail must not keep the last read buffer alive.
  return Buffer.concat(parts.reverse());
}

export async function observeCodexReply(
  nativeId: string,
  cursor: PersistedObserverCursor | null | undefined,
  {
    marker,
    timeoutMs = 120000,
    root = sessionRoot(),
    resolveRoot,
    pollMs = 250,
    signal,
    onCursor,
    continueUntilFinal = false,
    isCurrent
  }: ObserveCodexOptions = {}
): Promise<CodexObservation> {
  if (!marker) throw new Error('Codex observer requires a unique response marker');
  const startedAt = Date.now();
  let offset = Number(cursor?.offset || 0);
  let tailBytes = cursorTailBytes(cursor);
  let since = Number(cursor?.since || startedAt);
  const initialSince = since;
  const normalizeRoot = (value: string | null | undefined): string | null => typeof value === 'string' && value.length > 0 ? path.resolve(value) : null;
  const staticRoot = normalizeRoot(root);
  const currentRoot = () => {
    if (typeof resolveRoot !== 'function') return staticRoot;
    try { return normalizeRoot(resolveRoot()) || staticRoot; } catch { return staticRoot; }
  };
  let activeRoot = currentRoot();
  let file = cursor?.file || null;
  if (file && activeRoot) {
    const relative = path.relative(activeRoot, path.resolve(file));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      file = null;
      offset = 0;
      tailBytes = Buffer.alloc(0);
    }
  }
  if (!file) file = findCodexSessionFile(nativeId, activeRoot as string);
  const currentCursor = () => ({ file, offset, since, tail: tailBytes.toString('utf8'), tailBytes: tailBytes.toString('base64') });
  const stopped = () => signal?.aborted || (isCurrent && !isCurrent());
  while (continueUntilFinal || Date.now() - startedAt < timeoutMs) {
    if (stopped()) return { stopped: true, cursor: currentCursor() };
    const nextRoot = currentRoot();
    if (nextRoot !== activeRoot) {
      activeRoot = nextRoot;
      file = null;
      offset = 0;
      tailBytes = Buffer.alloc(0);
      since = initialSince;
    }
    if (!file) file = findCodexSessionFile(nativeId, activeRoot as string);
    if (file) {
      try {
        const fd = fs.openSync(file, 'r');
        let answer: FinalAnswer | null = null;
        try {
          const end = fs.fstatSync(fd).size;
          const truncated = end < offset;
          const nextSince = truncated ? startedAt : since;
          let position = truncated ? 0 : offset;
          const pending = truncated ? Buffer.alloc(0) : tailBytes;
          let parts = pending.length ? [pending] : [];
          // Hold only the unfinished record; still scan to snapshot EOF after a
          // match so the returned offset and trailing bytes keep their semantics.
          while (position < end) {
            if (stopped()) return { stopped: true, cursor: currentCursor() };
            const bytes = readTranscriptBlock(fd, position, Math.min(TRANSCRIPT_BLOCK_BYTES, end - position));
            position += bytes.length;
            let start = 0;
            for (let newline = bytes.indexOf(0x0a); newline >= 0; newline = bytes.indexOf(0x0a, start)) {
              if (!answer && (parts.length || newline > start)) {
                const piece = bytes.subarray(start, newline);
                const line = parts.length ? Buffer.concat([...parts, piece]) : piece;
                try {
                  const row = JSON.parse(line.toString('utf8'));
                  if (!(Date.parse(row.timestamp || '') < nextSince)) answer = parseFinalAnswer(row, marker);
                } catch {}
              }
              parts = [];
              start = newline + 1;
            }
            // Own the suffix: do not retain a whole block via a small subarray.
            if (start < bytes.length) parts.push(Buffer.from(bytes.subarray(start)));
          }
          if (stopped()) return { stopped: true, cursor: currentCursor() };
          // Commit only a fully read snapshot. A failed read must not lose bytes.
          offset = end;
          tailBytes = parts.length === 1 ? parts[0] : Buffer.concat(parts);
          since = nextSince;
        } finally {
          fs.closeSync(fd);
        }
        if (answer !== null) return { text: answer.text, parts: answer.parts, cursor: currentCursor() };
        onCursor?.(currentCursor());
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          file = null;
          offset = 0;
          tailBytes = Buffer.alloc(0);
        }
        onCursor?.(currentCursor());
      }
    }
    await sleep(pollMs, signal);
  }
  return { stopped: Boolean(signal?.aborted), cursor: currentCursor() };
}

export function readInitialCursor(nativeId: string, root = sessionRoot()): ObserverCursor {
  const file = findCodexSessionFile(nativeId, root);
  if (!file) return { file: null, offset: 0, since: Date.now(), tail: '' };
  let offset = 0;
  let tailBytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      tailBytes = readTranscriptTail(fd, size);
      offset = size;
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return { file, offset, since: Date.now(), tail: tailBytes.toString('utf8'), tailBytes: tailBytes.toString('base64') };
}

export function runCodex(command: string, args: readonly string[], options: CodexRunOptions = {}): Promise<CodexRunResult> {
  return new Promise<CodexRunResult>(resolve => {
    let spawned = false;
    const child = execFile(command, args, { cwd: options.cwd, env: options.env || process.env, signal: options.signal, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ status: DISPATCH_STATUSES.SUBMITTED, stdout, stderr });
      const text = `${error.message} ${stderr || ''}`;
      if (!spawned || errorCode(error) === 'ENOENT') return resolve({ status: DISPATCH_STATUSES.NOT_SUBMITTED, error: new Error(text) });
      if (/not found|does not exist|unknown thread|no such thread|missing thread|no rollout found for thread id/i.test(text)) {
        return resolve({ status: DISPATCH_STATUSES.NOT_SUBMITTED, error: new Error(text) });
      }
      resolve({ status: DISPATCH_STATUSES.UNCERTAIN, error: new Error(text) });
    });
    spawned = true;
    child.once('error', error => {
      const code = errorCode(error);
      const typed = asNativeError(error);
      if (code === 'ENOENT') resolve({ status: DISPATCH_STATUSES.NOT_SUBMITTED, error: typed });
      else resolve({ status: DISPATCH_STATUSES.UNCERTAIN, error: typed });
    });
  });
}

export class CodexProvider implements NativeProvider {
  private readonly command: string;
  private readonly root: string;
  private readonly run: (command: string, args: readonly string[], options?: CodexRunOptions) => Promise<CodexRunResult>;
  private readonly acknowledgmentFor: ((message: NativeMessage) => readonly string[] | null | undefined) | null;
  private readonly completionFor: ((message: NativeMessage) => readonly string[] | null | undefined) | null;

  constructor({
    command = 'codex',
    root = sessionRoot(),
    run = runCodex,
    acknowledgmentFor = null,
    completionFor = null
  }: {
    command?: string;
    root?: string;
    run?: (command: string, args: readonly string[], options?: CodexRunOptions) => Promise<CodexRunResult>;
    acknowledgmentFor?: ((message: NativeMessage) => readonly string[] | null | undefined) | null;
    completionFor?: ((message: NativeMessage) => readonly string[] | null | undefined) | null;
  } = {}) {
    this.command = command;
    this.root = root;
    this.run = run;
    this.acknowledgmentFor = acknowledgmentFor;
    this.completionFor = completionFor;
  }

  async dispatch(message: NativeMessage, { onCursor }: DispatchOptions = {}): Promise<DispatchOutcome> {
    try { validateNativeId(message.nativeId); } catch (error) {
      return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: asNativeError(error) };
    }
    const root = message.sessionRoot || this.root;
    let codexHome;
    try { codexHome = codexHomeForSessionRoot(root); } catch (error) {
      return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: asNativeError(error) };
    }
    const cursor = readInitialCursor(message.nativeId, root);
    onCursor?.(cursor);
    const args = ['queue', '--thread', message.nativeId, '--message', codexPrompt(message,
      this.acknowledgmentFor?.(message), this.completionFor?.(message)), '--cd', message.workspace];
    const result = await this.run(this.command, args, {
      cwd: message.workspace,
      env: { ...process.env, CODEX_HOME: codexHome }
    });
    return { ...result, cursor };
  }

  async dispatchCourier(envelope: CourierDispatchEnvelope, { signal }: CourierDispatchOptions = {}): Promise<DispatchOutcome> {
    if (signal?.aborted) return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: new Error('courier dispatch stopped before queue submission') };
    if (envelope?.courier?.provider !== 'codex') {
      return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: new Error('courier dispatch requires a Codex courier identity') };
    }
    try { validateNativeId(envelope.courier.nativeId); } catch (error) {
      return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: asNativeError(error) };
    }
    if (typeof envelope.courier.workspace !== 'string' || !path.isAbsolute(envelope.courier.workspace)) {
      return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: new Error('courier workspace must be absolute') };
    }
    let forwardingPrompt;
    try { forwardingPrompt = courierForwardingPrompt(envelope); } catch (error) {
      return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: asNativeError(error) };
    }
    const root = envelope.courier.sessionRoot || this.root;
    let codexHome;
    try { codexHome = codexHomeForSessionRoot(root); } catch (error) {
      return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: asNativeError(error) };
    }
    const args = ['queue', '--thread', envelope.courier.nativeId, '--message', forwardingPrompt, '--cd', envelope.courier.workspace];
    const result = await this.run(this.command, args, {
      cwd: envelope.courier.workspace,
      env: { ...process.env, CODEX_HOME: codexHome },
      signal
    });
    return result;
  }

  observe(message: NativeMessage, outcome: ObserveOutcome, options: ObserveCodexOptions = {}): Promise<CodexObservation> {
    return observeCodexReply(message.nativeId, outcome.cursor || message.observerCursor, {
      ...options,
      marker: `[[discord-surface:${message.id}]]`,
      root: message.sessionRoot || this.root,
      resolveRoot: typeof options.resolveRoot === 'function' ? () => (options.resolveRoot as () => string | null | undefined)() || this.root : undefined
    });
  }
}

export function postUnixJson(socketPath: string, body: unknown, { timeoutMs = 10000 }: { timeoutMs?: number } = {}): Promise<UnixJsonResponse> {
  return new Promise<UnixJsonResponse>((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(body));
    let wrote = false;
    const request = http.request({ agent: false, socketPath, path: '/event', method: 'POST', timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': encoded.length } }, response => {
      let output = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { output += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body: output, wrote }));
    });
    request.on('timeout', () => request.destroy(new Error('native channel request timed out')));
    request.on('error', error => {
      const typed = asNativeError(error);
      typed.wrote = wrote;
      reject(typed);
    });
    request.write(encoded, () => { wrote = true; });
    request.end();
  });
}

export class ClaudeProvider implements NativeProvider {
  private readonly post: (socketPath: string, body: unknown) => Promise<UnixJsonResponse>;
  private readonly waitForReply?: (messageId: string, options?: WaitForReplyOptions) => Promise<WaitForReplyResult> | WaitForReplyResult | null;
  private readonly completionFor: ((message: NativeMessage) => readonly string[] | null | undefined) | null;

  constructor({
    post = postUnixJson,
    waitForReply,
    completionFor = null
  }: {
    post?: (socketPath: string, body: unknown) => Promise<UnixJsonResponse>;
    waitForReply?: (messageId: string, options?: WaitForReplyOptions) => Promise<WaitForReplyResult> | WaitForReplyResult | null;
    completionFor?: ((message: NativeMessage) => readonly string[] | null | undefined) | null;
  } = {}) {
    this.post = post;
    this.waitForReply = waitForReply;
    this.completionFor = completionFor;
  }

  async dispatch(message: NativeMessage): Promise<DispatchOutcome> {
    try { validateNativeId(message.nativeId); } catch (error) {
      return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: asNativeError(error) };
    }
    if (!message.endpoint) return { status: DISPATCH_STATUSES.NOT_SUBMITTED, endpointUnavailable: true, error: new Error('Claude binding has no native channel endpoint') };
    try {
      const result = await this.post(message.endpoint, claudeEvent(message, this.completionFor?.(message)));
      if (result.statusCode === 202) return { status: DISPATCH_STATUSES.SUBMITTED };
      if (result.statusCode !== undefined && result.statusCode >= 400 && result.statusCode < 500) return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: new Error(`Claude channel rejected event: ${result.statusCode}`) };
      return { status: DISPATCH_STATUSES.UNCERTAIN, error: new Error(`Claude channel returned ${result.statusCode}`) };
    } catch (error) {
      const typed = asNativeError(error);
      return { status: typed.wrote ? DISPATCH_STATUSES.UNCERTAIN : DISPATCH_STATUSES.NOT_SUBMITTED, endpointUnavailable: !typed.wrote, error: typed };
    }
  }

  observe(_message: NativeMessage, _outcome: ObserveOutcome, options?: ObserveCodexOptions): Promise<WaitForReplyResult> | WaitForReplyResult | null {
    if (!this.waitForReply) return null;
    return this.waitForReply(_message.id, options);
  }
}

export async function waitForReply(state: NativeState, messageId: string, { timeoutMs = 120000, pollMs = 250, signal, continueUntilFinal = false, isCurrent }: WaitForReplyOptions = {}): Promise<WaitForReplyResult | null> {
  const startedAt = Date.now();
  while (continueUntilFinal || Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) return { stopped: true };
    const message = state.getMessage(messageId);
    if (!message) return null;
    if (message.state === MESSAGE_STATES.REPLY_READY || message.state === MESSAGE_STATES.REPLIED) return { text: message.replyText };
    if (message.state === MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST) return { stopped: true };
    if (isCurrent && !isCurrent()) return { stopped: true };
    if (message.state === MESSAGE_STATES.UNCERTAIN || message.state === MESSAGE_STATES.REPLY_UNKNOWN) return null;
    await sleep(pollMs, signal);
  }
  return null;
}

export async function observeSubmitted(
  state: NativeState,
  message: NativeMessage,
  provider: NativeProvider,
  options: ObserveCodexOptions = {}
): Promise<DispatchReport> {
  if (message.state === MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST) {
    return { status: message.state, message: state.getMessage(message.id) };
  }
  if (!provider?.observe) {
    const unavailable = state.markObservationUnavailable(message.id, 'native observer is unavailable');
    return { status: unavailable?.state || message.state, message: unavailable || state.getMessage(message.id) };
  }
  const marker = `[[discord-surface:${message.id}]]`;
  const outcome: ObserveOutcome = { cursor: message.observerCursor };
  let observedCursor: ObserverCursor | null = null;
  let reply: ProviderObservation | null = null;
  const isCurrent = () => {
    try {
      const currentMessage = state.getMessage(message.id);
      if (!currentMessage || currentMessage.state !== MESSAGE_STATES.SUBMITTED) return false;
      const check = state.currentMessageBinding?.(currentMessage);
      if (!check) return false;
      return check.current && currentMessage.provider === message.provider && currentMessage.nativeId === message.nativeId && currentMessage.generation === message.generation;
    } catch {
      return false;
    }
  };
  try {
    reply = await provider.observe(providerMessageForBinding(state, message), outcome, {
      ...options,
      isCurrent,
      resolveRoot: () => {
        const currentMessage = state.getMessage(message.id);
        if (!currentMessage) return undefined;
        return state.currentMessageBinding?.(currentMessage)?.binding?.sessionRoot || undefined;
      },
      onCursor: cursor => { observedCursor = cursor; }
    });
  } catch (error) {
    state.markObservationUnavailable(message.id, error);
    return { status: state.getMessage(message.id)?.state || message.state, message: state.getMessage(message.id), error };
  }
  if (reply && typeof reply.text === 'string') {
    try {
      const nativeReply: NativeReplyInput = { provider: message.provider, messageId: message.id, nativeId: message.nativeId, generation: message.generation, text: reply.text };
      if (reply.parts) nativeReply.parts = reply.parts;
      state.recordNativeReply(nativeReply);
      const cursor = reply.cursor || observedCursor;
      if (cursor) state.setObserverCursor(message.id, cursor, marker);
    } catch (error) {
      return { status: 'stale-reply', message: state.getMessage(message.id), error };
    }
  } else if (reply?.cursor || observedCursor) {
    const cursor = reply?.cursor || observedCursor;
    if (cursor) state.setObserverCursor(message.id, cursor, marker);
  } else if (!reply?.stopped) {
    state.markObservationUnavailable(message.id, 'native reply was not observed before the bounded window');
  }
  return { status: state.getMessage(message.id)?.state || message.state, message: state.getMessage(message.id) };
}

function providerMessageForBinding(state: NativeState, message: NativeMessage): NativeMessage {
  if (typeof state?.currentMessageBinding !== 'function') return message;
  try {
    const binding = state.currentMessageBinding(message)?.binding;
    if (!binding || binding.sessionRoot == null) return message;
    return { ...message, sessionRoot: binding.sessionRoot };
  } catch {
    return message;
  }
}

function isDispatchOutcome(value: unknown): value is DispatchOutcome {
  const status = value && typeof value === 'object' ? (value as { status?: unknown }).status : undefined;
  return typeof status === 'string' && (Object.values(DISPATCH_STATUSES) as readonly string[]).includes(status);
}

export async function dispatchAndObserve(
  state: NativeState,
  messageId: string,
  providers: Partial<Record<NativeProviderName, NativeProvider>>,
  options: ObserveCodexOptions & {
    dispatch?: (message: NativeMessage, provider: NativeProvider, options: DispatchOptions) => Promise<DispatchOutcome>;
    onDispatchOutcome?: (outcome: unknown) => void;
    onNativeUnavailable?: (message: NativeMessage, error: unknown, outcome: DispatchOutcome) => void;
    onSubmitted?: (message: NativeMessage | null | undefined) => void;
  } = {}
): Promise<DispatchReport> {
  const reportOutcome = (outcome: DispatchReport): DispatchReport => {
    try { options.onDispatchOutcome?.(outcome); } catch {}
    return outcome;
  };
  let claimed: DispatchClaim;
  try {
    claimed = state.claimDispatch(messageId);
  } catch (error) {
    return reportOutcome({ status: 'rejected', message: state.getMessage(messageId), error });
  }
  if (!claimed.claimed) return reportOutcome({ status: claimed.reason || claimed.message?.state || 'ignored', message: claimed.message });
  const message = claimed.message as NativeMessage;
  const provider = providers[message.provider];
  if (!provider) {
    const error = new Error(`provider is not configured: ${message.provider}`);
    state.markUncertain(message.id, error);
    return reportOutcome({ status: DISPATCH_STATUSES.UNCERTAIN, message: state.getMessage(message.id), error });
  }
  const marker = `[[discord-surface:${message.id}]]`;
  let outcome: unknown;
  try {
    const dispatchMessage = providerMessageForBinding(state, message);
    const dispatchOptions = {
      signal: options.signal,
      onCursor: (cursor: ObserverCursor) => state.setObserverCursor(message.id, cursor, marker)
    };
    outcome = options.dispatch
      ? await options.dispatch(dispatchMessage, provider, dispatchOptions)
      : await provider.dispatch(dispatchMessage, dispatchOptions);
  } catch (error) {
    state.markUncertain(message.id, error);
    return reportOutcome({ status: DISPATCH_STATUSES.UNCERTAIN, message: state.getMessage(message.id), error });
  }
  if (!isDispatchOutcome(outcome)) {
    const error = new Error('native dispatcher returned an invalid outcome');
    state.markUncertain(message.id, error);
    return reportOutcome({ status: DISPATCH_STATUSES.UNCERTAIN, message: state.getMessage(message.id), error });
  }
  if (outcome.status === DISPATCH_STATUSES.NOT_SUBMITTED) {
    try { options.onNativeUnavailable?.(message, outcome.error, outcome); } catch {}
    state.markNotSubmitted(message.id, outcome.error);
    return reportOutcome({ status: DISPATCH_STATUSES.NOT_SUBMITTED, message: state.getMessage(message.id), error: outcome.error });
  }
  if (outcome.status === DISPATCH_STATUSES.UNCERTAIN) {
    state.markUncertain(message.id, outcome.error);
    return reportOutcome({ status: DISPATCH_STATUSES.UNCERTAIN, message: state.getMessage(message.id), error: outcome.error });
  }
  state.markSubmitted(message.id, outcome.cursor || null, marker);
  reportOutcome({ status: DISPATCH_STATUSES.SUBMITTED, message: state.getMessage(message.id) });
  try { options.onSubmitted?.(state.getMessage(message.id)); } catch {}
  const observation = await observeSubmitted(state, state.getMessage(message.id) as NativeMessage, provider, options);
  return observation;
}
