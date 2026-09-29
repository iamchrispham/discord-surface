const ROUTE_RECEIPT = 'legacy-agent-request-route';

function isLegacyParentRequest(message) {
  return message.agentMessage?.kind === 'request' &&
    message.agentMessage.target.channelId === message.channelId;
}

function frozenRoute(state, message) {
  const row = state.db.prepare('SELECT detail FROM receipts WHERE discord_id=? AND kind=? ORDER BY id LIMIT 1')
    .get(message.id, ROUTE_RECEIPT);
  if (!row) return null;
  let detail;
  try { detail = JSON.parse(row.detail); }
  catch { throw new Error('legacy agent request route receipt is malformed'); }
  if (!isLegacyParentRequest(message) || !detail || typeof detail !== 'object' ||
      typeof detail.threadId !== 'string' || !detail.threadId || detail.threadId === message.channelId ||
      detail.parentChannelId !== message.channelId || detail.guildId !== message.guildId ||
      detail.provider !== message.provider || detail.nativeId !== message.nativeId ||
      detail.generation !== message.generation) {
    throw new Error('legacy agent request route receipt is malformed');
  }
  return detail.threadId;
}

function claimRoute(state, message) {
  if (!isLegacyParentRequest(message)) return { ready: true };
  const saved = frozenRoute(state, message);
  if (saved) {
    const route = state.getMessageRoute(saved);
    return route?.ready && route.enrollment?.parentChannelId === message.channelId &&
      route.binding.guildId === message.guildId && route.binding.provider === message.provider &&
      route.binding.nativeId === message.nativeId && route.binding.generation === message.generation
      ? { ready: true }
      : { ready: false, reason: 'legacy-agent-route-not-ready' };
  }
  const children = state.listThreadEnrollments(message.channelId)
    .filter(enrollment => enrollment.active && enrollment.guildId === message.guildId &&
      state.getMessageRoute(enrollment.threadId)?.ready);
  if (children.length !== 1) return { ready: false, reason: 'legacy-agent-route-not-unique' };
  const threadId = children[0].threadId;
  state.receipt(message.id, ROUTE_RECEIPT, {
    threadId, parentChannelId: message.channelId, guildId: message.guildId,
    provider: message.provider, nativeId: message.nativeId, generation: message.generation
  });
  return { ready: true };
}

function legacyParentReconciliationChannel(previous, updated) {
  if (!previous || !updated || previous.state !== 'ready' || updated.state === 'ready') return null;
  return typeof updated.parentChannelId === 'string' && updated.parentChannelId ? updated.parentChannelId : null;
}

function heldParentRequestIds(state, parentChannelIds) {
  const accepted = state.db.prepare("SELECT discord_id FROM messages WHERE channel_id=? AND state='accepted' ORDER BY created_at, rowid");
  return parentChannelIds.flatMap(channelId => accepted.all(channelId)
    .map(row => state.getMessage(row.discord_id))
    .filter(message => isLegacyParentRequest(message) && !message.agentRoute)
    .map(message => message.id));
}

module.exports = { claimRoute, frozenRoute, heldParentRequestIds, legacyParentReconciliationChannel };
