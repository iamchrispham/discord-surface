import { randomUUID } from 'node:crypto';
import {
  DIRECT_POST_OUTCOMES,
  DIRECT_POST_PART_STATUSES,
  TOWN_HALL_PUBLICATION_EVENTS,
  TOWN_HALL_PUBLICATION_RECEIPTS,
  type DirectPostOutcome,
  type SqlRow,
  type TownHallPublication,
  type TownHallPublicationDependencies,
  type TownHallPublicationConfirmationEvidence,
  type TownHallPublicationEvent,
  type TownHallPublicationOwner,
  type TownHallPublicationStateStore
} from './types';
import {
  deriveProjection,
  freezePublication,
  groupEvents,
  publicationKeyFor,
  type AttemptGroup,
  type PublicationProjection,
  type PublicationEvent
} from './projection';

const INVALID_KEY_MESSAGE = 'invalid town-hall journal key';
const MISSING_JOURNAL_MESSAGE = 'town-hall publication requires an existing journal';
const OWNER_UNAVAILABLE_MESSAGE = 'town-hall publication owner identity is unavailable';
const MARK_REFUSED_MESSAGE = 'town-hall publication attempt is not claimed';
const RECORD_REFUSED_MESSAGE = 'town-hall publication attempt is not in flight';
const INVALID_OUTCOME_MESSAGE = 'town-hall publication outcome is invalid';
const OUTCOME_CONFLICT_MESSAGE = 'town-hall publication outcome conflict';
const CONFIRM_REFUSED_MESSAGE = 'town-hall publication confirmation is not admissible';
const CORRUPT_MESSAGE = 'town-hall publication journal is corrupt';
const KEY_PATTERN = /^[0-9a-f]{64}$/;

const COMMON_DETAIL_KEYS = ['version', 'journalKey', 'fingerprint', 'event', 'attemptId', 'nonce', 'owner'] as const;
const OWNER_KEYS = ['ownerPid', 'ownerStartTime', 'ownerCommand'] as const;
const OUTCOME_EXTRA_KEYS = ['outcome', 'messageId'] as const;
const CONFIRMED_EXTRA_KEYS = ['messageId', 'guildId', 'channelId'] as const;
const OUTCOME_DETAIL_KEYS = ['messageId'] as const;
const EVIDENCE_KEYS = ['messageId', 'nonce', 'guildId', 'channelId'] as const;
const BLOCKED_RESERVE_STATUSES = new Set<string>([
  DIRECT_POST_PART_STATUSES.CLAIMED,
  DIRECT_POST_PART_STATUSES.IN_FLIGHT,
  DIRECT_POST_OUTCOMES.SENT,
  DIRECT_POST_OUTCOMES.UNKNOWN
]);

interface ReceiptRow {
  id: number;
  kind: string;
  detail: string;
  discord_id: null;
}

interface PublicationContext {
  journalKey: string;
  publicationKey: string;
  receiptKind: string;
  nonce: string;
  fingerprint: string;
  guildId: string;
  channelId: string;
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

function reject(deps: TownHallPublicationDependencies): never {
  throw new deps.StateCorruptError(CORRUPT_MESSAGE);
}

// The single workflow-owned own-data snapshot. It rejects arrays, nonobjects, own
// symbol keys, accessor descriptors and unexpected keys; it never evaluates getters.
// Each descriptor value is read exactly once into a fresh ordinary record, which is
// then used for every validation, comparison and append read. Keys may be resolved
// from the captured snapshot itself when the required set depends on a field value.
function snapshotOwnData(
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
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) return null;
    snapshot[name] = descriptor.value;
  }
  const required = typeof keys === 'function' ? keys(snapshot) : keys;
  if (required === null) return null;
  if (exact && names.length !== required.length) return null;
  if (!names.every(name => (required as readonly string[]).includes(name))) return null;
  return snapshot;
}

function isDirectPostOutcome(value: unknown): value is DirectPostOutcome {
  return typeof value === 'string' && (Object.values(DIRECT_POST_OUTCOMES) as readonly string[]).includes(value);
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

function assertJournalKey(deps: TownHallPublicationDependencies, journalKey: string): string {
  if (typeof journalKey !== 'string' || !KEY_PATTERN.test(journalKey)) throw new deps.BindingError(INVALID_KEY_MESSAGE);
  return journalKey;
}

function commandOf(owner: TownHallPublicationOwner): string | null {
  return owner.ownerCommand === undefined ? null : owner.ownerCommand;
}

function sameOwner(left: TownHallPublicationOwner, right: TownHallPublicationOwner): boolean {
  return left.ownerPid === right.ownerPid &&
    left.ownerStartTime === right.ownerStartTime &&
    commandOf(left) === commandOf(right);
}

function validOwner(owner: TownHallPublicationOwner | null): owner is TownHallPublicationOwner {
  if (owner === null) return false;
  if (!Number.isInteger(owner.ownerPid) || owner.ownerPid < 1) return false;
  if (typeof owner.ownerStartTime !== 'string' || owner.ownerStartTime.length === 0) return false;
  return owner.ownerCommand === null || typeof owner.ownerCommand === 'string';
}

function copyOwner(owner: TownHallPublicationOwner): TownHallPublicationOwner {
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

function decodePublication(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  context: PublicationContext
): DecodedPublication {
  const events = readRows(deps, state, context.receiptKind).map(row => canonicalEvent(deps, context, row.detail));
  let groups: AttemptGroup[];
  try {
    groups = groupEvents(toPublicationEvents(events));
  } catch {
    return reject(deps);
  }
  return { events, groups, projection: deriveProjection(groups, context.nonce) };
}

function publicationOf(context: PublicationContext, projection: PublicationProjection): TownHallPublication {
  return freezePublication(context.journalKey, context.fingerprint, projection);
}

function readContext(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  journalKey: string
): PublicationContext {
  // getTownHallBroadcast opens its own BEGIN IMMEDIATE, so it must run outside any transaction.
  const journal = state.getTownHallBroadcast(journalKey);
  if (journal === null) throw new deps.BindingError(MISSING_JOURNAL_MESSAGE);
  const publicationKey = publicationKeyFor(journalKey);
  return {
    journalKey,
    publicationKey,
    receiptKind: TOWN_HALL_PUBLICATION_RECEIPTS.PUBLICATION_PREFIX + journalKey,
    nonce: deps.discordNonce(publicationKey),
    fingerprint: journal.plan.fingerprint,
    guildId: journal.plan.townHall.guildId,
    channelId: journal.plan.townHall.channelId
  };
}

function ownerIdentity(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore
): TownHallPublicationOwner {
  const owner = state.directPostOwnerIdentity(process.pid);
  if (owner === null || !validOwner(owner)) throw new deps.BindingError(OWNER_UNAVAILABLE_MESSAGE);
  return copyOwner(owner);
}

function currentMatchesStored(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  stored: TownHallPublicationOwner | null
): boolean {
  if (stored === null) return false;
  const current = state.directPostOwnerIdentity(process.pid);
  return current !== null && sameOwner(current, stored);
}

function appendEvent(
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

function messageIdFor(outcome: DirectPostOutcome, detail: Record<string, unknown> | undefined): string | null {
  if (outcome !== DIRECT_POST_OUTCOMES.SENT) return null;
  return String(detail?.messageId);
}

export function getTownHallPublication(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  journalKey: string
): TownHallPublication {
  const key = assertJournalKey(deps, journalKey);
  const context = readContext(deps, state, key);
  return publicationOf(context, decodePublication(deps, state, context).projection);
}

export function reserveTownHallPublication(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  journalKey: string
): { claimed: boolean; publication: TownHallPublication } {
  const key = assertJournalKey(deps, journalKey);
  const context = readContext(deps, state, key);
  return state.transaction(() => {
    const decoded = decodePublication(deps, state, context);
    if (BLOCKED_RESERVE_STATUSES.has(decoded.projection.status)) {
      return { claimed: false, publication: publicationOf(context, decoded.projection) };
    }
    const owner = ownerIdentity(deps, state);
    const attemptId = randomUUID();
    appendEvent(state, context, TOWN_HALL_PUBLICATION_EVENTS.RESERVED, attemptId, owner, {});
    const updated = decodePublication(deps, state, context);
    return { claimed: true, publication: publicationOf(context, updated.projection) };
  });
}

export function markTownHallPublicationInFlight(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  journalKey: string,
  attemptId: string
): { started: boolean; publication: TownHallPublication } {
  const key = assertJournalKey(deps, journalKey);
  const context = readContext(deps, state, key);
  return state.transaction(() => {
    const decoded = decodePublication(deps, state, context);
    const projection = decoded.projection;
    if (projection.attemptId === null || projection.attemptId !== attemptId) {
      throw new deps.BindingError(MARK_REFUSED_MESSAGE);
    }
    if (!currentMatchesStored(deps, state, projection.owner)) {
      throw new deps.BindingError(MARK_REFUSED_MESSAGE);
    }
    if (projection.status === DIRECT_POST_PART_STATUSES.IN_FLIGHT) {
      return { started: false, publication: publicationOf(context, projection) };
    }
    if (projection.status !== DIRECT_POST_PART_STATUSES.CLAIMED) {
      throw new deps.BindingError(MARK_REFUSED_MESSAGE);
    }
    appendEvent(state, context, TOWN_HALL_PUBLICATION_EVENTS.IN_FLIGHT, attemptId, projection.owner as TownHallPublicationOwner, {});
    const updated = decodePublication(deps, state, context);
    return { started: true, publication: publicationOf(context, updated.projection) };
  });
}

export function recordTownHallPublicationOutcome(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  journalKey: string,
  attemptId: string,
  outcome: DirectPostOutcome,
  detail?: Record<string, unknown>
): TownHallPublication {
  const key = assertJournalKey(deps, journalKey);
  const context = readContext(deps, state, key);
  return state.transaction(() => {
    const decoded = decodePublication(deps, state, context);
    const projection = decoded.projection;
    const group = decoded.groups.length === 0 ? null : decoded.groups[decoded.groups.length - 1];
    if (projection.attemptId === null || projection.attemptId !== attemptId || group === null) {
      throw new deps.BindingError(RECORD_REFUSED_MESSAGE);
    }
    if (!currentMatchesStored(deps, state, projection.owner)) throw new deps.BindingError(RECORD_REFUSED_MESSAGE);
    if (!isDirectPostOutcome(outcome)) {
      throw new deps.BindingError(INVALID_OUTCOME_MESSAGE);
    }
    let detailRecord: Record<string, unknown> | undefined;
    if (detail !== undefined) {
      const snapshot = snapshotOwnData(detail, OUTCOME_DETAIL_KEYS, false);
      if (snapshot === null) throw new deps.BindingError(RECORD_REFUSED_MESSAGE);
      detailRecord = snapshot;
    }
    const hasMessageId = detailRecord !== undefined && Object.prototype.hasOwnProperty.call(detailRecord, 'messageId');
    if (outcome === DIRECT_POST_OUTCOMES.SENT) {
      if (!hasMessageId || typeof detailRecord?.messageId !== 'string' || detailRecord.messageId.length === 0) {
        throw new deps.BindingError(RECORD_REFUSED_MESSAGE);
      }
    } else if (hasMessageId) {
      throw new deps.BindingError(RECORD_REFUSED_MESSAGE);
    }
    if (group.outcome !== null) {
      const identical = group.outcome === outcome && group.outcomeMessageId === messageIdFor(outcome, detailRecord);
      if (identical) return publicationOf(context, projection);
      throw new deps.BindingError(OUTCOME_CONFLICT_MESSAGE);
    }
    if (projection.status === DIRECT_POST_PART_STATUSES.CLAIMED && outcome !== DIRECT_POST_OUTCOMES.NOT_SENT) {
      throw new deps.BindingError(RECORD_REFUSED_MESSAGE);
    }
    appendEvent(state, context, TOWN_HALL_PUBLICATION_EVENTS.OUTCOME, attemptId, projection.owner as TownHallPublicationOwner, {
      outcome,
      messageId: messageIdFor(outcome, detailRecord)
    });
    const updated = decodePublication(deps, state, context);
    return publicationOf(context, updated.projection);
  });
}

export function confirmTownHallPublication(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  journalKey: string,
  attemptId: string,
  evidence: TownHallPublicationConfirmationEvidence
): TownHallPublication {
  const key = assertJournalKey(deps, journalKey);
  const context = readContext(deps, state, key);
  return state.transaction(() => {
    const decoded = decodePublication(deps, state, context);
    const projection = decoded.projection;
    const group = decoded.groups.length === 0 ? null : decoded.groups[decoded.groups.length - 1];
    if (projection.attemptId === null || projection.attemptId !== attemptId || group === null) {
      throw new deps.BindingError(CONFIRM_REFUSED_MESSAGE);
    }
    if (!currentMatchesStored(deps, state, projection.owner)) throw new deps.BindingError(CONFIRM_REFUSED_MESSAGE);
    const evidenceRecord = snapshotOwnData(evidence, EVIDENCE_KEYS, true);
    if (evidenceRecord === null) {
      throw new deps.BindingError(CONFIRM_REFUSED_MESSAGE);
    }
    if (typeof evidenceRecord.messageId !== 'string' || evidenceRecord.messageId.length === 0 ||
        typeof evidenceRecord.nonce !== 'string' || evidenceRecord.nonce.length === 0 ||
        typeof evidenceRecord.guildId !== 'string' || evidenceRecord.guildId.length === 0 ||
        typeof evidenceRecord.channelId !== 'string' || evidenceRecord.channelId.length === 0) {
      throw new deps.BindingError(CONFIRM_REFUSED_MESSAGE);
    }
    if (group.confirmed) {
      const identical = group.confirmedMessageId === evidenceRecord.messageId &&
        evidenceRecord.nonce === context.nonce &&
        evidenceRecord.guildId === context.guildId &&
        evidenceRecord.channelId === context.channelId;
      if (identical) return publicationOf(context, projection);
      throw new deps.BindingError(CONFIRM_REFUSED_MESSAGE);
    }
    if (projection.status !== DIRECT_POST_OUTCOMES.UNKNOWN) throw new deps.BindingError(CONFIRM_REFUSED_MESSAGE);
    if (evidenceRecord.nonce !== context.nonce) throw new deps.BindingError(CONFIRM_REFUSED_MESSAGE);
    if (evidenceRecord.guildId !== context.guildId || evidenceRecord.channelId !== context.channelId) {
      throw new deps.BindingError(CONFIRM_REFUSED_MESSAGE);
    }
    appendEvent(state, context, TOWN_HALL_PUBLICATION_EVENTS.CONFIRMED, attemptId, projection.owner as TownHallPublicationOwner, {
      messageId: evidenceRecord.messageId,
      guildId: context.guildId,
      channelId: context.channelId
    });
    const updated = decodePublication(deps, state, context);
    return publicationOf(context, updated.projection);
  });
}

type Liveness = 'matching-live' | 'indeterminate' | 'absent';

function classifyLiveness(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  owner: TownHallPublicationOwner
): Liveness {
  if (owner.ownerStartTime.length === 0) return 'indeterminate';
  if (state.directPostOwnerAlive(owner.ownerPid, owner) === true) return 'matching-live';
  try {
    deps.probePid(owner.ownerPid);
    return 'indeterminate';
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    return code === 'ESRCH' ? 'absent' : 'indeterminate';
  }
}

export function recoverTownHallPublication(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  journalKey: string
): TownHallPublication {
  const key = assertJournalKey(deps, journalKey);
  const context = readContext(deps, state, key);
  const first = decodePublication(deps, state, context);
  if (first.projection.status !== DIRECT_POST_PART_STATUSES.CLAIMED &&
      first.projection.status !== DIRECT_POST_PART_STATUSES.IN_FLIGHT) {
    return publicationOf(context, first.projection);
  }
  const owner = first.projection.owner as TownHallPublicationOwner;
  const liveness = classifyLiveness(deps, state, owner);
  return state.transaction(() => {
    const second = decodePublication(deps, state, context);
    if (second.projection.attemptId !== first.projection.attemptId ||
        second.projection.status !== first.projection.status) {
      return publicationOf(context, second.projection);
    }
    const storedOwner = second.projection.owner as TownHallPublicationOwner;
    const attemptId = second.projection.attemptId as string;
    let outcome: DirectPostOutcome | null = null;
    if (liveness === 'absent' && second.projection.status === DIRECT_POST_PART_STATUSES.CLAIMED) {
      outcome = DIRECT_POST_OUTCOMES.NOT_SENT;
    }
    if (second.projection.status === DIRECT_POST_PART_STATUSES.IN_FLIGHT && liveness !== 'matching-live') {
      outcome = DIRECT_POST_OUTCOMES.UNKNOWN;
    }
    if (outcome === null) return publicationOf(context, second.projection);
    appendEvent(state, context, TOWN_HALL_PUBLICATION_EVENTS.OUTCOME, attemptId, storedOwner, {
      outcome,
      messageId: null
    });
    const updated = decodePublication(deps, state, context);
    return publicationOf(context, updated.projection);
  });
}

export type { SqlRow };
