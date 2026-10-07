const { createLiveCheckpointHandlers } = require('./discord/live-checkpoint');
const { createLiveAttachmentRecoveryHandlers } = require('./discord/live-attachment-recovery');
const { createInboundRecoveryHandlers } = require('./discord/inbound-recovery');
const { createPendingReconciliationHandlers } = require('./discord/pending-reconciliation');
const { createTransportRecoveryWaiter } = require('./discord/transport-recovery-waiter');
const { createTransportRecoveryHandlers } = require('./discord/transport-recovery');
const path = require('node:path');
const {
  AGENT_ATTACHMENT_RECOVERY_KINDS,
  fetchAgentAttachment,
  normalizeAgentMessage
} = require('./agent-attachment');
const fs = require('node:fs');
const { ACK_WAITING, acknowledgmentCommand, createAcknowledgmentDelivery, waitForAcknowledgment, watchAcknowledgments } = require('./acknowledgment');
const { CODEX_VALIDATION_KINDS, agentCompletionCommand, watcherNoticeCompletionCommand, ClaudeProvider, CodexProvider, probeClaudeChannel, validateCodexSessionIdentity, validateCodexSessionIdentityAsync, waitForReply } = require('./native');
const { DISPATCH_OUTCOMES, MESSAGE_STATES, READINESS, RECOVERY_LIMITS, UnresolvedWorkError } = require('./state');
const { CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX } = require('./ordinary/constants');
const { conductorMarkerMatches } = require('./topic');
const { readDirectPostFileSnapshot } = require('./direct-post-file');
const { assertPublicThread, historyPermission, recoverThread } = require('./discord/thread-enrollment');
const {
  classifyRecoveryFailure,
  isInterruptedRetryBoundary,
  isPreAdoptionRetryableThread,
  isRetryableFetchBoundary,
  isRetryableIntakeBoundary,
  refusesUnqualifiedBaseline,
  recoveryFetch,
  retryPendingBoundaryDetail
} = require('./discord/recovery-fetch');
const { NATIVE_PROOF_PHASES, nativeProofDeadlineDetail, isNativeProofRetryBoundary, isNativeProofBeforeBindingBoundary } = require('./discord/native-proof-recovery');
const {
  attachReconciliationWaiter,
  hasReconciliationLookup,
  invalidateReconciliationWaiters,
  pruneReconciliationWaiters,
  startReconciliationLookup,
  storeReconciliationSnapshot
} = require('../dist/discord/reconciliation-lookups.js');
const { THREAD_STATES } = require('./state/thread-enrollment');
const { heldParentRequestIds, legacyParentReconciliationChannel } = require('./state/legacy-agent-request-route');
const { parseComponentInteraction, parseCsInteraction, sendInteractionCallback, upsertGuildCsCommand } = require('./discord-interaction');
const { createDecisionConsumer } = require('./discord/decision');
const { sendDiscordMessage, fetchDiscordChannel } = require('./discord/http-transport');
const { sendGatewayTransportReceipt } = require('./discord/transport-receipts');
const { createSurfaceConsumer: createSurfaceConsumerImpl } = require('./discord/surface-consumer');
const { createGatewayLifecycleHandlers } = require('./discord/lifecycle');

const requireInstalled = require;
const DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS = 100;
const DEFERRED_HANDOFF_RECOVERY_MAX_DELAY_MS = 5000;
const LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS = 1000;
const LIVE_CHECKPOINT_RETRY_MAX_DELAY_MS = 30_000;
const PENDING_HANDOFF_RECOVERY_POLL_MS = 100;
const INTERACTION_CALLBACK_TIMEOUT_MS = 2500;
const RECOVERY_WAITER_DEADLINE_GRACE_MS = 250;
const CLOSING_CUSTODY_DETAIL = 'live Discord custody arrived while recovery readiness was closing';
const RECOVERY_POLICIES = Object.freeze({
  FULL: 'full',
  UNRESOLVED: 'unresolved'
});
const INTERACTION_REJECTION_MESSAGES = Object.freeze({
  'inactive-binding': 'This channel is not connected to an active status session.',
  'binding-not-ready': 'The status session is still recovering. Try again shortly.',
  'handoff-intake-paused': 'Status intake is paused during handoff. Try again shortly.',
  'unauthorized-interaction': 'You are not authorized to use /cs.',
  'unknown-binding': 'This channel is not connected to a status session.',
  'stale-binding': 'The status session changed before /cs was accepted. Try again shortly.'
});
const gatewayLifecycleHandlers = createGatewayLifecycleHandlers({
  readSecret,
  recoveryError,
  CODEX_VALIDATION_KINDS,
  READINESS,
  THREAD_STATES,
  isNativeProofRetryBoundary,
  CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX,
  watchAcknowledgments,
  MESSAGE_STATES,
  ACK_WAITING,
  invalidateReconciliationWaiters,
  DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS,
  LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS
});

function recoveryError(kind, detail) {
  const error = new Error(detail);
  error.recoveryKind = kind;
  return error;
}

function waitForRecoveryOperation(operation, signal, deadline, onDeadline = null) {
  if (signal?.aborted) return Promise.reject(recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Discord recovery was stopped'));
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(recoveryError(CODEX_VALIDATION_KINDS.DEADLINE, 'Discord recovery deadline exceeded'));
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Discord recovery was stopped'));
    timer = setTimeout(() => {
      try { onDeadline?.(); } finally { finish(reject, recoveryError(CODEX_VALIDATION_KINDS.DEADLINE, 'Discord recovery deadline exceeded')); }
    }, remaining);
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(operation).then(
      value => finish(resolve, value),
      error => finish(reject, error)
    );
  });
}

function recoveryKind(error) {
  return error?.recoveryKind || null;
}

function interactionRejectionMessage(reason) {
  return INTERACTION_REJECTION_MESSAGES[reason] || 'The status command is temporarily unavailable. Try again shortly.';
}

function compareDiscordIds(left, right) {
  try {
    const a = BigInt(left);
    const b = BigInt(right);
    return a === b ? 0 : a > b ? 1 : -1;
  } catch {
    return String(left).localeCompare(String(right));
  }
}

function discordIdAfter(left, right) {
  if (!left || !right) return false;
  return compareDiscordIds(left, right) > 0;
}

function conductorMarkerMatchesTopic(topic, binding) {
  if (!binding.conductorId && !binding.repoKey) return true;
  if (!binding.conductorId || !binding.repoKey || typeof topic !== 'string') return false;
  return conductorMarkerMatches(topic, binding);
}

function bindingIdentityMatches(expected, current) {
  return Boolean(current?.active) && current.channelId === expected.channelId && current.guildId === expected.guildId &&
    current.provider === expected.provider && current.nativeId === expected.nativeId &&
    current.generation === expected.generation && current.conductorId === expected.conductorId && current.repoKey === expected.repoKey;
}

// F12: a resolved channel is only usable when its guild/channel identity agrees with
// the stored message destination tuple. Absent stored metadata stays compatible.
function storedChannelMatches(channel, stored) {
  if (!stored) return true;
  const expectedChannelId = stored.deliveryChannelId || stored.channelId;
  if (typeof expectedChannelId === 'string' && expectedChannelId &&
      typeof channel?.id === 'string' && channel.id !== expectedChannelId) return false;
  if (typeof stored.guildId === 'string' && stored.guildId &&
      typeof channel?.guildId === 'string' && channel.guildId !== stored.guildId) return false;
  return true;
}

function readSecret(secretFile) {
  if (!fs.existsSync(secretFile)) throw new Error('Discord secret file does not exist');
  const mode = fs.statSync(secretFile).mode & 0o777;
  if (mode & 0o077) throw new Error('Discord secret file must be owner-only');
  const lines = fs.readFileSync(secretFile, 'utf8').split(/\r?\n/);
  const assignment = lines.find(line => /^\s*DISCORD_TOKEN\s*=/.test(line));
  const match = assignment?.match(/^\s*DISCORD_TOKEN\s*=\s*(.*?)\s*$/);
  if (!match) throw new Error('Discord secret file must contain a DISCORD_TOKEN assignment');
  let token = match[1];
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) token = token.slice(1, -1);
  if (!token) throw new Error('Discord secret file contains an empty DISCORD_TOKEN');
  return token;
}

function eventToInput(message) {
  let attachments = message.attachments;
  if (attachments === undefined || attachments === null) attachments = [];
  else if (!Array.isArray(attachments) && typeof attachments.values === 'function') {
    try { attachments = [...attachments.values()]; } catch {}
  }
  if (Array.isArray(attachments)) {
    attachments = attachments.map(attachment => attachment && typeof attachment === 'object' ? {
      url: attachment.url,
      filename: attachment.filename ?? attachment.name,
      contentType: attachment.contentType ?? null,
      size: attachment.size
    } : attachment);
  }
  return {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    authorId: message.author?.id,
    isBot: Boolean(message.author?.bot),
    content: message.content,
    attachments,
    nonce: message.nonce == null ? null : String(message.nonce)
  };
}

function classifyReplyError(error) {
  if (error?.outcome) return error.outcome;
  if (/authorization|stale|custody|generation/i.test(error?.message || '')) return 'failed';
  if ([400, 401, 403, 404, 413].includes(error?.status) || error?.code === 50013) return 'failed';
  if (error?.status >= 500 || error?.potentiallyDelivered || error?.wrote || error?.name === 'TypeError') return 'unknown';
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.code)) return 'unknown';
  return 'unknown';
}

function createSurfaceConsumer(options) {
  return createSurfaceConsumerImpl(options, { recoveryError, recoveryKind, compareDiscordIds, bindingIdentityMatches, eventToInput, classifyReplyError });
}

const liveAttachmentRecovery = createLiveAttachmentRecoveryHandlers({ recoveryKind, bindingIdentityMatches, AGENT_ATTACHMENT_RECOVERY_KINDS, CODEX_VALIDATION_KINDS, READINESS, THREAD_STATES });
const inboundRecovery = createInboundRecoveryHandlers({
  isNativeProofBeforeBindingBoundary,
  READINESS,
  compareDiscordIds,
  isRetryableIntakeBoundary,
  isInterruptedRetryBoundary,
  isNativeProofRetryBoundary,
  nativeProofDeadlineDetail,
  NATIVE_PROOF_PHASES,
  classifyRecoveryFailure,
  recoveryError,
  CODEX_VALIDATION_KINDS,
  CLOSING_CUSTODY_DETAIL,
  waitForRecoveryOperation,
  retryPendingBoundaryDetail,
  recoveryFetch,
  recoveryKind,
  isRetryableFetchBoundary,
  CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX,
  conductorMarkerMatchesTopic,
  refusesUnqualifiedBaseline,
  recoverThread,
  THREAD_STATES
});
const pendingReconciliation = createPendingReconciliationHandlers({ heldParentRequestIds, MESSAGE_STATES, CODEX_VALIDATION_KINDS, recoveryKind, waitForRecoveryOperation, startReconciliationLookup, recoveryFetch, attachReconciliationWaiter, storeReconciliationSnapshot, hasReconciliationLookup, assertPublicThread, storedChannelMatches, conductorMarkerMatchesTopic, DISPATCH_OUTCOMES });
const transportRecovery = createTransportRecoveryHandlers({ READINESS, THREAD_STATES, RECOVERY_POLICIES, recoveryKind, createTransportRecoveryWaiter, RECOVERY_WAITER_DEADLINE_GRACE_MS });

const { createOutboundDeliveryHandlers } = require('./discord/outbound-delivery');
const outboundDeliveryHandlers = createOutboundDeliveryHandlers({ bindingIdentityMatches, recoveryKind, CODEX_VALIDATION_KINDS, classifyRecoveryFailure, isRetryableFetchBoundary, THREAD_STATES, recoveryFetch, assertPublicThread, storedChannelMatches, readDirectPostFileSnapshot, classifyReplyError, waitForAcknowledgment });

const liveCheckpointHandlers = createLiveCheckpointHandlers({
  heldParentRequestIds,
  CODEX_VALIDATION_KINDS,
  recoveryKind,
  THREAD_STATES,
  LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS,
  LIVE_CHECKPOINT_RETRY_MAX_DELAY_MS,
  READINESS,
  waitForRecoveryOperation,
  recoveryError,
  compareDiscordIds,
  recoverThread
});

class DiscordGateway {
  constructor({ state, stateDir = path.dirname(state.dbPath), client, logger = () => {}, observeOptions = {}, providers, fetchHistory, recoveryOptions = {}, onReady = null, interactionFetch = globalThis.fetch, courierRoute = null } = {}) {
    this.state = state;
    this.stateDir = stateDir;
    this.logger = logger;
    this.onReady = typeof onReady === 'function' ? onReady : null;
    this.interactionFetch = interactionFetch;
    this.client = client || this.createClient();
    this.discordToken = null;
    this.acknowledgments = null;
    this.controllers = new Set();
    this.receiptControllers = new Set();
    this.inFlight = new Set();
    this.stopping = false;
    this.state.setThreadBoundaryObserver?.((previous, updated) => this.noteThreadBoundaryTransition(previous, updated));
    this.stopPromise = null;
    this.startPromise = null;
    this.starting = false;
    this.started = false;
    this.lifecycleEpoch = 0;
    this.connectionEpoch = 0;
    this.recoveryController = null;
    this.recoveryPromise = null;
    this.decisionRecoveryPromise = null;
    this.decisionRecoveryController = null;
    this.recoveryFollowupPromise = null;
    this.recoveryFollowupScope = null;
    this.recoveryActiveWaiters = new Set();
    this.recoveryRetryScheduledChannels = new Set();
    this.closingCustodyRetries = new Map();
    this.pendingRecoveryChannels = new Set();
    this.pendingRecoveryRequests = [];
    this.pendingFullRecovery = false;
    this.liveCheckpointController = null;
    this.liveCheckpointPromise = null;
    this.liveIntakeCounts = new Map();
    this.liveAttachmentRecoveryTimers = new Set();
    this.attachmentIntakeBlockedChannels = new Set();
    this.attachmentIntakeRetryPendingChannels = new Set();
    this.attachmentIntakeRetryMessages = new Map();
    this.attachmentIntakeRetryInFlight = new Map();
    this.liveCheckpointRetryTimer = null;
    this.liveCheckpointRetryChannels = null;
    this.liveCheckpointRetryDelayMs = LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS;
    this.reconnectPromise = null;
    this.deferredHandoffRecoveryTimer = null;
    this.deferredHandoffRecoveryTimerDeadline = null;
    this.pendingHandoffRecoveryPollTimer = null;
    this.deferredHandoffRecoveryChannels = new Set();
    this.pendingHandoffRecoveryChannels = new Set();
    this.deferredHandoffRecoveryDelayMs = DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS;
    this.transportReady = false;
    this.interactionRecoveryPromise = null;
    this.interactionRecoveryResolve = null;
    this.fetchHistoryInjected = typeof fetchHistory === 'function';
    this.fetchHistory = fetchHistory || ((channel, options) => channel.messages?.fetch(options));
    this.historyPageLimit = Math.min(RECOVERY_LIMITS.pageSize, Math.max(1, Number(recoveryOptions.pageLimit || RECOVERY_LIMITS.pageSize)));
    this.historyMaxPages = Math.min(RECOVERY_LIMITS.maxPages, Math.max(1, Number(recoveryOptions.maxPages || RECOVERY_LIMITS.maxPages)));
    this.historyMaxMessages = Math.min(RECOVERY_LIMITS.maxMessages, Math.max(1, Number(recoveryOptions.maxMessages || RECOVERY_LIMITS.maxMessages)));
    this.recoveryTimeoutMs = Math.min(RECOVERY_LIMITS.timeoutMs, Math.max(1000, Number(recoveryOptions.timeoutMs || RECOVERY_LIMITS.timeoutMs)));
    const callbackTimeout = Number(recoveryOptions.interactionCallbackTimeoutMs);
    this.interactionCallbackTimeoutMs = Number.isFinite(callbackTimeout) && callbackTimeout > 0
      ? Math.min(3000, callbackTimeout)
      : INTERACTION_CALLBACK_TIMEOUT_MS;
    this.liveCheckpointThreshold = Math.max(1, Math.floor(this.historyMaxMessages / 2));
    this.codexSessionRoot = recoveryOptions.codexSessionRoot;
    this.ready = false;
    this.deliverAcknowledgment = createAcknowledgmentDelivery({
      state,
      send: (message, reaction) => this.sendAcknowledgment(message, reaction)
    });
    const completionFor = message => {
      if (message.watcherNotice) return watcherNoticeCompletionCommand(message, state.dbPath, undefined, this.stateDir);
      if (message.agentMessage) return agentCompletionCommand(message, state.dbPath, undefined, this.stateDir);
      return null;
    };
    this.providers = providers || {
      codex: new CodexProvider({
        acknowledgmentFor: message => acknowledgmentCommand(message, state.dbPath),
        completionFor,
        courierInputFor: envelope => {
          const routeId = envelope?.route?.routeId;
          const messageId = envelope?.messageId;
          const attemptId = envelope?.attemptId;
          const nativeId = envelope?.courier?.nativeId;
          if (typeof routeId !== 'string' || routeId.length === 0 ||
            typeof messageId !== 'string' || messageId.length === 0 ||
            typeof attemptId !== 'string' || attemptId.length === 0 ||
            typeof nativeId !== 'string' || nativeId.length === 0) return null;
          return [
            process.execPath,
            '--disable-warning=ExperimentalWarning',
            path.join(__dirname, 'cli.js'),
            'courier-input',
            '--db', state.dbPath,
            `--courier-route-id=${routeId}`,
            '--message-id', messageId,
            '--attempt-id', attemptId,
            '--native-id', nativeId
          ];
        }
      }),
      claude: new ClaudeProvider({
        waitForReply: (id, options) => waitForReply(state, id, options),
        completionFor
      })
    };
    this.ordinaryNativePreflight = recoveryOptions.ordinaryNativePreflight || (async (binding, options = {}) => {
      if (binding.provider === 'codex') return validateCodexSessionIdentityAsync(binding.nativeId, binding.workspace, binding.sessionRoot || this.codexSessionRoot, options);
      if (binding.provider === 'claude') {
        return probeClaudeChannel(binding.endpoint, {
          nativeId: binding.nativeId,
          generation: binding.generation,
          workspace: binding.workspace,
          endpoint: binding.endpoint
        });
      }
      throw new Error(`unsupported ordinary provider: ${binding.provider}`);
    });
    const onNativeUnavailable = observeOptions.onNativeUnavailable;
    this.consumer = createSurfaceConsumer({
      state,
      stateDir: this.stateDir,
      providers: this.providers,
      agentCredential: () => this.discordToken,
      agentBotId: () => this.client.user?.id || null,
      agentAttachmentFetch: recoveryOptions.agentAttachmentFetch,
      agentAttachmentTimeoutMs: this.recoveryTimeoutMs,
      readyForLiveIntake: () => this.ready,
      sendReply: (message, reply) => this.sendReply(message, reply),
      prepareReply: (messageId, signal) => this.prepareReply(messageId, signal),
      sendTransportReceipt: (message, receipt) => this.sendTransportReceipt(message, receipt),
      courierRoute: courierRoute || recoveryOptions.courierRoute || null,
      observeOptions: {
        ...observeOptions,
        onNativeUnavailable: (message, error, outcome) => {
          try { onNativeUnavailable?.(message, error, outcome); } catch {}
          this.handleNativeUnavailable(message, error, outcome);
        }
      }
    });
    this.decisionConsumer = createDecisionConsumer({
      state,
      interactionFetch: this.interactionFetch,
      callbackTimeoutMs: this.interactionCallbackTimeoutMs,
      waitForDispatch: (channelId, signal) => this.waitForInteractionDispatch({ channelId }, signal),
      processAccepted: (message, signal, options) => this.consumer.processAccepted(message, signal, options),
      project: (input, signal) => this.projectDecisionMessage(input, signal)
    });
    this.boundMessage = message => {
      if (this.stopping) return;
      let handoffRecovery = null;
      let route = this.state.getMessageRoute(message?.channelId);
      const authorityId = route?.binding.channelId || message?.channelId;
      if (typeof authorityId === 'string') {
        handoffRecovery = this.state.recoverInterruptedOrdinaryHandoffIntake?.(authorityId);
      }
      route = this.state.getMessageRoute(message?.channelId);
      const binding = route?.binding;
      if (route?.enrollment) {
        try { assertPublicThread(message.channel, binding, route.deliveryChannelId, this.client.user); }
        catch (error) {
          this.markThreadBoundary(route.deliveryChannelId, THREAD_STATES.UNAVAILABLE, error.message, null, null, binding);
          return;
        }
      }
      if (handoffRecovery?.deferred) this.scheduleDeferredHandoffRecovery(authorityId);
      else if (!handoffRecovery && binding?.active && binding.readiness === READINESS.PENDING &&
        this.state.isOrdinaryBinding?.(binding)) {
        this.scheduleDeferredHandoffRecovery(authorityId, { pendingGeneration: true });
      }
      const bindingReady = binding?.readiness === READINESS.READY && (!route?.enrollment || route.enrollment.state === THREAD_STATES.READY);
      const readyLive = this.ready && bindingReady;
      const heldReady = !this.ready && bindingReady;
      const controller = new AbortController();
      this.controllers.add(controller);
      const work = (readyLive
        ? this.consumer.handleMessage(message, controller.signal, binding, () => this.noteLiveIntake(message))
        : this.consumer.intakeMessage(message, bindingReady, null, binding, true, controller.signal).then(intake => {
          if (heldReady && !intake?.stale) this.noteLiveIntake(message);
          return intake;
        }))
        .catch(async error => {
          if (this.isAttachmentIntakeFailure(error)) {
            try {
              await this.recordLiveAttachmentGap(message, binding, error, controller.signal);
            } catch (recoveryError) {
              this.logger(`live attachment gap recovery failed: ${recoveryError.message}`);
            }
          }
          this.logger(`message handling failed: ${error.message}`);
        })
        .finally(() => {
          this.controllers.delete(controller);
        });
      this.inFlight.add(work);
      work.finally(() => this.inFlight.delete(work));
    };
    this.boundInteraction = interaction => {
      if (this.stopping) return;
      const controller = new AbortController();
      this.controllers.add(controller);
      const work = this.handleInteraction(interaction, controller.signal)
        .catch(error => this.logger(`interaction handling failed: ${error.message}`))
        .finally(() => this.controllers.delete(controller));
      this.inFlight.add(work);
      work.finally(() => this.inFlight.delete(work));
    };
    this.boundResume = () => {
      return this.beginReconnectRecovery('resume');
    };
    this.boundDisconnect = (_error, code) => this.pauseConnection(`Discord shard disconnected${code === undefined ? '' : ` (${code})`}`);
    this.boundReconnecting = shardId => this.pauseConnection(`Discord shard reconnecting${shardId === undefined ? '' : ` (${shardId})`}`);
    this.boundShardReady = shardId => {
      if (!this.started) return Promise.resolve({ ready: false, state: this.starting ? 'starting' : 'stopped' });
      return this.beginReconnectRecovery(`shard-ready${shardId === undefined ? '' : ` (${shardId})`}`);
    };
    this.client.on('messageCreate', this.boundMessage);
    this.client.on?.('interactionCreate', this.boundInteraction);
    this.client.on?.('shardResume', this.boundResume);
    this.client.on?.('resume', this.boundResume);
    this.client.on?.('shardDisconnect', this.boundDisconnect);
    this.client.on?.('shardReconnecting', this.boundReconnecting);
    this.client.on?.('shardReady', this.boundShardReady);
  }

  async handleInteraction(interaction, signal) {
    const expectedApplicationId = this.client.application?.id || null;
    const parsedComponent = parseComponentInteraction(interaction, expectedApplicationId);
    if (parsedComponent) return this.decisionConsumer.handleParsed(parsedComponent, signal);
    const parsed = parseCsInteraction(interaction, expectedApplicationId);
    if (!parsed) return { accepted: false, reason: 'invalid-interaction' };
    const binding = this.state.getBinding(parsed.channelId);
    const ownerPid = process.pid;
    const ownerIdentity = typeof this.state.directPostOwnerIdentity === 'function'
      ? this.state.directPostOwnerIdentity(ownerPid)
      : null;
    const accepted = this.state.acceptInteraction(parsed, binding, {
      claimCallback: true,
      ownerPid,
      ownerIdentity
    });
    if (!accepted.accepted) {
      if (!accepted.duplicate) await this.sendInteractionRejection(parsed, accepted.reason, signal);
      return accepted;
    }
    const callback = accepted.callback || this.state.beginInteractionCallback(parsed.id);
    if (callback.started) {
      let result;
      try {
        result = await sendInteractionCallback(parsed, {
          signal,
          fetchImpl: this.interactionFetch,
          timeoutMs: this.interactionCallbackTimeoutMs
        });
      } catch (error) {
        result = { outcome: 'unknown', reason: String(error?.message || error).slice(0, 200) };
      }
      this.state.recordInteractionCallbackOutcome(parsed.id, result.outcome, {
        ...(result.responseMessageId ? { responseMessageId: result.responseMessageId } : {}),
        ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.visibility ? { visibility: result.visibility } : {}),
        ...(result.terminal ? { terminal: true } : {})
      });
    }
    const message = this.state.getMessage(parsed.id);
    if (!message) return { accepted: false, reason: 'interaction-custody-missing' };
    if (!await this.waitForInteractionDispatch(message, signal)) return { ...accepted, message, deferred: true };
    return this.consumer.processAccepted(message, signal);
  }

  async projectDecisionMessage({ click, answer }, signal) {
    if (signal?.aborted || this.stopping) throw Object.assign(new Error('decision projection stopped'), { outcome: 'not_sent' });
    const channel = await this.client.channels?.fetch?.(click.channelId);
    const message = await channel?.messages?.fetch?.(click.messageId);
    if (!message || typeof message.edit !== 'function') {
      throw Object.assign(new Error('decision question message cannot be edited'), { outcome: 'not_sent' });
    }
    if (signal?.aborted || this.stopping) throw Object.assign(new Error('decision projection stopped'), { outcome: 'not_sent' });
    const stored = this.state.getMessage(click.interactionId);
    if (stored) {
      this.state.assertMessageCurrent(click.interactionId, 'decision-projection');
    } else {
      const config = this.state.requireConfig();
      const current = this.state.getBinding(click.channelId);
      const sameBinding = Boolean(current?.active) && current.channelId === click.binding.channelId &&
        current.guildId === click.binding.guildId && current.provider === click.binding.provider &&
        current.nativeId === click.binding.nativeId && current.workspace === click.binding.workspace &&
        (current.sessionRoot || null) === (click.binding.sessionRoot || null) &&
        (current.endpoint || null) === (click.binding.endpoint || null) &&
        (current.conductorId || null) === (click.binding.conductorId || null) &&
        (current.repoKey || null) === (click.binding.repoKey || null) && current.generation === click.binding.generation;
      if (!sameBinding || config.guildId !== click.guildId || config.operatorId !== click.actorId) {
        throw new Error('decision projection authorization is no longer valid');
      }
    }
    return message.edit({ content: answer, components: [] });
  }

  async sendInteractionRejection(interaction, reason, signal) {
    try {
      return await sendInteractionCallback(interaction, {
        signal,
        fetchImpl: this.interactionFetch,
        content: interactionRejectionMessage(reason),
        ephemeral: true,
        timeoutMs: this.interactionCallbackTimeoutMs
      });
    } catch (error) {
      this.logger(`Discord interaction rejection callback failed: ${error.message}`);
      return { outcome: 'unknown', reason: String(error?.message || error).slice(0, 200) };
    }
  }

  createInteractionRecoveryBarrier() {
    if (this.interactionRecoveryPromise) return this.interactionRecoveryPromise;
    this.interactionRecoveryPromise = new Promise(resolve => {
      this.interactionRecoveryResolve = resolve;
    });
    return this.interactionRecoveryPromise;
  }

  resolveInteractionRecovery(ready) {
    const resolve = this.interactionRecoveryResolve;
    this.interactionRecoveryResolve = null;
    const promise = this.interactionRecoveryPromise;
    this.interactionRecoveryPromise = null;
    resolve?.(Boolean(ready));
    return promise;
  }

  async waitForInteractionDispatch(message, signal) {
    if (signal?.aborted || this.stopping) return false;
    const barrier = this.interactionRecoveryPromise;
    if (barrier) {
      const ready = await new Promise(resolve => {
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        };
        const onAbort = () => finish(false);
        signal?.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(barrier).then(finish, () => finish(false));
      });
      if (!ready || signal?.aborted || this.stopping) return false;
    }
    const pending = [this.startPromise, this.reconnectPromise, this.recoveryPromise].filter(Boolean);
    if (pending.length) await Promise.all(pending.map(promise => Promise.resolve(promise).catch(() => null)));
    if (signal?.aborted || this.stopping) return false;
    if (!this.started) return false;
    if (!this.transportReady || !this.ready) return false;
    return this.state.getBinding(message.channelId)?.readiness === READINESS.READY;
  }

  async registerApplicationCommand() {
    return upsertGuildCsCommand(this.client.application?.commands, this.state.requireConfig().guildId);
  }

  queueLegacyParentReconciliation(parentChannelId, threadId = null) {
    if (this.stopping || typeof parentChannelId !== 'string') return;
    const pending = this.pendingLegacyParentRecoveryChannels || new Set();
    pending.add(parentChannelId);
    this.pendingLegacyParentRecoveryChannels = pending;
    if (typeof threadId === 'string' && threadId) {
      const pendingThreads = this.pendingLegacyParentRecoveryThreads || new Map();
      const threads = pendingThreads.get(parentChannelId) || new Set();
      threads.add(threadId);
      pendingThreads.set(parentChannelId, threads);
      this.pendingLegacyParentRecoveryThreads = pendingThreads;
    }
    this.flushLegacyParentReconciliation();
  }

  flushLegacyParentReconciliation() {
    if (this.stopping || !this.started || this.pendingLegacyParentRecoveryQueued) return;
    this.pendingLegacyParentRecoveryQueued = true;
    queueMicrotask(() => {
      this.pendingLegacyParentRecoveryQueued = false;
      if (this.stopping || !this.started) return;
      const channelIds = [...(this.pendingLegacyParentRecoveryChannels || [])];
      this.pendingLegacyParentRecoveryChannels?.clear();
      if (!channelIds.length) return;
      const affectedThreadIds = channelIds.flatMap(channelId =>
        [...(this.pendingLegacyParentRecoveryThreads?.get(channelId) || [])]);
      channelIds.forEach(channelId => this.pendingLegacyParentRecoveryThreads?.delete(channelId));
      const messageIds = heldParentRequestIds(this.state, channelIds, affectedThreadIds);
      if (!messageIds.length) return;
      void this.reconcilePending(undefined, {
        allowPaused: true,
        readyOnly: true,
        channelIds,
        messageIds
      }).catch(recoveryError => {
        this.logger(`legacy parent recovery after thread boundary failed: ${recoveryError.message}`);
      });
    });
  }

  noteThreadBoundaryTransition(previous, updated) {
    const parentChannelId = legacyParentReconciliationChannel(previous, updated);
    if (parentChannelId) this.queueLegacyParentReconciliation(parentChannelId, updated.threadId);
  }

  markThreadBoundary(...args) {
    return this.state.markThreadBoundary(...args);
  }

  createClient() {
    const { Client, GatewayIntentBits } = requireInstalled('discord.js');
    return new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  }

  markThreadDeliveryUnavailable(message, error) { return outboundDeliveryHandlers.markThreadDeliveryUnavailable.apply(this, arguments); }

  async threadDeliveryMessage(message) { return outboundDeliveryHandlers.threadDeliveryMessage.apply(this, arguments); }

  async sendReply(message, reply) { return outboundDeliveryHandlers.sendReply.apply(this, arguments); }

  prepareReply(messageId, signal) { return outboundDeliveryHandlers.prepareReply.apply(this, arguments); }

  async sendAcknowledgment(message, reaction) { return outboundDeliveryHandlers.sendAcknowledgment.apply(this, arguments); }

  async sendTransportReceipt(message, receipt) {
    return await sendGatewayTransportReceipt(this, message, receipt, waitForRecoveryOperation);
  }

  isCurrentLifecycle(epoch) {
    return !this.stopping && this.lifecycleEpoch === epoch;
  }

  pauseLiveDispatch() {
    if (this.stopping) return;
    this.ready = false;
  }

  pauseConnection(detail) {
    if (this.stopping) return;
    this.ready = false;
    this.transportReady = false;
    const retiredConnection = { gateway: this, epoch: this.connectionEpoch };
    this.connectionEpoch += 1;
    pruneReconciliationWaiters(this.client, retiredConnection);
    this.recoveryController?.abort();
    this.liveCheckpointController?.abort();
    for (const binding of this.state.listBindings().filter(item => item.active)) {
      try { this.state.setBindingReadiness(binding.channelId, READINESS.RECOVERING, detail, binding); }
      catch (error) { this.logger(`Discord disconnect readiness update failed: ${error.message}`); }
    }
  }

  beginReconnectRecovery(reason) {
    if (this.stopping) return Promise.resolve({ ready: false, state: 'stopped' });
    this.transportReady = false;
    this.createInteractionRecoveryBarrier();
    const connectionEpoch = this.connectionEpoch;
    const lifecycleEpoch = this.lifecycleEpoch;
    const previousRecovery = this.recoveryPromise;
    const previousCheckpoint = this.liveCheckpointPromise;
    const task = (async () => {
      await previousRecovery?.catch(() => {});
      await previousCheckpoint?.catch(() => {});
      if (this.stopping || connectionEpoch !== this.connectionEpoch) return { ready: false, state: 'stopped' };
      const result = await this.recoverTransport('reconnect', lifecycleEpoch);
      if (this.isCurrentLifecycle(lifecycleEpoch) && !this.stopping && connectionEpoch === this.connectionEpoch && result.state !== 'stopped') {
        this.transportReady = true;
        if (result.ready) await this.reconcilePending();
        else await this.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
        if (!this.stopping && connectionEpoch === this.connectionEpoch) this.onReady?.();
      }
      return result;
    })().catch(error => {
      this.logger(`Discord recovery failed: ${error.message}`);
      return { ready: false, state: recoveryKind(error) || 'unavailable', error };
    });
    this.reconnectPromise = task;
    task.finally(() => {
      this.resolveInteractionRecovery(this.transportReady && this.ready);
      if (this.reconnectPromise === task) this.reconnectPromise = null;
    }).catch(() => {});
    return task;
  }

  async start(secretFile) {
    return gatewayLifecycleHandlers.start.apply(this, arguments);
  }

  normalizeFetchedMessage(message, channel) {
    return {
      ...message,
      guildId: message.guildId || channel.guildId || this.state.requireConfig().guildId,
      channelId: message.channelId || channel.id,
      channel
    };
  }

  historyMessages(result) {
    if (!result) return [];
    if (Array.isArray(result)) return result;
    if (typeof result.values === 'function') return [...result.values()];
    if (typeof result[Symbol.iterator] === 'function') return [...result];
    return [];
  }

  historyPermission(channel, { requireSend = false } = {}) {
    return historyPermission(channel, this.client.user, requireSend);
  }

  async recordBoundary(binding, channel, state, detail, gapFrom = null, gapTo = null, signal = null, deadline = null, expectedBoundary = undefined, expectedReadiness = undefined) {
    if (signal?.aborted || !this.isCurrentBinding(binding)) return null;
    let watermark;
    try {
      watermark = this.state.markIntakeBoundary(binding.channelId, state, detail, gapFrom, gapTo, binding, null, expectedBoundary, expectedReadiness);
    } catch (error) {
      if (!(error instanceof UnresolvedWorkError) || state !== 'ready') throw error;
      const blockedDetail = `${detail}; legacy topic migration custody is unresolved`;
      watermark = this.state.markIntakeBoundary(binding.channelId, READINESS.UNAVAILABLE, blockedDetail, gapFrom, gapTo, binding, null, expectedBoundary, expectedReadiness);
      return watermark ? { watermark, topicPublished: false, publication: null, blocked: true, error } : null;
    }
    if (!watermark) return null;
    return { watermark, topicPublished: true, publication: null };
  }

  isAttachmentIntakeFailure(error) { return liveAttachmentRecovery.isAttachmentIntakeFailure.apply(this, arguments); }

  async retryLiveAttachment(message, binding) { return liveAttachmentRecovery.retryLiveAttachment.apply(this, arguments); }

  retryPendingLiveAttachment(channelId) { return liveAttachmentRecovery.retryPendingLiveAttachment.apply(this, arguments); }

  async recordLiveAttachmentGap(message, binding, error, signal = null) { return liveAttachmentRecovery.recordLiveAttachmentGap.apply(this, arguments); }

  releaseRecoveredAttachmentIntake(channelId = null) { return liveAttachmentRecovery.releaseRecoveredAttachmentIntake.apply(this, arguments); }

  isPreAdoptionRetryableThread(channelId) {
    return isPreAdoptionRetryableThread(this.state.getThreadEnrollment?.(channelId));
  }

  isRetryableNativeProofBoundary(binding) {
    if (!binding?.active || !this.state.isOrdinaryBinding?.(binding)) return false;
    const watermark = this.state.getIntakeWatermark(binding.channelId);
    return isNativeProofRetryBoundary(watermark?.state, watermark?.detail);
  }

  noteLiveIntake(message) {
    const channelId = typeof message?.channelId === 'string' ? message.channelId : null;
    if (!channelId || this.stopping || !this.state.getMessageRoute(channelId)?.binding.active) return;
    if (this.isPreAdoptionRetryableThread(channelId)) return;
    const count = (this.liveIntakeCounts.get(channelId) || 0) + 1;
    this.liveIntakeCounts.set(channelId, count);
    if (count < this.liveCheckpointThreshold || this.liveCheckpointPromise || this.recoveryPromise) return;
    if (this.liveCheckpointRetryTimer) {
      const retryChannels = this.liveCheckpointRetryChannels || new Set();
      retryChannels.add(channelId);
      this.liveCheckpointRetryChannels = retryChannels;
      return;
    }
    this.liveIntakeCounts.set(channelId, 0);
    this.beginLiveCheckpoint(new Map([[channelId, count]]));
  }

  scheduleHeldLiveCheckpoints() {
    if (this.stopping || this.recoveryPromise || this.liveCheckpointPromise) return;
    const heldChannels = [...this.liveIntakeCounts.entries()]
      .filter(([channelId, count]) => count >= this.liveCheckpointThreshold && this.state.getMessageRoute(channelId)?.binding.active && !this.isPreAdoptionRetryableThread(channelId));
    if (!heldChannels.length) return;
    if (this.liveCheckpointRetryTimer) {
      const retryChannels = this.liveCheckpointRetryChannels || new Set();
      for (const [channelId] of heldChannels) retryChannels.add(channelId);
      this.liveCheckpointRetryChannels = retryChannels;
      return;
    }
    const triggeredCounts = new Map(heldChannels);
    for (const [channelId] of heldChannels) this.liveIntakeCounts.set(channelId, 0);
    this.beginLiveCheckpoint(triggeredCounts);
  }

  scheduleDeferredHandoffRecovery(channelId, { pendingGeneration = false } = {}) {
    if (this.stopping || typeof channelId !== 'string') return;
    const channels = pendingGeneration ? this.pendingHandoffRecoveryChannels : this.deferredHandoffRecoveryChannels;
    channels.add(channelId);
    const delay = Math.max(1, this.deferredHandoffRecoveryDelayMs);
    const timerDeadline = Date.now() + delay;
    if (this.deferredHandoffRecoveryTimer) {
      const currentDeadline = this.deferredHandoffRecoveryTimerDeadline ?? Number.POSITIVE_INFINITY;
      if (timerDeadline >= currentDeadline) return;
      clearTimeout(this.deferredHandoffRecoveryTimer);
      this.deferredHandoffRecoveryTimer = null;
    }
    this.deferredHandoffRecoveryDelayMs = Math.min(delay * 2, DEFERRED_HANDOFF_RECOVERY_MAX_DELAY_MS);
    const timer = setTimeout(() => {
      if (this.deferredHandoffRecoveryTimer !== timer) return;
      this.deferredHandoffRecoveryTimer = null;
      this.deferredHandoffRecoveryTimerDeadline = null;
      if (this.stopping || (!this.deferredHandoffRecoveryChannels.size && !this.pendingHandoffRecoveryChannels.size)) return;
      const deferredChannels = [...this.deferredHandoffRecoveryChannels];
      const pendingChannels = [...this.pendingHandoffRecoveryChannels];
      this.deferredHandoffRecoveryChannels.clear();
      this.pendingHandoffRecoveryChannels.clear();
      const requeue = (channelIds, pendingGeneration = false) => {
        for (const deferredChannelId of channelIds) {
          this.scheduleDeferredHandoffRecovery(deferredChannelId, { pendingGeneration });
        }
      };
      if (this.started && !this.transportReady) {
        requeue(deferredChannels);
        requeue(pendingChannels, true);
        return;
      }
      Promise.resolve().then(async () => {
        if (this.stopping) return;
        if (this.recoveryPromise) {
          requeue(deferredChannels);
          requeue(pendingChannels, true);
          return;
        }
        const recoverableChannels = new Set();
        const reconcileOnlyChannels = new Set();
        for (const channelId of new Set([...deferredChannels, ...pendingChannels])) {
          const binding = this.state.getBinding(channelId);
          const recovery = this.state.recoverInterruptedOrdinaryHandoffIntake?.(channelId, binding);
          const liveHandoffFence = this.state.ordinaryHandoffPauses?.has(channelId);
          if (recovery?.deferred) {
            this.deferredHandoffRecoveryChannels.add(channelId);
          } else if (recovery && binding?.active) {
            recoverableChannels.add(channelId);
          } else if (liveHandoffFence) {
            continue;
          } else if (binding?.active && this.state.isOrdinaryBinding?.(binding) &&
            [READINESS.PENDING, READINESS.RECOVERING].includes(binding.readiness)) {
            recoverableChannels.add(channelId);
          } else if (binding?.active && binding.readiness === READINESS.READY) {
            reconcileOnlyChannels.add(channelId);
          }
        }
        if (recoverableChannels.size) {
          for (const channelId of recoverableChannels) {
            const channelIds = new Set([channelId]);
            const recovery = await this.recoverTransport('ordinary-handoff', this.lifecycleEpoch, channelIds);
            if (recovery.ready) await this.reconcilePending(undefined, { channelIds });
            else if (this.ready) await this.reconcilePending(undefined, { readyOnly: true, channelIds });
          }
        }
        if (reconcileOnlyChannels.size) {
          await this.reconcilePending(undefined, {
            allowPaused: !this.ready,
            readyOnly: true,
            channelIds: reconcileOnlyChannels
          });
        }
      }).catch(error => this.logger(`Deferred ordinary handoff recovery failed: ${error.message}`)).finally(() => {
        if (this.stopping) return;
        if (this.deferredHandoffRecoveryChannels.size || this.pendingHandoffRecoveryChannels.size) {
          const deferredChannels = [];
          for (const channelId of this.deferredHandoffRecoveryChannels) {
            deferredChannels.push(channelId);
          }
          if (deferredChannels.length) requeue(deferredChannels);
          if (this.pendingHandoffRecoveryChannels.size) requeue([...this.pendingHandoffRecoveryChannels], true);
        } else {
          this.deferredHandoffRecoveryDelayMs = DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS;
        }
      });
    }, delay);
    timer.unref?.();
    this.deferredHandoffRecoveryTimer = timer;
    this.deferredHandoffRecoveryTimerDeadline = timerDeadline;
  }

  schedulePendingHandoffRecoveryPoll() {
    if (this.stopping || !this.started || this.pendingHandoffRecoveryPollTimer) return;
    const timer = setTimeout(() => {
      if (this.pendingHandoffRecoveryPollTimer === timer) this.pendingHandoffRecoveryPollTimer = null;
      if (this.stopping || !this.started) return;
      const pendingHandoffChannels = new Set(this.state.listPendingOrdinaryHandoffChannels?.() || []);
      for (const binding of this.state.listBindings?.() || []) {
        if (binding.active && binding.readiness === READINESS.PENDING && this.state.isOrdinaryBinding?.(binding)) {
          pendingHandoffChannels.add(binding.channelId);
        }
      }
      for (const channelId of pendingHandoffChannels) {
        this.scheduleDeferredHandoffRecovery(channelId, { pendingGeneration: true });
      }
      this.schedulePendingHandoffRecoveryPoll();
    }, PENDING_HANDOFF_RECOVERY_POLL_MS);
    timer.unref?.();
    this.pendingHandoffRecoveryPollTimer = timer;
  }

  beginLiveCheckpoint() {
    return liveCheckpointHandlers.beginLiveCheckpoint.apply(this, arguments);
  }

  scheduleLiveCheckpointRetry(deferredCounts) {
    return liveCheckpointHandlers.scheduleLiveCheckpointRetry.apply(this, arguments);
  }

  async checkpointHealthyIntake(signal, lifecycleEpoch) {
    return liveCheckpointHandlers.checkpointHealthyIntake.apply(this, arguments);
  }

  isCurrentBinding(binding) {
    return bindingIdentityMatches(binding, this.state.getBinding(binding.channelId));
  }

  handleNativeUnavailable(message, error, outcome) {
    if (message?.provider !== 'claude' || outcome?.endpointUnavailable !== true || this.stopping) return;
    const binding = this.state.getBinding(message.channelId);
    if (!binding || !binding.active || binding.provider !== 'claude' || binding.nativeId !== message.nativeId ||
      binding.generation !== message.generation || binding.workspace !== message.workspace || binding.endpoint !== message.endpoint ||
      !this.state.isOrdinaryBinding(binding)) return;
    const detail = `${CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX} ${String(error?.message || error || 'unknown error').slice(0, 900)}`;
    const demoted = this.state.setBindingReadiness(binding.channelId, READINESS.UNAVAILABLE, detail, binding);
    if (!demoted || this.stopping) return;
    const lifecycleEpoch = this.lifecycleEpoch;
    const recoverAndReconcile = async () => {
      let result = await this.recoverTransport('Claude endpoint unavailable', lifecycleEpoch);
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return result;
      let current = this.state.getBinding(binding.channelId);
      const matchesBinding = current?.active && current.provider === 'claude' && current.nativeId === binding.nativeId &&
        current.generation === binding.generation && current.workspace === binding.workspace && current.endpoint === binding.endpoint;
      if (matchesBinding && current.readiness === READINESS.READY) return this.reconcilePending();
      if (!matchesBinding || current.readiness !== READINESS.UNAVAILABLE) return result;

      result = await this.recoverTransport('Claude endpoint unavailable follow-up', lifecycleEpoch);
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return result;
      current = this.state.getBinding(binding.channelId);
      const recovered = current?.active && current.provider === 'claude' && current.nativeId === binding.nativeId &&
        current.generation === binding.generation && current.workspace === binding.workspace && current.endpoint === binding.endpoint &&
        current.readiness === READINESS.READY;
      return recovered ? this.reconcilePending() : result;
    };
    recoverAndReconcile().catch(recoveryError => {
      this.logger(`Claude endpoint recovery failed: ${recoveryError.message}`);
    });
  }

  async verifyOrdinaryNative(binding, options = {}) {
    if (!this.state.isOrdinaryBinding?.(binding)) return null;
    if (!this.providers[binding.provider] || typeof this.providers[binding.provider].dispatch !== 'function') {
      throw new Error(`${binding.provider} delivery provider is unavailable for ordinary binding`);
    }
    const proof = await this.ordinaryNativePreflight(binding, options);
    if (options.signal?.aborted) throw recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Codex native preflight was stopped');
    if (options.deadline !== undefined && Date.now() >= options.deadline) throw recoveryError(CODEX_VALIDATION_KINDS.DEADLINE, 'Codex native preflight deadline exceeded');
    if (!proof || typeof proof !== 'object') throw new Error(`${binding.provider} native preflight returned no proof`);
    if (!this.isCurrentBinding(binding)) throw recoveryError('stale', `ordinary ${binding.provider} binding changed during native preflight`);
    const recorded = this.state.recordOrdinaryPreflight(binding, proof);
    if (!recorded) throw recoveryError('stale', `ordinary ${binding.provider} binding changed before native preflight was recorded`);
    return proof;
  }

  recoverInbound(signal, reason, ...args) { return inboundRecovery.recoverInbound.apply(this, arguments); }

  recoverTransport(reason, ...args) { return transportRecovery.recoverTransport.apply(this, arguments); }

  async reconcilePending(before = undefined, {
    allowPaused = false,
    readyOnly = false,
    channelIds = null,
    messageIds = null
  } = {}) {
    const lifecycleEpoch = this.lifecycleEpoch;
    const connectionEpoch = this.connectionEpoch;
    while (this.recoveryPromise || this.recoveryFollowupPromise) {
      await (this.recoveryFollowupPromise || this.recoveryPromise).catch(() => {});
      if (!this.isCurrentLifecycle(lifecycleEpoch) || connectionEpoch !== this.connectionEpoch) return [];
    }
    if (!this.isCurrentLifecycle(lifecycleEpoch)) return [];
    const cutoff = before === undefined ? new Date().toISOString() : before;
    const hasReadyBinding = this.state.listBindings().some(binding => {
      return binding.active && binding.readiness === READINESS.READY;
    });
    if (!this.ready && !allowPaused && !hasReadyBinding) throw new Error('Discord gateway is not ready for recovery');
    this.recoveryController = new AbortController();
    const controller = this.recoveryController;
    this.recoveryPromise = this._reconcilePending(
      cutoff,
      controller.signal,
      readyOnly || allowPaused,
      channelIds,
      messageIds
    );
    try { return await this.recoveryPromise; }
    finally {
      this.recoveryPromise = null;
      this.recoveryController = null;
      this.scheduleHeldLiveCheckpoints();
    }
  }

  _reconcilePending(before, signal, ...args) { return pendingReconciliation.reconcilePending.apply(this, arguments); }

  startDecisionRecovery(signal, channelIds = null) {
    if (this.stopping || this.decisionRecoveryPromise || !this.decisionConsumer) return this.decisionRecoveryPromise;
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', relayAbort, { once: true });
    this.decisionRecoveryController = controller;
    const work = Promise.resolve().then(() => this.decisionConsumer.recover(controller.signal, channelIds));
    const tracked = work.catch(error => {
      this.logger(`Discord decision recovery failed: ${error.message}`);
      return [];
    });
    this.decisionRecoveryPromise = tracked;
    this.inFlight.add(tracked);
    tracked.finally(() => {
      signal?.removeEventListener('abort', relayAbort);
      this.inFlight.delete(tracked);
      if (this.decisionRecoveryPromise === tracked) this.decisionRecoveryPromise = null;
      if (this.decisionRecoveryController === controller) this.decisionRecoveryController = null;
    }).catch(() => {});
    return tracked;
  }

  async stop() {
    return gatewayLifecycleHandlers.stop.apply(this, arguments);
  }
}

module.exports = {
  DiscordGateway,
  RECOVERY_POLICIES,
  classifyReplyError,
  createSurfaceConsumer,
  discordIdAfter,
  eventToInput,
  fetchAgentAttachment,
  fetchDiscordChannel,
  normalizeAgentMessage,
  readSecret,
  requireInstalled,
  sendDiscordMessage,
  waitForRecoveryOperation,
};
