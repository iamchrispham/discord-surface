import { BOARD_RECEIPT_KINDS, BOARD_OUTCOMES, type BoardOutcome, type BoardState, type BoardTarget, type ReceiptRow, type BoardRefreshRecord, type BoardRefreshAttempt, type BoardAdmission } from './contracts';

export const UNRESOLVED_OUTCOMES = new Set<BoardOutcome>([
  BOARD_OUTCOMES.IN_FLIGHT,
  BOARD_OUTCOMES.UNKNOWN
]);

export const OUTCOME_VALUES = new Set<string>(Object.values(BOARD_OUTCOMES));

const RECEIPT_VALUES = new Set<string>(Object.values(BOARD_RECEIPT_KINDS));

export function parseDetail(value: unknown): Record<string, unknown> {
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

export function readReceipts(state: BoardState, kinds: readonly string[] = Object.values(BOARD_RECEIPT_KINDS)): ReceiptRow[] {
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

export function targetMatches(detail: Record<string, unknown>, target: BoardTarget): boolean {
  return detail.guildId === target.guildId && detail.channelId === target.channelId && detail.targetMessageId === target.messageId;
}

export function revisionOf(detail: Record<string, unknown>): number {
  const value = Number(detail.revision);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function outcomeRows(rows: readonly ReceiptRow[], attemptId: string): ReceiptRow[] {
  return rows.filter(row => row.kind === BOARD_RECEIPT_KINDS.OUTCOME && row.detail.attemptId === attemptId);
}

export function latestOutcome(rows: readonly ReceiptRow[], attemptId: string): ReceiptRow | null {
  return outcomeRows(rows, attemptId).at(-1) || null;
}

export function rowRecord(row: ReceiptRow, historical = false): BoardRefreshRecord {
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

export function currentRevision(rows: readonly ReceiptRow[], target: BoardTarget): number {
  return rows.filter(row => targetMatches(row.detail, target)).reduce((max, row) => Math.max(max, revisionOf(row.detail)), 0);
}

export function unresolvedAttempt(rows: readonly ReceiptRow[], target: BoardTarget): ReceiptRow | null {
  const attempts = rows.filter(row => row.kind === BOARD_RECEIPT_KINDS.ATTEMPT && targetMatches(row.detail, target));
  for (const attempt of attempts) {
    const outcome = latestOutcome(rows, String(attempt.detail.attemptId));
    if (!outcome) return attempt;
    const value = OUTCOME_VALUES.has(String(outcome.detail.outcome)) ? String(outcome.detail.outcome) as BoardOutcome : BOARD_OUTCOMES.UNKNOWN;
    if (UNRESOLVED_OUTCOMES.has(value)) return attempt;
  }
  return null;
}

export function duplicateRecord(rows: readonly ReceiptRow[], requestId: string, target: BoardTarget): BoardAdmission | null {
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
