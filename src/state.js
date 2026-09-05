const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = '1.2';
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
const REPLY_LIMIT = 2000;

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

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function now() {
  return new Date().toISOString();
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

function discordNonce(messageId, partIndex = 0) {
  const digest = crypto.createHash('sha256').update(`${messageId}:${partIndex}`).digest('base64url');
  return `ds-${digest.slice(0, 21)}`;
}

function splitReply(text) {
  const parts = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + REPLY_LIMIT);
    if (end < text.length && end > offset && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
    parts.push(text.slice(offset, end));
    offset = end;
  }
  return parts.length ? parts : [''];
}

function rowReplyPart(row) {
  return {
    index: Number(row.part_index),
    content: row.content,
    nonce: row.nonce,
    state: row.state,
    messageId: row.message_id,
    error: row.error,
    updatedAt: row.updated_at
  };
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
    replyNextPart: Number(row.reply_next_part || 0),
    observerCursor: parseJson(row.observer_cursor, null),
    observerMarker: row.observer_marker,
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
    categoryId: row.category_id || null,
    generation: Number(row.generation),
    active: Number(row.active) !== 0,
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
      if (existed) {
        this.migrateSchema();
        this.assertSchema();
      } else {
        this.createSchema();
      }
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
      INSERT OR IGNORE INTO meta(key, value) VALUES ('schema', '${SCHEMA_VERSION}');
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
        category_id TEXT,
        generation INTEGER NOT NULL CHECK(generation > 0),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS bindings_native_id_unique ON bindings(provider, native_id) WHERE active=1;
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
        reply_next_part INTEGER NOT NULL DEFAULT 0,
        observer_cursor TEXT,
        observer_marker TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_state_idx ON messages(state);
      CREATE TABLE IF NOT EXISTS reply_parts (
        discord_id TEXT NOT NULL REFERENCES messages(discord_id),
        part_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        nonce TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
        message_id TEXT,
        error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(discord_id, part_index)
      );
      CREATE TABLE IF NOT EXISTS provision_intents (
        provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
        native_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        category_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        endpoint TEXT,
        marker TEXT NOT NULL,
        task_name TEXT,
        channel_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('pending', 'resolved')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(provider, native_id)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_id TEXT REFERENCES messages(discord_id),
        kind TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  tableColumns(table) {
    return new Map(this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => [row.name, row]));
  }

  migrateSchema() {
    const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get();
    if (!version) throw new StateCorruptError('state schema metadata is missing');
    if (version.value === SCHEMA_VERSION) return;
    if (version.value !== '1.1') throw new StateCorruptError(`unsupported state schema ${version.value}`);
    const bindings = this.tableColumns('bindings');
    const messages = this.tableColumns('messages');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!bindings.has('category_id')) this.db.exec('ALTER TABLE bindings ADD COLUMN category_id TEXT');
      if (!bindings.has('active')) this.db.exec('ALTER TABLE bindings ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
      if (!messages.has('reply_next_part')) this.db.exec('ALTER TABLE messages ADD COLUMN reply_next_part INTEGER NOT NULL DEFAULT 0');
      if (!messages.has('observer_cursor')) this.db.exec('ALTER TABLE messages ADD COLUMN observer_cursor TEXT');
      if (!messages.has('observer_marker')) this.db.exec('ALTER TABLE messages ADD COLUMN observer_marker TEXT');
      this.db.exec(`
        DROP INDEX IF EXISTS bindings_native_id_unique;
        CREATE UNIQUE INDEX IF NOT EXISTS bindings_native_id_unique ON bindings(provider, native_id) WHERE active=1;
        CREATE TABLE IF NOT EXISTS reply_parts (
          discord_id TEXT NOT NULL REFERENCES messages(discord_id),
          part_index INTEGER NOT NULL,
          content TEXT NOT NULL,
          nonce TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK(state IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
          message_id TEXT,
          error TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(discord_id, part_index)
        );
        CREATE TABLE IF NOT EXISTS provision_intents (
          provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
          native_id TEXT NOT NULL,
          guild_id TEXT NOT NULL,
          category_id TEXT NOT NULL,
          workspace TEXT NOT NULL,
          endpoint TEXT,
          marker TEXT NOT NULL,
          task_name TEXT,
          channel_id TEXT,
          state TEXT NOT NULL CHECK(state IN ('pending', 'resolved')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(provider, native_id)
        );
        UPDATE meta SET value='${SCHEMA_VERSION}' WHERE key='schema';
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  assertColumns(table, required) {
    const columns = this.tableColumns(table);
    for (const [name, rule] of Object.entries(required)) {
      const row = columns.get(name);
      if (!row) throw new StateCorruptError(`state table ${table} is missing column ${name}`);
      if (rule.type && String(row.type).toUpperCase() !== rule.type) throw new StateCorruptError(`state table ${table}.${name} has wrong type`);
      if (rule.notnull && row.notnull !== 1) throw new StateCorruptError(`state table ${table}.${name} must be NOT NULL`);
    }
  }

  assertForeignKey(table, from, target, to) {
    const found = this.db.prepare(`PRAGMA foreign_key_list(${table})`).all()
      .some(row => row.from === from && row.table === target && row.to === to);
    if (!found) throw new StateCorruptError(`state foreign key ${table}.${from} -> ${target}.${to} is missing`);
  }

  assertSchema() {
    const expected = ['meta', 'config', 'bindings', 'messages', 'reply_parts', 'provision_intents', 'receipts'];
    const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const found = new Set(rows.map(row => row.name));
    if (expected.some(name => !found.has(name))) throw new StateCorruptError('state schema is incomplete');
    const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get();
    if (!version || version.value !== SCHEMA_VERSION) throw new StateCorruptError('unsupported state schema');
    this.assertColumns('meta', { key: { type: 'TEXT' }, value: { type: 'TEXT', notnull: true } });
    this.assertColumns('config', { key: { type: 'TEXT' }, value: { type: 'TEXT', notnull: true } });
    this.assertColumns('bindings', {
      channel_id: { type: 'TEXT' }, guild_id: { type: 'TEXT', notnull: true },
      provider: { type: 'TEXT', notnull: true }, native_id: { type: 'TEXT', notnull: true },
      workspace: { type: 'TEXT', notnull: true }, generation: { type: 'INTEGER', notnull: true },
      active: { type: 'INTEGER', notnull: true }, updated_at: { type: 'TEXT', notnull: true }
    });
    this.assertColumns('messages', {
      discord_id: { type: 'TEXT' }, guild_id: { type: 'TEXT', notnull: true },
      channel_id: { type: 'TEXT', notnull: true }, author_id: { type: 'TEXT', notnull: true },
      content: { type: 'TEXT', notnull: true }, state: { type: 'TEXT', notnull: true },
      reply_next_part: { type: 'INTEGER', notnull: true }, created_at: { type: 'TEXT', notnull: true },
      updated_at: { type: 'TEXT', notnull: true }
    });
    this.assertColumns('reply_parts', {
      discord_id: { type: 'TEXT', notnull: true }, part_index: { type: 'INTEGER', notnull: true },
      content: { type: 'TEXT', notnull: true }, nonce: { type: 'TEXT', notnull: true },
      state: { type: 'TEXT', notnull: true }, updated_at: { type: 'TEXT', notnull: true }
    });
    this.assertColumns('provision_intents', {
      provider: { type: 'TEXT', notnull: true }, native_id: { type: 'TEXT', notnull: true },
      guild_id: { type: 'TEXT', notnull: true }, category_id: { type: 'TEXT', notnull: true },
      workspace: { type: 'TEXT', notnull: true }, marker: { type: 'TEXT', notnull: true },
      state: { type: 'TEXT', notnull: true }, updated_at: { type: 'TEXT', notnull: true }
    });
    this.assertColumns('receipts', {
      id: { type: 'INTEGER', notnull: false }, kind: { type: 'TEXT', notnull: true },
      detail: { type: 'TEXT', notnull: true }, created_at: { type: 'TEXT', notnull: true }
    });
    this.assertForeignKey('messages', 'channel_id', 'bindings', 'channel_id');
    this.assertForeignKey('reply_parts', 'discord_id', 'messages', 'discord_id');
    this.assertForeignKey('receipts', 'discord_id', 'messages', 'discord_id');
    const integrity = this.db.prepare('PRAGMA integrity_check').all();
    if (integrity.some(row => Object.values(row)[0] !== 'ok')) throw new StateCorruptError('state integrity check failed');
    if (this.db.prepare('PRAGMA foreign_key_check').all().length) throw new StateCorruptError('state foreign key check failed');
    const index = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='bindings_native_id_unique'").get();
    if (!index?.sql || !/\(provider\s*,\s*native_id\)/i.test(index.sql) || !/WHERE\s+active\s*=\s*1/i.test(index.sql)) throw new StateCorruptError('native binding uniqueness guard is missing');
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
    const allowed = ['operatorId', 'guildId', 'secretFile', 'codexCategoryId', 'claudeCategoryId'];
    const current = this.getConfig();
    const merged = { ...current };
    for (const key of allowed) {
      if (values[key] !== undefined) merged[key] = values[key];
      if (merged[key] !== undefined) assertText(merged[key], key, 4096);
    }
    for (const key of ['operatorId', 'guildId', 'secretFile']) {
      if (!merged[key]) throw new BindingError(`surface is not configured: missing ${key}`);
    }
    return this.transaction(() => {
      const stmt = this.db.prepare('INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      for (const [key, value] of Object.entries(merged)) if (allowed.includes(key)) stmt.run(key, value);
      this.receipt(null, 'configured', { guildId: merged.guildId, operatorId: merged.operatorId });
      return merged;
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

  bindingInput(binding, existing = null) {
    const channelId = assertText(binding.channelId, 'channelId', 128);
    const guildId = binding.guildId == null && existing ? existing.guildId : assertText(binding.guildId, 'guildId', 128);
    const provider = assertProvider(binding.provider);
    const nativeId = assertUuid(binding.nativeId);
    const workspace = assertText(binding.workspace, 'workspace', 4096);
    if (!path.isAbsolute(workspace)) throw new BindingError('workspace must be absolute');
    const endpoint = binding.endpoint == null ? null : assertEndpoint(binding.endpoint);
    if (provider === PROVIDERS.CLAUDE && !endpoint) throw new BindingError('Claude bindings require a channel endpoint');
    const categoryId = binding.categoryId == null ? (existing?.categoryId || null) : assertText(binding.categoryId, 'categoryId', 128);
    const config = this.requireConfig();
    if (guildId !== config.guildId) throw new BindingError('binding guild is not the configured guild');
    return { channelId, guildId, provider, nativeId, workspace, endpoint, categoryId };
  }

  bind(binding) {
    const input = this.bindingInput(binding);
    const existing = this.getBinding(input.channelId);
    if (existing) throw new BindingError('channel is already bound; use rebind after work drains');
    this.assertNativeOwnerFree(input.provider, input.nativeId);
    const createdAt = now();
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO bindings(channel_id, guild_id, provider, native_id, workspace, endpoint, category_id, generation, active, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`).run(input.channelId, input.guildId, input.provider, input.nativeId, input.workspace, input.endpoint, input.categoryId, createdAt);
      this.receipt(null, 'bound', { channelId: input.channelId, provider: input.provider, generation: 1 });
      return this.getBinding(input.channelId);
    });
  }

  rebind(binding) {
    const channelId = assertText(binding.channelId, 'channelId', 128);
    const existing = this.getBinding(channelId);
    if (!existing) throw new BindingError('channel is not bound');
    if (this.hasUnresolved(channelId)) throw new UnresolvedWorkError('cannot rebind while work drains');
    const input = this.bindingInput({ ...binding, channelId }, existing);
    this.assertNativeOwnerFree(input.provider, input.nativeId, channelId);
    const generation = existing.generation + 1;
    return this.transaction(() => {
      this.db.prepare(`UPDATE bindings SET guild_id=?, provider=?, native_id=?, workspace=?, endpoint=?, category_id=?, generation=?, active=1, updated_at=? WHERE channel_id=?`)
        .run(input.guildId, input.provider, input.nativeId, input.workspace, input.endpoint, input.categoryId, generation, now(), channelId);
      this.receipt(null, 'rebound', { channelId, generation });
      return this.getBinding(channelId);
    });
  }

  unbind(channelId) {
    assertText(channelId, 'channelId', 128);
    const binding = this.getBinding(channelId);
    if (!binding) throw new BindingError('channel is not bound');
    if (!binding.active) return true;
    if (this.hasUnresolved(channelId)) throw new UnresolvedWorkError('cannot unbind while work is unresolved');
    return this.transaction(() => {
      this.db.prepare('UPDATE bindings SET active=0, updated_at=? WHERE channel_id=?').run(now(), channelId);
      this.receipt(null, 'unbound', { channelId, generation: binding.generation });
      return true;
    });
  }

  getBinding(channelId) {
    return rowBinding(this.db.prepare('SELECT * FROM bindings WHERE channel_id=?').get(channelId));
  }

  listBindings() {
    return this.db.prepare('SELECT * FROM bindings ORDER BY channel_id').all().map(rowBinding);
  }

  findNativeBinding(nativeId, provider = null) {
    assertUuid(nativeId);
    if (provider) assertProvider(provider);
    const row = provider
      ? this.db.prepare('SELECT * FROM bindings WHERE native_id=? AND provider=? ORDER BY active DESC, generation DESC LIMIT 1').get(nativeId, provider)
      : this.db.prepare('SELECT * FROM bindings WHERE native_id=? ORDER BY active DESC, generation DESC LIMIT 1').get(nativeId);
    return rowBinding(row);
  }

  assertNativeOwnerFree(provider, nativeId, channelId = null) {
    const row = this.db.prepare('SELECT channel_id, provider FROM bindings WHERE provider=? AND native_id=? AND active=1').get(provider, nativeId);
    if (row && row.channel_id !== channelId) throw new BindingError('native session is already owned by another channel for this provider');
  }

  hasUnresolved(channelId) {
    const states = [...ACTIVE_STATES];
    const row = this.db.prepare(`SELECT 1 FROM messages WHERE channel_id=? AND state IN (${states.map(() => '?').join(',')}) LIMIT 1`)
      .get(channelId, ...states);
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
    if (!binding || !binding.active || binding.guildId !== event.guildId) return this.reject('unknown-binding');
    const duplicate = this.getMessage(event.id);
    if (duplicate) return { accepted: false, duplicate: true, reason: 'duplicate-message', message: duplicate };
    return this.transaction(() => {
      const committed = this.getMessage(event.id);
      if (committed) return { accepted: false, duplicate: true, reason: 'duplicate-message', message: committed };
      if (this.failNextIntakeFlag) {
        this.failNextIntakeFlag = false;
        throw new Error('injected intake transaction failure');
      }
      const timestamp = now();
      this.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, author_id, content, provider, native_id, workspace, endpoint, generation, state, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        event.id, event.guildId, event.channelId, event.authorId, event.content, binding.provider, binding.nativeId,
        binding.workspace, binding.endpoint, binding.generation, MESSAGE_STATES.ACCEPTED, timestamp, timestamp
      );
      this.receipt(event.id, 'accepted', { channelId: event.channelId, generation: binding.generation });
      return { accepted: true, message: this.getMessage(event.id) };
    });
  }

  currentMessageBinding(message) {
    const config = this.requireConfig();
    const binding = this.getBinding(message.channelId);
    const identity = Boolean(binding && binding.active && binding.guildId === message.guildId &&
      binding.generation === message.generation && binding.nativeId === message.nativeId && binding.provider === message.provider);
    const current = Boolean(identity && binding.guildId === config.guildId &&
      message.guildId === config.guildId && message.authorId === config.operatorId &&
      binding.generation === message.generation && binding.nativeId === message.nativeId && binding.provider === message.provider);
    return { config, binding, identity, current };
  }

  assertMessageCurrent(messageId, phase) {
    try {
      return this.transaction(() => {
        const message = this.getMessage(messageId);
        if (!message) throw new BindingError('message is unknown');
        const check = this.currentMessageBinding(message);
        if (!check.identity) throw new StaleGenerationError('message binding generation is stale');
        if (!check.current) throw new AuthorizationError(`message authorization is no longer valid at ${phase}`);
        return message;
      });
    } catch (error) {
      if (error instanceof AuthorizationError) this.auditReceipt(messageId, `${phase}-rejected-auth`, {});
      if (error instanceof StaleGenerationError) this.auditReceipt(messageId, `${phase}-stale`, {});
      throw error;
    }
  }

  claimDispatch(messageId) {
    try {
      return this.transaction(() => {
        const message = this.getMessage(messageId);
        if (!message) throw new BindingError('message is unknown');
        if (message.state !== MESSAGE_STATES.ACCEPTED) return { claimed: false, message };
        const check = this.currentMessageBinding(message);
        if (!check.identity) throw new StaleGenerationError('message binding generation is stale');
        if (!check.current) {
          this.receipt(messageId, 'dispatch-rejected-auth', { generation: message.generation });
          return { claimed: false, message, reason: 'authorization-revoked' };
        }
        this.db.prepare('UPDATE messages SET state=?, updated_at=? WHERE discord_id=? AND state=?')
          .run(MESSAGE_STATES.DISPATCHING, now(), messageId, MESSAGE_STATES.ACCEPTED);
        this.receipt(messageId, 'dispatching', { generation: message.generation });
        return { claimed: true, message: this.getMessage(messageId) };
      });
    } catch (error) {
      if (error instanceof StaleGenerationError) this.auditReceipt(messageId, 'dispatch-stale', {});
      throw error;
    }
  }

  markSubmitted(messageId, cursor = null, marker = null) {
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new BindingError('message is unknown');
      if (message.state !== MESSAGE_STATES.DISPATCHING) return message;
      this.db.prepare('UPDATE messages SET state=?, observer_cursor=?, observer_marker=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
        .run(MESSAGE_STATES.SUBMITTED, cursor ? safeDetail(cursor) : null, marker, now(), messageId, MESSAGE_STATES.DISPATCHING);
      this.receipt(messageId, 'submitted', { marker: marker || undefined });
      return this.getMessage(messageId);
    });
  }

  setObserverCursor(messageId, cursor, marker = null) {
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message || message.state !== MESSAGE_STATES.SUBMITTED) return message;
      this.db.prepare('UPDATE messages SET observer_cursor=?, observer_marker=COALESCE(?, observer_marker), updated_at=? WHERE discord_id=?')
        .run(safeDetail(cursor), marker, now(), messageId);
      return this.getMessage(messageId);
    });
  }

  markObservationUnavailable(messageId, detail) {
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message || ![MESSAGE_STATES.ACCEPTED, MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLY_READY].includes(message.state)) return message;
      const error = String(detail?.message || detail || 'native observation unavailable').slice(0, 1000);
      this.db.prepare('UPDATE messages SET error=?, updated_at=? WHERE discord_id=?').run(error, now(), messageId);
      this.receipt(messageId, 'recovery-unavailable', { error: error.slice(0, 200) });
      return this.getMessage(messageId);
    });
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
    try {
      return this.transaction(() => {
        const message = this.getMessage(messageId);
        if (!message) throw new StaleGenerationError('native reply is stale');
        const check = this.currentMessageBinding(message);
        if (!check.binding || message.nativeId !== nativeId || message.generation !== generation ||
          check.binding.nativeId !== nativeId || check.binding.generation !== generation || check.binding.provider !== message.provider) {
          throw new StaleGenerationError('native reply is stale');
        }
        if (!check.current) throw new AuthorizationError('native reply authorization is no longer valid');
        if (message.state === MESSAGE_STATES.REPLY_READY || message.state === MESSAGE_STATES.REPLIED) return { duplicate: true, message };
        if (![MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.DISPATCHING].includes(message.state)) throw new BindingError(`reply is not accepted in state ${message.state}`);
        const timestamp = now();
        const parts = splitReply(text);
        this.db.prepare('UPDATE messages SET state=?, reply_text=?, reply_nonce=?, reply_next_part=0, updated_at=? WHERE discord_id=? AND state=?')
          .run(MESSAGE_STATES.REPLY_READY, text, discordNonce(messageId, 0), timestamp, messageId, message.state);
        this.db.prepare('DELETE FROM reply_parts WHERE discord_id=?').run(messageId);
        const insert = this.db.prepare('INSERT INTO reply_parts(discord_id, part_index, content, nonce, state, updated_at) VALUES(?, ?, ?, ?, ?, ?)');
        parts.forEach((part, index) => insert.run(messageId, index, part, discordNonce(messageId, index), 'pending', timestamp));
        this.receipt(messageId, message.state === MESSAGE_STATES.DISPATCHING ? 'native-reply-before-submit' : 'native-reply', { generation, parts: parts.length });
        return { duplicate: false, message: this.getMessage(messageId) };
      });
    } catch (error) {
      if (error instanceof AuthorizationError) this.auditReceipt(messageId, 'reply-rejected-auth', { generation });
      if (error instanceof StaleGenerationError) this.auditReceipt(messageId, 'reply-stale', { generation });
      throw error;
    }
  }

  listReplyParts(messageId) {
    return this.db.prepare('SELECT * FROM reply_parts WHERE discord_id=? ORDER BY part_index').all(messageId).map(rowReplyPart);
  }

  beginReply(messageId) {
    try {
      return this.transaction(() => {
        const message = this.getMessage(messageId);
        if (!message) throw new BindingError('message is unknown');
        if (message.state === MESSAGE_STATES.REPLIED) return { sent: true, message };
        if (message.state !== MESSAGE_STATES.REPLY_READY) throw new BindingError(`reply is not ready in state ${message.state}`);
        const check = this.currentMessageBinding(message);
        if (!check.identity) throw new StaleGenerationError('message binding generation is stale');
        if (!check.current) throw new AuthorizationError('reply authorization is no longer valid');
        this.db.prepare('UPDATE messages SET state=?, updated_at=? WHERE discord_id=? AND state=?')
          .run(MESSAGE_STATES.REPLYING, now(), messageId, MESSAGE_STATES.REPLY_READY);
        this.db.prepare("UPDATE reply_parts SET state='sending', updated_at=? WHERE discord_id=? AND state='pending'").run(now(), messageId);
        this.receipt(messageId, 'reply-attempt', { nonce: message.replyNonce });
        return { sent: false, message: this.getMessage(messageId) };
      });
    } catch (error) {
      if (error instanceof AuthorizationError) this.auditReceipt(messageId, 'reply-rejected-auth', {});
      if (error instanceof StaleGenerationError) this.auditReceipt(messageId, 'reply-stale', {});
      throw error;
    }
  }

  markReplyPartSent(messageId, partIndex, replyMessageId) {
    assertText(replyMessageId, 'replyMessageId', 128);
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new BindingError('message is unknown');
      if (message.state === MESSAGE_STATES.REPLIED) return message;
      if (message.state !== MESSAGE_STATES.REPLYING) throw new BindingError(`reply is not in flight in state ${message.state}`);
      const part = this.db.prepare('SELECT * FROM reply_parts WHERE discord_id=? AND part_index=?').get(messageId, partIndex);
      if (!part) throw new BindingError('reply part is unknown');
      if (part.state === 'sent') return message;
      this.db.prepare("UPDATE reply_parts SET state='sent', message_id=?, error=NULL, updated_at=? WHERE discord_id=? AND part_index=?").run(replyMessageId, now(), messageId, partIndex);
      const remaining = this.db.prepare("SELECT COUNT(*) AS count FROM reply_parts WHERE discord_id=? AND state<>'sent'").get(messageId).count;
      if (Number(remaining) === 0) {
        this.db.prepare('UPDATE messages SET state=?, reply_message_id=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
          .run(MESSAGE_STATES.REPLIED, replyMessageId, now(), messageId, MESSAGE_STATES.REPLYING);
        this.receipt(messageId, 'reply-sent', { replyMessageId });
      } else {
        this.db.prepare('UPDATE messages SET reply_next_part=?, updated_at=? WHERE discord_id=?').run(Number(partIndex) + 1, now(), messageId);
        this.receipt(messageId, 'reply-part-sent', { partIndex, replyMessageId });
      }
      return this.getMessage(messageId);
    });
  }

  markReplySent(messageId, replyMessageId) {
    const parts = this.listReplyParts(messageId);
    if (parts.length > 1) throw new BindingError('multi-part replies must acknowledge each part separately');
    return this.markReplyPartSent(messageId, 0, replyMessageId);
  }

  markReplyFailure(messageId, error, unknown = false, partIndex = null) {
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new BindingError('message is unknown');
      if (![MESSAGE_STATES.REPLYING, MESSAGE_STATES.REPLY_UNKNOWN].includes(message.state)) return message;
      const next = unknown ? MESSAGE_STATES.REPLY_UNKNOWN : MESSAGE_STATES.REPLY_FAILED;
      const text = String(error?.message || error || 'reply failed').slice(0, 1000);
      if (partIndex !== null) this.db.prepare('UPDATE reply_parts SET state=?, error=?, updated_at=? WHERE discord_id=? AND part_index=?').run(unknown ? 'unknown' : 'failed', text, now(), messageId, partIndex);
      this.db.prepare('UPDATE messages SET state=?, error=?, updated_at=? WHERE discord_id=?').run(next, text, now(), messageId);
      this.receipt(messageId, unknown ? 'reply-unknown' : 'reply-failed', { partIndex, error: text.slice(0, 200) });
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
        this.db.prepare("UPDATE reply_parts SET state='unknown', updated_at=? WHERE discord_id=? AND state='sending'").run(now(), row.discord_id);
        this.receipt(row.discord_id, 'reply-unknown-after-restart', {});
      }
      const candidates = this.recoveryCandidates();
      return { dispatching: dispatching.length, replying: replying.length, candidates: candidates.map(row => row.id) };
    });
  }

  recoveryCandidates(before = null) {
    const states = [MESSAGE_STATES.ACCEPTED, MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLY_READY];
    const rows = before
      ? this.db.prepare(`SELECT discord_id FROM messages WHERE state IN (?, ?, ?) AND created_at<=? ORDER BY created_at`).all(...states, before)
      : this.db.prepare(`SELECT discord_id FROM messages WHERE state IN (?, ?, ?) ORDER BY created_at`).all(...states);
    return rows.map(row => this.getMessage(row.discord_id));
  }

  reconcileUncertain(messageId, resolution) {
    if (!['submitted', 'not_submitted'].includes(resolution)) throw new BindingError('resolution must be submitted or not_submitted');
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message || message.state !== MESSAGE_STATES.UNCERTAIN) throw new BindingError('message is not uncertain');
      const next = resolution === 'submitted' ? MESSAGE_STATES.SUBMITTED : MESSAGE_STATES.ACCEPTED;
      this.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
        .run(next, now(), messageId, MESSAGE_STATES.UNCERTAIN);
      this.receipt(messageId, `uncertain-reconciled-${resolution}`, {});
      return this.getMessage(messageId);
    });
  }

  beginProvisionIntent(intent) {
    const provider = assertProvider(intent.provider);
    const nativeId = assertUuid(intent.nativeId);
    for (const key of ['guildId', 'categoryId', 'workspace', 'marker']) assertText(intent[key], key, 4096);
    const endpoint = intent.endpoint == null ? null : assertEndpoint(intent.endpoint);
    const taskName = intent.taskName == null ? null : assertText(intent.taskName, 'taskName', 90);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND native_id=?').get(provider, nativeId);
      if (existing) {
        const same = existing.guild_id === intent.guildId && existing.category_id === intent.categoryId && existing.workspace === intent.workspace && existing.endpoint === endpoint && existing.marker === intent.marker;
        if (!same) throw new BindingError('provision intent does not match the requested identity');
        return existing;
      }
      const timestamp = now();
      this.db.prepare(`INSERT INTO provision_intents(provider, native_id, guild_id, category_id, workspace, endpoint, marker, task_name, state, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(provider, nativeId, intent.guildId, intent.categoryId, intent.workspace, endpoint, intent.marker, taskName, timestamp, timestamp);
      this.receipt(null, 'provision-intent', { provider, nativeId, categoryId: intent.categoryId });
      return this.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND native_id=?').get(provider, nativeId);
    });
  }

  completeProvisionIntent(provider, nativeId, channelId) {
    assertProvider(provider);
    assertUuid(nativeId);
    assertText(channelId, 'channelId', 128);
    return this.transaction(() => {
      const result = this.db.prepare("UPDATE provision_intents SET channel_id=?, state='resolved', updated_at=? WHERE provider=? AND native_id=?").run(channelId, now(), provider, nativeId);
      if (Number(result.changes) !== 1) throw new BindingError('provision intent is unknown');
      this.receipt(null, 'provision-resolved', { provider, nativeId, channelId });
      return this.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND native_id=?').get(provider, nativeId);
    });
  }

  getMessage(messageId) {
    const message = rowMessage(this.db.prepare('SELECT * FROM messages WHERE discord_id=?').get(messageId));
    if (message) message.replyParts = this.listReplyParts(messageId);
    return message;
  }

  listMessages() {
    return this.db.prepare('SELECT discord_id FROM messages ORDER BY created_at').all().map(row => this.getMessage(row.discord_id));
  }

  listReceipts() {
    return this.db.prepare('SELECT * FROM receipts ORDER BY id').all();
  }

  getReadiness() {
    const config = this.getConfig();
    const bindings = this.listBindings();
    const messages = this.listMessages();
    return {
      configured: Boolean(config.operatorId && config.guildId && config.secretFile),
      activeBindings: bindings.filter(binding => binding.active).length,
      inactiveBindings: bindings.filter(binding => !binding.active).length,
      pending: messages.filter(message => [MESSAGE_STATES.ACCEPTED, MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLY_READY].includes(message.state)).length,
      uncertain: messages.filter(message => message.state === MESSAGE_STATES.UNCERTAIN).length,
      execution: bindings.some(binding => binding.active) ? 'unverified-live' : 'unavailable',
      limits: {
        permission: 'unverified-live',
        nativeApproval: 'unverified-live',
        quota: 'unverified-live',
        billing: 'unverified-live',
        connectionBackfill: 'bounded-by-observer-cursor'
      }
    };
  }

  receipt(discordId, kind, detail) {
    this.db.prepare('INSERT INTO receipts(discord_id, kind, detail, created_at) VALUES(?, ?, ?, ?)').run(discordId, kind, safeDetail(detail), now());
  }

  auditReceipt(discordId, kind, detail) {
    try { this.transaction(() => this.receipt(discordId, kind, detail)); } catch {}
  }

  failNextIntake() {
    this.failNextIntakeFlag = true;
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }
}

function validateNativeId(value) {
  return assertUuid(value);
}

module.exports = {
  ACTIVE_STATES,
  AuthorizationError,
  BindingError,
  MESSAGE_STATES,
  PROVIDERS,
  REPLY_LIMIT,
  StaleGenerationError,
  StateCorruptError,
  SurfaceState,
  UnresolvedWorkError,
  UUID,
  discordNonce,
  splitReply,
  validateNativeId
};
