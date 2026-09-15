import {
  DECISION_JOURNAL,
  DECISION_REASONS,
  DECISION_RECEIPT_KINDS,
  DECISION_WINNER_SOURCES,
  type DecisionInteractionAdmission,
  type DecisionInteractionInput,
  type DecisionResult
} from './decision/types';

export const INTERACTION_ORIGIN = 'interaction-origin' as const;
export const INTERACTION_TRANSPORT = 'interaction-callback' as const;
export const INTERACTION_SOURCES = Object.freeze({
  SLASH_COMMAND: 'slash-command',
  DECISION_COMPONENT: 'decision-component'
} as const);

interface SqlRow {
  [key: string]: unknown;
}

interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...parameters: unknown[]): T[];
  get<T extends SqlRow = SqlRow>(...parameters: unknown[]): T | undefined;
  run(...parameters: unknown[]): unknown;
}

interface InteractionDatabase {
  prepare(sql: string): SqlStatement;
}

interface InteractionBinding {
  active: boolean;
  channelId: string;
  guildId: string;
  provider: string;
  nativeId: string;
  workspace: string;
  sessionRoot?: string | null;
  endpoint?: string | null;
  conductorId?: string | null;
  repoKey?: string | null;
  generation: number;
  readiness: string | null;
}

export interface InteractionMessage {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  content: string;
  provider: string;
  nativeId: string;
  workspace: string;
  endpoint: string | null;
  conductorId: string | null;
  repoKey: string | null;
  generation: number;
  state: string;
  decisionResult?: DecisionResult;
}

interface InteractionState {
  db: InteractionDatabase;
  interactionVocabulary: {
    acceptedMessageState: string;
    readyReadiness: string;
  };
  transaction<T>(operation: () => T): T;
  requireConfig(): { guildId: string; operatorId: string };
  getBinding(channelId: string): InteractionBinding | null;
  getMessage(messageId: string): InteractionMessage | null;
  getIntakeWatermark?(channelId: string): { detail?: string | null } | null;
  currentMessageBinding(message: InteractionMessage): { current: boolean; binding?: InteractionBinding | null };
  getTransportReceipt(messageId: string, transport?: string | null): InteractionTransportRecord | null;
  beginTransportReceipt(messageId: string, options: {
    transport: typeof INTERACTION_TRANSPORT;
    ownerPid: number;
    ownerIdentity: unknown;
    inTransaction?: boolean;
  }): InteractionTransportRecord & { started: boolean };
  recordTransportReceiptOutcome(messageId: string, outcome: string, detail: Record<string, unknown>, transport?: string | null): InteractionTransportRecord | null;
  receipt(discordId: string | null, kind: string, detail: unknown): void;
  directPostOwnerIdentity?(pid: number): unknown;
  directPostOwnerAlive?(pid: number, expectedIdentity: unknown): boolean;
  ordinaryHandoffPauses?: Set<string>;
}

interface InteractionTransportRecord {
  messageId: string;
  attempt?: Record<string, unknown> | null;
  outcome?: Record<string, unknown> | null;
  started?: boolean;
  reason?: string;
  nonce?: string;
}

export interface InteractionInput {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  content: '/cs' | '/cs full';
  full: boolean;
}

export interface InteractionAcceptance {
  accepted: boolean;
  duplicate?: boolean;
  stale?: boolean;
  reason?: string;
  message?: InteractionMessage | null;
  callback?: InteractionTransportRecord & { started: boolean };
}

export interface InteractionAcceptanceOptions {
  claimCallback?: boolean;
  ownerPid?: number;
  ownerIdentity?: unknown;
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function validText(value: unknown, max = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validDecisionText(value: unknown, max: number): value is string {
  return validText(value, max) && !/[\u0000\u007f]/.test(value);
}

function validOptionalText(value: unknown, max: number): boolean {
  return value === null || value === undefined || validDecisionText(value, max);
}

function validDecisionBinding(binding: unknown): binding is InteractionBinding {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false;
  const candidate = binding as InteractionBinding;
  return typeof candidate.active === 'boolean' && validDecisionText(candidate.channelId, 128) &&
    validDecisionText(candidate.guildId, 128) && validDecisionText(candidate.provider, 64) &&
    validDecisionText(candidate.nativeId, 256) && validDecisionText(candidate.workspace, 4096) &&
    validOptionalText(candidate.sessionRoot, 4096) && validOptionalText(candidate.endpoint, 4096) &&
    validOptionalText(candidate.conductorId, 512) && validOptionalText(candidate.repoKey, 2048) &&
    Number.isInteger(candidate.generation) && candidate.generation > 0 &&
    (candidate.readiness === null || validDecisionText(candidate.readiness, 64));
}

function bindingMatchesExpected(binding: InteractionBinding | null, expected: InteractionBinding | null): boolean {
  if (!expected) return Boolean(binding?.active);
  return Boolean(binding && expected && binding.active === expected.active && binding.channelId === expected.channelId &&
    binding.guildId === expected.guildId && binding.provider === expected.provider && binding.nativeId === expected.nativeId &&
    binding.generation === expected.generation && (binding.sessionRoot || null) === (expected.sessionRoot || null) &&
    (binding.conductorId || null) === (expected.conductorId || null) &&
    (binding.repoKey || null) === (expected.repoKey || null));
}

function originDetail(input: InteractionInput, binding: InteractionBinding): Record<string, unknown> {
  return {
    interactionId: input.id,
    command: input.content,
    full: input.full,
    guildId: input.guildId,
    channelId: input.channelId,
    provider: binding.provider,
    nativeId: binding.nativeId,
    conductorId: binding.conductorId || null,
    repoKey: binding.repoKey || null,
    generation: binding.generation
  };
}

function decisionOriginDetail(input: DecisionInteractionInput, binding: InteractionBinding): Record<string, unknown> {
  return {
    interactionId: input.interactionId,
    source: INTERACTION_SOURCES.DECISION_COMPONENT,
    presentationId: input.presentationId,
    selectedKey: input.selectedKey,
    actorId: input.actorId,
    guildId: input.guildId,
    channelId: input.channelId,
    questionMessageId: input.questionMessageId,
    responseMessageId: input.questionMessageId,
    qid: input.qid,
    questionGeneration: input.questionGeneration,
    target: input.target,
    canonicalSource: input.canonicalSource,
    canonicalReference: input.canonicalReference,
    answer: input.answer,
    provider: binding.provider,
    nativeId: binding.nativeId,
    workspace: binding.workspace,
    endpoint: binding.endpoint || null,
    conductorId: binding.conductorId || null,
    repoKey: binding.repoKey || null,
    generation: binding.generation,
    readiness: binding.readiness,
    binding: { ...binding }
  };
}

function latestOriginDetail(state: InteractionState, messageId: string): Record<string, unknown> {
  const row = latestOriginRecord(state, messageId);
  return row?.detail || {};
}

function latestOriginRecord(state: InteractionState, messageId: string): { detail: Record<string, unknown>; malformed: boolean } | null {
  const row = state.db.prepare('SELECT detail FROM receipts WHERE discord_id=? AND kind=? ORDER BY id DESC LIMIT 1')
    .get<{ detail: unknown }>(messageId, INTERACTION_ORIGIN);
  if (!row) return null;
  if (typeof row.detail !== 'string') return { detail: {}, malformed: true };
  try {
    const parsed: unknown = JSON.parse(row.detail);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { detail: {}, malformed: true };
    return { detail: parsed as Record<string, unknown>, malformed: false };
  } catch {
    return { detail: {}, malformed: true };
  }
}

function latestDecisionNativeRecord(state: InteractionState, interactionId: string): { detail: Record<string, unknown>; malformed: boolean } | null {
  const row = state.db.prepare("SELECT detail FROM receipts WHERE kind=? AND json_extract(detail, '$.interactionId')=? ORDER BY id DESC LIMIT 1")
    .get<{ detail: unknown }>(DECISION_RECEIPT_KINDS.NATIVE_RETURN, interactionId);
  if (!row) return null;
  if (typeof row.detail !== 'string') return { detail: {}, malformed: true };
  try {
    const parsed: unknown = JSON.parse(row.detail);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { detail: {}, malformed: true };
    return { detail: parsed as Record<string, unknown>, malformed: false };
  } catch {
    return { detail: {}, malformed: true };
  }
}

function materializedSource(value: unknown): value is DecisionResult['canonicalSource'] {
  return value === DECISION_WINNER_SOURCES.CURRENT || value === DECISION_WINNER_SOURCES.HISTORY;
}

function decisionOriginText(value: unknown, max: number): string {
  if (!validDecisionText(value, max)) throw new Error('decision interaction origin is invalid');
  return value;
}

function decisionResultForMessage(state: InteractionState, message: InteractionMessage): DecisionResult | null {
  const origin = latestOriginRecord(state, message.id);
  if (!origin) return null;
  if (origin.malformed) throw new Error('decision interaction origin is invalid');
  const detail = origin.detail;
  if (detail.source !== INTERACTION_SOURCES.DECISION_COMPONENT) return null;

  const interactionId = decisionOriginText(detail.interactionId, 256);
  const presentationId = decisionOriginText(detail.presentationId, 256);
  const selectedKey = decisionOriginText(detail.selectedKey, 128);
  const actorId = decisionOriginText(detail.actorId, 256);
  const guildId = decisionOriginText(detail.guildId, 128);
  const channelId = decisionOriginText(detail.channelId, 128);
  const questionMessageId = decisionOriginText(detail.questionMessageId, 256);
  const responseMessageId = decisionOriginText(detail.responseMessageId, 256);
  const qid = decisionOriginText(detail.qid, 256);
  const questionGeneration = decisionOriginText(detail.questionGeneration, 128);
  const target = decisionOriginText(detail.target, 256);
  const canonicalReference = decisionOriginText(detail.canonicalReference, 512);
  const answer = decisionOriginText(detail.answer, 10000);
  const provider = decisionOriginText(detail.provider, 64);
  const nativeId = decisionOriginText(detail.nativeId, 256);
  const canonicalSource = detail.canonicalSource;
  if (!materializedSource(canonicalSource) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(questionGeneration)) {
    throw new Error('decision interaction origin is invalid');
  }
  if (typeof detail.generation !== 'number' || !Number.isInteger(detail.generation) || detail.generation < 1) {
    throw new Error('decision interaction origin is invalid');
  }
  const binding = detail.binding;
  if (!validDecisionBinding(binding)) throw new Error('decision interaction origin is invalid');
  const nativeRecord = latestDecisionNativeRecord(state, interactionId);
  if (!nativeRecord || nativeRecord.malformed || nativeRecord.detail.journal !== DECISION_JOURNAL) {
    throw new Error('decision interaction native custody is invalid');
  }
  const native = nativeRecord.detail;
  const nativePresentationId = decisionOriginText(native.presentationId, 256);
  const nativeSelectedKey = decisionOriginText(native.selectedKey, 128);
  const nativeQuestionMessageId = decisionOriginText(native.questionMessageId, 256);
  const nativeQid = decisionOriginText(native.qid, 256);
  const nativeQuestionGeneration = decisionOriginText(native.questionGeneration, 128);
  const nativeTarget = decisionOriginText(native.target, 256);
  const nativeCanonicalSource = native.canonicalSource;
  const nativeCanonicalReference = decisionOriginText(native.canonicalReference, 512);
  const nativeAnswer = decisionOriginText(native.answer, 10000);
  const nativeProvider = decisionOriginText(native.provider, 64);
  const nativeReceiptNativeId = decisionOriginText(native.nativeId, 256);
  const nativeChannelId = decisionOriginText(native.channelId, 128);
  const nativeGuildId = decisionOriginText(native.guildId, 128);
  const nativeWorkspace = decisionOriginText(native.workspace, 4096);
  if (!materializedSource(nativeCanonicalSource) || typeof native.generation !== 'number' ||
    !Number.isInteger(native.generation) || native.generation < 1 || native.interactionId !== interactionId || nativePresentationId !== presentationId ||
    nativeSelectedKey !== selectedKey || nativeQuestionMessageId !== questionMessageId || nativeQid !== qid ||
    nativeQuestionGeneration !== questionGeneration || nativeTarget !== target || nativeCanonicalSource !== canonicalSource ||
    nativeCanonicalReference !== canonicalReference || nativeAnswer !== answer || nativeProvider !== provider ||
    nativeReceiptNativeId !== message.nativeId || nativeChannelId !== message.channelId || nativeGuildId !== message.guildId ||
    nativeWorkspace !== message.workspace || native.generation !== message.generation ||
    (native.conductorId || null) !== (message.conductorId || null) || (native.repoKey || null) !== (message.repoKey || null)) {
    throw new Error('decision interaction native custody does not match message identity');
  }
  const bindingMatchesMessage = binding.active && binding.channelId === message.channelId &&
    binding.guildId === message.guildId && binding.provider === message.provider &&
    binding.nativeId === message.nativeId && binding.workspace === message.workspace &&
    (binding.endpoint || null) === (message.endpoint || null) &&
    (binding.conductorId || null) === (message.conductorId || null) &&
    (binding.repoKey || null) === (message.repoKey || null) &&
    binding.generation === message.generation;
  if (!bindingMatchesMessage || interactionId !== message.id || actorId !== message.authorId ||
    guildId !== message.guildId || channelId !== message.channelId || answer !== message.content ||
    provider !== message.provider || nativeId !== message.nativeId || detail.generation !== message.generation ||
    responseMessageId !== questionMessageId) {
    throw new Error('decision interaction origin does not match message identity');
  }
  return {
    qid,
    questionGeneration,
    target,
    canonicalSource,
    canonicalReference,
    answer,
    questionMessageId,
    interactionId,
    selectedKey
  };
}

function sameDecisionBinding(detail: unknown, binding: InteractionBinding): boolean {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return false;
  const recorded = detail as Partial<InteractionBinding>;
  return recorded.active === binding.active && recorded.channelId === binding.channelId &&
    recorded.guildId === binding.guildId && recorded.provider === binding.provider &&
    recorded.nativeId === binding.nativeId && recorded.workspace === binding.workspace &&
    (recorded.sessionRoot || null) === (binding.sessionRoot || null) &&
    (recorded.endpoint || null) === (binding.endpoint || null) &&
    (recorded.conductorId || null) === (binding.conductorId || null) &&
    (recorded.repoKey || null) === (binding.repoKey || null) &&
    recorded.generation === binding.generation && recorded.readiness === binding.readiness;
}

function sameDecisionInteraction(existing: InteractionMessage, detail: Record<string, unknown>, input: DecisionInteractionInput, binding: InteractionBinding): boolean {
  return existing.id === input.interactionId && existing.guildId === input.guildId && existing.channelId === input.channelId &&
    existing.authorId === input.actorId && existing.content === input.answer && existing.provider === binding.provider &&
    existing.nativeId === binding.nativeId && existing.generation === binding.generation &&
    detail.interactionId === input.interactionId && detail.source === INTERACTION_SOURCES.DECISION_COMPONENT &&
    detail.presentationId === input.presentationId && detail.selectedKey === input.selectedKey &&
    detail.actorId === input.actorId && detail.guildId === input.guildId && detail.channelId === input.channelId &&
    detail.questionMessageId === input.questionMessageId && detail.responseMessageId === input.questionMessageId &&
    detail.qid === input.qid && detail.questionGeneration === input.questionGeneration && detail.target === input.target &&
    detail.canonicalSource === input.canonicalSource && detail.canonicalReference === input.canonicalReference &&
    detail.answer === input.answer && sameDecisionBinding(detail.binding, binding);
}

function validDecisionInput(input: DecisionInteractionInput): boolean {
  return Boolean(input && validDecisionText(input.interactionId, 256) && validDecisionText(input.presentationId, 256) &&
    validDecisionText(input.selectedKey, 128) && validDecisionText(input.actorId, 256) && validDecisionText(input.guildId, 128) &&
    validDecisionText(input.channelId, 128) && validDecisionText(input.questionMessageId, 256) && validDecisionBinding(input.binding) &&
    validDecisionText(input.qid, 256) && validDecisionText(input.questionGeneration, 128) &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.questionGeneration) &&
    validDecisionText(input.target, 256) &&
    (input.canonicalSource === DECISION_WINNER_SOURCES.CURRENT || input.canonicalSource === DECISION_WINNER_SOURCES.HISTORY) &&
    validDecisionText(input.canonicalReference, 512) && validDecisionText(input.answer, 10000));
}

function validInput(input: InteractionInput): boolean {
  return Boolean(input && validText(input.id) && validText(input.guildId) && validText(input.channelId) && validText(input.userId) &&
    (input.content === '/cs' || input.content === '/cs full') && typeof input.full === 'boolean' && input.full === (input.content === '/cs full'));
}

export function createInteractionHandlers(): {
  acceptInteraction(state: InteractionState, input: InteractionInput, expectedBinding?: InteractionBinding | null, options?: InteractionAcceptanceOptions): InteractionAcceptance;
  acceptDecisionInteraction(state: InteractionState, input: DecisionInteractionInput): DecisionInteractionAdmission;
  decisionResult(state: InteractionState, message: InteractionMessage): DecisionResult | null;
  beginCallback(state: InteractionState, messageId: string): InteractionTransportRecord & { started: boolean };
  recordCallbackOutcome(state: InteractionState, messageId: string, outcome: string, detail?: Record<string, unknown>): InteractionTransportRecord | null;
  isInteractionMessage(state: InteractionState, messageId: string): boolean;
  responseTarget(state: InteractionState, messageId: string): string | null;
  recoverCallbacksInTransaction(state: InteractionState, ownerAlive?: (pid: number, identity: unknown) => boolean): number;
} {
  return {
    decisionResult(state, message) {
      return decisionResultForMessage(state, message);
    },

    acceptDecisionInteraction(state, input) {
      if (!validDecisionInput(input)) return { accepted: false, reason: DECISION_REASONS.INVALID_DECISION_INTERACTION };
      const config = state.requireConfig();
      const binding = state.getBinding(input.channelId);
      if (!bindingMatchesExpected(binding, input.binding)) return { accepted: false, reason: DECISION_REASONS.STALE_BINDING };
      if (!binding?.active) return { accepted: false, reason: DECISION_REASONS.INACTIVE_BINDING };
      if (input.guildId !== config.guildId || input.actorId !== config.operatorId) {
        return { accepted: false, reason: DECISION_REASONS.UNAUTHORIZED_INTERACTION };
      }
      if (state.ordinaryHandoffPauses?.has(input.channelId) || state.getIntakeWatermark?.(input.channelId)?.detail === 'ordinary handoff fence') {
        return { accepted: false, reason: DECISION_REASONS.HANDOFF_INTAKE_PAUSED };
      }
      if (binding.guildId !== config.guildId || binding.channelId !== input.channelId) return { accepted: false, reason: DECISION_REASONS.UNKNOWN_BINDING };
      if (binding.readiness !== state.interactionVocabulary.readyReadiness) return { accepted: false, reason: DECISION_REASONS.BINDING_NOT_READY };
      const existing = state.getMessage(input.interactionId);
      if (existing) {
        const detail = latestOriginDetail(state, input.interactionId);
        if (sameDecisionInteraction(existing, detail, input, binding)) {
          return { accepted: false, duplicate: true, reason: DECISION_REASONS.DUPLICATE_DECISION_INTERACTION };
        }
        return { accepted: false, reason: DECISION_REASONS.INTERACTION_ID_CONFLICT };
      }
      const timestamp = new Date().toISOString();
      state.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, author_id, content, attachments, provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.interactionId, input.guildId, input.channelId, input.actorId, input.answer, binding.provider, binding.nativeId,
        binding.workspace, binding.endpoint || null, binding.conductorId || null, binding.repoKey || null,
        binding.generation, state.interactionVocabulary.acceptedMessageState, timestamp, timestamp
      );
      state.receipt(input.interactionId, INTERACTION_ORIGIN, decisionOriginDetail(input, binding));
      return { accepted: true };
    },

    acceptInteraction(state, input, expectedBinding = null, options = {}) {
      if (!validInput(input)) return { accepted: false, reason: 'invalid-interaction' };
      const config = state.requireConfig();
      return state.transaction(() => {
        const binding = state.getBinding(input.channelId);
        if (!bindingMatchesExpected(binding, expectedBinding)) return { accepted: false, stale: true, reason: 'stale-binding' };
        if (!binding?.active) return { accepted: false, reason: 'inactive-binding' };
        if (input.guildId !== config.guildId || input.userId !== config.operatorId) return { accepted: false, reason: 'unauthorized-interaction' };
        if (state.ordinaryHandoffPauses?.has(input.channelId) || state.getIntakeWatermark?.(input.channelId)?.detail === 'ordinary handoff fence') {
          return { accepted: false, reason: 'handoff-intake-paused' };
        }
        if (!binding || binding.guildId !== config.guildId || binding.channelId !== input.channelId) return { accepted: false, reason: 'unknown-binding' };
        if (binding.readiness !== state.interactionVocabulary.readyReadiness) return { accepted: false, reason: 'binding-not-ready' };
        const existing = state.getMessage(input.id);
        if (existing) return { accepted: false, duplicate: true, reason: 'duplicate-interaction', message: existing };
        const timestamp = new Date().toISOString();
        state.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, author_id, content, attachments, provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
          VALUES(?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          input.id, input.guildId, input.channelId, input.userId, input.content, binding.provider, binding.nativeId,
          binding.workspace, binding.endpoint || null, binding.conductorId || null, binding.repoKey || null,
          binding.generation, state.interactionVocabulary.acceptedMessageState, timestamp, timestamp
        );
        state.receipt(input.id, INTERACTION_ORIGIN, originDetail(input, binding));
        const callback = options.claimCallback
          ? state.beginTransportReceipt(input.id, {
            transport: INTERACTION_TRANSPORT,
            ownerPid: options.ownerPid ?? process.pid,
            ownerIdentity: options.ownerIdentity ?? null,
            inTransaction: true
          })
          : null;
        return {
          accepted: true,
          message: state.getMessage(input.id),
          ...(callback ? { callback } : {})
        };
      });
    },

    beginCallback(state, messageId) {
      if (!validText(messageId)) throw new Error('messageId must be a non-empty string of at most 128 characters');
      const ownerPid = process.pid;
      const ownerIdentity = typeof state.directPostOwnerIdentity === 'function'
        ? state.directPostOwnerIdentity(ownerPid)
        : null;
      return state.beginTransportReceipt(messageId, {
        transport: INTERACTION_TRANSPORT,
        ownerPid,
        ownerIdentity
      });
    },

    recordCallbackOutcome(state, messageId, outcome, detail = {}) {
      return state.recordTransportReceiptOutcome(messageId, outcome, { transport: INTERACTION_TRANSPORT, ...detail }, INTERACTION_TRANSPORT);
    },

    isInteractionMessage(state, messageId) {
      return Boolean(state.db.prepare('SELECT 1 FROM receipts WHERE discord_id=? AND kind=? LIMIT 1').get(messageId, INTERACTION_ORIGIN));
    },

    responseTarget(state, messageId) {
      const receipt = state.getTransportReceipt(messageId, INTERACTION_TRANSPORT);
      const origin = latestOriginDetail(state, messageId);
      const target = receipt?.outcome?.responseMessageId || origin.responseMessageId || origin.questionMessageId;
      return validText(target) ? target : null;
    },

    recoverCallbacksInTransaction(state, ownerAlive = (pid, identity) => state.directPostOwnerAlive?.(pid, identity) || false) {
      const rows = state.db.prepare(`SELECT attempt.discord_id AS discord_id, attempt.detail AS detail
        FROM receipts attempt
        LEFT JOIN receipts outcome ON outcome.discord_id=attempt.discord_id
          AND outcome.kind=? AND outcome.id>attempt.id
          AND json_extract(outcome.detail, '$.transport')=?
        WHERE attempt.kind=? AND json_extract(attempt.detail, '$.transport')=? AND outcome.id IS NULL
        ORDER BY attempt.id`).all<{ discord_id: string; detail: unknown }>('transport-receipt-outcome', INTERACTION_TRANSPORT, 'transport-receipt-attempt', INTERACTION_TRANSPORT);
      let recovered = 0;
      for (const row of rows) {
        const detail = parseJson(row.detail);
        const pid = Number(detail.ownerPid);
        if (Number.isInteger(pid) && pid > 0 && ownerAlive(pid, detail.ownerIdentity)) continue;
        state.receipt(row.discord_id, 'transport-receipt-outcome', {
          ...detail,
          transport: INTERACTION_TRANSPORT,
          outcome: 'unknown',
          terminal: true,
          visibility: 'unknown',
          reason: 'process stopped before interaction callback outcome'
        });
        recovered += 1;
      }
      const missingAttempts = state.db.prepare(`SELECT origin.discord_id AS discord_id
        FROM receipts origin
        LEFT JOIN receipts attempt ON attempt.discord_id=origin.discord_id
          AND attempt.kind='transport-receipt-attempt'
          AND json_extract(attempt.detail, '$.transport')=?
          AND attempt.id>origin.id
        LEFT JOIN receipts outcome ON outcome.discord_id=origin.discord_id
          AND outcome.kind='transport-receipt-outcome'
          AND json_extract(outcome.detail, '$.transport')=?
          AND outcome.id>origin.id
        WHERE origin.kind=? AND attempt.id IS NULL AND outcome.id IS NULL
        ORDER BY origin.id`).all<{ discord_id: string }>(INTERACTION_TRANSPORT, INTERACTION_TRANSPORT, INTERACTION_ORIGIN);
      for (const row of missingAttempts) {
        state.receipt(row.discord_id, 'transport-receipt-outcome', {
          transport: INTERACTION_TRANSPORT,
          outcome: 'unknown',
          terminal: true,
          visibility: 'unknown',
          reason: 'process stopped before interaction callback attempt'
        });
        recovered += 1;
      }
      return recovered;
    }
  };
}
