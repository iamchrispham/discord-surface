import type { AgentProvider } from '../../agent-message';
import type { Readiness } from '../../topic';

export const DECISION_JOURNAL = 'decision-v1' as const;

export const DECISION_STATES = {
  PRESENTATION_PENDING: 'presentation_pending',
  PRESENTED_UNANSWERED: 'presented_unanswered',
  CLICK_ADMITTED: 'click_admitted',
  CALLBACK_PENDING: 'callback_pending',
  CANONICAL_PENDING: 'canonical_pending',
  CLAIM_ONLY: 'claim_only',
  MATERIALIZED_PROJECTION_PENDING: 'materialized_projection_pending',
  NATIVE_RETURN_PENDING: 'native_return_pending',
  UNKNOWN: 'unknown',
  STALE: 'stale',
  TERMINAL: 'terminal',
  REFUSED: 'refused'
} as const;

export type DecisionState = (typeof DECISION_STATES)[keyof typeof DECISION_STATES];

export const DECISION_RECEIPT_KINDS = {
  PRESENTATION: 'decision-presentation',
  PRESENTATION_OUTCOME: 'decision-presentation-outcome',
  PRESENTATION_STALE: 'decision-presentation-stale',
  CLICK: 'decision-click',
  CALLBACK_ATTEMPT: 'decision-callback-attempt',
  CALLBACK_OUTCOME: 'decision-callback-outcome',
  CANONICAL_IMPORT: 'decision-canonical-import',
  PROJECTION_OUTCOME: 'decision-projection-outcome',
  NATIVE_RETURN: 'decision-native-return',
  NATIVE_OUTCOME: 'decision-native-outcome'
} as const;

export type DecisionReceiptKind = (typeof DECISION_RECEIPT_KINDS)[keyof typeof DECISION_RECEIPT_KINDS];

export const DECISION_TRANSPORT_OUTCOMES = {
  SENT: 'sent',
  NOT_SENT: 'not_sent',
  REJECTED: 'rejected',
  RATE_LIMITED: 'rate_limited',
  UNKNOWN: 'unknown'
} as const;

export type DecisionTransportOutcome = (typeof DECISION_TRANSPORT_OUTCOMES)[keyof typeof DECISION_TRANSPORT_OUTCOMES];

export const DECISION_WINNER_SOURCES = {
  CURRENT: 'current',
  HISTORY: 'history',
  CLAIM: 'claim'
} as const;

export type DecisionWinnerSource = (typeof DECISION_WINNER_SOURCES)[keyof typeof DECISION_WINNER_SOURCES];

export type MaterializedDecisionWinnerSource = Exclude<DecisionWinnerSource, typeof DECISION_WINNER_SOURCES.CLAIM>;

export interface DecisionCanonicalRoute {
  executable: string;
  stateRoot: string;
  telegramRoot: string;
}

export const DECISION_REASONS = {
  INVALID_DECISION_INTERACTION: 'invalid-decision-interaction',
  DUPLICATE_DECISION_INTERACTION: 'duplicate-decision-interaction',
  INTERACTION_ID_CONFLICT: 'interaction-id-conflict',
  INACTIVE_BINDING: 'inactive-binding',
  HANDOFF_INTAKE_PAUSED: 'handoff-intake-paused',
  UNKNOWN_BINDING: 'unknown-binding',
  BINDING_NOT_READY: 'binding-not-ready',
  DUPLICATE_INTERACTION_CONFLICT: 'duplicate-interaction-conflict',
  UNKNOWN_INTERACTION: 'unknown-interaction',
  UNKNOWN_PRESENTATION: 'unknown-presentation',
  PRESENTATION_NOT_ADMISSIBLE: 'presentation-not-admissible',
  UNAUTHORIZED_INTERACTION: 'unauthorized-interaction',
  PRESENTATION_IDENTITY_MISMATCH: 'presentation-identity-mismatch',
  UNKNOWN_SELECTION: 'unknown-selection',
  STALE_BINDING: 'stale-binding',
  NATIVE_RETURN_REQUIRES_MATERIALIZED_WINNER: 'native-return-requires-materialized-winner',
  NATIVE_RETURN_ALREADY_QUEUED: 'native-return-already-queued',
  UNAUTHORIZED_PRESENTATION: 'unauthorized-presentation',
  CALLBACK_ALREADY_ATTEMPTED: 'callback-already-attempted',
  INTERACTION_NOT_CALLBACK_PENDING: 'interaction-not-callback-pending',
  CALLBACK_ATTEMPT_MISSING: 'callback-attempt-missing',
  CALLBACK_OUTCOME_RECORDED: 'callback-outcome-recorded',
  CALLBACK_OUTCOME_CONFLICT: 'callback-outcome-conflict',
  CLAIM_CANNOT_BE_MATERIALIZED: 'claim-cannot-be-materialized',
  MATERIALIZED_WINNER_REQUIRED: 'materialized-winner-required',
  MATERIALIZED_WINNER_ANSWER_MISSING: 'materialized-winner-answer-missing',
  CANONICAL_IDENTITY_MISMATCH: 'canonical-identity-mismatch',
  CANONICAL_RESULT_CONFLICT: 'canonical-result-conflict',
  CANONICAL_RESULT_RECORDED: 'canonical-result-recorded',
  PROJECTION_REQUIRES_MATERIALIZED_WINNER: 'projection-requires-materialized-winner',
  PROJECTION_OUTCOME_RECORDED: 'projection-outcome-recorded',
  PROJECTION_OUTCOME_CONFLICT: 'projection-outcome-conflict',
  NATIVE_RETURN_NOT_QUEUED: 'native-return-not-queued',
  NATIVE_OUTCOME_RECORDED: 'native-outcome-recorded',
  NATIVE_OUTCOME_CONFLICT: 'native-outcome-conflict'
} as const;

export type DecisionReason = (typeof DECISION_REASONS)[keyof typeof DECISION_REASONS];

export interface DecisionResult {
  qid: string;
  questionGeneration: string;
  target: string;
  canonicalSource: MaterializedDecisionWinnerSource;
  canonicalReference: string;
  answer: string;
  questionMessageId: string;
  interactionId: string;
  selectedKey: string;
}

export const DECISION_NATIVE_OUTCOMES = {
  IN_FLIGHT: 'in_flight',
  SUBMITTED: 'submitted',
  NOT_SUBMITTED: 'not_submitted',
  REJECTED: 'rejected',
  UNKNOWN: 'unknown'
} as const;

export type DecisionNativeOutcome = (typeof DECISION_NATIVE_OUTCOMES)[keyof typeof DECISION_NATIVE_OUTCOMES];

export interface DecisionBinding {
  active: boolean;
  readiness: string | null;
  channelId: string;
  guildId: string;
  provider: string;
  nativeId: string;
  workspace: string;
  sessionRoot: string | null;
  endpoint: string | null;
  conductorId: string | null;
  repoKey: string | null;
  generation: number;
}

export type DecisionBindingInput = Omit<DecisionBinding, 'active' | 'readiness' | 'provider'> & {
  provider: AgentProvider;
  readiness?: Readiness | null;
  active?: boolean;
};

export interface DecisionPresentationInput {
  namespace?: string;
  presentationId: string;
  requestId: string;
  qid: string;
  questionGeneration: string;
  target: string;
  guildId: string;
  channelId: string;
  messageId?: string | null;
  binding: DecisionBindingInput;
  keys: readonly string[];
  canonicalRoute?: DecisionCanonicalRoute;
  content?: string;
}

export interface DecisionPresentation {
  namespace?: string;
  presentationId: string;
  requestId: string;
  qid: string;
  questionGeneration: string;
  target: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  operatorId: string;
  binding: DecisionBinding;
  keys: readonly string[];
  state: DecisionState;
  presentationOutcome: DecisionTransportOutcome | null;
  clickCount: number;
  staleReason: string | null;
  createdAt: string;
  updatedAt: string;
  canonicalRoute?: DecisionCanonicalRoute;
  content?: string;
}

export interface DecisionClickInput {
  interactionId: string;
  presentationId: string;
  selectedKey: string;
  actorId: string;
  guildId: string;
  channelId: string;
  messageId: string;
  binding: DecisionBindingInput;
}

export interface DecisionPresentationLookupInput {
  namespace: string;
  requestId: string;
  channelId: string;
  provider: AgentProvider;
  nativeId: string;
  generation: number;
}

export interface DecisionCanonicalResult {
  qid: string;
  questionGeneration: string;
  target: string;
  source: DecisionWinnerSource;
  materialized: boolean;
  reference: string;
  answer?: string;
}

export interface DecisionNativeReturn {
  qid: string;
  questionGeneration: string;
  target: string;
  provider: string;
  nativeId: string;
  generation: number;
  channelId: string;
  guildId: string;
  workspace: string;
  conductorId: string | null;
  repoKey: string | null;
  canonicalReference: string;
  state: DecisionState;
  outcome: DecisionNativeOutcome | null;
}

export interface DecisionInteractionInput {
  interactionId: string;
  presentationId: string;
  selectedKey: string;
  actorId: string;
  guildId: string;
  channelId: string;
  questionMessageId: string;
  binding: DecisionBinding;
  qid: string;
  questionGeneration: string;
  target: string;
  canonicalSource: MaterializedDecisionWinnerSource;
  canonicalReference: string;
  answer: string;
}

export interface DecisionInteractionAdmission {
  accepted: boolean;
  duplicate?: boolean;
  reason?: DecisionReason;
}

export interface DecisionClick {
  interactionId: string;
  presentationId: string;
  selectedKey: string;
  actorId: string;
  guildId: string;
  channelId: string;
  messageId: string;
  binding: DecisionBinding;
  state: DecisionState;
  callbackAttempted: boolean;
  callbackOutcome: DecisionTransportOutcome | null;
  canonical: DecisionCanonicalResult | null;
  projectionOutcome: DecisionTransportOutcome | null;
  nativeReturn: DecisionNativeReturn | null;
  createdAt: string;
  updatedAt: string;
}

interface SqlRow {
  [key: string]: unknown;
}

interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...parameters: unknown[]): T[];
}

interface DecisionDatabase {
  prepare(sql: string): SqlStatement;
}

export interface DecisionStateStore {
  db: DecisionDatabase;
  transaction<T>(operation: () => T): T;
  requireConfig(): { guildId: string; operatorId: string };
  getBinding(channelId: string): DecisionBinding | null;
  receipt(discordId: string | null, kind: string, detail: unknown): void;
  acceptDecisionInteraction(input: DecisionInteractionInput, options?: { inTransaction?: boolean }): DecisionInteractionAdmission;
}

export class DecisionError extends Error {}

export interface DecisionPresentationResult {
  created: boolean;
  duplicate: boolean;
  reason?: DecisionReason;
  presentation: DecisionPresentation | null;
}

export interface DecisionClickAdmission {
  accepted: boolean;
  duplicate?: boolean;
  continuing?: boolean;
  stale?: boolean;
  reason?: DecisionReason;
  click: DecisionClick | null;
}

export interface DecisionTransitionResult {
  accepted: boolean;
  duplicate?: boolean;
  reason?: DecisionReason;
  existingInteractionId?: string;
  click: DecisionClick | null;
}

export interface DecisionHandlers {
  registerPresentation(state: DecisionStateStore, input: DecisionPresentationInput): DecisionPresentationResult;
  findPresentation(state: DecisionStateStore, input: DecisionPresentationLookupInput): DecisionPresentation | null;
  recordPresentationOutcome(state: DecisionStateStore, presentationId: string, outcome: DecisionTransportOutcome, messageId?: string | null): DecisionPresentation;
  markPresentationStale(state: DecisionStateStore, presentationId: string, reason: string): DecisionPresentation;
  getPresentation(state: DecisionStateStore, presentationId: string): DecisionPresentation | null;
  admitClick(state: DecisionStateStore, input: DecisionClickInput): DecisionClickAdmission;
  admitClickAndBeginCallback(state: DecisionStateStore, input: DecisionClickInput): DecisionClickAdmission;
  getClick(state: DecisionStateStore, interactionId: string): DecisionClick | null;
  beginCallback(state: DecisionStateStore, interactionId: string): DecisionTransitionResult;
  recordCallbackOutcome(state: DecisionStateStore, interactionId: string, outcome: DecisionTransportOutcome): DecisionTransitionResult;
  recoverCallbackAttemptsAfterRestart(state: DecisionStateStore): number;
  importWinner(state: DecisionStateStore, interactionId: string, result: DecisionCanonicalResult): DecisionTransitionResult;
  recordProjectionOutcome(state: DecisionStateStore, interactionId: string, outcome: DecisionTransportOutcome): DecisionTransitionResult;
  queueNativeReturn(state: DecisionStateStore, interactionId: string): DecisionTransitionResult;
  recordNativeReturnOutcome(state: DecisionStateStore, interactionId: string, outcome: DecisionNativeOutcome): DecisionTransitionResult;
  pendingWork(state: DecisionStateStore): DecisionClick[];
}

export interface JournalRow {
  [key: string]: unknown;
  id: number;
  kind: string;
  detail: string;
  created_at: string;
}

export interface MutablePresentation {
  namespace?: string;
  presentationId: string;
  requestId: string;
  qid: string;
  questionGeneration: string;
  target: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  operatorId: string;
  binding: DecisionBinding;
  keys: string[];
  state: DecisionState;
  presentationOutcome: DecisionTransportOutcome | null;
  clickIds: string[];
  staleReason: string | null;
  createdAt: string;
  updatedAt: string;
  canonicalRoute?: DecisionCanonicalRoute;
  content?: string;
}

export interface MutableClick {
  interactionId: string;
  presentationId: string;
  selectedKey: string;
  actorId: string;
  guildId: string;
  channelId: string;
  messageId: string;
  binding: DecisionBinding;
  state: DecisionState;
  callbackAttempted: boolean;
  callbackOutcome: DecisionTransportOutcome | null;
  canonical: DecisionCanonicalResult | null;
  projectionOutcome: DecisionTransportOutcome | null;
  nativeReturn: DecisionNativeReturn | null;
  createdAt: string;
  updatedAt: string;
}

export interface Snapshot {
  presentations: Map<string, MutablePresentation>;
  clicks: Map<string, MutableClick>;
}
