const createMessageRecoveryHandlers = (...args) => require('./state/message-recovery').createMessageRecoveryHandlers(...args);
const createReplyLifecycleHandlers = (...args) => require('./state/reply-lifecycle').createReplyLifecycleHandlers(...args);
const createMessageIntakeHandlers = (...args) => require('./state/message-intake').createMessageIntakeHandlers(...args);
const createTopicPublicationHandlers = (...args) => require('./state/topic-publication').createTopicPublicationHandlers(...args);
const createSchemaHandlers = (...args) => require('./state/schema').createSchemaHandlers(...args);
const createBindingLifecycleHandlers = (...args) => require('./state/binding-lifecycle').createBindingLifecycleHandlers(...args);
const createConductorCustodyHandlers = (...args) => require('./state/conductor-custody').createConductorCustodyHandlers(...args);
const createMessageDispatchHandlers = (...args) => require('./state/message-dispatch').createMessageDispatchHandlers(...args);
const createTransportReceiptHandlers = (...args) => require('./state/transport-receipts').createTransportReceiptHandlers(...args);
const { PREFIX: AGENT_PREFIX } = require('./agent-message');
const legacyAgentRequestRoute = require('./state/legacy-agent-request-route');
const { WATCHER_NOTICE_PREFIX, validateWatcherNotice } = require('./watcher-notice');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { normalizeAttachments } = require('./attachments');
const { deserializeReplyContext } = require('./reply-context');
const { ORDINARY_RECEIPT_KINDS } = require('./ordinary/constants');
const { createOrdinaryRepository } = require('./ordinary');
const { createDirectPostHandlers, queryDirectPostRows, DIRECT_POST_OUTCOMES } = require('./state/direct-post');
const { createProvisionIntentHandlers } = require('./state/provision-intents');
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
const { createAgentRequestWithdrawalHandlers, AGENT_WITHDRAWAL_RECEIPTS } = require('./state/agent-request-withdrawal');
const {
  createWatcherNoticeHandlers,
  WATCHER_NOTICE_AUTHORITY,
  WATCHER_NOTICE_JOURNAL,
  WATCHER_NOTICE_PUBLICATION_SOURCE,
  WATCHER_NOTICE_RECEIPTS
} = require('./state/watcher-notice');
const { createBoardRefreshHandlers, BOARD_OUTCOMES, BOARD_RECEIPT_KINDS } = require('./state/board-refresh');
const { createOrdinaryBindingHandlers } = require('./state/ordinary-binding');
const { createOrdinaryClaudeBindingHandlers } = require('./state/ordinary-binding-claude');
const {
  createThreadEnrollmentHandlers,
  THREAD_DEACTIVATION_DETAILS,
  THREAD_INTAKE_REASONS,
  THREAD_STATES,
  THREAD_RECEIPT_KINDS
} = require('./state/thread-enrollment');
const {
  createIntakeHandlers,
  intakeBoundaryMatches,
  pauseOrdinaryHandoffIntake,
  restoreOrdinaryHandoffIntake,
  recoverInterruptedOrdinaryHandoffIntake,
  persistenceRefusal,
  qualifiedCoverageId
} = require('./state/intake');
const { ADOPTION_REFUSAL_DETAILS, PERSISTENCE_REFUSAL_DETAILS } = require('./discord/history-access');
const { createInteractionHandlers, INTERACTION_ORIGIN, INTERACTION_TRANSPORT } = require('./state/interaction');
const { createMessageReadHandlers } = require('./state/message-read');
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
  COURIER_DELIVERY_STATUSES,
  COURIER_OUTCOMES,
  COURIER_RECEIPT_KINDS,
  COURIER_RECOVERY_REASONS,
  COURIER_RESULT_STATUSES,
  COURIER_ROUTE_STATES,
  COURIER_SOURCE_KINDS
} = require('./state/courier-route');
const {
  createTownHallJournalHandlers,
  TOWN_HALL_JOURNAL_RECEIPTS,
  TOWN_HALL_JOURNAL_STATES
} = require('./state/town-hall-journal');
const {
  createTownHallPublicationHandlers
} = require('./state/town-hall-publication');

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
const { REPLY_LIMIT, splitReply } = require('./reply-text');

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

const agentRequestWithdrawalHandlers = createAgentRequestWithdrawalHandlers({
  MESSAGE_STATES,
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
const messageReadHandlers = createMessageReadHandlers({ parseJson, deserializeReplyContext, normalizeAttachments, StateCorruptError, WATCHER_NOTICE_RECEIPTS, WATCHER_NOTICE_JOURNAL, validateWatcherNotice, AGENT_PREFIX, legacyAgentRequestRoute, WATCHER_NOTICE_PREFIX, interactionHandlers });
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

const townHallJournalHandlers = createTownHallJournalHandlers({
  BindingError,
  StateCorruptError
});

const townHallPublicationHandlers = createTownHallPublicationHandlers({
  BindingError,
  StateCorruptError,
  discordNonce,
  probePid: pid => process.kill(pid, 0)
});

const replyLifecycleHandlers = createReplyLifecycleHandlers({ assertProvider, assertText, assertUuid, StaleGenerationError, assertNativeReplyFileManifest, BindingError, REPLY_LIMIT, AuthorizationError, NATIVE_ACK_RECEIPT, MESSAGE_STATES, now, NATIVE_REPLY_FILE_PHASES, splitReply, discordNonce, safeDetail, REPLY_COMPLETED_WITHOUT_POST, rowReplyPart });

const messageIntakeHandlers = createMessageIntakeHandlers({
  assertText, bindingMatchesExpected, INTAKE_BOUNDARY_DETAILS, threadEnrollmentHandlers,
  compareDiscordIds, watcherNoticeHandlers, BindingError, MESSAGE_STATES, now
});

const messageDispatchHandlers = createMessageDispatchHandlers({ BindingError, StaleGenerationError, AuthorizationError, MESSAGE_STATES, READINESS, NATIVE_ACK_RECEIPT, parseJson, safeDetail, now, legacyAgentRequestRoute });

const transportReceiptHandlers = createTransportReceiptHandlers({
  assertText, BindingError, MESSAGE_STATES, INTERACTION_TRANSPORT, READINESS, bindingMatchesExpected,
  parseJson, TRANSPORT_RECEIPT_ATTEMPT, TRANSPORT_RECEIPT_OUTCOME, TRANSPORT_RECEIPT_OUTCOMES, discordNonce
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

const ordinaryClaudeBindingHandlers = createOrdinaryClaudeBindingHandlers({
  BindingError,
  PROVIDERS,
  READINESS,
  assertOrdinaryIdentity,
  assertOrdinaryNativeIdentity,
  bindingMatchesExpected
});



const schemaHandlers = createSchemaHandlers({ SCHEMA_VERSION, StateCorruptError, parseJson, compareDiscordIds, READINESS, now });

const topicPublicationHandlers = createTopicPublicationHandlers({ assertText, BindingError, UnresolvedWorkError, StaleGenerationError, READINESS, TOPIC_PUBLICATION_STATES, bindingMatchesExpected, now });

const conductorCustodyHandlers = createConductorCustodyHandlers({
  ACTIVE_STATES,
  MESSAGE_STATES,
  BindingError,
  StaleGenerationError,
  UnresolvedWorkError,
  now
});

const bindingLifecycleHandlers = createBindingLifecycleHandlers({
  ADOPTION_REFUSAL_DETAILS,
  BindingError,
  ORDINARY_RECEIPT_KINDS,
  PROVIDERS,
  READINESS,
  StaleGenerationError,
  UnresolvedWorkError,
  assertConductorId,
  assertEndpoint,
  assertOrdinaryIdentity,
  assertOrdinaryNativeIdentity,
  assertProvider,
  assertRepoKey,
  assertText,
  assertUuid,
  bindingMatchesExpected,
  conductorCustodyHandlers,
  now,
  ordinaryBindingHandlers,
  parseJson,
  persistenceRefusal,
  qualifiedCoverageId,
  rowBinding,
  threadEnrollmentHandlers
});

const messageRecoveryHandlers = createMessageRecoveryHandlers({ boardRefreshHandlers, topicPublicationHandlers, decisionHandlers, courierRouteHandlers, MESSAGE_STATES, COURIER_OUTCOMES, COURIER_RECEIPT_KINDS, TRANSPORT_RECEIPT_OUTCOME, TRANSPORT_RECEIPT_ATTEMPT, INTERACTION_TRANSPORT, parseJson, now, BindingError });
const provisionIntentHandlers = createProvisionIntentHandlers({ assertProvider, assertUuid, assertConductorId, assertRepoKey, assertText, assertEndpoint, BindingError, now });

class SurfaceState {
  constructor(dbPath, options = {}) {
    if (!path.isAbsolute(dbPath)) throw new TypeError('dbPath must be absolute');
    const existed = fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;
    const readOnly = options.readOnly === true;
    if ((options.requireCurrentSchema || readOnly) && !existed) throw new StateCorruptError('state database is missing');
    if (!readOnly) ensurePrivateDir(path.dirname(dbPath));
    try {
      this.db = readOnly ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath);
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
      if (existed) {
        if (!readOnly && !options.requireCurrentSchema) this.migrateSchema();
        this.assertSchema();
      } else {
        this.createSchema();
        this.assertSchema();
      }
      if (!readOnly) fs.chmodSync(dbPath, 0o600);
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
    this.threadBoundaryObserver = null;
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

  createSchema() { return schemaHandlers.createSchema.apply(this, arguments); }

  tableColumns(table) { return schemaHandlers.tableColumns.apply(this, arguments); }

  ensureThreadEnrollmentSchema() { return schemaHandlers.ensureThreadEnrollmentSchema.apply(this, arguments); }

  ensureNativeReplyFileSchema() { return schemaHandlers.ensureNativeReplyFileSchema.apply(this, arguments); }

  ensureDirectPostIndexes() { return schemaHandlers.ensureDirectPostIndexes.apply(this, arguments); }

  migrateSchema() { return schemaHandlers.migrateSchema.apply(this, arguments); }

  assertColumns(table, required) { return schemaHandlers.assertColumns.apply(this, arguments); }

  assertForeignKey(table, from, target, to) { return schemaHandlers.assertForeignKey.apply(this, arguments); }

  assertSchema() { return schemaHandlers.assertSchema.apply(this, arguments); }

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

  listTopicPublications(channelId = null) { return topicPublicationHandlers.listTopicPublications.apply(this, arguments); }

  getTopicPublication(requestId) { return topicPublicationHandlers.getTopicPublication.apply(this, arguments); }

  hasUnresolvedTopicPublication(channelId) { return topicPublicationHandlers.hasUnresolvedTopicPublication.apply(this, arguments); }

  assertTopicPublicationSettled(channelId) { return topicPublicationHandlers.assertTopicPublicationSettled.apply(this, arguments); }

  assertLegacyMigrationSafe(channelId) { return topicPublicationHandlers.assertLegacyMigrationSafe.apply(this, arguments); }

  beginTopicPublication(channelId, publication, expectedBinding) { return topicPublicationHandlers.beginTopicPublication.apply(this, arguments); }

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
    return bindingLifecycleHandlers.bindingInput.call(this, binding, existing);
  }

  bind(binding, options = {}) {
    return bindingLifecycleHandlers.bind.call(this, binding, options);
  }

  _bindOrdinary(binding, identity, adoptionCutoff = null, options = {}) {
    return ordinaryBindingHandlers.bindOrdinary(this, binding, identity, adoptionCutoff, options);
  }

  _bindOrdinaryClaude(binding, identity, adoptionCutoff = null, options = {}) {
    return ordinaryClaudeBindingHandlers.bindOrdinaryClaude(this, binding, identity, adoptionCutoff, options);
  }

  _rebindOrdinary(binding, identity, nativeProof = null, intakeCutoff = null, options = {}) {
    return ordinaryBindingHandlers.rebindOrdinary(this, binding, identity, nativeProof, intakeCutoff, options);
  }

  _rebindOrdinaryClaude(binding, identity, intakeCutoff = null, options = {}) {
    return ordinaryClaudeBindingHandlers.rebindOrdinaryClaude(this, binding, identity, intakeCutoff, options);
  }

  _isOrdinaryBindingRecord(binding) {
    if (binding?.provider === PROVIDERS.CODEX) return ordinaryBindingHandlers.isOrdinaryBindingRecord(this, binding);
    if (binding?.provider === PROVIDERS.CLAUDE) return ordinaryClaudeBindingHandlers.isOrdinaryBindingRecord(this, binding);
    return false;
  }

  _isOrdinaryBinding(binding) {
    if (binding?.provider === PROVIDERS.CODEX) return ordinaryBindingHandlers.isOrdinaryBinding(this, binding);
    if (binding?.provider === PROVIDERS.CLAUDE) return ordinaryClaudeBindingHandlers.isOrdinaryBinding(this, binding);
    return false;
  }

  _hasOrdinaryPreflight(binding) {
    if (binding?.provider === PROVIDERS.CODEX) return ordinaryBindingHandlers.hasOrdinaryPreflight(this, binding);
    if (binding?.provider === PROVIDERS.CLAUDE) return ordinaryClaudeBindingHandlers.hasOrdinaryPreflight(this, binding);
    return false;
  }

  _recordOrdinaryPreflight(binding, detail = {}) {
    if (binding?.provider === PROVIDERS.CODEX) return ordinaryBindingHandlers.recordOrdinaryPreflight(this, binding, detail);
    if (binding?.provider === PROVIDERS.CLAUDE) return ordinaryClaudeBindingHandlers.recordOrdinaryPreflight(this, binding, detail);
    return this.transaction(() => {
      const current = this.getBinding(binding?.channelId);
      if (!bindingMatchesExpected(current, binding)) return null;
      if (!this._isOrdinaryBinding(current)) throw new BindingError(`binding is not an ordinary ${current?.provider || 'native'} binding`);
      return null;
    });
  }

  rebind(binding, options) {
    return bindingLifecycleHandlers.rebind.call(this, binding, options);
  }

  unbind(channelId, options) {
    return bindingLifecycleHandlers.unbind.call(this, channelId, options);
  }

  getBinding(channelId) {
    return bindingLifecycleHandlers.getBinding.call(this, channelId);
  }

  listBindings() {
    return bindingLifecycleHandlers.listBindings.call(this);
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

  setThreadBoundaryObserver(observer) {
    this.threadBoundaryObserver = typeof observer === 'function' ? observer : null;
  }

  assertThreadEnrollmentCoverage(parentChannelId, proof) {
    return threadEnrollmentHandlers.assertEnrollmentCoverage(this, parentChannelId, proof);
  }

  _notifyThreadBoundaryTransition(previous, updated) {
    if (previous && updated && previous.state !== updated.state) {
      try { this.threadBoundaryObserver?.(previous, updated); } catch {}
    }
  }

  deactivateThreadEnrollments(parentChannelId, expectedBinding = null) {
    return threadEnrollmentHandlers.deactivateThreadEnrollments(this, parentChannelId, expectedBinding);
  }

  _hasActiveThreadEnrollments(parentChannelId) {
    return Boolean(this.db.prepare('SELECT 1 FROM thread_enrollments WHERE parent_channel_id=? AND active=1 LIMIT 1').get(parentChannelId));
  }

  setThreadBaseline(threadId, latestId, expectedBinding = null, expectedEnrollment = undefined) {
    return threadEnrollmentHandlers.setThreadBaseline(this, threadId, latestId, expectedBinding, expectedEnrollment);
  }

  markThreadBoundary(threadId, state, detail = null, gapFrom = null, gapTo = null, expectedBinding = null, coverageId = undefined, lastSeenBaselineId = undefined, expectedEnrollment = undefined) {
    const previous = this.getThreadEnrollment(threadId);
    const updated = threadEnrollmentHandlers.markThreadBoundary(this, threadId, state, detail, gapFrom, gapTo, expectedBinding, coverageId, lastSeenBaselineId, expectedEnrollment);
    this._notifyThreadBoundaryTransition(previous, updated);
    return updated;
  }

  noteThreadMessage(threadId, messageId, accepted = false, coverageId = null) {
    const previous = this.getThreadEnrollment(threadId);
    const updated = threadEnrollmentHandlers.noteThreadMessage(this, threadId, messageId, accepted, coverageId);
    this._notifyThreadBoundaryTransition(previous, updated);
    return updated;
  }

  checkpointThread(threadId, coverageId, expectedBinding = null, expectedEnrollment = undefined) {
    return threadEnrollmentHandlers.checkpointThread(this, threadId, coverageId, expectedBinding, expectedEnrollment);
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

  claimCourierForward(...args) {
    return courierRouteHandlers.claimCourierForward(this, ...args);
  }

  readCourierInput(...args) {
    return courierRouteHandlers.readCourierInput(this, ...args);
  }

  hasCourierForwardClaim(...args) {
    return courierRouteHandlers.hasCourierForwardClaim(this, ...args);
  }

  hasRetiredCourierAttempt(...args) {
    return courierRouteHandlers.hasRetiredCourierAttempt(this, ...args);
  }

  recordCourierOutcome(...args) {
    return courierRouteHandlers.recordCourierOutcome(this, ...args);
  }

  recoverCourierAttempt(...args) {
    return courierRouteHandlers.recoverCourierAttempt(this, ...args);
  }

  getCourierDeliveryStatus(...args) {
    return courierRouteHandlers.getCourierDeliveryStatus(this, ...args);
  }

  createTownHallBroadcast(...args) {
    return townHallJournalHandlers.createTownHallBroadcast(this, ...args);
  }

  getTownHallBroadcast(...args) {
    return townHallJournalHandlers.getTownHallBroadcast(this, ...args);
  }

  listTownHallBroadcasts(...args) {
    return townHallJournalHandlers.listTownHallBroadcasts(this, ...args);
  }

  reserveTownHallPublication(...args) {
    return townHallPublicationHandlers.reserveTownHallPublication(this, ...args);
  }

  getTownHallPublication(...args) {
    return townHallPublicationHandlers.getTownHallPublication(this, ...args);
  }

  markTownHallPublicationInFlight(...args) {
    return townHallPublicationHandlers.markTownHallPublicationInFlight(this, ...args);
  }

  recordTownHallPublicationOutcome(...args) {
    return townHallPublicationHandlers.recordTownHallPublicationOutcome(this, ...args);
  }

  recoverTownHallPublication(...args) {
    return townHallPublicationHandlers.recoverTownHallPublication(this, ...args);
  }

  confirmTownHallPublication(...args) {
    return townHallPublicationHandlers.confirmTownHallPublication(this, ...args);
  }

  findNativeBinding(nativeId, provider = null) { return bindingLifecycleHandlers.findNativeBinding.apply(this, arguments); }

  findConductorBinding(conductorId, provider) { return bindingLifecycleHandlers.findConductorBinding.apply(this, arguments); }

  setBindingReadiness(channelId, readiness, detail = null, expectedBinding = null) { return bindingLifecycleHandlers.setBindingReadiness.apply(this, arguments); }

  findConductorHandoff(handoffId) { return bindingLifecycleHandlers.findConductorHandoff.apply(this, arguments); }

  _findOrdinaryHandoff(handoffId) {
    assertText(handoffId, 'handoffId', 256);
    const rows = this.db.prepare('SELECT detail FROM receipts WHERE kind=? ORDER BY id DESC').all(ORDINARY_RECEIPT_KINDS.HANDOFF);
    for (const row of rows) {
      const detail = parseJson(row.detail, {});
      if (detail.handoffId === handoffId) return detail;
    }
    return null;
  }

  hasUnboundReceipt(channelId, generation) { return bindingLifecycleHandlers.hasUnboundReceipt.apply(this, arguments); }

  _handoffOrdinary(input) {
    return ordinaryBindingHandlers.handoffOrdinary(this, input);
  }

  handoffConductor(input) { return bindingLifecycleHandlers.handoffConductor.apply(this, arguments); }

  assertNativeOwnerFree(provider, nativeId, channelId = null) { return bindingLifecycleHandlers.assertNativeOwnerFree.apply(this, arguments); }

  assertConductorOwnerFree(provider, conductorId, channelId = null) { return bindingLifecycleHandlers.assertConductorOwnerFree.apply(this, arguments); }

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

  hasUnresolvedBindingPost(channelId) {
    return directPostHandlers.hasUnresolvedBindingPost(this, channelId) ||
      boardRefreshHandlers.hasUnresolvedBindingPost(this, channelId);
  }

  hasUnresolvedOrdinaryPost(channelId) {
    return this.hasUnresolvedBindingPost(channelId);
  }

  reject(reason) {
    return { accepted: false, reason };
  }

  upsertIntakeWatermark(event, ready, coverageId = null) {
    return intakeHandlers.upsertIntakeWatermark(this, event, ready, coverageId);
  }

  getIntakeWatermark(channelId) {
    return intakeHandlers.getIntakeWatermark(this, channelId);
  }

  hasIntakeEvidence(discordId) {
    return intakeHandlers.hasIntakeEvidence(this, discordId);
  }

  checkpointIntake(channelId, coverageId, expectedBinding = null) {
    return intakeHandlers.checkpointIntake(this, channelId, coverageId, expectedBinding);
  }

  setIntakeBaseline(channelId, lastSeenId, detail, expectedBinding = null, expectedBoundary = undefined, expectedReadiness = undefined) {
    return intakeHandlers.setIntakeBaseline(this, channelId, lastSeenId, detail, expectedBinding, expectedBoundary, expectedReadiness);
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

  markIntakeBoundary(channelId, state, detail = null, gapFrom = null, gapTo = null, expectedBinding = null, pauseMetadata = null, expectedBoundary = undefined, expectedReadiness = undefined) {
    return intakeHandlers.markIntakeBoundary(this, channelId, state, detail, gapFrom, gapTo, expectedBinding, pauseMetadata, expectedBoundary, expectedReadiness);
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

  recordTopicPublication(channelId, publication, expectedBinding = null) { return topicPublicationHandlers.recordTopicPublication.apply(this, arguments); }

  reconcileTopicPublication(channelId, requestId, resolution, evidenceScope, readback = null) { return topicPublicationHandlers.reconcileTopicPublication.apply(this, arguments); }

  reconcileIntake(channelId, expectedBinding = null, expectedBoundary = null) {
    const childEnrollment = typeof channelId === 'string' && channelId.length > 0 && channelId.length <= 128
      ? this.db.prepare('SELECT 1 FROM thread_enrollments WHERE thread_id=? AND active=1').get(channelId)
      : null;
    if (childEnrollment) {
      return threadEnrollmentHandlers.reconcileThread(this, channelId, expectedBinding);
    }
    return intakeHandlers.reconcileIntake(this, channelId, expectedBinding, expectedBoundary);
  }

  acceptDiscordMessage(event, options = {}) {
    const result = messageIntakeHandlers.acceptDiscordMessage.call(this, event, options);
    if (!result?.accepted || options.ready === false) return result;
    const deliveryChannelId = result.message?.deliveryChannelId || result.message?.delivery_channel_id ||
      event?.deliveryChannelId || event?.delivery_channel_id || event?.channelId;
    const route = deliveryChannelId ? this.getMessageRoute(deliveryChannelId) : null;
    return route?.ready ? result : { ...result, held: true };
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

  getTransportReceipt(messageId, transport = null) { return transportReceiptHandlers.getTransportReceipt.apply(this, arguments); }

  beginTransportReceipt(messageId, options = {}) { return transportReceiptHandlers.beginTransportReceipt.apply(this, arguments); }

  authorizeTransportReceipt(messageId, expectedBinding) { return transportReceiptHandlers.authorizeTransportReceipt.apply(this, arguments); }

  recordTransportReceiptOutcome(messageId, outcome, detail = {}, transport = null) { return transportReceiptHandlers.recordTransportReceiptOutcome.apply(this, arguments); }

  currentMessageBinding(message) { return messageDispatchHandlers.currentMessageBinding.apply(this, arguments); }

  hasNativeAcknowledgment(message) { return messageDispatchHandlers.hasNativeAcknowledgment.apply(this, arguments); }

  recoverNativeReplyAcknowledgment(messageId) { return messageDispatchHandlers.recoverNativeReplyAcknowledgment.apply(this, arguments); }

  assertMessageCurrent(messageId, phase) { return messageDispatchHandlers.assertMessageCurrent.apply(this, arguments); }

  claimDispatch(messageId) { return messageDispatchHandlers.claimDispatch.apply(this, arguments); }

  markSubmitted(messageId, cursor = null, marker = null) { return messageDispatchHandlers.markSubmitted.apply(this, arguments); }

  setObserverCursor(messageId, cursor, marker = null) { return messageDispatchHandlers.setObserverCursor.apply(this, arguments); }

  markObservationUnavailable(messageId, detail) { return messageDispatchHandlers.markObservationUnavailable.apply(this, arguments); }

  markUncertain(messageId, error) { return messageDispatchHandlers.markUncertain.apply(this, arguments); }

  markNotSubmitted(messageId, error) { return messageDispatchHandlers.markNotSubmitted.apply(this, arguments); }

  transition(messageId, expected, next, kind, error) { return messageDispatchHandlers.transition.apply(this, arguments); }

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

  recordNativeReply(input) { return replyLifecycleHandlers.recordNativeReply.call(this, input); }

  listReplyParts(messageId) { return replyLifecycleHandlers.listReplyParts.apply(this, arguments); }

  beginReply(messageId) { return replyLifecycleHandlers.beginReply.apply(this, arguments); }

  markReplyPartSent(messageId, partIndex, replyMessageId) { return replyLifecycleHandlers.markReplyPartSent.apply(this, arguments); }

  markReplyPartSkipped(messageId, partIndex) { return replyLifecycleHandlers.markReplyPartSkipped.apply(this, arguments); }

  markReplySent(messageId, replyMessageId) { return replyLifecycleHandlers.markReplySent.apply(this, arguments); }

  markReplyFailure(messageId, error, unknown = false, partIndex = null) { return replyLifecycleHandlers.markReplyFailure.apply(this, arguments); }

  reconcileReplyDelivery(messageId, resolution, options = {}) { return replyLifecycleHandlers.reconcileReplyDelivery.call(this, messageId, resolution, options); }
  recoverAfterRestart(ownerAlive = null) { return messageRecoveryHandlers.recoverAfterRestart.apply(this, arguments); }

  directPostRows(requestId = null, channelId = null, relatedChannelIds = []) {
    return queryDirectPostRows({
      db: this.db,
      assertText,
      parseJson,
      StateCorruptError,
      attemptKind: DIRECT_POST_ATTEMPT,
      outcomeKind: DIRECT_POST_OUTCOME
    }, requestId, channelId, relatedChannelIds);
  }

  getBindingReadinessReceipt(channelId) {
    assertText(channelId, 'channelId', 128);
    const row = this.db.prepare(`SELECT detail FROM receipts WHERE kind='binding-readiness'
      AND json_extract(detail, '$.channelId')=? ORDER BY id DESC LIMIT 1`).get(channelId);
    return row ? parseJson(row.detail, null) : null;
  }

  listAgentCompletionReceipts(messageId, kind) {
    assertText(messageId, 'messageId', 128);
    assertText(kind, 'kind', 128);
    return this.db.prepare('SELECT id, detail FROM receipts WHERE discord_id=? AND kind=? ORDER BY id')
      .all(messageId, kind)
      .map(row => ({ id: Number(row.id), detail: parseJson(row.detail, null) }));
  }

  listAgentMessageReceiptIds(packetId) {
    assertText(packetId, 'packetId', 128);
    return this.db.prepare(`SELECT discord_id FROM receipts WHERE kind='agent-message' AND
      (json_extract(detail, '$.packet.id')=? OR json_extract(detail, '$.packet.replyTo')=?) ORDER BY id`)
      .all(packetId, packetId)
      .map(row => row.discord_id);
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

  directPostBindingCurrent(binding, operatorId = null, deliveryChannelId = null, allowUnreadyDelivery = false) {
    const config = this.requireConfig();
    const current = this.getBinding(binding?.channelId);
    const parentCurrent = Boolean(binding && current && bindingMatchesExpected(current, binding) && current.guildId === config.guildId &&
      (operatorId === null || config.operatorId === operatorId));
    if (!parentCurrent) return false;
    if (deliveryChannelId === null || deliveryChannelId === binding.channelId) return true;
    const route = this.getMessageRoute(deliveryChannelId);
    return Boolean(route?.enrollment?.active && route.enrollment.threadId === deliveryChannelId &&
      route.enrollment.parentChannelId === current.channelId && route.enrollment.guildId === config.guildId &&
      route.binding.channelId === current.channelId && (route.ready || allowUnreadyDelivery));
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

  withdrawAgentRequest(args) {
    return agentRequestWithdrawalHandlers.withdrawAgentRequest(this, args);
  }

  agentWithdrawalRequesterSessionRoot(messageId, packetId) {
    return agentRequestWithdrawalHandlers.requesterSessionRoot(this, messageId, packetId);
  }

  isAgentResultForWithdrawnRequest(packet) {
    return agentRequestWithdrawalHandlers.isAgentResultForWithdrawnRequest(this, packet);
  }

  isAgentRequestWithdrawn(packet) {
    return agentRequestWithdrawalHandlers.isAgentRequestWithdrawn(this, packet);
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
  recoveryCandidates(before = null) { return messageRecoveryHandlers.recoveryCandidates.apply(this, arguments); }
  reconcileUncertain(messageId, resolution) { return messageRecoveryHandlers.reconcileUncertain.apply(this, arguments); }

  beginProvisionIntent(intent) {
    return provisionIntentHandlers.beginProvisionIntent(this, ...arguments);
  }

  completeProvisionIntent(provider, nativeId, channelId, conductorId = null) {
    return provisionIntentHandlers.completeProvisionIntent(this, ...arguments);
  }

  getAgentMessage(messageId) {
    return messageReadHandlers.getAgentMessage.apply(this, arguments);
  }

  getWatcherNotice(messageId) {
    return messageReadHandlers.getWatcherNotice.apply(this, arguments);
  }

  getMessage(messageId) {
    return messageReadHandlers.getMessage.apply(this, arguments);
  }

  getMessageRowId(messageId) {
    return messageReadHandlers.getMessageRowId.apply(this, arguments);
  }

  listMessages() {
    return messageReadHandlers.listMessages.apply(this, arguments);
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
  AGENT_WITHDRAWAL_RECEIPTS,
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
  COURIER_DELIVERY_STATUSES,
  COURIER_OUTCOMES,
  COURIER_RECEIPT_KINDS,
  COURIER_RECOVERY_REASONS,
  COURIER_RESULT_STATUSES,
  COURIER_ROUTE_STATES,
  COURIER_SOURCE_KINDS,
  TOWN_HALL_JOURNAL_RECEIPTS,
  TOWN_HALL_JOURNAL_STATES,
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
