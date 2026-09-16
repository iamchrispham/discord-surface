const { PREFIX: AGENT_PREFIX, decodeAgentMessage } = require('./agent-message');
const { WATCHER_NOTICE_PREFIX, decodeWatcherNotice, sameWatcherNotice, validateWatcherNotice } = require('./watcher-notice');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { normalizeAttachments } = require('./attachments');
const { ORDINARY_RECEIPT_KINDS } = require('./ordinary/constants');
const { createOrdinaryRepository } = require('./ordinary');
const { createDirectPostHandlers, queryDirectPostRows, DIRECT_POST_OUTCOMES } = require('./state/direct-post');
const {
  removeDirectPostFile
} = require('./direct-post-file');
const {
  NATIVE_REPLY_FILE_PHASES,
  NATIVE_REPLY_FILE_PREPARATION,
  assertNativeReplyFileManifest,
  createNativeReplyFileHandlers
} = require('./state/native-reply-file');
const { createAgentCompletionHandlers } = require('./state/agent-completion');
const {
  createWatcherNoticeHandlers,
  WATCHER_NOTICE_AUTHORITY,
  WATCHER_NOTICE_JOURNAL,
  WATCHER_NOTICE_PUBLICATION_SOURCE,
  WATCHER_NOTICE_RECEIPTS
} = require('./state/watcher-notice');
const { createBoardRefreshHandlers, BOARD_OUTCOMES, BOARD_RECEIPT_KINDS } = require('./state/board-refresh');
const { createOrdinaryBindingHandlers } = require('./state/ordinary-binding');
const {
  createThreadEnrollmentHandlers,
  THREAD_DEACTIVATION_DETAILS,
  THREAD_INTAKE_REASONS,
  THREAD_STATES,
  THREAD_RECEIPT_KINDS
} = require('./state/thread-enrollment');
const {
  createIntakeHandlers,
  intakeCutoffDecision,
  pauseOrdinaryHandoffIntake,
  restoreOrdinaryHandoffIntake,
  recoverInterruptedOrdinaryHandoffIntake
} = require('./state/intake');
const { createInteractionHandlers, INTERACTION_ORIGIN, INTERACTION_TRANSPORT } = require('./state/interaction');
const {
  createDecisionHandlers,
  DecisionError,
  DECISION_JOURNAL,
  DECISION_REASONS,
  DECISION_STATES,
  DECISION_RECEIPT_KINDS,
  DECISION_TRANSPORT_OUTCOMES,
  DECISION_WINNER_SOURCES,
  DECISION_NATIVE_OUTCOMES
} = require('./state/decision');
const {
  createCourierRouteHandlers,
  COURIER_ATTEMPT_STATES,
  COURIER_OUTCOMES,
  COURIER_RECEIPT_KINDS,
  COURIER_RESULT_STATUSES,
  COURIER_ROUTE_STATES,
  COURIER_SOURCE_KINDS
} = require('./state/courier-route');

const SCHEMA_VERSION = '1.8';
const PROVIDERS = Object.freeze({ CODEX: 'codex', CLAUDE: 'claude' });
const READINESS = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  UNAVAILABLE: 'unavailable',
  RECOVERING: 'recovering',
  GAP: 'gap'
});
const INTAKE_BOUNDARY_DETAILS = Object.freeze({
  ORDINARY_HANDOFF: 'ordinary handoff fence'
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
  AGENT_HANDLED_WITHOUT_POST: 'agent_handled_without_post',
  REJECTED: 'rejected'
});
const AGENT_COMPLETION_RECEIPTS = Object.freeze({
  RESULT_CONSUMED: 'result-consumed',
  REQUEST_HANDLED_WITHOUT_POST: 'agent-handled-without-post'
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
const NATIVE_ACK_RECEIPT = 'native-ack';
const REPLY_COMPLETED_WITHOUT_POST = 'reply-completed-without-post';

const DIRECT_POST_ATTEMPT = 'direct-post-attempt';
const DIRECT_POST_OUTCOME = 'direct-post-outcome';
const DIRECT_POST_FILE_PREPARATION = 'direct-post-file-preparation';
const DISPATCH_OUTCOMES = Object.freeze({ NOT_SUBMITTED: 'not_submitted' });

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

const ordinaryBindingHandlers = createOrdinaryBindingHandlers({
  BindingError,
  StaleGenerationError,
  MESSAGE_STATES,
  PROVIDERS,
  READINESS,
  UnresolvedWorkError,
  assertText,
  assertUuid,
  compareDiscordIds,
  bindingMatchesExpected,
  now
});

const directPostHandlers = createDirectPostHandlers({
  BindingError,
  StaleGenerationError,
  StateCorruptError,
  DIRECT_POST_ATTEMPT,
  DIRECT_POST_OUTCOME,
  DIRECT_POST_FILE_PREPARATION,
  DIRECT_POST_OUTCOMES,
  assertText,
  bindingMatchesExpected,
  parseJson,
  now
});

const nativeReplyFileHandlers = createNativeReplyFileHandlers({
  BindingError,
  AuthorizationError,
  StaleGenerationError,
  StateCorruptError,
  MESSAGE_STATES,
  DIRECT_POST_FILE_PREPARATION,
  NATIVE_ACK_RECEIPT,
  REPLY_LIMIT,
  assertProvider,
  assertText,
  assertUuid,
  parseJson,
  safeDetail,
  now
});

const agentCompletionHandlers = createAgentCompletionHandlers({
  AGENT_COMPLETION_RECEIPTS,
  MESSAGE_STATES,
  DIRECT_POST_ATTEMPT,
  DIRECT_POST_OUTCOME,
  NATIVE_REPLY_FILE_PHASES,
  assertText,
  assertProvider,
  assertUuid,
  parseJson,
  now,
  AuthorizationError,
  BindingError,
  StaleGenerationError,
  StateCorruptError
});

const watcherNoticeHandlers = createWatcherNoticeHandlers({
  BindingError,
  AuthorizationError,
  StaleGenerationError,
  StateCorruptError,
  MESSAGE_STATES,
  NATIVE_REPLY_FILE_PHASES,
  assertText,
  assertUuid,
  now
});

const boardRefreshHandlers = createBoardRefreshHandlers();

const intakeHandlers = createIntakeHandlers({
  BindingError,
  READINESS,
  assertText,
  bindingMatchesExpected,
  compareDiscordIds,
  now
});

const interactionHandlers = createInteractionHandlers();
const decisionHandlers = createDecisionHandlers();

const threadEnrollmentHandlers = createThreadEnrollmentHandlers({
  BindingError,
  THREAD_STATES,
  READINESS,
  assertText,
  bindingMatchesExpected,
  compareDiscordIds,
  now
});

const courierRouteHandlers = createCourierRouteHandlers({
  BindingError,
  MESSAGE_STATES,
  PROVIDERS,
  READINESS,
  THREAD_STATES,
  assertText,
  assertUuid,
  assertProvider,
  parseJson,
  now
});

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

function replyBoundaryAllowed(text, end) {
  return end === text.length || !/[\uD800-\uDBFF]/.test(text[end - 1]);
}

function repartitionNonBlankReply(text) {
  if (!text.length) return [''];
  const nextVisible = new Array(text.length + 1).fill(text.length);
  let visible = text.length;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (/\S/u.test(text[index])) visible = index;
    nextVisible[index] = visible;
  }

  const canPartition = new Array(text.length + 1).fill(false);
  const reachableBoundaries = new Array(text.length + 2).fill(0);
  canPartition[text.length] = true;
  reachableBoundaries[text.length] = 1;
  for (let start = text.length - 1; start >= 0; start -= 1) {
    const firstVisible = nextVisible[start];
    const maxEnd = Math.min(text.length, start + REPLY_LIMIT);
    if (replyBoundaryAllowed(text, start) && firstVisible < text.length && firstVisible + 1 <= maxEnd) {
      const minEnd = firstVisible + 1;
      canPartition[start] = reachableBoundaries[minEnd] - reachableBoundaries[maxEnd + 1] > 0;
    }
    reachableBoundaries[start] = reachableBoundaries[start + 1] +
      (canPartition[start] && replyBoundaryAllowed(text, start) ? 1 : 0);
  }
  if (!canPartition[0]) return null;

  const parts = [];
  let start = 0;
  while (start < text.length) {
    const firstVisible = nextVisible[start];
    const maxEnd = Math.min(text.length, start + REPLY_LIMIT);
    let end = maxEnd;
    while (end > firstVisible && (!canPartition[end] || !replyBoundaryAllowed(text, end))) end -= 1;
    if (end <= firstVisible) return null;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
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
  if (parts.some(part => !part.trim())) return repartitionNonBlankReply(text) || parts;
  return parts;
}

function rowReplyPart(row) {
  let fileManifest = null;
  if (row.file_manifest !== null && row.file_manifest !== undefined) {
    fileManifest = parseJson(row.file_manifest, null);
    if (!fileManifest || typeof fileManifest !== 'object' || Array.isArray(fileManifest)) {
      throw new StateCorruptError('reply part file manifest is invalid');
    }
  }
  return {
    index: Number(row.part_index),
    content: row.content,
    nonce: row.nonce,
    state: row.state,
    messageId: row.message_id,
    error: row.error,
    fileManifest,
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
    deliveryChannelId: row.delivery_channel_id || row.channel_id,
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
    sessionRoot: row.session_root || null,
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
    (binding.sessionRoot || null) === (expected.sessionRoot || null) &&
    binding.conductorId === expected.conductorId && binding.repoKey === expected.repoKey;
}

function assertOrdinaryIdentity(provider, identity) {
  if (!identity || typeof identity.sessionId !== 'string' || typeof identity.threadId !== 'string' ||
    identity.sessionId !== identity.threadId) {
    throw new BindingError(`ordinary ${provider} identity is missing or conflicting`);
  }
  assertUuid(identity.sessionId, 'sessionId');
  assertUuid(identity.threadId, 'threadId');
  if (provider === PROVIDERS.CLAUDE && identity.harness !== 'claude-code') {
    throw new BindingError('ordinary Claude identity requires the claude-code harness');
  }
  return identity;
}

function assertOrdinaryNativeIdentity(provider, nativeId, identity) {
  if (identity.sessionId !== nativeId || identity.threadId !== nativeId) {
    const label = provider === PROVIDERS.CLAUDE ? 'Claude' : 'Codex';
    throw new BindingError(`ordinary ${label} identity does not match the native session`);
  }
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
      fs.chmodSync(dbPath, 0o600);
    } catch (error) {
      try { this.db?.close(); } catch {}
      throw new StateCorruptError(`state database is not usable: ${error.message}`);
    }
    this.dbPath = dbPath;
    this.failNextIntakeFlag = Boolean(options.failNextIntake);
    this.interactionVocabulary = Object.freeze({
      acceptedMessageState: MESSAGE_STATES.ACCEPTED,
      readyReadiness: READINESS.READY
    });
    this.ordinary = createOrdinaryRepository({ state: this, assertOrdinaryIdentity, assertOrdinaryNativeIdentity });
    this.ordinaryHandoffPauses = new Set();
    this.ordinaryHandoffPauseSnapshots = new Map();
  }

  bindOrdinary(...args) { return this._bindOrdinary(...args); }
  bindOrdinaryClaude(...args) { return this._bindOrdinaryClaude(...args); }
  rebindOrdinary(...args) { return this._rebindOrdinary(...args); }
  rebindOrdinaryClaude(...args) { return this._rebindOrdinaryClaude(...args); }
  isOrdinaryBindingRecord(...args) { return this._isOrdinaryBindingRecord(...args); }
  isOrdinaryBinding(...args) { return this._isOrdinaryBinding(...args); }
  hasOrdinaryPreflight(...args) { return this._hasOrdinaryPreflight(...args); }
  recordOrdinaryPreflight(...args) { return this._recordOrdinaryPreflight(...args); }
  findOrdinaryHandoff(...args) { return this._findOrdinaryHandoff(...args); }
  handoffOrdinary(...args) { return this._handoffOrdinary(...args); }

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
        session_root TEXT,
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
        delivery_channel_id TEXT,
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
      CREATE TABLE IF NOT EXISTS thread_enrollments (
        thread_id TEXT PRIMARY KEY,
        parent_channel_id TEXT NOT NULL REFERENCES bindings(channel_id),
        guild_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'ready', 'gap', 'unavailable')),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        adopted_through_id TEXT,
        adopted_at TEXT,
        last_seen_id TEXT,
        recovered_through_id TEXT,
        last_accepted_id TEXT,
        gap_from TEXT,
        gap_to TEXT,
        detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS thread_enrollments_parent_idx ON thread_enrollments(parent_channel_id, active);
      CREATE TABLE IF NOT EXISTS reply_parts (
        discord_id TEXT NOT NULL REFERENCES messages(discord_id),
        part_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        nonce TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
        message_id TEXT,
        error TEXT,
        file_manifest TEXT,
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
    this.ensureThreadEnrollmentSchema();
    this.ensureNativeReplyFileSchema();
    this.ensureDirectPostIndexes();
  }

  tableColumns(table) {
    return new Map(this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => [row.name, row]));
  }

  ensureThreadEnrollmentSchema() {
    const messages = this.tableColumns('messages');
    if (!messages.has('delivery_channel_id')) this.db.exec('ALTER TABLE messages ADD COLUMN delivery_channel_id TEXT');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_enrollments (
        thread_id TEXT PRIMARY KEY,
        parent_channel_id TEXT NOT NULL REFERENCES bindings(channel_id),
        guild_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'ready', 'gap', 'unavailable')),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        adopted_through_id TEXT,
        adopted_at TEXT,
        last_seen_id TEXT,
        recovered_through_id TEXT,
        last_accepted_id TEXT,
        gap_from TEXT,
        gap_to TEXT,
        detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS thread_enrollments_parent_idx ON thread_enrollments(parent_channel_id, active);
    `);
    this.db.prepare('UPDATE messages SET delivery_channel_id=channel_id WHERE delivery_channel_id IS NULL').run();
  }

  ensureNativeReplyFileSchema() {
    const columns = this.tableColumns('reply_parts');
    if (!columns.has('file_manifest')) this.db.exec('ALTER TABLE reply_parts ADD COLUMN file_manifest TEXT');
  }

  ensureDirectPostIndexes() {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS direct_post_outcome_message_idx
        ON receipts(json_extract(detail, '$.messageId')) WHERE kind='direct-post-outcome';
      CREATE INDEX IF NOT EXISTS direct_post_outcome_nonce_idx
        ON receipts(json_extract(detail, '$.nonce')) WHERE kind='direct-post-outcome';
      CREATE INDEX IF NOT EXISTS acknowledgment_receipt_idx
        ON receipts(kind, discord_id, id);
      CREATE INDEX IF NOT EXISTS receipts_channel_kind_idx
        ON receipts(json_extract(detail, '$.channelId'), kind);
      CREATE INDEX IF NOT EXISTS ordinary_bound_identity_idx
        ON receipts(
          json_extract(detail, '$.channelId'),
          json_extract(detail, '$.nativeId'),
          json_extract(detail, '$.workspace'),
          json_extract(detail, '$.generation')
        ) WHERE kind='ordinary-bound';
      CREATE INDEX IF NOT EXISTS ordinary_preflight_identity_idx
        ON receipts(
          json_extract(detail, '$.channelId'),
          json_extract(detail, '$.nativeId'),
          json_extract(detail, '$.workspace'),
          json_extract(detail, '$.generation'),
          json_extract(detail, '$.sessionRoot'),
          json_extract(detail, '$.outcome')
        ) WHERE kind='ordinary-native-preflight';
    `);
  }

  migrateSchema() {
    const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get();
    if (!version) throw new StateCorruptError('state schema metadata is missing');
    if (version.value !== '1.1' && version.value !== '1.2' && version.value !== '1.3' && version.value !== '1.4' && version.value !== '1.5' && version.value !== '1.6' && version.value !== '1.7' && version.value !== SCHEMA_VERSION) {
      throw new StateCorruptError(`unsupported state schema ${version.value}`);
    }
    if (version.value === SCHEMA_VERSION) {
      const bindings = this.tableColumns('bindings');
      if (!bindings.has('session_root')) this.db.exec('ALTER TABLE bindings ADD COLUMN session_root TEXT');
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
      this.ensureThreadEnrollmentSchema();
      this.ensureNativeReplyFileSchema();
      this.ensureDirectPostIndexes();
      return;
    }
    if (version.value === '1.7') {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.ensureNativeReplyFileSchema();
        this.db.prepare("UPDATE meta SET value=? WHERE key='schema'").run(SCHEMA_VERSION);
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      this.ensureDirectPostIndexes();
      return;
    }
    if (version.value === '1.6') {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.ensureThreadEnrollmentSchema();
        this.ensureNativeReplyFileSchema();
        this.db.prepare("UPDATE meta SET value=? WHERE key='schema'").run(SCHEMA_VERSION);
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      this.ensureDirectPostIndexes();
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
      if (!bindings.has('session_root')) this.db.exec('ALTER TABLE bindings ADD COLUMN session_root TEXT');
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
    this.ensureThreadEnrollmentSchema();
    this.ensureNativeReplyFileSchema();
    this.ensureDirectPostIndexes();
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
    const expected = ['meta', 'config', 'bindings', 'messages', 'reply_parts', 'provision_intents', 'intake_watermarks', 'receipts', 'topic_publications', 'thread_enrollments'];
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
      workspace: { type: 'TEXT', notnull: true }, session_root: { type: 'TEXT' }, conductor_id: { type: 'TEXT' }, repo_key: { type: 'TEXT' },
      readiness: { type: 'TEXT', notnull: true }, generation: { type: 'INTEGER', notnull: true },
      active: { type: 'INTEGER', notnull: true }, updated_at: { type: 'TEXT', notnull: true }
    });
    this.assertColumns('messages', {
      discord_id: { type: 'TEXT' }, guild_id: { type: 'TEXT', notnull: true },
      channel_id: { type: 'TEXT', notnull: true }, author_id: { type: 'TEXT', notnull: true },
      delivery_channel_id: { type: 'TEXT' },
      content: { type: 'TEXT', notnull: true }, attachments: { type: 'TEXT', notnull: true }, conductor_id: { type: 'TEXT' }, repo_key: { type: 'TEXT' }, state: { type: 'TEXT', notnull: true },
      reply_next_part: { type: 'INTEGER', notnull: true }, created_at: { type: 'TEXT', notnull: true },
      updated_at: { type: 'TEXT', notnull: true }
    });
    this.assertColumns('reply_parts', {
      discord_id: { type: 'TEXT', notnull: true }, part_index: { type: 'INTEGER', notnull: true },
      content: { type: 'TEXT', notnull: true }, nonce: { type: 'TEXT', notnull: true },
      state: { type: 'TEXT', notnull: true }, file_manifest: { type: 'TEXT' }, updated_at: { type: 'TEXT', notnull: true }
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
    this.assertColumns('thread_enrollments', {
      thread_id: { type: 'TEXT' }, parent_channel_id: { type: 'TEXT', notnull: true },
      guild_id: { type: 'TEXT', notnull: true }, state: { type: 'TEXT', notnull: true },
      active: { type: 'INTEGER', notnull: true }, adopted_through_id: { type: 'TEXT' },
      adopted_at: { type: 'TEXT' }, last_seen_id: { type: 'TEXT' },
      recovered_through_id: { type: 'TEXT' }, last_accepted_id: { type: 'TEXT' },
      gap_from: { type: 'TEXT' }, gap_to: { type: 'TEXT' }, detail: { type: 'TEXT' },
      created_at: { type: 'TEXT', notnull: true }, updated_at: { type: 'TEXT', notnull: true }
    });
    this.assertForeignKey('messages', 'channel_id', 'bindings', 'channel_id');
    this.assertForeignKey('thread_enrollments', 'parent_channel_id', 'bindings', 'channel_id');
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
    const threadTable = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='thread_enrollments'").get();
    if (!threadTable?.sql || !/CHECK\s*\(state\s+IN\s*\('pending',\s*'ready',\s*'gap',\s*'unavailable'\)\)/i.test(threadTable.sql)) {
      throw new StateCorruptError('thread enrollment state constraints are missing');
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
    let sessionRoot;
    if (binding.sessionRoot === undefined) sessionRoot = existing?.sessionRoot || null;
    else if (binding.sessionRoot === null) sessionRoot = null;
    else sessionRoot = assertText(binding.sessionRoot, 'sessionRoot', 4096);
    if (sessionRoot !== null && !path.isAbsolute(sessionRoot)) throw new BindingError('sessionRoot must be absolute');
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
    return { channelId, guildId, provider, nativeId, workspace, sessionRoot, endpoint, categoryId, conductorId, repoKey, readiness, generation };
  }

  bind(binding, options = {}) {
    const ordinaryIdentity = binding.ordinaryIdentity || null;
    const intakeCutoff = options.intakeCutoff ?? null;
    const intakeCutoffDetail = options.intakeCutoffDetail || null;
    const beforeMutation = options.beforeMutation;
    const input = this.bindingInput(binding);
    if (intakeCutoff !== null) assertText(intakeCutoff, 'lastSeenId', 128);
    if (ordinaryIdentity) {
      if (input.conductorId || input.repoKey) throw new BindingError(`ordinary ${input.provider} bindings cannot carry conductor identity`);
      assertOrdinaryIdentity(input.provider, ordinaryIdentity);
      assertOrdinaryNativeIdentity(input.provider, input.nativeId, ordinaryIdentity);
    }
    const existing = this.getBinding(input.channelId);
    if (existing) throw new BindingError('channel is already bound; use rebind after work drains');
    if (this.db.prepare('SELECT 1 FROM thread_enrollments WHERE thread_id=? AND active=1').get(input.channelId)) {
      throw new BindingError('thread channel is already enrolled');
    }
    this.assertNativeOwnerFree(input.provider, input.nativeId);
    this.assertConductorOwnerFree(input.provider, input.conductorId);
    const createdAt = now();
    return this.transaction(() => {
      if (this.getBinding(input.channelId)) throw new BindingError('channel is already bound; use rebind after work drains');
      if (this.db.prepare('SELECT 1 FROM thread_enrollments WHERE thread_id=? AND active=1').get(input.channelId)) {
        throw new BindingError('thread channel is already enrolled');
      }
      this.assertNativeOwnerFree(input.provider, input.nativeId);
      const generationRow = input.conductorId
        ? this.db.prepare('SELECT COALESCE(MAX(generation), 0) + 1 AS next FROM bindings WHERE provider=? AND conductor_id=?').get(input.provider, input.conductorId)
        : this.db.prepare('SELECT COALESCE(MAX(generation), 0) + 1 AS next FROM bindings WHERE channel_id=?').get(input.channelId);
      const nextGeneration = Number(generationRow.next);
      const generation = input.generation == null ? nextGeneration : input.generation;
      if (generation < nextGeneration) throw new BindingError('binding generation would move backwards');
      if (typeof beforeMutation === 'function') beforeMutation();
      this.db.prepare(`INSERT INTO bindings(channel_id, guild_id, provider, native_id, workspace, session_root, endpoint, category_id, conductor_id, repo_key, readiness, generation, active, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(input.channelId, input.guildId, input.provider, input.nativeId, input.workspace, input.sessionRoot, input.endpoint, input.categoryId, input.conductorId, input.repoKey, input.readiness, generation, createdAt);
      this.receipt(null, 'bound', { channelId: input.channelId, provider: input.provider, conductorId: input.conductorId, generation });
      if (ordinaryIdentity) {
        this.receipt(null, ORDINARY_RECEIPT_KINDS.BOUND, {
          channelId: input.channelId, guildId: input.guildId, provider: input.provider,
          nativeId: input.nativeId, workspace: input.workspace, generation,
          sessionRoot: input.sessionRoot,
          sessionId: ordinaryIdentity.sessionId, threadId: ordinaryIdentity.threadId,
          harness: ordinaryIdentity.harness || undefined, endpoint: input.endpoint || undefined
        });
      }
      if (intakeCutoff !== null) {
        this.setIntakeCutoffInTransaction(input.channelId, input.guildId, intakeCutoff, intakeCutoffDetail);
      }
      return this.getBinding(input.channelId);
    });
  }

  _bindOrdinary(binding, identity, adoptionCutoff = null, options = {}) {
    return ordinaryBindingHandlers.bindOrdinary(this, binding, identity, adoptionCutoff, options);
  }

  _bindOrdinaryClaude(binding, identity, adoptionCutoff = null, options = {}) {
    if (binding.conductorId != null || binding.repoKey != null) throw new BindingError('ordinary bindings cannot carry conductor identity');
    assertOrdinaryIdentity(PROVIDERS.CLAUDE, identity);
    assertOrdinaryNativeIdentity(PROVIDERS.CLAUDE, binding.nativeId, identity);
    return this.bind({ ...binding, provider: PROVIDERS.CLAUDE, conductorId: null, repoKey: null, readiness: READINESS.PENDING, ordinaryIdentity: identity }, adoptionCutoff === null ? options : {
      intakeCutoff: adoptionCutoff,
      intakeCutoffDetail: 'ordinary binding adoption cutoff',
      beforeMutation: options.beforeMutation
    });
  }

  _rebindOrdinary(binding, identity, nativeProof = null, intakeCutoff = null, options = {}) {
    return ordinaryBindingHandlers.rebindOrdinary(this, binding, identity, nativeProof, intakeCutoff, options);
  }

  _rebindOrdinaryClaude(binding, identity, intakeCutoff = null, options = {}) {
    if (binding.conductorId != null || binding.repoKey != null) throw new BindingError('ordinary bindings cannot carry conductor identity');
    assertOrdinaryIdentity(PROVIDERS.CLAUDE, identity);
    const existing = this.getBinding(binding.channelId);
    if (!existing || existing.active || !this._isOrdinaryBindingRecord(existing)) {
      throw new BindingError('ordinary binding tombstone is unavailable for reuse');
    }
    if (existing.guildId !== binding.guildId || existing.provider !== PROVIDERS.CLAUDE ||
      existing.nativeId !== binding.nativeId || existing.workspace !== binding.workspace || existing.endpoint !== binding.endpoint ||
      identity.sessionId !== existing.nativeId || identity.threadId !== existing.nativeId) {
      throw new BindingError('ordinary binding owner changed; use explicit handoff');
    }
    return this.rebind({ ...binding, provider: PROVIDERS.CLAUDE, conductorId: null, repoKey: null, readiness: READINESS.PENDING, ordinaryIdentity: identity }, {
      intakeCutoff,
      beforeMutation: options.beforeMutation
    });
  }

  _isOrdinaryBindingRecord(binding) {
    if (binding?.provider === PROVIDERS.CODEX) return ordinaryBindingHandlers.isOrdinaryBindingRecord(this, binding);
    if (!binding || !Object.values(PROVIDERS).includes(binding.provider) || binding.conductorId || binding.repoKey) return false;
    return Boolean(this.db.prepare(`SELECT 1 FROM receipts
      WHERE kind=?
        AND json_extract(detail, '$.channelId')=?
        AND json_extract(detail, '$.provider')=?
        AND json_extract(detail, '$.nativeId')=?
        AND json_extract(detail, '$.workspace')=?
        AND json_extract(detail, '$.generation')=?
      LIMIT 1`).get(ORDINARY_RECEIPT_KINDS.BOUND, binding.channelId, binding.provider, binding.nativeId, binding.workspace, binding.generation));
  }

  _isOrdinaryBinding(binding) {
    if (binding?.provider === PROVIDERS.CODEX) return ordinaryBindingHandlers.isOrdinaryBinding(this, binding);
    return Boolean(binding?.active) && this._isOrdinaryBindingRecord(binding);
  }

  _hasOrdinaryPreflight(binding) {
    if (binding?.provider === PROVIDERS.CODEX) return ordinaryBindingHandlers.hasOrdinaryPreflight(this, binding);
    if (!this._isOrdinaryBinding(binding)) return false;
    return Boolean(this.db.prepare(`SELECT 1 FROM receipts
      WHERE kind=?
        AND json_extract(detail, '$.channelId')=?
        AND json_extract(detail, '$.provider')=?
        AND json_extract(detail, '$.nativeId')=?
        AND json_extract(detail, '$.workspace')=?
        AND json_extract(detail, '$.generation')=?
        AND json_extract(detail, '$.sessionRoot') IS ?
        AND json_extract(detail, '$.outcome')='verified'
      LIMIT 1`).get(ORDINARY_RECEIPT_KINDS.NATIVE_PREFLIGHT, binding.channelId, binding.provider, binding.nativeId, binding.workspace, binding.generation, binding.sessionRoot || null));
  }

  _recordOrdinaryPreflight(binding, detail = {}) {
    if (binding?.provider === PROVIDERS.CODEX) return ordinaryBindingHandlers.recordOrdinaryPreflight(this, binding, detail);
    return this.transaction(() => {
      const current = this.getBinding(binding?.channelId);
      if (!bindingMatchesExpected(current, binding)) return null;
      if (!this._isOrdinaryBinding(current)) throw new BindingError(`binding is not an ordinary ${current?.provider || 'native'} binding`);
      if (!detail || typeof detail !== 'object' || typeof detail.file !== 'string' || !path.isAbsolute(detail.file) ||
        detail.sessionId !== current.nativeId || detail.threadId !== current.nativeId || detail.workspace !== current.workspace) {
        throw new BindingError(`ordinary ${current.provider} native preflight proof does not match the binding`);
      }
      if (current.provider === PROVIDERS.CLAUDE && (detail.harness !== 'claude-code' || detail.endpoint !== current.endpoint)) {
        throw new BindingError('ordinary Claude native preflight proof does not match the binding');
      }
      this.receipt(null, ORDINARY_RECEIPT_KINDS.NATIVE_PREFLIGHT, {
        ...detail,
        channelId: current.channelId, guildId: current.guildId, provider: current.provider,
        nativeId: current.nativeId, workspace: current.workspace, generation: current.generation,
        sessionRoot: current.sessionRoot || null,
        outcome: 'verified'
      });
      return current;
    });
  }

  rebind(binding, {
    resetIntake = false,
    sessionRootOverride = undefined,
    intakeCutoff = null,
    enrollmentProof = null,
    beforeMutation = undefined,
    rejectUnresolvedOrdinaryPost = false
  } = {}) {
    if (intakeCutoff !== null) assertText(intakeCutoff, 'lastSeenId', 128);
    const channelId = assertText(binding.channelId, 'channelId', 128);
    if (this.db.prepare('SELECT 1 FROM thread_enrollments WHERE thread_id=? AND active=1').get(channelId)) {
      throw new BindingError('thread channel is already enrolled');
    }
    const existing = this.getBinding(channelId);
    if (!existing) throw new BindingError('channel is not bound');
    if (this.hasUnresolved(channelId)) throw new UnresolvedWorkError('cannot rebind while work drains');
    if (this._hasActiveThreadEnrollments(channelId) && intakeCutoff === null) {
      throw new BindingError('active thread enrollments require an observed intake cutoff');
    }
    const ordinaryIdentity = binding.ordinaryIdentity || null;
    if (ordinaryIdentity) {
      if (binding.conductorId || binding.repoKey) throw new BindingError(`ordinary ${binding.provider} bindings cannot carry conductor identity`);
      assertOrdinaryIdentity(binding.provider, ordinaryIdentity);
    }
    const input = this.bindingInput({ ...binding, channelId }, existing);
    if (sessionRootOverride !== undefined) input.sessionRoot = sessionRootOverride;
    const ordinary = this._isOrdinaryBindingRecord(existing);
    const ordinaryIdentityMatches = input.nativeId === existing.nativeId &&
      ordinaryIdentity?.sessionId === existing.nativeId && ordinaryIdentity?.threadId === existing.nativeId;
    if (ordinary && existing.provider === PROVIDERS.CODEX && (!ordinaryIdentity || input.provider !== PROVIDERS.CODEX || input.conductorId || input.repoKey ||
      !ordinaryIdentityMatches)) {
      throw new BindingError('ordinary bindings require matching invocation identity');
    }
    if (ordinary && existing.provider === PROVIDERS.CLAUDE && (!ordinaryIdentity || input.provider !== PROVIDERS.CLAUDE || input.conductorId || input.repoKey ||
      input.nativeId !== existing.nativeId || input.workspace !== existing.workspace || input.endpoint !== existing.endpoint ||
      ordinaryIdentity.sessionId !== existing.nativeId || ordinaryIdentity.threadId !== existing.nativeId)) {
      throw new BindingError('ordinary Claude bindings require matching owner and endpoint');
    }
    this.assertNativeOwnerFree(input.provider, input.nativeId, channelId);
    if (existing.conductorId !== input.conductorId || existing.repoKey !== input.repoKey) throw new BindingError('conductor identity changes require an explicit handoff');
    if (existing.conductorId && existing.provider !== input.provider) throw new BindingError('conductor provider changes require an explicit handoff');
    const generation = existing.generation + 1;
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM thread_enrollments WHERE thread_id=? AND active=1').get(channelId)) {
        throw new BindingError('thread channel is already enrolled');
      }
      const current = this.getBinding(channelId);
      if (!bindingMatchesExpected(current, existing)) throw new StaleGenerationError('rebind source identity is stale');
      if (this.hasUnresolved(channelId)) throw new UnresolvedWorkError('cannot rebind while work drains');
      if (this._hasActiveThreadEnrollments(channelId) && intakeCutoff === null) {
        throw new BindingError('active thread enrollments require an observed intake cutoff');
      }
      if (rejectUnresolvedOrdinaryPost && ordinary && this.hasUnresolvedOrdinaryPost(channelId)) {
        throw new UnresolvedWorkError('cannot rebind while an ordinary post is unresolved');
      }
      this.assertLegacyMigrationSafe(channelId);
      this.assertNativeOwnerFree(input.provider, input.nativeId, channelId);
      if (typeof beforeMutation === 'function') beforeMutation();
      if (intakeCutoff !== null) {
        if (enrollmentProof) this.assertThreadEnrollmentCoverage(channelId, enrollmentProof);
        const updatedAt = now();
        this.setIntakeCutoffInTransaction(channelId, input.guildId, intakeCutoff, 'parent rebind intake fence', current);
        ordinaryBindingHandlers.advanceEnrolledThreadCutoffs(this, channelId, intakeCutoff, updatedAt);
      }
      this.db.prepare(`UPDATE bindings SET guild_id=?, provider=?, native_id=?, workspace=?, session_root=?, endpoint=?, category_id=?, readiness=?, generation=?, active=1, updated_at=? WHERE channel_id=?`)
        .run(input.guildId, input.provider, input.nativeId, input.workspace, input.sessionRoot, input.endpoint, input.categoryId, READINESS.PENDING, generation, now(), channelId);
      this.receipt(null, 'rebound', { channelId, conductorId: input.conductorId, generation, intakeCutoff: intakeCutoff || undefined });
      if (ordinary && !input.conductorId && !input.repoKey) {
        this.receipt(null, ORDINARY_RECEIPT_KINDS.BOUND, {
          channelId, guildId: input.guildId, provider: input.provider, nativeId: input.nativeId,
          workspace: input.workspace, generation,
          sessionRoot: input.sessionRoot,
          sessionId: ordinaryIdentity?.sessionId || input.nativeId,
          threadId: ordinaryIdentity?.threadId || input.nativeId,
          harness: ordinaryIdentity?.harness || undefined, endpoint: input.endpoint || undefined
        });
      }
      if (resetIntake) {
        this.db.prepare("UPDATE intake_watermarks SET state='pending', detail=?, gap_from=NULL, gap_to=NULL, updated_at=? WHERE channel_id=?")
          .run('binding generation changed; intake recovery reopened', now(), channelId);
      }
      return this.getBinding(channelId);
    });
  }

  unbind(channelId, { expectedBinding = undefined, intakeCutoff = null } = {}) {
    assertText(channelId, 'channelId', 128);
    if (intakeCutoff !== null) assertText(intakeCutoff, 'lastSeenId', 128);
    const binding = this.getBinding(channelId);
    if (!binding) throw new BindingError('channel is not bound');
    if (expectedBinding !== undefined && !bindingMatchesExpected(binding, expectedBinding)) {
      throw new StaleGenerationError('unbind source identity is stale');
    }
    if (this.hasUnresolved(channelId) || this.hasUnresolvedOrdinaryPost(channelId)) {
      throw new UnresolvedWorkError('cannot unbind while work is unresolved');
    }
    return this.transaction(() => {
      const current = this.getBinding(channelId);
      const expected = expectedBinding === undefined ? binding : expectedBinding;
      if (!bindingMatchesExpected(current, expected)) throw new StaleGenerationError('unbind source identity is stale');
      if (!current.active) {
        threadEnrollmentHandlers.deactivateThreadEnrollments(this, channelId, current);
        return true;
      }
      if (this.hasUnresolved(channelId) || this.hasUnresolvedOrdinaryPost(channelId)) {
        throw new UnresolvedWorkError('cannot unbind while work is unresolved');
      }
      this.assertLegacyMigrationSafe(channelId);
      if (intakeCutoff !== null) {
        this.setIntakeCutoffInTransaction(channelId, current.guildId, intakeCutoff, 'ordinary unbind intake fence', current);
        this.db.prepare("UPDATE intake_watermarks SET state='ready', updated_at=? WHERE channel_id=?")
          .run(now(), channelId);
      }
      threadEnrollmentHandlers.deactivateThreadEnrollments(this, channelId, current);
      this.db.prepare('UPDATE bindings SET active=0, updated_at=? WHERE channel_id=?').run(now(), channelId);
      this.receipt(null, 'unbound', {
        channelId, generation: current.generation,
        intakeCutoff: intakeCutoff || undefined
      });
      return true;
    });
  }

  getBinding(channelId) {
    return rowBinding(this.db.prepare('SELECT * FROM bindings WHERE channel_id=?').get(channelId));
  }

  listBindings() {
    return this.db.prepare('SELECT * FROM bindings ORDER BY channel_id').all().map(rowBinding);
  }

  getMessageRoute(deliveryChannelId) {
    return threadEnrollmentHandlers.getMessageRoute(this, deliveryChannelId);
  }

  enrollThread(input, expectedBinding = null) {
    return threadEnrollmentHandlers.enrollThread(this, input, expectedBinding);
  }

  getThreadEnrollment(threadId) {
    return threadEnrollmentHandlers.getThreadEnrollment(this, threadId);
  }

  listThreadEnrollments(parentChannelId = null) {
    return threadEnrollmentHandlers.listThreadEnrollments(this, parentChannelId);
  }

  assertThreadEnrollmentCoverage(parentChannelId, proof) {
    return threadEnrollmentHandlers.assertEnrollmentCoverage(this, parentChannelId, proof);
  }

  deactivateThreadEnrollments(parentChannelId, expectedBinding = null) {
    return threadEnrollmentHandlers.deactivateThreadEnrollments(this, parentChannelId, expectedBinding);
  }

  _hasActiveThreadEnrollments(parentChannelId) {
    return Boolean(this.db.prepare('SELECT 1 FROM thread_enrollments WHERE parent_channel_id=? AND active=1 LIMIT 1').get(parentChannelId));
  }

  setThreadBaseline(threadId, latestId, expectedBinding = null) {
    return threadEnrollmentHandlers.setThreadBaseline(this, threadId, latestId, expectedBinding);
  }

  markThreadBoundary(threadId, state, detail = null, gapFrom = null, gapTo = null, expectedBinding = null, coverageId = undefined, lastSeenBaselineId = undefined) {
    return threadEnrollmentHandlers.markThreadBoundary(this, threadId, state, detail, gapFrom, gapTo, expectedBinding, coverageId, lastSeenBaselineId);
  }

  checkpointThread(threadId, coverageId, expectedBinding = null) {
    return threadEnrollmentHandlers.checkpointThread(this, threadId, coverageId, expectedBinding);
  }

  registerCourierRoute(...args) {
    return courierRouteHandlers.registerCourierRoute(this, ...args);
  }

  revokeCourierRoute(...args) {
    return courierRouteHandlers.revokeCourierRoute(this, ...args);
  }

  listCourierRoutes(...args) {
    return courierRouteHandlers.listCourierRoutes(this, ...args);
  }

  getCourierRoute(...args) {
    return courierRouteHandlers.getCourierRoute(this, ...args);
  }

  getCourierAttempt(...args) {
    return courierRouteHandlers.getCourierAttempt(this, ...args);
  }

  beginCourierAttempt(...args) {
    return courierRouteHandlers.beginCourierAttempt(this, ...args);
  }

  authorizeCourierAttempt(...args) {
    return courierRouteHandlers.authorizeCourierAttempt(this, ...args);
  }

  recordCourierOutcome(...args) {
    return courierRouteHandlers.recordCourierOutcome(this, ...args);
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
      if (readiness === READINESS.READY && this._isOrdinaryBinding(binding) && !this._hasOrdinaryPreflight(binding)) {
        throw new BindingError(`ordinary ${binding.provider} native preflight is required before READY`);
      }
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

  _findOrdinaryHandoff(handoffId) {
    assertText(handoffId, 'handoffId', 256);
    const rows = this.db.prepare('SELECT detail FROM receipts WHERE kind=? ORDER BY id DESC').all(ORDINARY_RECEIPT_KINDS.HANDOFF);
    for (const row of rows) {
      const detail = parseJson(row.detail, {});
      if (detail.handoffId === handoffId) return detail;
    }
    return null;
  }

  hasUnboundReceipt(channelId, generation) {
    const rows = this.db.prepare("SELECT detail FROM receipts WHERE kind='unbound' ORDER BY id DESC").all();
    return rows.some(row => {
      const detail = parseJson(row.detail, {});
      return detail.channelId === channelId && detail.generation === generation;
    });
  }

  _handoffOrdinary(input) {
    return ordinaryBindingHandlers.handoffOrdinary(this, input);
  }

  handoffConductor({ channelId, provider, conductorId, repoKey, fromNativeId, fromGeneration, nativeId, workspace, endpoint, handoffId, intakeCutoff = null, enrollmentProof = null }) {
    assertUuid(fromNativeId, 'fromNativeId');
    if (!Number.isInteger(fromGeneration) || fromGeneration < 1) throw new BindingError('fromGeneration must be a positive integer');
    assertText(handoffId, 'handoffId', 256);
    if (intakeCutoff !== null) assertText(intakeCutoff, 'lastSeenId', 128);
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
    if (this._hasActiveThreadEnrollments(channelId) && intakeCutoff === null) {
      throw new BindingError('active thread enrollments require an observed intake cutoff');
    }
    if (nativeId === fromNativeId) throw new BindingError('successor handoff requires a different native session UUID');
    if (this.hasUnresolved(channelId)) throw new UnresolvedWorkError('cannot handoff while work is unresolved');
    this.assertNativeOwnerFree(provider, nativeId, channelId);
    return this.transaction(() => {
      const current = this.getBinding(channelId);
      if (!bindingMatchesExpected(current, existing)) throw new StaleGenerationError('handoff source identity is stale');
      if (this.hasUnresolved(channelId)) throw new UnresolvedWorkError('cannot handoff while work is unresolved');
      if (this._hasActiveThreadEnrollments(channelId) && intakeCutoff === null) {
        throw new BindingError('active thread enrollments require an observed intake cutoff');
      }
      this.assertLegacyMigrationSafe(channelId);
      if (enrollmentProof) this.assertThreadEnrollmentCoverage(channelId, enrollmentProof);
      const generation = existing.generation + 1;
      const updatedAt = now();
      if (intakeCutoff !== null) {
        this.setIntakeCutoffInTransaction(channelId, current.guildId, intakeCutoff, 'conductor handoff intake fence', current);
        ordinaryBindingHandlers.advanceEnrolledThreadCutoffs(this, channelId, intakeCutoff, updatedAt);
      }
      this.db.prepare(`UPDATE bindings SET native_id=?, workspace=?, session_root=?, endpoint=?, readiness=?, generation=?, updated_at=? WHERE channel_id=? AND provider=? AND conductor_id=? AND generation=? AND native_id=?`)
        .run(input.nativeId, input.workspace, input.sessionRoot, input.endpoint, READINESS.PENDING, generation, updatedAt, channelId, provider, conductorId, fromGeneration, fromNativeId);
      this.receipt(null, 'conductor-handoff', {
        channelId, conductorId, repoKey, provider, handoffId,
        fromNativeId, fromGeneration, nativeId: input.nativeId, generation, intakeCutoff: intakeCutoff || undefined
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
    if (row) return true;
    return this.listDecisionPendingWork().some(click => click.channelId === channelId && !this.getMessage(click.interactionId)?.decisionResult);
  }

  hasDispatching(channelId) {
    return Boolean(this.db.prepare('SELECT 1 FROM messages WHERE channel_id=? AND state=? LIMIT 1')
      .get(channelId, MESSAGE_STATES.DISPATCHING));
  }

  hasSubmitted(channelId) {
    return Boolean(this.db.prepare('SELECT 1 FROM messages WHERE channel_id=? AND state=? LIMIT 1')
      .get(channelId, MESSAGE_STATES.SUBMITTED));
  }

  hasUncertain(channelId) {
    return Boolean(this.db.prepare('SELECT 1 FROM messages WHERE channel_id=? AND state=? LIMIT 1')
      .get(channelId, MESSAGE_STATES.UNCERTAIN));
  }

  hasUnresolvedOrdinaryPost(channelId) {
    return directPostHandlers.hasUnresolvedOrdinaryPost(this, channelId);
  }

  reject(reason) {
    return { accepted: false, reason };
  }

  upsertIntakeWatermark(event, ready, coverageId = null) {
    const existing = this.db.prepare('SELECT * FROM intake_watermarks WHERE channel_id=?').get(event.channelId);
    const lastSeen = existing?.last_seen_id && compareDiscordIds(existing.last_seen_id, event.id) >= 0 ? existing.last_seen_id : event.id;
    const confirmedCoverageId = coverageId;
    const recoveredThrough = confirmedCoverageId && (!existing?.recovered_through_id || compareDiscordIds(existing.recovered_through_id, confirmedCoverageId) < 0)
      ? confirmedCoverageId
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

  hasIntakeEvidence(discordId) {
    return intakeHandlers.hasIntakeEvidence(this, discordId);
  }

  checkpointIntake(channelId, coverageId, expectedBinding = null) {
    return intakeHandlers.checkpointIntake(this, channelId, coverageId, expectedBinding);
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

  setIntakeCutoff(channelId, guildId, lastSeenId, detail, expectedBinding = undefined) {
    return intakeHandlers.setIntakeCutoff(this, channelId, guildId, lastSeenId, detail, expectedBinding);
  }

  setIntakeCutoffInTransaction(channelId, guildId, lastSeenId, detail, expectedBinding = undefined) {
    return intakeHandlers.setIntakeCutoffInTransaction(this, channelId, guildId, lastSeenId, detail, expectedBinding);
  }

  listIntakeWatermarks() {
    return this.db.prepare('SELECT * FROM intake_watermarks ORDER BY channel_id').all();
  }

  listPendingOrdinaryHandoffChannels() {
    return intakeHandlers.listPendingOrdinaryHandoffChannels(this);
  }

  markIntakeBoundary(channelId, state, detail = null, gapFrom = null, gapTo = null, expectedBinding = null, pauseMetadata = null) {
    return intakeHandlers.markIntakeBoundary(this, channelId, state, detail, gapFrom, gapTo, expectedBinding, pauseMetadata);
  }

  pauseOrdinaryHandoffIntake(channelId, expectedBinding = null) {
    return pauseOrdinaryHandoffIntake(
      this,
      channelId,
      expectedBinding,
      READINESS.PENDING,
      INTAKE_BOUNDARY_DETAILS.ORDINARY_HANDOFF
    );
  }

  restoreOrdinaryHandoffIntake(channelId, expectedBinding = null) {
    return restoreOrdinaryHandoffIntake(this, channelId, expectedBinding);
  }

  recoverInterruptedOrdinaryHandoffIntake(channelId, expectedBinding = null) {
    return recoverInterruptedOrdinaryHandoffIntake(
      this,
      channelId,
      expectedBinding,
      READINESS.READY,
      INTAKE_BOUNDARY_DETAILS.ORDINARY_HANDOFF
    );
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

  reconcileIntake(channelId, expectedBinding = null) {
    const childEnrollment = typeof channelId === 'string' && channelId.length > 0 && channelId.length <= 128
      ? this.db.prepare('SELECT 1 FROM thread_enrollments WHERE thread_id=? AND active=1').get(channelId)
      : null;
    if (childEnrollment) {
      return threadEnrollmentHandlers.reconcileThread(this, channelId, expectedBinding);
    }
    return intakeHandlers.reconcileIntake(this, channelId, expectedBinding);
  }

  acceptDiscordMessage(event, { ready = true, coverageId = null, expectedBinding = null, agentToken = null } = {}) {
    const config = this.requireConfig();
    if (coverageId !== null) assertText(coverageId, 'coverageId', 128);
    const routeHint = typeof event?.channelId === 'string' && event.channelId.length > 0
      ? this.getMessageRoute(event.channelId)
      : null;
    const authorityHint = routeHint?.binding?.channelId || event?.channelId;
    if (typeof authorityHint === 'string') this.recoverInterruptedOrdinaryHandoffIntake(authorityHint, expectedBinding);
    let attachments;
    try { attachments = normalizeAttachments(event?.attachments); } catch { attachments = null; }
    const validEvent = event && [event.id, event.guildId, event.channelId, event.authorId].every(value => typeof value === 'string' && value.length > 0) &&
      typeof event.content === 'string' && event.content.length <= 10000 && attachments !== null && (event.content.length > 0 || attachments.length > 0);
    if (!validEvent) {
      if (event && [event.id, event.guildId, event.channelId].every(value => typeof value === 'string' && value.length > 0)) {
        const result = this.transaction(() => {
          const route = this.getMessageRoute(event.channelId);
          const binding = route?.binding || this.getBinding(event.channelId);
          const enrollment = route?.enrollment || null;
          const authorityChannelId = binding?.channelId || event.channelId;
          if (!bindingMatchesExpected(binding, expectedBinding)) return { accepted: false, stale: true, reason: 'stale-binding' };
          if (this.ordinaryHandoffPauses.has(authorityChannelId) || this.getIntakeWatermark(authorityChannelId)?.detail === INTAKE_BOUNDARY_DETAILS.ORDINARY_HANDOFF) {
            if (enrollment) threadEnrollmentHandlers.noteThreadMessage(this, enrollment.threadId, event.id, false);
            else this.upsertIntakeWatermark(event, false, null);
            this.receipt(null, 'intake-rejected', {
              discordId: event.id, channelId: authorityChannelId,
              ...(enrollment ? { deliveryChannelId: event.channelId } : {}),
              reason: 'handoff-intake-paused', ready
            });
            return this.reject('handoff-intake-paused');
          }
          if (enrollment) threadEnrollmentHandlers.noteThreadMessage(this, enrollment.threadId, event.id, false, coverageId);
          else this.upsertIntakeWatermark(event, ready, coverageId);
          this.receipt(null, 'intake-rejected', {
            discordId: event.id, channelId: authorityChannelId,
            ...(enrollment ? { deliveryChannelId: event.channelId } : {}),
            reason: 'invalid-event', ready
          });
          return null;
        });
        if (result?.stale) return result;
      }
      return this.reject('invalid-event');
    }
    const isWatcherNotice = Boolean(event.isBot && event.content.startsWith(WATCHER_NOTICE_PREFIX));
    const directPost = isWatcherNotice ? false : this.excludeDirectPost(event);
    return this.transaction(() => {
      const route = this.getMessageRoute(event.channelId);
      const binding = route?.binding || this.getBinding(event.channelId);
      const enrollment = route?.enrollment || null;
      const authorityChannelId = binding?.channelId || event.channelId;
      if (!bindingMatchesExpected(binding, expectedBinding)) return { accepted: false, stale: true, reason: 'stale-binding' };
      const handoffPaused = this.ordinaryHandoffPauses.has(authorityChannelId) ||
        this.getIntakeWatermark(authorityChannelId)?.detail === INTAKE_BOUNDARY_DETAILS.ORDINARY_HANDOFF;
      if (handoffPaused && !enrollment) {
        this.upsertIntakeWatermark(event, false, null);
        this.receipt(null, 'intake-rejected', {
          discordId: event.id, channelId: authorityChannelId,
          ...(enrollment ? { deliveryChannelId: event.channelId } : {}),
          reason: 'handoff-intake-paused', ready
        });
        return this.reject('handoff-intake-paused');
      }
      if (handoffPaused) {
        ready = false;
        coverageId = null;
      }
      const parentCutoff = route?.handoffCutoffId || null;
      let intakeCutoff = enrollment
        ? enrollment.recoveredThroughId
        : this.getIntakeWatermark(authorityChannelId)?.recovered_through_id || null;
      if (enrollment && parentCutoff && (!intakeCutoff || compareDiscordIds(intakeCutoff, parentCutoff) < 0)) {
        intakeCutoff = parentCutoff;
      }
      if (enrollment) threadEnrollmentHandlers.noteThreadMessage(this, enrollment.threadId, event.id, false, coverageId);
      else this.upsertIntakeWatermark(event, ready, coverageId);
      let agent = null;
      let invalidAgent = false;
      let notice = null;
      let invalidNotice = false;
      if (event.isBot && event.content.startsWith(AGENT_PREFIX)) {
        try {
          const target = binding && Object.fromEntries(['guildId', 'channelId', 'provider', 'nativeId', 'generation']
            .map(key => [key, key === 'channelId' ? event.channelId : binding[key]]));
          agent = decodeAgentMessage(event.content, agentToken, target);
          if (attachments.length) throw new BindingError('agent attachments are not supported');
        } catch { invalidAgent = true; }
      }
      if (isWatcherNotice) {
        try {
          const target = binding && Object.fromEntries(['guildId', 'channelId', 'provider', 'nativeId', 'generation']
            .map(key => [key, key === 'channelId' ? event.channelId : binding[key]]));
          notice = decodeWatcherNotice(event.content, agentToken, target);
          if (!notice) throw new BindingError('watcher notice is missing');
          watcherNoticeHandlers.authorizeWatcherNoticePublication(this, notice, event);
          if (attachments.length) throw new BindingError('watcher notice attachments are not supported');
        } catch { invalidNotice = true; }
      }
      let reason = invalidAgent || invalidNotice ? 'invalid-event' : null;
      if (typeof event.content !== 'string' || event.content.length > 10000 || attachments === null || (event.content.length === 0 && attachments?.length === 0)) reason = 'invalid-event';
      else if (enrollment && event.isBot && !agent && !notice) reason = 'bot-source';
      else if (!agent && !notice && directPost) reason = 'automatic-publication';
      else if (!agent && !notice && event.isBot) reason = 'bot-source';
      else if (event.guildId !== config.guildId || (!agent && !notice && event.authorId !== config.operatorId)) reason = 'unauthorized-sender';
      if (!reason && (!binding || !binding.active || binding.guildId !== event.guildId)) reason = 'unknown-binding';
      if (!reason && enrollment && [THREAD_STATES.GAP, THREAD_STATES.UNAVAILABLE].includes(enrollment.state)) {
        reason = enrollment.state === THREAD_STATES.GAP ? THREAD_INTAKE_REASONS.GAP : THREAD_INTAKE_REASONS.UNAVAILABLE;
      }
      if (reason) {
        this.receipt(null, 'intake-rejected', {
          discordId: event.id, channelId: authorityChannelId,
          ...(enrollment ? { deliveryChannelId: event.channelId } : {}),
          reason, ready
        });
        return this.reject(reason);
      }
      const committed = this.getMessage(event.id);
      if (committed) return { accepted: false, duplicate: true, reason: 'duplicate-message', message: committed };
      const cutoffReason = intakeCutoffDecision(event.id, intakeCutoff, compareDiscordIds);
      if (cutoffReason) {
        this.receipt(null, 'intake-rejected', {
          discordId: event.id, channelId: authorityChannelId,
          ...(enrollment ? { deliveryChannelId: event.channelId } : {}),
          reason: cutoffReason, ready
        });
        return this.reject(cutoffReason);
      }
      if (agent && this.db.prepare(`SELECT 1 FROM receipts WHERE kind='agent-message'
        AND json_extract(detail, '$.packet.id')=?
        AND json_extract(detail, '$.packet.source.guildId')=?
        AND json_extract(detail, '$.packet.source.channelId')=?
        AND json_extract(detail, '$.packet.source.provider')=?
        AND json_extract(detail, '$.packet.source.nativeId')=?
        AND json_extract(detail, '$.packet.source.generation')=?
        AND json_extract(detail, '$.packet.target.guildId')=?
        AND json_extract(detail, '$.packet.target.channelId')=?
        AND json_extract(detail, '$.packet.target.provider')=?
        AND json_extract(detail, '$.packet.target.nativeId')=?
        AND json_extract(detail, '$.packet.target.generation')=? LIMIT 1`)
        .get(agent.id, agent.source.guildId, agent.source.channelId, agent.source.provider, agent.source.nativeId, agent.source.generation,
          agent.target.guildId, agent.target.channelId, agent.target.provider, agent.target.nativeId, agent.target.generation)) {
        this.receipt(null, 'intake-rejected', {
          discordId: event.id,
          channelId: authorityChannelId,
          ...(enrollment ? { deliveryChannelId: event.channelId } : {}),
          reason: 'agent-message-duplicate',
          ready
        });
        return this.reject('agent-message-duplicate');
      }
      if (notice) {
        const prior = watcherNoticeHandlers.findWatcherNotice(this, notice.armKey, notice.triggerKey);
        if (prior) {
          if (!sameWatcherNotice(prior.provenance.packet, notice)) {
            this.receipt(null, 'intake-rejected', {
              discordId: event.id, channelId: authorityChannelId,
              ...(enrollment ? { deliveryChannelId: event.channelId } : {}),
              reason: 'watcher-notice-identity-conflict', ready
            });
            return this.reject('watcher-notice-identity-conflict');
          }
          this.receipt(null, 'intake-rejected', {
            discordId: event.id, channelId: authorityChannelId,
            ...(enrollment ? { deliveryChannelId: event.channelId } : {}),
            reason: 'watcher-notice-duplicate', ready
          });
          return { accepted: false, duplicate: true, reason: 'watcher-notice-duplicate', message: this.getMessage(prior.messageId) };
        }
      }
      if (this.failNextIntakeFlag) {
        this.failNextIntakeFlag = false;
        throw new Error('injected intake transaction failure');
      }
      const timestamp = now();
      this.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, delivery_channel_id, author_id, content, attachments, provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        event.id, event.guildId, authorityChannelId, event.channelId, event.authorId, event.content, JSON.stringify(attachments), binding.provider, binding.nativeId,
        binding.workspace, binding.endpoint, binding.conductorId, binding.repoKey, binding.generation, MESSAGE_STATES.ACCEPTED, timestamp, timestamp
      );
      if (enrollment) threadEnrollmentHandlers.noteThreadMessage(this, enrollment.threadId, event.id, true);
      else {
        const watermark = this.getIntakeWatermark(authorityChannelId);
        if (!watermark?.last_accepted_id || compareDiscordIds(watermark.last_accepted_id, event.id) < 0) {
          this.db.prepare('UPDATE intake_watermarks SET last_accepted_id=?, updated_at=? WHERE channel_id=?')
            .run(event.id, timestamp, authorityChannelId);
        }
      }
      if (agent) this.receipt(event.id, 'agent-message', { packet: agent, authorId: event.authorId });
      if (notice) {
        this.receipt(event.id, WATCHER_NOTICE_RECEIPTS.PROVENANCE, {
          journal: WATCHER_NOTICE_JOURNAL, packet: notice, authorId: event.authorId,
          authority: WATCHER_NOTICE_AUTHORITY.NOTICE_ONLY
        });
        this.receipt(event.id, WATCHER_NOTICE_RECEIPTS.PUBLICATION, {
          journal: WATCHER_NOTICE_JOURNAL, packet: notice, authorId: event.authorId,
          noticeId: notice.id, armKey: notice.armKey, triggerKey: notice.triggerKey,
          channelId: authorityChannelId, deliveryChannelId: event.channelId,
          provider: binding.provider, nativeId: binding.nativeId, generation: binding.generation,
          source: WATCHER_NOTICE_PUBLICATION_SOURCE
        });
      }
      this.receipt(event.id, 'accepted', {
        channelId: authorityChannelId,
        ...(enrollment ? { deliveryChannelId: event.channelId } : {}),
        conductorId: binding.conductorId, generation: binding.generation,
        readiness: ready && (!enrollment || enrollment.state === THREAD_STATES.READY) ? 'ready' : 'pending'
      });
      if (!ready || (enrollment && enrollment.state !== THREAD_STATES.READY)) {
        this.receipt(event.id, 'intake-held-not-ready', {
          channelId: authorityChannelId,
          ...(enrollment ? { deliveryChannelId: event.channelId } : {})
        });
      }
      return { accepted: true, message: this.getMessage(event.id) };
    });
  }

  acceptInteraction(input, expectedBinding = null, options = {}) {
    return interactionHandlers.acceptInteraction(this, input, expectedBinding, options);
  }

  acceptDecisionInteraction(input, { inTransaction = false } = {}) {
    const operation = () => interactionHandlers.acceptDecisionInteraction(this, input);
    return inTransaction ? operation() : this.transaction(operation);
  }

  isInteractionMessage(messageId) {
    assertText(messageId, 'messageId', 128);
    return interactionHandlers.isInteractionMessage(this, messageId);
  }

  beginInteractionCallback(messageId) {
    return interactionHandlers.beginCallback(this, messageId);
  }

  recordInteractionCallbackOutcome(messageId, outcome, detail = {}) {
    return interactionHandlers.recordCallbackOutcome(this, messageId, outcome, detail);
  }

  interactionResponseTarget(messageId) {
    return interactionHandlers.responseTarget(this, messageId);
  }

  recoverInteractionCallbacksInTransaction(ownerAlive = null) {
    return interactionHandlers.recoverCallbacksInTransaction(this, ownerAlive || undefined);
  }

  registerDecisionPresentation(input) {
    return decisionHandlers.registerPresentation(this, input);
  }

  findDecisionPresentation(input) {
    return decisionHandlers.findPresentation(this, input);
  }

  recordDecisionPresentationOutcome(presentationId, outcome, messageId = null) {
    return decisionHandlers.recordPresentationOutcome(this, presentationId, outcome, messageId);
  }

  markDecisionPresentationStale(presentationId, reason) {
    return decisionHandlers.markPresentationStale(this, presentationId, reason);
  }

  getDecisionPresentation(presentationId) {
    return decisionHandlers.getPresentation(this, presentationId);
  }

  admitDecisionClick(input) {
    return decisionHandlers.admitClick(this, input);
  }

  admitDecisionClickAndBeginCallback(input) {
    return decisionHandlers.admitClickAndBeginCallback(this, input);
  }

  getDecisionClick(interactionId) {
    return decisionHandlers.getClick(this, interactionId);
  }

  beginDecisionCallback(interactionId) {
    return decisionHandlers.beginCallback(this, interactionId);
  }

  recordDecisionCallbackOutcome(interactionId, outcome) {
    return decisionHandlers.recordCallbackOutcome(this, interactionId, outcome);
  }

  importDecisionWinner(interactionId, result) {
    return decisionHandlers.importWinner(this, interactionId, result);
  }

  recordDecisionProjectionOutcome(interactionId, outcome) {
    return decisionHandlers.recordProjectionOutcome(this, interactionId, outcome);
  }

  queueDecisionNativeReturn(interactionId) {
    return decisionHandlers.queueNativeReturn(this, interactionId);
  }

  recordDecisionNativeReturnOutcome(interactionId, outcome) {
    return decisionHandlers.recordNativeReturnOutcome(this, interactionId, outcome);
  }

  listDecisionPendingWork() {
    return decisionHandlers.pendingWork(this);
  }

  getTransportReceipt(messageId, transport = null) {
    assertText(messageId, 'messageId', 128);
    const rows = this.db.prepare('SELECT kind, detail, created_at FROM receipts WHERE discord_id=? AND kind IN (?, ?) ORDER BY id')
      .all(messageId, TRANSPORT_RECEIPT_ATTEMPT, TRANSPORT_RECEIPT_OUTCOME);
    let attempt = null;
    let outcome = null;
    for (const row of rows) {
      const detail = parseJson(row.detail, {});
      if (transport !== null && detail.transport !== transport) continue;
      if (row.kind === TRANSPORT_RECEIPT_ATTEMPT) attempt = { ...detail, recordedAt: row.created_at };
      if (row.kind === TRANSPORT_RECEIPT_OUTCOME) outcome = { ...detail, recordedAt: row.created_at };
    }
    if (!attempt && !outcome) return null;
    return { messageId, attempt, outcome };
  }

  beginTransportReceipt(messageId, { transport = null, ownerPid = null, ownerIdentity = null, inTransaction = false } = {}) {
    assertText(messageId, 'messageId', 128);
    const begin = () => {
      const existing = this.getTransportReceipt(messageId, transport);
      if (existing) return { started: false, ...existing, reason: 'already-attempted' };
      const message = this.getMessage(messageId);
      if (!message) throw new BindingError('message is unknown');
      if (message.state !== MESSAGE_STATES.ACCEPTED) return { started: false, message, reason: 'message-not-accepted' };
      if (transport === INTERACTION_TRANSPORT && !this.isInteractionMessage(messageId)) {
        throw new BindingError('interaction callback origin is unknown');
      }
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
        readiness: check.binding.readiness === READINESS.READY
          ? (check.enrollment?.state || READINESS.READY)
          : check.binding.readiness,
        status: 'attempted'
      };
      if (check.enrollment) detail.deliveryChannelId = check.deliveryChannelId;
      if (transport !== null) detail.transport = transport;
      if (ownerPid !== null) detail.ownerPid = ownerPid;
      if (ownerIdentity !== null) detail.ownerIdentity = ownerIdentity;
      this.receipt(messageId, TRANSPORT_RECEIPT_ATTEMPT, detail);
      return { started: true, message, binding: check.binding, attempt: detail, nonce: detail.nonce };
    };
    return inTransaction ? begin() : this.transaction(begin);
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

  recordTransportReceiptOutcome(messageId, outcome, detail = {}, transport = null) {
    assertText(messageId, 'messageId', 128);
    if (!TRANSPORT_RECEIPT_OUTCOMES.includes(outcome)) throw new BindingError('invalid transport receipt outcome');
    return this.transaction(() => {
      const record = this.getTransportReceipt(messageId, transport);
      if (!record?.attempt) throw new BindingError('transport receipt attempt is unknown');
      if (record.outcome) return record;
      const next = { ...detail, nonce: record.attempt.nonce, outcome };
      this.receipt(messageId, TRANSPORT_RECEIPT_OUTCOME, next);
      return this.getTransportReceipt(messageId);
    });
  }

  currentMessageBinding(message) {
    const config = this.requireConfig();
    const deliveryChannelId = message.deliveryChannelId || message.channelId;
    const route = typeof deliveryChannelId === 'string' && deliveryChannelId.length > 0
      ? this.getMessageRoute(deliveryChannelId)
      : null;
    const binding = route?.binding || this.getBinding(message.channelId);
    const enrollment = route?.enrollment || null;
    const routeIdentity = Boolean(route && route.binding.channelId === binding?.channelId &&
      route.binding.channelId === message.channelId &&
      (!enrollment || enrollment.guildId === binding?.guildId));
    const identity = Boolean(routeIdentity && binding && binding.active && binding.guildId === message.guildId &&
      binding.generation === message.generation && binding.nativeId === message.nativeId && binding.provider === message.provider);
    const current = Boolean(identity && binding.guildId === config.guildId &&
      message.guildId === config.guildId && (message.authorId === config.operatorId || this.getAgentMessage(message.id)?.authorId === message.authorId || this.getWatcherNotice(message.id)?.authorId === message.authorId) &&
      binding.generation === message.generation && binding.nativeId === message.nativeId && binding.provider === message.provider);
    return { config, binding, identity, current, enrollment, deliveryChannelId, ready: Boolean(identity && route?.ready) };
  }

  hasNativeAcknowledgment(message) {
    const row = this.db.prepare('SELECT detail FROM receipts WHERE discord_id=? AND kind=? ORDER BY id DESC LIMIT 1')
      .get(message.id, NATIVE_ACK_RECEIPT);
    const identity = parseJson(row?.detail, null);
    return Boolean(identity && identity.provider === message.provider && identity.nativeId === message.nativeId && identity.generation === message.generation);
  }

  recoverNativeReplyAcknowledgment(messageId) {
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message || message.state !== MESSAGE_STATES.REPLY_READY) return { recovered: false, reason: 'not-reply-ready' };
      const check = this.currentMessageBinding(message);
      if (!check.current) return { recovered: false, reason: check.identity ? 'authorization-revoked' : 'stale-generation' };
      if (this.hasNativeAcknowledgment(message)) return { recovered: false, duplicate: true };
      const receiptRows = this.db.prepare(`SELECT detail FROM receipts
        WHERE discord_id=? AND kind IN (?, ?) ORDER BY id DESC`).all(messageId, 'native-reply', 'native-reply-before-submit');
      const partCount = Number(this.db.prepare('SELECT COUNT(*) AS count FROM reply_parts WHERE discord_id=?').get(messageId).count);
      const provenance = receiptRows
        .map(row => parseJson(row.detail, null))
        .find(detail => detail && detail.generation === message.generation && Number.isInteger(detail.parts) && detail.parts > 0 && detail.parts === partCount);
      if (!provenance) return { recovered: false, reason: 'native-reply-provenance-missing' };
      this.receipt(messageId, NATIVE_ACK_RECEIPT, {
        provider: message.provider,
        nativeId: message.nativeId,
        generation: message.generation,
        source: 'native-reply'
      });
      return { recovered: true, message: this.getMessage(messageId) };
    });
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
        if (this.hasNativeAcknowledgment(message)) {
          this.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
            .run(MESSAGE_STATES.SUBMITTED, now(), messageId, MESSAGE_STATES.ACCEPTED);
          this.receipt(messageId, 'dispatch-already-acknowledged', { generation: message.generation });
          return { claimed: false, message: this.getMessage(messageId), reason: 'native-already-acknowledged' };
        }
        if (check.binding.readiness !== READINESS.READY || !check.ready) {
          this.receipt(messageId, 'dispatch-held-not-ready', {
            readiness: check.binding.readiness,
            ...(check.enrollment ? { threadState: check.enrollment.state } : {}),
            generation: message.generation
          });
          return { claimed: false, message, reason: 'binding-not-ready' };
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
      const serializedCursor = cursor === null || cursor === undefined ? null : safeDetail(cursor);
      const submittedMarker = marker === undefined ? null : marker;
      if (message.state === MESSAGE_STATES.SUBMITTED) {
        if (serializedCursor === null && submittedMarker === null) return message;
        this.db.prepare('UPDATE messages SET observer_cursor=COALESCE(observer_cursor, ?), observer_marker=COALESCE(observer_marker, ?), updated_at=? WHERE discord_id=? AND state=?')
          .run(serializedCursor, submittedMarker, now(), messageId, MESSAGE_STATES.SUBMITTED);
        return this.getMessage(messageId);
      }
      if (message.state !== MESSAGE_STATES.DISPATCHING) return message;
      this.db.prepare('UPDATE messages SET state=?, observer_cursor=?, observer_marker=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
        .run(MESSAGE_STATES.SUBMITTED, serializedCursor, submittedMarker, now(), messageId, MESSAGE_STATES.DISPATCHING);
      this.receipt(messageId, 'submitted', { marker: marker || undefined });
      return this.getMessage(messageId);
    });
  }

  setObserverCursor(messageId, cursor, marker = null) {
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message || ![MESSAGE_STATES.DISPATCHING, MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLY_READY, MESSAGE_STATES.REPLIED].includes(message.state)) return message;
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
      if ([MESSAGE_STATES.ACCEPTED, MESSAGE_STATES.UNCERTAIN].includes(next) && this.hasNativeAcknowledgment(message)) {
        this.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
          .run(MESSAGE_STATES.SUBMITTED, now(), messageId, expected);
        this.receipt(messageId, 'dispatch-already-acknowledged', { generation: message.generation });
        return this.getMessage(messageId);
      }
      this.db.prepare('UPDATE messages SET state=?, error=?, updated_at=? WHERE discord_id=? AND state=?')
        .run(next, error ? String(error.message || error).slice(0, 1000) : null, now(), messageId, expected);
      this.receipt(messageId, kind, { error: error ? String(error.message || error).slice(0, 200) : undefined });
      return this.getMessage(messageId);
    });
  }

  nativeReplyFilePreparation(messageId) {
    return nativeReplyFileHandlers.nativeReplyFilePreparation(this, messageId);
  }

  activeFilePreparationCount() {
    return nativeReplyFileHandlers.activeFilePreparationCount(this);
  }

  prepareNativeReplyFile(input) {
    return nativeReplyFileHandlers.prepareNativeReplyFile(this, input);
  }

  releaseNativeReplyFilePreparation(messageId, preparationId, partIndex = 0) {
    return nativeReplyFileHandlers.releaseNativeReplyFilePreparation(this, messageId, preparationId, partIndex);
  }

  recordNativeReply({ provider, messageId, nativeId, generation, text, parts: prepartitionedParts, fileManifest = null }) {
    assertProvider(provider);
    assertText(messageId, 'messageId', 128);
    assertUuid(nativeId);
    if (!Number.isInteger(generation) || generation < 1) throw new StaleGenerationError('invalid generation');
    const hasPrepartitionedParts = Array.isArray(prepartitionedParts);
    if (!(hasPrepartitionedParts && text === '')) assertText(text, 'reply text', 10000);
    if (fileManifest !== null) {
      try { assertNativeReplyFileManifest(fileManifest); }
      catch (error) { throw new BindingError(error.message); }
      if (!text.trim() || text.length > REPLY_LIMIT) throw new BindingError('file replies require one nonblank caption at most 2000 characters');
    }
    try {
      return this.transaction(() => {
        let message = this.getMessage(messageId);
        if (!message) throw new StaleGenerationError('native reply is stale');
        const check = this.currentMessageBinding(message);
        if (message.provider !== provider || !check.binding || message.nativeId !== nativeId || message.generation !== generation ||
          check.binding.nativeId !== nativeId || check.binding.generation !== generation || check.binding.provider !== message.provider || check.binding.provider !== provider) {
          throw new StaleGenerationError('native reply is stale');
        }
        if (!check.current) throw new AuthorizationError('native reply authorization is no longer valid');
        const ensureNativeReplyAcknowledgment = () => {
          const existing = this.db.prepare('SELECT 1 FROM receipts WHERE discord_id=? AND kind=? LIMIT 1')
            .get(messageId, NATIVE_ACK_RECEIPT);
          if (!existing) this.receipt(messageId, NATIVE_ACK_RECEIPT, { provider, nativeId, generation, source: 'native-reply' });
        };
        ensureNativeReplyAcknowledgment();
        if (message.state === MESSAGE_STATES.UNCERTAIN) {
          this.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
            .run(MESSAGE_STATES.SUBMITTED, now(), messageId, MESSAGE_STATES.UNCERTAIN);
          message = this.getMessage(messageId);
        }
        if (message.state === MESSAGE_STATES.REPLY_READY || message.state === MESSAGE_STATES.REPLIED) {
          return { duplicate: true, message };
        }
        if (![MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.DISPATCHING].includes(message.state)) throw new BindingError(`reply is not accepted in state ${message.state}`);
        const admittedFile = this.nativeReplyFilePreparation(messageId);
        if (admittedFile?.phase === NATIVE_REPLY_FILE_PHASES.PREPARING) {
          throw new BindingError('native reply file preparation is still in progress');
        }
        if (admittedFile?.phase === NATIVE_REPLY_FILE_PHASES.ADMITTED && fileManifest === null) {
          throw new BindingError('native reply file custody requires its admitted attachment');
        }
        if (fileManifest !== null) {
          if (!admittedFile || admittedFile.phase !== NATIVE_REPLY_FILE_PHASES.ADMITTED ||
            admittedFile.preparationId !== fileManifest.preparationId || admittedFile.stagedPath !== fileManifest.stagedPath ||
            admittedFile.filename !== fileManifest.filename || admittedFile.size !== fileManifest.size ||
            admittedFile.sha256 !== fileManifest.sha256 || admittedFile.caption !== fileManifest.caption ||
            admittedFile.captionHash !== fileManifest.captionHash || admittedFile.caption !== text) {
            throw new BindingError('native reply file preparation is not admitted for this reply');
          }
        }
        const timestamp = now();
        const parts = hasPrepartitionedParts ? prepartitionedParts.slice() : splitReply(text);
        if ((!parts.length && text !== '') || parts.some(part => typeof part !== 'string' || part.length > REPLY_LIMIT) || parts.join('') !== text) {
          throw new BindingError('reply parts are invalid');
        }
        if (fileManifest !== null && (parts.length !== 1 || parts[0] !== text)) {
          throw new BindingError('file replies require exactly one caption part');
        }
        if (fileManifest === null && text === '' && parts.every(part => part.length === 0)) {
          this.db.prepare('UPDATE messages SET state=?, reply_text=?, reply_nonce=?, reply_message_id=NULL, reply_next_part=0, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
            .run(MESSAGE_STATES.REPLIED, text, discordNonce(messageId, 0), timestamp, messageId, message.state);
          this.db.prepare('DELETE FROM reply_parts WHERE discord_id=?').run(messageId);
          this.receipt(messageId, message.state === MESSAGE_STATES.DISPATCHING ? 'native-reply-before-submit' : 'native-reply', { generation, parts: 0 });
          this.receipt(messageId, REPLY_COMPLETED_WITHOUT_POST, { generation });
          return { duplicate: false, message: this.getMessage(messageId) };
        }
        this.db.prepare('UPDATE messages SET state=?, reply_text=?, reply_nonce=?, reply_next_part=0, updated_at=? WHERE discord_id=? AND state=?')
          .run(MESSAGE_STATES.REPLY_READY, text, discordNonce(messageId, 0), timestamp, messageId, message.state);
        this.db.prepare('DELETE FROM reply_parts WHERE discord_id=?').run(messageId);
        const insert = this.db.prepare('INSERT INTO reply_parts(discord_id, part_index, content, nonce, state, file_manifest, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)');
        parts.forEach((part, index) => insert.run(messageId, index, part, discordNonce(messageId, index), 'pending', index === 0 && fileManifest !== null ? safeDetail(fileManifest) : null, timestamp));
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
    const result = this.transaction(() => {
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
    return result;
  }

  markReplyPartSkipped(messageId, partIndex) {
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new BindingError('message is unknown');
      if (message.state === MESSAGE_STATES.REPLIED) return message;
      if (message.state !== MESSAGE_STATES.REPLYING) throw new BindingError(`reply is not in flight in state ${message.state}`);
      const part = this.db.prepare('SELECT * FROM reply_parts WHERE discord_id=? AND part_index=?').get(messageId, partIndex);
      if (!part) throw new BindingError('reply part is unknown');
      if (part.file_manifest) throw new BindingError('file-bearing replies cannot be skipped');
      if (part.state === 'sent') return message;
      this.db.prepare("UPDATE reply_parts SET state='sent', message_id=NULL, error=NULL, updated_at=? WHERE discord_id=? AND part_index=?")
        .run(now(), messageId, partIndex);
      const remaining = this.db.prepare("SELECT COUNT(*) AS count FROM reply_parts WHERE discord_id=? AND state<>'sent'").get(messageId).count;
      if (Number(remaining) === 0) {
        const lastPosted = this.db.prepare("SELECT message_id FROM reply_parts WHERE discord_id=? AND state='sent' AND message_id IS NOT NULL ORDER BY part_index DESC LIMIT 1").get(messageId);
        const replyMessageId = lastPosted?.message_id || null;
        this.db.prepare('UPDATE messages SET state=?, reply_message_id=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
          .run(MESSAGE_STATES.REPLIED, replyMessageId, now(), messageId, MESSAGE_STATES.REPLYING);
        if (replyMessageId) this.receipt(messageId, 'reply-sent', { replyMessageId, skipped: true });
        else this.receipt(messageId, REPLY_COMPLETED_WITHOUT_POST, { generation: message.generation });
      } else {
        this.db.prepare('UPDATE messages SET reply_next_part=?, updated_at=? WHERE discord_id=?').run(Number(partIndex) + 1, now(), messageId);
        this.receipt(messageId, 'reply-part-skipped', { partIndex });
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
    const result = this.transaction(() => {
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
    return result;
  }

  recoverAfterRestart(ownerAlive = null) {
    return this.transaction(() => {
      boardRefreshHandlers.recoverBoardRefreshReceipts(this, ownerAlive || ((pid, identity) => this.directPostOwnerAlive(pid, identity)), true);
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
          AND COALESCE(json_extract(attempt.detail, '$.transport'), '') <> ?
        ORDER BY attempt.id
      `).all(TRANSPORT_RECEIPT_OUTCOME, TRANSPORT_RECEIPT_ATTEMPT, INTERACTION_TRANSPORT);
      for (const row of transportAttempts) {
        this.receipt(row.discord_id, TRANSPORT_RECEIPT_OUTCOME, {
          ...parseJson(row.detail, {}),
          outcome: 'unknown',
          reason: 'process stopped before transport receipt outcome'
        });
      }
      const interactionCallbacks = this.recoverInteractionCallbacksInTransaction(ownerAlive);
      decisionHandlers.recoverCallbackAttemptsAfterRestart(this);
      const courierAttempts = courierRouteHandlers.recoverCourierAttemptsAfterRestart(this, { inTransaction: true });
      const dispatching = this.db.prepare('SELECT discord_id FROM messages WHERE state=?').all(MESSAGE_STATES.DISPATCHING);
      for (const row of dispatching) {
        const message = this.getMessage(row.discord_id);
        const courierOutcome = this.getCourierAttempt(row.discord_id)?.outcome?.outcome;
        if (this.hasNativeAcknowledgment(message)) {
          this.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
            .run(MESSAGE_STATES.SUBMITTED, now(), row.discord_id, MESSAGE_STATES.DISPATCHING);
          this.receipt(row.discord_id, 'dispatch-already-acknowledged', { generation: message.generation, afterRestart: true });
          continue;
        }
        if (courierOutcome === COURIER_OUTCOMES.SUBMITTED) {
          const marker = `[[discord-surface:${row.discord_id}]]`;
          this.db.prepare('UPDATE messages SET state=?, observer_marker=COALESCE(observer_marker, ?), error=NULL, updated_at=? WHERE discord_id=? AND state=?')
            .run(MESSAGE_STATES.SUBMITTED, marker, now(), row.discord_id, MESSAGE_STATES.DISPATCHING);
          this.receipt(row.discord_id, 'submitted', { marker, afterRestart: true });
          continue;
        }
        if (courierOutcome === COURIER_OUTCOMES.NOT_SUBMITTED) {
          this.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
            .run(MESSAGE_STATES.ACCEPTED, now(), row.discord_id, MESSAGE_STATES.DISPATCHING);
          this.receipt(row.discord_id, 'dispatch-not-submitted-after-restart', { afterRestart: true });
          continue;
        }
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
      return { dispatching: dispatching.length, replying: replying.length, interactionCallbacks, courierAttempts, candidates: candidates.map(row => row.id) };
    });
  }

  directPostRows(requestId = null, channelId = null) {
    return queryDirectPostRows({
      db: this.db,
      assertText,
      parseJson,
      StateCorruptError,
      attemptKind: DIRECT_POST_ATTEMPT,
      outcomeKind: DIRECT_POST_OUTCOME
    }, requestId, channelId);
  }

  directPostFilePreparation(requestId) {
    return directPostHandlers.findDirectPostFilePreparation(this, requestId);
  }

  beginDirectPostFilePreparation(seed) {
    return directPostHandlers.beginDirectPostFilePreparation(this, seed);
  }

  admitDirectPostFilePreparation(preparationId, manifest) {
    return directPostHandlers.admitDirectPostFilePreparation(this, preparationId, manifest);
  }

  releaseDirectPostFilePreparation(preparationId) {
    return directPostHandlers.releaseDirectPostFilePreparation(this, preparationId, preparation => {
      const stateDir = typeof preparation.custodyRoot === 'string'
        ? preparation.custodyRoot
        : path.dirname(path.dirname(preparation.stagedPath));
      removeDirectPostFile({ stateDir, preparationId, stagedPath: preparation.stagedPath });
    });
  }

  directPostOwnerIdentity(pid) {
    if (!Number.isInteger(Number(pid)) || Number(pid) < 1) return null;
    const normalizedPid = Number(pid);
    let ownerStartTime = null;
    let ownerCommand = null;
    try {
      const stat = require('node:fs').readFileSync(`/proc/${normalizedPid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close > 0) ownerStartTime = stat.slice(close + 2).trim().split(/\s+/)[19] || null;
      const command = require('node:fs').readFileSync(`/proc/${normalizedPid}/cmdline`, 'utf8');
      ownerCommand = command.split('\0').filter(Boolean).join('\0') || null;
    } catch (error) {
      try {
        ownerStartTime = require('node:child_process').execFileSync('ps', ['-p', String(normalizedPid), '-o', 'lstart='], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
        }).trim().replace(/\s+/g, ' ') || null;
        ownerCommand = require('node:child_process').execFileSync('ps', ['-p', String(normalizedPid), '-o', 'command='], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
        }).trim() || null;
      } catch (fallbackError) {
        return null;
      }
    }
    if (!ownerStartTime && !ownerCommand) return null;
    return { ownerPid: normalizedPid, ownerStartTime, ownerCommand };
  }

  directPostOwnerAlive(pid, expectedIdentity = null) {
    if (!Number.isInteger(Number(pid)) || Number(pid) < 1 || !expectedIdentity) return false;
    try { process.kill(Number(pid), 0); } catch (error) { return false; }
    const actualIdentity = this.directPostOwnerIdentity(pid);
    if (!actualIdentity) return false;
    if (expectedIdentity.ownerStartTime && actualIdentity.ownerStartTime !== expectedIdentity.ownerStartTime) return false;
    if (expectedIdentity.ownerCommand && actualIdentity.ownerCommand !== expectedIdentity.ownerCommand) return false;
    return Boolean(
      (expectedIdentity.ownerStartTime && actualIdentity.ownerStartTime) ||
      (expectedIdentity.ownerCommand && actualIdentity.ownerCommand)
    );
  }

  recoverDirectPostReceipts(ownerAlive = (pid, expectedIdentity) => {
    if (!Number.isInteger(Number(pid)) || Number(pid) < 1) return false;
    return this.directPostOwnerAlive(pid, expectedIdentity);
  }) {
    return this.transaction(() => this.recoverDirectPostReceiptsInternal(ownerAlive));
  }

  recoverDirectPostReceiptsInternal(ownerAlive = (pid, expectedIdentity) => {
    if (!Number.isInteger(Number(pid)) || Number(pid) < 1) return false;
    return this.directPostOwnerAlive(pid, expectedIdentity);
  }) {
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

  directPostBindingCurrent(binding, operatorId = null, deliveryChannelId = null) {
    const config = this.requireConfig();
    const current = this.getBinding(binding?.channelId);
    const parentCurrent = Boolean(binding && current && bindingMatchesExpected(current, binding) && current.guildId === config.guildId &&
      (operatorId === null || config.operatorId === operatorId));
    if (!parentCurrent) return false;
    if (deliveryChannelId === null || deliveryChannelId === binding.channelId) return true;
    const route = this.getMessageRoute(deliveryChannelId);
    return Boolean(route?.enrollment?.active && route.enrollment.threadId === deliveryChannelId &&
      route.enrollment.parentChannelId === current.channelId && route.enrollment.guildId === config.guildId &&
      route.binding.channelId === current.channelId && route.ready);
  }

  captureBoardRevision(target) {
    return boardRefreshHandlers.captureBoardRevision(this, target);
  }

  inspectBoardRequest(requestId, target) {
    return boardRefreshHandlers.inspectBoardRequest(this, requestId, target);
  }

  boardMessageProvenance(target) {
    return boardRefreshHandlers.boardMessageProvenance(this, target);
  }

  recoverBoardRefreshReceipts(ownerAlive = (pid, identity) => this.directPostOwnerAlive(pid, identity)) {
    return boardRefreshHandlers.recoverBoardRefreshReceipts(this, ownerAlive);
  }

  recoverBoardRefreshAttempt(target, attemptId, ownerAlive = (pid, identity) => this.directPostOwnerAlive(pid, identity)) {
    return boardRefreshHandlers.recoverBoardRefreshAttempt(this, target, attemptId, ownerAlive);
  }

  beginBoardRefresh(meta, capturedRevision) {
    return boardRefreshHandlers.beginBoardRefresh(this, meta, capturedRevision);
  }

  recordBoardRefreshOutcome(target, attemptId, outcome, detail = {}) {
    return boardRefreshHandlers.recordBoardRefreshOutcome(this, target, attemptId, outcome, detail);
  }

  reconcileBoardRefresh(target, attemptId, resolution, evidence) {
    return boardRefreshHandlers.reconcileBoardRefresh(this, target, attemptId, resolution, evidence);
  }

  beginDirectPostPart(meta) {
    return directPostHandlers.beginDirectPostPart(this, meta);
  }

  inspectDirectPostPart(meta) {
    return directPostHandlers.inspectDirectPostPart(this, meta);
  }

  recordDirectPostPreflight(meta, outcome, detail = {}) {
    return directPostHandlers.recordDirectPostPreflight(this, meta, outcome, detail);
  }

  recordDirectPostOutcome(requestId, attemptId, outcome, detail = {}) {
    return directPostHandlers.recordDirectPostOutcome(this, requestId, attemptId, outcome, detail);
  }

  completeAgentHandledWithoutPost(args) {
    return agentCompletionHandlers.completeAgentHandledWithoutPost(this, args);
  }

  armWatcherNotice(input) {
    return watcherNoticeHandlers.armWatcherNotice(this, input);
  }

  getWatcherNoticeArm(armKey) {
    return watcherNoticeHandlers.getWatcherNoticeArm(this, armKey);
  }

  authorizeWatcherNoticeSend(packet) {
    return watcherNoticeHandlers.authorizeWatcherNoticeSend(this, packet);
  }

  recordWatcherNoticeTrigger(packet) {
    return watcherNoticeHandlers.recordWatcherNoticeTrigger(this, packet);
  }

  authorizeWatcherNoticePublication(packet, event) {
    return watcherNoticeHandlers.authorizeWatcherNoticePublication(this, packet, event);
  }

  consumeWatcherNotice(args) {
    return watcherNoticeHandlers.consumeWatcherNotice(this, args);
  }

  findWatcherNotice(armKey, triggerKey) {
    return watcherNoticeHandlers.findWatcherNotice(this, armKey, triggerKey);
  }

  reconcileDirectPostOutcome(requestId, attemptId, resolution, evidence = {}) {
    return directPostHandlers.reconcileDirectPostOutcome(this, requestId, attemptId, resolution, evidence);
  }

  directPostOutcomeMatches(event, key, value) {
    return directPostHandlers.directPostOutcomeMatches(this, event, key, value);
  }

  excludeDirectPost(event) {
    return directPostHandlers.excludeDirectPost(this, event);
  }

  recoveryCandidates(before = null) {
    const states = [MESSAGE_STATES.ACCEPTED, MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLY_READY];
    const rows = before
      ? this.db.prepare(`SELECT discord_id FROM messages WHERE state IN (?, ?, ?) AND created_at<=? ORDER BY created_at, rowid`).all(...states, before)
      : this.db.prepare(`SELECT discord_id FROM messages WHERE state IN (?, ?, ?) ORDER BY created_at, rowid`).all(...states);
    return rows.map(row => this.getMessage(row.discord_id));
  }

  reconcileUncertain(messageId, resolution) {
    if (!['submitted', 'not_submitted'].includes(resolution)) throw new BindingError('resolution must be submitted or not_submitted');
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new BindingError('message is not uncertain');
      if (resolution === 'not_submitted' && this.hasNativeAcknowledgment(message)) {
        throw new BindingError('native acknowledgment prevents retrying delivery');
      }
      if (message.state !== MESSAGE_STATES.UNCERTAIN) throw new BindingError('message is not uncertain');
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

  getAgentMessage(messageId) {
    const row = this.db.prepare("SELECT detail FROM receipts WHERE discord_id=? AND kind='agent-message' ORDER BY id LIMIT 1").get(messageId);
    return row ? parseJson(row.detail, null) : null;
  }

  getWatcherNotice(messageId) {
    const row = this.db.prepare(`SELECT id, detail, created_at FROM receipts
      WHERE discord_id=? AND kind=? ORDER BY id LIMIT 1`).get(messageId, WATCHER_NOTICE_RECEIPTS.PROVENANCE);
    if (!row) return null;
    const detail = parseJson(row.detail, null);
    if (!detail || detail.journal !== WATCHER_NOTICE_JOURNAL || !detail.packet || typeof detail.authorId !== 'string') {
      throw new StateCorruptError('watcher notice provenance is malformed');
    }
    try { validateWatcherNotice(detail.packet); }
    catch (error) { throw new StateCorruptError(`watcher notice provenance is malformed: ${error.message}`); }
    return {
      packet: detail.packet,
      authorId: detail.authorId,
      receiptId: Number(row.id),
      recordedAt: row.created_at
    };
  }

  getMessage(messageId) {
    const message = rowMessage(this.db.prepare('SELECT * FROM messages WHERE discord_id=?').get(messageId));
    if (message) {
      message.replyParts = this.listReplyParts(messageId);
      const agent = message.content.startsWith(AGENT_PREFIX) ? this.getAgentMessage(messageId) : null;
      if (agent) message.agentMessage = agent.packet;
      const notice = message.content.startsWith(WATCHER_NOTICE_PREFIX) ? this.getWatcherNotice(messageId) : null;
      if (notice) {
        message.watcherNotice = notice.packet;
        message.watcherNoticeProvenance = notice;
      }
      const decisionResult = interactionHandlers.decisionResult(this, message);
      if (decisionResult) message.decisionResult = decisionResult;
    }
    return message;
  }

  getMessageRowId(messageId) {
    const row = this.db.prepare('SELECT rowid FROM messages WHERE discord_id=?').get(messageId);
    return row ? Number(row.rowid) : null;
  }

  listMessages() {
    return this.db.prepare('SELECT discord_id FROM messages ORDER BY created_at, rowid').all().map(row => this.getMessage(row.discord_id));
  }

  listReceipts() {
    return this.db.prepare('SELECT * FROM receipts ORDER BY id').all();
  }

  getReadiness() {
    const config = this.getConfig();
    const bindings = this.listBindings();
    const messages = this.listMessages();
    const watermarks = this.listIntakeWatermarks();
    const threadEnrollments = this.listThreadEnrollments();
    const topicCustody = this.listTopicPublications();
    const topicPublications = new Map();
    for (const row of this.listReceipts().filter(item => item.kind === 'topic-publication' || item.kind === 'topic-publication-reconciled')) {
      const detail = parseJson(row.detail, {});
      if (detail.channelId) topicPublications.set(detail.channelId, { ...detail, recordedAt: row.created_at });
    }
    const watermarkGap = watermarks.find(row => row.state === 'gap' || row.state === 'unavailable');
    const watermarkPending = watermarks.some(row => row.state === 'pending');
    const activeThreadGap = threadEnrollments.find(row => row.active && [THREAD_STATES.GAP, THREAD_STATES.UNAVAILABLE].includes(row.state));
    const activeThreadPending = threadEnrollments.some(row => row.active && row.state === THREAD_STATES.PENDING);
    let connectionBackfill = watermarks.length ? 'bounded-by-discord-watermark' : 'pending';
    if (watermarkPending || activeThreadPending) connectionBackfill = 'pending';
    if (activeThreadGap) connectionBackfill = activeThreadGap.state === THREAD_STATES.GAP ? 'unrecoverable-gap' : 'unavailable';
    if (watermarkGap) connectionBackfill = watermarkGap.state === 'gap' ? 'unrecoverable-gap' : 'unavailable';
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
        connectionBackfill,
        recovery: RECOVERY_LIMITS
      },
      intakeWatermarks: watermarks.map(row => ({ channelId: row.channel_id, lastSeenId: row.last_seen_id, recoveredThroughId: row.recovered_through_id, state: row.state, gapFrom: row.gap_from, gapTo: row.gap_to, detail: row.detail })),
      threadEnrollments,
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
    for (const channelId of this.ordinaryHandoffPauses) {
      try { this.restoreOrdinaryHandoffIntake(channelId); } catch (error) {
        this.auditReceipt(null, 'ordinary-handoff-intake-restore-failed', {
          channelId, error: error.message
        });
      }
    }
    this.ordinaryHandoffPauses.clear();
    this.ordinaryHandoffPauseSnapshots.clear();
    this.db.close();
    this.db = null;
  }
}

function validateNativeId(value) {
  return assertUuid(value);
}

module.exports = {
  ACTIVE_STATES,
  AGENT_COMPLETION_RECEIPTS,
  AuthorizationError,
  BindingError,
  DecisionError,
  DECISION_JOURNAL,
  DECISION_REASONS,
  DECISION_STATES,
  DECISION_RECEIPT_KINDS,
  DECISION_TRANSPORT_OUTCOMES,
  DECISION_WINNER_SOURCES,
  DECISION_NATIVE_OUTCOMES,
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
  INTERACTION_ORIGIN,
  INTERACTION_TRANSPORT,
  NATIVE_ACK_RECEIPT,
  REPLY_COMPLETED_WITHOUT_POST,
  DIRECT_POST_ATTEMPT,
  DIRECT_POST_OUTCOME,
  DIRECT_POST_OUTCOMES,
  BOARD_OUTCOMES,
  BOARD_RECEIPT_KINDS,
  COURIER_ATTEMPT_STATES,
  COURIER_OUTCOMES,
  COURIER_RECEIPT_KINDS,
  COURIER_RESULT_STATUSES,
  COURIER_ROUTE_STATES,
  COURIER_SOURCE_KINDS,
  DISPATCH_OUTCOMES,
  TOPIC_PUBLICATION_STATES,
  THREAD_STATES,
  THREAD_RECEIPT_KINDS,
  THREAD_INTAKE_REASONS,
  UnresolvedWorkError,
  UUID,
  discordNonce,
  normalizeAttachments,
  splitReply,
  validateNativeId
};
