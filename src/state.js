const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = '1.3';
const PROVIDERS = Object.freeze({ CODEX: 'codex', CLAUDE: 'claude' });
const READINESS = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  UNAVAILABLE: 'unavailable',
  RECOVERING: 'recovering',
  GAP: 'gap'
});
const RECOVERY_LIMITS = Object.freeze({ pageSize: 100, maxPages: 10, maxMessages: 1000, timeoutMs: 30000 });
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

function assertConductorId(value) {
  return assertText(value, 'conductorId', 256);
}

function assertRepoKey(value) {
  assertText(value, 'repoKey', 1024);
  if (path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) throw new BindingError('repoKey must be a canonical repository identity, not a local path');
  return value;
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

function compareDiscordIds(left, right) {
  if (!left) return 1;
  try {
    const a = BigInt(left);
    const b = BigInt(right);
    return a === b ? 0 : a > b ? 1 : -1;
  } catch {
    return String(left).localeCompare(String(right));
  }
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
    conductorId: row.conductor_id || null,
    repoKey: row.repo_key || null,
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
    conductorId: row.conductor_id || null,
    repoKey: row.repo_key || null,
    readiness: row.readiness || READINESS.PENDING,
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
        this.assertSchema();
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
        conductor_id TEXT,
        repo_key TEXT,
        readiness TEXT NOT NULL DEFAULT 'pending' CHECK(readiness IN ('pending', 'ready', 'unavailable', 'recovering', 'gap')),
        generation INTEGER NOT NULL CHECK(generation > 0),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS bindings_native_id_unique ON bindings(provider, native_id) WHERE active=1;
      CREATE UNIQUE INDEX IF NOT EXISTS bindings_conductor_unique ON bindings(provider, conductor_id) WHERE active=1 AND conductor_id IS NOT NULL;
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
        conductor_id TEXT,
        repo_key TEXT,
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
        conductor_id TEXT,
        repo_key TEXT,
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
      CREATE UNIQUE INDEX IF NOT EXISTS provision_conductor_unique ON provision_intents(provider, conductor_id) WHERE conductor_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS intake_watermarks (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        last_seen_id TEXT,
        last_accepted_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('pending', 'ready', 'gap', 'unavailable')),
        gap_from TEXT,
        gap_to TEXT,
        detail TEXT,
        updated_at TEXT NOT NULL
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
    if (version.value !== '1.1' && version.value !== '1.2' && version.value !== SCHEMA_VERSION) {
      throw new StateCorruptError(`unsupported state schema ${version.value}`);
    }
    if (version.value === SCHEMA_VERSION) return;
    if (version.value === '1.1') {
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
          UPDATE meta SET value='1.2' WHERE key='schema';
        `);
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    }
    const bindings = this.tableColumns('bindings');
    const messages = this.tableColumns('messages');
    const intents = this.tableColumns('provision_intents');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!bindings.has('conductor_id')) this.db.exec('ALTER TABLE bindings ADD COLUMN conductor_id TEXT');
      if (!bindings.has('repo_key')) this.db.exec('ALTER TABLE bindings ADD COLUMN repo_key TEXT');
      if (!bindings.has('readiness')) this.db.exec("ALTER TABLE bindings ADD COLUMN readiness TEXT NOT NULL DEFAULT 'pending'");
      if (!messages.has('conductor_id')) this.db.exec('ALTER TABLE messages ADD COLUMN conductor_id TEXT');
      if (!messages.has('repo_key')) this.db.exec('ALTER TABLE messages ADD COLUMN repo_key TEXT');
      if (!intents.has('conductor_id')) this.db.exec('ALTER TABLE provision_intents ADD COLUMN conductor_id TEXT');
      if (!intents.has('repo_key')) this.db.exec('ALTER TABLE provision_intents ADD COLUMN repo_key TEXT');
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS bindings_conductor_unique ON bindings(provider, conductor_id) WHERE active=1 AND conductor_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS provision_conductor_unique ON provision_intents(provider, conductor_id) WHERE conductor_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS intake_watermarks (
          channel_id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          last_seen_id TEXT,
          last_accepted_id TEXT,
          state TEXT NOT NULL CHECK(state IN ('pending', 'ready', 'gap', 'unavailable')),
          gap_from TEXT,
          gap_to TEXT,
          detail TEXT,
          updated_at TEXT NOT NULL
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
    const expected = ['meta', 'config', 'bindings', 'messages', 'reply_parts', 'provision_intents', 'intake_watermarks', 'receipts'];
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
      workspace: { type: 'TEXT', notnull: true }, conductor_id: { type: 'TEXT' }, repo_key: { type: 'TEXT' },
      readiness: { type: 'TEXT', notnull: true }, generation: { type: 'INTEGER', notnull: true },
      active: { type: 'INTEGER', notnull: true }, updated_at: { type: 'TEXT', notnull: true }
    });
    this.assertColumns('messages', {
      discord_id: { type: 'TEXT' }, guild_id: { type: 'TEXT', notnull: true },
      channel_id: { type: 'TEXT', notnull: true }, author_id: { type: 'TEXT', notnull: true },
      content: { type: 'TEXT', notnull: true }, conductor_id: { type: 'TEXT' }, repo_key: { type: 'TEXT' }, state: { type: 'TEXT', notnull: true },
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
      conductor_id: { type: 'TEXT' }, repo_key: { type: 'TEXT' },
      guild_id: { type: 'TEXT', notnull: true }, category_id: { type: 'TEXT', notnull: true },
      workspace: { type: 'TEXT', notnull: true }, marker: { type: 'TEXT', notnull: true },
      state: { type: 'TEXT', notnull: true }, updated_at: { type: 'TEXT', notnull: true }
    });
    this.assertColumns('intake_watermarks', {
      channel_id: { type: 'TEXT' }, guild_id: { type: 'TEXT', notnull: true },
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
    const conductorIndex = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='bindings_conductor_unique'").get();
    if (!conductorIndex?.sql || !/\(provider\s*,\s*conductor_id\)/i.test(conductorIndex.sql)) throw new StateCorruptError('conductor identity uniqueness guard is missing');
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
    const conductorId = binding.conductorId == null ? (existing?.conductorId || null) : assertConductorId(binding.conductorId);
    const repoKey = binding.repoKey == null ? (existing?.repoKey || null) : assertRepoKey(binding.repoKey);
    if (Boolean(conductorId) !== Boolean(repoKey)) throw new BindingError('conductorId and repoKey must be provided together');
    const config = this.requireConfig();
    if (guildId !== config.guildId) throw new BindingError('binding guild is not the configured guild');
    return { channelId, guildId, provider, nativeId, workspace, endpoint, categoryId, conductorId, repoKey };
  }

  bind(binding) {
    const input = this.bindingInput(binding);
    const existing = this.getBinding(input.channelId);
    if (existing) throw new BindingError('channel is already bound; use rebind after work drains');
    this.assertNativeOwnerFree(input.provider, input.nativeId);
    this.assertConductorOwnerFree(input.provider, input.conductorId);
    const createdAt = now();
    return this.transaction(() => {
      const generationRow = input.conductorId
        ? this.db.prepare('SELECT COALESCE(MAX(generation), 0) + 1 AS next FROM bindings WHERE provider=? AND conductor_id=?').get(input.provider, input.conductorId)
        : this.db.prepare('SELECT COALESCE(MAX(generation), 0) + 1 AS next FROM bindings WHERE channel_id=?').get(input.channelId);
      const generation = Number(generationRow.next);
      this.db.prepare(`INSERT INTO bindings(channel_id, guild_id, provider, native_id, workspace, endpoint, category_id, conductor_id, repo_key, readiness, generation, active, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(input.channelId, input.guildId, input.provider, input.nativeId, input.workspace, input.endpoint, input.categoryId, input.conductorId, input.repoKey, READINESS.PENDING, generation, createdAt);
      this.receipt(null, 'bound', { channelId: input.channelId, provider: input.provider, conductorId: input.conductorId, generation });
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
    if (existing.conductorId !== input.conductorId || existing.repoKey !== input.repoKey) throw new BindingError('conductor identity changes require an explicit handoff');
    if (existing.conductorId && existing.provider !== input.provider) throw new BindingError('conductor provider changes require an explicit handoff');
    const generation = existing.generation + 1;
    return this.transaction(() => {
      this.db.prepare(`UPDATE bindings SET guild_id=?, provider=?, native_id=?, workspace=?, endpoint=?, category_id=?, readiness=?, generation=?, active=1, updated_at=? WHERE channel_id=?`)
        .run(input.guildId, input.provider, input.nativeId, input.workspace, input.endpoint, input.categoryId, READINESS.PENDING, generation, now(), channelId);
      this.receipt(null, 'rebound', { channelId, conductorId: input.conductorId, generation });
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

  findConductorBinding(conductorId, provider) {
    assertConductorId(conductorId);
    assertProvider(provider);
    return rowBinding(this.db.prepare('SELECT * FROM bindings WHERE conductor_id=? AND provider=? ORDER BY active DESC, generation DESC LIMIT 1').get(conductorId, provider));
  }

  setBindingReadiness(channelId, readiness, detail = null) {
    assertText(channelId, 'channelId', 128);
    if (!Object.values(READINESS).includes(readiness)) throw new BindingError('invalid binding readiness');
    return this.transaction(() => {
      const binding = this.getBinding(channelId);
      if (!binding) throw new BindingError('channel is not bound');
      this.db.prepare('UPDATE bindings SET readiness=?, updated_at=? WHERE channel_id=?').run(readiness, now(), channelId);
      this.receipt(null, 'binding-readiness', { channelId, conductorId: binding.conductorId, readiness, detail: detail || undefined });
      return this.getBinding(channelId);
    });
  }

  handoffConductor({ channelId, provider, conductorId, repoKey, fromNativeId, fromGeneration, nativeId, workspace, endpoint, handoffId }) {
    assertUuid(fromNativeId, 'fromNativeId');
    if (!Number.isInteger(fromGeneration) || fromGeneration < 1) throw new BindingError('fromGeneration must be a positive integer');
    assertText(handoffId, 'handoffId', 256);
    const existing = this.getBinding(channelId);
    if (!existing || !existing.active) throw new BindingError('channel is not actively bound');
    const input = this.bindingInput({ channelId, provider, conductorId, repoKey, nativeId, workspace, endpoint }, existing);
    if (existing.provider !== provider || existing.conductorId !== conductorId || existing.repoKey !== repoKey || existing.nativeId !== fromNativeId || existing.generation !== fromGeneration) {
      throw new StaleGenerationError('handoff source identity is stale');
    }
    if (nativeId === fromNativeId) throw new BindingError('successor handoff requires a different native session UUID');
    if (this.hasUnresolved(channelId)) throw new UnresolvedWorkError('cannot handoff while work is unresolved');
    this.assertNativeOwnerFree(provider, nativeId, channelId);
    return this.transaction(() => {
      const generation = existing.generation + 1;
      this.db.prepare(`UPDATE bindings SET native_id=?, workspace=?, endpoint=?, readiness=?, generation=?, updated_at=? WHERE channel_id=? AND provider=? AND conductor_id=? AND generation=? AND native_id=?`)
        .run(input.nativeId, input.workspace, input.endpoint, READINESS.PENDING, generation, now(), channelId, provider, conductorId, fromGeneration, fromNativeId);
      this.receipt(null, 'conductor-handoff', {
        channelId, conductorId, repoKey, provider, handoffId,
        fromNativeId, fromGeneration, nativeId: input.nativeId, generation
      });
      return this.getBinding(channelId);
    });
  }

  assertNativeOwnerFree(provider, nativeId, channelId = null) {
    const row = this.db.prepare('SELECT channel_id, provider FROM bindings WHERE provider=? AND native_id=? AND active=1').get(provider, nativeId);
    if (row && row.channel_id !== channelId) throw new BindingError('native session is already owned by another channel for this provider');
  }

  assertConductorOwnerFree(provider, conductorId, channelId = null) {
    if (!conductorId) return;
    const row = this.db.prepare('SELECT channel_id FROM bindings WHERE provider=? AND conductor_id=? AND active=1').get(provider, conductorId);
    if (row && row.channel_id !== channelId) throw new BindingError('conductor identity is already bound to another channel for this provider');
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

  upsertIntakeWatermark(event, ready) {
    const existing = this.db.prepare('SELECT * FROM intake_watermarks WHERE channel_id=?').get(event.channelId);
    const lastSeen = existing?.last_seen_id && compareDiscordIds(existing.last_seen_id, event.id) >= 0 ? existing.last_seen_id : event.id;
    const state = existing?.state === READINESS.GAP ? 'gap' : ready ? 'ready' : 'pending';
    if (existing) {
      this.db.prepare('UPDATE intake_watermarks SET guild_id=?, last_seen_id=?, state=?, updated_at=? WHERE channel_id=?')
        .run(event.guildId, lastSeen, state, now(), event.channelId);
    } else {
      this.db.prepare('INSERT INTO intake_watermarks(channel_id, guild_id, last_seen_id, state, updated_at) VALUES(?, ?, ?, ?, ?)')
        .run(event.channelId, event.guildId, lastSeen, state, now());
    }
  }

  getIntakeWatermark(channelId) {
    assertText(channelId, 'channelId', 128);
    return this.db.prepare('SELECT * FROM intake_watermarks WHERE channel_id=?').get(channelId) || null;
  }

  setIntakeBaseline(channelId, lastSeenId, detail) {
    assertText(channelId, 'channelId', 128);
    assertText(lastSeenId, 'lastSeenId', 128);
    return this.transaction(() => {
      const binding = this.getBinding(channelId);
      if (!binding) throw new BindingError('intake channel is unknown');
      const existing = this.getIntakeWatermark(channelId);
      const retainedLastSeen = existing?.last_seen_id && compareDiscordIds(existing.last_seen_id, lastSeenId) > 0
        ? existing.last_seen_id
        : lastSeenId;
      if (existing) {
        this.db.prepare('UPDATE intake_watermarks SET guild_id=?, last_seen_id=?, state=?, detail=?, gap_from=NULL, gap_to=NULL, updated_at=? WHERE channel_id=?')
          .run(binding.guildId, retainedLastSeen, 'pending', String(detail || '').slice(0, 1000) || null, now(), channelId);
      } else {
        this.db.prepare('INSERT INTO intake_watermarks(channel_id, guild_id, last_seen_id, state, detail, updated_at) VALUES(?, ?, ?, ?, ?, ?)')
          .run(channelId, binding.guildId, lastSeenId, 'pending', String(detail || '').slice(0, 1000) || null, now());
      }
      this.receipt(null, 'intake-baseline', { channelId, lastSeenId, detail });
      return this.getIntakeWatermark(channelId);
    });
  }

  listIntakeWatermarks() {
    return this.db.prepare('SELECT * FROM intake_watermarks ORDER BY channel_id').all();
  }

  markIntakeBoundary(channelId, state, detail = null, gapFrom = null, gapTo = null) {
    assertText(channelId, 'channelId', 128);
    if (!['pending', 'ready', 'gap', 'unavailable'].includes(state)) throw new BindingError('invalid intake watermark state');
    return this.transaction(() => {
      const binding = this.getBinding(channelId);
      const existing = this.getIntakeWatermark(channelId);
      if (!existing && !binding) throw new BindingError('intake channel is unknown');
      const guildId = existing?.guild_id || binding.guildId;
      if (existing) {
        this.db.prepare('UPDATE intake_watermarks SET state=?, detail=?, gap_from=?, gap_to=?, updated_at=? WHERE channel_id=?')
          .run(state, detail ? String(detail).slice(0, 1000) : null, gapFrom, gapTo, now(), channelId);
      } else {
        this.db.prepare('INSERT INTO intake_watermarks(channel_id, guild_id, state, detail, gap_from, gap_to, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
          .run(channelId, guildId, state, detail ? String(detail).slice(0, 1000) : null, gapFrom, gapTo, now());
      }
      if (binding) {
        const readiness = state === 'ready' ? READINESS.READY : state === 'gap' ? READINESS.GAP : state === 'unavailable' ? READINESS.UNAVAILABLE : READINESS.PENDING;
        this.db.prepare('UPDATE bindings SET readiness=?, updated_at=? WHERE channel_id=?').run(readiness, now(), channelId);
      }
      this.receipt(null, 'intake-boundary', { channelId, state, detail: detail || undefined, gapFrom: gapFrom || undefined, gapTo: gapTo || undefined });
      return this.getIntakeWatermark(channelId);
    });
  }

  reconcileIntake(channelId) {
    assertText(channelId, 'channelId', 128);
    return this.transaction(() => {
      const binding = this.getBinding(channelId);
      const watermark = this.getIntakeWatermark(channelId);
      if (!binding || !binding.active || !watermark) throw new BindingError('intake boundary is unknown');
      this.db.prepare("UPDATE intake_watermarks SET state='pending', detail=?, gap_from=NULL, gap_to=NULL, updated_at=? WHERE channel_id=?")
        .run('explicit intake reconciliation requested', now(), channelId);
      this.db.prepare('UPDATE bindings SET readiness=?, updated_at=? WHERE channel_id=?').run(READINESS.PENDING, now(), channelId);
      this.receipt(null, 'intake-reconcile-requested', { channelId, conductorId: binding.conductorId });
      return this.getIntakeWatermark(channelId);
    });
  }

  acceptDiscordMessage(event, { ready = true } = {}) {
    const config = this.requireConfig();
    if (!event || [event.id, event.guildId, event.channelId, event.authorId, event.content].some(value => typeof value !== 'string' || value.length === 0)) {
      if (event && [event.id, event.guildId, event.channelId].every(value => typeof value === 'string' && value.length > 0)) {
        this.transaction(() => {
          this.upsertIntakeWatermark(event, ready);
          this.receipt(null, 'intake-rejected', { discordId: event.id, reason: 'invalid-event', ready });
        });
      }
      return this.reject('invalid-event');
    }
    return this.transaction(() => {
      this.upsertIntakeWatermark(event, ready);
      let reason = null;
      if (event.content.length > 10000) reason = 'invalid-event';
      else if (event.isBot) reason = 'bot-source';
      else if (event.guildId !== config.guildId || event.authorId !== config.operatorId) reason = 'unauthorized-sender';
      const binding = this.getBinding(event.channelId);
      if (!reason && (!binding || !binding.active || binding.guildId !== event.guildId)) reason = 'unknown-binding';
      if (reason) {
        this.receipt(null, 'intake-rejected', { discordId: event.id, reason, ready });
        return this.reject(reason);
      }
      const committed = this.getMessage(event.id);
      if (committed) return { accepted: false, duplicate: true, reason: 'duplicate-message', message: committed };
      if (this.failNextIntakeFlag) {
        this.failNextIntakeFlag = false;
        throw new Error('injected intake transaction failure');
      }
      const timestamp = now();
      this.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, author_id, content, provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        event.id, event.guildId, event.channelId, event.authorId, event.content, binding.provider, binding.nativeId,
        binding.workspace, binding.endpoint, binding.conductorId, binding.repoKey, binding.generation, MESSAGE_STATES.ACCEPTED, timestamp, timestamp
      );
      const watermark = this.getIntakeWatermark(event.channelId);
      if (!watermark?.last_accepted_id || compareDiscordIds(watermark.last_accepted_id, event.id) < 0) {
        this.db.prepare('UPDATE intake_watermarks SET last_accepted_id=?, updated_at=? WHERE channel_id=?')
          .run(event.id, timestamp, event.channelId);
      }
      this.receipt(event.id, 'accepted', { channelId: event.channelId, conductorId: binding.conductorId, generation: binding.generation, readiness: ready ? 'ready' : 'pending' });
      if (!ready) this.receipt(event.id, 'intake-held-not-ready', { channelId: event.channelId });
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
      if (!message || ![MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLY_READY, MESSAGE_STATES.REPLIED].includes(message.state)) return message;
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

  recordNativeReply({ provider, messageId, nativeId, generation, text }) {
    assertProvider(provider);
    assertText(messageId, 'messageId', 128);
    assertUuid(nativeId);
    if (!Number.isInteger(generation) || generation < 1) throw new StaleGenerationError('invalid generation');
    assertText(text, 'reply text', 10000);
    try {
      return this.transaction(() => {
        const message = this.getMessage(messageId);
        if (!message) throw new StaleGenerationError('native reply is stale');
        const check = this.currentMessageBinding(message);
        if (message.provider !== provider || !check.binding || message.nativeId !== nativeId || message.generation !== generation ||
          check.binding.nativeId !== nativeId || check.binding.generation !== generation || check.binding.provider !== message.provider || check.binding.provider !== provider) {
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

  reconcileReplyDelivery(messageId, resolution, { partIndex = null, replyMessageId = null } = {}) {
    if (!['sent', 'not_sent'].includes(resolution)) throw new BindingError('reply resolution must be sent or not_sent');
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message || ![MESSAGE_STATES.REPLY_FAILED, MESSAGE_STATES.REPLY_UNKNOWN].includes(message.state)) {
        throw new BindingError('message does not need reply delivery reconciliation');
      }
      if (resolution === 'not_sent') {
        this.db.prepare("UPDATE reply_parts SET state='pending', error=NULL, updated_at=? WHERE discord_id=? AND state IN ('sending', 'failed', 'unknown')")
          .run(now(), messageId);
        this.db.prepare('UPDATE messages SET state=?, error=NULL, reply_next_part=0, updated_at=? WHERE discord_id=?')
          .run(MESSAGE_STATES.REPLY_READY, now(), messageId);
        this.receipt(messageId, 'reply-reconciled-not-sent', {});
        return this.getMessage(messageId);
      }
      if (!Number.isInteger(partIndex) || partIndex < 0) throw new BindingError('sent reconciliation requires partIndex');
      assertText(replyMessageId, 'replyMessageId', 128);
      const part = this.db.prepare('SELECT * FROM reply_parts WHERE discord_id=? AND part_index=?').get(messageId, partIndex);
      if (!part || !['sending', 'failed', 'unknown'].includes(part.state)) throw new BindingError('reply part does not need sent reconciliation');
      this.db.prepare("UPDATE reply_parts SET state='sent', message_id=?, error=NULL, updated_at=? WHERE discord_id=? AND part_index=?")
        .run(replyMessageId, now(), messageId, partIndex);
      const remaining = this.db.prepare("SELECT COUNT(*) AS count FROM reply_parts WHERE discord_id=? AND state<>'sent'").get(messageId).count;
      if (Number(remaining) === 0) {
        this.db.prepare('UPDATE messages SET state=?, reply_message_id=?, error=NULL, updated_at=? WHERE discord_id=?')
          .run(MESSAGE_STATES.REPLIED, replyMessageId, now(), messageId);
        this.receipt(messageId, 'reply-reconciled-sent', { partIndex, replyMessageId });
      } else {
        this.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=?')
          .run(MESSAGE_STATES.REPLY_UNKNOWN, now(), messageId);
        this.receipt(messageId, 'reply-part-reconciled-sent', { partIndex, replyMessageId });
      }
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
    const conductorId = intent.conductorId == null ? null : assertConductorId(intent.conductorId);
    const repoKey = intent.repoKey == null ? null : assertRepoKey(intent.repoKey);
    if (Boolean(conductorId) !== Boolean(repoKey)) throw new BindingError('conductorId and repoKey must be provided together');
    for (const key of ['guildId', 'categoryId', 'workspace', 'marker']) assertText(intent[key], key, 4096);
    const endpoint = intent.endpoint == null ? null : assertEndpoint(intent.endpoint);
    const taskName = intent.taskName == null ? null : assertText(intent.taskName, 'taskName', 90);
    return this.transaction(() => {
      const existing = conductorId
        ? this.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND conductor_id=?').get(provider, conductorId)
        : this.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND native_id=?').get(provider, nativeId);
      const legacy = conductorId && !existing
        ? this.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND native_id=?').get(provider, nativeId)
        : null;
      let adopted = existing || legacy;
      if (legacy && !legacy.conductor_id) {
        const sameLegacy = legacy.guild_id === intent.guildId && legacy.category_id === intent.categoryId && legacy.workspace === intent.workspace && legacy.endpoint === endpoint;
        if (!sameLegacy) throw new BindingError('legacy provision intent does not match the requested identity');
        this.db.prepare('UPDATE provision_intents SET conductor_id=?, repo_key=?, marker=?, task_name=?, updated_at=? WHERE provider=? AND native_id=?')
          .run(conductorId, repoKey, intent.marker, taskName, now(), provider, nativeId);
        adopted = this.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND native_id=?').get(provider, nativeId);
      }
      if (adopted) {
        const same = adopted.guild_id === intent.guildId && adopted.category_id === intent.categoryId && adopted.workspace === intent.workspace && adopted.endpoint === endpoint && adopted.marker === intent.marker && (adopted.conductor_id || conductorId) === conductorId && (adopted.repo_key || repoKey) === repoKey;
        if (!same) throw new BindingError('provision intent does not match the requested identity');
        if (conductorId && adopted.native_id !== nativeId) throw new BindingError('conductor successor requires an explicit handoff');
        return { ...this.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND native_id=?').get(provider, nativeId), fresh: false };
      }
      const timestamp = now();
      this.db.prepare(`INSERT INTO provision_intents(provider, native_id, conductor_id, repo_key, guild_id, category_id, workspace, endpoint, marker, task_name, state, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(provider, nativeId, conductorId, repoKey, intent.guildId, intent.categoryId, intent.workspace, endpoint, intent.marker, taskName, timestamp, timestamp);
      this.receipt(null, 'provision-intent', { provider, nativeId, conductorId, repoKey, categoryId: intent.categoryId });
      const row = conductorId
        ? this.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND conductor_id=?').get(provider, conductorId)
        : this.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND native_id=?').get(provider, nativeId);
      return { ...row, fresh: true };
    });
  }

  completeProvisionIntent(provider, nativeId, channelId, conductorId = null) {
    assertProvider(provider);
    assertUuid(nativeId);
    assertText(channelId, 'channelId', 128);
    if (conductorId) assertConductorId(conductorId);
    return this.transaction(() => {
      const result = conductorId
        ? this.db.prepare("UPDATE provision_intents SET channel_id=?, native_id=?, state='resolved', updated_at=? WHERE provider=? AND conductor_id=?").run(channelId, nativeId, now(), provider, conductorId)
        : this.db.prepare("UPDATE provision_intents SET channel_id=?, state='resolved', updated_at=? WHERE provider=? AND native_id=?").run(channelId, now(), provider, nativeId);
      if (Number(result.changes) !== 1) throw new BindingError('provision intent is unknown');
      this.receipt(null, 'provision-resolved', { provider, nativeId, conductorId, channelId });
      return conductorId
        ? this.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND conductor_id=?').get(provider, conductorId)
        : this.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND native_id=?').get(provider, nativeId);
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
    const watermarks = this.listIntakeWatermarks();
    const watermarkGap = watermarks.find(row => row.state === 'gap' || row.state === 'unavailable');
    const watermarkPending = watermarks.some(row => row.state === 'pending');
    return {
      configured: Boolean(config.operatorId && config.guildId && config.secretFile),
      activeBindings: bindings.filter(binding => binding.active).length,
      inactiveBindings: bindings.filter(binding => !binding.active).length,
      pending: messages.filter(message => [MESSAGE_STATES.ACCEPTED, MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLY_READY].includes(message.state)).length,
      uncertain: messages.filter(message => message.state === MESSAGE_STATES.UNCERTAIN).length,
      unknownDelivery: messages.filter(message => [MESSAGE_STATES.REPLY_FAILED, MESSAGE_STATES.REPLY_UNKNOWN].includes(message.state)).length,
      execution: bindings.some(binding => binding.active) ? 'unverified-live' : 'unavailable',
      limits: {
        permission: 'unverified-live',
        nativeApproval: 'unverified-live',
        quota: 'unverified-live',
        billing: 'unverified-live',
        connectionBackfill: watermarkGap ? (watermarkGap.state === 'gap' ? 'unrecoverable-gap' : 'unavailable') : watermarkPending ? 'pending' : watermarks.length ? 'bounded-by-discord-watermark' : 'pending',
        recovery: RECOVERY_LIMITS
      },
      intakeWatermarks: watermarks.map(row => ({ channelId: row.channel_id, lastSeenId: row.last_seen_id, state: row.state, gapFrom: row.gap_from, gapTo: row.gap_to, detail: row.detail }))
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
  READINESS,
  RECOVERY_LIMITS,
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
