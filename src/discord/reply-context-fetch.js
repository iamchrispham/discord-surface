const { isSnowflakeId, normalizeReplyContext, truncateExcerpt } = require('../reply-context');

const requireInstalled = require;

// Reply context is optional enrichment for a plain human ordinary message. A
// validated target whose id is known but whose text is unavailable still
// preserves the declared ids with an empty excerpt. Every failure degrades to
// that ID-only shape (or no context at all for an invalid reference) and never
// throws into intake.
function degradedReplyContext(messageId, channelId, guildId) {
  return normalizeReplyContext({ messageId, channelId, guildId, excerpt: '', isBotAuthor: null });
}

function replyContextFromAuthor(details, messageId, channelId, guildId, botId) {
  const excerpt = truncateExcerpt(typeof details?.content === 'string' ? details.content : null) ?? '';
  const authorId = details?.author?.id;
  const isBotAuthor = typeof botId === 'string' && botId.length > 0
    ? authorId === botId
    : null;
  return normalizeReplyContext({ messageId, channelId, guildId, excerpt, isBotAuthor });
}

// Discord's REST payload may omit guild_id or author.bot. A supplied value must
// match the proven route, and bot authorship comes from the connected bot id.
function rawReplyContextIsValid(raw, messageId, channelId, guildId) {
  if (!raw || typeof raw !== 'object') return false;
  if (raw.id !== messageId || raw.channel_id !== channelId) return false;
  if (guildId && raw.guild_id !== undefined && raw.guild_id !== guildId) return false;
  if (typeof raw.content !== 'string') return false;
  if (typeof raw.author?.id !== 'string') return false;
  if (raw.author.bot !== undefined && typeof raw.author.bot !== 'boolean') return false;
  return true;
}

async function optionalReplyContext(message, options = {}) {
  const messageId = message?.reference?.messageId;
  if (!isSnowflakeId(messageId)) return null;
  const currentChannelId = message?.channelId;
  const currentGuildId = message?.guildId;
  if (!isSnowflakeId(currentChannelId) || !isSnowflakeId(currentGuildId)) return null;
  const reference = message.reference;
  const targetChannelId = typeof reference.channelId === 'string' && reference.channelId.length > 0 ? reference.channelId : currentChannelId;
  const targetGuildId = typeof reference.guildId === 'string' && reference.guildId.length > 0 ? reference.guildId : currentGuildId;
  if (!isSnowflakeId(targetChannelId) || !isSnowflakeId(targetGuildId)) return null;
  const degraded = degradedReplyContext(messageId, targetChannelId, targetGuildId);
  if (targetGuildId !== currentGuildId || targetChannelId !== currentChannelId) return degraded;
  const { signal, timeoutMs, deadline, botId } = options;
  let budget = Infinity;
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)) budget = Math.min(budget, timeoutMs);
  if (typeof deadline === 'number' && Number.isFinite(deadline)) budget = Math.min(budget, deadline - Date.now());
  if (!Number.isFinite(budget) || budget <= 0 || signal?.aborted) return degraded;
  try {
    const cached = message?.channel?.messages?.cache?.get?.(messageId);
    if (cached && cached.id === messageId && cached.channelId === targetChannelId && cached.guildId === targetGuildId) {
      return replyContextFromAuthor(cached, messageId, targetChannelId, targetGuildId, botId);
    }
  } catch {}
  let Routes;
  try { ({ Routes } = requireInstalled('discord.js')); } catch { return degraded; }
  if (!Routes?.channelMessage) return degraded;
  const rest = message?.client?.rest;
  if (typeof rest?.get !== 'function') return degraded;
  const controller = new AbortController();
  const abortWith = () => {
    try { controller.abort(); } catch {}
  };
  const relayAbort = () => abortWith();
  signal?.addEventListener('abort', relayAbort, { once: true });
  const timer = setTimeout(abortWith, Math.max(1, budget));
  let restPending = true;
  const restPromise = Promise.resolve()
    .then(() => rest.get(Routes.channelMessage(targetChannelId, messageId), { signal: controller.signal }))
    .then(
      raw => (rawReplyContextIsValid(raw, messageId, targetChannelId, targetGuildId)
        ? replyContextFromAuthor(raw, messageId, targetChannelId, targetGuildId, botId)
        : degraded),
      () => degraded
    );
  restPromise.catch(() => {});
  restPromise.then(() => { restPending = false; }, () => { restPending = false; });
  const abortPromise = new Promise(resolve => {
    if (controller.signal.aborted) return resolve(degraded);
    controller.signal.addEventListener('abort', () => resolve(degraded), { once: true });
  });
  try {
    return await Promise.race([restPromise, abortPromise]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
    if (restPending) abortWith();
  }
}

module.exports = { optionalReplyContext };
