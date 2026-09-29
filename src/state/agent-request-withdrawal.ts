import { KINDS, sameAddress, validateAgentMessage, type AgentAddress, type AgentMessage } from '../agent-message';
import type { CompletionState, CompletionMessage, ErrorConstructor } from './agent-completion/contracts';
import { NATIVE_REPLY_FILE_PHASES } from './native-reply-file';
import { AGENT_ROUTING_VERSION } from './agent-routing';

export const AGENT_WITHDRAWAL_RECEIPTS = Object.freeze({ REQUEST_WITHDRAWN: 'agent-request-withdrawn' } as const);

interface WithdrawalState extends CompletionState {
  getMessageRoute(channelId: string): { binding: AgentAddress & { active: boolean; sessionRoot?: string | null }; deliveryChannelId: string } | null;
}

interface WithdrawalInput {
  messageId: string;
  packetId: string;
  provider: string;
  nativeId: string;
  generation: number;
}

interface WithdrawalDependencies {
  MESSAGE_STATES: Readonly<{ SUBMITTED: string; AGENT_HANDLED_WITHOUT_POST: string }>;
  assertText(value: unknown, name: string, max?: number): string;
  assertProvider(value: unknown): string;
  assertUuid(value: unknown, name?: string): string;
  parseJson(value: unknown, fallback: null): Record<string, unknown> | null;
  now(): string;
  AuthorizationError: ErrorConstructor;
  BindingError: ErrorConstructor;
  StaleGenerationError: ErrorConstructor;
  StateCorruptError: ErrorConstructor;
}

function validPacket(value: unknown, kind: string): value is AgentMessage {
  try { validateAgentMessage(value); }
  catch { return false; }
  return value.kind === kind;
}

function sameOwner(left: AgentAddress, right: unknown): boolean {
  if (!right || typeof right !== 'object' || Array.isArray(right) ||
      typeof (right as AgentAddress).channelId !== 'string') return false;
  return sameAddress({ ...left, channelId: (right as AgentAddress).channelId }, right);
}

function sourceRouteMatches(route: ReturnType<WithdrawalState['getMessageRoute']>, source: AgentAddress): boolean {
  return Boolean(route?.binding.active && route.deliveryChannelId === source.channelId &&
    sameAddress({ guildId: route.binding.guildId, channelId: route.deliveryChannelId,
      provider: route.binding.provider, nativeId: route.binding.nativeId, generation: route.binding.generation }, source));
}

function resultSourceMatches(source: AgentAddress, target: AgentAddress, routingVersion: unknown,
  frozenChildRoute: string | null = null, allowRouteLessParent = false, recordedTarget: unknown = null): boolean {
  if (frozenChildRoute) return sameAddress(source, { ...target, channelId: frozenChildRoute });
  if (routingVersion !== AGENT_ROUTING_VERSION) return sameOwner(source, target);
  return sameAddress(source, target) ||
    (allowRouteLessParent && recordedTarget !== null && sameAddress(recordedTarget, target) && sameOwner(source, target));
}

function hasUniqueRequestTargetEvidence(state: WithdrawalState, request: AgentMessage,
  parseJson: WithdrawalDependencies['parseJson']): boolean {
  const rows = state.db.prepare(`SELECT detail FROM receipts
    WHERE kind='agent-message' AND json_extract(detail, '$.packet.id')=?`).all(request.id);
  const targets: AgentAddress[] = [];
  for (const row of rows) {
    const packet = parseJson(row.detail, null)?.packet;
    if (!validPacket(packet, KINDS.REQUEST) || !sameAddress(packet.source, request.source)) continue;
    if (!targets.some(target => sameAddress(target, packet.target))) targets.push(packet.target);
    if (targets.length > 1) return false;
  }
  return targets.length === 1 && sameAddress(targets[0], request.target);
}

function reverseResult(packet: AgentMessage, request: AgentMessage, routingVersion: unknown,
  frozenChildRoute: string | null = null, allowRouteLessParent = false, recordedTarget: unknown = null): boolean {
  return packet.kind === KINDS.RESULT && packet.replyTo === request.id &&
    resultSourceMatches(packet.source, request.target, routingVersion, frozenChildRoute, allowRouteLessParent, recordedTarget) &&
    sameAddress(packet.target, request.source);
}

function withdrawnRequestForResult(state: WithdrawalState, packet: AgentMessage,
  parseJson: WithdrawalDependencies['parseJson']): Record<string, unknown> | null {
  if (packet.kind !== KINDS.RESULT || !packet.replyTo) return null;
  const rows = state.db.prepare(`SELECT detail FROM receipts
    WHERE kind=? AND json_extract(detail, '$.packetId')=? ORDER BY id DESC`)
    .all(AGENT_WITHDRAWAL_RECEIPTS.REQUEST_WITHDRAWN, packet.replyTo);
  for (const row of rows) {
    const detail = parseJson(row.detail, null);
    const source = detail?.source;
    const target = detail?.target;
    const frozenChildRoute = typeof detail?.frozenChildRoute === 'string' ? detail.frozenChildRoute : null;
    if (source && target && resultSourceMatches(packet.source, target as AgentAddress, detail.routingVersion, frozenChildRoute) &&
        sameAddress(packet.target, source)) return detail;
  }
  return null;
}

function resultCustody(state: WithdrawalState, request: AgentMessage, routingVersion: unknown,
  parseJson: WithdrawalDependencies['parseJson'], frozenChildRoute: string | null = null,
  allowRouteLessParent = false): boolean {
  const rows = state.db.prepare(`SELECT kind, detail FROM receipts
    WHERE kind IN ('agent-message', 'direct-post-attempt', 'direct-post-outcome')
      AND (json_extract(detail, '$.packet.replyTo')=?
        OR json_extract(detail, '$.agentPacket.replyTo')=?
        OR json_extract(detail, '$.legacyAgentPacket.replyTo')=?)`)
    .all(request.id, request.id, request.id);
  for (const row of rows) {
    const detail = parseJson(row.detail, null);
    for (const { packet: candidate, recordedTarget } of [
      { packet: detail?.packet, recordedTarget: null },
      { packet: detail?.agentPacket,
        recordedTarget: detail?.agentRequestTarget ?? (allowRouteLessParent && row.kind !== 'agent-message' ? request.target : null) },
      { packet: detail?.legacyAgentPacket,
        recordedTarget: detail?.agentRequestTarget ?? (allowRouteLessParent && row.kind !== 'agent-message' ? request.target : null) }
    ]) {
      if (validPacket(candidate, KINDS.RESULT) && reverseResult(candidate, request, routingVersion,
        frozenChildRoute, allowRouteLessParent, recordedTarget)) return true;
    }
  }
  return false;
}

function replyCustody(state: WithdrawalState, message: CompletionMessage): boolean {
  if (message.replyText != null || message.replyNonce != null || message.replyMessageId != null ||
      message.replyNextPart > 0 || state.listReplyParts(message.id).length > 0) return true;
  const file = state.nativeReplyFilePreparation(message.id);
  return file?.phase === NATIVE_REPLY_FILE_PHASES.PREPARING || file?.phase === NATIVE_REPLY_FILE_PHASES.ADMITTED;
}

export function createAgentRequestWithdrawalHandlers(deps: WithdrawalDependencies) {
  function requesterSessionRoot(state: WithdrawalState, messageId: string, packetId: string): string | undefined {
    const rows = state.db.prepare("SELECT detail FROM receipts WHERE discord_id=? AND kind='agent-message' ORDER BY id")
      .all(messageId);
    if (rows.length !== 1) return undefined;
    const packet = deps.parseJson(rows[0].detail, null)?.packet;
    if (!validPacket(packet, KINDS.REQUEST) || packet.id !== packetId) return undefined;
    const route = state.getMessageRoute(packet.source.channelId);
    return sourceRouteMatches(route, packet.source) ? route?.binding.sessionRoot || undefined : undefined;
  }

  function isAgentResultForWithdrawnRequest(state: WithdrawalState, packet: AgentMessage): boolean {
    return withdrawnRequestForResult(state, packet, deps.parseJson) !== null;
  }

  function isAgentRequestWithdrawn(state: WithdrawalState, request: AgentMessage): boolean {
    const rows = state.db.prepare(`SELECT detail FROM receipts
      WHERE kind=? AND json_extract(detail, '$.packetId')=?`)
      .all(AGENT_WITHDRAWAL_RECEIPTS.REQUEST_WITHDRAWN, request.id);
    return rows.some(row => {
      const detail = deps.parseJson(row.detail, null);
      return detail && sameAddress(detail.source, request.source) && sameAddress(detail.target, request.target);
    });
  }

  function withdrawAgentRequest(state: WithdrawalState, input: WithdrawalInput): Record<string, unknown> {
    const messageId = deps.assertText(input.messageId, 'messageId', 128);
    const packetId = deps.assertText(input.packetId, 'packetId', 128);
    deps.assertProvider(input.provider);
    deps.assertUuid(input.nativeId);
    if (!Number.isInteger(input.generation) || input.generation < 1) {
      throw new deps.StaleGenerationError('invalid requester generation');
    }
    return state.transaction(() => {
      const message = state.getMessage(messageId);
      if (!message) throw new deps.BindingError('agent request is unknown in this state database');
      const provenance = state.db.prepare(`SELECT id, detail FROM receipts
        WHERE discord_id=? AND kind='agent-message' ORDER BY id`).all(messageId);
      if (provenance.length !== 1) throw new deps.AuthorizationError('authenticated agent request provenance is missing or ambiguous');
      const original = deps.parseJson(provenance[0]?.detail, null);
      const packet = original?.packet;
      if (!validPacket(packet, KINDS.REQUEST) || original?.authorId !== (message as CompletionMessage & { authorId?: string }).authorId) {
        throw new deps.AuthorizationError('authenticated agent request provenance is missing');
      }
      if (packet.id !== packetId) throw new deps.AuthorizationError('agent request packet identity does not match');
      const target: AgentAddress = {
        guildId: message.guildId,
        channelId: message.deliveryChannelId || message.channelId,
        provider: message.provider as AgentAddress['provider'],
        nativeId: message.nativeId,
        generation: message.generation
      };
      if (!sameAddress(packet.target, target)) throw new deps.StateCorruptError('agent request target differs from accepted custody');
      const route = state.getMessageRoute(packet.source.channelId);
      if (!sourceRouteMatches(route, packet.source) ||
          input.provider !== packet.source.provider || input.nativeId !== packet.source.nativeId ||
          input.generation !== packet.source.generation) {
        throw new deps.StaleGenerationError('agent request requester is no longer current');
      }
      const prior = state.db.prepare(`SELECT id, detail FROM receipts WHERE discord_id=? AND kind=? ORDER BY id`)
        .all(messageId, AGENT_WITHDRAWAL_RECEIPTS.REQUEST_WITHDRAWN);
      if (message.state === deps.MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST && prior.length === 1) {
        const detail = deps.parseJson(prior[0]?.detail, null);
        if (detail?.packetId === packet.id && sameAddress(detail.source, packet.source) &&
            sameAddress(detail.target, packet.target)) {
          return { withdrawn: false, duplicate: true, disposition: AGENT_WITHDRAWAL_RECEIPTS.REQUEST_WITHDRAWN,
            receiptId: prior[0]?.id, message };
        }
      }
      if (prior.length) throw new deps.StateCorruptError('withdrawal receipt conflicts with message state');
      if (message.state !== deps.MESSAGE_STATES.SUBMITTED) {
        throw new deps.BindingError(`agent request withdrawal requires submitted state, got ${message.state}`);
      }
      if (!state.hasNativeAcknowledgment(message)) throw new deps.BindingError('agent request withdrawal requires native acknowledgment');
      const routingVersion = original?.routingVersion === AGENT_ROUTING_VERSION ? AGENT_ROUTING_VERSION : null;
      const allowRouteLessParent = packet.target.channelId === message.channelId &&
        hasUniqueRequestTargetEvidence(state, packet, deps.parseJson);
      if (replyCustody(state, message) ||
          resultCustody(state, packet, routingVersion, deps.parseJson, message.agentRoute || null, allowRouteLessParent)) {
        throw new deps.BindingError('agent request has reply or result custody');
      }
      const result = state.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
        .run(deps.MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST, deps.now(), messageId, deps.MESSAGE_STATES.SUBMITTED);
      if (Number(result.changes) !== 1) throw new deps.StateCorruptError('agent request changed concurrently');
      const detail = { packetId: packet.id, source: packet.source, target: packet.target,
        routingVersion,
        ...(message.agentRoute ? { frozenChildRoute: message.agentRoute } : {}),
        requester: { provider: input.provider, nativeId: input.nativeId, generation: input.generation },
        provenanceReceiptId: provenance[0]?.id };
      state.receipt(messageId, AGENT_WITHDRAWAL_RECEIPTS.REQUEST_WITHDRAWN, detail);
      return { withdrawn: true, duplicate: false, disposition: AGENT_WITHDRAWAL_RECEIPTS.REQUEST_WITHDRAWN,
        message: state.getMessage(messageId) };
    });
  }

  return { isAgentRequestWithdrawn, isAgentResultForWithdrawnRequest, requesterSessionRoot, withdrawAgentRequest };
}
