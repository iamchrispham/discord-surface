import {
  confirmTownHallPublication,
  getTownHallPublication,
  markTownHallPublicationInFlight,
  recordTownHallPublicationOutcome,
  recoverTownHallPublication,
  reserveTownHallPublication
} from './repository';
import {
  TOWN_HALL_PUBLICATION_EVENTS,
  TOWN_HALL_PUBLICATION_RECEIPTS
} from './types';
import type {
  TownHallPublicationDependencies,
  TownHallPublicationHandlers
} from './types';

export function createTownHallPublicationHandlers(
  deps: TownHallPublicationDependencies
): TownHallPublicationHandlers {
  return {
    getTownHallPublication: (state, journalKey) =>
      getTownHallPublication(deps, state, journalKey),
    reserveTownHallPublication: (state, journalKey) =>
      reserveTownHallPublication(deps, state, journalKey),
    markTownHallPublicationInFlight: (state, journalKey, attemptId) =>
      markTownHallPublicationInFlight(deps, state, journalKey, attemptId),
    recordTownHallPublicationOutcome: (state, journalKey, attemptId, outcome, detail) =>
      recordTownHallPublicationOutcome(deps, state, journalKey, attemptId, outcome, detail),
    recoverTownHallPublication: (state, journalKey) =>
      recoverTownHallPublication(deps, state, journalKey),
    confirmTownHallPublication: (state, journalKey, attemptId, evidence) =>
      confirmTownHallPublication(deps, state, journalKey, attemptId, evidence)
  };
}

export {
  TOWN_HALL_PUBLICATION_EVENTS,
  TOWN_HALL_PUBLICATION_RECEIPTS
};

export * from './types';
