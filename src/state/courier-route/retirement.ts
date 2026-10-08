import { COURIER_RECEIPT_KINDS, COURIER_RECOVERY_SOURCES, COURIER_RECOVERY_TRIGGERS } from './constants';
import type { CourierDependencies, CourierRoute, CourierState, SqlRow } from './types';

export function courierPredecessorRouteMatches(
  deps: CourierDependencies,
  state: CourierState,
  messageId: string,
  predecessorAttemptId: string,
  route: CourierRoute,
  beforeReceiptId = Number.MAX_SAFE_INTEGER
): boolean {
  const row = state.db.prepare(`SELECT detail FROM receipts WHERE kind=?
    AND discord_id=? AND id<? ORDER BY id DESC LIMIT 1`)
    .get(COURIER_RECEIPT_KINDS.ATTEMPT, messageId, beforeReceiptId) as SqlRow | undefined;
  const attempt = deps.parseJson(row?.detail, null);
  const predecessorRoute = attempt?.route;
  const predecessorCourier = attempt?.courier;
  const selectedCourier = route.courier;
  return attempt?.attemptId === predecessorAttemptId &&
    predecessorRoute?.routeId === route.routeId &&
    predecessorRoute?.routeGeneration === route.routeGeneration &&
    predecessorCourier?.provider === selectedCourier.provider &&
    predecessorCourier?.nativeId === selectedCourier.nativeId &&
    predecessorCourier?.workspace === selectedCourier.workspace &&
    (predecessorCourier?.sessionRoot || null) === (selectedCourier.sessionRoot || null) &&
    predecessorCourier?.recipientThreadId === selectedCourier.recipientThreadId &&
    (predecessorCourier?.hostId || null) === (selectedCourier.hostId || null);
}

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
  let explicit = false;
  for (const receipt of retirements) {
    const detail = deps.parseJson(receipt.detail, null);
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
    // Legacy reconciliation names its attempt by receipt order. Public recovery names it explicitly.
    if (Object.keys(detail).length === 0) {
      explicit = true;
      continue;
    }
    if (detail.source !== COURIER_RECOVERY_SOURCES.COURIER_RECOVERY || detail.attemptId !== attempt.attemptId) return null;
    if (detail.trigger === COURIER_RECOVERY_TRIGGERS.EXPLICIT) explicit = true;
    else if (detail.trigger != null && detail.trigger !== COURIER_RECOVERY_TRIGGERS.PICKUP_DEADLINE) return null;
  }
  return explicit ? attempt.attemptId : null;
}
