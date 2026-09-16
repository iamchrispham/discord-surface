const fs = require('node:fs');

const MAX_HOOK_BYTES = 1024 * 1024;

function persistGuardRefusal(state, routeId, event, reason) {
  if (!state || typeof routeId !== 'string' || !event || typeof event !== 'object') return false;
  if (reason !== 'courier hook caller or route is not current' &&
      reason !== 'courier message is not eligible for forwarding' &&
      !reason.startsWith('courier forwarding authorization ')) return false;
  const input = event.tool_input;
  if (!input || typeof input !== 'object' || typeof input.prompt !== 'string' || typeof event.session_id !== 'string' ||
      typeof event.cwd !== 'string') return false;
  const { COURIER_OUTCOMES, COURIER_RECEIPT_KINDS, MESSAGE_STATES } = require('./state');
  return state.transaction(() => {
    const rows = state.db.prepare(`SELECT id, discord_id, detail FROM receipts WHERE kind=?
      AND json_extract(detail, '$.route.routeId')=?
      AND json_extract(detail, '$.courier.nativeId')=?
      AND json_extract(detail, '$.prompt')=? LIMIT 2`)
      .all(COURIER_RECEIPT_KINDS.ATTEMPT, routeId, event.session_id, input.prompt);
    if (rows.length !== 1) return false;
    const row = rows[0];
    let detail;
    try { detail = JSON.parse(row.detail); } catch { return false; }
    const attemptId = detail?.attemptId;
    const messageId = String(row.discord_id);
    if (typeof attemptId !== 'string' || detail?.courier?.workspace !== event.cwd) return false;
    const outcome = state.getCourierAttempt(messageId, attemptId)?.outcome?.outcome;
    if (outcome && ![COURIER_OUTCOMES.SUBMITTED, COURIER_OUTCOMES.UNCERTAIN].includes(outcome)) return false;
    if (state.db.prepare(`SELECT 1 FROM receipts WHERE kind=? AND discord_id=? AND id>?
      AND json_extract(detail, '$.attemptId')=? LIMIT 1`)
      .get(COURIER_RECEIPT_KINDS.FORWARD_CLAIM, messageId, Number(row.id), attemptId)) return false;
    const message = state.getMessage(messageId);
    if (!message || ![MESSAGE_STATES.DISPATCHING, MESSAGE_STATES.SUBMITTED].includes(message.state) ||
        state.hasNativeAcknowledgment(message)) return false;
    state.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state IN (?, ?)')
      .run(MESSAGE_STATES.ACCEPTED, new Date().toISOString(), messageId, MESSAGE_STATES.DISPATCHING, MESSAGE_STATES.SUBMITTED);
    state.receipt(messageId, COURIER_RECEIPT_KINDS.OUTCOME, {
      attemptId,
      outcome: COURIER_OUTCOMES.NOT_SUBMITTED,
      reason: 'courier guard refused before host call',
      guardReason: reason
    });
    return true;
  });
}

function readHookEvent(fd) {
  const chunks = [];
  const buffer = Buffer.alloc(4096);
  let length = 0;
  for (;;) {
    const count = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (!count) break;
    length += count;
    if (length > MAX_HOOK_BYTES) throw new Error('courier hook input exceeds 1 MiB');
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function courierGuard(args, pathsFor) {
  let state;
  let event;
  try {
    if (typeof args['courier-route-id'] !== 'string' || !args['courier-route-id']) {
      throw new Error('missing --courier-route-id');
    }
    event = readHookEvent(0);
    const { db } = pathsFor(args);
    const stat = fs.statSync(db);
    if (!stat.isFile() || stat.size === 0) throw new Error('courier state database is missing');
    const { SurfaceState } = require('./state');
    state = new SurfaceState(db, { requireCurrentSchema: true });
    state.claimCourierForward(args['courier-route-id'], event);
    state.close();
    state = null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try { persistGuardRefusal(state, args['courier-route-id'], event, reason); } catch {}
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: reason
    } })}\n`);
    process.stderr.write(`${reason}\n`);
    process.exitCode = 2;
  } finally {
    if (state) {
      try { state.close(); } catch { process.exitCode = 2; }
    }
  }
}

module.exports = { courierGuard, MAX_HOOK_BYTES, persistGuardRefusal };
