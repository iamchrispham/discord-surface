import type { AcknowledgmentState, AcknowledgmentMessage, NativeAcknowledgmentInput, NativeAcknowledgmentResult } from './contracts';
import {
  ACK,
  ACK_OUTCOMES,
  MESSAGE_STATES,
  NATIVE_PROVIDERS,
  REPLY_READY_RECEIPTS,
  validateNativeId
} from './constants';
import type { MessageState } from './constants';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export function property(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined;
  return (value as Record<string, unknown>)[key];
}

export function parseReceiptDetail(detail: unknown): unknown {
  if (typeof detail !== 'string') return detail && typeof detail === 'object' ? detail : null;
  try { return JSON.parse(detail); } catch { return null; }
}

export function latestAcknowledgmentOutcomes(state: AcknowledgmentState): Array<{ discord_id: string; detail: unknown }> {
  return state.db.prepare(`SELECT done.discord_id, done.detail FROM receipts done
    WHERE done.kind=? AND NOT EXISTS
    (SELECT 1 FROM receipts newer WHERE newer.discord_id=done.discord_id
      AND newer.kind=done.kind AND newer.id>done.id)`).all<{ discord_id: string; detail: unknown }>(ACK.OUTCOME);
}

export function latestAcknowledgmentOutcome(state: AcknowledgmentState, messageId: string): unknown {
  const row = state.db.prepare('SELECT detail FROM receipts WHERE discord_id=? AND kind=? ORDER BY id DESC LIMIT 1')
    .get<{ detail: unknown }>(messageId, ACK.OUTCOME);
  return row ? parseReceiptDetail(row.detail) : null;
}

export function hasAcknowledgmentReceipt(state: AcknowledgmentState, messageId: string): boolean {
  return Boolean(state.db.prepare('SELECT 1 FROM receipts WHERE discord_id=? AND kind=? LIMIT 1')
    .get(messageId, ACK.RECEIVED));
}

export function receiptRowsAfter(state: AcknowledgmentState, receiptId: number, throughId: number): Array<{ id: number; discord_id: string; kind: string }> {
  return state.db.prepare(`SELECT id, discord_id, kind FROM receipts
    WHERE id>? AND id<=? AND kind IN (?, ?, ?, ?) ORDER BY id`).all<{ id: number; discord_id: string; kind: string }>(
      receiptId, throughId, ACK.RECEIVED, ACK.OUTCOME, REPLY_READY_RECEIPTS.REPLY, REPLY_READY_RECEIPTS.BEFORE_SUBMIT
    );
}

export function latestReceiptId(state: AcknowledgmentState): number {
  const row = state.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM receipts').get<{ id: number }>();
  return Number(row?.id);
}

export function retryableUnknown(detail: unknown): detail is Record<string, unknown> & { retryAt: number } {
  return isRecord(detail) && detail.outcome === ACK_OUTCOMES.UNKNOWN && !detail.terminal && Number.isFinite(detail.retryAt);
}

export function recordNativeAcknowledgment(
  state: AcknowledgmentState,
  { provider, messageId, nativeId, generation }: NativeAcknowledgmentInput
): NativeAcknowledgmentResult {
  validateNativeId(nativeId);
  if (!Object.values(NATIVE_PROVIDERS).includes(provider) || !Number.isInteger(generation) || generation < 1) {
    throw new Error('invalid native acknowledgment identity');
  }
  return state.transaction(() => {
    const message = state.getMessage(messageId);
    const current = message && state.currentMessageBinding(message);
    if (!message || !current?.current || message.provider !== provider || message.nativeId !== nativeId || message.generation !== generation) {
      throw new Error('native acknowledgment owner or generation is stale');
    }
    const duplicate = state.db.prepare('SELECT id FROM receipts WHERE discord_id=? AND kind=? LIMIT 1').get(messageId, ACK.RECEIVED);
    if (duplicate) return { recorded: false, duplicate: true, messageId };
    if (!([MESSAGE_STATES.DISPATCHING, MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLY_READY,
      MESSAGE_STATES.REPLYING, MESSAGE_STATES.REPLY_FAILED, MESSAGE_STATES.REPLY_UNKNOWN,
      MESSAGE_STATES.REPLIED, MESSAGE_STATES.UNCERTAIN] as readonly MessageState[]).includes(message.state)) {
      throw new Error(`native acknowledgment is not accepted in state ${message.state}`);
    }
    state.receipt(messageId, ACK.RECEIVED, { provider, nativeId, generation, source: 'explicit-native-ack' });
    if (([MESSAGE_STATES.DISPATCHING, MESSAGE_STATES.UNCERTAIN] as readonly MessageState[]).includes(message.state)) {
      state.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
        .run(MESSAGE_STATES.SUBMITTED, new Date().toISOString(), messageId, message.state);
      state.receipt(messageId, 'dispatch-already-acknowledged', {
        generation,
        fromState: message.state
      });
    }
    return { recorded: true, duplicate: false, messageId };
  });
}

export function pendingAcknowledgments(state: AcknowledgmentState, now = Date.now(), throughId: number | null = null): string[] {
  const outcomes = new Map(latestAcknowledgmentOutcomes(state).map(row => [row.discord_id, parseReceiptDetail(row.detail)]));
  const seen = new Set();
  const cutoff = throughId === null ? '' : ' AND r.id<=?';
  const statement = state.db.prepare(`SELECT r.discord_id FROM receipts r
    WHERE r.kind=? AND NOT EXISTS
    (SELECT 1 FROM receipts done WHERE done.discord_id=r.discord_id AND done.kind=?
      AND done.detail NOT LIKE ?)
    ${cutoff} ORDER BY r.id`);
  const rows = throughId === null
    ? statement.all<{ discord_id: string }>(ACK.RECEIVED, ACK.OUTCOME, '%"outcome":"unknown"%')
    : statement.all<{ discord_id: string }>(ACK.RECEIVED, ACK.OUTCOME, '%"outcome":"unknown"%', throughId);
  return rows
    .filter(row => {
      if (seen.has(row.discord_id)) return false;
      seen.add(row.discord_id);
      const detail = outcomes.get(row.discord_id);
      if (!detail) return true;
      if (!isRecord(detail) || detail.outcome !== ACK_OUTCOMES.UNKNOWN) return false;
      if (detail.terminal) return false;
      return !Number.isFinite(detail.retryAt) || Number(detail.retryAt) <= now;
    }).map(row => row.discord_id);
}

export function currentReplyReadyMessages(state: AcknowledgmentState, throughId: number): string[] {
  return state.db.prepare(`SELECT m.discord_id FROM messages m
    WHERE m.state=? AND EXISTS
    (SELECT 1 FROM receipts r WHERE r.discord_id=m.discord_id AND r.id<=? AND r.kind IN (?, ?))`).all<{ discord_id: string }>(
      MESSAGE_STATES.REPLY_READY, throughId, REPLY_READY_RECEIPTS.REPLY, REPLY_READY_RECEIPTS.BEFORE_SUBMIT
    ).map(row => row.discord_id);
}

export function isAcknowledgmentPending(state: AcknowledgmentState, messageId: string, now = Date.now()): boolean {
  const row = state.db.prepare(`SELECT r.discord_id, latest.detail AS outcome_detail
    FROM receipts r
    LEFT JOIN receipts latest ON latest.id = (
      SELECT candidate.id FROM receipts candidate
      WHERE candidate.discord_id=r.discord_id AND candidate.kind=?
      ORDER BY candidate.id DESC LIMIT 1
    )
    WHERE r.kind=? AND r.discord_id=?
    ORDER BY r.id DESC LIMIT 1`).get<{ outcome_detail: unknown }>(ACK.OUTCOME, ACK.RECEIVED, messageId);
  if (!row) return false;
  if (row.outcome_detail === null || row.outcome_detail === undefined) return true;
  const detail = parseReceiptDetail(row.outcome_detail);
  if (!isRecord(detail) || detail.outcome !== ACK_OUTCOMES.UNKNOWN) return false;
  if (detail.terminal) return false;
  return !Number.isFinite(detail.retryAt) || Number(detail.retryAt) <= now;
}

export function unknownAcknowledgmentAttempts(state: AcknowledgmentState, messageId: string): number {
  return state.db.prepare('SELECT detail FROM receipts WHERE discord_id=? AND kind=? ORDER BY id')
    .all<{ detail: unknown }>(messageId, ACK.OUTCOME)
    .reduce((count, row) => {
      const detail = parseReceiptDetail(row.detail);
      return count + (isRecord(detail) && detail.outcome === ACK_OUTCOMES.UNKNOWN ? 1 : 0);
    }, 0);
}

export function acknowledgedMessage(state: AcknowledgmentState, messageId: string): AcknowledgmentMessage {
  const receipt = state.db.prepare('SELECT detail FROM receipts WHERE discord_id=? AND kind=? ORDER BY id DESC LIMIT 1')
    .get<{ detail: unknown }>(messageId, ACK.RECEIVED);
  const identity = parseReceiptDetail(receipt?.detail);
  const message = state.getMessage(messageId);
  if (!message || !isRecord(identity) || message.provider !== identity.provider || message.nativeId !== identity.nativeId ||
    message.generation !== identity.generation) throw new Error('native acknowledgment owner or generation is stale');
  return message;
}
