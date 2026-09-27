'use strict';

const { KINDS, sameAddress, validateAgentMessage } = require('../agent-message');
const { DIRECT_POST_ATTEMPT, DIRECT_POST_OUTCOME, AGENT_COMPLETION_RECEIPTS, MESSAGE_STATES } = require('../state');
const { isLegacyChildResult } = require('../../dist/state/agent-routing.js');
const { projectNewestDirectPostAttempt } = require('../../dist/state/direct-post.js');
const PACKET_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const PEER_PACKET_ID_SCHEMA = Object.freeze({
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: PACKET_ID_PATTERN.source
});

function validPeerId(value) {
  return typeof value === 'string' && PACKET_ID_PATTERN.test(value);
}

function packetMatches(left, right) {
  return left.id === right.id && left.kind === right.kind && left.replyTo === right.replyTo &&
    left.text === right.text && sameAddress(left.source, right.source) && sameAddress(left.target, right.target);
}

function packetVariants(packet, legacyAgentPacket) {
  return [packet, legacyAgentPacket].filter(Boolean);
}

function packetRecordsMatch(left, right) {
  return packetMatches(left.packet, right.packet) ||
    (left.legacyAgentPacket && packetMatches(left.legacyAgentPacket, right.packet)) ||
    (right.legacyAgentPacket && packetMatches(left.packet, right.legacyAgentPacket)) ||
    (left.legacyAgentPacket && right.legacyAgentPacket && packetMatches(left.legacyAgentPacket, right.legacyAgentPacket));
}

function sourceMatchesCaller(packet, source) {
  const packetSource = packet && typeof packet === 'object' ? packet.source : null;
  if (!packetSource || typeof packetSource !== 'object') return true;
  return packetSource.guildId === source.guildId && packetSource.provider === source.provider &&
    packetSource.nativeId === source.nativeId && packetSource.generation === source.generation;
}

function rowMatchesCaller(row, source, correlationId, requirePacketId = false) {
  const detail = row.detail;
  const packets = [detail.agentPacket, detail.legacyAgentPacket]
    .filter(packet => packet && typeof packet === 'object');
  const packetIdMatches = packets.some(packet => packet.id === correlationId);
  if (requirePacketId ? !packetIdMatches : detail.requestId !== correlationId && !packetIdMatches) return false;
  return detail.guildId === source.guildId && detail.provider === source.provider &&
    detail.nativeId === source.nativeId && detail.generation === source.generation &&
    (packets.length === 0 || packets.some(packet => sourceMatchesCaller(packet, source)));
}

function isLegacyParentTarget(state, target, frozenRequest) {
  const route = typeof state.getMessageRoute === 'function' ? state.getMessageRoute(target.channelId) : null;
  return Boolean(frozenRequest?.kind === KINDS.REQUEST && sameAddress(frozenRequest.target, target) &&
    route && !route.enrollment);
}

function packetMatchesRecordedIdentity(candidate, records) {
  return records.some(record => packetVariants(record.packet, record.legacyAgentPacket)
    .some(variant => packetMatches(candidate, variant)));
}

function deliveryEvidence(state, messageId, packet) {
  const message = state.getMessage(messageId);
  if (!message || message.nativeId !== packet.target.nativeId || message.provider !== packet.target.provider ||
      message.generation !== packet.target.generation || message.guildId !== packet.target.guildId ||
      (message.deliveryChannelId || message.channelId) !== packet.target.channelId) return null;
  const kind = packet.kind === KINDS.RESULT ? AGENT_COMPLETION_RECEIPTS.RESULT_CONSUMED : AGENT_COMPLETION_RECEIPTS.REQUEST_HANDLED_WITHOUT_POST;
  const completions = state.listAgentCompletionReceipts(messageId, kind);
  const completion = completions.find(row => {
    const detail = row.detail;
    return detail && detail.packetId === packet.id && detail.disposition === kind &&
      detail.nativeId === packet.target.nativeId && detail.provider === packet.target.provider &&
      detail.generation === packet.target.generation && sameAddress(detail.source, packet.source) && sameAddress(detail.target, packet.target);
  });
  return { messageId, state: message.state, nativeAcknowledged: state.hasNativeAcknowledgment(message),
    completed: message.state === MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST && Boolean(completion),
    completionReceiptId: completion?.id ?? null };
}

function inspectPeerResult(state, source, correlationId) {
  if (!validPeerId(correlationId)) throw new Error('invalid correlation_id');
  let rows = state.directPostRows(correlationId, source.channelId).filter(row => rowMatchesCaller(row, source, correlationId));
  if (rows.length === 0) {
    rows = state.directPostRows(null, source.channelId).filter(row => rowMatchesCaller(row, source, correlationId, true));
  }
  const records = rows.map(row => ({
    packet: row.detail.agentPacket,
    legacyAgentPacket: row.detail.legacyAgentPacket
  })).filter(record => record.packet);
  for (const record of records) {
    validateAgentMessage(record.packet);
    if (record.legacyAgentPacket) validateAgentMessage(record.legacyAgentPacket);
  }
  const canonicalRecord = records.at(-1);
  const packet = canonicalRecord?.packet;
  if (!packet) throw new Error('correlation is unknown for this caller');
  if (records.some(candidate => !packetRecordsMatch(candidate, canonicalRecord))) throw new Error('correlation has conflicting custody');
  const receipts = state.listAgentMessageReceiptIds(packet.id);
  const deliveries = [];
  const results = [];
  const seen = new Set();
  for (const discordId of receipts) {
    if (seen.has(discordId)) continue;
    seen.add(discordId);
    const candidate = state.getAgentMessage(discordId)?.packet;
    if (!candidate) continue;
    validateAgentMessage(candidate);
    const evidence = deliveryEvidence(state, discordId, candidate);
    if (!evidence) continue;
    if (packetMatchesRecordedIdentity(candidate, records)) deliveries.push(evidence);
    else if (packet.kind === KINDS.REQUEST && (candidate.kind === KINDS.RESULT && candidate.replyTo === packet.id &&
      sameAddress(candidate.source, packet.target) && sameAddress(candidate.target, packet.source) ||
      ((packet.routingVersion === undefined || canonicalRecord.legacyAgentPacket?.kind === KINDS.REQUEST) &&
        isLegacyParentTarget(state, packet.target, canonicalRecord.legacyAgentPacket) &&
        isLegacyChildResult(candidate, packet, packet.target, true)))) {
      results.push({ ...evidence, packetId: candidate.id, text: candidate.text });
    }
  }
  const projection = projectNewestDirectPostAttempt(rows, {
    attemptKind: DIRECT_POST_ATTEMPT,
    outcomeKind: DIRECT_POST_OUTCOME
  });
  const preflightIsCurrent = Boolean(projection.latestPreflight &&
    (!projection.attempt || projection.latestPreflight.id > projection.attempt.id) &&
    (!projection.outcome || projection.latestPreflight.id > projection.outcome.id));
  let sendOutcome = null;
  if (preflightIsCurrent) sendOutcome = projection.latestPreflight.detail.outcome ?? null;
  else if (projection.attempt) sendOutcome = projection.outcome ? projection.outcome.detail.outcome ?? null : 'in_flight';
  return { correlationId, sendOutcome, deliveries, results };
}

module.exports = { inspectPeerResult, validPeerId, PEER_PACKET_ID_SCHEMA };
