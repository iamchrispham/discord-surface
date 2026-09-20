import {
  isLegacyAgentAddressEnvelope,
  sameAddress,
  validateAgentMessage,
  verifyAgentAddress,
  verifyLegacyAgentAddress,
  KINDS,
  type AgentAddress,
  type AgentAddressEnvelope,
  type AgentMessage,
  type AgentMessageKind,
  type LegacyAgentAddressEnvelope
} from '../agent-message';
import type {
  DirectPostBinding,
  DirectPostOutcome,
  DirectPostPartStatus,
  DirectPostReceiptRow,
  DirectPostResult,
  DirectPostState
} from '../direct-post';

export const AGENT_ROUTING_VERSION = 2;

export function isLegacyAgentReceipt(detail: unknown): boolean {
  return Boolean(detail && typeof detail === 'object' && !Object.hasOwn(detail, 'routingVersion'));
}

function sameOwner(left: AgentAddress, right: AgentAddress): boolean {
  return sameAddress({ ...left, channelId: right.channelId }, right);
}

export function isAgentSourcePromotion(original: unknown, packet: unknown, parentChannelId: string): original is AgentMessage {
  try { validateAgentMessage(original); validateAgentMessage(packet); }
  catch { return false; }
  const parentPromotion = original.source.channelId === parentChannelId;
  const childMetadataUpgrade = original.kind === KINDS.RESULT && original.routingVersion === undefined &&
    sameAddress(original.source, packet.source) && packet.routingVersion === AGENT_ROUTING_VERSION &&
    packet.sourceParentChannelId === parentChannelId;
  return (parentPromotion || childMetadataUpgrade) && packet.source.channelId !== parentChannelId &&
    sameOwner(packet.source, original.source) && sameAddress(packet.target, original.target) &&
    packet.id === original.id && packet.kind === original.kind && packet.replyTo === original.replyTo && packet.text === original.text;
}

export function isLegacyChildResult(packet: AgentMessage, request: AgentMessage, requestTarget: unknown,
  childRouteProven = false): boolean {
  return childRouteProven && packet.kind === KINDS.RESULT && packet.replyTo === request.id && sameAddress(packet.target, request.source) &&
    sameAddress(requestTarget, request.target) && packet.source.channelId !== request.target.channelId &&
    sameOwner(packet.source, request.target);
}

type BindingErrorConstructor = new (message?: string) => Error;

export interface LegacyParentSourcedReceipt {
  attempt: Record<string, unknown>;
  detail: Record<string, unknown>;
  packet: AgentMessage;
  outcome: DirectPostOutcome;
  result: DirectPostResult;
}

const ADDRESS_KEYS = Object.freeze(['guildId', 'channelId', 'provider', 'nativeId', 'generation'] as const);

function persistedBindingMatches(detail: Record<string, unknown>, binding: DirectPostBinding): boolean {
  const persisted = detail.binding;
  const authority = persisted && typeof persisted === 'object' && !Array.isArray(persisted)
    ? persisted as Record<string, unknown>
    : detail;
  return ADDRESS_KEYS.every(key => authority[key] === binding[key]) &&
    (authority.conductorId ?? null) === (binding.conductorId ?? null) &&
    (authority.repoKey ?? null) === (binding.repoKey ?? null);
}

function persistedChildParentMatches(detail: Record<string, unknown>, parent: AgentAddress): boolean {
  const childParent = detail.agentRequestTarget;
  if (childParent === undefined || childParent === null) return true;
  return Boolean(childParent && typeof childParent === 'object' && !Array.isArray(childParent) &&
    sameAddress(childParent, parent));
}

function canonicalAddress(address: DirectPostBinding | AgentAddress): AgentAddress {
  return Object.fromEntries(ADDRESS_KEYS.map(key => [key, address[key]])) as unknown as AgentAddress;
}

function requiredString(value: unknown, name: string, max: number, BindingError: BindingErrorConstructor): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BindingError(`${name} must be a non-empty string`);
  }
  return value;
}

function receiptDetail(row: DirectPostReceiptRow): Record<string, unknown> | null {
  const raw: unknown = row.detail;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  try {
    const detail: unknown = JSON.parse(raw);
    return detail && typeof detail === 'object' && !Array.isArray(detail)
      ? detail as Record<string, unknown>
      : null;
  } catch { return null; }
}

export function legacyParentSourcedReceipt(state: DirectPostState, binding: DirectPostBinding, requestId: string,
  validOutcomes: readonly DirectPostOutcome[], allowLegacyChildRoute = false): LegacyParentSourcedReceipt | null {
  const rows = state.directPostRows(requestId);
  const attempts = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (row.kind !== 'direct-post-attempt') continue;
    const detail = receiptDetail(row);
    const attemptId = detail?.attemptId;
    if (detail?.requestId !== requestId || typeof attemptId !== 'string') continue;
    attempts.set(attemptId, detail);
  }
  const latestOutcomes = new Map<string, { row: DirectPostReceiptRow; detail: Record<string, unknown> }>();
  const preflightOutcomes: Array<{ row: DirectPostReceiptRow; detail: Record<string, unknown> }> = [];
  for (const row of rows) {
    if (row.kind !== 'direct-post-outcome') continue;
    const detail = receiptDetail(row);
    const outcome = detail?.outcome;
    const attemptId = detail?.attemptId;
    if (detail?.requestId !== requestId || !validOutcomes.includes(outcome as DirectPostOutcome)) continue;
    if (typeof attemptId === 'string') latestOutcomes.set(attemptId, { row, detail });
    else preflightOutcomes.push({ row, detail });
  }
  const parent = canonicalAddress(binding);
  const candidates = [...latestOutcomes.values(), ...preflightOutcomes]
    .sort((left, right) => {
      const leftAttemptBacked = typeof left.detail.attemptId === 'string' &&
        (left.detail.outcome === 'sent' || left.detail.outcome === 'unknown') ? 1 : 0;
      const rightAttemptBacked = typeof right.detail.attemptId === 'string' &&
        (right.detail.outcome === 'sent' || right.detail.outcome === 'unknown') ? 1 : 0;
      return rightAttemptBacked - leftAttemptBacked || (right.row.id || 0) - (left.row.id || 0);
    });
  for (const candidate of candidates) {
    const detail = candidate.detail;
    const outcome = detail.outcome as DirectPostOutcome;
    const attemptId = typeof detail.attemptId === 'string' ? detail.attemptId : null;
    const attempt = attemptId ? attempts.get(attemptId) : detail;
    const attemptPacket = attempt?.legacyAgentPacket ?? attempt?.agentPacket;
    const packet = detail.legacyAgentPacket ?? detail.agentPacket ?? attemptPacket;
    if (!attempt || !attemptPacket || !packet || typeof attemptPacket !== 'object' || typeof packet !== 'object') continue;
    const attemptSource = (attemptPacket as Record<string, unknown>).source;
    const packetSource = (packet as Record<string, unknown>).source;
    const legacyReceipt = isLegacyAgentReceipt(attempt) && isLegacyAgentReceipt(detail);
    const parentSourced = legacyReceipt && sameAddress(attemptSource, parent) && sameAddress(packetSource, parent);
    const childSourced = allowLegacyChildRoute && legacyReceipt &&
      sameAddress(attemptSource, packetSource) && !sameAddress(packetSource, parent) &&
      persistedBindingMatches(attempt, binding) && persistedBindingMatches(detail, binding) &&
      persistedChildParentMatches(attempt, parent) && persistedChildParentMatches(detail, parent);
    if ((!parentSourced && !childSourced) ||
        !sameAddress((packet as Record<string, unknown>).target, (attemptPacket as Record<string, unknown>).target)) continue;
    const target = (packet as Record<string, unknown>).target as AgentAddress;
    const partIndex = Number.isSafeInteger(detail.partIndex) ? detail.partIndex as number : 0;
    const messageId = typeof detail.messageId === 'string' && detail.messageId.length > 0 ? detail.messageId : null;
    const status = outcome as DirectPostPartStatus;
    return {
      attempt,
      detail,
      packet: packet as AgentMessage,
      outcome,
      result: {
        requestId,
        dedupeKey: requestId,
        inReplyTo: typeof detail.inReplyTo === 'string' ? detail.inReplyTo : null,
        channelId: target.channelId,
        provider: binding.provider,
        nativeId: binding.nativeId,
        generation: binding.generation,
        status,
        state: status,
        recorded: false,
        duplicate: status === 'sent',
        messageIds: messageId ? [messageId] : [],
        parts: [{ index: partIndex, status, messageId }]
      }
    };
  }
  return null;
}

export function isLegacyRetryableOutcome(outcome: DirectPostOutcome): boolean {
  return outcome === 'not_sent';
}

function legacyAgentTarget(agentTarget: AgentAddress | AgentAddressEnvelope | LegacyAgentAddressEnvelope | null, token: string,
  requireProof: boolean, verifyLegacyProof: boolean): AgentAddress | null {
  if (agentTarget === null) return null;
  if (isLegacyAgentAddressEnvelope(agentTarget)) {
    return verifyLegacyProof ? verifyLegacyAgentAddress(agentTarget, token) : agentTarget.address;
  }
  const hasProof = typeof agentTarget === 'object' && Object.hasOwn(agentTarget, 'proof');
  if (hasProof || requireProof) return verifyAgentAddress(agentTarget, token);
  return agentTarget as AgentAddress;
}

export function resolveAgentReplyRequest(state: DirectPostState, replyTo: string, source: AgentAddress,
  target: AgentAddress | null = null, legacyParent: AgentAddress | null = null,
  BindingError: BindingErrorConstructor, requireLegacy = false): AgentMessage {
  const rows = state.listReceipts();
  const candidates = rows
    .filter(row => row.kind === 'agent-message')
    .map(row => {
      try {
        const detail: unknown = JSON.parse(row.detail);
        const packet = detail && typeof detail === 'object' ? (detail as Record<string, unknown>).packet || null : null;
        return packet ? { packet: packet as Record<string, unknown>, discordId: row.discord_id, legacy: isLegacyAgentReceipt(detail) } : null;
      } catch { return null; }
    })
    .filter((candidate): candidate is { packet: Record<string, unknown>; discordId: string | null; legacy: boolean } => candidate !== null &&
      candidate.packet.kind === KINDS.REQUEST &&
      (!requireLegacy || candidate.legacy) &&
      (target === null || sameAddress(candidate.packet.source, target)) &&
      (sameAddress(candidate.packet.target, source) || (legacyParent !== null && candidate.legacy &&
        sameAddress(candidate.packet.target, legacyParent))));
  const identified = candidates.filter(candidate => candidate.discordId === replyTo || candidate.packet.id === replyTo);
  if (identified.length !== 1) throw new BindingError('agent reply target is unknown or does not match the active request');
  const match = identified[0];
  if (!match) throw new BindingError('agent reply target is unknown or does not match the active request');
  return match.packet as unknown as AgentMessage;
}

export function assertLegacyParentSourcedIdentity({ state, binding, token, requestId, packet, sourceText, agentKind,
  agentTarget, agentReplyTo, sourceAddress = null, allowRecordedTarget = false, verifyLegacyProof = false, BindingError }:
  { state: DirectPostState; binding: DirectPostBinding; token: string; requestId: string; packet: AgentMessage; sourceText: string;
    agentKind: AgentMessageKind; agentTarget: AgentAddress | AgentAddressEnvelope | LegacyAgentAddressEnvelope | null; agentReplyTo: string | null;
    sourceAddress?: AgentAddress | null; allowRecordedTarget?: boolean; verifyLegacyProof?: boolean; BindingError: BindingErrorConstructor;
  }): void {
  const parent = canonicalAddress(binding);
  const expectedSource = sourceAddress ?? parent;
  if (packet.id !== requestId || !sameAddress(packet.source, expectedSource) || packet.kind !== agentKind || packet.text !== sourceText) {
    throw new BindingError('direct post request identity conflicts with existing custody');
  }
  const requestedTarget = legacyAgentTarget(agentTarget, token, agentKind === KINDS.REQUEST, verifyLegacyProof);
  const expectedTarget = requestedTarget ?? (allowRecordedTarget ? packet.target : null);
  if (expectedTarget !== null && !sameAddress(packet.target, expectedTarget)) {
    throw new BindingError('direct post request identity conflicts with existing custody');
  }
  if (agentKind === KINDS.REQUEST) {
    if (packet.replyTo !== null || expectedTarget === null) {
      throw new BindingError('direct post request identity conflicts with existing custody');
    }
  } else {
    try {
      const replyTo = requiredString(agentReplyTo, 'agent-reply-to', 128, BindingError);
      const request = resolveAgentReplyRequest(state, replyTo, expectedSource, expectedTarget, parent, BindingError);
      if (packet.replyTo !== request.id || !sameAddress(packet.target, request.source)) {
        throw new BindingError('direct post request identity conflicts with existing custody');
      }
    } catch (error) {
      if (error instanceof BindingError && error.message === 'direct post request identity conflicts with existing custody') throw error;
      throw new BindingError('direct post request identity conflicts with existing custody');
    }
  }
}
