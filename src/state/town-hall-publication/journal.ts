import { isDirectPostOutcome } from '../direct-post/contracts';
export { isDirectPostOutcome } from '../direct-post/contracts';
import {
  DIRECT_POST_OUTCOMES,
  TOWN_HALL_PUBLICATION_EVENTS,
  type SqlRow,
  type TownHallPublicationDependencies,
  type TownHallPublicationEvent,
  type TownHallPublicationOwner,
  type TownHallPublicationStateStore
} from './types';
import {
  deriveProjection,
  groupEvents,
  type AttemptGroup,
  type PublicationProjection,
  type PublicationEvent
} from './projection';
import type {
  PublicationContext
} from './context';


export const CORRUPT_MESSAGE = 'town-hall publication journal is corrupt';

const COMMON_DETAIL_KEYS = ['version', 'journalKey', 'fingerprint', 'event', 'attemptId', 'nonce', 'owner'] as const;
const OWNER_KEYS = ['ownerPid', 'ownerStartTime', 'ownerCommand'] as const;
const OUTCOME_EXTRA_KEYS = ['outcome', 'messageId'] as const;
const CONFIRMED_EXTRA_KEYS = ['messageId', 'guildId', 'channelId'] as const;

export interface ReceiptRow {
  id: number;
  kind: string;
  detail: string;
  discord_id: null;
}

interface DecodedEvent {
  event: string;
  attemptId: string;
  owner: TownHallPublicationOwner;
  outcome: string | null;
  messageId: string | null;
}

interface DecodedPublication {
  events: DecodedEvent[];
  groups: AttemptGroup[];
  projection: PublicationProjection;
}

export function reject(deps: TownHallPublicationDependencies): never {
  throw new deps.StateCorruptError(CORRUPT_MESSAGE);
}

// The single workflow-owned own-data snapshot. It rejects arrays, nonobjects, own
// symbol keys, accessor descriptors and unexpected keys; it never evaluates getters.
// Each descriptor value is read exactly once into a fresh ordinary record, which is
// then used for every validation, comparison and append read. Keys may be resolved
// from the captured snapshot itself when the required set depends on a field value.
export function snapshotOwnData(
  value: unknown,
  keys: readonly string[] | ((record: Record<string, unknown>) => readonly string[] | null),
  exact: boolean
): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.getOwnPropertySymbols(value).length !== 0) return null;
  const names = Object.getOwnPropertyNames(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = descriptors[name] as PropertyDescriptor | undefined;
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return null;
    snapshot[name] = descriptor.value;
  }
  const required = typeof keys === 'function' ? keys(snapshot) : keys;
  if (required === null) return null;
  if (exact && names.length !== required.length) return null;
  if (!names.every(name => (required as readonly string[]).includes(name))) return null;
  return snapshot;
}

function isPublicationEvent(value: unknown): value is TownHallPublicationEvent {
  return value === TOWN_HALL_PUBLICATION_EVENTS.RESERVED ||
    value === TOWN_HALL_PUBLICATION_EVENTS.IN_FLIGHT ||
    value === TOWN_HALL_PUBLICATION_EVENTS.OUTCOME ||
    value === TOWN_HALL_PUBLICATION_EVENTS.CONFIRMED;
}

function eventKeysFor(record: Record<string, unknown>): readonly string[] | null {
  const event = record.event;
  if (event === TOWN_HALL_PUBLICATION_EVENTS.OUTCOME) return [...COMMON_DETAIL_KEYS, ...OUTCOME_EXTRA_KEYS];
  if (event === TOWN_HALL_PUBLICATION_EVENTS.CONFIRMED) return [...COMMON_DETAIL_KEYS, ...CONFIRMED_EXTRA_KEYS];
  if (event === TOWN_HALL_PUBLICATION_EVENTS.RESERVED || event === TOWN_HALL_PUBLICATION_EVENTS.IN_FLIGHT) {
    return COMMON_DETAIL_KEYS;
  }
  return null;
}

function commandOf(owner: TownHallPublicationOwner): string | null {
  return owner.ownerCommand === undefined ? null : owner.ownerCommand;
}

export function sameOwner(left: TownHallPublicationOwner, right: TownHallPublicationOwner): boolean {
  return left.ownerPid === right.ownerPid &&
    left.ownerStartTime === right.ownerStartTime &&
    commandOf(left) === commandOf(right);
}

export function validOwner(owner: TownHallPublicationOwner | null): owner is TownHallPublicationOwner {
  if (owner === null) return false;
  if (!Number.isInteger(owner.ownerPid) || owner.ownerPid < 1) return false;
  if (typeof owner.ownerStartTime !== 'string' || owner.ownerStartTime.length === 0) return false;
  return owner.ownerCommand === null || typeof owner.ownerCommand === 'string';
}

export function copyOwner(owner: TownHallPublicationOwner): TownHallPublicationOwner {
  return { ownerPid: owner.ownerPid, ownerStartTime: owner.ownerStartTime, ownerCommand: commandOf(owner) };
}

function readRows(deps: TownHallPublicationDependencies, state: TownHallPublicationStateStore, kind: string): ReceiptRow[] {
  return state.db.prepare('SELECT id, kind, detail, discord_id FROM receipts WHERE kind=? ORDER BY id').all(kind)
    .filter(row => row.kind === kind)
    .map((row: SqlRow) => {
      // Compare the raw column so a null sentinel is not coerced into a non-null value.
      if (row.discord_id !== null) return reject(deps);
      return { id: Number(row.id), kind: String(row.kind), detail: String(row.detail), discord_id: null };
    });
}

function parseDetail(deps: TownHallPublicationDependencies, detail: string): unknown {
  try {
    return JSON.parse(detail);
  } catch {
    return reject(deps);
  }
}

function canonicalEvent(
  deps: TownHallPublicationDependencies,
  context: PublicationContext,
  detail: string
): DecodedEvent {
  const parsed = parseDetail(deps, detail);
  const eventRecord = snapshotOwnData(parsed, eventKeysFor, true);
  if (eventRecord === null) reject(deps);
  const event = eventRecord.event;
  if (typeof event !== 'string' || !isPublicationEvent(event)) reject(deps);
  const ownerRecord = snapshotOwnData(eventRecord.owner, OWNER_KEYS, true);
  if (ownerRecord === null) reject(deps);
  if (eventRecord.version !== 1 || eventRecord.journalKey !== context.journalKey) reject(deps);
  if (eventRecord.fingerprint !== context.fingerprint || eventRecord.nonce !== context.nonce) reject(deps);
  if (typeof eventRecord.attemptId !== 'string' || eventRecord.attemptId.length === 0) reject(deps);
  const owner = ownerRecord as unknown as TownHallPublicationOwner;
  if (!validOwner(owner)) reject(deps);
  const decoded: DecodedEvent = {
    event,
    attemptId: eventRecord.attemptId as string,
    owner: copyOwner(owner),
    outcome: null,
    messageId: null
  };
  if (event === TOWN_HALL_PUBLICATION_EVENTS.OUTCOME) {
    const outcome = eventRecord.outcome;
    if (!isDirectPostOutcome(outcome)) reject(deps);
    if (outcome === DIRECT_POST_OUTCOMES.SENT) {
      if (typeof eventRecord.messageId !== 'string' || eventRecord.messageId.length === 0) reject(deps);
    } else if (eventRecord.messageId !== null) reject(deps);
    decoded.outcome = outcome;
    decoded.messageId = outcome === DIRECT_POST_OUTCOMES.SENT ? String(eventRecord.messageId) : null;
  }
  if (event === TOWN_HALL_PUBLICATION_EVENTS.CONFIRMED) {
    if (typeof eventRecord.messageId !== 'string' || eventRecord.messageId.length === 0) reject(deps);
    if (eventRecord.guildId !== context.guildId || eventRecord.channelId !== context.channelId) reject(deps);
    decoded.messageId = eventRecord.messageId as string;
  }
  return decoded;
}

function toPublicationEvents(events: readonly DecodedEvent[]): PublicationEvent[] {
  return events.map(entry => ({
    event: entry.event,
    attemptId: entry.attemptId,
    owner: entry.owner,
    outcome: entry.outcome ?? undefined,
    messageId: entry.messageId
  }));
}

export function decodePublication(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  context: PublicationContext,
  preReadRows?: ReceiptRow[]
): DecodedPublication {
  const rows = preReadRows ?? readRows(deps, state, context.receiptKind);
  const events = rows.map(row => canonicalEvent(deps, context, row.detail));
  let groups: AttemptGroup[];
  try {
    groups = groupEvents(toPublicationEvents(events));
  } catch {
    return reject(deps);
  }
  return { events, groups, projection: deriveProjection(groups, context.nonce) };
}

export function appendEvent(
  state: TownHallPublicationStateStore,
  context: PublicationContext,
  event: string,
  attemptId: string,
  owner: TownHallPublicationOwner,
  extra: Record<string, unknown>
): void {
  state.receipt(null, context.receiptKind, {
    version: 1,
    journalKey: context.journalKey,
    fingerprint: context.fingerprint,
    event,
    attemptId,
    nonce: context.nonce,
    owner: copyOwner(owner),
    ...extra
  });
}

export function readRowsByPrefix(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  prefix: string
): ReceiptRow[] {
  let pattern = '';
  for (const character of prefix) {
    if (character === '*' || character === '?' || character === '[') pattern += `[${character}]`;
    else pattern += character;
  }
  return state.db.prepare(
    'SELECT id, kind, detail, discord_id FROM receipts WHERE kind GLOB ? COLLATE BINARY ORDER BY id'
  ).all(`${pattern}*`).filter((row: SqlRow) => String(row.kind).startsWith(prefix)).map((row: SqlRow) => {
    if (row.discord_id !== null) return reject(deps);
    return { id: Number(row.id), kind: String(row.kind), detail: String(row.detail), discord_id: null };
  });
}
