import { createHash } from 'node:crypto';
import { planTownHallBroadcast, type TownHallPlan } from '../../peer/town-hall-plan';
import {
  TOWN_HALL_JOURNAL_RECEIPTS,
  TOWN_HALL_JOURNAL_STATES,
  type SqlRow,
  type TownHallBroadcastCreateResult,
  type TownHallBroadcastRecipient,
  type TownHallBroadcastSnapshot,
  type TownHallJournalDependencies,
  type TownHallJournalStateStore
} from './types';

const JOURNAL_DOMAIN = 'discord-surface/town-hall-journal/v1';
const CORRUPT_MESSAGE = 'town-hall broadcast journal is corrupt';
const INVALID_KEY_MESSAGE = 'invalid town-hall journal key';
const CONFLICT_MESSAGE = 'town-hall broadcast identity conflict';
const KEY_PATTERN = /^[0-9a-f]{64}$/;

const MANIFEST_DETAIL_KEYS = ['version', 'journalKey', 'plan'] as const;
const PLAN_KEYS = ['version', 'broadcastId', 'townHall', 'source', 'text', 'recipients', 'fingerprint'] as const;
const RECIPIENT_ENTRY_KEYS = ['target', 'packetId'] as const;
const RECIPIENT_DETAIL_KEYS = ['version', 'journalKey', 'fingerprint', 'packetId', 'target'] as const;
const ADDRESS_KEYS = ['guildId', 'channelId', 'provider', 'nativeId', 'generation'] as const;
const ROOM_KEYS = ['guildId', 'channelId'] as const;

interface ReceiptRow {
  id: number;
  kind: string;
  detail: string;
  discord_id: string | null;
}

interface ReceiptProjection {
  plan: TownHallPlan;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function reject(deps: TownHallJournalDependencies): never {
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

function journalKeyForPlan(plan: TownHallPlan): string {
  return sha256Hex(JSON.stringify([
    JOURNAL_DOMAIN,
    plan.source.guildId,
    plan.source.channelId,
    plan.source.provider,
    plan.source.nativeId,
    plan.source.generation,
    plan.broadcastId
  ]));
}

function assertJournalKey(deps: TownHallJournalDependencies, journalKey: string): string {
  if (typeof journalKey !== 'string' || !KEY_PATTERN.test(journalKey)) throw new deps.BindingError(INVALID_KEY_MESSAGE);
  return journalKey;
}

function decodeRow(deps: TownHallJournalDependencies, row: SqlRow): ReceiptRow {
  // Compare the raw column so a null sentinel is not coerced into a non-null value.
  if (row.discord_id !== null) reject(deps);
  return {
    id: Number(row.id),
    kind: String(row.kind),
    detail: String(row.detail),
    discord_id: null
  };
}

function readRows(deps: TownHallJournalDependencies, state: TownHallJournalStateStore, kind: string): ReceiptRow[] {
  return state.db.prepare('SELECT id, kind, detail, discord_id FROM receipts WHERE kind=? ORDER BY id').all(kind)
    .filter(row => row.kind === kind)
    .map(row => decodeRow(deps, row));
}

function readRowsWithPrefix(deps: TownHallJournalDependencies, state: TownHallJournalStateStore, prefix: string): ReceiptRow[] {
  return state.db.prepare('SELECT id, kind, detail, discord_id FROM receipts WHERE kind LIKE ? ORDER BY id').all(`${prefix}%`)
    .filter(row => String(row.kind).startsWith(prefix))
    .map(row => decodeRow(deps, row));
}

function parseDetail(deps: TownHallJournalDependencies, detail: string): unknown {
  try {
    return JSON.parse(detail);
  } catch {
    return reject(deps);
  }
}

function canonicalPlan(deps: TownHallJournalDependencies, key: string, detail: string): ReceiptProjection {
  const parsed = parseDetail(deps, detail);
  if (!isPlainRecord(parsed) || !hasExactKeys(parsed, MANIFEST_DETAIL_KEYS)) reject(deps);
  if (parsed.version !== 1 || parsed.journalKey !== key) reject(deps);
  const plan = parsed.plan;
  if (!isPlainRecord(plan) || !hasExactKeys(plan, PLAN_KEYS)) reject(deps);
  if (plan.version !== 1) reject(deps);
  if (typeof plan.broadcastId !== 'string' || typeof plan.text !== 'string' || typeof plan.fingerprint !== 'string') reject(deps);
  if (!isPlainRecord(plan.townHall) || !hasExactKeys(plan.townHall, ROOM_KEYS)) reject(deps);
  if (!isPlainRecord(plan.source) || !hasExactKeys(plan.source, ADDRESS_KEYS)) reject(deps);
  const rawRecipients: unknown = plan.recipients;
  if (!Array.isArray(rawRecipients)) reject(deps);
  const targets: unknown[] = [];
  for (let recipientIndex = 0; recipientIndex < rawRecipients.length; recipientIndex += 1) {
    const entry: unknown = rawRecipients[recipientIndex];
    if (!isPlainRecord(entry) || !hasExactKeys(entry, RECIPIENT_ENTRY_KEYS)) reject(deps);
    if (typeof entry.packetId !== 'string') reject(deps);
    if (!isPlainRecord(entry.target) || !hasExactKeys(entry.target, ADDRESS_KEYS)) reject(deps);
    targets.push(entry.target);
  }
  let replanned: TownHallPlan;
  try {
    replanned = planTownHallBroadcast({
      broadcastId: plan.broadcastId,
      townHall: plan.townHall,
      source: plan.source,
      recipients: targets,
      text: plan.text
    });
  } catch {
    return reject(deps);
  }
  if (replanned.version !== 1 || replanned.broadcastId !== plan.broadcastId || replanned.text !== plan.text) reject(deps);
  if (replanned.fingerprint !== plan.fingerprint) reject(deps);
  if (journalKeyForPlan(replanned) !== key) reject(deps);
  if (replanned.townHall.guildId !== plan.townHall.guildId || replanned.townHall.channelId !== plan.townHall.channelId) reject(deps);
  const source = replanned.source;
  if (source.guildId !== plan.source.guildId || source.channelId !== plan.source.channelId ||
      source.provider !== plan.source.provider || source.nativeId !== plan.source.nativeId ||
      source.generation !== plan.source.generation) reject(deps);
  if (replanned.recipients.length !== rawRecipients.length) reject(deps);
  for (let index = 0; index < replanned.recipients.length; index += 1) {
    const canonical = replanned.recipients[index];
    const stored = rawRecipients[index];
    if (!isPlainRecord(stored)) reject(deps);
    if (stored.packetId !== canonical.packetId) reject(deps);
    const storedTarget = stored.target;
    if (!isPlainRecord(storedTarget)) reject(deps);
    if (canonical.target.guildId !== storedTarget.guildId || canonical.target.channelId !== storedTarget.channelId ||
        canonical.target.provider !== storedTarget.provider || canonical.target.nativeId !== storedTarget.nativeId ||
        canonical.target.generation !== storedTarget.generation) reject(deps);
  }
  return { plan: replanned };
}

function validateRecipients(deps: TownHallJournalDependencies, key: string, projection: ReceiptProjection, rows: ReceiptRow[]): void {
  const expected = projection.plan.recipients;
  if (rows.length !== expected.length) reject(deps);
  for (let index = 0; index < rows.length; index += 1) {
    const parsed = parseDetail(deps, rows[index].detail);
    if (!isPlainRecord(parsed) || !hasExactKeys(parsed, RECIPIENT_DETAIL_KEYS)) reject(deps);
    if (parsed.version !== 1 || parsed.journalKey !== key || parsed.fingerprint !== projection.plan.fingerprint) reject(deps);
    if (parsed.packetId !== expected[index].packetId) reject(deps);
    const target = parsed.target;
    if (!isPlainRecord(target) || !hasExactKeys(target, ADDRESS_KEYS)) reject(deps);
    const canonical = expected[index].target;
    if (target.guildId !== canonical.guildId || target.channelId !== canonical.channelId ||
        target.provider !== canonical.provider || target.nativeId !== canonical.nativeId ||
        target.generation !== canonical.generation) reject(deps);
  }
}

function freezeSnapshot(plan: TownHallPlan, journalKey: string): TownHallBroadcastSnapshot {
  const recipients = plan.recipients.map(recipient => Object.freeze<TownHallBroadcastRecipient>({
    target: recipient.target,
    packetId: recipient.packetId,
    status: TOWN_HALL_JOURNAL_STATES.PLANNED
  }));
  Object.freeze(recipients);
  return Object.freeze({
    journalKey,
    plan,
    publication: Object.freeze({ status: TOWN_HALL_JOURNAL_STATES.PLANNED }),
    recipients
  });
}

function projectByKey(deps: TownHallJournalDependencies, state: TownHallJournalStateStore, key: string): TownHallBroadcastSnapshot | null {
  const manifestRows = readRows(deps, state, TOWN_HALL_JOURNAL_RECEIPTS.MANIFEST_PREFIX + key);
  const recipientRows = readRows(deps, state, TOWN_HALL_JOURNAL_RECEIPTS.RECIPIENT_PREFIX + key);
  if (manifestRows.length === 0) {
    if (recipientRows.length !== 0) reject(deps);
    return null;
  }
  if (manifestRows.length !== 1) reject(deps);
  const projection = canonicalPlan(deps, key, manifestRows[0].detail);
  validateRecipients(deps, key, projection, recipientRows);
  return freezeSnapshot(projection.plan, key);
}

export function createTownHallBroadcast(
  deps: TownHallJournalDependencies,
  state: TownHallJournalStateStore,
  input: unknown
): TownHallBroadcastCreateResult {
  const plan = planTownHallBroadcast(input);
  const key = journalKeyForPlan(plan);
  return state.transaction(() => {
    const manifestRows = readRows(deps, state, TOWN_HALL_JOURNAL_RECEIPTS.MANIFEST_PREFIX + key);
    const recipientRows = readRows(deps, state, TOWN_HALL_JOURNAL_RECEIPTS.RECIPIENT_PREFIX + key);
    if (manifestRows.length !== 0) {
      if (manifestRows.length !== 1) reject(deps);
      const projection = canonicalPlan(deps, key, manifestRows[0].detail);
      validateRecipients(deps, key, projection, recipientRows);
      if (projection.plan.fingerprint !== plan.fingerprint) throw new deps.BindingError(CONFLICT_MESSAGE);
      return { created: false, broadcast: freezeSnapshot(projection.plan, key) };
    }
    if (recipientRows.length !== 0) reject(deps);
    state.receipt(null, TOWN_HALL_JOURNAL_RECEIPTS.MANIFEST_PREFIX + key, { version: 1, journalKey: key, plan });
    for (const recipient of plan.recipients) {
      state.receipt(null, TOWN_HALL_JOURNAL_RECEIPTS.RECIPIENT_PREFIX + key, {
        version: 1,
        journalKey: key,
        fingerprint: plan.fingerprint,
        packetId: recipient.packetId,
        target: recipient.target
      });
    }
    return { created: true, broadcast: freezeSnapshot(plan, key) };
  });
}

export function getTownHallBroadcast(
  deps: TownHallJournalDependencies,
  state: TownHallJournalStateStore,
  journalKey: string
): TownHallBroadcastSnapshot | null {
  const key = assertJournalKey(deps, journalKey);
  return state.transaction(() => projectByKey(deps, state, key));
}

export function listTownHallBroadcasts(
  deps: TownHallJournalDependencies,
  state: TownHallJournalStateStore
): TownHallBroadcastSnapshot[] {
  return state.transaction(() => {
    const manifestRows = readRowsWithPrefix(deps, state, TOWN_HALL_JOURNAL_RECEIPTS.MANIFEST_PREFIX);
    const recipientRows = readRowsWithPrefix(deps, state, TOWN_HALL_JOURNAL_RECEIPTS.RECIPIENT_PREFIX);
    const recipientGroups = new Map<string, ReceiptRow[]>();
    for (const row of recipientRows) {
      const key = row.kind.slice(TOWN_HALL_JOURNAL_RECEIPTS.RECIPIENT_PREFIX.length);
      const group = recipientGroups.get(key);
      if (group) group.push(row);
      else recipientGroups.set(key, [row]);
    }
    const snapshots: TownHallBroadcastSnapshot[] = [];
    const seen = new Set<string>();
    for (const row of manifestRows) {
      const key = row.kind.slice(TOWN_HALL_JOURNAL_RECEIPTS.MANIFEST_PREFIX.length);
      if (seen.has(key)) reject(deps);
      seen.add(key);
      const group = recipientGroups.get(key) ?? [];
      recipientGroups.delete(key);
      const projection = canonicalPlan(deps, key, row.detail);
      validateRecipients(deps, key, projection, group);
      snapshots.push(freezeSnapshot(projection.plan, key));
    }
    if (recipientGroups.size !== 0) reject(deps);
    return snapshots;
  });
}

export type { SqlRow };
