// Validated reply context for a plain human Discord message.
//
// This module is the single owner of the ReplyContext shape and its validation
// rules. Discord integration builds a candidate from message.reference, the
// intake transaction persists its serialized form, getMessage re-validates the
// stored form before hydration, and the native presenter renders it. Every
// boundary re-validates: a malformed candidate or stored blob degrades to
// "no context" instead of surfacing corrupt data.

export interface ReplyContext {
  messageId: string;
  channelId: string;
  guildId: string;
  excerpt: string;
  isBotAuthor: boolean | null;
}

export const REPLY_CONTEXT_MAX_ID_DIGITS = 20;
export const REPLY_CONTEXT_MAX_EXCERPT_CODE_POINTS = 300;

const SNOWFLAKE = /^[0-9]{1,20}$/;

export function isSnowflakeId(value: unknown): value is string {
  return typeof value === 'string' && SNOWFLAKE.test(value);
}

// Truncate to the first `limit` Unicode code points so a surrogate pair is
// never split. Returns null for a non-string input.
export function truncateExcerpt(value: unknown, limit: number = REPLY_CONTEXT_MAX_EXCERPT_CODE_POINTS): string | null {
  if (typeof value !== 'string') return null;
  if (!Number.isFinite(limit) || limit <= 0) return '';
  return Array.from(value).slice(0, Math.floor(limit)).join('');
}

// Accept a candidate context (from Discord normalization or a caller) and
// return the canonical five-field shape. Invalid ids or a non-string excerpt
// mean "no context"; an unknown or absent authorship is null, never false.
export function normalizeReplyContext(value: unknown): ReplyContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isSnowflakeId(record.messageId) || !isSnowflakeId(record.channelId) || !isSnowflakeId(record.guildId)) return null;
  if (typeof record.excerpt !== 'string') return null;
  const isBotAuthor = record.isBotAuthor === true ? true : record.isBotAuthor === false ? false : null;
  return {
    messageId: record.messageId,
    channelId: record.channelId,
    guildId: record.guildId,
    excerpt: truncateExcerpt(record.excerpt) ?? '',
    isBotAuthor
  };
}

// Persistence form: a JSON string of exactly the five validated fields, or null
// when there is no valid context. Never returns a placeholder for empty context.
export function serializeReplyContext(value: unknown): string | null {
  const normalized = normalizeReplyContext(value);
  if (!normalized) return null;
  return JSON.stringify(normalized);
}

// Hydration form: re-validate a stored blob. Malformed input returns null so
// callers omit the field entirely; this never throws.
export function deserializeReplyContext(value: unknown): ReplyContext | null {
  if (typeof value !== 'string') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!isSnowflakeId(record.messageId) || !isSnowflakeId(record.channelId) || !isSnowflakeId(record.guildId)) return null;
  if (typeof record.excerpt !== 'string') return null;
  if (record.isBotAuthor !== true && record.isBotAuthor !== false && record.isBotAuthor !== null) return null;
  const excerpt = truncateExcerpt(record.excerpt);
  if (excerpt === null) return null;
  return {
    messageId: record.messageId,
    channelId: record.channelId,
    guildId: record.guildId,
    excerpt,
    isBotAuthor: record.isBotAuthor as boolean | null
  };
}
