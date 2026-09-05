const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PROVIDERS = Object.freeze({ CODEX: 'codex', CLAUDE: 'claude' });
const MESSAGE_STATES = Object.freeze({
  ACCEPTED: 'accepted',
  DISPATCHING: 'dispatching',
  UNCERTAIN: 'uncertain',
  SUBMITTED: 'submitted',
  REPLY_READY: 'reply_ready',
  REPLYING: 'replying',
  REPLIED: 'replied',
  DISPATCH_FAILED: 'dispatch_failed',
  REPLY_FAILED: 'reply_failed',
  REPLY_UNKNOWN: 'reply_unknown',
  REJECTED: 'rejected'
});

const ACTIVE_STATES = new Set([
  MESSAGE_STATES.ACCEPTED,
  MESSAGE_STATES.DISPATCHING,
  MESSAGE_STATES.UNCERTAIN,
  MESSAGE_STATES.SUBMITTED,
  MESSAGE_STATES.REPLY_READY,
  MESSAGE_STATES.REPLYING,
  MESSAGE_STATES.REPLY_FAILED,
  MESSAGE_STATES.REPLY_UNKNOWN
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class StateCorruptError extends Error {}
class BindingError extends Error {}
class AuthorizationError extends Error {}
class StaleGenerationError extends Error {}
class UnresolvedWorkError extends Error {}

function assertText(value, name, max = 512) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new TypeError(`${name} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function assertUuid(value, name = 'nativeId') {
  assertText(value, name, 80);
  if (!UUID.test(value)) throw new BindingError(`${name} must be an exact UUID`);
  return value;
}

function assertProvider(provider) {
  if (provider !== PROVIDERS.CODEX && provider !== PROVIDERS.CLAUDE) {
    throw new BindingError(`unsupported provider: ${provider}`);
  }
  return provider;
}

function assertEndpoint(value) {
  assertText(value, 'endpoint', 180);
  if (!path.isAbsolute(value) || value.length > 90) throw new BindingError('endpoint must be a short absolute Unix socket path');
  return value;
}

function safeDetail(value) {
  if (value === undefined) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: 'unserializable detail' });
  }
}

function now() {
  return new Date().toISOString();
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

function rowMessage(row) {
  if (!row) return null;
  return {
    id: row.discord_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    authorId: row.author_id,
    content: row.content,
    provider: row.provider,
    nativeId: row.native_id,
    workspace: row.workspace,
    endpoint: row.endpoint,
    generation: Number(row.generation),
    state: row.state,
    replyText: row.reply_text,
    replyNonce: row.reply_nonce,
    replyMessageId: row.reply_message_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowBinding(row) {
  if (!row) return null;
  return {
    channelId: row.channel_id,
    guildId: row.guild_id,
    provider: row.provider,
    nativeId: row.native_id,
    workspace: row.workspace,
    endpoint: row.endpoint,
    generation: Number(row.generation),
    updatedAt: row.updated_at
  };
}

class SurfaceState {
  constructor(dbPath, options = {}) {
    if (!path.isAbsolute(dbPath)) throw new TypeError('dbPath must be absolute');
    ensurePrivateDir(path.dirname(dbPath));
    const existed = fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;
    try {
      this.db = new DatabaseSync(dbPath);
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
      if (existed) this.assertSchema();
      else this.createSchema();
      fs.chmodSync(dbPath, 0o600);
    } catch (error) {
      try { this.db?.close(); } catch {}
      throw new StateCorruptError(`state database is not usable: ${error.message}`);
    }
    this.dbPath = dbPath;
    this.failNextIntakeFlag = Boolean(options.failNextIntake);
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta(key, value) VALUES ('schema', '1.1');
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bindings (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
        native_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        endpoint TEXT,
        generation INTEGER NOT NULL CHECK(generation > 0),
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS bindings_native_id_unique ON bindings(native_id);
      CREATE TABLE IF NOT EXISTS messages (
        discord_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL REFERENCES bindings(channel_id),
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        provider TEXT NOT NULL,
        native_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        endpoint TEXT,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL,
        reply_text TEXT,
        reply_nonce TEXT UNIQUE,
        reply_message_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_state_idx ON messages(state);
      CREATE TABLE IF NOT EXISTS receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_id TEXT REFERENCES messages(discord_id),
        kind TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  assertSchema() {
    const expected = ['meta', 'config', 'bindings', 'messages', 'receipts'];
    const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const found = new Set(rows.map(row => row.name));
    if (expected.some(name => !found.has(name))) throw new StateCorruptError('state schema is incomplete');
    const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get();
    if (!version || version.value !== '1.1') throw new StateCorruptError('unsupported state schema');
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  setConfig(values) {
    const allowed = ['operatorId', 'guildId', 'secretFile'];
    for (const key of allowed) assertText(values[key], key, 4096);
    return this.transaction(() => {
      const stmt = this.db.prepare('INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      for (const key of allowed) stmt.run(key, values[key]);
      this.receipt(null, 'configured', { guildId: values.guildId, operatorId: values.operatorId });
      return this.getConfig();
    });
  }

  getConfig() {
    const rows = this.db.prepare('SELECT key, value FROM config').all();
    return Object.fromEntries(rows.map(row => [row.key, row.value]));
  }

  requireConfig() {
    const config = this.getConfig();
    for (const key of ['operatorId', 'guildId', 'secretFile']) {
      if (!config[key]) throw new BindingError(`surface is not configured: missing ${key}`);
    }
    return config;
  }

  bind(binding) {
    const channelId = assertText(binding.channelId, 'channelId', 128);
    const guildId = assertText(binding.guildId, 'guildId', 128);
    const provider = assertProvider(binding.provider);
    const nativeId = assertUuid(binding.nativeId);
    const workspace = assertText(binding.workspace, 'workspace', 4096);
    if (!path.isAbsolute(workspace)) throw new BindingError('workspace must be absolute');
    const endpoint = binding.endpoint == null ? null : assertEndpoint(binding.endpoint);
    if (provider === PROVIDERS.CLAUDE && !endpoint) throw new BindingError('Claude bindings require a channel endpoint');
    const config = this.requireConfig();
    if (guildId !== config.guildId) throw new BindingError('binding guild is not the configured guild');
    const existing = this.getBinding(channelId);
    if (existing) throw new BindingError('channel is already bound; use rebind after work drains');
    this.assertNativeOwnerFree(provider, nativeId);
    const createdAt = now();
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO bindings(channel_id, guild_id, provider, native_id, workspace, endpoint, generation, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, 1, ?)`).run(channelId, guildId, provider, nativeId, workspace, endpoint, createdAt);
      this.receipt(null, 'bound', { channelId, provider, generation: 1 });
      return this.getBinding(channelId);
    });
  }

  rebind(binding) {
    const channelId = assertText(binding.channelId, 'channelId', 128);
    const existing = this.getBinding(channelId);
    if (!existing) throw new BindingError('channel is not bound');
    if (this.hasUnresolved(channelId)) throw new UnresolvedWorkError('cannot rebind while work is unresolved');
    const provider = assertProvider(binding.provider);
    const nativeId = assertUuid(binding.nativeId);
    const workspace = assertText(binding.workspace, 'workspace', 4096);
    if (!path.isAbsolute(workspace)) throw new BindingError('workspace must be absolute');
    const endpoint = binding.endpoint == null ? null : assertEndpoint(binding.endpoint);
    if (provider === PROVIDERS.CLAUDE && !endpoint) throw new BindingError('Claude bindings require a channel endpoint');
    const guildId = binding.guildId == null ? existing.guildId : assertText(binding.guildId, 'guildId', 128);
    const config = this.requireConfig();
    if (guildId !== config.guildId) throw new BindingError('binding guild is not the configured guild');
    this.assertNativeOwnerFree(provider, nativeId, channelId);
    const generation = existing.generation + 1;
    return this.transaction(() => {
      this.db.prepare(`UPDATE bindings SET guild_id=?, provider=?, native_id=?, workspace=?, endpoint=?, generation=?, updated_at=? WHERE channel_id=?`)
        .run(guildId, provider, nativeId, workspace, endpoint, generation, now(), channelId);
      this.receipt(null, 'rebound', { channelId, generation });
      return this.getBinding(channelId);
    });
  }

  unbind(channelId) {
    assertText(channelId, 'channelId', 128);
    if (!this.getBinding(channelId)) throw new BindingError('channel is not bound');
    if (this.hasUnresolved(channelId)) throw new UnresolvedWorkError('cannot unbind while work is unresolved');
    return this.transaction(() => {
      this.db.prepare('DELETE FROM bindings WHERE channel_id=?').run(channelId);
      this.receipt(null, 'unbound', { channelId });
      return true;
    });
  }

  getBinding(channelId) {
    return rowBinding(this.db.prepare('SELECT * FROM bindings WHERE channel_id=?').get(channelId));
  }

  listBindings() {
    return this.db.prepare('SELECT * FROM bindings ORDER BY channel_id').all().map(rowBinding);
  }

  findNativeBinding(nativeId) {
    assertUuid(nativeId);
    return rowBinding(this.db.prepare('SELECT * FROM bindings WHERE native_id=?').get(nativeId));
  }

  assertNativeOwnerFree(provider, nativeId, channelId = null) {
    const row = this.db.prepare('SELECT channel_id, provider FROM bindings WHERE native_id=?').get(nativeId);
    if (row && row.channel_id !== channelId) throw new BindingError('native session is already owned by another channel');
  }

  hasUnresolved(channelId) {
    const row = this.db.prepare(`SELECT 1 FROM messages WHERE channel_id=? AND state IN (${[...ACTIVE_STATES].map(() => '?').join(',')}) LIMIT 1`)
      .get(channelId, ...ACTIVE_STATES);
    return Boolean(row);
  }

  reject(reason) {
    return { accepted: false, reason };
  }

  acceptDiscordMessage(event) {
    const config = this.requireConfig();
    if ([event.id, event.guildId, event.channelId, event.authorId, event.content].some(value => typeof value !== 'string' || value.length === 0)) {
      return this.reject('invalid-event');
    }
    if (event.content.length > 10000) return this.reject('invalid-event');
    if (event.isBot) return this.reject('bot-source');
    if (event.guildId !== config.guildId || event.authorId !== config.operatorId) return this.reject('unauthorized-sender');
    const binding = this.getBinding(event.channelId);
    if (!binding || binding.guildId !== event.guildId) return this.reject('unknown-binding');
    const duplicate = this.getMessage(event.id);
    if (duplicate) return { accepted: false, duplicate: true, reason: 'duplicate-message', message: duplicate };
    return this.transaction(() => {
      if (this.failNextIntakeFlag) {
        this.failNextIntakeFlag = false;
        throw new Error('injected intake transaction failure');
      }
      const timestamp = now();
      this.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, author_id, content, provider, native_id, workspace, endpoint, generation, state, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(event.id, event.guildId, event.channelId, event.authorId, event.content, binding.provider, binding.nativeId, binding.workspace,
          binding.endpoint, binding.generation, MESSAGE_STATES.ACCEPTED, timestamp, timestamp);
      this.receipt(event.id, 'accepted', { channelId: event.channelId, generation: binding.generation });
      return { accepted: true, message: this.getMessage(event.id) };
    });
  }

  claimDispatch(messageId) {
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new BindingError('message is unknown');
      if (message.state !== MESSAGE_STATES.ACCEPTED) return { claimed: false, message };
      const binding = this.getBinding(message.channelId);
      if (!binding || binding.generation !== message.generation || binding.nativeId !== message.nativeId || binding.provider !== message.provider) {
        throw new StaleGenerationError('message binding generation is stale');
      }
      this.db.prepare('UPDATE messages SET state=?, updated_at=? WHERE discord_id=? AND state=?')
        .run(MESSAGE_STATES.DISPATCHING, now(), messageId, MESSAGE_STATES.ACCEPTED);
      this.receipt(messageId, 'dispatching', { generation: message.generation });
      return { claimed: true, message: this.getMessage(messageId) };
    });
  }

  markSubmitted(messageId) {
    return this.transition(messageId, MESSAGE_STATES.DISPATCHING, MESSAGE_STATES.SUBMITTED, 'submitted');
  }

  markUncertain(messageId, error) {
    return this.transition(messageId, MESSAGE_STATES.DISPATCHING, MESSAGE_STATES.UNCERTAIN, 'dispatch-uncertain', error);
  }

  markNotSubmitted(messageId, error) {
    return this.transition(messageId, MESSAGE_STATES.DISPATCHING, MESSAGE_STATES.ACCEPTED, 'dispatch-not-submitted', error);
  }

  transition(messageId, expected, next, kind, error) {
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new BindingError('message is unknown');
      if (message.state !== expected) return message;
      this.db.prepare('UPDATE messages SET state=?, error=?, updated_at=? WHERE discord_id=? AND state=?')
        .run(next, error ? String(error.message || error).slice(0, 1000) : null, now(), messageId, expected);
      this.receipt(messageId, kind, { error: error ? String(error.message || error).slice(0, 200) : undefined });
      return this.getMessage(messageId);
    });
  }

  recordNativeReply({ messageId, nativeId, generation, text }) {
    assertText(messageId, 'messageId', 128);
    assertUuid(nativeId);
    if (!Number.isInteger(generation) || generation < 1) throw new StaleGenerationError('invalid generation');
    assertText(text, 'reply text', 10000);
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      const binding = message && this.getBinding(message.channelId);
      if (!message || !binding || message.nativeId !== nativeId || message.generation !== generation ||
          binding.nativeId !== nativeId || binding.generation !== generation) {
        throw new StaleGenerationError('native reply is stale');
      }
      if (message.state === MESSAGE_STATES.REPLY_READY || message.state === MESSAGE_STATES.REPLIED) {
        return { duplicate: true, message };
      }
      if (message.state !== MESSAGE_STATES.SUBMITTED) throw new BindingError(`reply is not accepted in state ${message.state}`);
      this.db.prepare('UPDATE messages SET state=?, reply_text=?, reply_nonce=?, updated_at=? WHERE discord_id=? AND state=?')
        .run(MESSAGE_STATES.REPLY_READY, text, `discord-surface:${messageId}`, now(), messageId, MESSAGE_STATES.SUBMITTED);
      this.receipt(messageId, 'native-reply', { generation });
      return { duplicate: false, message: this.getMessage(messageId) };
    });
  }

  beginReply(messageId) {
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new BindingError('message is unknown');
      if (message.state === MESSAGE_STATES.REPLIED) return { sent: true, message };
      if (message.state !== MESSAGE_STATES.REPLY_READY) throw new BindingError(`reply is not ready in state ${message.state}`);
      this.db.prepare('UPDATE messages SET state=?, updated_at=? WHERE discord_id=? AND state=?')
        .run(MESSAGE_STATES.REPLYING, now(), messageId, MESSAGE_STATES.REPLY_READY);
      this.receipt(messageId, 'reply-attempt', { nonce: message.replyNonce });
      return { sent: false, message: this.getMessage(messageId) };
    });
  }

  markReplySent(messageId, replyMessageId) {
    assertText(replyMessageId, 'replyMessageId', 128);
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new BindingError('message is unknown');
      if (message.state === MESSAGE_STATES.REPLIED) return message;
      if (message.state !== MESSAGE_STATES.REPLYING) throw new BindingError(`reply is not in flight in state ${message.state}`);
      this.db.prepare('UPDATE messages SET state=?, reply_message_id=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
        .run(MESSAGE_STATES.REPLIED, replyMessageId, now(), messageId, MESSAGE_STATES.REPLYING);
      this.receipt(messageId, 'reply-sent', { replyMessageId });
      return this.getMessage(messageId);
    });
  }

  markReplyFailure(messageId, error, unknown = false) {
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new BindingError('message is unknown');
      if (![MESSAGE_STATES.REPLYING, MESSAGE_STATES.REPLY_UNKNOWN].includes(message.state)) return message;
      const next = unknown ? MESSAGE_STATES.REPLY_UNKNOWN : MESSAGE_STATES.REPLY_FAILED;
      const text = String(error?.message || error || 'reply failed').slice(0, 1000);
      this.db.prepare('UPDATE messages SET state=?, error=?, updated_at=? WHERE discord_id=?').run(next, text, now(), messageId);
      this.receipt(messageId, unknown ? 'reply-unknown' : 'reply-failed', { error: text.slice(0, 200) });
      return this.getMessage(messageId);
    });
  }

  recoverAfterRestart() {
    return this.transaction(() => {
      const dispatching = this.db.prepare('SELECT discord_id FROM messages WHERE state=?').all(MESSAGE_STATES.DISPATCHING);
      for (const row of dispatching) {
        this.db.prepare('UPDATE messages SET state=?, error=?, updated_at=? WHERE discord_id=?')
          .run(MESSAGE_STATES.UNCERTAIN, 'process stopped at dispatch boundary', now(), row.discord_id);
        this.receipt(row.discord_id, 'dispatch-uncertain-after-restart', {});
      }
      const replying = this.db.prepare('SELECT discord_id FROM messages WHERE state=?').all(MESSAGE_STATES.REPLYING);
      for (const row of replying) {
        this.db.prepare('UPDATE messages SET state=?, error=?, updated_at=? WHERE discord_id=?')
          .run(MESSAGE_STATES.REPLY_UNKNOWN, 'process stopped during reply delivery', now(), row.discord_id);
        this.receipt(row.discord_id, 'reply-unknown-after-restart', {});
      }
      return { dispatching: dispatching.length, replying: replying.length };
    });
  }

  getMessage(messageId) {
    return rowMessage(this.db.prepare('SELECT * FROM messages WHERE discord_id=?').get(messageId));
  }

  listMessages() {
    return this.db.prepare('SELECT * FROM messages ORDER BY created_at').all().map(rowMessage);
  }

  listReceipts() {
    return this.db.prepare('SELECT * FROM receipts ORDER BY id').all();
  }

  receipt(discordId, kind, detail) {
    this.db.prepare('INSERT INTO receipts(discord_id, kind, detail, created_at) VALUES(?, ?, ?, ?)')
      .run(discordId, kind, safeDetail(detail), now());
  }

  failNextIntake() {
    this.failNextIntakeFlag = true;
  }

  close() {
    this.db?.close();
    this.db = null;
  }
}

function validateNativeId(value) {
  return assertUuid(value);
}

module.exports = {
  ACTIVE_STATES,
  BindingError,
  AuthorizationError,
  MESSAGE_STATES,
  PROVIDERS,
  StaleGenerationError,
  StateCorruptError,
  SurfaceState,
  UnresolvedWorkError,
  UUID,
  validateNativeId
};
