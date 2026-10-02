export const COURIER_RECEIPT_KINDS = Object.freeze({
  ROUTE: 'courier-route',
  ATTEMPT: 'courier-attempt',
  FORWARD_CLAIM: 'courier-forward-claim',
  OUTCOME: 'courier-outcome',
  RECONCILED_NOT_SUBMITTED: 'uncertain-reconciled-not_submitted',
  REJECTION: 'courier-rejection'
} as const);

export const COURIER_ROUTE_STATES = Object.freeze({
  ACTIVE: 'active',
  REVOKED: 'revoked'
} as const);

export const COURIER_ATTEMPT_STATES = Object.freeze({
  CLAIMED: 'claimed'
} as const);

export const COURIER_SOURCE_KINDS = Object.freeze({
  AGENT: 'agent',
  HUMAN: 'human',
  WATCHER_NOTICE: 'watcher-notice'
} as const);

export const COURIER_OUTCOMES = Object.freeze({
  SUBMITTED: 'submitted',
  NOT_SUBMITTED: 'not_submitted',
  UNCERTAIN: 'uncertain'
} as const);

// The stable pre-host refusal reason persisted on a guard-refusal outcome
// receipt. These bytes are persisted evidence: do not reword or reformat.
export const COURIER_OUTCOME_REASONS = Object.freeze({
  GUARD_REFUSED_BEFORE_HOST_CALL: 'courier guard refused before host call'
} as const);

export const COURIER_RESULT_STATUSES = Object.freeze({
  CLAIMED: 'claimed',
  DUPLICATE: 'duplicate',
  NO_ROUTE: 'no_route',
  STALE: 'stale',
  HELD: 'held',
  CONFLICT: 'conflict',
  SETTLED: 'settled'
} as const);

// Issue128: public recovery projection vocabulary. These name the observed
// courier delivery state and the concrete reason explicit recovery refused, so
// "retired" can never be read as native execution.
export const COURIER_DELIVERY_STATUSES = Object.freeze({
  QUEUED_UNFORWARDED: 'queued_unforwarded',
  FORWARD_CLAIMED: 'forward_claimed',
  NATIVE_ACKNOWLEDGED: 'native_acknowledged',
  RETIRED: 'retired',
  GUARD_REFUSED: 'guard_refused',
  NOT_APPLICABLE: 'not_applicable'
} as const);

export const COURIER_RECOVERY_REASONS = Object.freeze({
  ELIGIBLE: 'eligible',
  NO_ATTEMPT: 'no_attempt',
  STALE_BINDING: 'stale_binding',
  ATTEMPT_IDENTITY_MISMATCH: 'attempt_identity_mismatch',
  NATIVE_ACKNOWLEDGED: 'native_acknowledged',
  FORWARD_CLAIMED: 'forward_claimed',
  RETIRED: 'retired',
  NOT_SUBMITTED: 'not_submitted',
  UNKNOWN_MESSAGE: 'unknown_message',
  STALE_ATTEMPT: 'stale_attempt'
} as const);

export const COURIER_RECOVERY_SOURCES = Object.freeze({
  COURIER_RECOVERY: 'courier-recovery'
} as const);

export const ENVELOPE_TYPE = 'discord-surface:courier:v1' as const;
export const PROMPT_PREFIX = 'discord-surface courier forwarding envelope v1' as const;
