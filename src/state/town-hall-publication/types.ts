import {
  DIRECT_POST_OUTCOMES,
  DIRECT_POST_PART_STATUSES
} from '../../direct-post/contracts';
import type { DirectPostOutcome, DirectPostPartStatus } from '../../direct-post/contracts';
import { TOWN_HALL_ROOM_PARTS } from '../../peer/town-hall-room-parts';
import type { TownHallRoomPart } from '../../peer/town-hall-room-parts';
import type { TownHallBroadcastSnapshot, TownHallJournalState } from '../town-hall-journal/types';

export const TOWN_HALL_PUBLICATION_RECEIPTS = Object.freeze({
  INSTRUCTION_PREFIX: 'town-hall-instruction/v1:',
  PUBLICATION_PREFIX: 'town-hall-publication/v1:',
  INSTRUCTION_PART_PREFIX: 'town-hall-instruction-part/v1:',
  PUBLICATION_PART_PREFIX: 'town-hall-publication-part/v1:'
} as const);

// Explicitly a room-part ID, so the existing fixture assertion that recover()
// takes no extra plain string argument keeps failing typecheck.
export type TownHallPublicationPartId = `${typeof TOWN_HALL_ROOM_PARTS.ID_PREFIX}${string}`;

export const TOWN_HALL_PUBLICATION_EVENTS = Object.freeze({
  RESERVED: 'reserved',
  IN_FLIGHT: 'in_flight',
  OUTCOME: 'outcome',
  CONFIRMED: 'confirmed'
} as const);

export type TownHallPublicationEvent = (typeof TOWN_HALL_PUBLICATION_EVENTS)[keyof typeof TOWN_HALL_PUBLICATION_EVENTS];
export type TownHallPublicationStatus = TownHallJournalState | DirectPostPartStatus;

export interface TownHallPublicationOwner {
  readonly ownerPid: number;
  readonly ownerStartTime: string;
  readonly ownerCommand: string | null;
}

export interface TownHallPublication {
  readonly journalKey: string;
  readonly publicationKey: string;
  readonly fingerprint: string;
  readonly status: TownHallPublicationStatus;
  readonly attemptId: string | null;
  readonly nonce: string;
  readonly owner: TownHallPublicationOwner | null;
  readonly messageId: string | null;
}

export interface TownHallPublicationReservation {
  readonly claimed: boolean;
  readonly publication: TownHallPublication;
}

export interface TownHallPublicationStart {
  readonly started: boolean;
  readonly publication: TownHallPublication;
}

export interface TownHallPublicationPart extends TownHallRoomPart {
  readonly partId: TownHallPublicationPartId;
  readonly publication: TownHallPublication;
}

export interface TownHallPublicationSet {
  readonly journalKey: string;
  readonly fingerprint: string;
  readonly complete: boolean;
  readonly anchorMessageId: string | null;
  readonly parts: readonly TownHallPublicationPart[];
}

export interface SqlRow {
  [key: string]: unknown;
}

export interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...parameters: unknown[]): T[];
}

export interface TownHallPublicationDatabase {
  prepare(sql: string): SqlStatement;
}

export interface TownHallPublicationStateStore {
  db: TownHallPublicationDatabase;
  transaction<T>(operation: () => T): T;
  receipt(discordId: string | null, kind: string, detail: Record<string, unknown>): void;
  getTownHallBroadcast(journalKey: string): TownHallBroadcastSnapshot | null;
  directPostOwnerIdentity(pid: number): TownHallPublicationOwner | null;
  directPostOwnerAlive(pid: number, expectedIdentity: TownHallPublicationOwner): boolean;
}

export interface TownHallPublicationErrorClass {
  new (message: string): Error;
}

export interface TownHallPublicationDependencies {
  BindingError: TownHallPublicationErrorClass;
  StateCorruptError: TownHallPublicationErrorClass;
  discordNonce(messageId: string, partIndex?: number): string;
  probePid(pid: number): unknown;
}

export interface TownHallPublicationConfirmationEvidence {
  readonly messageId: string;
  readonly nonce: string;
  readonly guildId: string;
  readonly channelId: string;
}

export interface TownHallPublicationHandlers {
  getTownHallPublication(state: TownHallPublicationStateStore, journalKey: string, partId?: TownHallPublicationPartId): TownHallPublication;
  reserveTownHallPublication(state: TownHallPublicationStateStore, journalKey: string, partId?: TownHallPublicationPartId): TownHallPublicationReservation;
  markTownHallPublicationInFlight(
    state: TownHallPublicationStateStore,
    journalKey: string,
    attemptId: string,
    partId?: TownHallPublicationPartId
  ): TownHallPublicationStart;
  recordTownHallPublicationOutcome(
    state: TownHallPublicationStateStore,
    journalKey: string,
    attemptId: string,
    outcome: DirectPostOutcome,
    detail?: Record<string, unknown>,
    partId?: TownHallPublicationPartId
  ): TownHallPublication;
  recoverTownHallPublication(state: TownHallPublicationStateStore, journalKey: string, partId?: TownHallPublicationPartId): TownHallPublication;
  confirmTownHallPublication(
    state: TownHallPublicationStateStore,
    journalKey: string,
    attemptId: string,
    evidence: TownHallPublicationConfirmationEvidence,
    partId?: TownHallPublicationPartId
  ): TownHallPublication;
  getTownHallPublicationSet(state: TownHallPublicationStateStore, journalKey: string): TownHallPublicationSet;
}

export { DIRECT_POST_OUTCOMES, DIRECT_POST_PART_STATUSES };
export type { DirectPostOutcome, DirectPostPartStatus };
