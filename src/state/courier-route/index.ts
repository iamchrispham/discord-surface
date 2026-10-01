import { createCourierAttemptHandlers } from './attempt';
import {
  canonicalWorkspace,
  claimCourierForward,
  hasCourierForwardClaim,
  hasRetiredCourierAttempt,
  matchesFixedRecipient
} from './forward';
import { readCourierInput } from './input';
import type { ForwardState } from './forward';
import {
  COURIER_ATTEMPT_STATES,
  COURIER_DELIVERY_STATUSES,
  COURIER_OUTCOMES,
  COURIER_OUTCOME_REASONS,
  COURIER_RECEIPT_KINDS,
  COURIER_RECOVERY_REASONS,
  COURIER_RECOVERY_SOURCES,
  COURIER_RESULT_STATUSES,
  COURIER_ROUTE_STATES,
  COURIER_SOURCE_KINDS,
  ENVELOPE_TYPE,
  PROMPT_PREFIX
} from './constants';
import { createEnvelope } from './envelope';
import { isConfirmedCourierGuardRefusal, isCourierGuardRefusalReason } from './guard-refusal';
import { getCourierDeliveryStatus, recoverCourierAttempt } from './recovery';
import { getRoute, isCourierOriginAllowed, listRoutes, registerRoute, revokeRoute } from './route';
import type { CourierDependencies, CourierState } from './types';

export function createCourierRouteHandlers(deps: CourierDependencies) {
  const attempts = createCourierAttemptHandlers(deps);
  return {
    claimCourierForward: claimCourierForward.bind(null, deps),
    readCourierInput: (state: CourierState, routeId: string, messageId: string, attemptId: string, nativeId: string, workspace: string) =>
      readCourierInput(deps, state as ForwardState, routeId, messageId, attemptId, nativeId, workspace),
    hasCourierForwardClaim,
    hasRetiredCourierAttempt,
    beginCourierAttempt: attempts.beginCourierAttempt,
    authorizeCourierAttempt: attempts.authorizeCourierAttempt,
    createEnvelope,
    getCourierAttempt: attempts.getCourierAttempt,
    listCourierRoutes: (state: CourierState) => listRoutes(deps, state),
    recordCourierOutcome: attempts.recordCourierOutcome,
    recoverCourierAttemptsAfterRestart: attempts.recoverCourierAttemptsAfterRestart,
    recoverCourierAttempt: recoverCourierAttempt.bind(null, deps),
    getCourierDeliveryStatus: getCourierDeliveryStatus.bind(null, deps),
    registerCourierRoute: (state: CourierState, input: unknown) => registerRoute(deps, state, input),
    revokeCourierRoute: (state: CourierState, routeId: string, reason: string | null = null) => revokeRoute(deps, state, routeId, reason),
    getCourierRoute: (state: CourierState, routeId: string) => getRoute(deps, state, routeId)
  };
}

export {
  COURIER_ATTEMPT_STATES,
  COURIER_DELIVERY_STATUSES,
  COURIER_OUTCOMES,
  COURIER_OUTCOME_REASONS,
  COURIER_RECEIPT_KINDS,
  COURIER_RECOVERY_REASONS,
  COURIER_RECOVERY_SOURCES,
  COURIER_RESULT_STATUSES,
  COURIER_ROUTE_STATES,
  COURIER_SOURCE_KINDS,
  ENVELOPE_TYPE,
  PROMPT_PREFIX,
  canonicalWorkspace,
  createEnvelope,
  isConfirmedCourierGuardRefusal,
  isCourierGuardRefusalReason,
  isCourierOriginAllowed,
  matchesFixedRecipient
};

export * from './types';
export type { RouteMatch } from './route';
