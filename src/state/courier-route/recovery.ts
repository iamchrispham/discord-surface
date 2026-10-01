import {
  COURIER_DELIVERY_STATUSES,
  COURIER_OUTCOMES,
  COURIER_RECEIPT_KINDS,
  COURIER_RECOVERY_REASONS,
  COURIER_RECOVERY_SOURCES
} from './constants';
import { hasCourierForwardClaim, hasRetiredCourierAttempt } from './forward';
import { isConfirmedCourierGuardRefusal } from './guard-refusal';
import type {
  CourierAttemptRecord,
  CourierDeliveryStatus,
  CourierDeliveryStatusRow,
  CourierDependencies,
  CourierMessage,
  CourierRecoveryReason,
  CourierRecoveryResult,
  CourierState,
  SqlRow
} from './types';

// Issue128 public courier recovery. This module owns the single authoritative
// decision for explicitly retiring a queue-admitted courier attempt and for
// projecting its delivery status. "retired" only ever means the attempt can no
// longer gain forwarding permission; it never asserts that the native tool ran.
// Nothing here reads a clock, a transcript, Discord, the Gateway, a native
// executor, or custody tables.

export interface RecoveryState extends CourierState {
  getCourierAttempt(messageId: string, id?: string | null): CourierAttemptRecord | null;
  hasNativeAcknowledgment(message: CourierMessage): boolean;
}

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function receiptDetail(raw: unknown): Record<string, any> | null {
  const value = (raw as SqlRow | undefined)?.detail;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return record(value) ? value : null;
}

// Every attempt persisted for the message, oldest first, de-duplicated by id.
function attemptIds(state: RecoveryState, messageId: string): string[] {
  const rows = state.db.prepare('SELECT detail FROM receipts WHERE kind=? AND discord_id=? ORDER BY id')
    .all(COURIER_RECEIPT_KINDS.ATTEMPT, messageId);
  const ids: string[] = [];
  for (const row of rows) {
    const detail = receiptDetail(row);
    if (detail && typeof detail.attemptId === 'string' && !ids.includes(detail.attemptId)) ids.push(detail.attemptId);
  }
  return ids;
}

// True only for a courier-recovery retirement of this exact attempt. A legacy
// `uncertain-reconciled-not_submitted` receipt (no source/attemptId) still fences
// late forwarding through hasRetiredCourierAttempt, but it is not an idempotent
// public recovery result.
function retiredByRecovery(state: RecoveryState, messageId: string, attemptReceiptId: number, attemptId: string): boolean {
  if (!Number.isSafeInteger(attemptReceiptId) || !hasRetiredCourierAttempt(state, messageId, attemptReceiptId)) return false;
  const rows = state.db.prepare('SELECT detail FROM receipts WHERE kind=? AND discord_id=? AND id>? ORDER BY id')
    .all(COURIER_RECEIPT_KINDS.RECONCILED_NOT_SUBMITTED, messageId, attemptReceiptId);
  return rows.some(row => {
    const detail = receiptDetail(row);
    return Boolean(detail &&
      detail.source === COURIER_RECOVERY_SOURCES.COURIER_RECOVERY &&
      detail.attemptId === attemptId);
  });
}

function parentIdentityMatches(message: CourierMessage, attempt: CourierAttemptRecord): boolean {
  return attempt.attempt.parent?.guildId === message.guildId &&
    attempt.attempt.parent?.channelId === message.channelId &&
    attempt.attempt.parent?.provider === message.provider &&
    attempt.attempt.parent?.nativeId === message.nativeId &&
    attempt.attempt.parent?.generation === message.generation;
}

// The shared fresh-eligibility decision. recoverCourierAttempt executes it and
// getCourierDeliveryStatus reports it without writing. Order: current binding,
// exact latest attempt, attempt envelope identity, existing retirement, native
// acknowledgment, any forward claim, then the custody requirement. The latest
// attempt is passed in so a missing or superseded attempt refuses as
// stale_attempt, never as a fabricated identity or eligibility result.
function recoveryReason(
  deps: CourierDependencies,
  state: RecoveryState,
  message: CourierMessage,
  attempt: CourierAttemptRecord | null,
  latestAttemptId: string | null
): CourierRecoveryReason {
  const check = state.currentMessageBinding(message);
  if (!check?.current) return COURIER_RECOVERY_REASONS.STALE_BINDING;
  if (!attempt || latestAttemptId !== attempt.attempt.attemptId) return COURIER_RECOVERY_REASONS.STALE_ATTEMPT;
  if (!parentIdentityMatches(message, attempt)) return COURIER_RECOVERY_REASONS.ATTEMPT_IDENTITY_MISMATCH;
  const deliveryChannelId = message.deliveryChannelId || check.deliveryChannelId;
  if (attempt.attempt.deliveryChannelId !== deliveryChannelId) return COURIER_RECOVERY_REASONS.STALE_BINDING;
  if (retiredByRecovery(state, message.id, Number(attempt.attempt.receiptId), attempt.attempt.attemptId)) {
    return COURIER_RECOVERY_REASONS.RETIRED;
  }
  if (state.hasNativeAcknowledgment(message)) return COURIER_RECOVERY_REASONS.NATIVE_ACKNOWLEDGED;
  if (hasCourierForwardClaim(state, message.id)) return COURIER_RECOVERY_REASONS.FORWARD_CLAIMED;
  // Issue196: a submitted message with a submitted outcome is the original
  // eligible case. A guard-refused attempt already left accepted custody, so the
  // accepted message plus confirmed pre-host guard evidence is the one added
  // eligible case. Anything else remains an explicit not_submitted refusal.
  const submittedCustody = attempt.outcome?.outcome === COURIER_OUTCOMES.SUBMITTED &&
    message.state === deps.MESSAGE_STATES.SUBMITTED;
  const guardRefusedCustody = message.state === deps.MESSAGE_STATES.ACCEPTED &&
    isConfirmedCourierGuardRefusal(attempt.outcome);
  if (!submittedCustody && !guardRefusedCustody) return COURIER_RECOVERY_REASONS.NOT_SUBMITTED;
  return COURIER_RECOVERY_REASONS.ELIGIBLE;
}

// Status projection priority is intentionally separate from eligibility: a
// forward claim or native acknowledgment is visible evidence about the message
// regardless of which attempt is latest. "retired" is attributed only to the
// exact latest attempt named by the courier-recovery receipt. guard_refused is
// the additive issue196 status: confirmed pre-host guard evidence on accepted
// custody, never a queue admission or native-completion claim.
function projectedStatus(
  deps: CourierDependencies,
  state: RecoveryState,
  message: CourierMessage,
  attempt: CourierAttemptRecord,
  latestAttemptId: string | null
): CourierDeliveryStatus {
  if (state.hasNativeAcknowledgment(message)) return COURIER_DELIVERY_STATUSES.NATIVE_ACKNOWLEDGED;
  if (hasCourierForwardClaim(state, message.id)) return COURIER_DELIVERY_STATUSES.FORWARD_CLAIMED;
  if (latestAttemptId === attempt.attempt.attemptId &&
      retiredByRecovery(state, message.id, Number(attempt.attempt.receiptId), attempt.attempt.attemptId)) {
    return COURIER_DELIVERY_STATUSES.RETIRED;
  }
  if (message.state === deps.MESSAGE_STATES.ACCEPTED && isConfirmedCourierGuardRefusal(attempt.outcome)) {
    return COURIER_DELIVERY_STATUSES.GUARD_REFUSED;
  }
  if (attempt.outcome?.outcome === COURIER_OUTCOMES.SUBMITTED) return COURIER_DELIVERY_STATUSES.QUEUED_UNFORWARDED;
  return COURIER_DELIVERY_STATUSES.NOT_APPLICABLE;
}

function refusal(reason: CourierRecoveryReason): string {
  return `courier recovery refused: ${reason}`;
}

export function recoverCourierAttempt(
  deps: CourierDependencies,
  state: RecoveryState,
  messageId: string,
  attemptId: string
): CourierRecoveryResult {
  deps.assertText(messageId, 'messageId', 128);
  deps.assertText(attemptId, 'attemptId', 128);
  return state.transaction(() => {
    const message = state.getMessage(messageId);
    if (!message) throw new deps.BindingError(refusal(COURIER_RECOVERY_REASONS.UNKNOWN_MESSAGE));
    // One eligibility decision for both the mutation and the projection. The
    // requested attempt must be the persisted latest attempt; anything missing,
    // superseded, or otherwise ineligible refuses before any write.
    const latest = state.getCourierAttempt(messageId);
    const reason = recoveryReason(deps, state, message, latest, attemptId);
    // Idempotence comes before every later refusal and before any write, so a
    // repeat of the same retirement stays retired even after later native
    // acknowledgment. It never retires a newer attempt.
    if (reason === COURIER_RECOVERY_REASONS.RETIRED) {
      return { message: state.getMessage(messageId), attemptId, retired: true, duplicate: true };
    }
    if (reason !== COURIER_RECOVERY_REASONS.ELIGIBLE || !latest) {
      throw new deps.BindingError(refusal(reason));
    }
    state.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
      .run(deps.MESSAGE_STATES.ACCEPTED, deps.now(), messageId, message.state);
    state.receipt(messageId, COURIER_RECEIPT_KINDS.RECONCILED_NOT_SUBMITTED, {
      attemptId,
      route: {
        routeId: latest.attempt.route.routeId,
        routeGeneration: latest.attempt.route.routeGeneration
      },
      generation: message.generation,
      source: COURIER_RECOVERY_SOURCES.COURIER_RECOVERY
    });
    return { message: state.getMessage(messageId), attemptId, retired: true, duplicate: false };
  });
}

export function getCourierDeliveryStatus(
  deps: CourierDependencies,
  state: RecoveryState,
  messageId: string
): CourierDeliveryStatusRow[] {
  deps.assertText(messageId, 'messageId', 128);
  const message = state.getMessage(messageId);
  if (!message) return [];
  const latest = state.getCourierAttempt(messageId);
  const rows: CourierDeliveryStatusRow[] = [];
  for (const id of attemptIds(state, messageId)) {
    const attempt = state.getCourierAttempt(messageId, id);
    if (!attempt || attempt.attempt.attemptId !== id) continue;
    const reason = recoveryReason(deps, state, message, attempt, latest?.attempt.attemptId ?? null);
    rows.push({
      messageId,
      attemptId: id,
      status: projectedStatus(deps, state, message, attempt, latest?.attempt.attemptId ?? null),
      recoveryEligible: reason === COURIER_RECOVERY_REASONS.ELIGIBLE,
      recoveryReason: reason
    });
  }
  return rows;
}
