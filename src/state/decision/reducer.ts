import { PROVIDERS, type AgentProvider } from '../../agent-message';
import {
  DECISION_JOURNAL,
  DECISION_NATIVE_OUTCOMES,
  DECISION_RECEIPT_KINDS,
  DECISION_STATES,
  DECISION_TRANSPORT_OUTCOMES,
  DECISION_WINNER_SOURCES,
  DecisionError,
  type DecisionBinding,
  type DecisionCanonicalResult,
  type DecisionCanonicalRoute,
  type DecisionClick,
  type DecisionClickInput,
  type DecisionNativeOutcome,
  type DecisionPresentation,
  type DecisionPresentationLookupInput,
  type DecisionReceiptKind,
  type DecisionState,
  type DecisionStateStore,
  type DecisionTransportOutcome,
  type DecisionWinnerSource,
  type JournalRow,
  type MutableClick,
  type MutablePresentation,
  type Snapshot
} from './types';
import * as path from 'node:path';

const BINDING_KEYS: readonly (keyof DecisionBinding)[] = [
  'channelId',
  'guildId',
  'provider',
  'nativeId',
  'workspace',
  'sessionRoot',
  'endpoint',
  'conductorId',
  'repoKey',
  'generation'
];

const RECEIPT_KIND_VALUES = Object.values(DECISION_RECEIPT_KINDS) as DecisionReceiptKind[];
const TRANSPORT_OUTCOME_VALUES = Object.values(DECISION_TRANSPORT_OUTCOMES) as DecisionTransportOutcome[];
const WINNER_SOURCE_VALUES = Object.values(DECISION_WINNER_SOURCES) as DecisionWinnerSource[];
const NATIVE_OUTCOME_VALUES = Object.values(DECISION_NATIVE_OUTCOMES) as DecisionNativeOutcome[];
const CANONICAL_ROUTE_PATH_MAX = 4096;
const CANONICAL_CONTENT_MAX = 2000;
export const PENDING_STATES = new Set<DecisionState>([
  DECISION_STATES.CLICK_ADMITTED,
  DECISION_STATES.CALLBACK_PENDING,
  DECISION_STATES.CANONICAL_PENDING,
  DECISION_STATES.CLAIM_ONLY,
  DECISION_STATES.MATERIALIZED_PROJECTION_PENDING,
  DECISION_STATES.NATIVE_RETURN_PENDING,
  DECISION_STATES.UNKNOWN
]);

export function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DecisionError(name + ' must be an object');
  return value as Record<string, unknown>;
}

export function text(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000\u007f]/.test(value)) {
    throw new DecisionError(name + ' must be a non-empty string of at most ' + max + ' characters');
  }
  return value;
}

export function optionalText(value: unknown, name: string, max = 512): string | null {
  if (value === undefined || value === null) return null;
  return text(value, name, max);
}

export function questionGeneration(value: unknown, name = 'questionGeneration'): string {
  const candidate = text(value, name, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate)) {
    throw new DecisionError(name + ' must start alphanumeric and use [A-Za-z0-9._:-]');
  }
  return candidate;
}

export function generation(value: unknown, name = 'generation'): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new DecisionError(name + ' must be a positive integer');
  return Number(value);
}

export function outcome(value: unknown): DecisionTransportOutcome {
  if (!TRANSPORT_OUTCOME_VALUES.includes(value as DecisionTransportOutcome)) throw new DecisionError('invalid decision transport outcome');
  return value as DecisionTransportOutcome;
}

export function nativeOutcome(value: unknown): DecisionNativeOutcome {
  if (!NATIVE_OUTCOME_VALUES.includes(value as DecisionNativeOutcome)) throw new DecisionError('invalid decision native outcome');
  return value as DecisionNativeOutcome;
}

export function winnerSource(value: unknown): DecisionWinnerSource {
  if (!WINNER_SOURCE_VALUES.includes(value as DecisionWinnerSource)) throw new DecisionError('invalid decision winner source');
  return value as DecisionWinnerSource;
}

export function normalizeBinding(value: unknown, name = 'binding'): DecisionBinding {
  const input = record(value, name);
  return {
    active: input.active !== false,
    readiness: input.readiness == null ? null : text(input.readiness, name + '.readiness', 64),
    channelId: text(input.channelId, name + '.channelId', 128),
    guildId: text(input.guildId, name + '.guildId', 128),
    provider: text(input.provider, name + '.provider', 64),
    nativeId: text(input.nativeId, name + '.nativeId', 256),
    workspace: text(input.workspace, name + '.workspace', 4096),
    sessionRoot: optionalText(input.sessionRoot, name + '.sessionRoot', 4096),
    endpoint: optionalText(input.endpoint, name + '.endpoint', 4096),
    conductorId: optionalText(input.conductorId, name + '.conductorId', 512),
    repoKey: optionalText(input.repoKey, name + '.repoKey', 2048),
    generation: generation(input.generation, name + '.generation')
  };
}

export function bindingMatches(left: DecisionBinding, right: DecisionBinding): boolean {
  return BINDING_KEYS.every(key => left[key] === right[key]);
}

export function normalizeKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new DecisionError('decision keys must be a non-empty array');
  const keys = value.map((item, index) => text(item, 'keys[' + index + ']', 128));
  if (new Set(keys).size !== keys.length) throw new DecisionError('decision keys must be unique');
  return keys;
}

function canonicalPath(value: unknown, name: string): string {
  const candidate = text(value, name, CANONICAL_ROUTE_PATH_MAX);
  if (!path.isAbsolute(candidate) || /[\u0000-\u001f\u007f]/.test(candidate)) {
    throw new DecisionError(name + ' must be an absolute path');
  }
  return path.resolve(candidate);
}

export function normalizeCanonicalRoute(value: unknown): DecisionCanonicalRoute {
  const input = record(value, 'canonicalRoute');
  return {
    executable: canonicalPath(input.executable, 'canonicalRoute.executable'),
    stateRoot: canonicalPath(input.stateRoot, 'canonicalRoute.stateRoot'),
    telegramRoot: canonicalPath(input.telegramRoot, 'canonicalRoute.telegramRoot')
  };
}

export function normalizePresentationPayload(
  routeValue: unknown,
  contentValue: unknown
): { canonicalRoute?: DecisionCanonicalRoute; content?: string } {
  const hasRoute = routeValue !== undefined && routeValue !== null;
  const hasContent = contentValue !== undefined && contentValue !== null;
  if (!hasRoute && !hasContent) return {};
  if (!hasRoute || !hasContent) throw new DecisionError('canonicalRoute and content must be provided together');
  return {
    canonicalRoute: normalizeCanonicalRoute(routeValue),
    content: text(contentValue, 'content', CANONICAL_CONTENT_MAX)
  };
}

export function optionalPresentationNamespace(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value, 'namespace', 256);
}

export function parseDetail(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    const detail = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    return detail?.journal === DECISION_JOURNAL ? detail : null;
  } catch {
    return null;
  }
}

export function journal(state: DecisionStateStore): JournalRow[] {
  const placeholders = RECEIPT_KIND_VALUES.map(() => '?').join(', ');
  return state.db.prepare('SELECT id, kind, detail, created_at FROM receipts WHERE kind IN (' + placeholders + ') ORDER BY id')
    .all<JournalRow>(...RECEIPT_KIND_VALUES);
}

export function append(state: DecisionStateStore, kind: DecisionReceiptKind, detail: Record<string, unknown>): void {
  state.receipt(null, kind, { journal: DECISION_JOURNAL, ...detail });
}

export function mutablePresentationOutput(presentation: MutablePresentation): DecisionPresentation {
  const { clickIds, ...output } = presentation;
  return {
    ...output,
    ...(output.canonicalRoute ? { canonicalRoute: { ...output.canonicalRoute } } : {}),
    keys: [...output.keys],
    clickCount: clickIds.length
  };
}

export function mutableClickOutput(click: MutableClick): DecisionClick {
  return {
    ...click,
    binding: { ...click.binding },
    canonical: click.canonical ? { ...click.canonical } : null,
    nativeReturn: click.nativeReturn ? { ...click.nativeReturn } : null
  };
}

export function snapshot(state: DecisionStateStore): Snapshot {
  const presentations = new Map<string, MutablePresentation>();
  const clicks = new Map<string, MutableClick>();
  for (const row of journal(state)) {
    const detail = parseDetail(row.detail);
    if (!detail) continue;
    const presentationId = typeof detail.presentationId === 'string' ? detail.presentationId : null;
    const interactionId = typeof detail.interactionId === 'string' ? detail.interactionId : null;
    if (row.kind === DECISION_RECEIPT_KINDS.PRESENTATION && presentationId) {
      if (presentations.has(presentationId)) continue;
      const payload = normalizePresentationPayload(detail.canonicalRoute, detail.content);
      const namespace = optionalPresentationNamespace(detail.namespace);
      presentations.set(presentationId, {
        ...(namespace !== undefined ? { namespace } : {}),
        presentationId,
        requestId: text(detail.requestId, 'requestId', 256),
        qid: text(detail.qid, 'qid', 256),
        questionGeneration: questionGeneration(detail.questionGeneration),
        target: text(detail.target, 'target', 256),
        guildId: text(detail.guildId, 'guildId', 128),
        channelId: text(detail.channelId, 'channelId', 128),
        messageId: optionalText(detail.messageId, 'messageId', 256),
        operatorId: text(detail.operatorId, 'operatorId', 256),
        binding: normalizeBinding(detail.binding),
        keys: normalizeKeys(detail.keys),
        state: DECISION_STATES.PRESENTATION_PENDING,
        presentationOutcome: null,
        clickIds: [],
        staleReason: null,
        createdAt: row.created_at,
        updatedAt: row.created_at,
        ...payload
      });
      continue;
    }
    const presentation = presentationId ? presentations.get(presentationId) : undefined;
    if (row.kind === DECISION_RECEIPT_KINDS.PRESENTATION_OUTCOME && presentation) {
      const nextOutcome = outcome(detail.outcome);
      presentation.presentationOutcome = nextOutcome;
      if (nextOutcome === DECISION_TRANSPORT_OUTCOMES.SENT) {
        const messageId = text(detail.messageId, 'messageId', 256);
        if (presentation.messageId && presentation.messageId !== messageId) throw new DecisionError('presentation message identity changed');
        presentation.messageId = messageId;
        presentation.state = presentation.clickIds.length ? DECISION_STATES.CLICK_ADMITTED : DECISION_STATES.PRESENTED_UNANSWERED;
      } else {
        presentation.state = nextOutcome === DECISION_TRANSPORT_OUTCOMES.UNKNOWN ? DECISION_STATES.UNKNOWN : DECISION_STATES.REFUSED;
      }
      presentation.updatedAt = row.created_at;
      continue;
    }
    if (row.kind === DECISION_RECEIPT_KINDS.PRESENTATION_STALE && presentation) {
      presentation.state = DECISION_STATES.STALE;
      presentation.staleReason = text(detail.reason, 'reason', 512);
      presentation.updatedAt = row.created_at;
      continue;
    }
    if (row.kind === DECISION_RECEIPT_KINDS.CLICK && presentation && interactionId) {
      if (clicks.has(interactionId)) continue;
      clicks.set(interactionId, {
        interactionId,
        presentationId: presentation.presentationId,
        selectedKey: text(detail.selectedKey, 'selectedKey', 128),
        actorId: text(detail.actorId, 'actorId', 256),
        guildId: text(detail.guildId, 'guildId', 128),
        channelId: text(detail.channelId, 'channelId', 128),
        messageId: text(detail.messageId, 'messageId', 256),
        binding: normalizeBinding(detail.binding),
        state: DECISION_STATES.CLICK_ADMITTED,
        callbackAttempted: false,
        callbackOutcome: null,
        canonical: null,
        projectionOutcome: null,
        nativeReturn: null,
        createdAt: row.created_at,
        updatedAt: row.created_at
      });
      presentation.clickIds.push(interactionId);
      if (presentation.state === DECISION_STATES.PRESENTED_UNANSWERED) presentation.state = DECISION_STATES.CLICK_ADMITTED;
      presentation.updatedAt = row.created_at;
      continue;
    }
    const click = interactionId ? clicks.get(interactionId) : undefined;
    if (!click) continue;
    if (row.kind === DECISION_RECEIPT_KINDS.CALLBACK_ATTEMPT) {
      click.callbackAttempted = true;
      if (!click.canonical && !click.nativeReturn) click.state = DECISION_STATES.CALLBACK_PENDING;
      click.updatedAt = row.created_at;
    } else if (row.kind === DECISION_RECEIPT_KINDS.CALLBACK_OUTCOME) {
      click.callbackOutcome = outcome(detail.outcome);
      if (!click.canonical && !click.nativeReturn) click.state = DECISION_STATES.CANONICAL_PENDING;
      click.updatedAt = row.created_at;
    } else if (row.kind === DECISION_RECEIPT_KINDS.CANONICAL_IMPORT) {
      const source = winnerSource(detail.source);
      const materialized = detail.materialized === true;
      const canonical: DecisionCanonicalResult = {
        qid: text(detail.qid, 'qid', 256),
        questionGeneration: questionGeneration(detail.questionGeneration),
        target: text(detail.target, 'target', 256),
        source,
        materialized,
        reference: text(detail.reference, 'reference', 512),
        ...(materialized ? { answer: text(detail.answer, 'answer', 10000) } : {})
      };
      click.canonical = canonical;
      click.state = materialized ? DECISION_STATES.MATERIALIZED_PROJECTION_PENDING : DECISION_STATES.CLAIM_ONLY;
      click.updatedAt = row.created_at;
    } else if (row.kind === DECISION_RECEIPT_KINDS.PROJECTION_OUTCOME) {
      click.projectionOutcome = outcome(detail.outcome);
      if (click.nativeReturn) click.state = click.nativeReturn.state;
      else click.state = click.projectionOutcome === DECISION_TRANSPORT_OUTCOMES.UNKNOWN
        ? DECISION_STATES.UNKNOWN
        : DECISION_STATES.TERMINAL;
      click.updatedAt = row.created_at;
    } else if (row.kind === DECISION_RECEIPT_KINDS.NATIVE_RETURN) {
      const canonical = click.canonical;
      click.nativeReturn = {
        qid: text(detail.qid ?? canonical?.qid, 'qid', 256),
        questionGeneration: questionGeneration(detail.questionGeneration ?? canonical?.questionGeneration),
        target: text(detail.target ?? canonical?.target, 'target', 256),
        provider: text(detail.provider, 'provider', 64),
        nativeId: text(detail.nativeId, 'nativeId', 256),
        generation: generation(detail.generation),
        channelId: text(detail.channelId, 'channelId', 128),
        guildId: text(detail.guildId, 'guildId', 128),
        workspace: text(detail.workspace, 'workspace', 4096),
        conductorId: optionalText(detail.conductorId, 'conductorId', 512),
        repoKey: optionalText(detail.repoKey, 'repoKey', 2048),
        canonicalReference: text(detail.canonicalReference, 'canonicalReference', 512),
        state: DECISION_STATES.NATIVE_RETURN_PENDING,
        outcome: null
      };
      click.state = DECISION_STATES.NATIVE_RETURN_PENDING;
      click.updatedAt = row.created_at;
    } else if (row.kind === DECISION_RECEIPT_KINDS.NATIVE_OUTCOME && click.nativeReturn) {
      const nextOutcome = nativeOutcome(detail.outcome);
      click.nativeReturn.outcome = nextOutcome;
      click.nativeReturn.state = nextOutcome === DECISION_NATIVE_OUTCOMES.SUBMITTED
        ? DECISION_STATES.TERMINAL
        : nextOutcome === DECISION_NATIVE_OUTCOMES.IN_FLIGHT
          ? DECISION_STATES.NATIVE_RETURN_PENDING
          : DECISION_STATES.UNKNOWN;
      click.state = click.nativeReturn.state;
      click.updatedAt = row.created_at;
    }
  }
  return { presentations, clicks };
}

export function presentationFor(state: DecisionStateStore, presentationId: string): MutablePresentation | null {
  return snapshot(state).presentations.get(text(presentationId, 'presentationId', 256)) || null;
}

export function normalizePresentationLookup(value: DecisionPresentationLookupInput): DecisionPresentationLookupInput {
  const provider = text(value?.provider, 'provider', 64);
  if (!Object.values(PROVIDERS).includes(provider as AgentProvider)) throw new DecisionError('provider must use the existing AgentProvider vocabulary');
  return {
    namespace: text(value?.namespace, 'namespace', 256),
    requestId: text(value?.requestId, 'requestId', 256),
    channelId: text(value?.channelId, 'channelId', 128),
    provider: provider as DecisionPresentationLookupInput['provider'],
    nativeId: text(value?.nativeId, 'nativeId', 256),
    generation: generation(value?.generation)
  };
}

export function findPresentation(
  state: DecisionStateStore,
  rawInput: DecisionPresentationLookupInput
): DecisionPresentation | null {
  const input = normalizePresentationLookup(rawInput);
  const matches = [...snapshot(state).presentations.values()].filter(presentation =>
    presentation.namespace === input.namespace &&
    presentation.requestId === input.requestId &&
    presentation.binding.channelId === input.channelId &&
    presentation.binding.provider === input.provider &&
    presentation.binding.nativeId === input.nativeId &&
    presentation.binding.generation === input.generation
  );
  if (matches.length > 1) throw new DecisionError('decision presentation lookup is ambiguous');
  return matches.length ? mutablePresentationOutput(matches[0]) : null;
}

export function clickFor(state: DecisionStateStore, interactionId: string): MutableClick | null {
  return snapshot(state).clicks.get(text(interactionId, 'interactionId', 256)) || null;
}

export function sameCanonical(left: DecisionCanonicalResult, right: DecisionCanonicalResult): boolean {
  if (!sameOccurrence(left, right) || left.materialized !== right.materialized) return false;
  if (left.materialized) return left.answer === right.answer;
  return left.source === right.source && left.reference === right.reference && (left.answer || null) === (right.answer || null);
}

export function sameOccurrence(
  left: Pick<DecisionCanonicalResult, 'qid' | 'questionGeneration' | 'target'>,
  right: Pick<DecisionCanonicalResult, 'qid' | 'questionGeneration' | 'target'>
): boolean {
  return left.qid === right.qid && left.questionGeneration === right.questionGeneration && left.target === right.target;
}

export function sameMaterializedAnswer(left: DecisionCanonicalResult, right: DecisionCanonicalResult): boolean {
  return left.materialized && right.materialized && sameOccurrence(left, right) && left.answer === right.answer;
}

export function sameCanonicalRoute(
  left: DecisionCanonicalRoute | undefined,
  right: DecisionCanonicalRoute | undefined
): boolean {
  if (!left || !right) return !left && !right;
  return left.executable === right.executable && left.stateRoot === right.stateRoot && left.telegramRoot === right.telegramRoot;
}

export function sameClickInput(click: MutableClick, input: Omit<DecisionClickInput, 'binding'>, binding: DecisionBinding): boolean {
  return click.presentationId === input.presentationId && click.selectedKey === input.selectedKey &&
    click.actorId === input.actorId && click.guildId === input.guildId && click.channelId === input.channelId &&
    click.messageId === input.messageId && bindingMatches(click.binding, binding);
}

export function currentBinding(state: DecisionStateStore, binding: DecisionBinding): boolean {
  const current = state.getBinding(binding.channelId);
  return Boolean(current && current.active !== false && bindingMatches(normalizeBinding(current), binding));
}
