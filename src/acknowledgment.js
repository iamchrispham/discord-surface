const fs = require('node:fs');
const path = require('node:path');
const { MESSAGE_STATES, validateNativeId } = require('./state');

const ACK = Object.freeze({ RECEIVED: 'native-ack', OUTCOME: 'native-ack-reaction' });
const ACK_OUTCOMES = Object.freeze({ SENT: 'sent', STALE: 'stale', FAILED: 'failed', UNKNOWN: 'unknown' });
const REACTION = Object.freeze({ SAVED: '📥', ACKNOWLEDGED: '👀' });
const ACK_RETRY = Object.freeze({ BASE_MS: 250, MAX_MS: 60000 });

function parseReceiptDetail(detail) {
  if (typeof detail !== 'string') return detail && typeof detail === 'object' ? detail : null;
  try { return JSON.parse(detail); } catch { return null; }
}

function latestAcknowledgmentOutcomes(state) {
  return state.db.prepare(`SELECT done.discord_id, done.detail FROM receipts done
    WHERE done.kind=? AND NOT EXISTS
    (SELECT 1 FROM receipts newer WHERE newer.discord_id=done.discord_id
      AND newer.kind=done.kind AND newer.id>done.id)`).all(ACK.OUTCOME);
}

function acknowledgmentCommand(message, dbPath, cliPath = path.join(__dirname, 'cli.js')) {
  return [process.execPath, cliPath, 'native-ack', '--db', dbPath,
    '--provider', message.provider, '--message-id', message.id,
    '--native-id', message.nativeId, '--generation', String(message.generation)];
}

function recordNativeAcknowledgment(state, { provider, messageId, nativeId, generation }) {
  validateNativeId(nativeId);
  if (!['codex', 'claude'].includes(provider) || !Number.isInteger(generation) || generation < 1) {
    throw new Error('invalid native acknowledgment identity');
  }
  return state.transaction(() => {
    const message = state.getMessage(messageId);
    const current = message && state.currentMessageBinding(message);
    if (!current?.current || message.provider !== provider || message.nativeId !== nativeId || message.generation !== generation) {
      throw new Error('native acknowledgment owner or generation is stale');
    }
    const duplicate = state.db.prepare('SELECT id FROM receipts WHERE discord_id=? AND kind=? LIMIT 1').get(messageId, ACK.RECEIVED);
    if (duplicate) return { recorded: false, duplicate: true, messageId };
    if (![MESSAGE_STATES.DISPATCHING, MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLY_READY,
      MESSAGE_STATES.REPLYING, MESSAGE_STATES.REPLY_FAILED, MESSAGE_STATES.REPLY_UNKNOWN,
      MESSAGE_STATES.REPLIED, MESSAGE_STATES.UNCERTAIN].includes(message.state)) {
      throw new Error(`native acknowledgment is not accepted in state ${message.state}`);
    }
    state.receipt(messageId, ACK.RECEIVED, { provider, nativeId, generation });
    return { recorded: true, duplicate: false, messageId };
  });
}

function pendingAcknowledgments(state, now = Date.now()) {
  const outcomes = new Map(latestAcknowledgmentOutcomes(state).map(row => [row.discord_id, parseReceiptDetail(row.detail)]));
  const seen = new Set();
  return state.db.prepare(`SELECT r.discord_id FROM receipts r
    WHERE r.kind=? AND NOT EXISTS
    (SELECT 1 FROM receipts done WHERE done.discord_id=r.discord_id AND done.kind=?
      AND done.detail NOT LIKE ?)
    ORDER BY r.id`).all(ACK.RECEIVED, ACK.OUTCOME, '%"outcome":"unknown"%')
    .filter(row => {
      if (seen.has(row.discord_id)) return false;
      seen.add(row.discord_id);
      const detail = outcomes.get(row.discord_id);
      if (!detail) return true;
      if (detail.outcome !== ACK_OUTCOMES.UNKNOWN) return false;
      return !Number.isFinite(detail.retryAt) || detail.retryAt <= now;
    }).map(row => row.discord_id);
}

function nextAcknowledgmentRetryAt(state) {
  let next = null;
  for (const row of latestAcknowledgmentOutcomes(state)) {
    const detail = parseReceiptDetail(row.detail);
    if (detail?.outcome !== ACK_OUTCOMES.UNKNOWN || !Number.isFinite(detail.retryAt)) continue;
    if (next === null || detail.retryAt < next) next = detail.retryAt;
  }
  return next;
}

function unknownAcknowledgmentAttempts(state, messageId) {
  return state.db.prepare('SELECT detail FROM receipts WHERE discord_id=? AND kind=? ORDER BY id')
    .all(messageId, ACK.OUTCOME)
    .reduce((count, row) => count + (parseReceiptDetail(row.detail)?.outcome === ACK_OUTCOMES.UNKNOWN ? 1 : 0), 0);
}

function acknowledgmentFailureStatus(error) {
  const candidates = [error?.status, error?.statusCode, error?.response?.status, error?.code];
  for (const candidate of candidates) {
    const status = Number(candidate);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  const match = String(error?.message || error || '').match(/\b(4\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function acknowledgedMessage(state, messageId) {
  const receipt = state.db.prepare('SELECT detail FROM receipts WHERE discord_id=? AND kind=? ORDER BY id DESC LIMIT 1')
    .get(messageId, ACK.RECEIVED);
  let identity;
  try { identity = receipt && (typeof receipt.detail === 'string' ? JSON.parse(receipt.detail) : receipt.detail); } catch { identity = null; }
  const message = state.getMessage(messageId);
  if (!message || !identity || message.provider !== identity.provider || message.nativeId !== identity.nativeId ||
    message.generation !== identity.generation) throw new Error('native acknowledgment owner or generation is stale');
  return message;
}

function watchAcknowledgments({ state, send, logger = () => {}, watchFactory = fs.watch, rearmMs = 1000 }) {
  let closed = false;
  let timer = null;
  let running = null;
  let dirty = false;
  const outcome = (id, result, detail = {}) => state.transaction(() => state.receipt(id, ACK.OUTCOME, { outcome: result, ...detail }));
  async function drain() {
    if (closed) return;
    if (running) { dirty = true; return running; }
    running = (async () => {
      for (const id of pendingAcknowledgments(state)) {
        if (closed) return;
        let message;
        try { message = acknowledgedMessage(state, id); }
        catch { outcome(id, ACK_OUTCOMES.STALE); continue; }
        try {
          await send(message, REACTION.ACKNOWLEDGED);
          outcome(id, ACK_OUTCOMES.SENT, { reaction: REACTION.ACKNOWLEDGED, targetMessageId: id });
        } catch (error) {
          const status = acknowledgmentFailureStatus(error);
          const detail = { error: String(error.message || error).slice(0, 200) };
          if (status !== null) detail.status = status;
          if (status !== null && status >= 400 && status < 500 && status !== 429) {
            outcome(id, ACK_OUTCOMES.FAILED, detail);
            continue;
          }
          const attempts = unknownAcknowledgmentAttempts(state, id);
          const retryDelay = Math.min(ACK_RETRY.BASE_MS * (2 ** attempts), ACK_RETRY.MAX_MS);
          outcome(id, ACK_OUTCOMES.UNKNOWN, {
            ...detail,
            attempt: attempts + 1,
            retryAt: Date.now() + retryDelay,
          });
        }
      }
    })().catch(error => logger(`native acknowledgment drain failed: ${error.message}`));
    try { await running; }
    finally {
      running = null;
      if (dirty) { dirty = false; schedule(); }
      else {
        const retryAt = nextAcknowledgmentRetryAt(state);
        if (retryAt !== null) schedule(Math.max(0, retryAt - Date.now()));
      }
    }
  }
  function schedule(delay = 50) {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = null; drain(); }, delay);
  }
  const basename = path.basename(state.dbPath);
  let watcher = null;
  let retry = null;
  let retryDelay = rearmMs;
  function arm() {
    if (closed) return;
    try {
      const next = watchFactory(path.dirname(state.dbPath), (_event, name) => {
        if (!name || String(name).startsWith(basename)) schedule();
      });
      watcher = next;
      retryDelay = rearmMs;
      next.on('error', error => {
        if (watcher !== next) return;
        watcher = null;
        try { next.close(); } catch {}
        logger(`native acknowledgment watch failed: ${error.message}`);
        if (!closed && !retry) {
          retry = setTimeout(() => { retry = null; arm(); }, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 60000);
        }
      });
      schedule();
    } catch (error) {
      logger(`native acknowledgment watch failed: ${error.message}`);
      if (!closed && !retry) {
        retry = setTimeout(() => { retry = null; arm(); }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 60000);
      }
    }
  }
  arm();
  schedule();
  return {
    drain,
    async stop() {
      closed = true;
      watcher?.close();
      watcher = null;
      clearTimeout(retry);
      retry = null;
      clearTimeout(timer);
      timer = null;
      await running;
    }
  };
}

module.exports = { ACK, REACTION, acknowledgmentCommand, pendingAcknowledgments, recordNativeAcknowledgment, watchAcknowledgments };
