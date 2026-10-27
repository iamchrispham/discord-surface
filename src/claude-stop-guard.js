const { readHookEvent } = require('./courier-guard');

// Copies of MESSAGE_STATES.SUBMITTED, PROVIDERS.CLAUDE and NATIVE_ACK_RECEIPT, because ./state loads the built dist this hook must not need.
const STOP_GUARD_VOCABULARY = Object.freeze({ SUBMITTED: 'submitted', CLAUDE: 'claude', NATIVE_ACK: 'native-ack' });
const BUSY_TIMEOUT_MS = 200;

// Submitted means the listener's notification write succeeded (Claude Code may still queue it), the set claude-submitted-reoffer treats as owed.
const UNACKNOWLEDGED_HANDED_MESSAGES = `SELECT m.discord_id AS messageId, m.generation FROM messages m
  JOIN bindings b ON b.channel_id = m.channel_id
  WHERE m.native_id = ? AND m.provider = ? AND m.state = ?
    AND b.active = 1 AND b.provider = m.provider AND b.native_id = m.native_id AND b.generation = m.generation
    AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.kind = ? AND r.discord_id = m.discord_id)
  ORDER BY m.created_at, m.discord_id`;

function unacknowledgedMessages(dbPath, sessionId) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const { SUBMITTED, CLAUDE, NATIVE_ACK } = STOP_GUARD_VOCABULARY;
    return db.prepare(UNACKNOWLEDGED_HANDED_MESSAGES).all(sessionId, CLAUDE, SUBMITTED, NATIVE_ACK);
  } finally {
    db.close();
  }
}

function stopDecision(event, dbPath) {
  if (!event || typeof event.session_id !== 'string' || !event.session_id || event.stop_hook_active) return null;
  const messages = unacknowledgedMessages(dbPath, event.session_id);
  if (messages.length === 0) return null;
  const list = messages.map(message => `messageId "${message.messageId}" generation ${message.generation}`).join(', ');
  return {
    decision: 'block',
    reason: `Discord message not acknowledged: ${list}. It was handed to this session. ` +
      'If its event is in your context, acknowledge it now and follow the result before ending the turn: ' +
      'call acknowledge with that messageId and generation, loading acknowledge and reply with one ToolSearch call first if they are not loaded ' +
      '(a Monitor event runs its acknowledgment.command instead), then handle the request as its event instructs. ' +
      'If its event is not in your context, do not acknowledge it.'
  };
}

// Runs at every Claude Stop on the machine, so any failure stays silent and never blocks the turn.
function claudeStopGuard(args, pathsFor, argumentError = null) {
  try {
    if (argumentError) return;
    const decision = stopDecision(readHookEvent(0), pathsFor(args).db);
    if (decision) process.stdout.write(`${JSON.stringify(decision)}\n`);
  } catch {}
}

module.exports = { claudeStopGuard, stopDecision, STOP_GUARD_VOCABULARY };
