import { PROVIDERS } from '../src/agent-message';
import type { AgentProvider } from '../src/agent-message';
import type { Readiness } from '../src/topic';
import {
  createDecisionHandlers,
  DECISION_NATIVE_OUTCOMES,
  DECISION_STATES,
  DECISION_REASONS,
  DECISION_TRANSPORT_OUTCOMES,
  DECISION_WINNER_SOURCES,
  type DecisionBinding,
  type DecisionBindingInput,
  type DecisionCanonicalResult,
  type DecisionCanonicalRoute,
  type DecisionClickAdmission,
  type DecisionInteractionInput,
  type DecisionNativeReturn,
  type DecisionPresentationInput,
  type DecisionPresentationLookupInput,
  type DecisionResult,
  type DecisionReason,
  type DecisionStateStore
} from '../src/state/decision';
import type { InteractionMessage } from '../src/state/interaction';
import type { DecisionRequest } from '../src/decision-present';

const binding: DecisionBindingInput = {
  active: true,
  readiness: 'ready',
  channelId: 'channel-id',
  guildId: 'guild-id',
  provider: PROVIDERS.CODEX,
  nativeId: '9caa5d21-2169-429d-918b-5f08651b5dbd',
  workspace: '/tmp/decision-types',
  sessionRoot: null,
  endpoint: null,
  conductorId: null,
  repoKey: null,
  generation: 7
};

const presentation: DecisionPresentationInput = {
  presentationId: 'presentation-id',
  requestId: 'request-id',
  qid: 'owner-question-id',
  questionGeneration: 'owner-question-generation',
  target: 'owner-target',
  guildId: binding.guildId,
  channelId: binding.channelId,
  binding,
  keys: ['approve', 'decline']
};

const canonicalRoute: DecisionCanonicalRoute = {
  executable: '/tmp/decision-canonical/tg-canonical.mjs',
  stateRoot: '/tmp/decision-canonical/state',
  telegramRoot: '/tmp/decision-canonical/telegram'
};
const producerPresentation: DecisionPresentationInput = {
  ...presentation,
  canonicalRoute,
  content: 'Promote this canonical answer?'
};
void producerPresentation;

const producerRequest: DecisionRequest = {
  namespace: 'decision-types',
  requestId: 'request-id',
  target: 'target',
  question: 'Promote this answer?',
  menu: ['approve', 'decline'],
  channelId: binding.channelId,
  provider: PROVIDERS.CODEX,
  nativeId: binding.nativeId,
  generation: binding.generation
};
void producerRequest;

const producerLookup: DecisionPresentationLookupInput = {
  namespace: producerRequest.namespace,
  requestId: producerRequest.requestId,
  channelId: producerRequest.channelId,
  provider: producerRequest.provider,
  nativeId: producerRequest.nativeId,
  generation: producerRequest.generation
};
void producerLookup;

// @ts-expect-error decision requests use the existing AgentProvider vocabulary
const invalidProducerProvider: DecisionRequest = { ...producerRequest, provider: 'spark' };
void invalidProducerProvider;

// @ts-expect-error decision requests keep binding generation numeric
const invalidProducerGeneration: DecisionRequest = { ...producerRequest, generation: '7' };
void invalidProducerGeneration;

const winner: DecisionCanonicalResult = {
  qid: presentation.qid,
  questionGeneration: presentation.questionGeneration,
  target: presentation.target,
  source: DECISION_WINNER_SOURCES.HISTORY,
  materialized: true,
  reference: 'answer-reference',
  answer: 'saved answer'
};

const nativeReturn: DecisionNativeReturn = {
  qid: winner.qid,
  questionGeneration: winner.questionGeneration,
  target: winner.target,
  provider: binding.provider,
  nativeId: binding.nativeId,
  generation: binding.generation,
  channelId: binding.channelId,
  guildId: binding.guildId,
  workspace: binding.workspace,
  conductorId: binding.conductorId,
  repoKey: binding.repoKey,
  canonicalReference: winner.reference,
  state: DECISION_STATES.NATIVE_RETURN_PENDING,
  outcome: DECISION_NATIVE_OUTCOMES.IN_FLIGHT
};

const handlers = createDecisionHandlers();
const store = null as unknown as DecisionStateStore;
void handlers.registerPresentation(store, presentation);
void handlers.admitClickAndBeginCallback(store, {
  interactionId: 'interaction-id',
  presentationId: presentation.presentationId,
  selectedKey: 'approve',
  actorId: 'operator-id',
  guildId: binding.guildId,
  channelId: binding.channelId,
  messageId: 'message-id',
  binding
});
void handlers.importWinner(store, 'interaction-id', winner);
void handlers.recordCallbackOutcome(store, 'interaction-id', DECISION_TRANSPORT_OUTCOMES.UNKNOWN);
void nativeReturn;

const canonicalGeneration: string = presentation.questionGeneration;
const nativeGeneration: number = binding.generation;
void canonicalGeneration;
void nativeGeneration;

// @ts-expect-error canonical question generation is opaque text
const invalidPresentation: DecisionPresentationInput = { ...presentation, questionGeneration: 2 };
void invalidPresentation;

// @ts-expect-error canonical result must keep question generation separate from binding generation
const invalidWinner: DecisionCanonicalResult = { ...winner, questionGeneration: 2 };
void invalidWinner;

// @ts-expect-error decision bindings use the existing AgentProvider vocabulary
const invalidBindingProvider: DecisionBindingInput = { ...binding, provider: 'spark' };
void invalidBindingProvider;

// @ts-expect-error decision binding inputs use the existing Readiness vocabulary
const invalidBindingReadiness: DecisionBindingInput = { ...binding, readiness: 'online' };
void invalidBindingReadiness;

const rawBinding: DecisionBinding = { ...binding, active: true, provider: 'legacy-provider', readiness: 'legacy-readiness' };
// @ts-expect-error raw binding provider remains string until a runtime validation boundary
const unvalidatedProvider: AgentProvider = rawBinding.provider;
void unvalidatedProvider;
// @ts-expect-error raw binding readiness remains string until a runtime validation boundary
const unvalidatedReadiness: Readiness | null = rawBinding.readiness;
void unvalidatedReadiness;

const rawNativeReturn: DecisionNativeReturn = { ...nativeReturn, provider: 'legacy-provider' };
// @ts-expect-error raw native-return provider remains string until a runtime validation boundary
const unvalidatedNativeProvider: AgentProvider = rawNativeReturn.provider;
void unvalidatedNativeProvider;

const decisionResult: DecisionResult = {
  qid: winner.qid,
  questionGeneration: winner.questionGeneration,
  target: winner.target,
  canonicalSource: DECISION_WINNER_SOURCES.HISTORY,
  canonicalReference: winner.reference,
  answer: winner.answer || 'saved answer',
  questionMessageId: 'question-message-id',
  interactionId: 'interaction-id',
  selectedKey: 'approve'
};

const decisionMessage: InteractionMessage = {
  id: decisionResult.interactionId,
  guildId: binding.guildId,
  channelId: binding.channelId,
  authorId: 'operator-id',
  content: decisionResult.answer,
  provider: binding.provider,
  nativeId: binding.nativeId,
  workspace: binding.workspace,
  endpoint: binding.endpoint,
  conductorId: binding.conductorId,
  repoKey: binding.repoKey,
  generation: binding.generation,
  state: 'accepted',
  decisionResult
};
void decisionMessage;

// @ts-expect-error decision result question generation remains opaque text
const invalidDecisionResult: DecisionResult = { ...decisionResult, questionGeneration: 2 };
void invalidDecisionResult;

const knownReason: DecisionReason = DECISION_REASONS.CANONICAL_RESULT_CONFLICT;
void knownReason;

// @ts-expect-error decision result reasons use the closed domain vocabulary
const invalidDecisionReason: DecisionClickAdmission = { accepted: false, reason: 'made-up-reason', click: null };
void invalidDecisionReason;

const nativeInteraction: DecisionInteractionInput = {
  interactionId: 'interaction-id',
  presentationId: presentation.presentationId,
  selectedKey: 'approve',
  actorId: 'operator-id',
  guildId: binding.guildId,
  channelId: binding.channelId,
  questionMessageId: 'question-message-id',
  binding: rawBinding,
  qid: winner.qid,
  questionGeneration: winner.questionGeneration,
  target: winner.target,
  canonicalSource: DECISION_WINNER_SOURCES.HISTORY,
  canonicalReference: winner.reference,
  answer: 'saved answer'
};
void store.acceptDecisionInteraction(nativeInteraction, { inTransaction: true });

// @ts-expect-error claim-only results cannot reach the materialized native bridge
const invalidNativeInteraction: DecisionInteractionInput = { ...nativeInteraction, canonicalSource: DECISION_WINNER_SOURCES.CLAIM };
void invalidNativeInteraction;
