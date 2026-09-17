import * as path from 'node:path';
import * as os from 'node:os';
import { COURIER_OUTCOMES, COURIER_RECEIPT_KINDS, COURIER_ROUTE_STATES } from './constants';
import { attemptId, attemptKey, createEnvelope, payloadHash } from './envelope';
import { findMatchingRoute, getRoute } from './route';
import type { CourierAttemptRecord, CourierDependencies, CourierMessage, CourierState } from './types';

export interface ForwardState extends CourierState {
  getCourierAttempt(messageId: string, id: string): CourierAttemptRecord | null;
  hasNativeAcknowledgment(message: CourierMessage): boolean;
}

const FORWARD = Object.freeze({
  EVENT: 'PreToolUse',
  TOOL: 'mcp__codex_app__send_message_to_thread'
} as const);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalWorkspace(value: unknown): string | null {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  const normalized = path.normalize(value);
  const root = path.parse(normalized).root;
  return normalized.length > root.length && normalized.endsWith(path.sep)
    ? normalized.slice(0, -path.sep.length)
    : normalized;
}

function configuredSessionRoot(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}

function transcriptIsInSessionRoot(transcriptPath: unknown, configuredRoot: string | null): boolean {
  if (typeof transcriptPath !== 'string') return false;
  const effectiveRoot = configuredRoot || configuredSessionRoot();
  const relative = path.relative(path.resolve(effectiveRoot), path.resolve(transcriptPath));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function hasRetiredCourierAttempt(state: Pick<ForwardState, 'db'>, messageId: string, attemptReceiptId: number): boolean {
  return Boolean(state.db.prepare(`SELECT id FROM receipts WHERE kind=?
    AND discord_id=? AND id>? LIMIT 1`)
    .get(COURIER_RECEIPT_KINDS.RECONCILED_NOT_SUBMITTED, messageId, attemptReceiptId));
}

export function hasCourierForwardClaim(state: Pick<ForwardState, 'db'>, messageId: string, attemptId: string | null = null): boolean {
  const query = attemptId === null
    ? `SELECT id FROM receipts WHERE kind=? AND discord_id=? LIMIT 1`
    : `SELECT id FROM receipts WHERE kind=? AND discord_id=?
      AND json_extract(detail, '$.attemptId')=? LIMIT 1`;
  const row = attemptId === null
    ? state.db.prepare(query).get(COURIER_RECEIPT_KINDS.FORWARD_CLAIM, messageId)
    : state.db.prepare(query).get(COURIER_RECEIPT_KINDS.FORWARD_CLAIM, messageId, attemptId);
  return Boolean(row);
}

export function claimCourierForward(deps: CourierDependencies, state: ForwardState, routeId: string, event: unknown) {
  deps.assertText(routeId, 'routeId', 128);
  if (!record(event) || event.hook_event_name !== FORWARD.EVENT || event.tool_name !== FORWARD.TOOL ||
      !record(event.tool_input) || typeof event.tool_input.prompt !== 'string') {
    throw new deps.BindingError('courier hook event is invalid');
  }
  const input = event.tool_input;
  const prompt = deps.assertText(input.prompt, 'prompt', 100000);
  return state.transaction(() => {
    const route = getRoute(deps, state, routeId);
    const eventWorkspace = canonicalWorkspace(event.cwd);
    const routeWorkspace = route ? canonicalWorkspace(route.courier.workspace) : null;
    if (!route || route.status !== COURIER_ROUTE_STATES.ACTIVE ||
        event.session_id !== route.courier.nativeId || eventWorkspace === null || routeWorkspace === null ||
        eventWorkspace !== routeWorkspace ||
        !transcriptIsInSessionRoot(event.transcript_path, route.courier.sessionRoot)) {
      throw new deps.BindingError('courier hook caller or route is not current');
    }
    const rows = state.db.prepare(`SELECT id, discord_id, detail FROM receipts WHERE kind=?
      AND json_extract(detail, '$.route.routeId')=?
      AND json_extract(detail, '$.courier.nativeId')=?
      AND json_extract(detail, '$.prompt')=? LIMIT 2`)
      .all(COURIER_RECEIPT_KINDS.ATTEMPT, routeId, event.session_id, prompt);
    if (rows.length !== 1) throw new deps.BindingError('courier hook requires one exact persisted attempt');
    const saved = deps.parseJson(rows[0].detail, null);
    const id = saved?.attemptId;
    const messageId = String(rows[0].discord_id);
    const attemptReceiptId = Number(rows[0].id);
    if (typeof id !== 'string') throw new deps.BindingError('courier attempt identity is invalid');
    const current = state.getCourierAttempt(messageId, id);
    const message = state.getMessage(messageId);
    if (!current || !message) throw new deps.BindingError('courier attempt is unavailable');
    const persistedRecipient = current.attempt.envelope.recipient;
    const expected: Record<string, unknown> = { threadId: persistedRecipient.threadId, prompt };
    if (persistedRecipient.hostId) expected.hostId = persistedRecipient.hostId;
    if (Object.keys(input).length !== Object.keys(expected).length ||
        !Object.entries(expected).every(([key, value]) => input[key] === value)) {
      throw new deps.BindingError('courier hook tool input differs from the fixed recipient');
    }
    const eligible = [deps.MESSAGE_STATES.DISPATCHING, deps.MESSAGE_STATES.SUBMITTED, deps.MESSAGE_STATES.UNCERTAIN];
    const reconciledNotSubmitted = hasRetiredCourierAttempt(state, messageId, attemptReceiptId);
    if (!eligible.includes(message.state) || state.hasNativeAcknowledgment(message)) {
      throw new deps.BindingError('courier message is not eligible for forwarding');
    }
    const match = findMatchingRoute(deps, state, message, routeId);
    if (match.status) throw new deps.BindingError(`courier forwarding authorization ${match.status}`);
    if (reconciledNotSubmitted || current.outcome?.outcome === COURIER_OUTCOMES.NOT_SUBMITTED) {
      throw new deps.BindingError('courier queue submission was refused');
    }

    const dispatch = { routeId, prompt, observerCursor: current.attempt.observerCursor };
    const hash = payloadHash(message, dispatch);
    const key = attemptKey(message, route, hash);
    const envelope = createEnvelope(message, route, id, hash, dispatch);
    if (id !== attemptId(key) || key !== current.attempt.attemptKey || hash !== current.attempt.payloadHash ||
        JSON.stringify(envelope) !== JSON.stringify(current.attempt.envelope)) {
      throw new deps.BindingError('courier attempt changed after admission');
    }
    if (hasCourierForwardClaim(state, messageId, id)) {
      throw new deps.BindingError('courier forwarding attempt is already claimed');
    }

    // Commit before the host call. An interrupted or uncertain call never regains permission.
    state.receipt(messageId, COURIER_RECEIPT_KINDS.FORWARD_CLAIM, {
      attemptId: id, routeId, routeGeneration: route.routeGeneration,
      callerSessionId: route.courier.nativeId, recipient: envelope.recipient,
      generation: message.generation, payloadHash: hash,
      toolUseId: typeof event.tool_use_id === 'string' ? event.tool_use_id : null,
      turnId: typeof event.turn_id === 'string' ? event.turn_id : null
    });
    return { attemptId: id, messageId };
  });
}
