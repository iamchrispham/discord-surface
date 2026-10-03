import { randomUUID } from 'node:crypto';
import {
  DIRECT_POST_OUTCOMES,
  TOWN_HALL_PUBLICATION_EVENTS,
  TOWN_HALL_PUBLICATION_RECEIPTS,
  type DirectPostOutcome,
  type SqlRow,
  type TownHallPublication,
  type TownHallPublicationDependencies,
  type TownHallPublicationConfirmationEvidence,
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
const EVIDENCE_KEYS = ['messageId', 'nonce', 'guildId', 'channelId'] as const;
const BLOCKED_RESERVE_STATUSES = new Set(['claimed', 'in_flight', 'sent', 'unknown']);

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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value);
  return names.length === keys.length && names.every(name => keys.includes(name));
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
  if (!isPlainRecord(parsed)) reject(deps);
  const event = parsed.event;
  if (event !== TOWN_HALL_PUBLICATION_EVENTS.RESERVED &&
      event !== TOWN_HALL_PUBLICATION_EVENTS.IN_FLIGHT &&
      event !== TOWN_HALL_PUBLICATION_EVENTS.OUTCOME &&
      event !== TOWN_HALL_PUBLICATION_EVENTS.CONFIRMED) reject(deps);
  const eventKeys = event === TOWN_HALL_PUBLICATION_EVENTS.OUTCOME
    ? [...COMMON_DETAIL_KEYS, ...OUTCOME_EXTRA_KEYS]
    : event === TOWN_HALL_PUBLICATION_EVENTS.CONFIRMED
      ? [...COMMON_DETAIL_KEYS, ...CONFIRMED_EXTRA_KEYS]
      : [...COMMON_DETAIL_KEYS];
  if (!hasExactKeys(parsed, eventKeys)) reject(deps);
  if (parsed.version !== 1 || parsed.journalKey !== context.journalKey) reject(deps);
  if (parsed.fingerprint !== context.fingerprint || parsed.nonce !== context.nonce) reject(deps);
  if (typeof parsed.attemptId !== 'string' || parsed.attemptId.length === 0) reject(deps);
  if (!isPlainRecord(parsed.owner) || !hasExactKeys(parsed.owner, OWNER_KEYS)) reject(deps);
  const owner = parsed.owner as unknown as TownHallPublicationOwner;
  if (!validOwner(owner)) reject(deps);
  const decoded: DecodedEvent = {
    event,
    attemptId: parsed.attemptId,
    owner: copyOwner(owner),
    outcome: null,
    messageId: null
  };
  if (event === TOWN_HALL_PUBLICATION_EVENTS.OUTCOME) {
    const outcome = parsed.outcome;
    if (typeof outcome !== 'string' || !(Object.values(DIRECT_POST_OUTCOMES) as readonly string[]).includes(outcome)) reject(deps);
    if (outcome === 'sent') {
      if (typeof parsed.messageId !== 'string' || parsed.messageId.length === 0) reject(deps);
    } else if (parsed.messageId !== null) reject(deps);
    decoded.outcome = outcome;
    decoded.messageId = outcome === 'sent' ? String(parsed.messageId) : null;
  }
  if (event === TOWN_HALL_PUBLICATION_EVENTS.CONFIRMED) {
    if (typeof parsed.messageId !== 'string' || parsed.messageId.length === 0) reject(deps);
    if (parsed.guildId !== context.guildId || parsed.channelId !== context.channelId) reject(deps);
    decoded.messageId = parsed.messageId;
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
  if (outcome !== 'sent') return null;
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
    if (projection.status === 'in_flight') {
      return { started: false, publication: publicationOf(context, projection) };
    }
    if (projection.status !== 'claimed') {
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
    if (typeof outcome !== 'string' || !(Object.values(DIRECT_POST_OUTCOMES) as readonly string[]).includes(outcome)) {
      throw new deps.BindingError(INVALID_OUTCOME_MESSAGE);
    }
    if (detail !== undefined) {
      if (!isPlainRecord(detail)) throw new deps.BindingError(RECORD_REFUSED_MESSAGE);
      if (Object.getOwnPropertySymbols(detail).length !== 0) throw new deps.BindingError(RECORD_REFUSED_MESSAGE);
      if (!Object.getOwnPropertyNames(detail).every(name => name === 'messageId')) {
        throw new deps.BindingError(RECORD_REFUSED_MESSAGE);
      }
    }
    const hasMessageId = detail !== undefined && Object.prototype.hasOwnProperty.call(detail, 'messageId');
    if (outcome === 'sent') {
      if (!hasMessageId || typeof detail?.messageId !== 'string' || detail.messageId.length === 0) {
        throw new deps.BindingError(RECORD_REFUSED_MESSAGE);
      }
    } else if (hasMessageId) {
      throw new deps.BindingError(RECORD_REFUSED_MESSAGE);
    }
    if (group.outcome !== null) {
      const identical = group.outcome === outcome && group.outcomeMessageId === messageIdFor(outcome, detail);
      if (identical) return publicationOf(context, projection);
      throw new deps.BindingError(OUTCOME_CONFLICT_MESSAGE);
    }
    if (projection.status === 'claimed' && outcome !== 'not_sent') {
      throw new deps.BindingError(RECORD_REFUSED_MESSAGE);
    }
    appendEvent(state, context, TOWN_HALL_PUBLICATION_EVENTS.OUTCOME, attemptId, projection.owner as TownHallPublicationOwner, {
      outcome,
      messageId: messageIdFor(outcome, detail)
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
    if (!isPlainRecord(evidence) || !hasExactKeys(evidence as unknown as Record<string, unknown>, EVIDENCE_KEYS)) {
      throw new deps.BindingError(CONFIRM_REFUSED_MESSAGE);
    }
    if (typeof evidence.messageId !== 'string' || evidence.messageId.length === 0 ||
        typeof evidence.nonce !== 'string' || evidence.nonce.length === 0 ||
        typeof evidence.guildId !== 'string' || evidence.guildId.length === 0 ||
        typeof evidence.channelId !== 'string' || evidence.channelId.length === 0) {
      throw new deps.BindingError(CONFIRM_REFUSED_MESSAGE);
    }
    if (group.confirmed) {
      const identical = group.confirmedMessageId === evidence.messageId &&
        evidence.nonce === context.nonce &&
        evidence.guildId === context.guildId &&
        evidence.channelId === context.channelId;
      if (identical) return publicationOf(context, projection);
      throw new deps.BindingError(CONFIRM_REFUSED_MESSAGE);
    }
    if (projection.status !== 'unknown') throw new deps.BindingError(CONFIRM_REFUSED_MESSAGE);
    if (evidence.nonce !== context.nonce) throw new deps.BindingError(CONFIRM_REFUSED_MESSAGE);
    if (evidence.guildId !== context.guildId || evidence.channelId !== context.channelId) {
      throw new deps.BindingError(CONFIRM_REFUSED_MESSAGE);
    }
    appendEvent(state, context, TOWN_HALL_PUBLICATION_EVENTS.CONFIRMED, attemptId, projection.owner as TownHallPublicationOwner, {
      messageId: evidence.messageId,
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
  if (first.projection.status !== 'claimed' && first.projection.status !== 'in_flight') {
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
    if (liveness === 'absent' && second.projection.status === 'claimed') outcome = 'not_sent';
    if (second.projection.status === 'in_flight' && liveness !== 'matching-live') outcome = 'unknown';
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
