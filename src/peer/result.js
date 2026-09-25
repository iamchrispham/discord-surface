'use strict';

const { KINDS, sameAddress, validateAgentMessage } = require('../agent-message');
const { DIRECT_POST_OUTCOME, AGENT_COMPLETION_RECEIPTS, MESSAGE_STATES } = require('../state');
const PACKET_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function validPeerId(value) {
  return typeof value === 'string' && PACKET_ID_PATTERN.test(value);
}

function packetMatches(left, right) {
  return left.id === right.id && left.kind === right.kind && left.replyTo === right.replyTo &&
    left.text === right.text && sameAddress(left.source, right.source) && sameAddress(left.target, right.target);
}

function deliveryEvidence(state, messageId, packet) {
  const message = state.getMessage(messageId);
  if (!message || message.nativeId !== packet.target.nativeId || message.provider !== packet.target.provider ||
      message.generation !== packet.target.generation || message.guildId !== packet.target.guildId ||
      (message.deliveryChannelId || message.channelId) !== packet.target.channelId) return null;
  const kind = packet.kind === KINDS.RESULT ? AGENT_COMPLETION_RECEIPTS.RESULT_CONSUMED : AGENT_COMPLETION_RECEIPTS.REQUEST_HANDLED_WITHOUT_POST;
  const completions = state.db.prepare('SELECT id, detail FROM receipts WHERE discord_id=? AND kind=? ORDER BY id').all(messageId, kind);
  const completion = completions.find(row => {
    const detail = JSON.parse(row.detail);
    return detail.packetId === packet.id && detail.disposition === kind &&
      detail.nativeId === packet.target.nativeId && detail.provider === packet.target.provider &&
      detail.generation === packet.target.generation && sameAddress(detail.source, packet.source) && sameAddress(detail.target, packet.target);
  });
  return { messageId, state: message.state, nativeAcknowledged: state.hasNativeAcknowledgment(message),
    completed: message.state === MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST && Boolean(completion),
    completionReceiptId: completion?.id ?? null };
}

function inspectPeerResult(state, source, correlationId) {
  if (!validPeerId(correlationId)) throw new Error('invalid correlation_id');
  const rows = state.directPostRows(correlationId, source.channelId).filter(row => {
    const d = row.detail;
    return d.nativeId === source.nativeId && d.provider === source.provider && d.generation === source.generation && d.guildId === source.guildId;
  });
  const packets = rows.map(row => row.detail.agentPacket).filter(Boolean);
  for (const packet of packets) validateAgentMessage(packet);
  const packet = packets[0];
  if (!packet) throw new Error('correlation is unknown for this caller');
  if (packets.some(candidate => !packetMatches(candidate, packet))) throw new Error('correlation has conflicting custody');
  const receipts = state.db.prepare(`SELECT discord_id FROM receipts WHERE kind='agent-message' AND
    (json_extract(detail, '$.packet.id')=? OR json_extract(detail, '$.packet.replyTo')=?) ORDER BY id`).all(packet.id, packet.id);
  const deliveries = [];
  const results = [];
  const seen = new Set();
  for (const row of receipts) {
    if (seen.has(row.discord_id)) continue;
    seen.add(row.discord_id);
    const candidate = state.getAgentMessage(row.discord_id)?.packet;
    if (!candidate) continue;
    validateAgentMessage(candidate);
    const evidence = deliveryEvidence(state, row.discord_id, candidate);
    if (!evidence) continue;
    if (packetMatches(candidate, packet)) deliveries.push(evidence);
    else if (packet.kind === KINDS.REQUEST && candidate.kind === KINDS.RESULT && candidate.replyTo === packet.id &&
      sameAddress(candidate.source, packet.target) && sameAddress(candidate.target, packet.source)) {
      results.push({ ...evidence, packetId: candidate.id, text: candidate.text });
    }
  }
  return { correlationId, sendOutcome: rows.filter(row => row.kind === DIRECT_POST_OUTCOME).at(-1)?.detail.outcome ?? null,
    deliveries, results };
}

module.exports = { inspectPeerResult, validPeerId };
