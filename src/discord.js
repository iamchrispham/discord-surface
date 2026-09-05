const fs = require('node:fs');
const { createRequire } = require('node:module');
const { dispatchAndObserve, ClaudeProvider, CodexProvider, waitForReply } = require('./native');

const requireInstalled = createRequire('/Users/cphamballer/.codex/mcp/discord/package.json');

function readSecret(secretFile) {
  if (!fs.existsSync(secretFile)) throw new Error('Discord secret file does not exist');
  const mode = fs.statSync(secretFile).mode & 0o777;
  if (mode & 0o077) throw new Error('Discord secret file must be owner-only');
  const token = fs.readFileSync(secretFile, 'utf8').trim();
  if (!token) throw new Error('Discord secret file is empty');
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

function createSurfaceConsumer({ state, providers, sendReply, observeOptions = {} }) {
  async function handleMessage(message) {
    const intake = state.acceptDiscordMessage(eventToInput(message));
    if (!intake.accepted) return intake;
    const result = await dispatchAndObserve(state, intake.message.id, providers, observeOptions);
    if (result.message?.state !== 'reply_ready') return result;
    const ready = state.beginReply(result.message.id);
    if (ready.sent) return { ...result, message: ready.message };
    try {
      const sent = await sendReply(message, ready.message);
      const replyId = sent?.id || sent?.messageId;
      if (!replyId) throw new Error('Discord did not return a message id');
      return { ...result, message: state.markReplySent(ready.message.id, replyId) };
    } catch (error) {
      const unknown = error?.outcome === 'unknown';
      return { ...result, message: state.markReplyFailure(ready.message.id, error, unknown), error };
    }
  }
  return { handleMessage };
}

class DiscordGateway {
  constructor({ state, client, logger = () => {}, observeOptions = {} } = {}) {
    this.state = state;
    this.logger = logger;
    this.client = client || this.createClient();
    this.consumer = createSurfaceConsumer({
      state,
      providers: {
        codex: new CodexProvider(),
        claude: new ClaudeProvider({ waitForReply: (id, options) => waitForReply(state, id, options) })
      },
      sendReply: (message, reply) => this.sendReply(message, reply),
      observeOptions
    });
    this.boundMessage = message => this.consumer.handleMessage(message).catch(error => this.logger(`message handling failed: ${error.message}`));
    this.client.on('messageCreate', this.boundMessage);
  }

  createClient() {
    const { Client, GatewayIntentBits } = requireInstalled('discord.js');
    return new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  }

  async sendReply(message, reply) {
    return message.channel.send({
      content: reply.replyText,
      nonce: reply.replyNonce,
      allowedMentions: { parse: [] }
    });
  }

  async start(secretFile) {
    const token = readSecret(secretFile);
    await this.client.login(token);
  }

  async stop() {
    this.client.off?.('messageCreate', this.boundMessage);
    if (typeof this.client.destroy === 'function') await this.client.destroy();
  }
}

module.exports = {
  DiscordGateway,
  createSurfaceConsumer,
  eventToInput,
  readSecret,
  requireInstalled
};
