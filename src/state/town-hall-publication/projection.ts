import { TOWN_HALL_PUBLICATION_EVENTS, TOWN_HALL_PUBLICATION_RECEIPTS } from './types';
import type { TownHallPublication, TownHallPublicationOwner, TownHallPublicationStatus } from './types';

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

const RETRYABLE_OUTCOMES = new Set(['not_sent', 'rejected', 'rate_limited', 'stale']);

export function publicationKeyFor(journalKey: string): string {
  return TOWN_HALL_PUBLICATION_RECEIPTS.INSTRUCTION_PREFIX + journalKey;
}

function sameOwner(left: TownHallPublicationOwner, right: TownHallPublicationOwner): boolean {
  return left.ownerPid === right.ownerPid &&
    left.ownerStartTime === right.ownerStartTime &&
    left.ownerCommand === right.ownerCommand;
}

function groupStatus(group: AttemptGroup): TownHallPublicationStatus {
  if (group.confirmed) return 'sent';
  if (group.outcome !== null) return group.outcome as TownHallPublicationStatus;
  if (group.inFlight) return 'in_flight';
  return 'claimed';
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
        if (!current.inFlight && event.outcome !== 'not_sent') throw new Error('outcome before in-flight');
        current = { ...current, outcome: event.outcome ?? null, outcomeMessageId: event.messageId ?? null };
        break;
      case TOWN_HALL_PUBLICATION_EVENTS.CONFIRMED:
        if (current.confirmed || current.outcome !== 'unknown') throw new Error('misordered confirmation event');
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
    return Object.freeze({ status: 'planned', attemptId: null, nonce, owner: null, messageId: null });
  }
  let status: TownHallPublicationStatus = 'claimed';
  let messageId: string | null = null;
  if (latest.confirmed) {
    status = 'sent';
    messageId = latest.confirmedMessageId;
  } else if (latest.outcome !== null) {
    status = latest.outcome as TownHallPublicationStatus;
    messageId = latest.outcome === 'sent' ? latest.outcomeMessageId : null;
  } else if (latest.inFlight) {
    status = 'in_flight';
  }
  return Object.freeze({ status, attemptId: latest.attemptId, nonce, owner: latest.owner, messageId });
}

export function freezePublication(
  journalKey: string,
  fingerprint: string,
  projection: PublicationProjection
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
    publicationKey: publicationKeyFor(journalKey),
    fingerprint,
    status: projection.status,
    attemptId: projection.attemptId,
    nonce: projection.nonce,
    owner,
    messageId: projection.messageId
  });
}
