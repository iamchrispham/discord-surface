import { COURIER_ATTEMPT_STATES, COURIER_OUTCOMES, COURIER_RECEIPT_KINDS, COURIER_RESULT_STATUSES } from './constants';
import { attemptId, attemptKey, createEnvelope, payloadHash } from './envelope';
import { findMatchingRoute, isCourierOriginAllowed, type RouteMatch } from './route';
import type {
  CourierAttempt,
  CourierAttemptRecord,
  CourierDispatchInput,
  CourierDependencies,
  CourierMessage,
  CourierOutcome,
  CourierOutcomeRecord,
  CourierState,
  CourierRoute,
  SqlRow
} from './types';

interface ReceiptRow {
  id: number;
  discordId: string;
  detail: Record<string, any>;
  createdAt: string;
}

function attemptRows(deps: CourierDependencies, state: CourierState, messageId: string | null = null): ReceiptRow[] {
  const rows = messageId === null
    ? state.db.prepare('SELECT id, discord_id, detail, created_at FROM receipts WHERE kind=? ORDER BY id').all(COURIER_RECEIPT_KINDS.ATTEMPT)
    : state.db.prepare('SELECT id, discord_id, detail, created_at FROM receipts WHERE kind=? AND discord_id=? ORDER BY id').all(COURIER_RECEIPT_KINDS.ATTEMPT, messageId);
  return rows.map(row => {
    const raw = row as SqlRow;
    return {
      id: Number(raw.id),
      discordId: String(raw.discord_id),
      detail: deps.parseJson(raw.detail, null) || {},
      createdAt: String(raw.created_at)
    };
  }).filter(row => typeof row.detail.attemptId === 'string');
}

function outcomeRows(deps: CourierDependencies, state: CourierState, messageId: string, id: string): ReceiptRow[] {
  return state.db.prepare('SELECT id, detail, created_at FROM receipts WHERE kind=? AND discord_id=? ORDER BY id')
    .all(COURIER_RECEIPT_KINDS.OUTCOME, messageId)
    .map(row => {
      const raw = row as SqlRow;
      return {
        id: Number(raw.id),
        discordId: messageId,
        detail: deps.parseJson(raw.detail, null) || {},
        createdAt: String(raw.created_at)
      };
    }).filter(row => row.detail.attemptId === id);
}

function latestAttempt(deps: CourierDependencies, state: CourierState, messageId: string, id: string | null = null): CourierAttemptRecord | null {
  const rows = attemptRows(deps, state, messageId).filter(row => !id || row.detail.attemptId === id);
  const row = rows.at(-1);
  if (!row) return null;
  const outcomes = outcomeRows(deps, state, messageId, String(row.detail.attemptId));
  const outcomeRow = outcomes.at(-1);
  const attempt = { ...row.detail, receiptId: row.id, createdAt: row.createdAt } as CourierAttempt;
  const outcome = outcomeRow
    ? { ...outcomeRow.detail, receiptId: outcomeRow.id, createdAt: outcomeRow.createdAt } as CourierOutcomeRecord
    : null;
  return { attempt, outcome };
}

function rejection(deps: CourierDependencies, state: CourierState, messageId: string, reason: string, detail: Record<string, unknown> = {}): void {
  const prior = state.db.prepare('SELECT detail FROM receipts WHERE kind=? AND discord_id=? ORDER BY id DESC LIMIT 1')
    .get(COURIER_RECEIPT_KINDS.REJECTION, messageId) as SqlRow | undefined;
  const previous = deps.parseJson(prior?.detail, null);
  if (previous?.reason === reason && previous?.routeId === detail.routeId) return;
  state.receipt(messageId, COURIER_RECEIPT_KINDS.REJECTION, { reason, ...detail });
}

function normalizeInput(deps: CourierDependencies, input: CourierDispatchInput | null | undefined): CourierDispatchInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new deps.BindingError('courier forwarded prompt is required');
  }
  const prompt = deps.assertText(input.prompt, 'courier.prompt', 100000);
  const routeId = input.routeId == null ? null : deps.assertText(input.routeId, 'routeId', 128);
  const observerCursor = input.observerCursor == null ? null : input.observerCursor;
  if (observerCursor !== null && (typeof observerCursor !== 'object' || Array.isArray(observerCursor))) {
    throw new deps.BindingError('courier observer cursor is invalid');
  }
  return { prompt, routeId, observerCursor };
}

function courierMessage(message: CourierMessage, state: CourierState): boolean {
  if (!isCourierOriginAllowed(state, message)) return false;
  if (message.agentMessage) return true;
  return message.authorId === state.requireConfig().operatorId;
}

function claimedResult(message: CourierMessage, match: RouteMatch, attempt: CourierAttempt, envelope: CourierAttempt['envelope']): Record<string, unknown> {
  return { accepted: true, duplicate: false, status: COURIER_RESULT_STATUSES.CLAIMED, message, route: match.route, attempt, envelope };
}

export function createCourierAttemptHandlers(deps: CourierDependencies) {
  function beginCourierAttempt(state: CourierState, messageId: string, rawInput: CourierDispatchInput): Record<string, any> {
    deps.assertText(messageId, 'messageId', 128);
    const input = normalizeInput(deps, rawInput);
    return state.transaction(() => {
      const message = state.getMessage(messageId);
      if (!message || !courierMessage(message, state)) {
        return { accepted: false, status: COURIER_RESULT_STATUSES.NO_ROUTE, message: message || null };
      }
      if (![deps.MESSAGE_STATES.ACCEPTED, deps.MESSAGE_STATES.DISPATCHING].includes(message.state)) {
        const existing = latestAttempt(deps, state, messageId);
        return existing
          ? { accepted: false, duplicate: true, status: COURIER_RESULT_STATUSES.DUPLICATE, message, ...existing }
          : { accepted: false, status: COURIER_RESULT_STATUSES.SETTLED, message };
      }
      const existing = latestAttempt(deps, state, messageId);
      if (existing) {
        return { accepted: false, duplicate: true, status: COURIER_RESULT_STATUSES.DUPLICATE, message, ...existing };
      }
      const match = findMatchingRoute(deps, state, message, input.routeId);
      if (match.status) {
        rejection(deps, state, messageId, match.status, { routeId: match.route?.routeId || input.routeId || undefined });
        return { accepted: false, status: match.status, message, route: match.route || null };
      }
      const route = match.route as CourierRoute;
      const hash = payloadHash(message, input);
      const key = attemptKey(message, route, hash);
      const id = attemptId(key);
      const envelope = createEnvelope(message, route, id, hash, input);
      const detail = {
        attemptId: id,
        attemptKey: key,
        state: COURIER_ATTEMPT_STATES.CLAIMED,
        messageId,
        route: envelope.route,
        payloadHash: hash,
        courier: envelope.courier,
        recipient: envelope.recipient,
        parent: envelope.parent,
        deliveryChannelId: envelope.deliveryChannelId,
        sourceDestination: envelope.sourceDestination,
        source: envelope.source,
        packet: envelope.packet,
        wire: envelope.wire,
        prompt: envelope.prompt,
        observerCursor: envelope.observerCursor,
        envelope
      };
      state.receipt(messageId, COURIER_RECEIPT_KINDS.ATTEMPT, detail);
      return claimedResult(message, match, { ...detail } as CourierAttempt, envelope);
    });
  }

  function authorizeCourierAttempt(state: CourierState, messageId: string, id: string, rawInput: CourierDispatchInput): Record<string, any> {
    deps.assertText(messageId, 'messageId', 128);
    deps.assertText(id, 'attemptId', 128);
    const input = normalizeInput(deps, rawInput);
    return state.transaction(() => {
      const record = latestAttempt(deps, state, messageId, id);
      const message = state.getMessage(messageId);
      if (!record || !message || !courierMessage(message, state)) {
        return { authorized: false, status: COURIER_RESULT_STATUSES.STALE, message: message || null };
      }
      const match = findMatchingRoute(deps, state, message, record.attempt.route.routeId);
      if (match.status) {
        rejection(deps, state, messageId, match.status, { routeId: record.attempt.route.routeId });
        return { authorized: false, status: match.status, message, route: match.route || null, ...record };
      }
      if (record.outcome) return { authorized: false, duplicate: true, status: COURIER_RESULT_STATUSES.DUPLICATE, message, route: match.route, ...record };
      const route = match.route as CourierRoute;
      const hash = payloadHash(message, input);
      const key = attemptKey(message, route, hash);
      if (key !== record.attempt.attemptKey || hash !== record.attempt.payloadHash) {
        rejection(deps, state, messageId, COURIER_RESULT_STATUSES.CONFLICT, { routeId: route.routeId });
        return { authorized: false, status: COURIER_RESULT_STATUSES.CONFLICT, message, route, ...record };
      }
      const envelope = createEnvelope(message, route, id, hash, input);
      if (JSON.stringify(envelope) !== JSON.stringify(record.attempt.envelope)) {
        rejection(deps, state, messageId, COURIER_RESULT_STATUSES.CONFLICT, { routeId: route.routeId });
        return { authorized: false, status: COURIER_RESULT_STATUSES.CONFLICT, message, route, ...record };
      }
      return { authorized: true, message, route, attempt: record.attempt, envelope };
    });
  }

  function recordCourierOutcome(state: CourierState, messageId: string, id: string, outcome: CourierOutcome, detail: Record<string, unknown> = {}): Record<string, any> {
    deps.assertText(messageId, 'messageId', 128);
    deps.assertText(id, 'attemptId', 128);
    if (!Object.values(COURIER_OUTCOMES).includes(outcome)) throw new deps.BindingError('invalid courier outcome');
    return state.transaction(() => {
      const record = latestAttempt(deps, state, messageId, id);
      if (!record) throw new deps.BindingError('courier attempt is unknown');
      if (record.outcome) return { ...record, duplicate: true };
      state.receipt(messageId, COURIER_RECEIPT_KINDS.OUTCOME, {
        attemptId: id,
        outcome,
        ...detail,
        recordedAt: deps.now()
      });
      return { ...latestAttempt(deps, state, messageId, id), duplicate: false };
    });
  }

  function recoverCourierAttemptsAfterRestart(state: CourierState, { inTransaction = false } = {}): number {
    const operation = () => {
      let recovered = 0;
      for (const row of attemptRows(deps, state)) {
        if (outcomeRows(deps, state, row.discordId, String(row.detail.attemptId)).length) continue;
        state.receipt(row.discordId, COURIER_RECEIPT_KINDS.OUTCOME, {
          attemptId: row.detail.attemptId,
          outcome: COURIER_OUTCOMES.UNCERTAIN,
          reason: 'process stopped during courier queue dispatch',
          afterRestart: true,
          recordedAt: deps.now()
        });
        recovered += 1;
      }
      return recovered;
    };
    return inTransaction ? operation() : state.transaction(operation);
  }

  function getCourierAttempt(state: CourierState, messageId: string, id: string | null = null): CourierAttemptRecord | null {
    deps.assertText(messageId, 'messageId', 128);
    if (id !== null) deps.assertText(id, 'attemptId', 128);
    return latestAttempt(deps, state, messageId, id);
  }

  return { beginCourierAttempt, authorizeCourierAttempt, getCourierAttempt, recordCourierOutcome, recoverCourierAttemptsAfterRestart };
}
