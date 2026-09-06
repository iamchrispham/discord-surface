const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createPublicationSchema, PublicationStore } = require('./publication/store');
const { REFERENCE_RECEIPT, PENDING_REFERENCE_RECEIPT, referenceForReply, pendingReferenceForReply } = require('./publication/reference');

const SCHEMA_VERSION = '1.5';
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
const TOPIC_PUBLICATION_STATES = Object.freeze({
  IN_FLIGHT: 'in_flight',
  UNKNOWN: 'unknown',
  PUBLISHED: 'published',
  NOT_PUBLISHED: 'not_published'
});
const TOPIC_DEFINITE_NOT_PUBLISHED = new Set(['rate_limited', 'rejected', 'stopped', 'not_published']);
const TRANSPORT_RECEIPT_ATTEMPT = 'transport-receipt-attempt';
const TRANSPORT_RECEIPT_OUTCOME = 'transport-receipt-outcome';
const TRANSPORT_RECEIPT_OUTCOMES = Object.freeze(['sent', 'not_sent', 'rejected', 'rate_limited', 'unknown', 'stale']);
const DIRECT_POST_ATTEMPT = 'direct-post-attempt';
const DIRECT_POST_OUTCOME = 'direct-post-outcome';
const DIRECT_POST_OUTCOMES = Object.freeze(['sent', 'not_sent', 'rejected', 'rate_limited', 'unknown', 'stale']);
const PROCESS_START_TOKEN = crypto.randomUUID();

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

function processIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const startTicks = Number(fields[19]);
    const boot = Number(fs.readFileSync('/proc/stat', 'utf8').match(/^btime\s+(\d+)/m)?.[1]);
    if (Number.isSafeInteger(startTicks) && Number.isSafeInteger(boot)) {
      return { token: `proc:${startTicks}`, seconds: boot + Math.floor(startTicks / 100) };
    }
  } catch {}
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
    const timestamp = Date.parse(output);
    return Number.isFinite(timestamp) ? { token: `ps:${timestamp}`, seconds: Math.floor(timestamp / 1000) } : null;
  } catch { return null; }
}

function directPostOwnerAlive(pid, detail = {}) {
  if (!Number.isInteger(Number(pid)) || Number(pid) < 1) return false;
  try { process.kill(Number(pid), 0); } catch { return false; }
  if (Number(pid) === process.pid && detail.ownerProcessToken) return detail.ownerProcessToken === PROCESS_START_TOKEN;
  const current = processIdentity(pid);
  if (!current) return false;
  if (detail.ownerStartIdentity && current.token === detail.ownerStartIdentity) return true;
  const expectedStart = Number(detail.ownerStartTime ?? detail.ownerStartedAt);
  if (Number.isSafeInteger(expectedStart) && expectedStart >= 0 && current.seconds === expectedStart) return true;
  return Boolean(detail.ownerStartToken && current.token === detail.ownerStartToken);
}

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

function normalizeAttachments(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError('attachments must be an array');
  if (value.length > 25) throw new TypeError('attachments must contain at most 25 items');
  return value.map((attachment, index) => {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) throw new TypeError(`attachment ${index} must be an object`);
    const url = attachment.url;
    if (typeof url !== 'string' || url.length === 0 || url.length > 2048 || /[\u0000-\u001f\u007f]/.test(url)) throw new TypeError(`attachment ${index} url is invalid`);
    let parsed;
    try { parsed = new URL(url); } catch { throw new TypeError(`attachment ${index} url is invalid`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new TypeError(`attachment ${index} url must be an http or https URL`);
    const filename = attachment.filename;
    if (typeof filename !== 'string' || filename.length === 0 || filename.length > 255 || /[\u0000-\u001f\u007f]/.test(filename)) throw new TypeError(`attachment ${index} filename is invalid`);
    const contentType = attachment.contentType === undefined || attachment.contentType === null ? null : attachment.contentType;
    if (contentType !== null && (typeof contentType !== 'string' || contentType.length === 0 || contentType.length > 255 || /[\u0000-\u001f\u007f]/.test(contentType))) throw new TypeError(`attachment ${index} contentType is invalid`);
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) throw new TypeError(`attachment ${index} size is invalid`);
    return { url, filename, contentType, size: attachment.size };
  });
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

function transportReceiptNonce(messageId) {
  return discordNonce(`transport:${messageId}`, 0);
}

function replyBoundary(text, offset) {
  let end = Math.min(text.length, offset + REPLY_LIMIT);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
  return end;
}

function partitionReply(text, preferNewlines) {
  const parts = [];
  let offset = 0;
  while (offset < text.length) {
    let end = replyBoundary(text, offset);
    if (preferNewlines && end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline >= offset) end = newline + 1;
    }
    parts.push(text.slice(offset, end));
    offset = end;
  }
  return parts.length ? parts : [''];
}

function splitReply(text) {
  let parts = partitionReply(text, true);
  if (!parts.some(part => !part.trim())) return parts;
  parts = partitionReply(text, false);
  const tail = parts.at(-1);
  if (parts.length > 1 && !tail.trim()) {
    const previous = parts.at(-2);
    const boundary = previous.search(/\S\s*$/u);
    if (boundary > 0 && previous.length - boundary + tail.length <= REPLY_LIMIT) {
      parts[parts.length - 2] = previous.slice(0, boundary);
      parts[parts.length - 1] = previous.slice(boundary) + tail;
    }
  }
  return parts;
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
  let attachments;
  try {
    if (typeof row.attachments !== 'string') throw new TypeError('attachments column is not text');
    const parsed = JSON.parse(row.attachments);
    if (!Array.isArray(parsed)) throw new TypeError('attachments must be an array');
    attachments = normalizeAttachments(parsed);
  } catch (error) {
    throw new StateCorruptError(`message attachments are invalid: ${error.message}`);
  }
  return {
    id: row.discord_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    authorId: row.author_id,
    content: row.content,
    attachments,
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

function rowTopicPublication(row) {
  if (!row) return null;
  return {
    requestId: row.request_id,
    channelId: row.channel_id,
    guildId: row.guild_id,
    provider: row.provider,
    nativeId: row.native_id,
    conductorId: row.conductor_id || null,
    repoKey: row.repo_key || null,
    generation: Number(row.generation),
    desiredReadiness: row.desired_readiness,
    desiredTopic: row.desired_topic,
    status: row.status,
    outcome: row.outcome || null,
    evidenceScope: row.evidence_scope || null,
    error: row.error || null,
    operationEndedAt: row.operation_ended_at || null,
    readbackAt: row.readback_at || null,
    readbackTopic: row.readback_topic || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function bindingMatchesExpected(binding, expected) {
  if (!expected) return true;
  return Boolean(binding) && binding.active === expected.active && binding.channelId === expected.channelId &&
    binding.guildId === expected.guildId && binding.provider === expected.provider &&
    binding.nativeId === expected.nativeId && binding.generation === expected.generation &&
    binding.conductorId === expected.conductorId && binding.repoKey === expected.repoKey;
}

function bindingIdentityMatchesTopicPublication(binding, publication) {
  return Boolean(binding?.active) && binding.channelId === publication.channelId && binding.guildId === publication.guildId &&
    binding.provider === publication.provider && binding.nativeId === publication.nativeId &&
    binding.generation === publication.generation && binding.conductorId === publication.conductorId &&
    binding.repoKey === publication.repoKey;
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
      createPublicationSchema(this.db);
      this.db.exec(`CREATE INDEX IF NOT EXISTS publication_reference_message ON receipts(discord_id) WHERE kind='${REFERENCE_RECEIPT}'`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS direct_post_receipts_idx ON receipts(id) WHERE discord_id IS NULL AND kind IN ('${DIRECT_POST_ATTEMPT}', '${DIRECT_POST_OUTCOME}')`);
      fs.chmodSync(dbPath, 0o600);
    } catch (error) {
      try { this.db?.close(); } catch {}
      throw new StateCorruptError(`state database is not usable: ${error.message}`);
    }
    this.dbPath = dbPath;
    this.publications = new PublicationStore(this);
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
        attachments TEXT NOT NULL DEFAULT '[]',
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
        recovered_through_id TEXT,
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
      CREATE TABLE IF NOT EXISTS topic_publications (
        request_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
        native_id TEXT NOT NULL,
        conductor_id TEXT,
        repo_key TEXT,
        generation INTEGER NOT NULL CHECK(generation > 0),
        desired_readiness TEXT NOT NULL CHECK(desired_readiness IN ('pending', 'ready', 'unavailable', 'recovering', 'gap')),
        desired_topic TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('in_flight', 'unknown', 'published', 'not_published')),
        outcome TEXT,
        evidence_scope TEXT,
        error TEXT,
        operation_ended_at TEXT,
        readback_at TEXT,
        readback_topic TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS topic_publications_channel_idx ON topic_publications(channel_id, updated_at);
      CREATE INDEX IF NOT EXISTS topic_publications_unresolved_idx ON topic_publications(channel_id) WHERE status IN ('in_flight', 'unknown');
    `);
  }

  tableColumns(table) {
    return new Map(this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => [row.name, row]));
  }

  migrateSchema() {
    const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get();
    if (!version) throw new StateCorruptError('state schema metadata is missing');
    if (version.value !== '1.1' && version.value !== '1.2' && version.value !== '1.3' && version.value !== '1.4' && version.value !== SCHEMA_VERSION) {
      throw new StateCorruptError(`unsupported state schema ${version.value}`);
    }
    if (version.value === SCHEMA_VERSION) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS topic_publications (
          request_id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          guild_id TEXT NOT NULL,
          provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
          native_id TEXT NOT NULL,
          conductor_id TEXT,
          repo_key TEXT,
          generation INTEGER NOT NULL CHECK(generation > 0),
          desired_readiness TEXT NOT NULL CHECK(desired_readiness IN ('pending', 'ready', 'unavailable', 'recovering', 'gap')),
          desired_topic TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('in_flight', 'unknown', 'published', 'not_published')),
          outcome TEXT,
          evidence_scope TEXT,
          error TEXT,
          operation_ended_at TEXT,
          readback_at TEXT,
          readback_topic TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS topic_publications_channel_idx ON topic_publications(channel_id, updated_at);
        CREATE INDEX IF NOT EXISTS topic_publications_unresolved_idx ON topic_publications(channel_id) WHERE status IN ('in_flight', 'unknown');
      `);
      const topicColumns = this.tableColumns('topic_publications');
      if (!topicColumns.has('operation_ended_at')) this.db.exec('ALTER TABLE topic_publications ADD COLUMN operation_ended_at TEXT');
      if (!topicColumns.has('readback_at')) this.db.exec('ALTER TABLE topic_publications ADD COLUMN readback_at TEXT');
      if (!topicColumns.has('readback_topic')) this.db.exec('ALTER TABLE topic_publications ADD COLUMN readback_topic TEXT');
      return;
    }
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
    const watermarks = this.tableColumns('intake_watermarks');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!bindings.has('conductor_id')) this.db.exec('ALTER TABLE bindings ADD COLUMN conductor_id TEXT');
      if (!bindings.has('repo_key')) this.db.exec('ALTER TABLE bindings ADD COLUMN repo_key TEXT');
      if (!bindings.has('readiness')) this.db.exec("ALTER TABLE bindings ADD COLUMN readiness TEXT NOT NULL DEFAULT 'pending'");
      if (!messages.has('conductor_id')) this.db.exec('ALTER TABLE messages ADD COLUMN conductor_id TEXT');
      if (!messages.has('repo_key')) this.db.exec('ALTER TABLE messages ADD COLUMN repo_key TEXT');
      if (!messages.has('attachments')) this.db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
      if (!intents.has('conductor_id')) this.db.exec('ALTER TABLE provision_intents ADD COLUMN conductor_id TEXT');
      if (!intents.has('repo_key')) this.db.exec('ALTER TABLE provision_intents ADD COLUMN repo_key TEXT');
      if (watermarks.size && !watermarks.has('recovered_through_id')) {
        this.db.exec('ALTER TABLE intake_watermarks ADD COLUMN recovered_through_id TEXT');
        const baselineByChannel = new Map();
        for (const row of this.db.prepare("SELECT detail FROM receipts WHERE kind='intake-baseline' ORDER BY id").all()) {
          const detail = parseJson(row.detail, {});
          if (typeof detail.channelId === 'string' && typeof detail.lastSeenId === 'string') baselineByChannel.set(detail.channelId, detail.lastSeenId);
        }
        for (const row of this.db.prepare('SELECT * FROM intake_watermarks').all()) {
          const baselineId = baselineByChannel.get(row.channel_id);
          const confirmed = baselineId && row.last_seen_id && compareDiscordIds(baselineId, row.last_seen_id) <= 0 ? baselineId : null;
          const nextState = confirmed
            ? (row.state === 'gap' || row.state === 'unavailable' ? row.state : 'pending')
            : 'gap';
          const detail = confirmed
            ? 'schema migration retained the recorded intake baseline; recovery is required'
            : 'schema migration found an unverified legacy intake cursor; explicit reconciliation is required';
          this.db.prepare('UPDATE intake_watermarks SET recovered_through_id=?, state=?, detail=?, gap_to=? WHERE channel_id=?')
            .run(confirmed, nextState, detail, confirmed ? row.gap_to : row.last_seen_id, row.channel_id);
          this.db.prepare('UPDATE bindings SET readiness=?, updated_at=? WHERE channel_id=? AND active=1')
            .run(nextState === 'unavailable' ? READINESS.UNAVAILABLE : nextState === 'gap' ? READINESS.GAP : READINESS.PENDING, now(), row.channel_id);
          this.receipt(null, 'legacy-intake-migration', { channelId: row.channel_id, recoveredThroughId: confirmed, state: nextState });
        }
      }
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS bindings_conductor_unique ON bindings(provider, conductor_id) WHERE active=1 AND conductor_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS provision_conductor_unique ON provision_intents(provider, conductor_id) WHERE conductor_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS intake_watermarks (
          channel_id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          last_seen_id TEXT,
          recovered_through_id TEXT,
          last_accepted_id TEXT,
          state TEXT NOT NULL CHECK(state IN ('pending', 'ready', 'gap', 'unavailable')),
          gap_from TEXT,
          gap_to TEXT,
          detail TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS topic_publications (
          request_id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          guild_id TEXT NOT NULL,
          provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
          native_id TEXT NOT NULL,
          conductor_id TEXT,
          repo_key TEXT,
          generation INTEGER NOT NULL CHECK(generation > 0),
          desired_readiness TEXT NOT NULL CHECK(desired_readiness IN ('pending', 'ready', 'unavailable', 'recovering', 'gap')),
          desired_topic TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('in_flight', 'unknown', 'published', 'not_published')),
          outcome TEXT,
          evidence_scope TEXT,
          error TEXT,
          operation_ended_at TEXT,
          readback_at TEXT,
          readback_topic TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS topic_publications_channel_idx ON topic_publications(channel_id, updated_at);
        CREATE INDEX IF NOT EXISTS topic_publications_unresolved_idx ON topic_publications(channel_id) WHERE status IN ('in_flight', 'unknown');
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
    const expected = ['meta', 'config', 'bindings', 'messages', 'reply_parts', 'provision_intents', 'intake_watermarks', 'receipts', 'topic_publications'];
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
      content: { type: 'TEXT', notnull: true }, attachments: { type: 'TEXT', notnull: true }, conductor_id: { type: 'TEXT' }, repo_key: { type: 'TEXT' }, state: { type: 'TEXT', notnull: true },
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
      recovered_through_id: { type: 'TEXT' },
      state: { type: 'TEXT', notnull: true }, updated_at: { type: 'TEXT', notnull: true }
    });
    this.assertColumns('receipts', {
      id: { type: 'INTEGER', notnull: false }, kind: { type: 'TEXT', notnull: true },
      detail: { type: 'TEXT', notnull: true }, created_at: { type: 'TEXT', notnull: true }
    });
    this.assertColumns('topic_publications', {
      request_id: { type: 'TEXT', notnull: false }, channel_id: { type: 'TEXT', notnull: true },
      guild_id: { type: 'TEXT', notnull: true }, provider: { type: 'TEXT', notnull: true },
      native_id: { type: 'TEXT', notnull: true }, conductor_id: { type: 'TEXT' }, repo_key: { type: 'TEXT' },
      generation: { type: 'INTEGER', notnull: true }, desired_readiness: { type: 'TEXT', notnull: true },
      desired_topic: { type: 'TEXT', notnull: true }, status: { type: 'TEXT', notnull: true },
      outcome: { type: 'TEXT' }, evidence_scope: { type: 'TEXT' }, error: { type: 'TEXT' },
      operation_ended_at: { type: 'TEXT' }, readback_at: { type: 'TEXT' }, readback_topic: { type: 'TEXT' },
      created_at: { type: 'TEXT', notnull: true }, updated_at: { type: 'TEXT', notnull: true }
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
    const topicIndex = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='topic_publications_unresolved_idx'").get();
    if (!topicIndex?.sql || !/status\s+IN\s*\('in_flight',\s*'unknown'\)/i.test(topicIndex.sql)) throw new StateCorruptError('topic publication custody guard is missing');
    const topicTable = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='topic_publications'").get();
    if (!topicTable?.sql || !/CHECK\s*\(provider\s+IN\s*\('codex',\s*'claude'\)\)/i.test(topicTable.sql) ||
      !/CHECK\s*\(status\s+IN\s*\('in_flight',\s*'unknown',\s*'published',\s*'not_published'\)\)/i.test(topicTable.sql)) {
      throw new StateCorruptError('topic publication custody constraints are missing');
    }
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

  listTopicPublications(channelId = null) {
    if (channelId !== null) assertText(channelId, 'channelId', 128);
    const rows = channelId === null
      ? this.db.prepare('SELECT * FROM topic_publications ORDER BY updated_at, request_id').all()
      : this.db.prepare('SELECT * FROM topic_publications WHERE channel_id=? ORDER BY updated_at, request_id').all(channelId);
    return rows.map(rowTopicPublication);
  }

  getTopicPublication(requestId) {
    assertText(requestId, 'requestId', 128);
    return rowTopicPublication(this.db.prepare('SELECT * FROM topic_publications WHERE request_id=?').get(requestId));
  }

  hasUnresolvedTopicPublication(channelId) {
    assertText(channelId, 'channelId', 128);
    return Boolean(this.db.prepare("SELECT 1 FROM topic_publications WHERE channel_id=? AND status IN ('in_flight', 'unknown') LIMIT 1").get(channelId));
  }

  assertTopicPublicationSettled(channelId) {
    if (this.hasUnresolvedTopicPublication(channelId)) throw new UnresolvedWorkError('topic publication custody is unresolved');
  }

  assertLegacyMigrationSafe(channelId) {
    assertText(channelId, 'channelId', 128);
    this.assertTopicPublicationSettled(channelId);
    return true;
  }

  beginTopicPublication(channelId, publication, expectedBinding) {
    assertText(channelId, 'channelId', 128);
    if (!expectedBinding) throw new BindingError('topic publication requires an expected binding identity');
    if (!publication || typeof publication.desiredReadiness !== 'string') throw new BindingError('topic publication readiness is required');
    if (!Object.values(READINESS).includes(publication.desiredReadiness)) throw new BindingError('invalid topic publication readiness');
    assertText(publication.desiredTopic, 'desiredTopic', 1024);
    const publishedAt = publication.publishedAt == null ? null : assertText(publication.publishedAt, 'publishedAt', 64);
    return this.transaction(() => {
      const binding = this.getBinding(channelId);
      if (!bindingMatchesExpected(binding, expectedBinding)) return null;
      this.assertTopicPublicationSettled(channelId);
      const requestId = crypto.randomUUID();
      const timestamp = now();
      this.db.prepare(`INSERT INTO topic_publications(
        request_id, channel_id, guild_id, provider, native_id, conductor_id, repo_key, generation,
        desired_readiness, desired_topic, status, outcome, evidence_scope, error, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`).run(
        requestId, channelId, binding.guildId, binding.provider, binding.nativeId, binding.conductorId, binding.repoKey,
        binding.generation, publication.desiredReadiness, publication.desiredTopic, TOPIC_PUBLICATION_STATES.IN_FLIGHT,
        timestamp, timestamp
      );
      const guardedReadiness = publication.desiredReadiness === READINESS.READY ? READINESS.UNAVAILABLE : publication.desiredReadiness;
      this.db.prepare('UPDATE bindings SET readiness=?, updated_at=? WHERE channel_id=? AND active=1').run(guardedReadiness, timestamp, channelId);
      if (publication.desiredReadiness === READINESS.READY) {
        this.db.prepare("UPDATE intake_watermarks SET state='pending', detail=?, updated_at=? WHERE channel_id=? AND state <> 'gap'")
          .run('Discord topic publication custody is unresolved', timestamp, channelId);
      }
      this.receipt(null, 'topic-publication-started', {
        requestId, channelId, conductorId: binding.conductorId, repoKey: binding.repoKey,
        provider: binding.provider, nativeId: binding.nativeId, generation: binding.generation,
        desiredReadiness: publication.desiredReadiness, desiredTopic: publication.desiredTopic, publishedAt
      });
      return this.getTopicPublication(requestId);
    });
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
    const generation = binding.generation == null ? null : Number(binding.generation);
    if (generation !== null && (!Number.isInteger(generation) || generation < 1)) throw new BindingError('generation must be a positive integer');
    const readiness = binding.readiness == null ? (existing?.readiness || (conductorId ? READINESS.PENDING : READINESS.READY)) : binding.readiness;
    if (!Object.values(READINESS).includes(readiness)) throw new BindingError('invalid binding readiness');
    const config = this.requireConfig();
    if (guildId !== config.guildId) throw new BindingError('binding guild is not the configured guild');
    return { channelId, guildId, provider, nativeId, workspace, endpoint, categoryId, conductorId, repoKey, readiness, generation };
  }

  bind(binding) {
    const input = this.bindingInput(binding);
    const existing = this.getBinding(input.channelId);
    if (existing) throw new BindingError('channel is already bound; use rebind after work drains');
    this.assertNativeOwnerFree(input.provider, input.nativeId);
    this.assertConductorOwnerFree(input.provider, input.conductorId);
    const createdAt = now();
    return this.transaction(() => {
      if (this.getBinding(input.channelId)) throw new BindingError('channel is already bound; use rebind after work drains');
      const generationRow = input.conductorId
        ? this.db.prepare('SELECT COALESCE(MAX(generation), 0) + 1 AS next FROM bindings WHERE provider=? AND conductor_id=?').get(input.provider, input.conductorId)
        : this.db.prepare('SELECT COALESCE(MAX(generation), 0) + 1 AS next FROM bindings WHERE channel_id=?').get(input.channelId);
      const nextGeneration = Number(generationRow.next);
      const generation = input.generation == null ? nextGeneration : input.generation;
      if (generation < nextGeneration) throw new BindingError('binding generation would move backwards');
      this.db.prepare(`INSERT INTO bindings(channel_id, guild_id, provider, native_id, workspace, endpoint, category_id, conductor_id, repo_key, readiness, generation, active, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(input.channelId, input.guildId, input.provider, input.nativeId, input.workspace, input.endpoint, input.categoryId, input.conductorId, input.repoKey, input.readiness, generation, createdAt);
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
      const current = this.getBinding(channelId);
      if (!bindingMatchesExpected(current, existing)) throw new StaleGenerationError('rebind source identity is stale');
      this.assertLegacyMigrationSafe(channelId);
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
      const current = this.getBinding(channelId);
      if (!bindingMatchesExpected(current, binding)) throw new StaleGenerationError('unbind source identity is stale');
      this.assertLegacyMigrationSafe(channelId);
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

  setBindingReadiness(channelId, readiness, detail = null, expectedBinding = null) {
    assertText(channelId, 'channelId', 128);
    if (!Object.values(READINESS).includes(readiness)) throw new BindingError('invalid binding readiness');
    return this.transaction(() => {
      const binding = this.getBinding(channelId);
      if (!binding) throw new BindingError('channel is not bound');
      if (!bindingMatchesExpected(binding, expectedBinding)) return null;
      if (readiness === READINESS.READY) this.assertLegacyMigrationSafe(channelId);
      this.db.prepare('UPDATE bindings SET readiness=?, updated_at=? WHERE channel_id=?').run(readiness, now(), channelId);
      this.receipt(null, 'binding-readiness', { channelId, conductorId: binding.conductorId, readiness, detail: detail || undefined });
      return this.getBinding(channelId);
    });
  }

  findConductorHandoff(handoffId) {
    assertText(handoffId, 'handoffId', 256);
    const rows = this.db.prepare("SELECT detail FROM receipts WHERE kind='conductor-handoff' ORDER BY id DESC").all();
    for (const row of rows) {
      const detail = parseJson(row.detail, {});
      if (detail.handoffId === handoffId) return detail;
    }
    return null;
  }

  handoffConductor({ channelId, provider, conductorId, repoKey, fromNativeId, fromGeneration, nativeId, workspace, endpoint, handoffId }) {
    assertUuid(fromNativeId, 'fromNativeId');
    if (!Number.isInteger(fromGeneration) || fromGeneration < 1) throw new BindingError('fromGeneration must be a positive integer');
    assertText(handoffId, 'handoffId', 256);
    const existing = this.getBinding(channelId);
    if (!existing || !existing.active) throw new BindingError('channel is not actively bound');
    const input = this.bindingInput({ channelId, provider, conductorId, repoKey, nativeId, workspace, endpoint }, existing);
    const previous = this.findConductorHandoff(handoffId);
    if (previous) {
      const sameRequest = previous.channelId === channelId && previous.provider === provider && previous.conductorId === conductorId &&
        previous.repoKey === repoKey && previous.fromNativeId === fromNativeId && previous.fromGeneration === fromGeneration &&
        previous.nativeId === nativeId && previous.generation === existing.generation && existing.nativeId === nativeId &&
        existing.generation === fromGeneration + 1 && existing.workspace === input.workspace && existing.endpoint === input.endpoint;
      if (!sameRequest) throw new BindingError('handoff ID is already used for a different successor');
      return this.transaction(() => {
        this.assertTopicPublicationSettled(channelId);
        this.receipt(null, 'conductor-handoff-retry', { channelId, conductorId, provider, handoffId, nativeId, generation: existing.generation });
        return { ...existing, handoffReconciled: true };
      });
    }
    if (existing.provider !== provider || existing.conductorId !== conductorId || existing.repoKey !== repoKey || existing.nativeId !== fromNativeId || existing.generation !== fromGeneration) {
      throw new StaleGenerationError('handoff source identity is stale');
    }
    if (nativeId === fromNativeId) throw new BindingError('successor handoff requires a different native session UUID');
    if (this.hasUnresolved(channelId)) throw new UnresolvedWorkError('cannot handoff while work is unresolved');
    this.assertNativeOwnerFree(provider, nativeId, channelId);
    return this.transaction(() => {
      const current = this.getBinding(channelId);
      if (!bindingMatchesExpected(current, existing)) throw new StaleGenerationError('handoff source identity is stale');
      if (this.hasUnresolved(channelId)) throw new UnresolvedWorkError('cannot handoff while work is unresolved');
      this.assertLegacyMigrationSafe(channelId);
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

  upsertIntakeWatermark(event, ready, coverageId = null) {
    const existing = this.db.prepare('SELECT * FROM intake_watermarks WHERE channel_id=?').get(event.channelId);
    const lastSeen = existing?.last_seen_id && compareDiscordIds(existing.last_seen_id, event.id) >= 0 ? existing.last_seen_id : event.id;
    const recoveredThrough = coverageId && (!existing?.recovered_through_id || compareDiscordIds(existing.recovered_through_id, coverageId) < 0)
      ? coverageId
      : existing?.recovered_through_id || null;
    const state = existing?.state === READINESS.GAP ? 'gap' : existing?.state === READINESS.UNAVAILABLE ? 'unavailable' : ready ? 'ready' : 'pending';
    if (existing) {
      this.db.prepare('UPDATE intake_watermarks SET guild_id=?, last_seen_id=?, recovered_through_id=?, state=?, updated_at=? WHERE channel_id=?')
        .run(event.guildId, lastSeen, recoveredThrough, state, now(), event.channelId);
    } else {
      this.db.prepare('INSERT INTO intake_watermarks(channel_id, guild_id, last_seen_id, recovered_through_id, state, updated_at) VALUES(?, ?, ?, ?, ?, ?)')
        .run(event.channelId, event.guildId, lastSeen, recoveredThrough, state, now());
    }
    if (!ready) {
      const binding = this.getBinding(event.channelId);
      if (binding?.active && binding.guildId === event.guildId) {
        this.db.prepare("UPDATE bindings SET readiness='recovering', updated_at=? WHERE channel_id=? AND active=1 AND readiness='ready'")
          .run(now(), event.channelId);
      }
    }
  }

  getIntakeWatermark(channelId) {
    assertText(channelId, 'channelId', 128);
    return this.db.prepare('SELECT * FROM intake_watermarks WHERE channel_id=?').get(channelId) || null;
  }

  setIntakeBaseline(channelId, lastSeenId, detail, expectedBinding = null) {
    assertText(channelId, 'channelId', 128);
    assertText(lastSeenId, 'lastSeenId', 128);
    return this.transaction(() => {
      const binding = this.getBinding(channelId);
      if (!binding) throw new BindingError('intake channel is unknown');
      if (!bindingMatchesExpected(binding, expectedBinding)) return null;
      const existing = this.getIntakeWatermark(channelId);
      const retainedLastSeen = existing?.last_seen_id && compareDiscordIds(existing.last_seen_id, lastSeenId) > 0
        ? existing.last_seen_id
        : lastSeenId;
      const retainedRecoveredThrough = existing?.recovered_through_id || lastSeenId;
      if (existing) {
        this.db.prepare('UPDATE intake_watermarks SET guild_id=?, last_seen_id=?, recovered_through_id=?, state=?, detail=?, gap_from=NULL, gap_to=NULL, updated_at=? WHERE channel_id=?')
          .run(binding.guildId, retainedLastSeen, retainedRecoveredThrough, 'pending', String(detail || '').slice(0, 1000) || null, now(), channelId);
      } else {
        this.db.prepare('INSERT INTO intake_watermarks(channel_id, guild_id, last_seen_id, recovered_through_id, state, detail, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
          .run(channelId, binding.guildId, lastSeenId, lastSeenId, 'pending', String(detail || '').slice(0, 1000) || null, now());
      }
      this.receipt(null, 'intake-baseline', { channelId, lastSeenId, detail });
      return this.getIntakeWatermark(channelId);
    });
  }

  listIntakeWatermarks() {
    return this.db.prepare('SELECT * FROM intake_watermarks ORDER BY channel_id').all();
  }

  markIntakeBoundary(channelId, state, detail = null, gapFrom = null, gapTo = null, expectedBinding = null) {
    assertText(channelId, 'channelId', 128);
    if (!['pending', 'ready', 'gap', 'unavailable'].includes(state)) throw new BindingError('invalid intake watermark state');
    return this.transaction(() => {
      const binding = this.getBinding(channelId);
      const existing = this.getIntakeWatermark(channelId);
      if (!bindingMatchesExpected(binding, expectedBinding)) return null;
      if (!existing && !binding) throw new BindingError('intake channel is unknown');
      if (state === 'ready') this.assertLegacyMigrationSafe(channelId);
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

  recordTopicPublication(channelId, publication, expectedBinding = null) {
    assertText(channelId, 'channelId', 128);
    if (!publication || typeof publication.desiredReadiness !== 'string') throw new BindingError('topic publication readiness is required');
    if (!Object.values(READINESS).includes(publication.desiredReadiness)) throw new BindingError('invalid topic publication readiness');
    const requestId = publication.requestId == null ? null : assertText(publication.requestId, 'requestId', 128);
    const outcome = String(publication.outcome || 'unknown');
    const remoteTerminal = publication.remoteTerminal === true;
    const status = remoteTerminal && outcome === 'published'
      ? TOPIC_PUBLICATION_STATES.PUBLISHED
      : remoteTerminal && TOPIC_DEFINITE_NOT_PUBLISHED.has(outcome) && publication.publicationUnknown !== true
        ? TOPIC_PUBLICATION_STATES.NOT_PUBLISHED
        : TOPIC_PUBLICATION_STATES.UNKNOWN;
    return this.transaction(() => {
      const binding = this.getBinding(channelId);
      if (!bindingMatchesExpected(binding, expectedBinding)) return null;
      const custody = requestId ? this.getTopicPublication(requestId) : null;
      if (requestId && (!custody || custody.channelId !== channelId)) throw new BindingError('topic publication custody is unknown');
      if (custody && ![TOPIC_PUBLICATION_STATES.IN_FLIGHT, TOPIC_PUBLICATION_STATES.UNKNOWN].includes(custody.status)) return binding;
      if (custody && custody.status === TOPIC_PUBLICATION_STATES.UNKNOWN && !remoteTerminal) return binding;
      if (custody && !bindingIdentityMatchesTopicPublication(binding, custody)) {
        const settledAt = remoteTerminal ? now() : null;
        this.db.prepare('UPDATE topic_publications SET status=?, outcome=?, error=?, operation_ended_at=COALESCE(operation_ended_at, ?), updated_at=? WHERE request_id=? AND status IN (?, ?)')
          .run(TOPIC_PUBLICATION_STATES.UNKNOWN, 'stale', 'topic publication owner changed before settlement', settledAt, now(), requestId, TOPIC_PUBLICATION_STATES.IN_FLIGHT, TOPIC_PUBLICATION_STATES.UNKNOWN);
        this.receipt(null, 'topic-publication', {
          requestId, channelId, conductorId: custody.conductorId, repoKey: custody.repoKey,
          provider: custody.provider, nativeId: custody.nativeId, generation: custody.generation,
          desiredReadiness: custody.desiredReadiness, publishedReadiness: null, publishedAt: null,
          outcome: 'stale', custodyStatus: TOPIC_PUBLICATION_STATES.UNKNOWN,
          remoteTerminal,
          observedTopic: typeof publication.observedTopic === 'string' ? publication.observedTopic : null,
          error: 'topic publication owner changed before settlement'
        });
        return null;
      }
      const desiredReadiness = custody?.desiredReadiness || publication.desiredReadiness;
      if (custody) {
        const endedAt = remoteTerminal ? (custody.operationEndedAt || now()) : custody.operationEndedAt;
        this.db.prepare(`UPDATE topic_publications SET status=?, outcome=?, error=?, operation_ended_at=?, updated_at=? WHERE request_id=? AND status IN (?, ?)`)
          .run(status, outcome, publication.error ? String(publication.error).slice(0, 200) : null, endedAt, now(), requestId, TOPIC_PUBLICATION_STATES.IN_FLIGHT, TOPIC_PUBLICATION_STATES.UNKNOWN);
      }
      this.receipt(null, 'topic-publication', {
        requestId, channelId,
        conductorId: custody?.conductorId || binding?.conductorId || null,
        repoKey: custody?.repoKey || binding?.repoKey || null,
        provider: custody?.provider || binding?.provider || null,
        nativeId: custody?.nativeId || binding?.nativeId || null,
        generation: custody?.generation || binding?.generation || null,
        desiredReadiness,
        publishedReadiness: publication.publishedReadiness || null,
        publishedAt: publication.publishedAt || null,
        outcome,
        custodyStatus: status,
        remoteTerminal,
        observedTopic: typeof publication.observedTopic === 'string' ? publication.observedTopic : null,
        error: publication.error ? String(publication.error).slice(0, 200) : null
      });
      return this.getBinding(channelId);
    });
  }

  reconcileTopicPublication(channelId, requestId, resolution, evidenceScope, readback = null) {
    assertText(channelId, 'channelId', 128);
    assertText(requestId, 'requestId', 128);
    if (!['published', 'not_published'].includes(resolution)) throw new BindingError('topic publication resolution must be published or not_published');
    assertText(evidenceScope, 'evidenceScope', 2000);
    if (!readback || typeof readback !== 'object') throw new BindingError('fresh topic readback is required');
    assertText(readback.topic, 'readback.topic', 2048);
    assertText(readback.observedAt, 'readback.observedAt', 64);
    if (!Number.isFinite(Date.parse(readback.observedAt))) throw new BindingError('readback.observedAt must be an ISO timestamp');
    return this.transaction(() => {
      const custody = this.getTopicPublication(requestId);
      if (!custody || custody.channelId !== channelId) throw new BindingError('topic publication custody is unknown');
      if (![TOPIC_PUBLICATION_STATES.IN_FLIGHT, TOPIC_PUBLICATION_STATES.UNKNOWN].includes(custody.status)) {
        throw new BindingError('topic publication custody is already settled');
      }
      if (!custody.operationEndedAt) throw new UnresolvedWorkError('topic publication operation has not terminated');
      if (Date.parse(readback.observedAt) < Date.parse(custody.operationEndedAt)) throw new BindingError('topic readback predates operation termination');
      if (resolution === 'published' && readback.topic !== custody.desiredTopic) throw new BindingError('topic readback does not confirm the desired publication');
      if (resolution === 'not_published' && readback.topic === custody.desiredTopic) throw new BindingError('topic readback confirms the desired publication');
      const binding = this.getBinding(channelId);
      if (!binding || !bindingIdentityMatchesTopicPublication(binding, custody)) throw new StaleGenerationError('topic publication reconciliation target is stale');
      const status = resolution === 'published' ? TOPIC_PUBLICATION_STATES.PUBLISHED : TOPIC_PUBLICATION_STATES.NOT_PUBLISHED;
      const outcome = resolution === 'published' ? 'reconciled_published' : 'reconciled_not_published';
      this.db.prepare('UPDATE topic_publications SET status=?, outcome=?, evidence_scope=?, error=NULL, readback_at=?, readback_topic=?, updated_at=? WHERE request_id=? AND status IN (?, ?)')
        .run(status, outcome, evidenceScope, readback.observedAt, readback.topic, now(), requestId, TOPIC_PUBLICATION_STATES.IN_FLIGHT, TOPIC_PUBLICATION_STATES.UNKNOWN);
      this.receipt(null, 'topic-publication-reconciled', {
        requestId, channelId, provider: custody.provider, nativeId: custody.nativeId,
        conductorId: custody.conductorId, repoKey: custody.repoKey, generation: custody.generation,
        desiredReadiness: custody.desiredReadiness, resolution, evidenceScope, custodyStatus: status,
        operationEndedAt: custody.operationEndedAt, readbackAt: readback.observedAt, readbackTopic: readback.topic
      });
      return this.getBinding(channelId);
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

  acceptDiscordMessage(event, { ready = true, coverageId = null, expectedBinding = null, botUserId = null } = {}) {
    const config = this.requireConfig();
    if (coverageId !== null) assertText(coverageId, 'coverageId', 128);
    let attachments;
    try { attachments = normalizeAttachments(event?.attachments); } catch { attachments = null; }
    const validEvent = event && [event.id, event.guildId, event.channelId, event.authorId].every(value => typeof value === 'string' && value.length > 0) &&
      typeof event.content === 'string' && event.content.length <= 10000 && attachments !== null && (event.content.length > 0 || attachments.length > 0);
    if (!validEvent) {
      if (event && [event.id, event.guildId, event.channelId].every(value => typeof value === 'string' && value.length > 0)) {
        const result = this.transaction(() => {
          const binding = this.getBinding(event.channelId);
          if (!bindingMatchesExpected(binding, expectedBinding)) return { accepted: false, stale: true, reason: 'stale-binding' };
          this.upsertIntakeWatermark(event, ready, coverageId);
          this.receipt(null, 'intake-rejected', { discordId: event.id, reason: 'invalid-event', ready });
          return null;
        });
        if (result?.stale) return result;
      }
      return this.reject('invalid-event');
    }
    const automaticPost = this.publications.excludeEvent(event, botUserId) || this.excludeDirectPost(event, botUserId);
    return this.transaction(() => {
      const binding = this.getBinding(event.channelId);
      if (!bindingMatchesExpected(binding, expectedBinding)) return { accepted: false, stale: true, reason: 'stale-binding' };
      this.upsertIntakeWatermark(event, ready, coverageId);
      let reason = null;
      if (typeof event.content !== 'string' || event.content.length > 10000 || attachments === null || (event.content.length === 0 && attachments?.length === 0)) reason = 'invalid-event';
      else if (automaticPost) reason = 'automatic-publication';
      else if (event.isBot) reason = 'bot-source';
      else if (event.guildId !== config.guildId || event.authorId !== config.operatorId) reason = 'unauthorized-sender';
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
      this.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, author_id, content, attachments, provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        event.id, event.guildId, event.channelId, event.authorId, event.content, JSON.stringify(attachments), binding.provider, binding.nativeId,
        binding.workspace, binding.endpoint, binding.conductorId, binding.repoKey, binding.generation, MESSAGE_STATES.ACCEPTED, timestamp, timestamp
      );
      const reference = referenceForReply(this.db, binding, event.referencedMessageId);
      if (reference) this.receipt(event.id, REFERENCE_RECEIPT, reference);
      else {
        const pendingReference = pendingReferenceForReply(this.db, binding, event.referencedMessageId);
        if (pendingReference) this.receipt(event.id, PENDING_REFERENCE_RECEIPT, pendingReference);
      }
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

  getTransportReceipt(messageId) {
    assertText(messageId, 'messageId', 128);
    const rows = this.db.prepare('SELECT kind, detail, created_at FROM receipts WHERE discord_id=? AND kind IN (?, ?) ORDER BY id')
      .all(messageId, TRANSPORT_RECEIPT_ATTEMPT, TRANSPORT_RECEIPT_OUTCOME);
    let attempt = null;
    let outcome = null;
    for (const row of rows) {
      const detail = parseJson(row.detail, {});
      if (row.kind === TRANSPORT_RECEIPT_ATTEMPT) attempt = { ...detail, recordedAt: row.created_at };
      if (row.kind === TRANSPORT_RECEIPT_OUTCOME) outcome = { ...detail, recordedAt: row.created_at };
    }
    if (!attempt && !outcome) return null;
    return { messageId, attempt, outcome };
  }

  beginTransportReceipt(messageId) {
    assertText(messageId, 'messageId', 128);
    return this.transaction(() => {
      const existing = this.getTransportReceipt(messageId);
      if (existing) return { started: false, ...existing, reason: 'already-attempted' };
      const message = this.getMessage(messageId);
      if (!message) throw new BindingError('message is unknown');
      if (message.state !== MESSAGE_STATES.ACCEPTED) return { started: false, message, reason: 'message-not-accepted' };
      const check = this.currentMessageBinding(message);
      if (!check.current) {
        const detail = { nonce: transportReceiptNonce(messageId), outcome: 'stale', reason: 'authorization revoked before receipt attempt' };
        this.receipt(messageId, TRANSPORT_RECEIPT_OUTCOME, detail);
        return { started: false, message, outcome: detail.outcome, detail, reason: 'stale-authority' };
      }
      const detail = {
        nonce: transportReceiptNonce(messageId),
        channelId: message.channelId,
        provider: check.binding.provider,
        conductorId: check.binding.conductorId,
        repoKey: check.binding.repoKey,
        generation: check.binding.generation,
        readiness: check.binding.readiness,
        status: 'attempted'
      };
      this.receipt(messageId, TRANSPORT_RECEIPT_ATTEMPT, detail);
      return { started: true, message, binding: check.binding, attempt: detail, nonce: detail.nonce };
    });
  }

  authorizeTransportReceipt(messageId, expectedBinding) {
    assertText(messageId, 'messageId', 128);
    return this.transaction(() => {
      const record = this.getTransportReceipt(messageId);
      if (!record?.attempt || record.outcome) return null;
      const message = this.getMessage(messageId);
      const check = message ? this.currentMessageBinding(message) : null;
      if (!check?.current || !bindingMatchesExpected(check.binding, expectedBinding)) return null;
      return { message, binding: check.binding, attempt: record.attempt, nonce: record.attempt.nonce };
    });
  }

  recordTransportReceiptOutcome(messageId, outcome, detail = {}) {
    assertText(messageId, 'messageId', 128);
    if (!TRANSPORT_RECEIPT_OUTCOMES.includes(outcome)) throw new BindingError('invalid transport receipt outcome');
    return this.transaction(() => {
      const record = this.getTransportReceipt(messageId);
      if (!record?.attempt) throw new BindingError('transport receipt attempt is unknown');
      if (record.outcome) return record;
      const next = { ...detail, nonce: record.attempt.nonce, outcome };
      this.receipt(messageId, TRANSPORT_RECEIPT_OUTCOME, next);
      return this.getTransportReceipt(messageId);
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
        if (check.binding.readiness !== READINESS.READY) {
          this.receipt(messageId, 'dispatch-held-not-ready', { readiness: check.binding.readiness, generation: message.generation });
          return { claimed: false, message, reason: 'binding-not-ready' };
        }
        const pendingReference = this.db.prepare('SELECT 1 FROM receipts WHERE discord_id=? AND kind=? LIMIT 1')
          .get(messageId, PENDING_REFERENCE_RECEIPT);
        if (pendingReference) {
          this.receipt(messageId, 'dispatch-held-publication-reference', { generation: message.generation });
          return { claimed: false, message, reason: 'publication-reference-pending' };
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
      this.recoverDirectPostReceiptsInternal();
      const topicPublications = this.db.prepare('SELECT * FROM topic_publications WHERE status=?').all(TOPIC_PUBLICATION_STATES.IN_FLIGHT);
      for (const row of topicPublications) {
        this.db.prepare('UPDATE topic_publications SET status=?, outcome=?, error=?, updated_at=? WHERE request_id=? AND status=?')
          .run(TOPIC_PUBLICATION_STATES.UNKNOWN, 'process_stopped', 'process stopped during topic publication', now(), row.request_id, TOPIC_PUBLICATION_STATES.IN_FLIGHT);
        this.receipt(null, 'topic-publication-unknown-after-restart', {
          requestId: row.request_id, channelId: row.channel_id, provider: row.provider,
          nativeId: row.native_id, conductorId: row.conductor_id, repoKey: row.repo_key,
          generation: row.generation, desiredReadiness: row.desired_readiness
        });
      }
      const transportAttempts = this.db.prepare(`
        SELECT attempt.discord_id, attempt.detail
        FROM receipts AS attempt
        LEFT JOIN receipts AS outcome
          ON outcome.discord_id = attempt.discord_id
         AND outcome.kind = ?
         AND outcome.id > attempt.id
        WHERE attempt.kind = ? AND outcome.id IS NULL
        ORDER BY attempt.id
      `).all(TRANSPORT_RECEIPT_OUTCOME, TRANSPORT_RECEIPT_ATTEMPT);
      for (const row of transportAttempts) {
        this.receipt(row.discord_id, TRANSPORT_RECEIPT_OUTCOME, {
          ...parseJson(row.detail, {}),
          outcome: 'unknown',
          reason: 'process stopped before transport receipt outcome'
        });
      }
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

  directPostRows(requestId = null) {
    if (requestId !== null) assertText(requestId, 'requestId', 256);
    const rows = this.db.prepare(`SELECT id, kind, detail, created_at FROM receipts
      WHERE discord_id IS NULL AND kind IN ('${DIRECT_POST_ATTEMPT}', '${DIRECT_POST_OUTCOME}') ORDER BY id`).all();
    return rows.map(row => ({
      id: Number(row.id),
      kind: row.kind,
      detail: parseJson(row.detail, null),
      createdAt: row.created_at
    })).filter(row => {
      if (!row.detail || row.detail.journal !== 'direct-post-v1') throw new StateCorruptError('direct post receipt is malformed');
      return requestId === null || row.detail.requestId === requestId;
    });
  }

  recoverDirectPostReceipts(ownerAlive = directPostOwnerAlive) {
    return this.transaction(() => this.recoverDirectPostReceiptsInternal(ownerAlive));
  }

  recoverDirectPostReceiptsInternal(ownerAlive = directPostOwnerAlive) {
    const rows = this.directPostRows();
    const outcomes = new Set(rows.filter(row => row.kind === DIRECT_POST_OUTCOME && row.detail?.attemptId).map(row => row.detail.attemptId));
    let recovered = 0;
    for (const row of rows.filter(item => item.kind === DIRECT_POST_ATTEMPT)) {
      if (outcomes.has(row.detail.attemptId)) continue;
      if (ownerAlive(row.detail.ownerPid, row.detail)) continue;
      this.receipt(null, DIRECT_POST_OUTCOME, {
        ...row.detail,
        outcome: 'unknown',
        reason: 'process stopped before direct post outcome'
      });
      recovered += 1;
    }
    return recovered;
  }

  directPostBindingCurrent(binding, operatorId = null) {
    const config = this.requireConfig();
    const current = this.getBinding(binding?.channelId);
    return Boolean(binding && current && bindingMatchesExpected(current, binding) && current.guildId === config.guildId &&
      (operatorId === null || config.operatorId === operatorId));
  }

  beginDirectPostPart(meta) {
    if (!meta || typeof meta !== 'object') throw new BindingError('direct post metadata is required');
    assertText(meta.requestId, 'requestId', 256);
    assertText(meta.attemptId, 'attemptId', 128);
    if (!Number.isInteger(meta.partIndex) || meta.partIndex < 0 || !Number.isInteger(meta.partCount) || meta.partCount < 1 || meta.partIndex >= meta.partCount) {
      throw new BindingError('direct post part index is invalid');
    }
    return this.transaction(() => {
      const rows = this.directPostRows(meta.requestId);
      const identityKeys = ['sourcePath', 'textHash', 'operatorId', 'channelId', 'guildId', 'provider', 'nativeId', 'generation', 'conductorId', 'repoKey', 'partCount'];
      for (const row of rows) {
        for (const key of identityKeys) {
          if (row.detail[key] !== meta[key]) throw new BindingError('direct post request identity conflicts with existing custody');
        }
        if (row.detail.partIndex === meta.partIndex && row.detail.partHash !== meta.partHash) {
          throw new BindingError('direct post part hash conflicts with existing custody');
        }
      }
      if (!this.directPostBindingCurrent(meta.binding, meta.operatorId)) throw new StaleGenerationError('direct post binding is stale');
      const attempts = rows.filter(row => row.kind === DIRECT_POST_ATTEMPT && row.detail.partIndex === meta.partIndex).sort((a, b) => a.id - b.id);
      const outcomes = new Map(rows.filter(row => row.kind === DIRECT_POST_OUTCOME && row.detail.attemptId).map(row => [row.detail.attemptId, row]));
      const latest = attempts.at(-1);
      if (latest) {
        if (latest.detail.partHash !== meta.partHash) throw new BindingError('direct post part hash conflicts with existing custody');
        const outcome = outcomes.get(latest.detail.attemptId);
        if (!outcome) return { claimed: false, status: 'in_flight', attemptId: latest.detail.attemptId, nonce: latest.detail.nonce };
        const status = outcome.detail.outcome;
        if (status === 'sent' || status === 'unknown') return { claimed: false, status, attemptId: latest.detail.attemptId, nonce: latest.detail.nonce, outcome: outcome.detail };
        if (!['not_sent', 'rejected', 'rate_limited'].includes(status)) return { claimed: false, status, attemptId: latest.detail.attemptId, nonce: latest.detail.nonce, outcome: outcome.detail };
      }
      const identity = processIdentity(process.pid);
      this.receipt(null, DIRECT_POST_ATTEMPT, {
        journal: 'direct-post-v1', ...meta, ownerPid: process.pid, ownerStartTime: identity?.seconds ?? null,
        ownerProcessToken: PROCESS_START_TOKEN, ownerStartToken: identity?.token || null, status: 'attempted'
      });
      return { claimed: true, status: 'claimed', attemptId: meta.attemptId, nonce: meta.nonce };
    });
  }

  recordDirectPostOutcome(requestId, attemptId, outcome, detail = {}) {
    assertText(requestId, 'requestId', 256);
    assertText(attemptId, 'attemptId', 128);
    if (!DIRECT_POST_OUTCOMES.includes(outcome)) throw new BindingError('invalid direct post outcome');
    return this.transaction(() => {
      const rows = this.directPostRows(requestId);
      const attempt = rows.find(row => row.kind === DIRECT_POST_ATTEMPT && row.detail.attemptId === attemptId);
      if (!attempt) throw new BindingError('direct post attempt is unknown');
      const existing = rows.filter(row => row.kind === DIRECT_POST_OUTCOME && row.detail.attemptId === attemptId).at(-1);
      if (existing) return existing.detail;
      const next = { ...attempt.detail, ...detail, outcome };
      this.receipt(null, DIRECT_POST_OUTCOME, next);
      return next;
    });
  }

  reconcileDirectPostEcho(event, botUserId = null) {
    if (!event?.isBot || typeof botUserId !== 'string' || event.authorId !== botUserId ||
      typeof event.id !== 'string' || !event.id || typeof event.channelId !== 'string' ||
      typeof event.guildId !== 'string' || typeof event.nonce !== 'string' || !event.nonce) return false;
    return this.transaction(() => {
      const rows = this.directPostRows();
      const outcomes = new Map(rows.filter(row => row.kind === DIRECT_POST_OUTCOME && row.detail.attemptId)
        .map(row => [row.detail.attemptId, row]));
      for (const attempt of rows.filter(row => row.kind === DIRECT_POST_ATTEMPT).reverse()) {
        const detail = attempt.detail;
        if (detail.channelId !== event.channelId || detail.guildId !== event.guildId || detail.nonce !== event.nonce) continue;
        const outcome = outcomes.get(detail.attemptId);
        if (outcome?.detail.outcome === 'sent') return true;
        if (outcome && outcome.detail.outcome !== 'unknown') continue;
        this.receipt(null, DIRECT_POST_OUTCOME, {
          ...detail,
          ...(outcome?.detail || {}),
          outcome: 'sent', messageId: event.id, status: 200, reason: 'gateway-echo'
        });
        return true;
      }
      return false;
    });
  }

  excludeDirectPost(event, botUserId = null) {
    if (!event || typeof event.id !== 'string' || typeof event.channelId !== 'string' || typeof event.guildId !== 'string') return false;
    const reconciled = this.reconcileDirectPostEcho(event, botUserId);
    const rows = this.directPostRows();
    return reconciled || rows.some(row => row.kind === DIRECT_POST_OUTCOME && row.detail.outcome === 'sent' &&
      row.detail.channelId === event.channelId && row.detail.guildId === event.guildId &&
      (row.detail.messageId === event.id || (event.isBot && event.authorId === botUserId && typeof event.nonce === 'string' && row.detail.nonce === event.nonce)));
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
    if (message) {
      message.replyParts = this.listReplyParts(messageId);
      const reference = this.db.prepare('SELECT detail FROM receipts WHERE discord_id=? AND kind=? ORDER BY id LIMIT 1').get(messageId, REFERENCE_RECEIPT);
      if (reference) message.publicationReference = JSON.parse(reference.detail);
    }
    return message;
  }

  settlePublicationReference(publicationId, messageId) {
    return this.transaction(() => {
      const rows = this.db.prepare('SELECT id, discord_id, detail FROM receipts WHERE kind=? ORDER BY id').all(PENDING_REFERENCE_RECEIPT);
      let settled = 0;
      for (const row of rows) {
        const pending = parseJson(row.detail, null);
        if (pending?.publicationId !== publicationId || pending.referencedMessageId !== messageId) continue;
        const message = this.db.prepare('SELECT channel_id FROM messages WHERE discord_id=?').get(row.discord_id);
        const binding = message && this.getBinding(message.channel_id);
        const reference = binding && referenceForReply(this.db, binding, messageId);
        if (!reference) continue;
        this.db.prepare('UPDATE receipts SET kind=?, detail=? WHERE id=?')
          .run(REFERENCE_RECEIPT, safeDetail(reference), row.id);
        settled += 1;
      }
      return settled;
    });
  }

  clearPendingPublicationReferences(publicationId) {
    return this.transaction(() => {
      const rows = this.db.prepare('SELECT id, detail FROM receipts WHERE kind=?').all(PENDING_REFERENCE_RECEIPT);
      let cleared = 0;
      for (const row of rows) {
        if (parseJson(row.detail, null)?.publicationId !== publicationId) continue;
        cleared += this.db.prepare('DELETE FROM receipts WHERE id=?').run(row.id).changes;
      }
      return cleared;
    });
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
    const topicCustody = this.listTopicPublications();
    const topicPublications = new Map();
    for (const row of this.listReceipts().filter(item => item.kind === 'topic-publication' || item.kind === 'topic-publication-reconciled')) {
      const detail = parseJson(row.detail, {});
      if (detail.channelId) topicPublications.set(detail.channelId, { ...detail, recordedAt: row.created_at });
    }
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
      intakeWatermarks: watermarks.map(row => ({ channelId: row.channel_id, lastSeenId: row.last_seen_id, recoveredThroughId: row.recovered_through_id, state: row.state, gapFrom: row.gap_from, gapTo: row.gap_to, detail: row.detail })),
      legacyTopicPublications: [...topicPublications.values()],
      legacyTopicPublicationCustody: topicCustody
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
  TRANSPORT_RECEIPT_ATTEMPT,
  TRANSPORT_RECEIPT_OUTCOME,
  TRANSPORT_RECEIPT_OUTCOMES,
  DIRECT_POST_ATTEMPT,
  DIRECT_POST_OUTCOME,
  DIRECT_POST_OUTCOMES,
  TOPIC_PUBLICATION_STATES,
  UnresolvedWorkError,
  UUID,
  discordNonce,
  normalizeAttachments,
  splitReply,
  validateNativeId
};
