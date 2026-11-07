import {
  appendEvent,
  copyOwner,
  decodePublication,
  isDirectPostOutcome,
  readRowsByPrefix,
  reject,
  sameOwner,
  snapshotOwnData,
  validOwner,
  CORRUPT_MESSAGE,
  type ReceiptRow
} from './journal';
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
  type TownHallPublicationPartId,
  type TownHallPublicationStateStore,
  type TownHallPublicationSet
} from './types';
import {
  deriveProjection,
  duplicateMessageId,
  freezePublication,
  freezePublicationSet,
  groupEvents,
  type AttemptGroup,
  type PlannedPublicationPart,
  type PublicationProjection,
  type PublicationEvent
} from './projection';
import {
  classifyProcessOwner,
  OWNER_EVIDENCE,
  OWNER_EVIDENCE_REASON
} from '../process-owner-evidence';
import { readContext, readPartContext, readPartPlan } from './context';
import type { PublicationContext } from './context';

const INVALID_KEY_MESSAGE = 'invalid town-hall journal key';
const INVALID_PART_MESSAGE = 'invalid town-hall publication part';
const OWNER_UNAVAILABLE_MESSAGE = 'town-hall publication owner identity is unavailable';
const MARK_REFUSED_MESSAGE = 'town-hall publication attempt is not claimed';
const RECORD_REFUSED_MESSAGE = 'town-hall publication attempt is not in flight';
const INVALID_OUTCOME_MESSAGE = 'town-hall publication outcome is invalid';
const OUTCOME_CONFLICT_MESSAGE = 'town-hall publication outcome conflict';
const CONFIRM_REFUSED_MESSAGE = 'town-hall publication confirmation is not admissible';
const KEY_PATTERN = /^[0-9a-f]{64}$/;
const OUTCOME_DETAIL_KEYS = ['messageId'] as const;
const EVIDENCE_KEYS = ['messageId', 'nonce', 'guildId', 'channelId'] as const;
const BLOCKED_RESERVE_STATUSES = new Set<string>([
  DIRECT_POST_PART_STATUSES.CLAIMED,
  DIRECT_POST_PART_STATUSES.IN_FLIGHT,
  DIRECT_POST_OUTCOMES.SENT,
  DIRECT_POST_OUTCOMES.UNKNOWN
]);

function assertJournalKey(deps: TownHallPublicationDependencies, journalKey: string): string {
  if (typeof journalKey !== 'string' || !KEY_PATTERN.test(journalKey)) throw new deps.BindingError(INVALID_KEY_MESSAGE);
  return journalKey;
}

function publicationOf(context: PublicationContext, projection: PublicationProjection): TownHallPublication {
  return freezePublication(context.journalKey, context.fingerprint, projection, context.publicationKey);
}

function contextForPart(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  journalKey: string,
  partId: unknown
): PublicationContext {
  if (typeof partId !== 'string') throw new deps.BindingError(INVALID_PART_MESSAGE);
  return readPartContext(deps, state, journalKey, partId);
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

function messageIdFor(outcome: DirectPostOutcome, detail: Record<string, unknown> | undefined): string | null {
  if (outcome !== DIRECT_POST_OUTCOMES.SENT) return null;
  return String(detail?.messageId);
}

export function getTownHallPublication(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  journalKey: string,
  partId?: string
): TownHallPublication {
  const key = assertJournalKey(deps, journalKey);
  const context = partId === undefined ? readContext(deps, state, key) : contextForPart(deps, state, key, partId);
  return publicationOf(context, decodePublication(deps, state, context).projection);
}

export function reserveTownHallPublication(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  journalKey: string,
  partId?: string
): { claimed: boolean; publication: TownHallPublication } {
  const key = assertJournalKey(deps, journalKey);
  const context = partId === undefined ? readContext(deps, state, key) : contextForPart(deps, state, key, partId);
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
  attemptId: string,
  partId?: string
): { started: boolean; publication: TownHallPublication } {
  const key = assertJournalKey(deps, journalKey);
  const context = partId === undefined ? readContext(deps, state, key) : contextForPart(deps, state, key, partId);
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
  detail?: Record<string, unknown>,
  partId?: string
): TownHallPublication {
  const key = assertJournalKey(deps, journalKey);
  const context = partId === undefined ? readContext(deps, state, key) : contextForPart(deps, state, key, partId);
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
  evidence: TownHallPublicationConfirmationEvidence,
  partId?: string
): TownHallPublication {
  const key = assertJournalKey(deps, journalKey);
  const context = partId === undefined ? readContext(deps, state, key) : contextForPart(deps, state, key, partId);
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
  const shared = classifyProcessOwner(owner.ownerPid, owner, {
    probePid: pid => deps.probePid(pid),
    captureIdentity: pid => typeof state.directPostOwnerIdentity === 'function' ? state.directPostOwnerIdentity(pid) : null
  });
  if (shared.reason === OWNER_EVIDENCE_REASON.IDENTITY_MISMATCH) return 'indeterminate';
  if (shared.status === OWNER_EVIDENCE.ABSENT) return 'absent';
  if (shared.status === OWNER_EVIDENCE.MATCHING_LIVE) return 'matching-live';
  return 'indeterminate';
}

export function recoverTownHallPublication(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  journalKey: string,
  partId?: string
): TownHallPublication {
  const key = assertJournalKey(deps, journalKey);
  const context = partId === undefined ? readContext(deps, state, key) : contextForPart(deps, state, key, partId);
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

export function getTownHallPublicationSet(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  journalKey: string
): TownHallPublicationSet {
  const key = assertJournalKey(deps, journalKey);
  // The journal read and the canonical part plan are built before the single
  // snapshot transaction; no public transition method runs inside it.
  const plan = readPartPlan(deps, state, key);
  const fingerprint = plan[0].context.fingerprint;
  const byReceiptKind = new Map(plan.map(entry => [entry.context.receiptKind, entry]));
  const partPrefix = TOWN_HALL_PUBLICATION_RECEIPTS.PUBLICATION_PART_PREFIX + key + ':';
  const parts = state.transaction(() => {
    const rows = readRowsByPrefix(deps, state, partPrefix);
    const grouped = new Map<string, ReceiptRow[]>();
    for (const row of rows) {
      if (!byReceiptKind.has(row.kind)) reject(deps);
      const group = grouped.get(row.kind);
      if (group) group.push(row);
      else grouped.set(row.kind, [row]);
    }
    return plan.map(entry => {
      const decoded = decodePublication(deps, state, entry.context, grouped.get(entry.context.receiptKind) ?? []);
      const part: PlannedPublicationPart = {
        index: entry.part.index,
        total: entry.part.total,
        partId: entry.part.partId as TownHallPublicationPartId,
        content: entry.part.content,
        publication: publicationOf(entry.context, decoded.projection)
      };
      return part;
    });
  });
  if (duplicateMessageId(parts)) throw new deps.StateCorruptError(CORRUPT_MESSAGE);
  return freezePublicationSet(key, fingerprint, parts);
}

export type { SqlRow };
