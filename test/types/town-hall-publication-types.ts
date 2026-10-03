import {
  createTownHallPublicationHandlers,
  TOWN_HALL_PUBLICATION_EVENTS,
  TOWN_HALL_PUBLICATION_RECEIPTS
} from '../../src/state/town-hall-publication/index';

const handlers = createTownHallPublicationHandlers({
  BindingError: class BindingError extends Error {},
  StateCorruptError: class StateCorruptError extends Error {},
  discordNonce: (messageId: string) => `ds-${messageId.slice(0, 21)}`,
  probePid: (_pid: number): void => {}
});

type PublicationState = Parameters<typeof handlers.getTownHallPublication>[0];

const state = {
  db: { prepare: (_sql: string) => ({ all: () => [] }) },
  transaction: <T>(operation: () => T): T => operation(),
  receipt: (_discordId: string | null, _kind: string, _detail: Record<string, unknown>): void => {},
  getTownHallBroadcast: (_journalKey: string): null => null,
  directPostOwnerIdentity: (_pid: number): null => null,
  directPostOwnerAlive: (_pid: number, _identity: unknown): boolean => false
} as unknown as PublicationState;

const journalKey = 'a'.repeat(64);
const attemptId = '00000000-0000-4000-8000-000000000000';

const reserveResult = handlers.reserveTownHallPublication(state, journalKey);
const claimed: boolean = reserveResult.claimed;
const reservedProjection = reserveResult.publication;

const markResult = handlers.markTownHallPublicationInFlight(state, journalKey, attemptId);
const started: boolean = markResult.started;

const projection = handlers.getTownHallPublication(state, journalKey);
const recovered = handlers.recoverTownHallPublication(state, journalKey);
const recorded = handlers.recordTownHallPublicationOutcome(state, journalKey, attemptId, 'sent', { messageId: 'm1' });
const confirmed = handlers.confirmTownHallPublication(state, journalKey, attemptId, {
  messageId: 'm1',
  nonce: projection.nonce,
  guildId: '100',
  channelId: '900'
});

const publicationKey: string = projection.publicationKey;
const status: 'planned' | 'claimed' | 'in_flight' | 'sent' | 'not_sent' | 'rejected' | 'rate_limited' | 'unknown' | 'stale' =
  projection.status;
const projectedNonce: string = projection.nonce;
const fingerprint: string = projection.fingerprint;
const messageId: string | null = projection.messageId;
const ownerPid: number | null = projection.owner === null ? null : projection.owner.ownerPid;
const ownerStartTime: string | null = projection.owner === null ? null : projection.owner.ownerStartTime;

const reservedEvent: 'reserved' = TOWN_HALL_PUBLICATION_EVENTS.RESERVED;
const inFlightEvent: 'in_flight' = TOWN_HALL_PUBLICATION_EVENTS.IN_FLIGHT;
const outcomeEvent: 'outcome' = TOWN_HALL_PUBLICATION_EVENTS.OUTCOME;
const confirmedEvent: 'confirmed' = TOWN_HALL_PUBLICATION_EVENTS.CONFIRMED;
const instructionPrefix: 'town-hall-instruction/v1:' = TOWN_HALL_PUBLICATION_RECEIPTS.INSTRUCTION_PREFIX;
const publicationPrefix: 'town-hall-publication/v1:' = TOWN_HALL_PUBLICATION_RECEIPTS.PUBLICATION_PREFIX;

// @ts-expect-error get requires a string journal key
handlers.getTownHallPublication(state, 123);
// @ts-expect-error reserve requires a journal key
handlers.reserveTownHallPublication(state);
// @ts-expect-error mark requires an attempt id
handlers.markTownHallPublicationInFlight(state, journalKey);
// @ts-expect-error record requires a finite outcome vocabulary value
handlers.recordTownHallPublicationOutcome(state, journalKey, attemptId, 'bogus');
// @ts-expect-error record requires a string attempt id
handlers.recordTownHallPublicationOutcome(state, journalKey, 42, 'not_sent');
// @ts-expect-error confirm requires the exact evidence shape
handlers.confirmTownHallPublication(state, journalKey, attemptId, { messageId: 'm1', nonce: projection.nonce, guildId: '100' });
// @ts-expect-error recover takes no extra arguments
handlers.recoverTownHallPublication(state, journalKey, 'extra');
// @ts-expect-error publication key is read only
projection.publicationKey = 'replacement';
// @ts-expect-error status is a read only finite state
projection.status = 'published';
// @ts-expect-error attempt id is read only
projection.attemptId = 'replacement';
// @ts-expect-error nonce is read only
projection.nonce = 'replacement';
// @ts-expect-error message id is read only
projection.messageId = 'replacement';
// @ts-expect-error owner pid is read only
projection.owner.ownerPid = 1;
// @ts-expect-error reservation claim flag is read only
reserveResult.claimed = false;
// @ts-expect-error mark started flag is read only
markResult.started = false;
// @ts-expect-error the finite event vocabulary has no unknown member
const unknownEvent: 'bogus' = TOWN_HALL_PUBLICATION_EVENTS.RESERVED;

void claimed;
void reservedProjection;
void started;
void recovered;
void recorded;
void confirmed;
void publicationKey;
void status;
void projectedNonce;
void fingerprint;
void messageId;
void ownerPid;
void ownerStartTime;
void reservedEvent;
void inFlightEvent;
void outcomeEvent;
void confirmedEvent;
void instructionPrefix;
void publicationPrefix;
void unknownEvent;
