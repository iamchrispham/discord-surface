const fs = require('node:fs');
const { createRequire } = require('node:module');
const { dispatchAndObserve, ClaudeProvider, CodexProvider, observeSubmitted, waitForReply } = require('./native');
const { READINESS, RECOVERY_LIMITS } = require('./state');

const requireInstalled = createRequire('/Users/cphamballer/.codex/mcp/discord/package.json');

function compareDiscordIds(left, right) {
  try {
    const a = BigInt(left);
    const b = BigInt(right);
    return a === b ? 0 : a > b ? 1 : -1;
  } catch {
    return String(left).localeCompare(String(right));
  }
}

function topicWithReadiness(topic, readiness) {
  const current = typeof topic === 'string' ? topic : '';
  if (/\breadiness=[^\s]+/.test(current)) return current.replace(/\breadiness=[^\s]+/, `readiness=${readiness}`);
  const suffix = ` readiness=${readiness}`;
  return `${current.slice(0, Math.max(0, 1024 - suffix.length))}${suffix}`;
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

function createSurfaceConsumer({ state, providers, sendReply, observeOptions = {} }) {
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

  async function processAccepted(message, signal) {
    const result = await dispatchAndObserve(state, message.id, providers, { ...observeOptions, signal });
    return deliverReply(message, result, signal);
  }

  async function handleMessage(message, signal) {
    const intake = state.acceptDiscordMessage(eventToInput(message));
    if (!intake.accepted) return intake;
    return processAccepted(message, signal);
  }

  async function intakeMessage(message, ready = false) {
    return state.acceptDiscordMessage(eventToInput(message), { ready });
  }

  async function handleStoredMessage(message, signal) {
    return processAccepted(message, signal);
  }

  async function resumeSubmitted(message, signal) {
    const provider = providers[message.provider];
    const result = await observeSubmitted(state, message, provider, { ...observeOptions, signal });
    return deliverReply(message, result, signal);
  }

  return { deliverReply, handleMessage, handleStoredMessage, intakeMessage, processAccepted, resumeSubmitted };
}

class DiscordGateway {
  constructor({ state, client, logger = () => {}, observeOptions = {}, providers, fetchHistory, recoveryOptions = {} } = {}) {
    this.state = state;
    this.logger = logger;
    this.client = client || this.createClient();
    this.controllers = new Set();
    this.inFlight = new Set();
    this.stopping = false;
    this.stopPromise = null;
    this.recoveryController = null;
    this.recoveryPromise = null;
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
      observeOptions
    });
    this.boundMessage = message => {
      if (this.stopping) return;
      const controller = new AbortController();
      this.controllers.add(controller);
      const work = (this.ready ? this.consumer.handleMessage(message, controller.signal) : this.consumer.intakeMessage(message, false))
        .catch(error => this.logger(`message handling failed: ${error.message}`))
        .finally(() => this.controllers.delete(controller));
      this.inFlight.add(work);
      work.finally(() => this.inFlight.delete(work));
    };
    this.boundResume = () => {
      if (this.stopping) return Promise.resolve({ ready: false, state: 'stopped' });
      this.ready = false;
      return this.recoverTransport('reconnect')
        .then(result => result.ready ? this.reconcilePending() : result)
        .catch(error => this.logger(`Discord recovery failed: ${error.message}`));
    };
    this.client.on('messageCreate', this.boundMessage);
    this.client.on?.('shardResume', this.boundResume);
    this.client.on?.('resume', this.boundResume);
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

  async start(secretFile) {
    const token = readSecret(secretFile);
    await this.client.login(token);
    const recovery = await this.recoverTransport('startup');
    if (!recovery.ready) throw new Error(`Discord intake recovery is ${recovery.state}`);
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

  async updateChannelReadiness(channel, readiness) {
    if (!channel) return;
    const topic = topicWithReadiness(channel.topic, readiness);
    if (channel.topic === topic) return;
    if (typeof channel.setTopic === 'function') await channel.setTopic(topic);
    else if (typeof channel.edit === 'function') await channel.edit({ topic });
    else channel.topic = topic;
    if (channel.topic !== topic) throw new Error('Discord channel readiness topic readback mismatch');
  }

  async recordBoundary(binding, channel, state, detail, gapFrom = null, gapTo = null) {
    const watermark = this.state.markIntakeBoundary(binding.channelId, state, detail, gapFrom, gapTo);
    const readiness = state === 'ready' ? READINESS.READY : state === 'gap' ? READINESS.GAP : state === 'unavailable' ? READINESS.UNAVAILABLE : READINESS.PENDING;
    try { await this.updateChannelReadiness(channel, readiness); }
    catch (error) { this.logger(`Discord readiness topic update failed: ${error.message}`); }
    return watermark;
  }

  async recoverInbound(signal, reason) {
    const deadline = Date.now() + this.recoveryTimeoutMs;
    const bindings = this.state.listBindings().filter(binding => binding.active);
    let failure = null;
    for (const binding of bindings) {
      if (signal.aborted) return { ready: false, state: 'stopped' };
      if (Date.now() >= deadline) {
        await this.recordBoundary(binding, null, 'gap', `${reason} recovery exceeded ${this.recoveryTimeoutMs}ms`);
        failure ||= { ready: false, state: 'gap' };
        continue;
      }
      this.state.setBindingReadiness(binding.channelId, READINESS.RECOVERING, `${reason} intake recovery in progress`);
      let watermark = this.state.getIntakeWatermark(binding.channelId);
      if (watermark && ['gap', 'unavailable'].includes(watermark.state)) {
        failure ||= { ready: false, state: watermark.state };
        continue;
      }
      let channel;
      try {
        channel = await this.client.channels.fetch(binding.channelId);
        if (!channel) throw new Error('Discord channel is unavailable');
      } catch (error) {
        await this.recordBoundary(binding, null, 'unavailable', error.message);
        failure ||= { ready: false, state: 'unavailable', error };
        continue;
      }
      try { await this.updateChannelReadiness(channel, READINESS.RECOVERING); }
      catch (error) { this.logger(`Discord readiness topic update failed: ${error.message}`); }
      if (!this.fetchHistoryInjected && typeof channel.messages?.fetch !== 'function') {
        const error = new Error('Discord history fetch is unavailable for intake recovery');
        await this.recordBoundary(binding, channel, 'unavailable', error.message);
        failure ||= { ready: false, state: 'unavailable', error };
        continue;
      }
      if (!watermark?.last_seen_id) {
        let baseline;
        try { baseline = this.historyMessages(await this.fetchHistory(channel, { limit: 1, signal })); }
        catch (error) {
          await this.recordBoundary(binding, channel, 'unavailable', error.message);
          failure ||= { ready: false, state: 'unavailable', error };
          continue;
        }
        if (signal.aborted) return { ready: false, state: 'stopped' };
        if (baseline.some(message => typeof message?.id !== 'string' || !message.id)) {
          const error = new Error('Discord history message has no stable ID');
          await this.recordBoundary(binding, channel, 'unavailable', error.message);
          failure ||= { ready: false, state: 'unavailable', error };
          continue;
        }
        const newest = baseline.sort((a, b) => compareDiscordIds(b.id, a.id))[0];
        if (newest?.id) {
          this.state.setIntakeBaseline(binding.channelId, newest.id, `${reason} cutoff excludes pre-adoption backlog`);
        } else {
          watermark = this.state.getIntakeWatermark(binding.channelId);
          if (!watermark?.last_seen_id) {
            await this.recordBoundary(binding, channel, 'ready', `${reason} empty channel baseline`);
            continue;
          }
        }
        watermark = this.state.getIntakeWatermark(binding.channelId);
      }
      let after = watermark?.last_seen_id || null;
      let pages = 0;
      let total = 0;
      let complete = false;
      let attemptedId = null;
      try {
        while (pages < this.historyMaxPages && total < this.historyMaxMessages && Date.now() < deadline) {
          if (signal.aborted) return { ready: false, state: 'stopped' };
          const options = { limit: this.historyPageLimit, signal };
          if (after) options.after = after;
          const page = this.historyMessages(await this.fetchHistory(channel, options));
          pages += 1;
          if (!page.length) { complete = true; break; }
          if (page.some(message => typeof message?.id !== 'string' || !message.id)) throw new Error('Discord history message has no stable ID');
          page.sort((a, b) => compareDiscordIds(a.id, b.id));
          const fresh = after ? page.filter(message => compareDiscordIds(message.id, after) > 0) : page;
          if (!fresh.length) { complete = true; break; }
          for (const message of fresh) {
            if (total >= this.historyMaxMessages) break;
            attemptedId = message.id;
            await this.consumer.intakeMessage(this.normalizeFetchedMessage(message, channel), false);
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
        await this.recordBoundary(binding, channel, 'unavailable', error.message, watermark?.last_seen_id, attemptedId || after);
        failure ||= { ready: false, state: 'unavailable', error };
        continue;
      }
      if (!complete) {
        const detail = pages >= this.historyMaxPages ? `history page bound ${this.historyMaxPages} reached` : total >= this.historyMaxMessages ? `history message bound ${this.historyMaxMessages} reached` : `history recovery deadline ${this.recoveryTimeoutMs}ms reached`;
        await this.recordBoundary(binding, channel, 'gap', detail, watermark?.last_seen_id, after);
        failure ||= { ready: false, state: 'gap' };
        continue;
      }
      await this.recordBoundary(binding, channel, 'ready', `${reason} watermark backfill complete`);
    }
    return failure || { ready: true, state: 'ready' };
  }

  async recoverTransport(reason) {
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryController = new AbortController();
    const controller = this.recoveryController;
    this.recoveryPromise = (async () => {
      const result = await this.recoverInbound(controller.signal, reason);
      if (result.ready) this.ready = true;
      return result;
    })();
    try { return await this.recoveryPromise; }
    finally {
      this.recoveryPromise = null;
      this.recoveryController = null;
    }
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
    const candidates = this.state.recoveryCandidates(before);
    const ordered = candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const sessionTails = new Set();
    for (const message of ordered) {
      if (signal?.aborted) return this.state.recoveryCandidates(before);
      const key = `${message.provider}:${message.nativeId}`;
      if (sessionTails.has(key)) continue;
      let channel;
      try { channel = await this.client.channels.fetch(message.channelId); } catch (error) {
        this.state.markObservationUnavailable(message.id, error);
        continue;
      }
      if (!channel) {
        this.state.markObservationUnavailable(message.id, new Error('Discord channel is unavailable during recovery'));
        continue;
      }
      const storedMessage = {
        id: message.id,
        guildId: message.guildId,
        channelId: message.channelId,
        content: message.content,
        author: { id: message.authorId, bot: false },
        channel
      };
      let result;
      if (message.state === 'accepted') result = await this.consumer.handleStoredMessage(storedMessage, signal);
      else if (message.state === 'submitted') result = await this.consumer.resumeSubmitted(message, signal);
      else result = await this.consumer.deliverReply(storedMessage, { status: message.state, message }, signal);
      if (['accepted', 'submitted', 'reply_ready', 'replying'].includes(result?.message?.state)) sessionTails.add(key);
    }
    return this.state.recoveryCandidates(before);
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      this.ready = false;
      this.recoveryController?.abort();
      await this.recoveryPromise?.catch(() => {});
      for (const controller of this.controllers) controller.abort();
      await Promise.allSettled([...this.inFlight]);
      this.client.off?.('messageCreate', this.boundMessage);
      this.client.off?.('shardResume', this.boundResume);
      this.client.off?.('resume', this.boundResume);
      if (typeof this.client.destroy === 'function') await this.client.destroy();
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
  requireInstalled
};
