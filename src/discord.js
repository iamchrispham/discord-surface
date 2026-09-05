const fs = require('node:fs');
const { createRequire } = require('node:module');
const { dispatchAndObserve, ClaudeProvider, CodexProvider, observeSubmitted, waitForReply } = require('./native');

const requireInstalled = createRequire('/Users/cphamballer/.codex/mcp/discord/package.json');

function readSecret(secretFile) {
  if (!fs.existsSync(secretFile)) throw new Error('Discord secret file does not exist');
  const mode = fs.statSync(secretFile).mode & 0o777;
  if (mode & 0o077) throw new Error('Discord secret file must be owner-only');
  const lines = fs.readFileSync(secretFile, 'utf8').split(/\r?\n/);
  const assignment = lines.find(line => line.trim() && !line.trim().startsWith('#'));
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
  if (error?.status === 401 || error?.status === 403 || error?.code === 50013) return 'failed';
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'].includes(error?.code)) return 'unknown';
  return 'failed';
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

  async function handleStoredMessage(message, signal) {
    return processAccepted(message, signal);
  }

  async function resumeSubmitted(message, signal) {
    const provider = providers[message.provider];
    const result = await observeSubmitted(state, message, provider, { ...observeOptions, signal });
    return deliverReply(message, result, signal);
  }

  return { deliverReply, handleMessage, handleStoredMessage, resumeSubmitted };
}

class DiscordGateway {
  constructor({ state, client, logger = () => {}, observeOptions = {}, providers } = {}) {
    this.state = state;
    this.logger = logger;
    this.client = client || this.createClient();
    this.controllers = new Set();
    this.inFlight = new Set();
    this.stopping = false;
    this.stopPromise = null;
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
      if (!this.ready) return;
      const controller = new AbortController();
      this.controllers.add(controller);
      const work = this.consumer.handleMessage(message, controller.signal)
        .catch(error => this.logger(`message handling failed: ${error.message}`))
        .finally(() => this.controllers.delete(controller));
      this.inFlight.add(work);
      work.finally(() => this.inFlight.delete(work));
    };
    this.client.on('messageCreate', this.boundMessage);
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
    this.ready = true;
  }

  async reconcilePending(before = new Date().toISOString()) {
    if (!this.ready) throw new Error('Discord gateway is not ready for recovery');
    const candidates = this.state.recoveryCandidates(before);
    const ordered = candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const sessionTails = new Set();
    for (const message of ordered) {
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
      if (message.state === 'accepted') result = await this.consumer.handleStoredMessage(storedMessage, undefined);
      else if (message.state === 'submitted') result = await this.consumer.resumeSubmitted(message, undefined);
      else result = await this.consumer.deliverReply(storedMessage, { status: message.state, message });
      if (['accepted', 'submitted', 'reply_ready', 'replying'].includes(result?.message?.state)) sessionTails.add(key);
    }
    return this.state.recoveryCandidates(before);
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      this.ready = false;
      for (const controller of this.controllers) controller.abort();
      await Promise.allSettled([...this.inFlight]);
      this.client.off?.('messageCreate', this.boundMessage);
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
