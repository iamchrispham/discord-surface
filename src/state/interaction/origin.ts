import {
  DECISION_JOURNAL,
  DECISION_RECEIPT_KINDS,
  DECISION_WINNER_SOURCES,
  type DecisionInteractionInput,
  type DecisionResult
} from '../decision/types';
import { INTERACTION_ORIGIN, INTERACTION_SOURCES } from './constants';
import type { InteractionBinding, InteractionInput, InteractionMessage, InteractionState } from './contracts';

export function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function validText(value: unknown, max = 128): value is string {
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

export function bindingMatchesExpected(binding: InteractionBinding | null, expected: InteractionBinding | null): boolean {
  if (!expected) return Boolean(binding?.active);
  return Boolean(binding && expected && binding.active === expected.active && binding.channelId === expected.channelId &&
    binding.guildId === expected.guildId && binding.provider === expected.provider && binding.nativeId === expected.nativeId &&
    binding.generation === expected.generation && (binding.sessionRoot || null) === (expected.sessionRoot || null) &&
    (binding.conductorId || null) === (expected.conductorId || null) &&
    (binding.repoKey || null) === (expected.repoKey || null));
}

export function originDetail(input: InteractionInput, binding: InteractionBinding): Record<string, unknown> {
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

export function decisionOriginDetail(input: DecisionInteractionInput, binding: InteractionBinding): Record<string, unknown> {
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

export function latestOriginDetail(state: InteractionState, messageId: string): Record<string, unknown> {
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

export function decisionResultForMessage(state: InteractionState, message: InteractionMessage): DecisionResult | null {
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

export function sameDecisionInteraction(existing: InteractionMessage, detail: Record<string, unknown>, input: DecisionInteractionInput, binding: InteractionBinding): boolean {
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

export function validDecisionInput(input: DecisionInteractionInput): boolean {
  return Boolean(input && validDecisionText(input.interactionId, 256) && validDecisionText(input.presentationId, 256) &&
    validDecisionText(input.selectedKey, 128) && validDecisionText(input.actorId, 256) && validDecisionText(input.guildId, 128) &&
    validDecisionText(input.channelId, 128) && validDecisionText(input.questionMessageId, 256) && validDecisionBinding(input.binding) &&
    validDecisionText(input.qid, 256) && validDecisionText(input.questionGeneration, 128) &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.questionGeneration) &&
    validDecisionText(input.target, 256) &&
    (input.canonicalSource === DECISION_WINNER_SOURCES.CURRENT || input.canonicalSource === DECISION_WINNER_SOURCES.HISTORY) &&
    validDecisionText(input.canonicalReference, 512) && validDecisionText(input.answer, 10000));
}

export function validInput(input: InteractionInput): boolean {
  return Boolean(input && validText(input.id) && validText(input.guildId) && validText(input.channelId) && validText(input.userId) &&
    (input.content === '/cs' || input.content === '/cs full') && typeof input.full === 'boolean' && input.full === (input.content === '/cs full'));
}
