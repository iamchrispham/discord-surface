import * as crypto from 'node:crypto';

export const BOARD_RECEIPT_KINDS = Object.freeze({
  DESIGNATION: 'board-designation',
  ATTEMPT: 'board-refresh-attempt',
  OUTCOME: 'board-refresh-outcome'
} as const);

export const BOARD_OUTCOMES = Object.freeze({
  IN_FLIGHT: 'in_flight',
  APPLIED: 'applied',
  NO_OP: 'no_op',
  NOT_SENT: 'not_sent',
  REJECTED: 'rejected',
  RATE_LIMITED: 'rate_limited',
  UNKNOWN: 'unknown',
  STALE: 'stale'
} as const);

export type BoardOutcome = typeof BOARD_OUTCOMES[keyof typeof BOARD_OUTCOMES];
export type BoardTerminalOutcome = Exclude<BoardOutcome, typeof BOARD_OUTCOMES.IN_FLIGHT | typeof BOARD_OUTCOMES.UNKNOWN>;

const UNRESOLVED_OUTCOMES = new Set<BoardOutcome>([
  BOARD_OUTCOMES.IN_FLIGHT,
  BOARD_OUTCOMES.UNKNOWN
]);
const OUTCOME_VALUES = new Set<string>(Object.values(BOARD_OUTCOMES));
const RECEIPT_VALUES = new Set<string>(Object.values(BOARD_RECEIPT_KINDS));

interface SqlRow {
  [key: string]: unknown;
}

interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...parameters: unknown[]): T[];
  get<T extends SqlRow = SqlRow>(...parameters: unknown[]): T | undefined;
  run(...parameters: unknown[]): unknown;
}

interface BoardDatabase {
  prepare(sql: string): SqlStatement;
}

export interface BoardBinding {
  active: boolean;
  channelId: string;
  guildId: string;
  provider: string;
  nativeId: string;
  generation: number;
  conductorId?: string | null;
  repoKey?: string | null;
  sessionRoot?: string | null;
}

export interface BoardConfig {
  guildId: string;
  operatorId?: string;
}

export interface BoardState {
  db: BoardDatabase;
  transaction<T>(operation: () => T): T;
  getBinding(channelId: string): BoardBinding | null;
  requireConfig(): BoardConfig;
  receipt(discordId: string | null, kind: string, detail: unknown): void;
  directPostOwnerIdentity?(pid: number): unknown;
  directPostOwnerAlive?(pid: number, identity: unknown): boolean;
}

export interface BoardTarget {
  guildId: string;
  channelId: string;
  messageId: string;
}

export interface BoardProvenance {
  source: 'reply' | 'direct-post';
  messageId: string;
  channelId: string;
  guildId: string;
  sourceMessageId?: string;
  requestId?: string;
  attemptId?: string;
  generation?: number;
  provider?: string;
}

export interface BoardOwner {
  guildId: string;
  channelId: string;
  provider: string;
  nativeId: string;
  generation: number;
  conductorId: string | null;
  repoKey: string | null;
}

export interface BoardRefreshMeta {
  requestId: string;
  target: BoardTarget;
  content: string;
  payloadHash: string;
  preEditContent: string;
  binding: BoardBinding;
  targetAuthorId: string;
  provenance: BoardProvenance;
  ownerPid?: number;
  ownerIdentity?: unknown;
}

export interface BoardRefreshAttempt {
  journal: 'board-refresh-v1';
  board: 'compact-status-board';
  operation: 'message.patch';
  requestId: string;
  dedupeKey: string;
  attemptId: string;
  guildId: string;
  channelId: string;
  targetMessageId: string;
  provider: string;
  nativeId: string;
  generation: number;
  conductorId: string | null;
  repoKey: string | null;
  content: string;
  preEditContent: string;
  payloadHash: string;
  baseRevision: number;
  revision: number;
  targetAuthorId: string;
  provenance: BoardProvenance;
  originalOwner: BoardOwner;
  ownerPid?: number;
  ownerIdentity?: unknown;
  status: typeof BOARD_OUTCOMES.IN_FLIGHT;
  outcome: typeof BOARD_OUTCOMES.IN_FLIGHT;
}

export interface BoardRefreshRecord extends Omit<BoardRefreshAttempt, 'outcome' | 'status'> {
  outcome: BoardOutcome;
  status: BoardOutcome;
  historical?: boolean;
  recordedAt?: string;
  operationEndedAt?: string | null;
  [key: string]: unknown;
}

export interface BoardRevisionSnapshot {
  target: BoardTarget;
  revision: number;
}

export interface BoardAdmission {
  status: 'admitted' | 'stale' | 'blocked' | BoardOutcome;
  requestId: string;
  targetMessageId: string;
  revision?: number;
  attemptId?: string;
  attempt?: BoardRefreshAttempt;
  outcome?: BoardOutcome;
  historical?: boolean;
  duplicate?: boolean;
  reason?: string;
}

export interface BoardRecoveryEvidence {
  evidenceScope: string;
  observedAt: string;
  readbackContent: string;
  soleWriter: boolean;
  singleAttempt: boolean;
  noHiddenRetry: boolean;
}

interface ReceiptRow {
  id: number;
  kind: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

function text(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function messageId(value: unknown, name = 'messageId'): string {
  return text(value, name, 128);
}

function generation(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('generation must be a positive integer');
  return parsed;
}

function parseDetail(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readReceipts(state: BoardState, kinds: readonly string[] = Object.values(BOARD_RECEIPT_KINDS)): ReceiptRow[] {
  if (kinds.some(kind => !RECEIPT_VALUES.has(kind))) throw new Error('invalid board receipt kind');
  const placeholders = kinds.map(() => '?').join(', ');
  return state.db.prepare(`SELECT id, kind, detail, created_at FROM receipts WHERE kind IN (${placeholders}) ORDER BY id`)
    .all(...kinds)
    .map(row => ({
      id: Number(row.id),
      kind: String(row.kind),
      detail: parseDetail(row.detail),
      createdAt: String(row.created_at)
    }));
}

function targetMatches(detail: Record<string, unknown>, target: BoardTarget): boolean {
  return detail.guildId === target.guildId && detail.channelId === target.channelId && detail.targetMessageId === target.messageId;
}

function assertTarget(target: BoardTarget): BoardTarget {
  return {
    guildId: text(target?.guildId, 'guildId', 128),
    channelId: text(target?.channelId, 'channelId', 128),
    messageId: messageId(target?.messageId, 'messageId')
  };
}

function assertBinding(binding: BoardBinding): BoardBinding {
  if (!binding?.active) throw new Error('board refresh requires an active binding');
  text(binding.channelId, 'binding.channelId', 128);
  text(binding.guildId, 'binding.guildId', 128);
  text(binding.provider, 'binding.provider', 32);
  text(binding.nativeId, 'binding.nativeId', 128);
  generation(binding.generation);
  return binding;
}

function bindingMatches(left: BoardBinding | null, right: BoardBinding): boolean {
  if (!left?.active) return false;
  return left.channelId === right.channelId && left.guildId === right.guildId &&
    left.provider === right.provider && left.nativeId === right.nativeId && left.generation === right.generation &&
    (left.sessionRoot || null) === (right.sessionRoot || null) &&
    (left.conductorId || null) === (right.conductorId || null) &&
    (left.repoKey || null) === (right.repoKey || null);
}

function ownerFor(binding: BoardBinding): BoardOwner {
  return {
    guildId: binding.guildId,
    channelId: binding.channelId,
    provider: binding.provider,
    nativeId: binding.nativeId,
    generation: binding.generation,
    conductorId: binding.conductorId || null,
    repoKey: binding.repoKey || null
  };
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function revisionOf(detail: Record<string, unknown>): number {
  const value = Number(detail.revision);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function outcomeRows(rows: readonly ReceiptRow[], attemptId: string): ReceiptRow[] {
  return rows.filter(row => row.kind === BOARD_RECEIPT_KINDS.OUTCOME && row.detail.attemptId === attemptId);
}

function latestOutcome(rows: readonly ReceiptRow[], attemptId: string): ReceiptRow | null {
  return outcomeRows(rows, attemptId).at(-1) || null;
}

function rowRecord(row: ReceiptRow, historical = false): BoardRefreshRecord {
  const detail = row.detail;
  const outcome = OUTCOME_VALUES.has(String(detail.outcome)) ? String(detail.outcome) as BoardOutcome : BOARD_OUTCOMES.UNKNOWN;
  return {
    ...(detail as unknown as BoardRefreshAttempt),
    status: outcome,
    outcome,
    historical,
    recordedAt: row.createdAt,
    operationEndedAt: typeof detail.operationEndedAt === 'string' ? detail.operationEndedAt : null
  };
}

function requestRows(rows: readonly ReceiptRow[], requestId: string): ReceiptRow[] {
  return rows.filter(row => row.kind === BOARD_RECEIPT_KINDS.ATTEMPT && row.detail.requestId === requestId);
}

function validateOutcome(value: unknown): BoardOutcome {
  const outcome = text(value, 'outcome', 32);
  if (!OUTCOME_VALUES.has(outcome)) throw new Error('invalid board refresh outcome');
  return outcome as BoardOutcome;
}

function operationEndedAt(value: unknown): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : new Date().toISOString();
}

function validateMeta(meta: BoardRefreshMeta): BoardRefreshMeta {
  text(meta?.requestId, 'requestId', 256);
  const target = assertTarget(meta?.target);
  const binding = assertBinding(meta?.binding);
  if (binding.channelId !== target.channelId || binding.guildId !== target.guildId) throw new Error('board target does not match the bound guild and channel');
  text(meta.content, 'content', 2000);
  if (!meta.content.trim()) throw new Error('content must contain non-whitespace text');
  if (typeof meta.preEditContent !== 'string' || meta.preEditContent.length > 2000) throw new Error('preEditContent is invalid');
  text(meta.payloadHash, 'payloadHash', 128);
  text(meta.targetAuthorId, 'targetAuthorId', 128);
  if (!meta.provenance || meta.provenance.messageId !== target.messageId || meta.provenance.channelId !== target.channelId || meta.provenance.guildId !== target.guildId) {
    throw new Error('board target provenance does not match the explicit target');
  }
  return { ...meta, target, binding };
}

function currentRevision(rows: readonly ReceiptRow[], target: BoardTarget): number {
  return rows.filter(row => targetMatches(row.detail, target)).reduce((max, row) => Math.max(max, revisionOf(row.detail)), 0);
}

function unresolvedAttempt(rows: readonly ReceiptRow[], target: BoardTarget): ReceiptRow | null {
  const attempts = rows.filter(row => row.kind === BOARD_RECEIPT_KINDS.ATTEMPT && targetMatches(row.detail, target));
  for (const attempt of attempts) {
    const outcome = latestOutcome(rows, String(attempt.detail.attemptId));
    if (!outcome) return attempt;
    const value = OUTCOME_VALUES.has(String(outcome.detail.outcome)) ? String(outcome.detail.outcome) as BoardOutcome : BOARD_OUTCOMES.UNKNOWN;
    if (UNRESOLVED_OUTCOMES.has(value)) return attempt;
  }
  return null;
}

function duplicateRecord(rows: readonly ReceiptRow[], requestId: string, target: BoardTarget): BoardAdmission | null {
  const attempts = requestRows(rows, requestId);
  if (attempts.length === 0) return null;
  if (attempts.some(row => !targetMatches(row.detail, target))) throw new Error('dedupe key is already used for another board target');
  const attempt = attempts.at(-1)!;
  const outcome = latestOutcome(rows, String(attempt.detail.attemptId));
  if (!outcome) {
    return {
      status: BOARD_OUTCOMES.IN_FLIGHT,
      requestId,
      targetMessageId: target.messageId,
      revision: revisionOf(attempt.detail),
      attemptId: String(attempt.detail.attemptId),
      attempt: attempt.detail as unknown as BoardRefreshAttempt,
      outcome: BOARD_OUTCOMES.IN_FLIGHT,
      duplicate: true,
      reason: 'board refresh attempt is still unresolved'
    };
  }
  const record = rowRecord(outcome, true);
  if (UNRESOLVED_OUTCOMES.has(record.outcome)) {
    return {
      status: record.outcome,
      requestId,
      targetMessageId: target.messageId,
      revision: revisionOf(attempt.detail),
      attemptId: String(attempt.detail.attemptId),
      attempt: attempt.detail as unknown as BoardRefreshAttempt,
      outcome: record.outcome,
      duplicate: true,
      reason: 'board refresh attempt is still unresolved'
    };
  }
  return {
    status: record.outcome,
    requestId,
    targetMessageId: target.messageId,
    revision: revisionOf(attempt.detail),
    attemptId: String(attempt.detail.attemptId),
    attempt: attempt.detail as unknown as BoardRefreshAttempt,
    outcome: record.outcome,
    historical: true,
    duplicate: true
  };
}

function captureBoardRevision(state: BoardState, rawTarget: BoardTarget): BoardRevisionSnapshot {
  const target = assertTarget(rawTarget);
  const rows = readReceipts(state);
  return { target, revision: currentRevision(rows, target) };
}

function inspectBoardRequest(state: BoardState, requestId: string, rawTarget: BoardTarget): BoardAdmission | null {
  const target = assertTarget(rawTarget);
  text(requestId, 'requestId', 256);
  return duplicateRecord(readReceipts(state), requestId, target);
}

function boardMessageProvenance(state: BoardState, rawTarget: BoardTarget): BoardProvenance[] {
  const target = assertTarget(rawTarget);
  const direct = state.db.prepare(`SELECT detail, created_at FROM receipts
    WHERE kind='direct-post-outcome' AND json_extract(detail, '$.messageId')=?
      AND json_extract(detail, '$.outcome')='sent' ORDER BY id`).all(target.messageId);
  const directProvenance: BoardProvenance[] = direct.flatMap(row => {
    const detail = parseDetail(row.detail);
    const destinationChannel = typeof detail.deliveryChannelId === 'string' ? detail.deliveryChannelId : detail.channelId;
    if (detail.guildId !== target.guildId || destinationChannel !== target.channelId) return [];
    return [{
      source: 'direct-post',
      messageId: target.messageId,
      channelId: target.channelId,
      guildId: target.guildId,
      requestId: typeof detail.requestId === 'string' ? detail.requestId : undefined,
      attemptId: typeof detail.attemptId === 'string' ? detail.attemptId : undefined,
      generation: Number.isSafeInteger(Number(detail.generation)) ? Number(detail.generation) : undefined,
      provider: typeof detail.provider === 'string' ? detail.provider : undefined
    }];
  });
  const replies = state.db.prepare(`SELECT rp.discord_id AS source_message_id, m.guild_id, m.channel_id,
      m.provider, m.generation, rp.message_id
    FROM reply_parts rp JOIN messages m ON m.discord_id=rp.discord_id
    WHERE rp.message_id=? AND rp.state='sent'`).all(target.messageId);
  const replyProvenance: BoardProvenance[] = replies.flatMap(row => {
    if (row.guild_id !== target.guildId || row.channel_id !== target.channelId) return [];
    return [{
      source: 'reply',
      messageId: target.messageId,
      channelId: target.channelId,
      guildId: target.guildId,
      sourceMessageId: String(row.source_message_id),
      generation: Number(row.generation),
      provider: typeof row.provider === 'string' ? row.provider : undefined
    }];
  });
  return [...directProvenance, ...replyProvenance];
}

function recoverBoardRefreshReceipts(state: BoardState, ownerAlive: ((pid: number, identity: unknown) => boolean) | null = null, inTransaction = false): number {
  const recover = (): number => {
    const rows = readReceipts(state, [BOARD_RECEIPT_KINDS.ATTEMPT, BOARD_RECEIPT_KINDS.OUTCOME]);
    let count = 0;
    for (const attempt of rows.filter(row => row.kind === BOARD_RECEIPT_KINDS.ATTEMPT)) {
      const attemptId = String(attempt.detail.attemptId || '');
      if (!attemptId || latestOutcome(rows, attemptId)) continue;
      const pid = Number(attempt.detail.ownerPid);
      const identity = attempt.detail.ownerIdentity;
      if (ownerAlive && Number.isInteger(pid) && pid > 0 && ownerAlive(pid, identity)) continue;
      const ended = new Date().toISOString();
      state.receipt(null, BOARD_RECEIPT_KINDS.OUTCOME, {
        ...attempt.detail,
        outcome: BOARD_OUTCOMES.UNKNOWN,
        status: BOARD_OUTCOMES.UNKNOWN,
        operationEndedAt: ended,
        reason: 'process stopped before board refresh outcome'
      });
      count += 1;
    }
    return count;
  };
  return inTransaction ? recover() : state.transaction(recover);
}

function beginBoardRefresh(state: BoardState, metaInput: BoardRefreshMeta, capturedRevision: number): BoardAdmission {
  const meta = validateMeta(metaInput);
  if (!Number.isSafeInteger(capturedRevision) || capturedRevision < 0) throw new Error('captured board revision must be a non-negative integer');
  return state.transaction(() => {
    const config = state.requireConfig();
    const binding = state.getBinding(meta.target.channelId);
    if (config.guildId !== meta.target.guildId || !bindingMatches(binding, meta.binding)) {
      return {
        status: BOARD_OUTCOMES.STALE,
        requestId: meta.requestId,
        targetMessageId: meta.target.messageId,
        reason: 'binding changed before board refresh admission'
      };
    }
    const rows = readReceipts(state);
    const duplicate = duplicateRecord(rows, meta.requestId, meta.target);
    if (duplicate) {
      if (duplicate.attempt && duplicate.attempt.payloadHash !== meta.payloadHash) throw new Error('dedupe key is already used for another board payload');
      return duplicate;
    }
    const revision = currentRevision(rows, meta.target);
    if (revision !== capturedRevision) {
      return {
        status: BOARD_OUTCOMES.STALE,
        requestId: meta.requestId,
        targetMessageId: meta.target.messageId,
        revision,
        reason: 'board revision changed before admission'
      };
    }
    const unresolved = unresolvedAttempt(rows, meta.target);
    if (unresolved) {
      const unresolvedOutcome = latestOutcome(rows, String(unresolved.detail.attemptId));
      const status = unresolvedOutcome ? validateOutcome(unresolvedOutcome.detail.outcome) : BOARD_OUTCOMES.IN_FLIGHT;
      return {
        status,
        requestId: meta.requestId,
        targetMessageId: meta.target.messageId,
        revision: revisionOf(unresolved.detail),
        attemptId: String(unresolved.detail.attemptId),
        attempt: unresolved.detail as unknown as BoardRefreshAttempt,
        outcome: status,
        reason: 'another board refresh for this target is unresolved'
      };
    }
    const nextRevision = revision + 1;
    const attempt: BoardRefreshAttempt = {
      journal: 'board-refresh-v1',
      board: 'compact-status-board',
      operation: 'message.patch',
      requestId: meta.requestId,
      dedupeKey: meta.requestId,
      attemptId: crypto.randomUUID(),
      guildId: meta.target.guildId,
      channelId: meta.target.channelId,
      targetMessageId: meta.target.messageId,
      provider: meta.binding.provider,
      nativeId: meta.binding.nativeId,
      generation: meta.binding.generation,
      conductorId: meta.binding.conductorId || null,
      repoKey: meta.binding.repoKey || null,
      content: meta.content,
      preEditContent: meta.preEditContent,
      payloadHash: meta.payloadHash || hashContent(meta.content),
      baseRevision: revision,
      revision: nextRevision,
      targetAuthorId: meta.targetAuthorId,
      provenance: meta.provenance,
      originalOwner: ownerFor(meta.binding),
      ...(meta.ownerPid === undefined ? {} : { ownerPid: meta.ownerPid }),
      ...(meta.ownerIdentity === undefined ? {} : { ownerIdentity: meta.ownerIdentity }),
      status: BOARD_OUTCOMES.IN_FLIGHT,
      outcome: BOARD_OUTCOMES.IN_FLIGHT
    };
    const designation = rows.find(row => row.kind === BOARD_RECEIPT_KINDS.DESIGNATION && targetMatches(row.detail, meta.target));
    if (!designation) {
      state.receipt(null, BOARD_RECEIPT_KINDS.DESIGNATION, {
        journal: 'board-refresh-v1',
        board: 'compact-status-board',
        designation: 'explicit-target',
        guildId: meta.target.guildId,
        channelId: meta.target.channelId,
        targetMessageId: meta.target.messageId,
        targetAuthorId: meta.targetAuthorId,
        provenance: meta.provenance,
        originalOwner: attempt.originalOwner,
        revision: nextRevision
      });
    }
    state.receipt(null, BOARD_RECEIPT_KINDS.ATTEMPT, attempt);
    return {
      status: 'admitted',
      requestId: meta.requestId,
      targetMessageId: meta.target.messageId,
      revision: nextRevision,
      attemptId: attempt.attemptId,
      attempt
    };
  });
}

function recordBoardRefreshOutcome(state: BoardState, targetInput: BoardTarget, attemptIdInput: string, outcomeInput: unknown, detail: Record<string, unknown> = {}): BoardRefreshRecord {
  const target = assertTarget(targetInput);
  const attemptId = text(attemptIdInput, 'attemptId', 128);
  const outcome = validateOutcome(outcomeInput);
  if (outcome === BOARD_OUTCOMES.IN_FLIGHT) throw new Error('board refresh outcome must be terminal or unknown');
  return state.transaction(() => {
    const rows = readReceipts(state);
    const attempts = rows.filter(row => row.kind === BOARD_RECEIPT_KINDS.ATTEMPT && row.detail.attemptId === attemptId);
    const attempt = attempts.at(-1);
    if (!attempt || !targetMatches(attempt.detail, target)) throw new Error('board refresh attempt is unknown');
    const existing = latestOutcome(rows, attemptId);
    if (existing) return rowRecord(existing, true);
    const ended = operationEndedAt(detail.operationEndedAt);
    const next = {
      ...attempt.detail,
      ...detail,
      outcome,
      status: outcome,
      operationEndedAt: ended
    };
    state.receipt(null, BOARD_RECEIPT_KINDS.OUTCOME, next);
    return { ...(next as unknown as BoardRefreshRecord), recordedAt: ended };
  });
}

function reconcileBoardRefresh(state: BoardState, targetInput: BoardTarget, attemptIdInput: string, resolution: unknown, evidence: BoardRecoveryEvidence): BoardRefreshRecord {
  const target = assertTarget(targetInput);
  const attemptId = text(attemptIdInput, 'attemptId', 128);
  if (resolution !== BOARD_OUTCOMES.APPLIED) throw new Error('board refresh reconciliation only accepts applied evidence');
  const scope = text(evidence?.evidenceScope, 'evidenceScope', 2000);
  const observedAt = text(evidence?.observedAt, 'observedAt', 64);
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('observedAt must be an ISO timestamp');
  text(evidence?.readbackContent, 'readbackContent', 2000);
  if (!evidence.soleWriter || !evidence.singleAttempt || !evidence.noHiddenRetry) {
    throw new Error('positive board readback requires sole-writer, single-attempt, and no-hidden-retry evidence');
  }
  return state.transaction(() => {
    const rows = readReceipts(state);
    const attempt = rows.filter(row => row.kind === BOARD_RECEIPT_KINDS.ATTEMPT && row.detail.attemptId === attemptId).at(-1);
    if (!attempt || !targetMatches(attempt.detail, target)) throw new Error('board refresh attempt is unknown');
    const existing = latestOutcome(rows, attemptId);
    if (!existing) throw new Error('board refresh attempt has no outcome to reconcile');
    const current = validateOutcome(existing.detail.outcome);
    if (!UNRESOLVED_OUTCOMES.has(current)) return rowRecord(existing, true);
    const endedAt = typeof existing.detail.operationEndedAt === 'string' ? existing.detail.operationEndedAt : null;
    if (!endedAt) throw new Error('board refresh operation end is unknown');
    if (Date.parse(observedAt) < Date.parse(endedAt)) throw new Error('board readback predates operation termination');
    if (attempt.detail.content === attempt.detail.preEditContent) throw new Error('positive board readback requires desired content different from the pre-edit content');
    if (evidence.readbackContent !== attempt.detail.content) throw new Error('board readback does not confirm the desired content');
    const next = {
      ...attempt.detail,
      outcome: BOARD_OUTCOMES.APPLIED,
      status: BOARD_OUTCOMES.APPLIED,
      reconciledFrom: current,
      evidenceScope: scope,
      readbackAt: observedAt,
      readbackContent: evidence.readbackContent,
      soleWriter: true,
      singleAttempt: true,
      noHiddenRetry: true,
      operationEndedAt: endedAt
    };
    state.receipt(null, BOARD_RECEIPT_KINDS.OUTCOME, next);
    return { ...(next as unknown as BoardRefreshRecord), recordedAt: observedAt };
  });
}

export function createBoardRefreshHandlers() {
  return {
    captureBoardRevision,
    inspectBoardRequest,
    boardMessageProvenance,
    recoverBoardRefreshReceipts,
    beginBoardRefresh,
    recordBoardRefreshOutcome,
    reconcileBoardRefresh
  };
}

export { hashContent };
