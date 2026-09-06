const fs = require('node:fs');
const path = require('node:path');
const { MESSAGE_STATES, validateNativeId } = require('./state');

const ACK = Object.freeze({ RECEIVED: 'native-ack', OUTCOME: 'native-ack-reaction' });
const ACK_OUTCOMES = Object.freeze({ SENT: 'sent', STALE: 'stale', UNKNOWN: 'unknown' });
const REACTION = Object.freeze({ SAVED: '📥', ACKNOWLEDGED: '👀' });

function retryableOutcomePattern(outcome) {
  return `%"outcome":${JSON.stringify(outcome)}%`;
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

function pendingAcknowledgments(state) {
  return state.db.prepare(`SELECT r.discord_id FROM receipts r
    WHERE r.kind=? AND NOT EXISTS
    (SELECT 1 FROM receipts done WHERE done.discord_id=r.discord_id AND done.kind=?
      AND done.detail NOT LIKE ?)
    ORDER BY r.id`).all(ACK.RECEIVED, ACK.OUTCOME,
    retryableOutcomePattern(ACK_OUTCOMES.UNKNOWN)).map(row => row.discord_id);
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
          outcome(id, ACK_OUTCOMES.UNKNOWN, { error: String(error.message || error).slice(0, 200) });
        }
      }
    })().catch(error => logger(`native acknowledgment drain failed: ${error.message}`));
    try { await running; }
    finally {
      running = null;
      if (dirty) { dirty = false; schedule(); }
    }
  }
  function schedule() {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = null; drain(); }, 50);
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
