import {
  KINDS,
  sameAddress,
  validateAgentMessage,
  type AgentAddress,
  type AgentMessage
} from '../agent-message';
import {
  querySentAgentResultRows,
  type DirectPostReceiptDetail,
  type SentAgentResultRow
} from './direct-post';

interface SqlRow {
  [key: string]: unknown;
}

interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...parameters: unknown[]): T[];
  get<T extends SqlRow = SqlRow>(...parameters: unknown[]): T | undefined;
  run(...parameters: unknown[]): { changes?: number };
}

interface CompletionDatabase {
  prepare(sql: string): SqlStatement;
}

interface CompletionMessage {
  id: string;
  guildId: string;
  channelId: string;
  deliveryChannelId?: string | null;
  provider: string;
  nativeId: string;
  generation: number;
  state: string;
  replyText?: string | null;
  replyNonce?: string | null;
  replyMessageId?: string | null;
  replyNextPart: number;
  decisionResult?: unknown;
}

interface CompletionBinding extends AgentAddress {
  active: boolean;
}

interface MessageBindingCheck {
  binding: CompletionBinding | null;
  identity: boolean;
  current: boolean;
  deliveryChannelId: string;
}

interface AgentMessageProvenance {
  packet?: unknown;
}

interface CompletionState {
  db: CompletionDatabase;
  transaction<T>(operation: () => T): T;
  getMessage(messageId: string): CompletionMessage | null;
  nativeReplyFilePreparation(messageId: string): { phase: string } | null;
  isInteractionMessage(messageId: string): boolean;
  getAgentMessage(messageId: string): AgentMessageProvenance | null;
  currentMessageBinding(message: CompletionMessage): MessageBindingCheck;
  hasNativeAcknowledgment(message: CompletionMessage): boolean;
  listReplyParts(messageId: string): unknown[];
  receipt(discordId: string, kind: string, detail: Record<string, unknown>): void;
}

interface ErrorConstructor {
  new (message: string): Error;
}

export interface AgentCompletionDependencies {
  AGENT_COMPLETION_RECEIPTS: Readonly<{
    RESULT_CONSUMED: string;
    REQUEST_HANDLED_WITHOUT_POST: string;
  }>;
  MESSAGE_STATES: Readonly<{
    SUBMITTED: string;
    AGENT_HANDLED_WITHOUT_POST: string;
  }>;
  DIRECT_POST_ATTEMPT: string;
  DIRECT_POST_OUTCOME: string;
  NATIVE_REPLY_FILE_PHASES: typeof import('./native-reply-file').NATIVE_REPLY_FILE_PHASES;
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

export interface AgentCompletionInput {
  messageId: string;
  provider: string;
  nativeId: string;
  generation: number;
  channelId?: string | null;
}

interface CompletionReceiptRow extends SqlRow {
  id: number;
  kind: string;
  detail: unknown;
}

function validAgentPacket(packet: unknown, expectedKind: string | null = null): packet is AgentMessage {
  try { validateAgentMessage(packet); }
  catch { return false; }
  return expectedKind === null || packet.kind === expectedKind;
}

function sameAgentPacket(left: unknown, right: unknown): boolean {
  if (!validAgentPacket(left) || !validAgentPacket(right) || left.kind !== right.kind || left.id !== right.id ||
      left.replyTo !== right.replyTo || !sameAddress(left.source, right.source) || !sameAddress(left.target, right.target)) return false;
  return left.text === right.text;
}

function agentPacketEvidence(packet: AgentMessage): Record<string, unknown> {
  return {
    packetId: packet.id,
    replyTo: packet.replyTo,
    source: packet.source,
    target: packet.target
  };
}

function sameReverseAddresses(candidate: AgentMessage, request: AgentMessage): boolean {
  return candidate.replyTo === request.id && sameAddress(candidate.source, request.target) &&
    sameAddress(candidate.target, request.source);
}

function receivedResultEvidence(
  state: CompletionState,
  messageId: string,
  packet: AgentMessage
): Record<string, unknown> | null {
  const row = state.db.prepare("SELECT id FROM receipts WHERE discord_id=? AND kind='agent-message' ORDER BY id LIMIT 1")
    .get(messageId) as { id?: number } | undefined;
  if (!row || !Number.isSafeInteger(row.id)) return null;
  return {
    kind: 'received-result',
    receiptId: Number(row.id),
    discordId: messageId,
    ...agentPacketEvidence(packet)
  };
}

function receivedReplyEvidence(
  state: CompletionState,
  request: AgentMessage,
  deps: AgentCompletionDependencies
): Record<string, unknown> | null {
  const candidateRow = state.db.prepare(`SELECT id, discord_id, detail FROM receipts
    WHERE kind='agent-message' AND json_extract(detail, '$.packet.kind')=?
      AND json_extract(detail, '$.packet.replyTo')=?
      AND json_extract(detail, '$.packet.source.guildId')=?
      AND json_extract(detail, '$.packet.source.channelId')=?
      AND json_extract(detail, '$.packet.source.provider')=?
      AND json_extract(detail, '$.packet.source.nativeId')=?
      AND json_extract(detail, '$.packet.source.generation')=?
      AND json_extract(detail, '$.packet.target.guildId')=?
      AND json_extract(detail, '$.packet.target.channelId')=?
      AND json_extract(detail, '$.packet.target.provider')=?
      AND json_extract(detail, '$.packet.target.nativeId')=?
      AND json_extract(detail, '$.packet.target.generation')=?
    ORDER BY id LIMIT 1`).get(
    KINDS.RESULT, request.id,
    request.target.guildId, request.target.channelId, request.target.provider, request.target.nativeId, request.target.generation,
    request.source.guildId, request.source.channelId, request.source.provider, request.source.nativeId, request.source.generation
  ) as { id?: number; discord_id?: unknown; detail?: unknown } | undefined;
  if (!candidateRow || typeof candidateRow.discord_id !== 'string' || !candidateRow.discord_id || !Number.isSafeInteger(candidateRow.id)) return null;
  const detail = deps.parseJson(candidateRow.detail, null);
  const candidate = detail?.packet;
  if (!validAgentPacket(candidate, KINDS.RESULT) || !sameReverseAddresses(candidate, request)) return null;
  return {
    kind: 'received-result',
    receiptId: Number(candidateRow.id),
    discordId: candidateRow.discord_id,
    ...agentPacketEvidence(candidate)
  };
}

function sentReplyEvidence(
  state: CompletionState,
  request: AgentMessage,
  channelId: string,
  deps: AgentCompletionDependencies
): Record<string, unknown> | null {
  const rows: SentAgentResultRow[] = querySentAgentResultRows({
    db: state.db,
    parseJson: deps.parseJson,
    StateCorruptError: deps.StateCorruptError,
    assertText: deps.assertText,
    attemptKind: deps.DIRECT_POST_ATTEMPT,
    outcomeKind: deps.DIRECT_POST_OUTCOME
  }, request, channelId);
  for (const row of rows) {
    const attemptPacket = row.attemptDetail.agentPacket;
    const candidate = row.outcomeDetail.agentPacket;
    if (!validAgentPacket(attemptPacket, KINDS.RESULT) || !validAgentPacket(candidate, KINDS.RESULT) ||
        !sameAgentPacket(candidate, attemptPacket) || !sameReverseAddresses(candidate, request)) continue;
    return {
      kind: 'sent-result',
      attemptReceiptId: row.attemptReceiptId,
      outcomeReceiptId: row.outcomeReceiptId,
      ...(row.messageId ? { messageId: row.messageId } : {}),
      ...(row.nonce ? { nonce: row.nonce } : {}),
      ...agentPacketEvidence(candidate)
    };
  }
  return null;
}

export function createAgentCompletionHandlers(deps: AgentCompletionDependencies) {
  function completeAgentHandledWithoutPost(
    state: CompletionState,
    { messageId, provider, nativeId, generation, channelId = null }: AgentCompletionInput
  ): Record<string, unknown> {
    deps.assertText(messageId, 'messageId', 128);
    deps.assertProvider(provider);
    deps.assertUuid(nativeId);
    if (!Number.isInteger(generation) || generation < 1) throw new deps.StaleGenerationError('invalid generation');
    if (channelId !== null) deps.assertText(channelId, 'channelId', 128);
    return state.transaction(() => {
      const message = state.getMessage(messageId);
      if (!message) throw new deps.BindingError('message is unknown');
      if (message.provider !== provider || message.nativeId !== nativeId || message.generation !== generation) {
        throw new deps.StaleGenerationError('agent completion identity is stale');
      }
      if (state.isInteractionMessage(messageId) || message.decisionResult) {
        throw new deps.BindingError('agent completion does not apply to interaction or decision messages');
      }
      const provenance = state.getAgentMessage(messageId);
      const packet = provenance?.packet;
      if (!validAgentPacket(packet)) throw new deps.AuthorizationError('authenticated agent message provenance is missing');
      const disposition = packet.kind === KINDS.RESULT
        ? deps.AGENT_COMPLETION_RECEIPTS.RESULT_CONSUMED
        : deps.AGENT_COMPLETION_RECEIPTS.REQUEST_HANDLED_WITHOUT_POST;
      const check = state.currentMessageBinding(message);
      if (!check.identity) throw new deps.StaleGenerationError('agent completion route is stale');
      if (!check.current) throw new deps.AuthorizationError('agent completion owner is no longer current');
      if (channelId !== null && channelId !== message.channelId && channelId !== check.deliveryChannelId) {
        throw new deps.BindingError('agent completion channel does not match the current route');
      }
      const binding = check.binding;
      if (!binding) throw new deps.StateCorruptError('agent completion current binding is missing');
      const target = {
        guildId: binding.guildId,
        channelId: check.deliveryChannelId || message.deliveryChannelId || message.channelId,
        provider: binding.provider,
        nativeId: binding.nativeId,
        generation: binding.generation
      };
      if (!sameAddress(packet.target, target)) throw new deps.StaleGenerationError('agent completion target is stale');
      if (!state.hasNativeAcknowledgment(message)) throw new deps.BindingError('agent completion requires a matching native acknowledgment');
      if ((message.replyText !== null && message.replyText !== undefined) ||
          (message.replyNonce !== null && message.replyNonce !== undefined) ||
          (message.replyMessageId !== null && message.replyMessageId !== undefined) ||
          message.replyNextPart > 0 || state.listReplyParts(messageId).length > 0) {
        throw new deps.BindingError('agent completion requires empty reply custody');
      }
      const filePreparation = state.nativeReplyFilePreparation(messageId);
      if (filePreparation?.phase === deps.NATIVE_REPLY_FILE_PHASES.PREPARING ||
          filePreparation?.phase === deps.NATIVE_REPLY_FILE_PHASES.ADMITTED) {
        throw new deps.BindingError('agent completion requires native reply file custody to be recorded or explicitly released');
      }
      const completionRows = state.db.prepare(`SELECT id, kind, detail FROM receipts
        WHERE discord_id=? AND kind IN (?, ?) ORDER BY id DESC`).all(
        messageId, deps.AGENT_COMPLETION_RECEIPTS.RESULT_CONSUMED, deps.AGENT_COMPLETION_RECEIPTS.REQUEST_HANDLED_WITHOUT_POST
      ) as CompletionReceiptRow[];
      const previous = completionRows
        .map(row => ({ ...row, detail: deps.parseJson(row.detail, null) }))
        .find(row => row.detail && row.detail.disposition === disposition && row.detail.provider === provider &&
          row.detail.nativeId === nativeId && row.detail.generation === generation && row.detail.packetId === packet.id);
      if (message.state === deps.MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST) {
        if (previous) {
          return {
            completed: false,
            duplicate: true,
            disposition,
            receiptId: Number(previous.id),
            message,
            evidence: previous.detail?.evidence || null
          };
        }
        throw new deps.BindingError('agent message is already finalized');
      }
      if (completionRows.length) throw new deps.StateCorruptError('agent completion receipt exists before terminal state');
      if (message.state !== deps.MESSAGE_STATES.SUBMITTED) {
        throw new deps.BindingError(`agent completion requires submitted state, got ${message.state}`);
      }

      let evidence: Record<string, unknown> | null = null;
      if (packet.kind === KINDS.RESULT) {
        evidence = receivedResultEvidence(state, messageId, packet);
      } else {
        evidence = receivedReplyEvidence(state, packet, deps) || sentReplyEvidence(state, packet, message.channelId, deps);
        if (!evidence) throw new deps.BindingError('agent request lacks an immutable correlated result');
      }
      const detail = {
        disposition,
        provider,
        nativeId,
        generation,
        channelId: message.channelId,
        deliveryChannelId: check.deliveryChannelId,
        ...agentPacketEvidence(packet),
        evidence
      };
      const result = state.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
        .run(deps.MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST, deps.now(), messageId, deps.MESSAGE_STATES.SUBMITTED);
      if (Number(result.changes) !== 1) throw new deps.StateCorruptError('agent completion state changed concurrently');
      state.receipt(messageId, disposition, detail);
      return {
        completed: true,
        duplicate: false,
        disposition,
        message: state.getMessage(messageId),
        evidence
      };
    });
  }

  return { completeAgentHandledWithoutPost };
}
