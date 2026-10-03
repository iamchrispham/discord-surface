import { DIRECT_POST_OUTCOMES, DIRECT_POST_PART_STATUSES, TOWN_HALL_PUBLICATION_EVENTS, TOWN_HALL_PUBLICATION_RECEIPTS } from './types';
import type { TownHallPublication, TownHallPublicationOwner, TownHallPublicationPartId, TownHallPublicationSet, TownHallPublicationStatus } from './types';
import { TOWN_HALL_JOURNAL_STATES } from '../town-hall-journal/types';

export interface PublicationEvent {
  readonly event: string;
  readonly attemptId: string;
  readonly owner: TownHallPublicationOwner;
  readonly outcome?: string;
  readonly messageId?: string | null;
}

export interface AttemptGroup {
  readonly attemptId: string;
  readonly owner: TownHallPublicationOwner;
  readonly reserved: boolean;
  readonly inFlight: boolean;
  readonly outcome: string | null;
  readonly outcomeMessageId: string | null;
  readonly confirmed: boolean;
  readonly confirmedMessageId: string | null;
}

export interface PublicationProjection {
  readonly status: TownHallPublicationStatus;
  readonly attemptId: string | null;
  readonly nonce: string;
  readonly owner: TownHallPublicationOwner | null;
  readonly messageId: string | null;
}

const RETRYABLE_OUTCOMES = new Set<string>([
  DIRECT_POST_OUTCOMES.NOT_SENT,
  DIRECT_POST_OUTCOMES.REJECTED,
  DIRECT_POST_OUTCOMES.RATE_LIMITED,
  DIRECT_POST_OUTCOMES.STALE
]);

export function publicationKeyFor(journalKey: string, partId?: string): string {
  if (partId === undefined) return TOWN_HALL_PUBLICATION_RECEIPTS.INSTRUCTION_PREFIX + journalKey;
  return TOWN_HALL_PUBLICATION_RECEIPTS.INSTRUCTION_PART_PREFIX + journalKey + ':' + partId;
}

export function receiptKindFor(journalKey: string, partId?: string): string {
  if (partId === undefined) return TOWN_HALL_PUBLICATION_RECEIPTS.PUBLICATION_PREFIX + journalKey;
  return TOWN_HALL_PUBLICATION_RECEIPTS.PUBLICATION_PART_PREFIX + journalKey + ':' + partId;
}

function sameOwner(left: TownHallPublicationOwner, right: TownHallPublicationOwner): boolean {
  return left.ownerPid === right.ownerPid &&
    left.ownerStartTime === right.ownerStartTime &&
    left.ownerCommand === right.ownerCommand;
}

function groupStatus(group: AttemptGroup): TownHallPublicationStatus {
  if (group.confirmed) return DIRECT_POST_OUTCOMES.SENT;
  if (group.outcome !== null) return group.outcome as TownHallPublicationStatus;
  if (group.inFlight) return DIRECT_POST_PART_STATUSES.IN_FLIGHT;
  return DIRECT_POST_PART_STATUSES.CLAIMED;
}

export function groupEvents(events: readonly PublicationEvent[]): AttemptGroup[] {
  const groups: AttemptGroup[] = [];
  const seenAttempts = new Set<string>();
  let current: AttemptGroup | null = null;
  for (const event of events) {
    if (event.event === TOWN_HALL_PUBLICATION_EVENTS.RESERVED) {
      if (seenAttempts.has(event.attemptId)) throw new Error('duplicate publication attempt');
      if (current !== null && !RETRYABLE_OUTCOMES.has(groupStatus(current))) {
        throw new Error('publication retry before terminal outcome');
      }
      seenAttempts.add(event.attemptId);
      current = {
        attemptId: event.attemptId,
        owner: event.owner,
        reserved: true,
        inFlight: false,
        outcome: null,
        outcomeMessageId: null,
        confirmed: false,
        confirmedMessageId: null
      };
      groups.push(current);
      continue;
    }
    if (current === null || current.attemptId !== event.attemptId) throw new Error('orphan publication event');
    if (!sameOwner(event.owner, current.owner)) throw new Error('publication attempt owner mismatch');
    switch (event.event) {
      case TOWN_HALL_PUBLICATION_EVENTS.IN_FLIGHT:
        if (current.inFlight || current.outcome !== null || current.confirmed) throw new Error('misordered in-flight event');
        current = { ...current, inFlight: true };
        break;
      case TOWN_HALL_PUBLICATION_EVENTS.OUTCOME:
        if (current.outcome !== null || current.confirmed) throw new Error('misordered outcome event');
        if (!current.inFlight && event.outcome !== DIRECT_POST_OUTCOMES.NOT_SENT) throw new Error('outcome before in-flight');
        current = { ...current, outcome: event.outcome ?? null, outcomeMessageId: event.messageId ?? null };
        break;
      case TOWN_HALL_PUBLICATION_EVENTS.CONFIRMED:
        if (current.confirmed || current.outcome !== DIRECT_POST_OUTCOMES.UNKNOWN) throw new Error('misordered confirmation event');
        current = { ...current, confirmed: true, confirmedMessageId: event.messageId ?? null };
        break;
      default:
        throw new Error('unknown publication event');
    }
    groups[groups.length - 1] = current;
  }
  return groups;
}

export function deriveProjection(groups: readonly AttemptGroup[], nonce: string): PublicationProjection {
  const latest = groups.length === 0 ? null : groups[groups.length - 1];
  if (!latest) {
    return Object.freeze({ status: TOWN_HALL_JOURNAL_STATES.PLANNED, attemptId: null, nonce, owner: null, messageId: null });
  }
  let status: TownHallPublicationStatus = DIRECT_POST_PART_STATUSES.CLAIMED;
  let messageId: string | null = null;
  if (latest.confirmed) {
    status = DIRECT_POST_OUTCOMES.SENT;
    messageId = latest.confirmedMessageId;
  } else if (latest.outcome !== null) {
    status = latest.outcome as TownHallPublicationStatus;
    messageId = latest.outcome === DIRECT_POST_OUTCOMES.SENT ? latest.outcomeMessageId : null;
  } else if (latest.inFlight) {
    status = DIRECT_POST_PART_STATUSES.IN_FLIGHT;
  }
  return Object.freeze({ status, attemptId: latest.attemptId, nonce, owner: latest.owner, messageId });
}

export function freezePublication(
  journalKey: string,
  fingerprint: string,
  projection: PublicationProjection,
  publicationKey: string = publicationKeyFor(journalKey)
): TownHallPublication {
  const owner = projection.owner === null
    ? null
    : Object.freeze({
        ownerPid: projection.owner.ownerPid,
        ownerStartTime: projection.owner.ownerStartTime,
        ownerCommand: projection.owner.ownerCommand
      });
  return Object.freeze({
    journalKey,
    publicationKey,
    fingerprint,
    status: projection.status,
    attemptId: projection.attemptId,
    nonce: projection.nonce,
    owner,
    messageId: projection.messageId
  });
}

export interface PlannedPublicationPart {
  readonly index: number;
  readonly total: number;
  readonly partId: TownHallPublicationPartId;
  readonly content: string;
  readonly publication: TownHallPublication;
}

// Pure assembly of the read-only set projection. The complete flag requires an
// actual sent message ID with distinct IDs across every expected part.
export function freezePublicationSet(
  journalKey: string,
  fingerprint: string,
  parts: readonly PlannedPublicationPart[]
): TownHallPublicationSet {
  const frozenParts = parts.map(part => Object.freeze({
    index: part.index,
    total: part.total,
    partId: part.partId,
    content: part.content,
    publication: part.publication
  }));
  const complete = parts.length > 0 && parts.every(part =>
    part.publication.status === DIRECT_POST_OUTCOMES.SENT &&
    typeof part.publication.messageId === 'string' &&
    part.publication.messageId.length > 0
  );
  const messageIds = new Set(parts.map(part => part.publication.messageId));
  const distinct = messageIds.size === parts.length;
  const finished = complete && distinct;
  Object.freeze(frozenParts);
  return Object.freeze({
    journalKey,
    fingerprint,
    complete: finished,
    anchorMessageId: finished ? frozenParts[0].publication.messageId : null,
    parts: frozenParts
  });
}

export function duplicateMessageId(parts: readonly PlannedPublicationPart[]): boolean {
  const seen = new Set<string>();
  for (const part of parts) {
    const messageId = part.publication.messageId;
    if (typeof messageId !== 'string' || messageId.length === 0) continue;
    if (seen.has(messageId)) return true;
    seen.add(messageId);
  }
  return false;
}
