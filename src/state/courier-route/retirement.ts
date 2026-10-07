import { COURIER_RECEIPT_KINDS, COURIER_RECOVERY_SOURCES } from './constants';
import type { CourierDependencies, CourierState, SqlRow } from './types';

export function retiredCourierPredecessor(
  deps: CourierDependencies,
  state: CourierState,
  messageId: string,
  beforeReceiptId = Number.MAX_SAFE_INTEGER
): string | null {
  const row = state.db.prepare(`SELECT id, detail FROM receipts WHERE kind=?
    AND discord_id=? AND id<? ORDER BY id DESC LIMIT 1`)
    .get(COURIER_RECEIPT_KINDS.ATTEMPT, messageId, beforeReceiptId) as SqlRow | undefined;
  const attempt = deps.parseJson(row?.detail, null);
  if (!row || typeof attempt?.attemptId !== 'string') return null;
  const retirements = state.db.prepare(`SELECT detail FROM receipts WHERE kind=?
    AND discord_id=? AND id>? AND id<? ORDER BY id`)
    .all(COURIER_RECEIPT_KINDS.RECONCILED_NOT_SUBMITTED, messageId, Number(row.id), beforeReceiptId);
  const retired = retirements.some(receipt => {
    const detail = deps.parseJson(receipt.detail, null);
    if (!detail || Array.isArray(detail)) return false;
    // Legacy reconciliation names its attempt by receipt order. Public recovery names it explicitly.
    return Object.keys(detail).length === 0 ||
      (detail.source === COURIER_RECOVERY_SOURCES.COURIER_RECOVERY && detail.attemptId === attempt.attemptId);
  });
  return retired ? attempt.attemptId : null;
}
