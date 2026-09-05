const fs = require('node:fs');
const { createRequire } = require('node:module');
const { dispatchAndObserve, ClaudeProvider, CodexProvider, observeSubmitted, waitForReply } = require('./native');
const { MESSAGE_STATES, READINESS, RECOVERY_LIMITS, UnresolvedWorkError } = require('./state');
const { conductorMarkerMatches } = require('./topic');

const requireInstalled = createRequire('/Users/cphamballer/.codex/mcp/discord/package.json');

function recoveryError(kind, detail) {
  const error = new Error(detail);
  error.recoveryKind = kind;
  return error;
}

function waitForRecoveryOperation(operation, signal, deadline, onDeadline = null) {
  if (signal?.aborted) return Promise.reject(recoveryError('stopped', 'Discord recovery was stopped'));
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(recoveryError('deadline', 'Discord recovery deadline exceeded'));
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
    const onAbort = () => finish(reject, recoveryError('stopped', 'Discord recovery was stopped'));
    timer = setTimeout(() => {
      try { onDeadline?.(); } finally { finish(reject, recoveryError('deadline', 'Discord recovery deadline exceeded')); }
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

function compareDiscordIds(left, right) {
  try {
    const a = BigInt(left);
    const b = BigInt(right);
    return a === b ? 0 : a > b ? 1 : -1;
  } catch {
    return String(left).localeCompare(String(right));
  }
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
  return {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    authorId: message.author?.id,
    isBot: Boolean(message.author?.bot),
    content: message.content
  };
}

function classifyReplyError(error) {
  if (error?.outcome) return error.outcome;
  if (/authorization|stale|custody|generation/i.test(error?.message || '')) return 'failed';
  if (error?.status === 400 || error?.status === 401 || error?.status === 403 || error?.status === 404 || error?.code === 50013) return 'failed';
  if (error?.status >= 500 || error?.potentiallyDelivered || error?.wrote || error?.name === 'TypeError') return 'unknown';
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.code)) return 'unknown';
  return 'unknown';
}

function classifyTransportReceiptError(error) {
  if (error?.status === 429 || error?.code === 429 || /^RateLimitError(?:\[|$)/.test(String(error?.name || '')) || /^RateLimitError(?:\[|$)/.test(String(error?.message || ''))) return 'rate_limited';
  if ([400, 401, 403, 404].includes(error?.status) || error?.code === 50013) return 'rejected';
  return 'unknown';
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {}
}

function transportReceiptText(message, attempt) {
  if (attempt.readiness === 'ready') return 'Receipt: saved for this conductor.';
  return 'Receipt: saved. Delivery was paused when this receipt was prepared.';
}

function createSurfaceConsumer({ state, providers, sendReply, sendTransportReceipt, trackReceipt, observeOptions = {} }) {
  const receiptWork = new Set();
  const nativeWork = new Map();

  function trackReceiptWork(work) {
    const tracked = Promise.resolve(work).catch(() => null);
    receiptWork.add(tracked);
    tracked.finally(() => receiptWork.delete(tracked)).catch(() => {});
    trackReceipt?.(tracked);
    return tracked;
  }

  async function issueTransportReceipt(message) {
    const started = state.beginTransportReceipt(message.id);
    if (!started.started) return started;
    const authorized = state.authorizeTransportReceipt(message.id, started.binding);
    if (!authorized) return state.recordTransportReceiptOutcome(message.id, 'stale', { reason: 'authorization changed before receipt send' });
    const payload = {
      ...authorized.attempt,
      content: transportReceiptText(message, authorized.attempt),
      nonce: authorized.nonce,
      enforceNonce: true,
      allowedMentions: { parse: [], repliedUser: false },
      reply: { messageReference: message.id, failIfNotExists: false }
    };
    const sender = sendTransportReceipt || ((source, receipt) => source.channel?.send(receipt));
    try {
      const sent = await sender(message, payload);
      const receiptMessageId = sent?.id || sent?.messageId;
      if (!receiptMessageId) throw new Error('Discord did not return a transport receipt message id');
      return state.recordTransportReceiptOutcome(message.id, 'sent', { receiptMessageId });
    } catch (error) {
      return state.recordTransportReceiptOutcome(message.id, classifyTransportReceiptError(error), { error: String(error?.message || error).slice(0, 200) });
    }
  }

  function launchTransportReceipt(message) {
    return trackReceiptWork(issueTransportReceipt(message));
  }

  function trackNativeWork(messageId, work, onSettled = null) {
    const tracked = Promise.resolve(work);
    nativeWork.set(messageId, { promise: tracked, controller: null });
    tracked.finally(() => {
      if (nativeWork.get(messageId)?.promise !== tracked) return;
      nativeWork.delete(messageId);
      try { onSettled?.(messageId); } catch {}
    }).catch(() => {});
    return tracked;
  }

  function existingNativeWork(message, awaitExisting) {
    const existing = nativeWork.get(message.id)?.promise;
    if (!existing) return null;
    if (awaitExisting) return existing;
    return Promise.resolve({ status: 'observing', message: state.getMessage(message.id) });
  }

  function startNativeWork(messageId, signal, workFactory, onSettled = null) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const work = Promise.resolve().then(() => {
      if (controller.signal.aborted) return { status: 'stopped', message: null };
      return workFactory(controller.signal);
    });
    const tracked = trackNativeWork(messageId, work, onSettled);
    const entry = nativeWork.get(messageId);
    if (entry?.promise === tracked) entry.controller = controller;
    tracked.finally(() => signal?.removeEventListener('abort', onAbort)).catch(() => {});
    return tracked;
  }

  function abortNativeWork() {
    for (const entry of nativeWork.values()) entry.controller?.abort();
  }

  async function waitForNativeWork() {
    while (nativeWork.size) {
      await Promise.allSettled([...nativeWork.values()].map(entry => entry.promise));
    }
  }

  async function deliverReply(message, result, signal) {
    if (result.message?.state !== 'reply_ready') return result;
    let ready;
    try {
      ready = state.beginReply(result.message.id);
    } catch (error) {
      return { ...result, message: state.getMessage(result.message.id), error };
    }
    if (ready.sent) return { ...result, message: ready.message };
    const parts = ready.message.replyParts?.length ? ready.message.replyParts : [{ index: 0, content: ready.message.replyText, nonce: ready.message.replyNonce, state: 'sending' }];
    for (const part of parts) {
      if (part.state === 'sent') continue;
      if (signal?.aborted) return { ...result, message: state.markReplyFailure(ready.message.id, new Error('reply delivery stopped'), true, part.index) };
      try {
        state.assertMessageCurrent(ready.message.id, 'reply-send');
        if (part.content.length > 2000) throw new Error('Discord reply part exceeds 2000 characters');
        const sent = await sendReply(message, { ...ready.message, replyText: part.content, replyNonce: part.nonce, replyPart: part });
        const replyId = sent?.id || sent?.messageId;
        if (!replyId) throw new Error('Discord did not return a message id');
        const saved = state.markReplyPartSent(ready.message.id, part.index, replyId);
        if (saved.state === 'replied') return { ...result, message: saved };
      } catch (error) {
        const unknown = classifyReplyError(error) === 'unknown';
        return { ...result, message: state.markReplyFailure(ready.message.id, error, unknown, part.index), error };
      }
    }
    return { ...result, message: state.getMessage(ready.message.id) };
  }

  function processAccepted(message, signal, { continueUntilFinal = true, awaitExisting = true, handoff = false, onSettled = null } = {}) {
    const existing = existingNativeWork(message, awaitExisting);
    if (existing) return existing;
    let settleHandoff;
    let rejectHandoff;
    const handoffPromise = handoff ? new Promise((resolve, reject) => {
      settleHandoff = resolve;
      rejectHandoff = reject;
    }) : null;
    handoffPromise?.catch(() => {});
    const work = startNativeWork(message.id, signal, async taskSignal => {
      const result = await dispatchAndObserve(state, message.id, providers, {
        ...observeOptions,
        signal: taskSignal,
        continueUntilFinal,
        onSubmitted: submitted => settleHandoff?.({ status: 'observing', message: submitted })
      });
      return deliverReply(message, result, taskSignal);
    }, onSettled);
    if (!handoff) return work;
    work.then(result => settleHandoff?.(result), error => rejectHandoff?.(error));
    return handoffPromise;
  }

  async function handleMessage(message, signal) {
    const intake = state.acceptDiscordMessage(eventToInput(message));
    if (!intake.accepted) return intake;
    launchTransportReceipt(message);
    return processAccepted(message, signal);
  }

  async function intakeMessage(message, ready = false, coverageId = null, expectedBinding = null, emitReceipt = false) {
    const intake = await state.acceptDiscordMessage(eventToInput(message), { ready, coverageId, expectedBinding });
    if (emitReceipt && intake.accepted) launchTransportReceipt(message);
    return intake;
  }

  async function handleStoredMessage(message, signal, { continueUntilFinal = false, handoff = false, onSettled = null } = {}) {
    launchTransportReceipt(message);
    return processAccepted(message, signal, { continueUntilFinal, awaitExisting: false, handoff, onSettled });
  }

  function resumeSubmitted(message, signal, { awaitExisting = false, continueUntilFinal = false, onSettled = null } = {}) {
    launchTransportReceipt(message);
    const existing = existingNativeWork(message, awaitExisting);
    if (existing) return existing;
    const work = startNativeWork(message.id, signal, async taskSignal => {
      const provider = providers[message.provider];
      const result = await observeSubmitted(state, message, provider, { ...observeOptions, signal: taskSignal, continueUntilFinal });
      return deliverReply(message, result, taskSignal);
    }, onSettled);
    if (continueUntilFinal) return Promise.resolve({ status: 'observing', message: state.getMessage(message.id) });
    return work;
  }

  async function waitForReceipts() {
    await Promise.allSettled([...receiptWork]);
  }

  return { abortNativeWork, deliverReply, handleMessage, handleStoredMessage, intakeMessage, issueTransportReceipt, processAccepted, resumeSubmitted, waitForNativeWork, waitForReceipts };
}

class DiscordGateway {
  constructor({ state, client, logger = () => {}, observeOptions = {}, providers, fetchHistory, recoveryOptions = {} } = {}) {
    this.state = state;
    this.logger = logger;
    this.client = client || this.createClient();
    this.discordToken = null;
    this.controllers = new Set();
    this.receiptControllers = new Set();
    this.inFlight = new Set();
    this.stopping = false;
    this.stopPromise = null;
    this.startPromise = null;
    this.starting = false;
    this.started = false;
    this.lifecycleEpoch = 0;
    this.connectionEpoch = 0;
    this.recoveryController = null;
    this.recoveryPromise = null;
    this.recoveryDrainPromise = null;
    this.recoveryDrainRequested = false;
    this.reconnectPromise = null;
    this.fetchHistoryInjected = typeof fetchHistory === 'function';
    this.fetchHistory = fetchHistory || ((channel, options) => channel.messages?.fetch(options));
    this.historyPageLimit = Math.min(RECOVERY_LIMITS.pageSize, Math.max(1, Number(recoveryOptions.pageLimit || RECOVERY_LIMITS.pageSize)));
    this.historyMaxPages = Math.min(RECOVERY_LIMITS.maxPages, Math.max(1, Number(recoveryOptions.maxPages || RECOVERY_LIMITS.maxPages)));
    this.historyMaxMessages = Math.min(RECOVERY_LIMITS.maxMessages, Math.max(1, Number(recoveryOptions.maxMessages || RECOVERY_LIMITS.maxMessages)));
    this.recoveryTimeoutMs = Math.min(RECOVERY_LIMITS.timeoutMs, Math.max(1000, Number(recoveryOptions.timeoutMs || RECOVERY_LIMITS.timeoutMs)));
    this.ready = false;
    this.providers = providers || {
      codex: new CodexProvider(),
      claude: new ClaudeProvider({ waitForReply: (id, options) => waitForReply(state, id, options) })
    };
    this.consumer = createSurfaceConsumer({
      state,
      providers: this.providers,
      sendReply: (message, reply) => this.sendReply(message, reply),
      sendTransportReceipt: (message, receipt) => this.sendTransportReceipt(message, receipt),
      observeOptions
    });
    this.boundMessage = message => {
      if (this.stopping) return;
      const controller = new AbortController();
      this.controllers.add(controller);
      const work = (this.ready ? this.consumer.handleMessage(message, controller.signal) : this.consumer.intakeMessage(message, false, null, null, true))
        .catch(error => this.logger(`message handling failed: ${error.message}`))
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
    this.client.on?.('shardResume', this.boundResume);
    this.client.on?.('resume', this.boundResume);
    this.client.on?.('shardDisconnect', this.boundDisconnect);
    this.client.on?.('shardReconnecting', this.boundReconnecting);
    this.client.on?.('shardReady', this.boundShardReady);
  }

  createClient() {
    const { Client, GatewayIntentBits } = requireInstalled('discord.js');
    return new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  }

  async sendReply(message, reply) {
    this.state.assertMessageCurrent(reply.id, 'reply-send');
    if (typeof reply.replyText !== 'string' || reply.replyText.length > 2000) throw new Error('Discord reply must be at most 2000 characters per message');
    if (typeof reply.replyNonce !== 'string' || reply.replyNonce.length > 25) throw new Error('Discord reply nonce must be at most 25 characters');
    try {
      return await message.channel.send({
        content: reply.replyText,
        nonce: reply.replyNonce,
        enforceNonce: true,
        allowedMentions: { parse: [] }
      });
    } catch (error) {
      if (!error.outcome) error.outcome = classifyReplyError(error);
      throw error;
    }
  }

  async sendTransportReceipt(message, receipt) {
    const controller = new AbortController();
    this.receiptControllers.add(controller);
    try {
      let sendPromise;
      try {
        // discord.js channel.send drops the signal and uses the shared REST retry queue.
        if (this.discordToken && this.client?.rest && typeof globalThis.fetch === 'function') {
          const url = `https://discord.com/api/v10/channels/${encodeURIComponent(message.channel.id)}/messages`;
          sendPromise = globalThis.fetch(url, {
            method: 'POST',
            headers: {
              Authorization: `Bot ${this.discordToken}`,
              'User-Agent': 'DiscordBot (discord-surface, 0.1.0)',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              content: receipt.content,
              nonce: receipt.nonce,
              enforce_nonce: true,
              allowed_mentions: { parse: [], replied_user: false },
              message_reference: {
                message_id: message.id,
                fail_if_not_exists: false
              }
            }),
            signal: controller.signal
          }).then(async response => {
            if (!response.ok) {
              await cancelResponseBody(response);
              const error = new Error('Discord transport receipt request rejected');
              error.status = response.status;
              throw error;
            }
            let body;
            try { body = await response.json(); }
            catch (error) {
              await cancelResponseBody(response);
              throw error;
            }
            if (!body?.id) throw new Error('Discord did not return a transport receipt message id');
            return body;
          });
        } else if (this.discordToken && this.client?.rest) {
          throw new Error('Discord transport receipt fetch is unavailable');
        } else {
          sendPromise = message.channel.send({
            content: receipt.content,
            nonce: receipt.nonce,
            enforceNonce: true,
            allowedMentions: receipt.allowedMentions,
            reply: receipt.reply
          });
        }
      } catch (error) {
        sendPromise = Promise.reject(error);
      }
      return await waitForRecoveryOperation(
        () => sendPromise,
        controller.signal,
        Date.now() + this.recoveryTimeoutMs,
        () => controller.abort()
      );
    } finally {
      this.receiptControllers.delete(controller);
    }
  }

  isCurrentLifecycle(epoch) {
    return !this.stopping && this.lifecycleEpoch === epoch;
  }

  pauseConnection(detail) {
    if (this.stopping) return;
    this.ready = false;
    this.connectionEpoch += 1;
    this.recoveryController?.abort();
    for (const binding of this.state.listBindings().filter(item => item.active)) {
      try { this.state.setBindingReadiness(binding.channelId, READINESS.RECOVERING, detail, binding); }
      catch (error) { this.logger(`Discord disconnect readiness update failed: ${error.message}`); }
    }
  }

  beginReconnectRecovery(reason) {
    if (this.stopping) return Promise.resolve({ ready: false, state: 'stopped' });
    const connectionEpoch = this.connectionEpoch;
    const previousRecovery = this.recoveryPromise;
    const task = (async () => {
      await previousRecovery?.catch(() => {});
      if (this.stopping || connectionEpoch !== this.connectionEpoch) return { ready: false, state: 'stopped' };
      const result = await this.recoverTransport('reconnect', this.lifecycleEpoch);
      if (result.ready && !this.stopping && connectionEpoch === this.connectionEpoch) await this.reconcilePending();
      return result;
    })().catch(error => {
      this.logger(`Discord recovery failed: ${error.message}`);
      return { ready: false, state: recoveryKind(error) || 'unavailable', error };
    });
    this.reconnectPromise = task;
    task.finally(() => {
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
    const startPromise = (async () => {
      const token = readSecret(secretFile);
      this.discordToken = token;
      await this.client.login(token);
      if (!this.isCurrentLifecycle(epoch)) throw recoveryError('stopped', 'Discord startup was stopped during login');
      const recovery = await this.recoverTransport('startup', epoch);
      if (!this.isCurrentLifecycle(epoch)) throw recoveryError('stopped', 'Discord startup was stopped during recovery');
      if (!recovery.ready) throw new Error(`Discord intake recovery is ${recovery.state}`);
      this.started = true;
    })();
    this.startPromise = startPromise;
    try { return await startPromise; }
    finally {
      if (this.startPromise === startPromise) this.startPromise = null;
      this.starting = false;
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

  historyPermission(channel) {
    if (!this.client.user || typeof channel?.permissionsFor !== 'function') return { known: false, allowed: false };
    try {
      const { PermissionFlagsBits } = requireInstalled('discord.js');
      const permissions = channel.permissionsFor(this.client.user);
      if (!permissions || typeof permissions.has !== 'function') return { known: false, allowed: false };
      return {
        known: true,
        allowed: permissions.has(PermissionFlagsBits.ViewChannel) && permissions.has(PermissionFlagsBits.ReadMessageHistory)
      };
    } catch {
      return { known: false, allowed: false };
    }
  }

  async recordBoundary(binding, channel, state, detail, gapFrom = null, gapTo = null, signal = null) {
    if (signal?.aborted || !this.isCurrentBinding(binding)) return null;
    let watermark;
    try {
      watermark = this.state.markIntakeBoundary(binding.channelId, state, detail, gapFrom, gapTo, binding);
    } catch (error) {
      if (!(error instanceof UnresolvedWorkError) || state !== 'ready') throw error;
      const blockedDetail = `${detail}; legacy topic migration custody is unresolved`;
      watermark = this.state.markIntakeBoundary(binding.channelId, READINESS.UNAVAILABLE, blockedDetail, gapFrom, gapTo, binding);
      return watermark ? { watermark, topicPublished: false, publication: null, blocked: true, error } : null;
    }
    if (!watermark) return null;
    return { watermark, topicPublished: true, publication: null };
  }

  isCurrentBinding(binding) {
    return bindingIdentityMatches(binding, this.state.getBinding(binding.channelId));
  }

  async recoverInbound(signal, reason, lifecycleEpoch = this.lifecycleEpoch) {
    const deadline = Date.now() + this.recoveryTimeoutMs;
    const bindings = this.state.listBindings().filter(binding => binding.active);
    let failure = null;
    for (const binding of bindings) {
      if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
      if (Date.now() >= deadline) {
        await this.recordBoundary(binding, null, 'gap', `${reason} recovery exceeded ${this.recoveryTimeoutMs}ms`, null, null, signal, deadline);
        failure ||= { ready: false, state: 'gap' };
        continue;
      }
      const recovering = this.state.setBindingReadiness(binding.channelId, READINESS.RECOVERING, `${reason} intake recovery in progress`, binding);
      if (!recovering) {
        failure ||= { ready: false, state: 'unavailable' };
        continue;
      }
      let watermark = this.state.getIntakeWatermark(binding.channelId);
      if (watermark && ['gap', 'unavailable'].includes(watermark.state)) {
        failure ||= { ready: false, state: watermark.state };
        continue;
      }
      let channel;
      try {
        channel = await waitForRecoveryOperation(() => this.client.channels.fetch(binding.channelId), signal, deadline);
        if (!channel) throw new Error('Discord channel is unavailable');
      } catch (error) {
        const kind = recoveryKind(error);
        if (kind === 'stopped') return { ready: false, state: 'stopped' };
        await this.recordBoundary(binding, null, kind === 'deadline' ? 'gap' : 'unavailable', error.message, watermark?.recovered_through_id, null, signal, deadline);
        failure ||= { ready: false, state: kind === 'deadline' ? 'gap' : 'unavailable', error };
        continue;
      }
      if (!this.isCurrentBinding(binding)) {
        failure ||= { ready: false, state: 'unavailable' };
        continue;
      }
      if (!conductorMarkerMatchesTopic(channel.topic, binding)) {
        const error = new Error('Discord channel topic does not identify the current conductor and native generation');
        await this.recordBoundary(binding, channel, 'unavailable', error.message, watermark?.recovered_through_id, null, signal, deadline);
        failure ||= { ready: false, state: 'unavailable', error };
        continue;
      }
      if (!this.fetchHistoryInjected && typeof channel.messages?.fetch !== 'function') {
        const error = new Error('Discord history fetch is unavailable for intake recovery');
        await this.recordBoundary(binding, channel, 'unavailable', error.message, watermark?.recovered_through_id, null, signal, deadline);
        failure ||= { ready: false, state: 'unavailable', error };
        continue;
      }
      const permission = this.historyPermission(channel);
      if (!permission.known || !permission.allowed) {
        const error = new Error(permission.known ? 'Discord channel lacks ViewChannel or ReadMessageHistory' : 'Discord channel history permission is unknown');
        await this.recordBoundary(binding, channel, 'unavailable', error.message, watermark?.recovered_through_id, null, signal, deadline);
        failure ||= { ready: false, state: 'unavailable', error };
        continue;
      }
      if (!watermark?.recovered_through_id) {
        let baseline;
        try { baseline = this.historyMessages(await waitForRecoveryOperation(() => this.fetchHistory(channel, { limit: 1, signal }), signal, deadline)); }
        catch (error) {
          const kind = recoveryKind(error);
          if (kind === 'stopped') return { ready: false, state: 'stopped' };
          await this.recordBoundary(binding, channel, kind === 'deadline' ? 'gap' : 'unavailable', error.message, watermark?.recovered_through_id, null, signal, deadline);
          failure ||= { ready: false, state: kind === 'deadline' ? 'gap' : 'unavailable', error };
          continue;
        }
        if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
        if (!this.isCurrentBinding(binding)) {
          failure ||= { ready: false, state: 'unavailable' };
          continue;
        }
        if (baseline.some(message => typeof message?.id !== 'string' || !message.id)) {
          const error = new Error('Discord history message has no stable ID');
          await this.recordBoundary(binding, channel, 'unavailable', error.message, watermark?.recovered_through_id, null, signal, deadline);
          failure ||= { ready: false, state: 'unavailable', error };
          continue;
        }
        const newest = baseline.sort((a, b) => compareDiscordIds(b.id, a.id))[0];
        if (newest?.id) {
          const baseline = this.state.setIntakeBaseline(binding.channelId, newest.id, `${reason} cutoff excludes pre-adoption backlog`, binding);
          if (!baseline) {
            failure ||= { ready: false, state: 'unavailable' };
            continue;
          }
        } else {
          watermark = this.state.getIntakeWatermark(binding.channelId);
          if (!watermark?.last_seen_id) {
            const boundary = await this.recordBoundary(binding, channel, 'ready', `${reason} empty channel baseline`, null, null, signal, deadline);
            if (!boundary || boundary.stale || boundary.blocked) failure ||= { ready: false, state: 'unavailable', error: boundary?.error };
            continue;
          }
          const baseline = this.state.setIntakeBaseline(binding.channelId, watermark.last_seen_id, `${reason} empty channel baseline after live custody`, binding);
          if (!baseline) {
            failure ||= { ready: false, state: 'unavailable' };
            continue;
          }
        }
        watermark = this.state.getIntakeWatermark(binding.channelId);
      }
      let after = watermark?.recovered_through_id || null;
      let pages = 0;
      let total = 0;
      let complete = false;
      let attemptedId = null;
      try {
        while (pages < this.historyMaxPages && total < this.historyMaxMessages && Date.now() < deadline) {
          if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
          const options = { limit: this.historyPageLimit, signal };
          if (after) options.after = after;
          const page = this.historyMessages(await waitForRecoveryOperation(() => this.fetchHistory(channel, options), signal, deadline));
          if (!this.isCurrentBinding(binding)) throw recoveryError('stale', 'Discord recovery binding changed during history fetch');
          pages += 1;
          if (!page.length) { complete = true; break; }
          if (page.some(message => typeof message?.id !== 'string' || !message.id)) throw new Error('Discord history message has no stable ID');
          page.sort((a, b) => compareDiscordIds(a.id, b.id));
          const fresh = after ? page.filter(message => compareDiscordIds(message.id, after) > 0) : page;
          if (!fresh.length) { complete = true; break; }
          for (const message of fresh) {
            if (total >= this.historyMaxMessages) break;
            if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
            if (Date.now() >= deadline) throw recoveryError('deadline', 'Discord recovery deadline exceeded while admitting history');
            attemptedId = message.id;
            const admitted = await this.consumer.intakeMessage(this.normalizeFetchedMessage(message, channel), false, message.id, binding);
            if (admitted?.stale) throw recoveryError('stale', 'Discord recovery binding changed during history intake');
            if (!this.isCurrentBinding(binding)) throw recoveryError('stale', 'Discord recovery binding changed during history intake');
            total += 1;
            if (!after || compareDiscordIds(message.id, after) > 0) after = message.id;
          }
          if (total >= this.historyMaxMessages) break;
          if (fresh.length < page.length && page.length === this.historyPageLimit) {
            throw new Error('Discord history page overlapped the cursor without complete coverage');
          }
          if (page.length < this.historyPageLimit) { complete = true; break; }
        }
      } catch (error) {
        const kind = recoveryKind(error);
        if (kind === 'stopped') return { ready: false, state: 'stopped' };
        if (kind === 'stale') {
          failure ||= { ready: false, state: 'unavailable', error };
          continue;
        }
        await this.recordBoundary(binding, channel, kind === 'deadline' ? 'gap' : 'unavailable', error.message, watermark?.recovered_through_id, attemptedId || after, signal, deadline);
        failure ||= { ready: false, state: kind === 'deadline' ? 'gap' : 'unavailable', error };
        continue;
      }
      if (!complete) {
        const detail = pages >= this.historyMaxPages ? `history page bound ${this.historyMaxPages} reached` : total >= this.historyMaxMessages ? `history message bound ${this.historyMaxMessages} reached` : `history recovery deadline ${this.recoveryTimeoutMs}ms reached`;
        await this.recordBoundary(binding, channel, 'gap', detail, watermark?.recovered_through_id, after, signal, deadline);
        failure ||= { ready: false, state: 'gap' };
        continue;
      }
      const boundary = await this.recordBoundary(binding, channel, 'ready', `${reason} watermark backfill complete`, null, null, signal, deadline);
      if (!boundary || boundary.stale || boundary.blocked || !this.isCurrentBinding(binding)) {
        failure ||= { ready: false, state: 'unavailable' };
        continue;
      }
      const finalWatermark = this.state.getIntakeWatermark(binding.channelId);
      const finalBinding = this.state.getBinding(binding.channelId);
      const liveCustodyAhead = finalWatermark?.last_seen_id && (!finalWatermark.recovered_through_id || compareDiscordIds(finalWatermark.last_seen_id, finalWatermark.recovered_through_id) > 0);
      if (liveCustodyAhead || (finalBinding?.readiness !== READINESS.READY && finalBinding?.readiness !== READINESS.UNAVAILABLE)) {
        const detail = liveCustodyAhead
          ? 'live Discord custody arrived while recovery readiness was closing'
          : 'binding readiness changed while recovery readiness was closing';
        await this.recordBoundary(binding, channel, 'gap', detail, finalWatermark?.recovered_through_id, finalWatermark?.last_seen_id, signal, deadline);
        failure ||= { ready: false, state: 'gap' };
      }
    }
    return failure || { ready: true, state: 'ready' };
  }

  async recoverTransport(reason, lifecycleEpoch = this.lifecycleEpoch) {
    if (!this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryController = new AbortController();
    const controller = this.recoveryController;
    this.recoveryPromise = (async () => {
      const result = await this.recoverInbound(controller.signal, reason, lifecycleEpoch);
      if (result.ready && this.isCurrentLifecycle(lifecycleEpoch)) this.ready = true;
      else if (!this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
      return result;
    })();
    try { return await this.recoveryPromise; }
    finally {
      this.recoveryPromise = null;
      this.recoveryController = null;
    }
  }

  requestRecoveryDrain(before, messageId) {
    const settled = this.state.getMessage(messageId);
    const ownerFree = [MESSAGE_STATES.REPLIED, MESSAGE_STATES.REPLY_FAILED, MESSAGE_STATES.REPLY_UNKNOWN].includes(settled?.state);
    if (!ownerFree || this.stopping || !this.ready) return;
    this.recoveryDrainRequested = true;
    if (this.recoveryDrainPromise) return;
    const task = (async () => {
      while (this.recoveryDrainRequested && !this.stopping && this.ready) {
        this.recoveryDrainRequested = false;
        const activeRecovery = this.recoveryPromise;
        if (activeRecovery) await activeRecovery.catch(() => {});
        if (this.stopping || !this.ready) return;
        try {
          await this.reconcilePending(before);
        } catch (error) {
          if (!this.stopping) this.logger(`Discord recovery queue drain failed: ${error.message}`);
          return;
        }
      }
    })();
    this.recoveryDrainPromise = task;
    task.finally(() => {
      if (this.recoveryDrainPromise === task) this.recoveryDrainPromise = null;
    }).catch(() => {});
  }

  async reconcilePending(before = new Date().toISOString()) {
    if (!this.ready) throw new Error('Discord gateway is not ready for recovery');
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryController = new AbortController();
    const controller = this.recoveryController;
    this.recoveryPromise = this._reconcilePending(before, controller.signal);
    try { return await this.recoveryPromise; }
    finally {
      this.recoveryPromise = null;
      this.recoveryController = null;
    }
  }

  async _reconcilePending(before, signal) {
    const deadline = Date.now() + this.recoveryTimeoutMs;
    const candidates = this.state.recoveryCandidates(before);
    const ordered = candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const sessionTails = new Set();
    for (const message of ordered) {
      if (signal?.aborted) return this.state.recoveryCandidates(before);
      const key = `${message.provider}:${message.nativeId}`;
      if (sessionTails.has(key)) continue;
      let channel;
      try { channel = await waitForRecoveryOperation(() => this.client.channels.fetch(message.channelId), signal, deadline); } catch (error) {
        if (recoveryKind(error) === 'stopped') return this.state.recoveryCandidates(before);
        this.state.markObservationUnavailable(message.id, error);
        continue;
      }
      if (!channel) {
        this.state.markObservationUnavailable(message.id, new Error('Discord channel is unavailable during recovery'));
        continue;
      }
      const storedMessage = {
        ...message,
        id: message.id,
        guildId: message.guildId,
        channelId: message.channelId,
        content: message.content,
        author: { id: message.authorId, bot: false },
        channel
      };
      let result;
      try {
        if (message.state === 'accepted') {
          result = await waitForRecoveryOperation(
            () => this.consumer.handleStoredMessage(storedMessage, signal, {
              continueUntilFinal: true,
              handoff: true,
              onSettled: settledMessageId => this.requestRecoveryDrain(before, settledMessageId)
            }),
            signal,
            deadline
          );
        } else if (message.state === 'submitted') {
          result = await waitForRecoveryOperation(
            () => this.consumer.resumeSubmitted(storedMessage, signal, {
              continueUntilFinal: true,
              onSettled: settledMessageId => this.requestRecoveryDrain(before, settledMessageId)
            }),
            signal,
            deadline
          );
        } else {
          result = await this.consumer.deliverReply(storedMessage, { status: message.state, message }, signal);
        }
      } catch (error) {
        if (recoveryKind(error) === 'stopped') return this.state.recoveryCandidates(before);
        const current = this.state.getMessage(message.id);
        if (['accepted', 'dispatching', 'submitted', 'reply_ready', 'replying'].includes(current?.state)) sessionTails.add(key);
        this.state.markObservationUnavailable(message.id, error);
        continue;
      }
      if (['accepted', 'dispatching', 'submitted', 'reply_ready', 'replying'].includes(result?.message?.state)) sessionTails.add(key);
    }
    return this.state.recoveryCandidates(before);
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.lifecycleEpoch += 1;
    this.connectionEpoch += 1;
    this.stopping = true;
    this.started = false;
    this.stopPromise = (async () => {
      this.ready = false;
      this.recoveryDrainRequested = false;
      this.recoveryController?.abort();
      const recovery = this.recoveryPromise;
      const reconnect = this.reconnectPromise;
      const recoveryDrain = this.recoveryDrainPromise;
      await Promise.allSettled([recovery, reconnect, recoveryDrain].filter(Boolean));
      for (const controller of this.controllers) controller.abort();
      for (const controller of this.receiptControllers) controller.abort();
      this.consumer.abortNativeWork();
      await Promise.allSettled([...this.inFlight]);
      await this.consumer.waitForNativeWork();
      await this.consumer.waitForReceipts();
      this.client.off?.('messageCreate', this.boundMessage);
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
  classifyReplyError,
  createSurfaceConsumer,
  eventToInput,
  readSecret,
  requireInstalled,
};
