import { COURIER_OUTCOMES, COURIER_OUTCOME_REASONS, COURIER_RESULT_STATUSES } from './constants';
import type { CourierOutcomeRecord } from './types';

// Issue196 pre-host guard-refusal evidence. The guard producer in
// src/courier-guard.js and the recovery projection share this one classifier, so
// "confirmed guard refusal" can only mean the persisted NOT_SUBMITTED outcome
// carrying the stable marker reason together with a refusal reason the guard can
// actually produce. This module reads no state; it only classifies evidence.

const GUARD_REFUSAL_REASONS = [
  'courier hook caller or route is not current',
  'courier message is not eligible for forwarding',
  'courier attempt changed after admission'
] as const;

const FORWARDING_AUTHORIZATION_PREFIX = 'courier forwarding authorization ' as const;
const FORWARDING_AUTHORIZATION_STATUSES = [
  COURIER_RESULT_STATUSES.NO_ROUTE,
  COURIER_RESULT_STATUSES.STALE,
  COURIER_RESULT_STATUSES.HELD,
  COURIER_RESULT_STATUSES.CONFLICT
] as const;

export type CourierGuardRefusalReason =
  | (typeof GUARD_REFUSAL_REASONS)[number]
  | `${typeof FORWARDING_AUTHORIZATION_PREFIX}${(typeof FORWARDING_AUTHORIZATION_STATUSES)[number]}`;

const FORWARDING_AUTHORIZATION_REASONS = new Set(
  FORWARDING_AUTHORIZATION_STATUSES.map(status => `${FORWARDING_AUTHORIZATION_PREFIX}${status}`)
);

// True only for a reason the pre-host guard actually refuses with: one of the
// three fixed refusal reasons, or a forwarding-authorization refusal carrying
// the guard's status suffix. The stable marker is deliberately not accepted.
export function isCourierGuardRefusalReason(reason: unknown): reason is CourierGuardRefusalReason {
  return typeof reason === 'string' &&
    ((GUARD_REFUSAL_REASONS as readonly string[]).includes(reason) ||
      FORWARDING_AUTHORIZATION_REASONS.has(reason));
}

// True only for a persisted outcome record that proves the guard refused before
// the host call: NOT_SUBMITTED, the stable marker reason, and a guard reason the
// refusal classifier accepts. A null, uncertain, submitted, unmarked, or
// arbitrary NOT_SUBMITTED outcome is not confirmed guard evidence.
export function isConfirmedCourierGuardRefusal(outcome: CourierOutcomeRecord | null): boolean {
  return outcome !== null &&
    outcome.outcome === COURIER_OUTCOMES.NOT_SUBMITTED &&
    outcome.reason === COURIER_OUTCOME_REASONS.GUARD_REFUSED_BEFORE_HOST_CALL &&
    isCourierGuardRefusalReason(outcome.guardReason);
}
