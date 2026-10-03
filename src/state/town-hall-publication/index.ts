import {
  confirmTownHallPublication,
  getTownHallPublication,
  getTownHallPublicationSet,
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
    getTownHallPublication: (state, journalKey, partId) =>
      getTownHallPublication(deps, state, journalKey, partId),
    reserveTownHallPublication: (state, journalKey, partId) =>
      reserveTownHallPublication(deps, state, journalKey, partId),
    markTownHallPublicationInFlight: (state, journalKey, attemptId, partId) =>
      markTownHallPublicationInFlight(deps, state, journalKey, attemptId, partId),
    recordTownHallPublicationOutcome: (state, journalKey, attemptId, outcome, detail, partId) =>
      recordTownHallPublicationOutcome(deps, state, journalKey, attemptId, outcome, detail, partId),
    recoverTownHallPublication: (state, journalKey, partId) =>
      recoverTownHallPublication(deps, state, journalKey, partId),
    confirmTownHallPublication: (state, journalKey, attemptId, evidence, partId) =>
      confirmTownHallPublication(deps, state, journalKey, attemptId, evidence, partId),
    getTownHallPublicationSet: (state, journalKey) =>
      getTownHallPublicationSet(deps, state, journalKey)
  };
}

export {
  TOWN_HALL_PUBLICATION_EVENTS,
  TOWN_HALL_PUBLICATION_RECEIPTS
};

export * from './types';
