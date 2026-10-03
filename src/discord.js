const { createLiveAttachmentRecoveryHandlers } = require('./discord/live-attachment-recovery');
const { createInboundRecoveryHandlers } = require('./discord/inbound-recovery');
const { createTransportRecoveryWaiter } = require('./discord/transport-recovery-waiter');
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

  markThreadDeliveryUnavailable(message, error) {
    const stored = this.state.getMessage(message.id);
    if (!stored?.deliveryChannelId || stored.deliveryChannelId === stored.channelId) return;
    const binding = this.state.getBinding(stored.channelId);
    if (!bindingIdentityMatches(stored, binding)) return;
    const enrollment = this.state.getThreadEnrollment(stored.deliveryChannelId);
    if (!enrollment) return;
    const detail = recoveryKind(error) === CODEX_VALIDATION_KINDS.DEADLINE
      ? classifyRecoveryFailure(error).detail
      : error.message;
    const retryableBoundary = isRetryableFetchBoundary(enrollment.state, enrollment.detail);
    const retryableFetch = isRetryableFetchBoundary(THREAD_STATES.UNAVAILABLE, detail);
    if (['gap', 'unavailable'].includes(enrollment.state) && !retryableBoundary) return;
    const nextState = !enrollment.adoptedAt && retryableFetch ? THREAD_STATES.PENDING : THREAD_STATES.UNAVAILABLE;
    this.markThreadBoundary(stored.deliveryChannelId, nextState,
      detail, null, null, binding, undefined, undefined, enrollment);
  }

  async threadDeliveryMessage(message) {
    const stored = this.state.getMessage(message.id);
    if (!stored?.deliveryChannelId || stored.deliveryChannelId === stored.channelId) return message;
    const binding = this.state.getBinding(stored.channelId);
    const route = this.state.getMessageRoute(stored.deliveryChannelId);
    if (!route) throw Object.assign(new Error('Thread delivery has no active parent route'), { outcome: 'not_sent' });
    let channel;
    try {
      channel = message.channel?.id === stored.deliveryChannelId ? message.channel :
        await recoveryFetch(() => this.client.channels.fetch(stored.deliveryChannelId));
      assertPublicThread(channel, binding, stored.deliveryChannelId, this.client.user);
    }
    catch (error) {
      const deliveryError = error instanceof Error ? error : new Error(String(error));
      this.markThreadDeliveryUnavailable(stored, deliveryError);
      deliveryError.outcome = 'not_sent';
      throw deliveryError;
    }
    return { ...message, channelId: stored.deliveryChannelId, channel };
  }

  async sendReply(message, reply) {
    const stored = this.state.getMessage(message.id);
    const isThreadDelivery = Boolean(stored?.deliveryChannelId && stored.deliveryChannelId !== stored.channelId);
    message = await this.threadDeliveryMessage(message);
    this.state.assertMessageCurrent(reply.id, 'reply-send');
    if (typeof reply.replyText !== 'string' || reply.replyText.length > 2000) throw new Error('Discord reply must be at most 2000 characters per message');
    if (typeof reply.replyNonce !== 'string' || reply.replyNonce.length > 25) throw new Error('Discord reply nonce must be at most 25 characters');
    const channel = message.channel || await this.client.channels?.fetch?.(message.deliveryChannelId || message.channelId);
    if (!channel?.send) throw new Error('Discord reply channel is unavailable');
    // F12: an explicit guild/channel mismatch on the resolved destination is a
    // definitive not-sent outcome. Nothing is sent and the saved reply keeps its
    // stored tuple. Missing stored metadata stays compatible.
    if (!storedChannelMatches(channel, stored)) {
      throw Object.assign(new Error('Discord reply channel does not match the stored message destination'), { outcome: 'not_sent' });
    }
    this.state.assertMessageCurrent(reply.id, 'reply-send');
    const fileManifest = reply.replyPart?.fileManifest || null;
    const files = fileManifest
      ? [{ attachment: readDirectPostFileSnapshot(fileManifest), name: fileManifest.filename }]
      : undefined;
    this.state.assertMessageCurrent(reply.id, 'reply-send');
    try {
      return await channel.send({
        content: reply.replyText,
        nonce: reply.replyNonce,
        enforceNonce: true,
        allowedMentions: { parse: [] },
        ...(files ? { files } : {})
      });
    } catch (error) {
      const definitiveThreadRejection = isThreadDelivery &&
        ([403, 404].includes(Number(error?.status)) || error?.code === 50013);
      if (definitiveThreadRejection) {
        const deliveryError = error instanceof Error ? error : new Error(String(error));
        this.markThreadDeliveryUnavailable(message, deliveryError);
      }
      if (!error.outcome) error.outcome = classifyReplyError(error);
      throw error;
    }
  }

  prepareReply(messageId, signal) {
    if (signal?.aborted || this.stopping) return;
    return waitForAcknowledgment(this.state, this.deliverAcknowledgment, messageId, signal);
  }

  async sendAcknowledgment(message, reaction) {
    if (this.stopping) throw new Error('Discord acknowledgment stopped');
    this.state.assertMessageCurrent(message.id, 'native-ack-reaction');
    const interaction = this.state.isInteractionMessage?.(message.id);
    const targetMessageId = interaction ? this.state.interactionResponseTarget?.(message.id) : message.id;
    if (interaction && !targetMessageId) {
      throw Object.assign(new Error('interaction callback response target is unavailable'), {
        outcome: 'local_visibility_failure', visibility: 'local', targetMessageId: null
      });
    }
    let source = message;
    if (!source.channel && !(this.discordToken && this.client?.rest)) {
      const channel = await this.client.channels?.fetch?.(message.deliveryChannelId || message.channelId);
      if (!channel) throw new Error('Discord acknowledgment channel is unavailable');
      source = { ...message, channel };
    }
    this.state.assertMessageCurrent(message.id, 'native-ack-reaction');
    try {
      return await this.sendTransportReceipt(source, { reaction, targetMessageId: targetMessageId || message.id });
    } catch (error) {
      if ([400, 401, 403, 404].includes(Number(error?.status))) {
        error.visibility = 'local';
        error.targetMessageId = targetMessageId || message.id;
      }
      throw error;
    }
  }

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
    if (this.stopping) throw new Error('Discord gateway is stopping');
    if (this.startPromise) return this.startPromise;
    const epoch = ++this.lifecycleEpoch;
    this.ready = false;
    this.starting = true;
    this.started = false;
    this.createInteractionRecoveryBarrier();
    const startPromise = (async () => {
      const token = readSecret(secretFile);
      this.discordToken = token;
      await this.client.login(token);
      if (!this.isCurrentLifecycle(epoch)) throw recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Discord startup was stopped during login');
      try {
        await this.registerApplicationCommand();
      } catch (error) {
        this.logger(`Discord application command registration failed: ${error.message}`);
      }
      for (const binding of this.state.listBindings().filter(binding => binding.active)) {
        this.state.recoverInterruptedOrdinaryHandoffIntake?.(binding.channelId, binding);
      }
      const recovery = await this.recoverTransport('startup', epoch);
      if (!this.isCurrentLifecycle(epoch)) throw recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Discord startup was stopped during recovery');
      const unresolvedBindings = this.state.listBindings().filter(binding => binding.active && binding.readiness !== READINESS.READY);
      const unresolvedThreadEnrollments = this.state.listThreadEnrollments().filter(enrollment =>
        enrollment.active && enrollment.state !== THREAD_STATES.READY
      );
      const aggregateRecoveryReady = recovery.ready && unresolvedThreadEnrollments.length === 0;
      const aggregateRecoveryState = aggregateRecoveryReady
        ? recovery.state
        : unresolvedThreadEnrollments[0]?.state || recovery.state;
      const hasEndpointUnavailableBinding = !aggregateRecoveryReady && ['gap', 'unavailable'].includes(recovery.state) &&
        unresolvedBindings.length > 0 && unresolvedBindings.every(binding => {
          const watermark = this.state.getIntakeWatermark(binding.channelId);
          return watermark?.state === READINESS.UNAVAILABLE &&
            typeof watermark.detail === 'string' && (
              isNativeProofRetryBoundary(watermark.state, watermark.detail) ||
              watermark.detail.startsWith(CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX) ||
              watermark.detail.startsWith('Codex transcript proof unavailable before event write:')
            );
        }) && unresolvedThreadEnrollments.every(enrollment => this.isPreAdoptionRetryableThread(enrollment.threadId));
      const hasPersistedRecoveryHolds = !aggregateRecoveryReady && recovery.state !== 'stopped' &&
        (unresolvedBindings.length > 0 || unresolvedThreadEnrollments.length > 0) &&
        unresolvedBindings.every(binding => {
          const watermark = this.state.getIntakeWatermark(binding.channelId);
          return watermark && [READINESS.PENDING, READINESS.GAP, READINESS.UNAVAILABLE].includes(watermark.state) &&
            binding.readiness === watermark.state;
        }) &&
        unresolvedThreadEnrollments.every(enrollment =>
          [THREAD_STATES.PENDING, THREAD_STATES.GAP, THREAD_STATES.UNAVAILABLE].includes(enrollment.state));
      if (!aggregateRecoveryReady && !hasEndpointUnavailableBinding && !hasPersistedRecoveryHolds) {
        throw new Error(`Discord intake recovery is ${aggregateRecoveryState}`);
      }
      if (hasEndpointUnavailableBinding) this.ready = true;
      this.transportReady = true;
      this.started = true;
      this.flushLegacyParentReconciliation();
      this.resolveInteractionRecovery(true);
      this.schedulePendingHandoffRecoveryPoll();
      this.acknowledgments = watchAcknowledgments({
        state: this.state,
        send: (message, reaction) => this.sendAcknowledgment(message, reaction),
        deliver: this.deliverAcknowledgment,
        onAcknowledged: messageId => {
          if (this.stopping) return null;
          const message = this.state.getMessage(messageId);
          if (![MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLY_READY].includes(message?.state)) return ACK_WAITING;
          this.consumer?.releaseAcknowledged?.(messageId);
          return this.reconcilePending(undefined, {
            allowPaused: true,
            readyOnly: true,
            channelIds: [message.channelId],
            messageIds: [messageId]
          });
        },
        logger: this.logger
      });
    })();
    this.startPromise = startPromise;
    try { return await startPromise; }
    catch (error) {
      this.started = false;
      throw error;
    }
    finally {
      if (this.startPromise === startPromise) this.startPromise = null;
      this.starting = false;
      if (!this.started) this.ready = false;
      if (!this.started) this.transportReady = false;
      if (!this.started) this.resolveInteractionRecovery(false);
      if (!this.started) this.discordToken = null;
    }
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

  beginLiveCheckpoint(triggeredCounts = new Map(), { allowPendingRecovery = true } = {}) {
    if (this.liveCheckpointPromise || this.stopping || this.recoveryPromise) return;
    const controller = new AbortController();
    const epoch = this.lifecycleEpoch;
    this.liveCheckpointController = controller;
    let advancedChannels = new Set();
    const checkpoint = this.checkpointHealthyIntake(controller.signal, epoch, triggeredCounts)
      .then(async result => {
        advancedChannels = result instanceof Set ? result : new Set();
        const threads = [...advancedChannels].filter(channelId => this.state.getThreadEnrollment(channelId)?.active);
        if (threads.length) {
          const parentChannels = threads
            .map(channelId => this.state.getThreadEnrollment(channelId)?.parentChannelId)
            .filter(Boolean);
          if (!controller.signal.aborted && this.isCurrentLifecycle(epoch)) {
            await this.reconcilePending(undefined, { readyOnly: true, channelIds: threads });
            const parentRequestIds = heldParentRequestIds(this.state, [...new Set(parentChannels)], threads);
            if (parentRequestIds.length && !controller.signal.aborted && this.isCurrentLifecycle(epoch)) {
              await this.reconcilePending(undefined, {
                readyOnly: true,
                channelIds: [...new Set(parentChannels)],
                messageIds: parentRequestIds
              });
            }
          }
        }
        return result;
      })
      .catch(error => {
        if (recoveryKind(error) !== CODEX_VALIDATION_KINDS.STOPPED) this.logger(`Discord live intake checkpoint failed: ${error.message}`);
      })
      .finally(() => {
        if (this.liveCheckpointPromise === checkpoint) this.liveCheckpointPromise = null;
        if (this.liveCheckpointController === controller) this.liveCheckpointController = null;
        if (this.stopping) return;
        const deferredChannels = [...this.liveIntakeCounts.entries()]
          .filter(([channelId, count]) => count >= this.liveCheckpointThreshold && this.state.getMessageRoute(channelId)?.binding.active);
        const deferredCounts = new Map(deferredChannels);
        for (const [channelId] of deferredChannels) this.liveIntakeCounts.set(channelId, 0);
        for (const [channelId, count] of triggeredCounts) {
          if (advancedChannels.has(channelId) || !this.state.getMessageRoute(channelId)?.binding.active) continue;
          const currentCount = this.liveIntakeCounts.get(channelId) || 0;
          const deferredCount = deferredCounts.get(channelId);
          if (deferredCount === undefined) this.liveIntakeCounts.set(channelId, currentCount + count);
          else deferredCounts.set(channelId, deferredCount + count);
        }
        for (const [channelId, count] of this.liveIntakeCounts) {
          if (count < this.liveCheckpointThreshold || !this.state.getMessageRoute(channelId)?.binding.active) continue;
          deferredCounts.set(channelId, count);
          this.liveIntakeCounts.set(channelId, 0);
        }
        for (const channelId of deferredCounts.keys()) {
          if (!this.isPreAdoptionRetryableThread(channelId)) continue;
          deferredCounts.delete(channelId);
          this.liveIntakeCounts.delete(channelId);
        }
        if (this.recoveryPromise) {
          for (const [channelId, count] of deferredCounts) {
            const currentCount = this.liveIntakeCounts.get(channelId) || 0;
            this.liveIntakeCounts.set(channelId, Math.max(currentCount, count));
          }
          return;
        }
        if (!deferredCounts.size) {
          this.liveCheckpointRetryDelayMs = LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS;
          return;
        }
        const immediateCounts = new Map();
        for (const [channelId, count] of deferredCounts) {
          const pendingRecovery = allowPendingRecovery && this.state.getThreadEnrollment(channelId)?.state === THREAD_STATES.PENDING && !this.isPreAdoptionRetryableThread(channelId);
          if (!advancedChannels.has(channelId) && !pendingRecovery) continue;
          immediateCounts.set(channelId, count);
          deferredCounts.delete(channelId);
        }
        if (deferredCounts.size) this.scheduleLiveCheckpointRetry(deferredCounts);
        else this.liveCheckpointRetryDelayMs = LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS;
        if (immediateCounts.size) this.beginLiveCheckpoint(immediateCounts, { allowPendingRecovery: false });
      });
    this.liveCheckpointPromise = checkpoint;
  }

  scheduleLiveCheckpointRetry(deferredCounts) {
    if (!deferredCounts?.size || this.stopping) return;
    const retryChannels = this.liveCheckpointRetryChannels || new Set();
    for (const [channelId, count] of deferredCounts) {
      const currentCount = this.liveIntakeCounts.get(channelId) || 0;
      this.liveIntakeCounts.set(channelId, Math.max(currentCount, count));
      retryChannels.add(channelId);
    }
    this.liveCheckpointRetryChannels = retryChannels;
    if (this.liveCheckpointRetryTimer) return;
    const retryDelay = Math.min(this.liveCheckpointRetryDelayMs || LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS, LIVE_CHECKPOINT_RETRY_MAX_DELAY_MS);
    this.liveCheckpointRetryDelayMs = Math.min(retryDelay * 2, LIVE_CHECKPOINT_RETRY_MAX_DELAY_MS);
    const timer = setTimeout(() => {
      if (this.liveCheckpointRetryTimer === timer) this.liveCheckpointRetryTimer = null;
      const channels = this.liveCheckpointRetryChannels || new Set();
      this.liveCheckpointRetryChannels = null;
      if (this.stopping || this.recoveryPromise || this.liveCheckpointPromise) return;
      const retryCounts = new Map();
      for (const channelId of channels) {
        if (!this.state.getMessageRoute(channelId)?.binding.active) continue;
        if (this.isPreAdoptionRetryableThread(channelId)) continue;
        const count = this.liveIntakeCounts.get(channelId) || 0;
        if (count < this.liveCheckpointThreshold) continue;
        retryCounts.set(channelId, count);
        this.liveIntakeCounts.set(channelId, 0);
      }
      if (retryCounts.size) this.beginLiveCheckpoint(retryCounts, { allowPendingRecovery: false });
    }, retryDelay);
    timer.unref?.();
    this.liveCheckpointRetryTimer = timer;
  }

  async checkpointHealthyIntake(signal, lifecycleEpoch, triggeredCounts = new Map()) {
    const deadline = Date.now() + this.recoveryTimeoutMs;
    const triggeredChannels = triggeredCounts instanceof Map ? new Set(triggeredCounts.keys()) : new Set();
    const bindings = this.state.listBindings().filter(binding => binding.active
      && binding.readiness === READINESS.READY
      && (!triggeredChannels.size || triggeredChannels.has(binding.channelId)));
    const advancedChannels = new Set();
    for (const binding of bindings) {
      if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) throw recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Discord live intake checkpoint was stopped');
      const watermark = this.state.getIntakeWatermark(binding.channelId);
      if (!watermark?.recovered_through_id || typeof this.state.hasIntakeEvidence !== 'function') continue;
      if (typeof this.client?.channels?.fetch !== 'function') continue;
      let channel;
      try {
        channel = await waitForRecoveryOperation(() => this.client.channels.fetch(binding.channelId), signal, deadline);
        if (!channel || typeof channel.messages?.fetch !== 'function') continue;
        const permission = this.historyPermission(channel, { requireSend: this.state.isOrdinaryBinding?.(binding) });
        if (!permission.known || !permission.allowed) continue;
        let after = watermark.recovered_through_id;
        let pages = 0;
        let total = 0;
        let complete = false;
        while (pages < this.historyMaxPages && total < this.historyMaxMessages && Date.now() < deadline) {
          if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) throw recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Discord live intake checkpoint was stopped');
          const page = this.historyMessages(await waitForRecoveryOperation(
            () => this.fetchHistory(channel, { limit: this.historyPageLimit, after, signal }),
            signal,
            deadline
          ));
          pages += 1;
          if (!page.length) { complete = true; break; }
          if (page.some(message => typeof message?.id !== 'string' || message.id.length === 0)) break;
          page.sort((left, right) => compareDiscordIds(left?.id, right?.id));
          const fresh = page.filter(message => typeof message?.id === 'string' && compareDiscordIds(message.id, after) > 0);
          if (!fresh.length) { complete = true; break; }
          for (const message of fresh) {
            if (total >= this.historyMaxMessages) break;
            if (!this.state.hasIntakeEvidence(message.id)) {
              complete = false;
              break;
            }
            after = message.id;
            total += 1;
          }
          if (!complete && total < this.historyMaxMessages && fresh.some(message => !this.state.hasIntakeEvidence(message.id))) break;
          if (total >= this.historyMaxMessages) {
            const consumedPage = after === fresh[fresh.length - 1].id;
            if (page.length < this.historyPageLimit && consumedPage) complete = true;
            break;
          }
          if (page.length < this.historyPageLimit) { complete = true; break; }
        }
        if (!complete || !after) continue;
        const checkpointed = this.state.checkpointIntake(binding.channelId, after, binding);
        if (checkpointed?.recovered_through_id && compareDiscordIds(checkpointed.recovered_through_id, watermark.recovered_through_id) > 0) {
          advancedChannels.add(binding.channelId);
        }
      } catch (error) {
        if (recoveryKind(error) === CODEX_VALIDATION_KINDS.STOPPED) throw error;
      }
    }
    for (const enrollment of this.state.listThreadEnrollments()) {
      if (!enrollment.active || ![THREAD_STATES.READY, THREAD_STATES.PENDING].includes(enrollment.state) ||
          (triggeredChannels.size && !triggeredChannels.has(enrollment.threadId))) continue;
      if (this.isPreAdoptionRetryableThread(enrollment.threadId)) continue;
      const checkpointOnly = enrollment.state === THREAD_STATES.READY;
      const recovered = await recoverThread(this, enrollment, signal, lifecycleEpoch, waitForRecoveryOperation, checkpointOnly, deadline);
      if (recovered) {
        advancedChannels.add(enrollment.threadId);
      } else if (checkpointOnly && this.state.getThreadEnrollment(enrollment.threadId)?.state === THREAD_STATES.PENDING) {
        const currentCount = this.liveIntakeCounts.get(enrollment.threadId) || 0;
        this.liveIntakeCounts.set(enrollment.threadId, Math.max(currentCount, this.liveCheckpointThreshold));
      }
    }
    return advancedChannels;
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

  async recoverTransport(reason, lifecycleEpoch = this.lifecycleEpoch, channelIds = null, recoveryDeadline = null,
    { recoveryPolicy = RECOVERY_POLICIES.FULL } = {}) {
    if (!this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
    const overallDeadline = recoveryDeadline ?? (Date.now() + this.recoveryTimeoutMs);
    let callerScope = null;
    if (channelIds !== null && channelIds !== undefined) {
      callerScope = new Set(channelIds);
    } else if (recoveryPolicy === RECOVERY_POLICIES.UNRESOLVED) {
      callerScope = new Set([
        ...this.state.listBindings()
          .filter(binding => binding.active && (binding.readiness !== READINESS.READY ||
            this.state.getIntakeWatermark(binding.channelId)?.state !== READINESS.READY))
          .map(binding => binding.channelId),
        ...this.state.listThreadEnrollments()
          .filter(enrollment => enrollment.active && enrollment.state !== THREAD_STATES.READY)
          .map(enrollment => enrollment.threadId)
      ]);
    }
    const expandScope = scope => {
      if (scope === null) return null;
      const expanded = new Set(scope);
      for (const enrollment of this.state.listThreadEnrollments()) {
        if (!enrollment.active) continue;
        if (expanded.has(enrollment.parentChannelId) || expanded.has(enrollment.threadId)) expanded.add(enrollment.threadId);
      }
      return expanded;
    };
    const allActiveEnrollmentsReady = () => this.state.listThreadEnrollments().every(enrollment => !enrollment.active || enrollment.state === THREAD_STATES.READY);
    const scopeIsReady = scope => {
      const expanded = expandScope(scope);
      const scopedChannels = expanded === null
        ? new Set(this.state.listBindings().filter(binding => binding.active).map(binding => binding.channelId))
        : expanded;
      for (const channelId of scopedChannels) {
        const binding = this.state.getBinding(channelId);
        const watermark = this.state.getIntakeWatermark(channelId);
        if (binding?.active && binding.readiness === READINESS.READY && watermark?.state === READINESS.READY) continue;
        const enrollment = this.state.getThreadEnrollment(channelId);
        if (enrollment?.active && enrollment.state === THREAD_STATES.READY) continue;
        return false;
      }
      if (expanded === null && !allActiveEnrollmentsReady()) return false;
      return true;
    };
    const scopesIntersect = (left, right) => {
      if (left === null || right === null) return true;
      const leftScope = expandScope(left);
      const rightScope = expandScope(right);
      return [...leftScope].some(channelId => rightScope.has(channelId));
    };
    const makeResult = (waiter, fallback = null) => {
      if (waiter.stopped || !this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
      if (scopeIsReady(waiter.scope)) return { ready: true, state: 'ready' };
      if (waiter.scope === null && waiter.childCount === 0 && waiter.ownResult?.ready === true && allActiveEnrollmentsReady()) return waiter.ownResult;
      const result = fallback || waiter.lastResult || waiter.ownResult || { ready: false, state: 'unavailable' };
      return result?.ready === true ? { ready: false, state: 'unavailable', error: result.error } : result;
    };
    const attachParents = waiter => {
      for (const parent of this.recoveryActiveWaiters) {
        if (parent === waiter || parent.settled || !scopesIntersect(parent.scope, waiter.scope)) continue;
        parent.pending += 1;
        parent.childCount += 1;
        parent.extendDeadline(waiter.deadline);
        waiter.parents.add(parent);
      }
    };
    const startRecoveryPass = (scope, deadline, passReason, passLifecycle, activeWaiters) => {
      if (Date.now() >= deadline || activeWaiters.every(waiter => waiter.settled)) {
        return Promise.resolve({ ready: false, state: 'unavailable' });
      }
      this.recoveryActiveWaiters = new Set(activeWaiters.filter(waiter => !waiter.settled));
      this.recoveryController = new AbortController();
      const controller = this.recoveryController;
      const connectionEpoch = this.connectionEpoch;
      let resolvePass;
      let rejectPass;
      const activeRecovery = new Promise((resolve, reject) => {
        resolvePass = resolve;
        rejectPass = reject;
      });
      this.recoveryPromise = activeRecovery;
      Promise.resolve().then(async () => {
        try {
          const result = await this.recoverInbound(controller.signal, passReason, passLifecycle,
            scope === null ? null : new Set(scope), deadline);
          if (controller.signal.aborted || connectionEpoch !== this.connectionEpoch || !this.isCurrentLifecycle(passLifecycle)) {
            resolvePass({ ready: false, state: 'stopped' });
            return;
          }
          const hasReadyBinding = this.state.listBindings().some(binding => binding.active && binding.readiness === READINESS.READY);
          this.ready = result.ready || (result.state !== 'stopped' && hasReadyBinding);
          resolvePass(result);
        } catch (error) {
          rejectPass(error);
        }
      });
      const cleanup = () => {
        if (this.recoveryPromise !== activeRecovery) return;
        this.recoveryPromise = null;
        this.recoveryController = null;
        this.releaseRecoveredAttachmentIntake();
        this.scheduleHeldLiveCheckpoints();
      };
      activeRecovery.then(cleanup, cleanup).catch(() => {});
      return activeRecovery;
    };
    const drainRecoveryFollowups = async () => {
      while (true) {
        if (!this.pendingRecoveryRequests.length) {
          await Promise.resolve();
          if (!this.pendingRecoveryRequests.length) break;
        }
        const request = this.pendingRecoveryRequests.shift();
        if (!request) continue;
        if (!this.isCurrentLifecycle(request.lifecycleEpoch)) {
          request.waiter.stop();
          continue;
        }
        const activeWaiters = [request.waiter, ...request.waiter.parents].filter(waiter => !waiter.settled);
        this.recoveryActiveWaiters = new Set(activeWaiters);
        // Scoped followups are serialized, so their timeout starts when this pass begins.
        const passDeadline = request.scope === null
          ? request.deadline
          : Date.now() + this.recoveryTimeoutMs;
        if (request.scope !== null) {
          request.waiter.extendDeadline(passDeadline);
          for (const parent of request.waiter.parents) parent.extendDeadline(passDeadline);
        }
        if (request.capturedClosingCustodyAttempts) {
          for (const [channelId, attempt] of request.capturedClosingCustodyAttempts) {
            if (this.closingCustodyRetries.get(channelId) === attempt && attempt.lifecycleEpoch === request.lifecycleEpoch) {
              attempt.deadline = passDeadline;
            }
          }
        }
        let result;
        try {
          result = await startRecoveryPass(request.scope, passDeadline, request.reason,
            request.lifecycleEpoch, activeWaiters);
        } catch (error) {
          result = { ready: false, state: recoveryKind(error) || 'unavailable', error };
        }
        request.waiter.completeOwn(result);
        this.recoveryActiveWaiters = new Set(activeWaiters.filter(waiter => !waiter.settled));
        if (result?.state === 'stopped') {
          for (const pending of this.pendingRecoveryRequests.splice(0)) pending.waiter.stop();
          break;
        }
      }
      return { ready: true, state: 'ready' };
    };
    const ensureFollowupCoordinator = () => {
      if (this.recoveryFollowupPromise) return;
      const activeRecovery = this.recoveryPromise || Promise.resolve();
      const coordinator = activeRecovery.then(
        () => drainRecoveryFollowups(),
        () => drainRecoveryFollowups()
      );
      this.recoveryFollowupPromise = coordinator;
      const finishCoordinator = () => {
        if (this.recoveryFollowupPromise !== coordinator) return;
        this.recoveryFollowupPromise = null;
        this.recoveryFollowupScope = null;
        this.recoveryActiveWaiters.clear();
        if (this.pendingRecoveryRequests.length) ensureFollowupCoordinator();
      };
      coordinator.then(finishCoordinator, finishCoordinator).catch(() => {});
    };

    const recoveryAlreadyQueued = this.recoveryPromise || this.recoveryFollowupPromise;
    const queuedScoped = recoveryAlreadyQueued && callerScope !== null;
    const waiter = createTransportRecoveryWaiter(callerScope, queuedScoped ? null : overallDeadline, makeResult, RECOVERY_WAITER_DEADLINE_GRACE_MS);
    if (recoveryAlreadyQueued) {
      if (callerScope === null) this.ready = false;
      attachParents(waiter);
      let capturedClosingCustodyAttempts = null;
      if (callerScope !== null && recoveryDeadline !== null) {
        for (const channelId of callerScope) {
          const attempt = this.closingCustodyRetries.get(channelId);
          if (attempt && attempt.lifecycleEpoch === lifecycleEpoch && attempt.deadline === recoveryDeadline) {
            if (!capturedClosingCustodyAttempts) capturedClosingCustodyAttempts = new Map();
            capturedClosingCustodyAttempts.set(channelId, attempt);
          }
        }
      }
      this.pendingRecoveryRequests.push({
        scope: callerScope === null ? null : new Set(callerScope),
        deadline: queuedScoped ? null : overallDeadline,
        reason,
        lifecycleEpoch,
        waiter,
        capturedClosingCustodyAttempts
      });
      this.recoveryFollowupScope = callerScope === null ? null : new Set(callerScope);
      ensureFollowupCoordinator();
      return waiter.promise;
    }

    if (callerScope === null) this.ready = false;
    const activeRecovery = startRecoveryPass(callerScope, overallDeadline, reason,
      lifecycleEpoch, [waiter]);
    activeRecovery.then(
      result => waiter.completeOwn(result),
      error => waiter.completeOwn({ ready: false, state: recoveryKind(error) || 'unavailable', error })
    ).catch(() => {});
    return waiter.promise;
  }

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

  async _reconcilePending(before, signal, readyOnly = false, channelIds = null, messageIds = null) {
    const deadline = Date.now() + this.recoveryTimeoutMs;
    const passLifecycle = this.lifecycleEpoch;
    const passConnectionEpoch = this.connectionEpoch;
    const reconciliationConnection = { gateway: this, epoch: passConnectionEpoch };
    const selectedChannels = channelIds ? new Set(channelIds) : null;
    const selectedMessages = messageIds ? new Set(messageIds) : null;
    if (selectedChannels && selectedMessages) {
      for (const channelId of [...selectedChannels]) {
        const enrollment = this.state.getThreadEnrollment(channelId);
        if (!enrollment?.active || !enrollment.parentChannelId) continue;
        const heldParentIds = heldParentRequestIds(this.state, [enrollment.parentChannelId], [channelId]);
        if (heldParentIds.some(messageId => selectedMessages.has(messageId))) {
          selectedChannels.add(enrollment.parentChannelId);
        }
      }
    }
    this.consumer?.releaseHandledWithoutPost?.();
    const isHeldDurable = message => message.state === 'submitted' || message.state === 'reply_ready';
    const allowed = message => (!selectedMessages || selectedMessages.has(message.id)) &&
      (!selectedChannels || selectedChannels.has(message.channelId) || selectedChannels.has(message.deliveryChannelId)) &&
      (!readyOnly || this.state.getMessageRoute(message.deliveryChannelId || message.channelId)?.ready ||
        isHeldDurable(message));
    this.startDecisionRecovery(signal, selectedChannels);
    const candidates = this.state.recoveryCandidates(before).filter(allowed);
    const retryOrder = messageIds ? new Map(messageIds.map((messageId, index) => [messageId, index])) : null;
    const ordered = candidates.sort((a, b) => {
      if (retryOrder) return retryOrder.get(a.id) - retryOrder.get(b.id);
      return a.createdAt.localeCompare(b.createdAt);
    });
    const blockedOwners = new Set();
    let reconciliationRetryQueued = false;
    const reconciliationRetryMessageIds = [];
    const queueReconciliationRetry = messageIdsToRetry => {
      if (this.stopping || signal?.aborted) return;
      for (const messageId of messageIdsToRetry || []) {
        if (!reconciliationRetryMessageIds.includes(messageId)) reconciliationRetryMessageIds.push(messageId);
      }
      if (reconciliationRetryQueued || !reconciliationRetryMessageIds.length) return;
      reconciliationRetryQueued = true;
      queueMicrotask(() => {
        // Drain this batch before the awaited pass so later settlements can queue a new one.
        reconciliationRetryQueued = false;
        const retryMessageIds = reconciliationRetryMessageIds.splice(0);
        if (this.stopping || signal?.aborted || !retryMessageIds.length) return;
        const retryThreadIds = new Set();
        const blockedOwnerKeys = new Set();
        for (const messageId of retryMessageIds) {
          const message = this.state.getMessage(messageId);
          if (message?.state !== 'accepted' || !message.deliveryChannelId ||
              message.deliveryChannelId === message.channelId) continue;
          if (!this.state.getMessageRoute(message.deliveryChannelId)?.ready) {
            retryThreadIds.add(message.deliveryChannelId);
            blockedOwnerKeys.add(`${message.provider}:${message.nativeId}`);
          }
        }
        const retry = messageIds => {
          if (!messageIds.length) return Promise.resolve();
          return this.reconcilePending(before, {
            allowPaused: true,
            readyOnly: true,
            channelIds,
            messageIds
          }).catch(error => this.logger(`Discord reply reconciliation retry failed: ${error.message}`));
        };
        if (!retryThreadIds.size) {
          retry(retryMessageIds);
          return;
        }
        const blockedRetryMessageIds = retryMessageIds.filter(messageId => {
          const message = this.state.getMessage(messageId);
          return message && blockedOwnerKeys.has(`${message.provider}:${message.nativeId}`);
        });
        const blockedRetryMessageIdSet = new Set(blockedRetryMessageIds);
        const immediateRetryMessageIds = retryMessageIds.filter(messageId =>
          !blockedRetryMessageIdSet.has(messageId)
        );
        const recoverBlocked = () => this.recoverTransport('accepted custody recovery retry', passLifecycle, [...retryThreadIds])
          .then(recovery => {
            const routesReady = [...retryThreadIds].every(threadId =>
              this.state.getMessageRoute(threadId)?.ready
            );
            if (recovery?.ready !== true && !routesReady) {
              this.logger(`Discord accepted custody recovery retry held: ${recovery?.state || 'unavailable'}`);
              return;
            }
            retry(blockedRetryMessageIds);
          })
          .catch(error => this.logger(`Discord accepted custody recovery retry failed: ${error.message}`));
        if (!immediateRetryMessageIds.length) {
          recoverBlocked();
          return;
        }
        retry(immediateRetryMessageIds).then(recoverBlocked).catch(() => {});
      });
    };
    const storedMessages = new Map();
    const storedMessageFor = message => {
      let storedMessage = storedMessages.get(message.id);
      if (!storedMessage) {
        storedMessage = {
          ...message,
          id: message.id,
          guildId: message.guildId,
          channelId: message.deliveryChannelId || message.channelId,
          content: message.content,
          author: { id: message.authorId, bot: false }
        };
        storedMessages.set(message.id, storedMessage);
      }
      return storedMessage;
    };
    const canDeliverSettledReply = (message, storedMessage) => {
      if (!storedMessage.channel) return false;
      const route = this.state.getMessageRoute(message.deliveryChannelId || message.channelId);
      if (!route?.ready) return false;
      const permission = this.historyPermission(storedMessage.channel, { requireSend: true });
      return permission.known && permission.allowed;
    };
    // F14 phase 1: admit every eligible submitted native observation up front through
    // the existing per-owner queue ordering/deduplication/cancellation, WITHOUT
    // spending the network deadline and WITHOUT waiting for native completion.
    // Admission never dispatches or replies; a later native completion still needs
    // its own reconciliation pass to reach reply.
    for (const message of ordered) {
      if (signal?.aborted) break;
      if (message.state !== 'submitted') continue;
      const storedMessage = storedMessageFor(message);
      try {
        const admitted = this.consumer.resumeSubmitted(storedMessage, signal, {
          continueUntilFinal: true,
          deferReply: () => {
            const deferred = !canDeliverSettledReply(message, storedMessage);
            if (deferred && !storedMessage.channel &&
              this.state.getMessage(message.id)?.state === MESSAGE_STATES.REPLY_READY) queueReconciliationRetry([message.id]);
            return deferred;
          }
        });
        // Admission observes existing submitted work; its settlement is handled by the
        // owning observer/queue, so a rejected admission must not become an unhandled
        // rejection in the recovery pass.
        if (admitted && typeof admitted.catch === 'function') admitted.catch(() => {});
      } catch (error) {
        if (recoveryKind(error) === CODEX_VALIDATION_KINDS.STOPPED) break;
        this.state.markObservationUnavailable(message.id, error);
      }
    }
    // F14 phase 2: the existing bounded channel fetch / reply reconciliation.
    for (let candidateIndex = 0; candidateIndex < ordered.length; candidateIndex += 1) {
      const message = ordered[candidateIndex];
      if (signal?.aborted) return this.state.recoveryCandidates(before).filter(allowed);
      const key = `${message.provider}:${message.nativeId}`;
      if (blockedOwners.has(key)) continue;
      const storedMessage = storedMessageFor(message);
      let result;
      let channel;
      let channelFetchStarted = false;
      // Tracks whether THIS pass actually registered its settlement waiter on an
      // owned in-flight lookup. Distinct from channelFetchStarted, which records
      // only whether this pass initiated the SDK fetch: an adopting reconnect
      // attaches to an already-pending promise without starting a fetch.
      let waiterAttached = false;
      let lookupAbandoned = false;
      let deferredRetryMessageIds = [];
      let releaseLookupWaiter = null;
      const lookupDestinationId = message.deliveryChannelId || message.channelId;
      try {
        channel = await waitForRecoveryOperation(
          () => {
            const lookupPromise = startReconciliationLookup(
              this.client,
              lookupDestinationId,
              message.id,
              () => recoveryFetch(() => {
                channelFetchStarted = true;
                return this.client.channels.fetch(lookupDestinationId);
              }),
              reconciliationConnection
            );
            releaseLookupWaiter = attachReconciliationWaiter(this.client, lookupDestinationId, {
              isCurrent: () => !this.stopping && this.isCurrentLifecycle(passLifecycle) &&
                passConnectionEpoch === this.connectionEpoch,
              settled: settledChannel => {
                // A caller whose bounded wait ended must not lose the lookup. Save
                // the one-use snapshot for this exact continuation and wake it via
                // the existing retry producer only when this pass gave up waiting.
                // Same-owner successors stay here until the predecessor is queued.
                if (!lookupAbandoned) return;
                storeReconciliationSnapshot(this.client, lookupDestinationId, message.id, settledChannel, reconciliationConnection);
                if (this.stopping || signal?.aborted || !this.isCurrentLifecycle(passLifecycle) ||
                    passConnectionEpoch !== this.connectionEpoch) return;
                queueReconciliationRetry([message.id, ...deferredRetryMessageIds]);
              },
              failed: () => {
                if (!lookupAbandoned || this.stopping || signal?.aborted ||
                    !this.isCurrentLifecycle(passLifecycle) ||
                    passConnectionEpoch !== this.connectionEpoch) return;
                queueReconciliationRetry([message.id, ...deferredRetryMessageIds]);
              }
            });
            // Only an actually owned in-flight lookup gives this pass late
            // settlement interest. A consumed one-use snapshot resolves without
            // registering an entry, so it must leave this false.
            waiterAttached = hasReconciliationLookup(this.client, lookupDestinationId);
            return lookupPromise;
          },
          signal,
          deadline
        );
        releaseLookupWaiter?.();
      } catch (error) {
        if (recoveryKind(error) === CODEX_VALIDATION_KINDS.STOPPED) {
          releaseLookupWaiter?.();
          return this.state.recoveryCandidates(before).filter(allowed);
        }
        if (recoveryKind(error) === CODEX_VALIDATION_KINDS.DEADLINE && waiterAttached) {
          lookupAbandoned = true;
          // Rotate unrelated candidates ahead of the retry, but keep undispatched
          // custody for this native owner in its original order. A destination
          // whose single-flight lookup is still owned is NOT requeued here: its
          // attached waiter wakes it on genuine settlement, and requeuing it every
          // deadline would be the endless replacement chain the ruling forbids.
          const lookupInFlight = hasReconciliationLookup(this.client, lookupDestinationId);
          const laterCandidates = ordered.slice(candidateIndex + 1);
          const laterOwnerIds = [];
          const otherOwnerIds = [];
          for (const candidate of laterCandidates) {
            const candidateKey = `${candidate.provider}:${candidate.nativeId}`;
            if (candidateKey === key) laterOwnerIds.push(candidate.id);
            else otherOwnerIds.push(candidate.id);
          }
          if (lookupInFlight) deferredRetryMessageIds = laterOwnerIds;
          const retryMessageIds = lookupInFlight
            ? otherOwnerIds
            : [...otherOwnerIds, message.id, ...laterOwnerIds];
          queueReconciliationRetry(retryMessageIds);
        }
        blockedOwners.add(key);
        if (!channelFetchStarted) {
          if (!waiterAttached) continue;
          queueReconciliationRetry([message.id, ...deferredRetryMessageIds]);
        }
        this.markThreadDeliveryUnavailable(message, error);
        this.state.markObservationUnavailable(message.id, error);
        continue;
      }
      if (!channel) {
        blockedOwners.add(key);
        const error = new Error('Discord channel is unavailable during recovery');
        this.markThreadDeliveryUnavailable(message, error);
        this.state.markObservationUnavailable(message.id, error);
        continue;
      }
      if (message.deliveryChannelId && message.deliveryChannelId !== message.channelId) {
        try { assertPublicThread(channel, this.state.getBinding(message.channelId), message.deliveryChannelId, this.client.user); }
        catch (error) {
          this.markThreadDeliveryUnavailable(message, error);
          blockedOwners.add(key);
          continue;
        }
      } else {
        const binding = this.state.getBinding(message.channelId);
        if (!binding?.active || !storedChannelMatches(channel, message)) {
          blockedOwners.add(key);
          continue;
        }
        if (isHeldDurable(message)) {
          const ordinary = this.state.isOrdinaryBinding?.(binding) === true;
          if ((ordinary && channel.guildId && channel.guildId !== binding.guildId) ||
              (!ordinary && !conductorMarkerMatchesTopic(channel.topic, binding))) {
            blockedOwners.add(key);
            continue;
          }
          const permission = this.historyPermission(channel, { requireSend: true });
          if (!permission.known || !permission.allowed) {
            blockedOwners.add(key);
            continue;
          }
        }
      }
      storedMessage.channel = channel;
      // F11: attach the verified channel to the ORIGINAL observation entry without
      // replacing its promise/observer, so a deferred reply on the existing work can
      // still deliver after the recovery fetch that failed once finally succeeds.
      this.consumer?.refreshNativeWorkChannel?.(storedMessage);
      if (!this.state.getMessageRoute(message.deliveryChannelId || message.channelId)?.ready &&
          !isHeldDurable(message)) {
        blockedOwners.add(key);
        continue;
      }
      let recoveryOperationStarted = false;
      try {
        const startRecoveryOperation = operation => {
          recoveryOperationStarted = true;
          return operation();
        };
        const settleReplyDeadline = () => {
          const current = this.state.getMessage(message.id);
          if (current?.state !== 'replying') return current;
          return this.state.markReplyFailure(message.id, new Error('Discord recovery deadline exceeded while delivering reply'), true);
        };
        const deliverReplyWithinRecovery = (replyMessage, replyResult) => {
          const deliveryController = new AbortController();
          const settle = () => {
            deliveryController.abort();
            settleReplyDeadline();
          };
          const relayAbort = () => settle();
          if (signal?.aborted) settle();
          else signal?.addEventListener('abort', relayAbort, { once: true });
          return waitForRecoveryOperation(
            () => startRecoveryOperation(() => this.consumer.deliverReply(replyMessage, replyResult, deliveryController.signal)),
            signal,
            deadline,
            settle
          ).finally(() => signal?.removeEventListener('abort', relayAbort));
        };
        if (message.state === 'accepted') {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            recoveryOperationStarted = false;
            result = await waitForRecoveryOperation(
              () => startRecoveryOperation(() => this.consumer.handleStoredMessage(storedMessage, signal, { continueUntilFinal: true, handoff: true, awaitDispatchOutcome: true })),
              signal,
              deadline
            );
            const stillAccepted = result?.status === DISPATCH_OUTCOMES.NOT_SUBMITTED &&
              this.state.getMessage(message.id)?.state === 'accepted';
            if (!stillAccepted || !this.state.getMessageRoute(message.deliveryChannelId || message.channelId)?.ready) break;
          }
        } else if (message.state === 'submitted') {
          const current = this.state.getMessage(message.id);
          if (current?.state === 'reply_ready') {
            this.state.recoverNativeReplyAcknowledgment(message.id);
            recoveryOperationStarted = false;
            result = await deliverReplyWithinRecovery(storedMessage, { status: current.state, message: current });
          }
        } else {
          this.state.recoverNativeReplyAcknowledgment(message.id);
          recoveryOperationStarted = false;
          result = await deliverReplyWithinRecovery(storedMessage, { status: message.state, message });
        }
        if (result === DISPATCH_OUTCOMES.NOT_SUBMITTED || result?.status === DISPATCH_OUTCOMES.NOT_SUBMITTED) {
          blockedOwners.add(key);
        }
      } catch (error) {
        if (recoveryKind(error) === CODEX_VALIDATION_KINDS.STOPPED) return this.state.recoveryCandidates(before).filter(allowed);
        if (recoveryKind(error) === CODEX_VALIDATION_KINDS.DEADLINE) {
          const current = this.state.getMessage(message.id);
          if (!recoveryOperationStarted || current?.state === 'reply_ready') {
            // The preflight check or reply preparation skipped delivery, so retain custody for a fresh pass.
            queueReconciliationRetry([message.id]);
          }
        }
        blockedOwners.add(key);
        this.state.markObservationUnavailable(message.id, error);
        continue;
      }
    }
    return this.state.recoveryCandidates(before).filter(allowed);
  }

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
    if (this.stopPromise) return this.stopPromise;
    this.lifecycleEpoch += 1;
    this.connectionEpoch += 1;
    this.stopping = true;
    this.started = false;
    this.transportReady = false;
    this.resolveInteractionRecovery(false);
    invalidateReconciliationWaiters(this.client);
    for (const timer of this.liveAttachmentRecoveryTimers) clearImmediate(timer);
    this.liveAttachmentRecoveryTimers.clear();
    for (const channelId of this.attachmentIntakeBlockedChannels) this.consumer.releaseIntake(channelId);
    this.attachmentIntakeBlockedChannels.clear();
    this.attachmentIntakeRetryPendingChannels.clear();
    this.attachmentIntakeRetryMessages.clear();
    this.attachmentIntakeRetryInFlight.clear();
    if (this.deferredHandoffRecoveryTimer) clearTimeout(this.deferredHandoffRecoveryTimer);
    this.deferredHandoffRecoveryTimer = null;
    this.deferredHandoffRecoveryTimerDeadline = null;
    if (this.pendingHandoffRecoveryPollTimer) clearTimeout(this.pendingHandoffRecoveryPollTimer);
    this.pendingHandoffRecoveryPollTimer = null;
    this.deferredHandoffRecoveryChannels.clear();
    this.pendingHandoffRecoveryChannels.clear();
    this.pendingFullRecovery = false;
    this.pendingRecoveryChannels.clear();
    for (const request of this.pendingRecoveryRequests.splice(0)) request.waiter?.stop?.();
    this.recoveryRetryScheduledChannels.clear();
    this.closingCustodyRetries.clear();
    this.deferredHandoffRecoveryDelayMs = DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS;
    this.stopPromise = (async () => {
      this.ready = false;
      this.recoveryController?.abort();
      this.decisionRecoveryController?.abort();
      this.liveCheckpointController?.abort();
      const recovery = this.recoveryPromise;
      const reconnect = this.reconnectPromise;
      const liveCheckpoint = this.liveCheckpointPromise;
      await Promise.allSettled([recovery, reconnect, liveCheckpoint].filter(Boolean));
      if (this.liveCheckpointRetryTimer) clearTimeout(this.liveCheckpointRetryTimer);
      this.liveCheckpointRetryTimer = null;
      this.liveCheckpointRetryChannels = null;
      this.liveCheckpointRetryDelayMs = LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS;
      this.liveIntakeCounts.clear();
      for (const controller of this.controllers) controller.abort();
      for (const controller of this.receiptControllers) controller.abort();
      const acknowledgmentStop = this.acknowledgments?.stop();
      this.acknowledgments = null;
      this.consumer.abortNativeWork();
      await Promise.allSettled([...this.inFlight]);
      await this.consumer.waitForNativeWork();
      await this.consumer.waitForReceipts();
      await acknowledgmentStop;
      this.client.off?.('messageCreate', this.boundMessage);
      this.client.off?.('interactionCreate', this.boundInteraction);
      this.client.off?.('shardResume', this.boundResume);
      this.client.off?.('resume', this.boundResume);
      this.client.off?.('shardDisconnect', this.boundDisconnect);
      this.client.off?.('shardReconnecting', this.boundReconnecting);
      this.client.off?.('shardReady', this.boundShardReady);
      try {
        if (typeof this.client.destroy === 'function') await this.client.destroy();
      } finally {
        this.discordToken = null;
      }
    })();
    try { await this.stopPromise; }
    finally {
      this.stopPromise = null;
      this.stopping = false;
    }
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
