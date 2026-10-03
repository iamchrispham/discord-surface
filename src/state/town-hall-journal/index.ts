import type { TownHallBroadcastInput } from '../../peer/town-hall-plan';
import {
  createTownHallBroadcast as createBroadcast,
  getTownHallBroadcast as getBroadcast,
  listTownHallBroadcasts as listBroadcasts
} from './repository';
import { TOWN_HALL_JOURNAL_RECEIPTS, TOWN_HALL_JOURNAL_STATES } from './types';
import type {
  TownHallJournalDependencies,
  TownHallJournalHandlers,
  TownHallJournalStateStore
} from './types';

export function createTownHallJournalHandlers(deps: TownHallJournalDependencies): TownHallJournalHandlers {
  return {
    createTownHallBroadcast: (state: TownHallJournalStateStore, input: TownHallBroadcastInput) =>
      createBroadcast(deps, state, input),
    getTownHallBroadcast: (state: TownHallJournalStateStore, journalKey: string) =>
      getBroadcast(deps, state, journalKey),
    listTownHallBroadcasts: (state: TownHallJournalStateStore) =>
      listBroadcasts(deps, state)
  };
}

export {
  TOWN_HALL_JOURNAL_RECEIPTS,
  TOWN_HALL_JOURNAL_STATES
};

export * from './types';
