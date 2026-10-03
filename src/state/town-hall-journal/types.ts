import type { TownHallAddress, TownHallBroadcastInput, TownHallPlan } from '../../peer/town-hall-plan';

export const TOWN_HALL_JOURNAL_RECEIPTS = {
  MANIFEST_PREFIX: 'town-hall-manifest/v1:',
  RECIPIENT_PREFIX: 'town-hall-recipient/v1:'
} as const;

export const TOWN_HALL_JOURNAL_STATES = {
  PLANNED: 'planned'
} as const;

export type TownHallJournalState = (typeof TOWN_HALL_JOURNAL_STATES)[keyof typeof TOWN_HALL_JOURNAL_STATES];
export type TownHallJournalManifestKind = `${typeof TOWN_HALL_JOURNAL_RECEIPTS.MANIFEST_PREFIX}${string}`;
export type TownHallJournalRecipientKind = `${typeof TOWN_HALL_JOURNAL_RECEIPTS.RECIPIENT_PREFIX}${string}`;

export interface TownHallBroadcastPublication {
  readonly status: TownHallJournalState;
}

export interface TownHallBroadcastRecipient {
  readonly target: TownHallAddress;
  readonly packetId: string;
  readonly status: TownHallJournalState;
}

export interface TownHallBroadcastSnapshot {
  readonly journalKey: string;
  readonly plan: TownHallPlan;
  readonly publication: TownHallBroadcastPublication;
  readonly recipients: readonly TownHallBroadcastRecipient[];
}

export interface TownHallBroadcastCreateResult {
  readonly created: boolean;
  readonly broadcast: TownHallBroadcastSnapshot;
}

export interface SqlRow {
  [key: string]: unknown;
}

export interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...parameters: unknown[]): T[];
}

export interface TownHallJournalDatabase {
  prepare(sql: string): SqlStatement;
}

export interface TownHallJournalStateStore {
  db: TownHallJournalDatabase;
  transaction<T>(operation: () => T): T;
  receipt(discordId: string | null, kind: string, detail: Record<string, unknown>): void;
}

export interface TownHallJournalErrorClass {
  new (message: string): Error;
}

export interface TownHallJournalDependencies {
  BindingError: TownHallJournalErrorClass;
  StateCorruptError: TownHallJournalErrorClass;
}

export interface TownHallJournalHandlers {
  createTownHallBroadcast(state: TownHallJournalStateStore, input: TownHallBroadcastInput): TownHallBroadcastCreateResult;
  getTownHallBroadcast(state: TownHallJournalStateStore, journalKey: string): TownHallBroadcastSnapshot | null;
  listTownHallBroadcasts(state: TownHallJournalStateStore): TownHallBroadcastSnapshot[];
}
