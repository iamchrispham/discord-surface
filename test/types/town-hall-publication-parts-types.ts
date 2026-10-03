import {
  createTownHallPublicationHandlers,
  type TownHallPublication,
  type TownHallPublicationPart,
  type TownHallPublicationPartId,
  type TownHallPublicationSet
} from '../../src/state/town-hall-publication/index';
import { TOWN_HALL_ROOM_PARTS } from '../../src/peer/town-hall-room-parts';

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
const partId: TownHallPublicationPartId = `${TOWN_HALL_ROOM_PARTS.ID_PREFIX}deadbeef`;

const projection: TownHallPublication = handlers.getTownHallPublication(state, journalKey, partId);
const partProjection: TownHallPublication = handlers.getTownHallPublication(state, journalKey);
const set: TownHallPublicationSet = handlers.getTownHallPublicationSet(state, journalKey);
const parts: readonly TownHallPublicationPart[] = set.parts;
const part: TownHallPublicationPart = parts[0];
const partReservation = handlers.reserveTownHallPublication(state, journalKey, part.partId);
const complete: boolean = set.complete;
const anchorMessageId: string | null = set.anchorMessageId;
const setJournalKey: string = set.journalKey;
const setFingerprint: string = set.fingerprint;
const partIndex: number = part.index;
const partTotal: number = part.total;
const partIdValue: string = part.partId;
const partContent: string = part.content;
const partPublication: TownHallPublication = part.publication;
const publicationNonce: string = projection.nonce;
const legacyPublicationKey: string = partProjection.publicationKey;
const setPartCount: number = set.parts.length;

// @ts-expect-error journal key is read only
set.journalKey = 'replacement';
// @ts-expect-error fingerprint is read only
set.fingerprint = 'replacement';
// @ts-expect-error completion flag is read only
set.complete = true;
// @ts-expect-error anchor message id is read only
set.anchorMessageId = 'replacement';
// @ts-expect-error parts is a read only array
set.parts.push(part);
// @ts-expect-error part id is read only
part.partId = 'replacement';
// @ts-expect-error content is read only
part.content = 'replacement';
// @ts-expect-error publication status is a read only finite state
part.publication.status = 'published';

void projection;
void partProjection;
void parts;
void partReservation;
void complete;
void anchorMessageId;
void setJournalKey;
void setFingerprint;
void partIndex;
void partTotal;
void partIdValue;
void partContent;
void partPublication;
void publicationNonce;
void legacyPublicationKey;
void setPartCount;
