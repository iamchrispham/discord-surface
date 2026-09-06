const crypto = require('node:crypto');
const path = require('node:path');
const { ClaudeChannel } = require('./claude-channel');

function replyFileFor(directory, messageId, generation) {
  const key = crypto.createHash('sha256')
    .update(`${messageId}\0${generation}`)
    .digest('hex');
  return path.join(path.resolve(directory), '.claude-monitor-replies', `${key}.txt`);
}

function writeStdoutLine(stdout, line) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      stdout.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onError = error => finish(error);
    stdout.once('error', onError);
    try {
      stdout.write(`${line}\n`, error => finish(error || null));
    } catch (error) {
      finish(error);
    }
  });
}

function eventValues(event) {
  if (!event || event.method !== 'notifications/claude/channel' || !event.params || typeof event.params !== 'object') {
    throw new Error('invalid Claude Monitor event');
  }
  const content = event.params.content;
  const meta = event.params.meta;
  if (typeof content !== 'string' || !meta || typeof meta !== 'object') throw new Error('invalid Claude Monitor event');
  const messageId = meta.messageId;
  const nativeId = meta.nativeId;
  const generation = Number(meta.generation);
  if (typeof messageId !== 'string' || !messageId || typeof nativeId !== 'string' || !nativeId || !Number.isInteger(generation) || generation < 1) {
    throw new Error('invalid Claude Monitor event metadata');
  }
  return { content, messageId, nativeId, generation };
}

function monitorEvent({ content, messageId, nativeId, generation, stateDir, dbPath, cliPath, textFile }) {
  return {
    type: 'discord-surface/claude-monitor',
    content,
    meta: { messageId, nativeId, generation: String(generation) },
    instructions: 'Create reply.directory owner-only if needed. Write final answer to reply.textFile, then run every argument in reply.command.',
    reply: {
      messageId,
      nativeId,
      generation,
      directory: path.dirname(textFile),
      textFile,
      command: [
        process.execPath,
        cliPath,
        'claude-reply',
        '--state-dir',
        stateDir,
        '--db',
        dbPath,
        '--message-id',
        messageId,
        '--native-id',
        nativeId,
        '--generation',
        String(generation),
        '--text-file',
        textFile
      ]
    }
  };
}

function createMonitorMcp({ state, stateDir, dbPath = path.join(path.resolve(stateDir || '.'), 'surface.sqlite'), stdout = process.stdout, cliPath = path.join(__dirname, 'cli.js') } = {}) {
  if (!state) throw new TypeError('state is required');
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir is required');
  if (!stdout || typeof stdout.write !== 'function') throw new TypeError('stdout must be writable');
  const entries = new Map();
  let closed = false;

  return {
    async notification(event) {
      if (closed) throw new Error('Claude Monitor transport is closed');
      const values = eventValues(event);
      const key = `${values.messageId}\0${values.nativeId}\0${values.generation}`;
      const existing = entries.get(key);
      if (existing) return existing;
      const message = state.getMessage(values.messageId);
      if (!message || message.provider !== 'claude' || message.nativeId !== values.nativeId || message.generation !== values.generation) {
        throw new Error('Claude Monitor event has no accepted custody');
      }
      const textFile = replyFileFor(stateDir, values.messageId, values.generation);
      const operation = (async () => {
        try {
          await writeStdoutLine(stdout, JSON.stringify(monitorEvent({
            ...values,
            content: message.content,
            stateDir: path.resolve(stateDir),
            dbPath: path.resolve(dbPath),
            cliPath: path.resolve(cliPath),
            textFile
          })));
        } catch (error) {
          error.potentiallyDelivered = true;
          throw error;
        }
      })();
      entries.set(key, operation);
      return operation;
    },
    async close() {
      if (closed) return;
      closed = true;
    }
  };
}

function createClaudeMonitor(options) {
  const mcp = createMonitorMcp(options);
  return new ClaudeChannel({ ...options, mcp });
}

module.exports = {
  createClaudeMonitor,
  createMonitorMcp,
  eventValues,
  monitorEvent,
  replyFileFor,
  writeStdoutLine
};
