import { planTownHallRoomParts } from '../../peer/town-hall-room-parts';
import type { TownHallRoomPart } from '../../peer/town-hall-room-parts';
import { publicationKeyFor, receiptKindFor } from './projection';
import type { TownHallPublicationDependencies, TownHallPublicationStateStore } from './types';

const MISSING_JOURNAL_MESSAGE = 'town-hall publication requires an existing journal';
const CORRUPT_MESSAGE = 'town-hall publication journal is corrupt';

export interface PublicationContext {
  journalKey: string;
  publicationKey: string;
  receiptKind: string;
  nonce: string;
  fingerprint: string;
  guildId: string;
  channelId: string;
}

export interface PartPlanEntry {
  readonly part: TownHallRoomPart;
  readonly context: PublicationContext;
}

function contextFor(
  deps: TownHallPublicationDependencies,
  journalKey: string,
  partId: string | null,
  fingerprint: string,
  guildId: string,
  channelId: string
): PublicationContext {
  const publicationKey = publicationKeyFor(journalKey, partId ?? undefined);
  return {
    journalKey,
    publicationKey,
    receiptKind: receiptKindFor(journalKey, partId ?? undefined),
    nonce: deps.discordNonce(publicationKey),
    fingerprint,
    guildId,
    channelId
  };
}

// getTownHallBroadcast opens its own BEGIN IMMEDIATE, so it must run outside any transaction.
export function readContext(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  journalKey: string
): PublicationContext {
  const journal = state.getTownHallBroadcast(journalKey);
  if (journal === null) throw new deps.BindingError(MISSING_JOURNAL_MESSAGE);
  const plan = journal.plan;
  return contextFor(
    deps,
    journalKey,
    null,
    plan.fingerprint,
    plan.townHall.guildId,
    plan.townHall.channelId
  );
}

// The journal owns the immutable plan. The part list is rebuilt only from the
// stored snapshot; a caller-supplied list or content is never consulted.
export function readPartContext(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  journalKey: string,
  partId: string
): PublicationContext {
  const entries = readPartPlan(deps, state, journalKey);
  for (const entry of entries) {
    if (entry.part.partId === partId) return entry.context;
  }
  throw new deps.BindingError('invalid town-hall publication part');
}

export function readPartPlan(
  deps: TownHallPublicationDependencies,
  state: TownHallPublicationStateStore,
  journalKey: string
): PartPlanEntry[] {
  const journal = state.getTownHallBroadcast(journalKey);
  if (journal === null) throw new deps.BindingError(MISSING_JOURNAL_MESSAGE);
  const plan = journal.plan;
  const rebuilt = planTownHallRoomParts({
    broadcastId: plan.broadcastId,
    townHall: plan.townHall,
    source: plan.source,
    text: plan.text,
    recipients: plan.recipients.map(recipient => recipient.target)
  });
  if (rebuilt.plan.fingerprint !== plan.fingerprint) {
    throw new deps.StateCorruptError(CORRUPT_MESSAGE);
  }
  return rebuilt.parts.map(part => ({
    part,
    context: contextFor(
      deps,
      journalKey,
      part.partId,
      plan.fingerprint,
      plan.townHall.guildId,
      plan.townHall.channelId
    )
  }));
}
