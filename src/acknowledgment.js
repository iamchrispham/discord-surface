const fs = require('node:fs');
const path = require('node:path');
const { MESSAGE_STATES, validateNativeId } = require('./state');

const ACK = Object.freeze({ RECEIVED: 'native-ack', OUTCOME: 'native-ack-reaction' });
const REACTION = Object.freeze({ SAVED: '📥', ACKNOWLEDGED: '👀' });

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
      MESSAGE_STATES.REPLIED].includes(message.state)) {
      throw new Error(`native acknowledgment is not accepted in state ${message.state}`);
    }
    state.receipt(messageId, ACK.RECEIVED, { provider, nativeId, generation });
    return { recorded: true, duplicate: false, messageId };
  });
}

function pendingAcknowledgments(state) {
  return state.db.prepare(`SELECT r.discord_id FROM receipts r
    WHERE r.kind=? AND NOT EXISTS
    (SELECT 1 FROM receipts done WHERE done.discord_id=r.discord_id AND done.kind=?)
    ORDER BY r.id`).all(ACK.RECEIVED, ACK.OUTCOME).map(row => row.discord_id);
}

function watchAcknowledgments({ state, send, logger = () => {} }) {
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
        try { message = state.assertMessageCurrent(id, 'native-ack-reaction'); }
        catch { outcome(id, 'stale'); continue; }
        try {
          await send(message, REACTION.ACKNOWLEDGED);
          outcome(id, 'sent', { reaction: REACTION.ACKNOWLEDGED, targetMessageId: id });
        } catch (error) {
          outcome(id, 'unknown', { error: String(error.message || error).slice(0, 200) });
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
  const watcher = fs.watch(path.dirname(state.dbPath), (_event, name) => {
    if (!name || String(name).startsWith(basename)) schedule();
  });
  watcher.on('error', error => logger(`native acknowledgment watch failed: ${error.message}`));
  schedule();
  return {
    drain,
    async stop() {
      closed = true;
      watcher.close();
      clearTimeout(timer);
      timer = null;
      await running;
    }
  };
}

module.exports = { ACK, REACTION, acknowledgmentCommand, pendingAcknowledgments, recordNativeAcknowledgment, watchAcknowledgments };
