function createMessageReadHandlers({
  parseJson,
  deserializeReplyContext,
  normalizeAttachments,
  StateCorruptError,
  WATCHER_NOTICE_RECEIPTS,
  WATCHER_NOTICE_JOURNAL,
  validateWatcherNotice,
  AGENT_PREFIX,
  legacyAgentRequestRoute,
  WATCHER_NOTICE_PREFIX,
  interactionHandlers
}) {
function rowMessage(row) {
  if (!row) return null;
  let attachments;
  try {
    if (typeof row.attachments !== 'string') throw new TypeError('attachments column is not text');
    const parsed = JSON.parse(row.attachments);
    if (!Array.isArray(parsed)) throw new TypeError('attachments must be an array');
    attachments = normalizeAttachments(parsed);
  } catch (error) {
    throw new StateCorruptError(`message attachments are invalid: ${error.message}`);
  }
  return {
    id: row.discord_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    deliveryChannelId: row.delivery_channel_id || row.channel_id,
    authorId: row.author_id,
    content: row.content,
    attachments,
    provider: row.provider,
    nativeId: row.native_id,
    workspace: row.workspace,
    endpoint: row.endpoint,
    conductorId: row.conductor_id || null,
    repoKey: row.repo_key || null,
    generation: Number(row.generation),
    state: row.state,
    replyText: row.reply_text,
    replyNonce: row.reply_nonce,
    replyMessageId: row.reply_message_id,
    replyNextPart: Number(row.reply_next_part || 0),
    observerCursor: parseJson(row.observer_cursor, null),
    observerMarker: row.observer_marker,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Attach the persisted reply context to an ordinary human message. The first
// accepted receipt wins permanently; later accepted receipts are never
// consulted. A stored context whose channel does not match the message's own
// channel is out of scope and is omitted, as is a malformed blob. Hydration
// never throws into getMessage.
function hydrateReplyContext(state, message) {
  const row = state.db.prepare("SELECT id, detail FROM receipts WHERE discord_id=? AND kind='accepted' ORDER BY id LIMIT 1").get(message.id);
  if (!row) return;
  const detail = parseJson(row.detail, null);
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return;
  if (detail.channelId !== message.channelId) return;
  const replyContext = deserializeReplyContext(detail.replyContext);
  if (replyContext) message.replyContext = replyContext;
}

  return {
getAgentMessage(messageId) {
    const row = this.db.prepare("SELECT detail FROM receipts WHERE discord_id=? AND kind='agent-message' ORDER BY id LIMIT 1").get(messageId);
    return row ? parseJson(row.detail, null) : null;
  },

getWatcherNotice(messageId) {
    const row = this.db.prepare(`SELECT id, detail, created_at FROM receipts
      WHERE discord_id=? AND kind=? ORDER BY id LIMIT 1`).get(messageId, WATCHER_NOTICE_RECEIPTS.PROVENANCE);
    if (!row) return null;
    const detail = parseJson(row.detail, null);
    if (!detail || detail.journal !== WATCHER_NOTICE_JOURNAL || !detail.packet || typeof detail.authorId !== 'string') {
      throw new StateCorruptError('watcher notice provenance is malformed');
    }
    try { validateWatcherNotice(detail.packet); }
    catch (error) { throw new StateCorruptError(`watcher notice provenance is malformed: ${error.message}`); }
    return {
      packet: detail.packet,
      authorId: detail.authorId,
      receiptId: Number(row.id),
      recordedAt: row.created_at
    };
  },

getMessage(messageId) {
    const message = rowMessage(this.db.prepare('SELECT * FROM messages WHERE discord_id=?').get(messageId));
    if (message) {
      message.replyParts = this.listReplyParts(messageId);
      const agent = message.content.startsWith(AGENT_PREFIX) ? this.getAgentMessage(messageId) : null;
      if (agent) {
        message.agentMessage = agent.packet;
        message.agentRoute = legacyAgentRequestRoute.frozenRoute(this, message);
      }
      const notice = message.content.startsWith(WATCHER_NOTICE_PREFIX) ? this.getWatcherNotice(messageId) : null;
      if (notice) {
        message.watcherNotice = notice.packet;
        message.watcherNoticeProvenance = notice;
      }
      const decisionResult = interactionHandlers.decisionResult(this, message);
      if (decisionResult) message.decisionResult = decisionResult;
      else if (!agent && !notice) hydrateReplyContext(this, message);
    }
    return message;
  },

getMessageRowId(messageId) {
    const row = this.db.prepare('SELECT rowid FROM messages WHERE discord_id=?').get(messageId);
    return row ? Number(row.rowid) : null;
  },

listMessages() {
    return this.db.prepare('SELECT discord_id FROM messages ORDER BY created_at, rowid').all().map(row => this.getMessage(row.discord_id));
  }
  };
}

module.exports = { createMessageReadHandlers };
