const crypto = require('node:crypto');
const { REFERENCE_INSTRUCTIONS } = require('./publication/reference');
const { acknowledgmentCommand } = require('./acknowledgment');
const fs = require('node:fs');
const path = require('node:path');
const { ClaudeChannel } = require('./claude-channel');
const { normalizeAttachments } = require('./state');

function replyFileFor(directory, messageId, generation) {
  const key = crypto.createHash('sha256')
    .update(`${messageId}\0${generation}`)
    .digest('hex');
  return path.join(path.resolve(directory), '.claude-monitor-replies', `${key}.txt`);
}

function payloadFileFor(directory, messageId, nativeId, generation, dbPath) {
  const scope = dbPath ? path.resolve(dbPath) : path.resolve(directory);
  const key = crypto.createHash('sha256')
    .update(`${scope}\0${messageId}\0${nativeId}\0${generation}`)
    .digest('hex')
    .slice(0, 32);
  return path.join(path.resolve(directory), '.cm-e', `${key}.json`);
}

function writePayloadFile(payloadPath, payload) {
  const directory = path.dirname(payloadPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077)) throw new Error('Claude Monitor payload directory must be owner-only');
  try {
    const existing = fs.lstatSync(payloadPath);
    if (!existing.isFile() || (existing.mode & 0o077)) throw new Error('Claude Monitor payload path is not an owner-only file');
    if (fs.readFileSync(payloadPath, 'utf8') !== payload) throw new Error('Claude Monitor payload identity collision');
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${payloadPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, payload, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, payloadPath);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
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
  const attachments = normalizeAttachments(event.params.attachments);
  if (typeof content !== 'string' || !meta || typeof meta !== 'object') throw new Error('invalid Claude Monitor event');
  const messageId = meta.messageId;
  const nativeId = meta.nativeId;
  const generation = Number(meta.generation);
  if (typeof messageId !== 'string' || !messageId || typeof nativeId !== 'string' || !nativeId || !Number.isInteger(generation) || generation < 1) {
    throw new Error('invalid Claude Monitor event metadata');
  }
  return { content, messageId, nativeId, generation, attachments };
}

function monitorEvent({ content, messageId, nativeId, generation, attachments = [], publicationReference, stateDir, dbPath, cliPath, textFile }) {
  const event = {
    type: 'discord-surface/claude-monitor',
    content,
    meta: { messageId, nativeId, generation: String(generation) },
    instructions: 'At pickup run acknowledgment.command once with argument boundaries preserved. Then create reply.directory owner-only if needed, write the final answer to reply.textFile, and run reply.command. Acknowledgment means received, not completed.',
    acknowledgment: { command: acknowledgmentCommand({ id: messageId, nativeId, generation, provider: 'claude' }, dbPath, cliPath) },
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
  if (attachments.length) event.attachments = attachments;
  if (publicationReference) {
    event.publicationReference = publicationReference;
    event.instructions += ' ' + REFERENCE_INSTRUCTIONS;
  }
  return event;
}

function monitorPointer({ messageId, nativeId, generation, payloadPath }) {
  return {
    type: 'discord-surface/claude-monitor',
    payloadPath: path.resolve(payloadPath),
    meta: { messageId, nativeId, generation: String(generation) },
    instructions: 'Read payloadPath with Read. Run acknowledgment.command, then answer through reply.command.'
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
      const payloadPath = payloadFileFor(stateDir, values.messageId, values.nativeId, values.generation, dbPath);
      const operation = (async () => {
        const payload = monitorEvent({
          ...values,
          content: message.content,
          attachments: message.attachments,
          publicationReference: message.publicationReference,
          stateDir: path.resolve(stateDir),
          dbPath: path.resolve(dbPath),
          cliPath: path.resolve(cliPath),
          textFile
        });
        writePayloadFile(payloadPath, JSON.stringify(payload));
        try { await writeStdoutLine(stdout, JSON.stringify(monitorPointer({ ...values, payloadPath }))); }
        catch (error) {
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
  monitorPointer,
  payloadFileFor,
  replyFileFor,
  writePayloadFile,
  writeStdoutLine
};
