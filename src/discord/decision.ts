import { PROVIDERS, type AgentProvider } from '../agent-message';
import {
  decodeDecisionCustomId,
  parseComponentInteraction,
  sendComponentCallback,
  type InteractionCallbackResult,
  type InteractionFetch,
  type ParsedComponentInteraction
} from '../discord-interaction';
import {
  CANONICAL_OPERATIONS,
  CANONICAL_RUN_STATUSES,
  resolveCanonicalRoute,
  runCanonicalOperation,
  type CanonicalOperationResult,
  type CanonicalRoute
} from '../decision-canonical';
import {
  DECISION_NATIVE_OUTCOMES,
  DECISION_REASONS,
  DECISION_STATES,
  DECISION_TRANSPORT_OUTCOMES,
  DECISION_WINNER_SOURCES,
  type DecisionBinding,
  type DecisionBindingInput,
  type DecisionCanonicalResult,
  type DecisionClick,
  type DecisionReason,
  type DecisionPresentation,
  type DecisionTransportOutcome
} from '../state/decision';
import type { Readiness } from '../topic';

const { DISPATCH_OUTCOMES, MESSAGE_STATES } = require('../../src/state') as {
  DISPATCH_OUTCOMES: Readonly<{ NOT_SUBMITTED: string }>;
  MESSAGE_STATES: Readonly<{
    ACCEPTED: string;
    DISPATCHING: string;
    UNCERTAIN: string;
    SUBMITTED: string;
    REPLY_READY: string;
    REPLYING: string;
    REPLIED: string;
  }>;
};

export interface DecisionMessage {
  id: string;
  guildId: string;
  channelId: string;
  provider: string;
  nativeId: string;
  workspace: string;
  generation: number;
  state: string;
  decisionResult?: unknown;
}

export interface DecisionConsumerState {
  getBinding(channelId: string): DecisionBinding | null;
  getDecisionPresentation(presentationId: string): DecisionPresentation | null;
  admitDecisionClickAndBeginCallback(input: {
    interactionId: string;
    presentationId: string;
    selectedKey: string;
    actorId: string;
    guildId: string;
    channelId: string;
    messageId: string;
    binding: DecisionBindingInput;
  }): {
    accepted: boolean;
    duplicate?: boolean;
    continuing?: boolean;
    reason?: DecisionReason;
    click: DecisionClick | null;
  };
  getDecisionClick(interactionId: string): DecisionClick | null;
  recordDecisionCallbackOutcome(interactionId: string, outcome: DecisionTransportOutcome): unknown;
  importDecisionWinner(interactionId: string, result: DecisionCanonicalResult): {
    accepted: boolean;
    duplicate?: boolean;
    reason?: DecisionReason;
    click: DecisionClick | null;
  };
  recordDecisionProjectionOutcome(interactionId: string, outcome: DecisionTransportOutcome): unknown;
  recordDecisionNativeReturnOutcome(interactionId: string, outcome: typeof DECISION_NATIVE_OUTCOMES[keyof typeof DECISION_NATIVE_OUTCOMES]): unknown;
  getMessage(messageId: string): DecisionMessage | null;
  listDecisionPendingWork(): DecisionClick[];
}

export interface DecisionProjectionInput {
  click: DecisionClick;
  presentation: DecisionPresentation;
  answer: string;
}

export interface DecisionConsumerOptions {
  state: DecisionConsumerState;
  interactionFetch?: InteractionFetch;
  callbackTimeoutMs?: number;
  waitForDispatch?: (channelId: string, signal?: AbortSignal) => Promise<boolean>;
  processAccepted?: (message: DecisionMessage, signal?: AbortSignal, options?: Record<string, unknown>) => Promise<unknown>;
  project?: (input: DecisionProjectionInput, signal?: AbortSignal) => Promise<unknown>;
  resolveRoute?: typeof resolveCanonicalRoute;
  runCanonical?: typeof runCanonicalOperation;
}

export interface DecisionConsumerResult {
  handled: true;
  accepted: boolean;
  duplicate?: boolean;
  continuing?: boolean;
  reason?: DecisionReason;
  click?: DecisionClick | null;
  callback?: InteractionCallbackResult;
  canonical?: DecisionCanonicalResult | null;
  message?: DecisionMessage | null;
  native?: unknown;
}

interface CanonicalPayload {
  [key: string]: unknown;
}

interface CanonicalWinner {
  source: string;
  materialized: boolean;
}

interface CanonicalRead {
  source: 'current' | 'history';
  reference: string;
  answer: string;
}

const DECISION_ANSWER_LIMIT = 10000;
const DECISION_REFERENCE_LIMIT = 512;

function record(value: unknown): CanonicalPayload | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as CanonicalPayload
    : null;
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000\u007f]/.test(value);
}

function provider(value: unknown): value is AgentProvider {
  return Object.values(PROVIDERS).includes(value as AgentProvider);
}

function bindingInput(value: DecisionBinding | null): DecisionBindingInput | null {
  if (!value || value.active !== true || value.readiness !== 'ready' || !provider(value.provider)) return null;
  return { ...value, provider: value.provider, readiness: value.readiness as Readiness };
}

function transportOutcome(value: unknown): DecisionTransportOutcome {
  return Object.values(DECISION_TRANSPORT_OUTCOMES).includes(value as DecisionTransportOutcome)
    ? value as DecisionTransportOutcome
    : DECISION_TRANSPORT_OUTCOMES.UNKNOWN;
}

function canonicalReference(value: unknown, qid: string, generation: string): string | null {
  const candidate = record(value);
  const evidenceName = candidate?.evidence_name;
  if (!text(evidenceName, 256) || candidate?.qid !== qid || candidate?.question_generation !== generation) return null;
  const serialized = JSON.stringify({ qid, question_generation: generation, evidence_name: evidenceName });
  return serialized.length <= DECISION_REFERENCE_LIMIT ? serialized : null;
}

function routeEnvironment(route: DecisionPresentation['canonicalRoute']): NodeJS.ProcessEnv | null {
  if (!route || !text(route.executable, 4096) || !text(route.stateRoot, 4096) || !text(route.telegramRoot, 4096)) return null;
  return { TELEGRAM_ROOT: route.telegramRoot, TG_CANONICAL_STATE_ROOT: undefined };
}

function routeMatchesSaved(route: CanonicalRoute, saved: NonNullable<DecisionPresentation['canonicalRoute']>): boolean {
  return route.replay.executable === saved.executable && route.replay.stateRoot === saved.stateRoot &&
    route.replay.telegramRoot === saved.telegramRoot;
}

function canonicalWinner(payload: CanonicalPayload): CanonicalWinner | null {
  const winner = record(payload.winner);
  if (!winner || typeof winner.source !== 'string' || typeof winner.materialized !== 'boolean') return null;
  return { source: winner.source, materialized: winner.materialized };
}

function nativeOutcomeFor(message: DecisionMessage | null, dispatchResult: unknown): typeof DECISION_NATIVE_OUTCOMES[keyof typeof DECISION_NATIVE_OUTCOMES] | null {
  if (!message) return null;
  if ([MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLY_READY, MESSAGE_STATES.REPLYING, MESSAGE_STATES.REPLIED].includes(message.state)) {
    return DECISION_NATIVE_OUTCOMES.SUBMITTED;
  }
  const result = record(dispatchResult);
  if (result?.status === DISPATCH_OUTCOMES.NOT_SUBMITTED || message.state === MESSAGE_STATES.ACCEPTED) return DECISION_NATIVE_OUTCOMES.NOT_SUBMITTED;
  if (message.state === MESSAGE_STATES.UNCERTAIN || message.state === MESSAGE_STATES.DISPATCHING) return DECISION_NATIVE_OUTCOMES.IN_FLIGHT;
  return null;
}

function safeMessage(state: DecisionConsumerState, messageId: string): DecisionMessage | null {
  try { return state.getMessage(messageId); } catch { return null; }
}

function validatedRead(payload: CanonicalPayload, presentation: DecisionPresentation): CanonicalRead | null {
  if (payload.ok !== true || payload.operation !== CANONICAL_OPERATIONS.READ ||
    payload.qid !== presentation.qid || payload.question_generation !== presentation.questionGeneration) return null;
  const source = payload.source === DECISION_WINNER_SOURCES.CURRENT
    ? DECISION_WINNER_SOURCES.CURRENT
    : payload.source === DECISION_WINNER_SOURCES.HISTORY
      ? DECISION_WINNER_SOURCES.HISTORY
      : null;
  if (!source) return null;
  const reference = canonicalReference({
    qid: payload.qid,
    question_generation: payload.question_generation,
    evidence_name: payload.evidence_name
  }, presentation.qid, presentation.questionGeneration);
  const answerRecord = record(payload.answer);
  const answer = answerRecord?.answer;
  if (!reference || !text(answer, DECISION_ANSWER_LIMIT) || answerRecord?.qid !== presentation.qid ||
    answerRecord?.question_generation !== presentation.questionGeneration || answerRecord?.target !== presentation.target) return null;
  return { source, reference, answer };
}

function invalidResult(reason: DecisionReason = DECISION_REASONS.INVALID_DECISION_INTERACTION): DecisionConsumerResult {
  return { handled: true, accepted: false, reason };
}

export function parseDecisionComponent(input: unknown, expectedApplicationId: string | null = null): ParsedComponentInteraction | null {
  return parseComponentInteraction(input, expectedApplicationId);
}

export function createDecisionConsumer(options: DecisionConsumerOptions) {
  const state = options.state;
  const interactionFetch = options.interactionFetch;
  const callbackTimeoutMs = options.callbackTimeoutMs;
  const resolveRoute = options.resolveRoute || resolveCanonicalRoute;
  const runCanonical = options.runCanonical || runCanonicalOperation;

  async function routeFor(presentation: DecisionPresentation, signal?: AbortSignal): Promise<CanonicalRoute | null> {
    const saved = presentation.canonicalRoute;
    const environment = routeEnvironment(saved);
    if (!saved || !environment) return null;
    const route = await resolveRoute({ executable: saved.executable, stateRoot: saved.stateRoot, environment, signal });
    return routeMatchesSaved(route, saved) ? route : null;
  }

  async function settleAndRead(click: DecisionClick, presentation: DecisionPresentation, signal?: AbortSignal): Promise<DecisionCanonicalResult | null> {
    let current = click;
    if (current.canonical?.materialized && current.canonical.source !== DECISION_WINNER_SOURCES.CLAIM) return current.canonical;
    const route = await routeFor(presentation, signal);
    if (!route) return null;
    if (!current.canonical || current.canonical.source === DECISION_WINNER_SOURCES.CLAIM) {
      const settle = await runCanonical(route, CANONICAL_OPERATIONS.SETTLE, {
        qid: presentation.qid,
        generation: presentation.questionGeneration,
        target: presentation.target,
        selected: current.selectedKey,
        provenance: `discord:${current.interactionId}`
      }, { signal, environment: route.replay.environment });
      if (settle.status !== CANONICAL_RUN_STATUSES.COMPLETE || settle.payload?.ok !== true) return current.canonical;
      const winner = canonicalWinner(settle.payload);
      const reference = canonicalReference(settle.payload.canonical_reference, presentation.qid, presentation.questionGeneration);
      if (winner?.source === DECISION_WINNER_SOURCES.CLAIM && winner?.materialized === false && reference && !current.canonical) {
        const claim = state.importDecisionWinner(current.interactionId, {
          qid: presentation.qid,
          questionGeneration: presentation.questionGeneration,
          target: presentation.target,
          source: DECISION_WINNER_SOURCES.CLAIM,
          materialized: false,
          reference
        });
        if (!claim.accepted && !claim.duplicate) return null;
        current = state.getDecisionClick(current.interactionId) || current;
      }
    }
    const read = await runCanonical(route, CANONICAL_OPERATIONS.READ, {
      qid: presentation.qid,
      generation: presentation.questionGeneration
    }, { signal, environment: route.replay.environment });
    if (read.status !== CANONICAL_RUN_STATUSES.COMPLETE || read.payload?.ok !== true) return current.canonical;
    const winner = validatedRead(read.payload, presentation);
    if (!winner) return null;
    const imported = state.importDecisionWinner(current.interactionId, {
      qid: presentation.qid,
      questionGeneration: presentation.questionGeneration,
      target: presentation.target,
      source: winner.source,
      materialized: true,
      reference: winner.reference,
      answer: winner.answer
    });
    if (!imported.accepted && !imported.duplicate) return null;
    return imported.click?.canonical || state.getDecisionClick(current.interactionId)?.canonical || null;
  }

  async function project(click: DecisionClick, presentation: DecisionPresentation, signal?: AbortSignal): Promise<void> {
    if (click.projectionOutcome || !click.canonical?.materialized || !click.canonical.answer) return;
    if (typeof options.project !== 'function') {
      state.recordDecisionProjectionOutcome(click.interactionId, DECISION_TRANSPORT_OUTCOMES.NOT_SENT);
      return;
    }
    try {
      await options.project({ click, presentation, answer: click.canonical.answer }, signal);
      state.recordDecisionProjectionOutcome(click.interactionId, DECISION_TRANSPORT_OUTCOMES.SENT);
    } catch (error) {
      const outcome = transportOutcome((error as { outcome?: unknown })?.outcome);
      state.recordDecisionProjectionOutcome(click.interactionId, outcome);
    }
  }

  async function native(click: DecisionClick, signal?: AbortSignal): Promise<unknown> {
    const message = safeMessage(state, click.interactionId);
    if (!message || !options.processAccepted || click.nativeReturn?.outcome === DECISION_NATIVE_OUTCOMES.SUBMITTED ||
      click.nativeReturn?.outcome === DECISION_NATIVE_OUTCOMES.NOT_SUBMITTED ||
      click.nativeReturn?.outcome === DECISION_NATIVE_OUTCOMES.REJECTED) return message;
    const result = await options.processAccepted(message, signal, { continueUntilFinal: false, awaitDispatchOutcome: true });
    const refreshed = safeMessage(state, click.interactionId);
    const outcome = nativeOutcomeFor(refreshed, result);
    if (outcome) {
      try { state.recordDecisionNativeReturnOutcome(click.interactionId, outcome); } catch (error) {
        if (!/native-outcome-conflict/.test(String((error as Error)?.message || error))) throw error;
      }
    }
    return result;
  }

  async function continueClick(click: DecisionClick, signal?: AbortSignal): Promise<DecisionConsumerResult> {
    const presentation = state.getDecisionPresentation(click.presentationId);
    if (!presentation) return invalidResult(DECISION_REASONS.UNKNOWN_PRESENTATION);
    let current = state.getDecisionClick(click.interactionId) || click;
    let canonical: DecisionCanonicalResult | null = null;
    try {
      canonical = await settleAndRead(current, presentation, signal);
      current = state.getDecisionClick(click.interactionId) || current;
    } catch {
      return { handled: true, accepted: true, click: current, canonical: current.canonical, message: safeMessage(state, click.interactionId) };
    }
    if (!canonical && !current.canonical) return { ...invalidResult(DECISION_REASONS.CANONICAL_RESULT_CONFLICT), click: current };
    if (current.canonical?.source === DECISION_WINNER_SOURCES.CLAIM && !current.canonical.materialized) {
      return { handled: true, accepted: true, click: current, canonical: current.canonical, message: null };
    }
    await project(current, presentation, signal);
    current = state.getDecisionClick(click.interactionId) || current;
    const nativeResult = await native(current, signal);
    return { handled: true, accepted: true, click: state.getDecisionClick(click.interactionId) || current, canonical: current.canonical, message: safeMessage(state, click.interactionId), native: nativeResult };
  }

  async function handleParsed(parsed: ParsedComponentInteraction, signal?: AbortSignal): Promise<DecisionConsumerResult> {
    const decoded = decodeDecisionCustomId(parsed.customId);
    if (!decoded) return invalidResult(DECISION_REASONS.INVALID_DECISION_INTERACTION);
    const presentation = state.getDecisionPresentation(decoded.presentationId);
    if (!presentation) return invalidResult(DECISION_REASONS.UNKNOWN_PRESENTATION);
    const binding = bindingInput(state.getBinding(parsed.channelId));
    const selectedKey = presentation.keys[decoded.selectedIndex];
    if (!binding || !selectedKey) return invalidResult(DECISION_REASONS.PRESENTATION_IDENTITY_MISMATCH);
    const admission = state.admitDecisionClickAndBeginCallback({
      interactionId: parsed.id,
      presentationId: presentation.presentationId,
      selectedKey,
      actorId: parsed.userId,
      guildId: parsed.guildId,
      channelId: parsed.channelId,
      messageId: parsed.messageId,
      binding
    });
    if (!admission.accepted && !(admission.duplicate && admission.continuing && admission.click)) {
      return { ...invalidResult(admission.reason || DECISION_REASONS.INVALID_DECISION_INTERACTION), duplicate: admission.duplicate, click: admission.click };
    }
    let callback: InteractionCallbackResult | undefined;
    if (admission.accepted) {
      callback = await sendComponentCallback(parsed, { signal, fetchImpl: interactionFetch, timeoutMs: callbackTimeoutMs });
      state.recordDecisionCallbackOutcome(parsed.id, transportOutcome(callback.outcome));
    }
    const click = state.getDecisionClick(parsed.id) || admission.click;
    if (!click) return invalidResult(DECISION_REASONS.UNKNOWN_INTERACTION);
    if (options.waitForDispatch && !await options.waitForDispatch(click.channelId, signal)) {
      return {
        handled: true,
        accepted: true,
        duplicate: admission.duplicate,
        continuing: admission.continuing,
        click,
        message: safeMessage(state, click.interactionId),
        ...(callback ? { callback } : {})
      };
    }
    const continuation = await continueClick(click, signal);
    return { ...continuation, duplicate: admission.duplicate, continuing: admission.continuing, ...(callback ? { callback } : {}) };
  }

  async function handle(input: unknown, expectedApplicationId: string | null = null, signal?: AbortSignal): Promise<DecisionConsumerResult | null> {
    const parsed = parseDecisionComponent(input, expectedApplicationId);
    return parsed ? handleParsed(parsed, signal) : null;
  }

  async function recover(signal?: AbortSignal, channelIds: Set<string> | null = null): Promise<DecisionClick[]> {
    const pending = state.listDecisionPendingWork().filter(click => !channelIds || channelIds.has(click.channelId));
    const remaining: DecisionClick[] = [];
    for (const pendingClick of pending) {
      if (signal?.aborted) { remaining.push(pendingClick); continue; }
      if (!bindingInput(state.getBinding(pendingClick.channelId))) {
        remaining.push(pendingClick);
        continue;
      }
      const stored = safeMessage(state, pendingClick.interactionId);
      if (stored?.decisionResult && pendingClick.projectionOutcome) continue;
      try {
        const result = await continueClick(pendingClick, signal);
        if (result.click && state.listDecisionPendingWork().some(click => click.interactionId === pendingClick.interactionId)) {
          remaining.push(result.click);
        }
      } catch {
        remaining.push(pendingClick);
      }
    }
    return remaining;
  }

  return { handle, handleParsed, recover };
}
