const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { CLAUDE, CLI_PATH, sleep } = require('./fixture.cjs');

function spawnChannel(t, f) {
  const child = spawn(process.execPath, [CLI_PATH, 'claude-channel', '--state-dir', f.dir, '--db', f.db, '--native-id', CLAUDE, '--socket', f.socketPath], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 20000);
  deadline.unref();
  const closed = new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  t.after(async () => {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
  });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    async terminate() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
    }
  };
}

async function expectWithin(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error(`${label} did not happen within ${timeoutMs}ms`);
}

function readinessReceipts(state, channelId) {
  return state.listReceipts()
    .filter(row => row.kind === 'binding-readiness')
    .map(row => JSON.parse(row.detail))
    .filter(detail => detail.channelId === channelId);
}

function spawnGateway(t, f, { messageId, content }) {
  const preloadPath = path.join(f.dir, 'gateway-preload.cjs');
  const archiveRoot = path.resolve(__dirname, '..', '..');
  fs.writeFileSync(path.join(f.dir, 'discord.env'), 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  const preloadSource = String.raw`
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const archive = __ARCHIVE__;
const channelId = __CHANNEL__;
const heldMessageId = __MESSAGE_ID__;
const heldContent = __CONTENT__;
const channel = {
  id: channelId,
  guildId: 'guild',
  topic: '',
  isTextBased: () => true,
  isThread: () => false,
  permissionsFor: () => ({ has: () => true }),
  messages: {
    async fetch() {
      return [{ id: heldMessageId, guildId: 'guild', channelId, author: { id: 'operator', bot: false }, content: heldContent, attachments: [],
        async react() {} }];
    }
  },
  async send() { return { id: 'fixture-discord-message' }; }
};
class FixtureClient extends EventEmitter {
  constructor() {
    super();
    this.user = { id: 'fixture-bot' };
    this.channels = { fetch: async requested => requested === channelId ? channel : null };
    this.guilds = { fetch: async () => ({ channels: { fetch: async requested => requested ? channel : new Map([[channelId, channel]]) } }) };
  }
  async login() {}
  async destroy() {}
}
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'discord.js') return { Client: FixtureClient, GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 }, PermissionFlagsBits: { ViewChannel: 'ViewChannel', ReadMessageHistory: 'ReadMessageHistory', SendMessages: 'SendMessages' } };
  return originalLoad.apply(this, arguments);
};
const nativePath = path.join(archive, 'src', 'native.js');
const native = require(nativePath);
class FixtureClaudeProvider {
  async dispatch(message) {
    const result = await native.postUnixJson(message.endpoint, {
      nativeId: message.nativeId, messageId: message.id, generation: message.generation, content: message.content
    });
    return result.statusCode === 202 ? { status: 'submitted' } : { status: 'not-submitted', error: new Error('Claude channel returned ' + result.statusCode) };
  }
  observe() { return { stopped: true }; }
}
require.cache[require.resolve(nativePath)].exports = { ...native, ClaudeProvider: FixtureClaudeProvider };
setInterval(() => {}, 1000);
`.replaceAll('__ARCHIVE__', JSON.stringify(archiveRoot))
    .replaceAll('__CHANNEL__', JSON.stringify(f.binding.channelId))
    .replaceAll('__MESSAGE_ID__', JSON.stringify(messageId))
    .replaceAll('__CONTENT__', JSON.stringify(content));
  fs.writeFileSync(preloadPath, preloadSource, { mode: 0o600 });
  const child = spawn(process.execPath, [CLI_PATH, 'run', '--state-dir', f.dir, '--db', f.db], {
    cwd: archiveRoot,
    env: { ...process.env, NODE_OPTIONS: `--require=${preloadPath}`, DISCORD_SURFACE_LOCK_HELD: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 20000);
  deadline.unref();
  const closed = new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  t.after(async () => {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
  });
  return {
    child,
    stderr: () => stderr,
    async terminate() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
    }
  };
}

module.exports = { expectWithin, readinessReceipts, spawnChannel, spawnGateway };
