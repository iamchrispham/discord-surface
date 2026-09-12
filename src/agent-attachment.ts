import { PREFIX as AGENT_PREFIX } from './agent-message';
import { CODEX_VALIDATION_KINDS } from './native-transcript';

export const AGENT_ATTACHMENT_FILENAME = 'agent-message.tether';
export const AGENT_ATTACHMENT_CONTENT_TYPE = 'application/octet-stream';
export const AGENT_ATTACHMENT_MAX_BYTES = 2000;

const AGENT_ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const DEFAULT_ATTACHMENT_TIMEOUT_MS = 30000;

type RecoveryKind = string;

interface AgentAttachmentFailure extends Error {
  recoveryKind?: RecoveryKind;
}

interface AttachmentRecord {
  url?: unknown;
  filename?: unknown;
  contentType?: unknown;
  size?: unknown;
}

interface AgentInput {
  content?: unknown;
  attachments?: unknown;
  isBot?: unknown;
  [key: string]: unknown;
}

interface AttachmentHeaders {
  get?: (name: string) => string | null;
  [key: string]: unknown;
}

interface AttachmentReader {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?: () => PromiseLike<unknown> | unknown;
  releaseLock?: () => void;
}

interface AttachmentBody {
  getReader?: () => AttachmentReader;
  cancel?: () => PromiseLike<unknown> | unknown;
}

interface AttachmentResponse {
  ok?: boolean;
  status?: number;
  url?: string;
  headers?: AttachmentHeaders;
  body?: AttachmentBody | null;
}

interface AttachmentFetchInit {
  method: 'GET';
  redirect: 'manual';
  signal: AbortSignal;
}

export type AttachmentFetch = (url: string, init: AttachmentFetchInit) => Promise<AttachmentResponse>;

export interface AgentAttachmentOptions {
  fetchImpl?: AttachmentFetch;
  signal?: AbortSignal | null;
  timeoutMs?: number;
  deadline?: number | null;
  botId?: string | null;
}

function attachmentError(detail: string, cause: unknown = null, recoveryKind: RecoveryKind = 'agent-attachment'): AgentAttachmentFailure {
  const error = new Error(`agent attachment ${detail}`) as AgentAttachmentFailure;
  if (cause !== null) error.cause = cause;
  error.recoveryKind = recoveryKind;
  return error;
}

function defaultFetch(): AttachmentFetch | null {
  const fetchImpl = globalThis.fetch;
  return typeof fetchImpl === 'function' ? fetchImpl.bind(globalThis) as unknown as AttachmentFetch : null;
}

export function attachmentUrlAllowed(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return false; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !AGENT_ATTACHMENT_HOSTS.has(parsed.hostname.toLowerCase())) return false;
  const segments = parsed.pathname.split('/');
  return segments.length === 5 && segments[1] === 'attachments' && /^\d{1,20}$/u.test(segments[2]) &&
    /^\d{1,20}$/u.test(segments[3]) && segments[4].length > 0;
}

function readAttachmentHeader(response: AttachmentResponse, name: string): string | null {
  if (typeof response.headers?.get === 'function') return response.headers.get(name);
  const value = response.headers?.[name] ?? response.headers?.[name.toLowerCase()];
  return value === null || value === undefined ? null : String(value);
}

function cancelWithoutWaiting(value: { cancel?: () => PromiseLike<unknown> | unknown } | null | undefined): void {
  try { Promise.resolve(value?.cancel?.()).catch(() => {}); } catch {}
}

function waitWithAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('agent attachment operation stopped'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const finishResolve = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => finishReject(new Error('agent attachment operation stopped'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(operation).then(
      value => finishResolve(value),
      error => finishReject(error instanceof Error ? error : new Error(String(error)))
    );
  });
}

function readWithAbort(reader: AttachmentReader, signal: AbortSignal): Promise<{ done: boolean; value?: Uint8Array }> {
  if (signal.aborted) return Promise.reject(new Error('agent attachment read stopped'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const finishResolve = (value: { done: boolean; value?: Uint8Array }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => finishReject(new Error('agent attachment read stopped'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => reader.read()).then(
      value => finishResolve(value),
      error => finishReject(error instanceof Error ? error : new Error(String(error)))
    );
  });
}

async function readBoundedAttachment(response: AttachmentResponse, signal: AbortSignal): Promise<Buffer> {
  const reader = response.body?.getReader?.();
  if (!reader) throw attachmentError('response body is not a bounded stream');
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const next = await readWithAbort(reader, signal);
      if (next.done) break;
      const chunk = Buffer.from(next.value || []);
      bytesRead += chunk.length;
      if (bytesRead > AGENT_ATTACHMENT_MAX_BYTES) throw attachmentError('exceeds the bounded wire limit');
      chunks.push(chunk);
    }
  } catch (error) {
    cancelWithoutWaiting(reader);
    throw error;
  } finally {
    try { reader.releaseLock?.(); } catch {}
  }
  return Buffer.concat(chunks, bytesRead);
}

function boundedTimeout({ timeoutMs, deadline }: AgentAttachmentOptions): number {
  const configured = Number(timeoutMs ?? DEFAULT_ATTACHMENT_TIMEOUT_MS);
  const base = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ATTACHMENT_TIMEOUT_MS;
  if (deadline === null || deadline === undefined) return base;
  const remaining = deadline - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  return Math.min(base, remaining);
}

export async function fetchAgentAttachment(attachment: AttachmentRecord, options: AgentAttachmentOptions = {}): Promise<string> {
  if (options.signal?.aborted) throw attachmentError('fetch was stopped', null, CODEX_VALIDATION_KINDS.STOPPED);
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  if (!fetchImpl) throw attachmentError('fetch is unavailable');
  if (!attachmentUrlAllowed(attachment.url)) throw attachmentError('URL is not an allowed Discord CDN attachment path');
  const timeoutMs = boundedTimeout(options);
  if (timeoutMs <= 0) throw attachmentError('deadline exceeded', null, CODEX_VALIDATION_KINDS.DEADLINE);
  const controller = new AbortController();
  let abortedByCaller = false;
  let timedOut = false;
  const relayAbort = () => {
    abortedByCaller = true;
    controller.abort();
  };
  options.signal?.addEventListener('abort', relayAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));
  try {
    let response: AttachmentResponse;
    try {
      const request = Promise.resolve().then(() => fetchImpl(attachment.url as string, {
        method: 'GET', redirect: 'manual', signal: controller.signal
      }));
      request.then(lateResponse => {
        if (controller.signal.aborted) cancelWithoutWaiting(lateResponse.body);
      }, () => {});
      response = await waitWithAbort(() => request, controller.signal);
    } catch (error) {
      if (abortedByCaller) throw attachmentError('fetch was stopped', error, CODEX_VALIDATION_KINDS.STOPPED);
      if (timedOut) throw attachmentError('fetch deadline exceeded', error, CODEX_VALIDATION_KINDS.DEADLINE);
      throw attachmentError('fetch failed', error);
    }
    if (options.deadline !== null && options.deadline !== undefined && Date.now() >= options.deadline) {
      cancelWithoutWaiting(response.body);
      throw attachmentError('deadline exceeded', null, CODEX_VALIDATION_KINDS.DEADLINE);
    }
    if (response.url && !attachmentUrlAllowed(response.url)) {
      cancelWithoutWaiting(response.body);
      throw attachmentError('redirected away from the Discord CDN attachment path');
    }
    if (!response.ok) {
      cancelWithoutWaiting(response.body);
      throw attachmentError(`fetch returned HTTP ${response.status || 'error'}`);
    }
    const contentLength = Number(readAttachmentHeader(response, 'content-length'));
    if (Number.isSafeInteger(contentLength) && contentLength > AGENT_ATTACHMENT_MAX_BYTES) {
      cancelWithoutWaiting(response.body);
      throw attachmentError('declared size exceeds the bounded wire limit');
    }
    let bytes: Buffer;
    try {
      bytes = await readBoundedAttachment(response, controller.signal);
    } catch (error) {
      if (abortedByCaller) throw attachmentError('read was stopped', error, CODEX_VALIDATION_KINDS.STOPPED);
      if (timedOut) throw attachmentError('read deadline exceeded', error, CODEX_VALIDATION_KINDS.DEADLINE);
      throw error instanceof Error && 'recoveryKind' in error ? error : attachmentError('read failed', error);
    }
    if (options.deadline !== null && options.deadline !== undefined && Date.now() >= options.deadline) {
      throw attachmentError('deadline exceeded', null, CODEX_VALIDATION_KINDS.DEADLINE);
    }
    let wire: string;
    try { wire = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (error) { throw attachmentError('body is not valid UTF-8', error); }
    if (!Buffer.from(wire, 'utf8').equals(bytes)) throw attachmentError('body is not canonical UTF-8');
    return wire;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', relayAbort);
    controller.abort();
  }
}

function isBotMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const author = (message as { author?: unknown }).author;
  return Boolean(author && typeof author === 'object' && (author as { bot?: unknown }).bot === true);
}

function isConnectedBotMessage(message: unknown, botId: string | null | undefined): boolean {
  if (!isBotMessage(message) || typeof botId !== 'string' || botId.length === 0) return false;
  const author = (message as { author?: unknown }).author;
  return Boolean(author && typeof author === 'object' && (author as { id?: unknown }).id === botId);
}

function isPermanentMetadataValid(attachment: AttachmentRecord): boolean {
  return typeof attachment.contentType === 'string' && attachment.contentType.toLowerCase() === AGENT_ATTACHMENT_CONTENT_TYPE &&
    Number.isSafeInteger(attachment.size) && Number(attachment.size) >= 1 && Number(attachment.size) <= AGENT_ATTACHMENT_MAX_BYTES &&
    attachmentUrlAllowed(attachment.url);
}

export async function normalizeAgentMessage(message: unknown, input: AgentInput, options: AgentAttachmentOptions = {}): Promise<AgentInput> {
  if (!isConnectedBotMessage(message, options.botId) || (typeof input.content === 'string' && input.content.startsWith(AGENT_PREFIX))) return input;
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  const candidates = attachments.filter(attachment => attachment && typeof attachment === 'object' &&
    (attachment as AttachmentRecord).filename === AGENT_ATTACHMENT_FILENAME) as AttachmentRecord[];
  if (!candidates.length) return input;
  if (candidates.length !== 1 || attachments.length !== 1) return input;
  const [attachment] = candidates;
  if (!isPermanentMetadataValid(attachment)) return input;
  const wire = await fetchAgentAttachment(attachment, options);
  return { ...input, content: wire, attachments: [] };
}
