import * as crypto from 'node:crypto';

const BOARD_MESSAGE_LIMIT = 2000;

export interface BoardFetchResponse {
  ok?: boolean;
  status?: number;
  json?: () => Promise<unknown>;
  body?: { cancel?: () => Promise<unknown> | unknown } | null;
}

export type BoardFetch = (url: string, init: {
  method: 'GET' | 'PATCH';
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<BoardFetchResponse>;

export interface BoardMessage {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
}

interface BoardUser {
  id: string;
}

interface BoardTransportError extends Error {
  status?: number;
  outcome?: 'not_sent' | 'rejected' | 'rate_limited' | 'unknown';
  started?: boolean;
}

function text(value: unknown, name: string, max = 2048): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000\u007f]/.test(value)) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

export function readBoardText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > BOARD_MESSAGE_LIMIT || !value.trim() || /[\u0000\u007f]/.test(value)) {
    throw new Error('board text must be non-empty and at most 2000 characters');
  }
  return value;
}

export function hashBoardText(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function transportError(message: string, status: number | undefined, outcome: BoardTransportError['outcome'], started: boolean): BoardTransportError {
  const error = new Error(message) as BoardTransportError;
  error.status = status;
  error.outcome = outcome;
  error.started = started;
  return error;
}

function classifyStatus(status: number | undefined): BoardTransportError['outcome'] {
  if (status === 429) return 'rate_limited';
  if (typeof status === 'number' && status >= 400 && status < 500) return 'rejected';
  return 'unknown';
}

async function cancelBody(response: BoardFetchResponse | null | undefined): Promise<void> {
  try { await response?.body?.cancel?.(); } catch {}
}

async function requestJson(
  token: string,
  url: string,
  method: 'GET' | 'PATCH',
  body: string | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  fetchImpl: BoardFetch
): Promise<unknown> {
  if (typeof fetchImpl !== 'function') throw transportError('Discord board fetch is unavailable', undefined, 'not_sent', false);
  if (signal?.aborted) throw transportError('Discord board request stopped before request', undefined, 'not_sent', false);
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  signal?.addEventListener('abort', relayAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let timedOut = false;
  const operation = (async () => {
    started = true;
    let response: BoardFetchResponse;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bot ${token}`,
          'User-Agent': 'DiscordBot (discord-surface, 0.1.0)',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(body === undefined ? {} : { body }),
        signal: controller.signal
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause as BoardTransportError : transportError(String(cause), undefined, 'unknown', started);
      if (!error.outcome) error.outcome = 'unknown';
      error.started = started;
      throw error;
    }
    if (!response?.ok) {
      const status = Number(response?.status);
      await cancelBody(response);
      throw transportError(`Discord board ${method} request rejected`, Number.isInteger(status) ? status : undefined,
        classifyStatus(Number.isInteger(status) ? status : undefined), started);
    }
    try {
      return await response.json?.();
    } catch (cause) {
      await cancelBody(response);
      const error = cause instanceof Error ? cause as BoardTransportError : transportError(String(cause), undefined, 'unknown', started);
      error.outcome = 'unknown';
      error.started = started;
      throw error;
    }
  })();
  const deadline = new Promise<unknown>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(transportError(`Discord board ${method} request deadline exceeded`, undefined, 'unknown', started));
    }, Math.max(1, Number(timeoutMs)));
  });
  try {
    return await Promise.race([operation, deadline]);
  } catch (cause) {
    const error = cause instanceof Error ? cause as BoardTransportError : transportError(String(cause), undefined, started ? 'unknown' : 'not_sent', started);
    if (!error.outcome) error.outcome = started || timedOut ? 'unknown' : 'not_sent';
    error.started = started;
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
    controller.abort();
    operation.catch(() => {});
  }
}

function messageRecord(value: unknown): BoardMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Discord board message response is malformed');
  const record = value as Record<string, unknown>;
  const author = record.author;
  if (author === null || typeof author !== 'object' || Array.isArray(author)) throw new Error('Discord board message author is missing');
  const authorRecord = author as Record<string, unknown>;
  return {
    id: text(record.id, 'message.id', 128),
    guildId: text(record.guild_id, 'message.guild_id', 128),
    channelId: text(record.channel_id, 'message.channel_id', 128),
    authorId: text(authorRecord.id, 'message.author.id', 128),
    authorIsBot: authorRecord.bot === true,
    content: typeof record.content === 'string' ? record.content : ''
  };
}

function userRecord(value: unknown): BoardUser {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Discord installation user response is malformed');
  return { id: text((value as Record<string, unknown>).id, 'installation user id', 128) };
}

function endpoint(channelId: string, messageId?: string): string {
  const channel = encodeURIComponent(text(channelId, 'channelId', 128));
  return messageId === undefined
    ? `https://discord.com/api/v10/channels/${channel}/messages`
    : `https://discord.com/api/v10/channels/${channel}/messages/${encodeURIComponent(text(messageId, 'messageId', 128))}`;
}

export async function fetchBoardTarget({ token, channelId, messageId, signal, timeoutMs = 30000, fetchImpl = globalThis.fetch as unknown as BoardFetch }: {
  token: string;
  channelId: string;
  messageId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: BoardFetch;
}): Promise<BoardMessage> {
  const result = await requestJson(token, endpoint(channelId, messageId), 'GET', undefined, signal, timeoutMs, fetchImpl);
  return messageRecord(result);
}

export async function fetchBoardInstallation({ token, signal, timeoutMs = 30000, fetchImpl = globalThis.fetch as unknown as BoardFetch }: {
  token: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: BoardFetch;
}): Promise<BoardUser> {
  const result = await requestJson(token, 'https://discord.com/api/v10/users/@me', 'GET', undefined, signal, timeoutMs, fetchImpl);
  return userRecord(result);
}

export async function patchBoardMessage({ token, channelId, messageId, content, signal, timeoutMs = 30000, fetchImpl = globalThis.fetch as unknown as BoardFetch }: {
  token: string;
  channelId: string;
  messageId: string;
  content: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: BoardFetch;
}): Promise<BoardMessage> {
  const desired = readBoardText(content);
  const result = await requestJson(token, endpoint(channelId, messageId), 'PATCH', JSON.stringify({
    content: desired,
    allowed_mentions: { parse: [] }
  }), signal, timeoutMs, fetchImpl);
  return messageRecord(result);
}

export { BOARD_MESSAGE_LIMIT };
