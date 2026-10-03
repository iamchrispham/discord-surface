import {
  createTownHallJournalHandlers,
  TOWN_HALL_JOURNAL_RECEIPTS,
  TOWN_HALL_JOURNAL_STATES,
  type TownHallBroadcastCreateResult,
  type TownHallBroadcastRecipient,
  type TownHallBroadcastSnapshot,
  type TownHallJournalHandlers,
  type TownHallJournalStateStore
} from '../../src/state/town-hall-journal/index';
import type { TownHallBroadcastInput } from '../../src/peer/town-hall-plan';

const input: TownHallBroadcastInput = {
  broadcastId: 'b1',
  townHall: { guildId: '100', channelId: '900' },
  source: {
    guildId: '100',
    channelId: '200',
    provider: 'codex',
    nativeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    generation: 1
  },
  recipients: [{
    guildId: '100',
    channelId: '300',
    provider: 'codex',
    nativeId: '11111111-1111-4111-8111-aabbccddeeff',
    generation: 1
  }],
  text: 'hello'
};

const handlers: TownHallJournalHandlers = createTownHallJournalHandlers({
  BindingError: class BindingError extends Error {},
  StateCorruptError: class StateCorruptError extends Error {}
});

const state: TownHallJournalStateStore = {
  db: { prepare: () => ({ all: () => [] }) },
  transaction: <T>(operation: () => T): T => operation(),
  receipt: (_discordId: string | null, _kind: string, _detail: Record<string, unknown>): void => {}
};

const created: TownHallBroadcastCreateResult = handlers.createTownHallBroadcast(state, input);
const createdFlag: boolean = created.created;
const snapshot: TownHallBroadcastSnapshot = created.broadcast;
const journalKey: string = snapshot.journalKey;
const text: string = snapshot.plan.text;
const status: string = snapshot.publication.status;
const recipients: readonly TownHallBroadcastRecipient[] = snapshot.recipients;
const targetGeneration: number = snapshot.recipients[0].target.generation;
const packetId: string = snapshot.recipients[0].packetId;

const manifestPrefix: 'town-hall-manifest/v1:' = TOWN_HALL_JOURNAL_RECEIPTS.MANIFEST_PREFIX;
const recipientPrefix: 'town-hall-recipient/v1:' = TOWN_HALL_JOURNAL_RECEIPTS.RECIPIENT_PREFIX;
const planned: 'planned' = TOWN_HALL_JOURNAL_STATES.PLANNED;

const maybe: TownHallBroadcastSnapshot | null = handlers.getTownHallBroadcast(state, journalKey);
const listed: TownHallBroadcastSnapshot[] = handlers.listTownHallBroadcasts(state);

// @ts-expect-error journal key must be a string
handlers.getTownHallBroadcast(state, 123);
// @ts-expect-error create requires a broadcast input argument
handlers.createTownHallBroadcast(state);
// @ts-expect-error list takes no extra arguments
handlers.listTownHallBroadcasts(state, 'extra');
// @ts-expect-error broadcast input requires the full canonical shape
const missingBroadcastId: TownHallBroadcastInput = { townHall: input.townHall, source: input.source, recipients: input.recipients, text: input.text };
// @ts-expect-error text must be a string
const numericText: TownHallBroadcastInput = { ...input, text: 5 };
// @ts-expect-error providers are the finite agent-message vocabulary
const otherProvider: TownHallBroadcastInput = { ...input, source: { ...input.source, provider: 'other' } };
// @ts-expect-error get may return null, so the result cannot be used as a snapshot directly
const unguarded: TownHallBroadcastSnapshot = handlers.getTownHallBroadcast(state, journalKey);
// @ts-expect-error journalKey is read only
snapshot.journalKey = 'replacement';
// @ts-expect-error plan is read only
snapshot.plan = snapshot.plan;
// @ts-expect-error publication status is a read only finite state
snapshot.publication.status = 'published';
// @ts-expect-error recipient status is a read only finite state
snapshot.recipients[0].status = 'published';
// @ts-expect-error recipient target generation is read only
snapshot.recipients[0].target.generation = 2;
// @ts-expect-error recipients array is read only
snapshot.recipients.push(snapshot.recipients[0]);
// @ts-expect-error write result flag is read only
created.created = false;

void createdFlag;
void text;
void status;
void recipients;
void targetGeneration;
void packetId;
void manifestPrefix;
void recipientPrefix;
void planned;
void maybe;
void listed;
void missingBroadcastId;
void numericText;
void otherProvider;
void unguarded;
