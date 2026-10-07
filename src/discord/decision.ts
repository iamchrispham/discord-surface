import { PROVIDERS, type AgentProvider } from '../agent-message';
import {
  decodeDecisionCustomId,
  parseComponentInteraction,
  sendComponentCallback,
  sendInteractionFollowup,
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
  DECISION_AUTHORIZATION_OUTCOMES,
  DECISION_REASONS,
  DECISION_STATES,
  DECISION_TRANSPORT_OUTCOMES,
  DECISION_WINNER_SOURCES,
  type DecisionBinding,
  type DecisionAuthorizationOutcome,
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

const DECISION_EMBED_DESCRIPTION_LIMIT = 4096;
const DISCORD_MESSAGE_CONTENT_LIMIT = 2000;
const DECISION_RECOVERY_DEFAULT_DELAY_MS = 1000;
const DECISION_PROJECTION_RETRY_MAX_DELAY_MS = 30_000;
const DECISION_PROJECTION_RETRY_LIMIT = 5;

function decisionRecoveryDelayMs(value: unknown): number {
  const delay = Number(value);
  return Number.isFinite(delay) && delay >= 0 ? Math.ceil(delay) : DECISION_RECOVERY_DEFAULT_DELAY_MS;
}

function projectionOutcomeRetryable(outcome: DecisionTransportOutcome | null): boolean {
  return outcome === null || outcome === DECISION_TRANSPORT_OUTCOMES.NOT_SENT ||
    outcome === DECISION_TRANSPORT_OUTCOMES.RATE_LIMITED || outcome === DECISION_TRANSPORT_OUTCOMES.UNKNOWN;
}

export function renderDecisionProjection(
  presentation: Pick<DecisionPresentation, 'content'>,
  answer: string,
  { embed = true, attach = answer.length > DECISION_EMBED_DESCRIPTION_LIMIT } = {}
) {
  const inline = answer.length <= DECISION_EMBED_DESCRIPTION_LIMIT;
  const file = attach || !inline;
  const promptContent = presentation.content || '';
  const promptSeparator = promptContent.length > 0 ? '\n\n' : '';
  const fileFallbackContent = `${promptContent}${promptSeparator}Selected action is attached in selected-action.txt.`;
  let fallbackContent = `${promptContent}${promptSeparator}Selected action:\n${answer}`;
  if (file) fallbackContent = fileFallbackContent.length <= DISCORD_MESSAGE_CONTENT_LIMIT ? fileFallbackContent : promptContent;
  const content = embed ? presentation.content : fallbackContent;
  const embedDescription = inline && !file ? answer : 'Full answer attached in selected-action.txt.';
  return {
    content,
    embeds: embed ? [{ title: 'Selected action', description: embedDescription }] : [],
    components: [],
    attachments: [],
    allowedMentions: { parse: [] },
    ...(file ? { files: [{ attachment: Buffer.from(answer, 'utf8'), name: 'selected-action.txt' }] } : {})
  };
}

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
    applicationId?: string;
    token?: string;
  }): {
    accepted: boolean;
    duplicate?: boolean;
    continuing?: boolean;
    reason?: DecisionReason;
    click: DecisionClick | null;
  };
  admitDecisionClickAndBeginAuthorization(input: {
    interactionId: string;
    presentationId: string;
    selectedKey: string;
    actorId: string;
    guildId: string;
    channelId: string;
    messageId: string;
    binding: DecisionBindingInput;
    applicationId?: string;
    token?: string;
  }): {
    accepted: boolean;
    duplicate?: boolean;
    continuing?: boolean;
    reason?: DecisionReason;
    click: DecisionClick | null;
  };
  recordDecisionAuthorizationOutcome(interactionId: string, outcome: DecisionAuthorizationOutcome): unknown;
  beginDecisionRejectionFollowup(interactionId: string): unknown;
  recordDecisionRejectionOutcome(interactionId: string, outcome: DecisionTransportOutcome): unknown;
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

export interface DecisionAuthorizationInput {
  channelId: string;
  guildId: string;
}

export interface DecisionConsumerOptions {
  state: DecisionConsumerState;
  interactionFetch?: InteractionFetch;
  callbackTimeoutMs?: number;
  authorize?: (input: DecisionAuthorizationInput, signal?: AbortSignal) => Promise<boolean | null>;
  reject?: (interaction: ParsedComponentInteraction, reason: DecisionReason, signal?: AbortSignal, deferred?: boolean) => Promise<InteractionCallbackResult>;
  scheduleRecovery?: (channelIds: Set<string>, options?: { deferIfActive?: boolean; delayMs?: number; decisionId?: string }) => unknown;
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

function isTerminalDiscordProjectionError(error: unknown): boolean {
  const candidate = record(error);
  const rawError = record(candidate?.rawError);
  const code = candidate?.code ?? rawError?.code;
  const status = candidate?.status ?? candidate?.statusCode ?? rawError?.status ?? rawError?.statusCode;
  const message = candidate?.message ?? rawError?.message;
  return String(code) === '10008' || String(code) === '10003' ||
    (Number(status) === 404 && typeof message === 'string' &&
      ['unknown message', 'unknown channel'].includes(message.toLowerCase()));
}

function projectionErrorOutcome(error: unknown): DecisionTransportOutcome {
  const candidate = record(error);
  if (isTerminalDiscordProjectionError(error)) return DECISION_TRANSPORT_OUTCOMES.REJECTED;
  if (candidate && 'outcome' in candidate) return transportOutcome(candidate.outcome);
  return DECISION_TRANSPORT_OUTCOMES.UNKNOWN;
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

function authorizationRejectionMessage(reason: DecisionReason): string {
  return reason === DECISION_REASONS.PRESENTATION_NOT_ADMISSIBLE
    ? 'This decision cannot be accepted in this channel.'
    : 'This decision is no longer available.';
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
  const callbackWaiters = new Map<string, Promise<void>>();
  const decisionRecoveryDeadlines = new Map<string, number>();

  function scheduleRecovery(
    channelIds: Set<string>,
    recoveryOptions: { deferIfActive?: boolean; delayMs?: number; decisionId?: string } | undefined = undefined
  ): unknown {
    const decisionId = recoveryOptions?.decisionId;
    if (typeof decisionId === 'string' && decisionId.length > 0) {
      const delay = Number(recoveryOptions?.delayMs);
      if (Number.isFinite(delay) && delay > 0) {
        decisionRecoveryDeadlines.set(decisionId, Date.now() + Math.ceil(delay));
      } else {
        decisionRecoveryDeadlines.delete(decisionId);
      }
    }
    return options.scheduleRecovery?.(channelIds, recoveryOptions);
  }

  function pendingRecoveryDelay(decisionId: string): number {
    const retryDeadline = decisionRecoveryDeadlines.get(decisionId);
    if (retryDeadline === undefined) return 0;
    const remainingDelay = retryDeadline - Date.now();
    if (remainingDelay > 0) return remainingDelay;
    decisionRecoveryDeadlines.delete(decisionId);
    return 0;
  }

  async function authorizationAllowed(input: DecisionAuthorizationInput, signal?: AbortSignal): Promise<boolean | null> {
    if (typeof options.authorize !== 'function') return true;
    try {
      const result = await options.authorize(input, signal);
      return typeof result === 'boolean' ? result : null;
    } catch { return null; }
  }

  function authorizationTransition(interactionId: string, outcome: DecisionAuthorizationOutcome): { outcome: DecisionAuthorizationOutcome | null; click: DecisionClick | null } {
    let transition: { click?: DecisionClick | null } | null = null;
    try { transition = state.recordDecisionAuthorizationOutcome(interactionId, outcome) as { click?: DecisionClick | null }; } catch {}
    const click = transition?.click || state.getDecisionClick(interactionId);
    return { outcome: click?.authorizationOutcome || null, click };
  }

  async function awaitCallbackOutcome(click: DecisionClick): Promise<DecisionClick> {
    let current = state.getDecisionClick(click.interactionId) || click;
    if (!current.callbackAttempted || current.callbackOutcome) return current;
    const waiter = callbackWaiters.get(current.interactionId);
    if (waiter) {
      try { await waiter; } catch {}
      current = state.getDecisionClick(current.interactionId) || current;
    }
    return current;
  }

  function rejectionInteraction(click: DecisionClick): ParsedComponentInteraction | null {
    if (!click.applicationId || !click.token) return null;
    return {
      id: click.interactionId,
      guildId: click.guildId,
      channelId: click.channelId,
      userId: click.actorId,
      token: click.token,
      applicationId: click.applicationId,
      messageId: click.messageId,
      componentType: 2,
      customId: '',
      presentationId: click.presentationId
    };
  }

  async function deliverRejection(click: DecisionClick, signal?: AbortSignal, interaction: ParsedComponentInteraction | null = null): Promise<InteractionCallbackResult | null> {
    click = await awaitCallbackOutcome(click);
    if (!click.callbackOutcome) {
      if (!signal?.aborted) scheduleRecovery(new Set([click.channelId]), { decisionId: click.interactionId });
      return null;
    }
    if (click.callbackOutcome !== DECISION_TRANSPORT_OUTCOMES.SENT) {
      const begin = state.beginDecisionRejectionFollowup(click.interactionId) as { accepted?: boolean };
      if (!begin.accepted) return null;
      const outcome = click.callbackOutcome === DECISION_TRANSPORT_OUTCOMES.REJECTED
        ? DECISION_TRANSPORT_OUTCOMES.REJECTED
        : DECISION_TRANSPORT_OUTCOMES.UNKNOWN;
      try {
        state.recordDecisionRejectionOutcome(click.interactionId, outcome);
      } catch {}
      return null;
    }
    const remainingDelay = pendingRecoveryDelay(click.interactionId);
    if (remainingDelay > 0) {
      if (!signal?.aborted) scheduleRecovery(new Set([click.channelId]), { delayMs: remainingDelay, decisionId: click.interactionId });
      return null;
    }
    const begin = state.beginDecisionRejectionFollowup(click.interactionId) as { accepted?: boolean; click?: DecisionClick | null };
    if (!begin.accepted) return null;
    const target = rejectionInteraction(click) || interaction;
    let result: InteractionCallbackResult;
    if (!target) {
      result = { outcome: DECISION_TRANSPORT_OUTCOMES.NOT_SENT, reason: 'decision rejection interaction custody is unavailable' };
    } else {
      try {
        result = options.reject
          ? await options.reject(target, DECISION_REASONS.PRESENTATION_NOT_ADMISSIBLE, signal, true)
          : await sendInteractionFollowup(target, {
            signal,
            fetchImpl: interactionFetch,
            content: authorizationRejectionMessage(DECISION_REASONS.PRESENTATION_NOT_ADMISSIBLE),
            timeoutMs: callbackTimeoutMs
          });
      } catch (error) {
        result = { outcome: DECISION_TRANSPORT_OUTCOMES.UNKNOWN, reason: String((error as Error)?.message || error).slice(0, 200) };
      }
    }
    const outcome = transportOutcome(result.outcome);
    const retryDelayMs = outcome === DECISION_TRANSPORT_OUTCOMES.RATE_LIMITED
      ? decisionRecoveryDelayMs(result.retryAfterMs)
      : DECISION_RECOVERY_DEFAULT_DELAY_MS;
    const retryFirstUnknown = outcome === DECISION_TRANSPORT_OUTCOMES.UNKNOWN && click.rejectionOutcome === null;
    const scheduleRetry = (outcome === DECISION_TRANSPORT_OUTCOMES.RATE_LIMITED || retryFirstUnknown) && !signal?.aborted;
    try { state.recordDecisionRejectionOutcome(click.interactionId, outcome); } catch {}
    if (scheduleRetry) {
      scheduleRecovery(new Set([click.channelId]), {
        ...(retryDelayMs > 0 ? { delayMs: retryDelayMs } : {}),
        decisionId: click.interactionId
      });
    }
    return result;
  }

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

  const projectionRetryAttempts = new Map<string, number>();

  async function project(click: DecisionClick, presentation: DecisionPresentation, signal?: AbortSignal): Promise<boolean> {
    if (click.projectionOutcome === DECISION_TRANSPORT_OUTCOMES.SENT || !click.canonical?.materialized || !click.canonical.answer) {
      projectionRetryAttempts.delete(click.interactionId);
      return true;
    }
    if (click.projectionOutcome && !projectionOutcomeRetryable(click.projectionOutcome)) {
      projectionRetryAttempts.delete(click.interactionId);
      return false;
    }
    if (typeof options.project !== 'function') {
      if (click.canonical.answer.length <= DECISION_EMBED_DESCRIPTION_LIMIT) {
        projectionRetryAttempts.delete(click.interactionId);
        return true;
      }
      state.recordDecisionProjectionOutcome(click.interactionId, DECISION_TRANSPORT_OUTCOMES.NOT_SENT);
      projectionRetryAttempts.delete(click.interactionId);
      return false;
    }
    try {
      await options.project({ click, presentation, answer: click.canonical.answer }, signal);
      const recorded = state.recordDecisionProjectionOutcome(click.interactionId, DECISION_TRANSPORT_OUTCOMES.SENT) as { click?: DecisionClick | null };
      const sent = recorded.click?.projectionOutcome === DECISION_TRANSPORT_OUTCOMES.SENT ||
        state.getDecisionClick(click.interactionId)?.projectionOutcome === DECISION_TRANSPORT_OUTCOMES.SENT;
      if (sent) projectionRetryAttempts.delete(click.interactionId);
      return sent;
    } catch (error) {
      const outcome = projectionErrorOutcome(error);
      state.recordDecisionProjectionOutcome(click.interactionId, outcome);
      const retryable = outcome !== DECISION_TRANSPORT_OUTCOMES.NOT_SENT || (error as { retryable?: unknown })?.retryable === true;
      if (!signal?.aborted && retryable && projectionOutcomeRetryable(outcome)) {
        const attempts = (projectionRetryAttempts.get(click.interactionId) || 0) + 1;
        projectionRetryAttempts.set(click.interactionId, attempts);
        if (attempts <= DECISION_PROJECTION_RETRY_LIMIT) {
          const requestedDelay = decisionRecoveryDelayMs((error as { retryAfterMs?: unknown })?.retryAfterMs);
          const exponentialDelay = DECISION_RECOVERY_DEFAULT_DELAY_MS * (2 ** (attempts - 1));
          scheduleRecovery(new Set([click.channelId]), {
            decisionId: click.interactionId,
            delayMs: Math.min(DECISION_PROJECTION_RETRY_MAX_DELAY_MS, Math.max(requestedDelay, exponentialDelay))
          });
        }
      } else {
        projectionRetryAttempts.delete(click.interactionId);
      }
      return false;
    }
  }

  async function native(click: DecisionClick, signal?: AbortSignal, retryKnownUnsubmitted = false): Promise<unknown> {
    const message = safeMessage(state, click.interactionId);
    if (!message || !options.processAccepted || click.nativeReturn?.outcome === DECISION_NATIVE_OUTCOMES.SUBMITTED ||
      (click.nativeReturn?.outcome === DECISION_NATIVE_OUTCOMES.NOT_SUBMITTED && !retryKnownUnsubmitted) ||
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

  async function continueClick(click: DecisionClick, signal?: AbortSignal, { recovery = false } = {}): Promise<DecisionConsumerResult> {
    const presentation = state.getDecisionPresentation(click.presentationId);
    if (!presentation) return invalidResult(DECISION_REASONS.UNKNOWN_PRESENTATION);
    let current = state.getDecisionClick(click.interactionId) || click;
    if (current.state === DECISION_STATES.AUTHORIZATION_PENDING) {
      const allowed = await authorizationAllowed(current, signal);
      if (signal?.aborted || allowed === null) {
        if (allowed === null && !signal?.aborted) scheduleRecovery(new Set([current.channelId]), { deferIfActive: recovery, decisionId: current.interactionId });
        return { handled: true, accepted: true, click: current, canonical: current.canonical, message: safeMessage(state, current.interactionId) };
      }
      if (!allowed) {
        const transition = authorizationTransition(current.interactionId, DECISION_AUTHORIZATION_OUTCOMES.DENIED);
        if (transition.outcome === DECISION_AUTHORIZATION_OUTCOMES.AUTHORIZED) {
          current = state.getDecisionClick(current.interactionId) || current;
        } else if (transition.outcome === DECISION_AUTHORIZATION_OUTCOMES.DENIED) {
          await deliverRejection(transition.click || current, signal);
          return { handled: true, accepted: false, reason: DECISION_REASONS.PRESENTATION_NOT_ADMISSIBLE, click: null, message: safeMessage(state, current.interactionId) };
        } else {
          return { handled: true, accepted: true, click: current, canonical: current.canonical, message: safeMessage(state, current.interactionId) };
        }
      } else {
        const transition = authorizationTransition(current.interactionId, DECISION_AUTHORIZATION_OUTCOMES.AUTHORIZED);
        if (transition.outcome !== DECISION_AUTHORIZATION_OUTCOMES.AUTHORIZED) {
          if (transition.outcome === DECISION_AUTHORIZATION_OUTCOMES.DENIED) {
            await deliverRejection(transition.click || current, signal);
            return { handled: true, accepted: false, reason: DECISION_REASONS.PRESENTATION_NOT_ADMISSIBLE, click: null, message: safeMessage(state, current.interactionId) };
          }
          return { handled: true, accepted: true, click: current, canonical: current.canonical, message: safeMessage(state, current.interactionId) };
        }
        current = state.getDecisionClick(current.interactionId) || current;
      }
    }
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
    const projected = await project(current, presentation, signal);
    current = state.getDecisionClick(click.interactionId) || current;
    const retryKnownUnsubmitted = recovery && projected &&
      current.projectionOutcome === DECISION_TRANSPORT_OUTCOMES.SENT;
    const nativeResult = await native(current, signal, retryKnownUnsubmitted);
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
    const existing = state.getDecisionClick(parsed.id);
    const admission = existing ? state.admitDecisionClickAndBeginCallback({
      interactionId: parsed.id,
      presentationId: presentation.presentationId,
      selectedKey,
      actorId: parsed.userId,
      guildId: parsed.guildId,
      channelId: parsed.channelId,
      messageId: parsed.messageId,
      binding,
      applicationId: parsed.applicationId,
      token: parsed.token
    }) : state.admitDecisionClickAndBeginAuthorization({
      interactionId: parsed.id,
      presentationId: presentation.presentationId,
      selectedKey,
      actorId: parsed.userId,
      guildId: parsed.guildId,
      channelId: parsed.channelId,
      messageId: parsed.messageId,
      binding,
      applicationId: parsed.applicationId,
      token: parsed.token
    });
    if (!admission.accepted && !(admission.duplicate && admission.continuing && admission.click)) {
      return { ...invalidResult(admission.reason || DECISION_REASONS.INVALID_DECISION_INTERACTION), duplicate: admission.duplicate, click: admission.click };
    }
    let callback: InteractionCallbackResult | undefined;
    if (admission.accepted && !admission.duplicate) {
      const callbackWork = (async () => {
        let result: InteractionCallbackResult;
        try {
          result = await sendComponentCallback(parsed, { signal, fetchImpl: interactionFetch, timeoutMs: callbackTimeoutMs });
        } catch (error) {
          result = {
            outcome: DECISION_TRANSPORT_OUTCOMES.UNKNOWN,
            reason: String((error as Error)?.message || error).slice(0, 200)
          } as InteractionCallbackResult;
        }
        state.recordDecisionCallbackOutcome(parsed.id, transportOutcome(result.outcome));
        return result;
      })();
      const waiter = callbackWork.then(() => undefined);
      callbackWaiters.set(parsed.id, waiter);
      try {
        callback = await callbackWork;
      } finally {
        if (callbackWaiters.get(parsed.id) === waiter) callbackWaiters.delete(parsed.id);
      }
    }
    let click = state.getDecisionClick(parsed.id) || admission.click;
    if (!click) return invalidResult(DECISION_REASONS.UNKNOWN_INTERACTION);
    if (admission.duplicate && admission.continuing) {
      click = await awaitCallbackOutcome(click);
      if (click.callbackAttempted && !click.callbackOutcome) {
        scheduleRecovery(new Set([click.channelId]), { decisionId: click.interactionId });
        return {
          handled: true,
          accepted: true,
          duplicate: true,
          continuing: true,
          click,
          message: safeMessage(state, click.interactionId)
        };
      }
    }
    if (click.authorizationOutcome === DECISION_AUTHORIZATION_OUTCOMES.DENIED) {
      const rejection = await deliverRejection(click, signal, parsed);
      return {
        handled: true,
        accepted: false,
        reason: DECISION_REASONS.PRESENTATION_NOT_ADMISSIBLE,
        click: null,
        ...(rejection ? { callback: rejection } : callback ? { callback } : {})
      };
    }
    if (click.state === DECISION_STATES.AUTHORIZATION_PENDING) {
      const allowed = await authorizationAllowed(parsed, signal);
      if (signal?.aborted) {
        return {
          handled: true,
          accepted: true,
          click,
          message: safeMessage(state, click.interactionId),
          ...(callback ? { callback } : {})
        };
      }
      if (allowed === null) {
        scheduleRecovery(new Set([click.channelId]), { decisionId: click.interactionId });
        return {
          handled: true,
          accepted: true,
          click,
          message: safeMessage(state, click.interactionId),
          ...(callback ? { callback } : {})
        };
      }
      if (!allowed) {
        const transition = authorizationTransition(parsed.id, DECISION_AUTHORIZATION_OUTCOMES.DENIED);
        if (transition.outcome === DECISION_AUTHORIZATION_OUTCOMES.AUTHORIZED) {
          click = state.getDecisionClick(parsed.id) || click;
        } else if (transition.outcome === DECISION_AUTHORIZATION_OUTCOMES.DENIED) {
          const rejection = await deliverRejection(transition.click || click, signal, parsed);
          return {
            handled: true,
            accepted: false,
            reason: DECISION_REASONS.PRESENTATION_NOT_ADMISSIBLE,
            click: null,
            ...(rejection ? { callback: rejection } : callback ? { callback } : {})
          };
        } else {
          return {
            handled: true,
            accepted: true,
            click,
            message: safeMessage(state, click.interactionId),
            ...(callback ? { callback } : {})
          };
        }
      } else {
        const transition = authorizationTransition(parsed.id, DECISION_AUTHORIZATION_OUTCOMES.AUTHORIZED);
        if (transition.outcome === DECISION_AUTHORIZATION_OUTCOMES.DENIED) {
          const rejection = await deliverRejection(transition.click || click, signal, parsed);
          return {
            handled: true,
            accepted: false,
            reason: DECISION_REASONS.PRESENTATION_NOT_ADMISSIBLE,
            click: null,
            ...(rejection ? { callback: rejection } : callback ? { callback } : {})
          };
        }
        if (transition.outcome !== DECISION_AUTHORIZATION_OUTCOMES.AUTHORIZED) {
          return {
            handled: true,
            accepted: true,
            click,
            message: safeMessage(state, click.interactionId),
            ...(callback ? { callback } : {})
          };
        }
        click = state.getDecisionClick(parsed.id) || click;
      }
    }
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
    const allPending = state.listDecisionPendingWork();
    const pendingIds = new Set(allPending.map(click => click.interactionId));
    for (const decisionId of decisionRecoveryDeadlines.keys()) {
      if (!pendingIds.has(decisionId)) decisionRecoveryDeadlines.delete(decisionId);
    }
    const pending = allPending.filter(click => !channelIds || channelIds.has(click.channelId));
    const remaining: DecisionClick[] = [];
    for (let pendingClick of pending) {
      if (signal?.aborted) { remaining.push(pendingClick); continue; }
      const retryDeadline = decisionRecoveryDeadlines.get(pendingClick.interactionId);
      const enforceRetryDeadline = channelIds !== null;
      if (!enforceRetryDeadline && retryDeadline !== undefined) {
        decisionRecoveryDeadlines.delete(pendingClick.interactionId);
      }
      if (enforceRetryDeadline) {
        const remainingDelay = pendingRecoveryDelay(pendingClick.interactionId);
        if (remainingDelay > 0) {
          remaining.push(pendingClick);
          scheduleRecovery(new Set([pendingClick.channelId]), {
            delayMs: remainingDelay,
            decisionId: pendingClick.interactionId
          });
          continue;
        }
      }
      if (pendingClick.authorizationOutcome === DECISION_AUTHORIZATION_OUTCOMES.DENIED) {
        pendingClick = await awaitCallbackOutcome(pendingClick);
        if (pendingClick.callbackAttempted && !pendingClick.callbackOutcome) {
          remaining.push(pendingClick);
          continue;
        }
        try {
          await deliverRejection(pendingClick, signal);
        } catch {}
        if (state.listDecisionPendingWork().some(click => click.interactionId === pendingClick.interactionId)) remaining.push(pendingClick);
        continue;
      }
      if (!bindingInput(state.getBinding(pendingClick.channelId))) {
        remaining.push(pendingClick);
        continue;
      }
      const stored = safeMessage(state, pendingClick.interactionId);
      const projectionEnded = pendingClick.projectionOutcome === DECISION_TRANSPORT_OUTCOMES.SENT ||
        pendingClick.projectionOutcome === DECISION_TRANSPORT_OUTCOMES.REJECTED;
      if (stored?.decisionResult && projectionEnded) {
        const reconciledNativeOutcome = nativeOutcomeFor(stored, null);
        if (reconciledNativeOutcome && reconciledNativeOutcome !== pendingClick.nativeReturn?.outcome) {
          try {
            state.recordDecisionNativeReturnOutcome(pendingClick.interactionId, reconciledNativeOutcome);
            pendingClick = state.getDecisionClick(pendingClick.interactionId) || pendingClick;
          } catch (error) {
            if (!/native-outcome-conflict/.test(String((error as Error)?.message || error))) throw error;
          }
        }
        continue;
      }
      try {
        const result = await continueClick(pendingClick, signal, { recovery: true });
        const unresolved = state.listDecisionPendingWork().find(click => click.interactionId === pendingClick.interactionId);
        if (unresolved) {
          remaining.push(result.click || unresolved);
        }
      } catch {
        remaining.push(pendingClick);
      }
    }
    return remaining;
  }

  return { handle, handleParsed, recover };
}
