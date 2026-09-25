const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { attachOrdinaryListener } = require('../src/cli');
const { MESSAGE_STATES, READINESS, SurfaceState } = require('../src/state');
const { staticConductorMarker } = require('../src/topic');

const CLI_PATH = path.resolve(__dirname, '../src/cli.js');
const CLAUDE = '79e3da8e-94b4-4aff-8f88-b45b3a451dd1';

const identity = Object.freeze({
  channelId: 'channel', guildId: 'guild', provider: 'claude',
  nativeId: 'owner', generation: 3, workspace: '/workspace', endpoint: '/listener.sock'
});

function fixture(changes = {}) {
  let wakes = 0;
  const binding = { ...identity, active: true, conductorId: 'conductor', ...changes };
  const state = {
    getBinding: channel => channel === identity.channelId ? binding : null,
    isOrdinaryBinding: () => false,
    getIntakeWatermark() { throw new Error('conductor attach must not read ordinary readiness'); },
    setBindingReadiness() { throw new Error('conductor attach must not mutate readiness'); }
  };
  return {
    args: { state, paths: {}, startupBinding: null, identity, label: 'Claude Monitor',
      requestRecovery: () => { wakes += 1; return { requested: true }; },
      stderr: { write() {} } },
    wakes: () => wakes
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function expectWithin(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error(`${label} did not happen within ${timeoutMs}ms`);
}

function conductorFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-'));
  const db = path.join(dir, 'surface.sqlite');
  const socketPath = path.join(dir, 's.sock');
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  const binding = state.bind({
    channelId: 'claude-channel', guildId: 'guild', provider: 'claude', nativeId: CLAUDE,
    workspace: dir, endpoint: socketPath, conductorId: 'conductor-1', repoKey: 'repo-1'
  });
  state.setIntakeBaseline(binding.channelId, '100', 'previous completed recovery', binding);
  state.close();
  t.after(() => {
    try { state.close(); } catch {}
    try { fs.unlinkSync(socketPath); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, db, socketPath, binding };
}

function spawnGateway(t, f, { messageId, content }) {
  const preloadPath = path.join(f.dir, 'gateway-preload.cjs');
  const archiveRoot = path.resolve(__dirname, '..');
  fs.writeFileSync(path.join(f.dir, 'discord.env'), 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  const preloadSource = String.raw`
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const archive = __ARCHIVE__;
const channelId = __CHANNEL__;
const heldMessageId = __MESSAGE_ID__;
const heldContent = __CONTENT__;
const topic = __TOPIC__;
const socketPath = __SOCKET__;
const channel = {
  id: channelId,
  guildId: 'guild',
  topic,
  isTextBased: () => true,
  isThread: () => false,
  permissionsFor: () => ({ has: () => true }),
  messages: {
    async fetch() {
      if (!fs.existsSync(socketPath)) return [];
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
    return result.statusCode === 202 ? { status: 'submitted' } : { status: 'not-submitted', error: new Error('Claude conductor returned ' + result.statusCode) };
  }
  observe() { return { stopped: true }; }
}
require.cache[require.resolve(nativePath)].exports = { ...native, ClaudeProvider: FixtureClaudeProvider };
setInterval(() => {}, 1000);
`.replaceAll('__ARCHIVE__', JSON.stringify(archiveRoot))
    .replaceAll('__CHANNEL__', JSON.stringify(f.binding.channelId))
    .replaceAll('__MESSAGE_ID__', JSON.stringify(messageId))
    .replaceAll('__CONTENT__', JSON.stringify(content))
    .replaceAll('__TOPIC__', JSON.stringify(staticConductorMarker({
      provider: f.binding.provider, conductorId: f.binding.conductorId, repoKey: f.binding.repoKey
    })))
    .replaceAll('__SOCKET__', JSON.stringify(f.socketPath));
  fs.writeFileSync(preloadPath, preloadSource, { mode: 0o600 });
  const child = spawn(process.execPath, [CLI_PATH, 'run', '--state-dir', f.dir, '--db', f.db], {
    cwd: archiveRoot,
    env: { ...process.env, NODE_OPTIONS: `--require=${preloadPath}`, DISCORD_SURFACE_LOCK_HELD: '1' },
    stdio: ['ignore', 'ignore', 'pipe']
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
  return { child, stderr: () => stderr };
}

function spawnListener(t, f, command) {
  const child = spawn(process.execPath, [CLI_PATH, command, '--state-dir', f.dir, '--db', f.db, '--native-id', CLAUDE, '--socket', f.socketPath], {
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
  return { child, stdout: () => stdout, stderr: () => stderr, async terminate() {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
  } };
}

test('attachOrdinaryListener wakes once without ordinary readiness changes', () => {
  for (const label of ['Claude channel', 'Claude Monitor']) {
    const f = fixture();
    assert.deepEqual(attachOrdinaryListener({ ...f.args, label }), { requested: true });
    assert.equal(f.wakes(), 1);
  }
});

test('conductor attach refuses changed identity before waking', () => {
  for (const change of [
    { active: false }, { nativeId: 'successor' }, { generation: 4 },
    { provider: 'codex' }, { endpoint: '/other.sock' }, { workspace: '/other' }, { guildId: 'other' }
  ]) {
    const f = fixture(change);
    assert.throws(() => attachOrdinaryListener(f.args), /binding changed during startup/);
    assert.equal(f.wakes(), 0);
  }
});

test('missing Gateway is reported without promoting conductor readiness', () => {
  const f = fixture();
  const output = [];
  const result = attachOrdinaryListener({ ...f.args,
    requestRecovery: () => ({ requested: false, reason: 'gateway-not-running' }),
    stderr: { write: text => output.push(text) }
  });
  assert.equal(result.requested, false);
  assert.match(output.join(''), /gateway-not-running/);
});

test('unsupported wake refuses attach without revoking conductor readiness', () => {
  const f = fixture();
  assert.throws(() => attachOrdinaryListener({ ...f.args,
    requestRecovery: () => ({ requested: false, reason: 'gateway-wake-unsupported' })
  }), /gateway-wake-unsupported/);
});

for (const command of ['claude-channel', 'claude-monitor']) {
  test(`${command} CLI entrypoint wakes Gateway and delivers held conductor intake`, async t => {
    const messageId = command === 'claude-channel' ? '101' : '102';
    const content = `deliver through ${command}`;
    const f = conductorFixture(t);
    spawnGateway(t, f, { messageId, content });
    await expectWithin(() => fs.existsSync(path.join(f.dir, 'runtime.pid')), `${command} Gateway runtime pid`);
    const recovered = new SurfaceState(f.db);
    try {
      await expectWithin(() => recovered.getBinding(f.binding.channelId)?.readiness === READINESS.READY &&
        recovered.getIntakeWatermark(f.binding.channelId)?.state === READINESS.READY,
      `${command} initial Gateway recovery`);
    } finally {
      recovered.close();
    }
    const acceptedState = new SurfaceState(f.db);
    const accepted = acceptedState.acceptDiscordMessage({
      id: messageId, guildId: 'guild', channelId: f.binding.channelId,
      authorId: 'operator', isBot: false, content, attachments: []
    }, { ready: false });
    assert.equal(accepted.accepted, true);
    assert.equal(acceptedState.claimDispatch(messageId).reason, 'binding-not-ready');
    assert.equal(acceptedState.getMessage(messageId)?.state, MESSAGE_STATES.ACCEPTED);
    acceptedState.close();
    const listener = spawnListener(t, f, command);
    await expectWithin(() => fs.existsSync(f.socketPath), `${command} listener socket`);
    await expectWithin(() => listener.stdout().includes(messageId), `held message delivery through ${command}`);
    const observed = new SurfaceState(f.db);
    t.after(() => { try { observed.close(); } catch {} });
    await expectWithin(() => observed.getMessage(messageId)?.state === MESSAGE_STATES.SUBMITTED,
      `${command} submitted held message`);
    if (command === 'claude-monitor') {
      const pointer = listener.stdout().trim().split('\n').map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).find(value => value?.meta?.messageId === messageId);
      assert.ok(pointer?.payloadPath, 'Claude Monitor must expose the delivered payload');
      assert.equal(JSON.parse(fs.readFileSync(pointer.payloadPath, 'utf8')).content, content);
    } else {
      assert.match(listener.stdout(), new RegExp(content));
    }
    await listener.terminate();
  });
}
