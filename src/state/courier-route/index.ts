import { createCourierAttemptHandlers } from './attempt';
import { claimCourierForward } from './forward';
import { COURIER_ATTEMPT_STATES, COURIER_OUTCOMES, COURIER_RECEIPT_KINDS, COURIER_RESULT_STATUSES, COURIER_ROUTE_STATES, COURIER_SOURCE_KINDS, ENVELOPE_TYPE, PROMPT_PREFIX } from './constants';
import { createEnvelope } from './envelope';
import { getRoute, isCourierOriginAllowed, listRoutes, registerRoute, revokeRoute } from './route';
import type { CourierDependencies, CourierState } from './types';

export function createCourierRouteHandlers(deps: CourierDependencies) {
  const attempts = createCourierAttemptHandlers(deps);
  return {
    claimCourierForward: claimCourierForward.bind(null, deps),
    beginCourierAttempt: attempts.beginCourierAttempt,
    authorizeCourierAttempt: attempts.authorizeCourierAttempt,
    createEnvelope,
    getCourierAttempt: attempts.getCourierAttempt,
    listCourierRoutes: (state: CourierState) => listRoutes(deps, state),
    recordCourierOutcome: attempts.recordCourierOutcome,
    recoverCourierAttemptsAfterRestart: attempts.recoverCourierAttemptsAfterRestart,
    registerCourierRoute: (state: CourierState, input: unknown) => registerRoute(deps, state, input),
    revokeCourierRoute: (state: CourierState, routeId: string, reason: string | null = null) => revokeRoute(deps, state, routeId, reason),
    getCourierRoute: (state: CourierState, routeId: string) => getRoute(deps, state, routeId)
  };
}

export {
  COURIER_ATTEMPT_STATES,
  COURIER_OUTCOMES,
  COURIER_RECEIPT_KINDS,
  COURIER_RESULT_STATUSES,
  COURIER_ROUTE_STATES,
  COURIER_SOURCE_KINDS,
  ENVELOPE_TYPE,
  PROMPT_PREFIX,
  createEnvelope,
  isCourierOriginAllowed
};

export * from './types';
export type { RouteMatch } from './route';
