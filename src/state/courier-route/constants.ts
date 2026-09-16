export const COURIER_RECEIPT_KINDS = Object.freeze({
  ROUTE: 'courier-route',
  ATTEMPT: 'courier-attempt',
  FORWARD_CLAIM: 'courier-forward-claim',
  OUTCOME: 'courier-outcome',
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
  HUMAN: 'human'
} as const);

export const COURIER_OUTCOMES = Object.freeze({
  SUBMITTED: 'submitted',
  NOT_SUBMITTED: 'not_submitted',
  UNCERTAIN: 'uncertain'
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

export const ENVELOPE_TYPE = 'discord-surface:courier:v1' as const;
export const PROMPT_PREFIX = 'discord-surface courier forwarding envelope v1' as const;
