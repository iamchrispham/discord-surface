import { KINDS, sameAddress, validateAgentMessage, type AgentAddress, type AgentMessage } from '../agent-message';
import type { CompletionState, CompletionMessage, ErrorConstructor } from './agent-completion/contracts';
import { NATIVE_REPLY_FILE_PHASES } from './native-reply-file';

export const AGENT_WITHDRAWAL_RECEIPTS = Object.freeze({ REQUEST_WITHDRAWN: 'agent-request-withdrawn' } as const);

interface WithdrawalState extends CompletionState {
  getMessageRoute(channelId: string): { binding: AgentAddress & { active: boolean }; deliveryChannelId: string } | null;
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

function reverseResult(packet: AgentMessage, request: AgentMessage): boolean {
  return packet.kind === KINDS.RESULT && packet.replyTo === request.id &&
    sameOwner(packet.source, request.target) && sameAddress(packet.target, request.source);
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
    if (source && target && sameOwner(packet.source, target) && sameAddress(packet.target, source)) return detail;
  }
  return null;
}

function resultCustody(state: WithdrawalState, request: AgentMessage,
  parseJson: WithdrawalDependencies['parseJson']): boolean {
  const rows = state.db.prepare(`SELECT kind, detail FROM receipts
    WHERE kind IN ('agent-message', 'direct-post-attempt', 'direct-post-outcome')
      AND (json_extract(detail, '$.packet.replyTo')=?
        OR json_extract(detail, '$.agentPacket.replyTo')=?
        OR json_extract(detail, '$.legacyAgentPacket.replyTo')=?)`)
    .all(request.id, request.id, request.id);
  for (const row of rows) {
    const detail = parseJson(row.detail, null);
    for (const candidate of [detail?.packet, detail?.agentPacket, detail?.legacyAgentPacket]) {
      if (validPacket(candidate, KINDS.RESULT) && reverseResult(candidate, request)) return true;
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
      if (!message) throw new deps.BindingError('agent request is unknown');
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
      if (!route || !route.binding.active || route.deliveryChannelId !== packet.source.channelId ||
          !sameAddress({ guildId: route.binding.guildId, channelId: route.deliveryChannelId,
            provider: route.binding.provider, nativeId: route.binding.nativeId, generation: route.binding.generation }, packet.source) ||
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
      if (replyCustody(state, message) || resultCustody(state, packet, deps.parseJson)) {
        throw new deps.BindingError('agent request has reply or result custody');
      }
      const result = state.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
        .run(deps.MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST, deps.now(), messageId, deps.MESSAGE_STATES.SUBMITTED);
      if (Number(result.changes) !== 1) throw new deps.StateCorruptError('agent request changed concurrently');
      const detail = { packetId: packet.id, source: packet.source, target: packet.target,
        requester: { provider: input.provider, nativeId: input.nativeId, generation: input.generation },
        provenanceReceiptId: provenance[0]?.id };
      state.receipt(messageId, AGENT_WITHDRAWAL_RECEIPTS.REQUEST_WITHDRAWN, detail);
      return { withdrawn: true, duplicate: false, disposition: AGENT_WITHDRAWAL_RECEIPTS.REQUEST_WITHDRAWN,
        message: state.getMessage(messageId) };
    });
  }

  return { isAgentRequestWithdrawn, isAgentResultForWithdrawnRequest, withdrawAgentRequest };
}
