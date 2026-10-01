const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SurfaceState, MESSAGE_STATES } = require('../src/state');
const { DiscordGateway, createSurfaceConsumer } = require('../src/discord');
const {
  COMPONENT_TYPES,
  CS_COMMAND,
  DEFERRED_UPDATE_CALLBACK_TYPE,
  INTERACTION_OUTCOMES,
  SAVED_CALLBACK_CONTENT,
  decodeDecisionCustomId,
  encodeDecisionCustomId,
  parseComponentInteraction,
  parseCsInteraction,
  sendComponentCallback,
  sendInteractionCallback,
  upsertGuildCsCommand
} = require('../src/discord-interaction');
const {
  ACK,
  ACK_WAITING,
  createAcknowledgmentDelivery,
  isAcknowledgmentPending,
  recordNativeAcknowledgment
} = require('../src/acknowledgment');

const { NATIVE_ID, fixture, interaction, componentInteraction, latestDetail, callbackOutcome, acceptWithCallback, closeFixture } = require('./cs-interaction-fixture');

test('command registration failure is reported without taking down the ordinary Gateway path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-cs-startup-'));
  const secretFile = path.join(dir, 'discord.secret');
  fs.writeFileSync(secretFile, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile });
  state.bind({ channelId: 'channel', guildId: 'guild', provider: 'codex', nativeId: NATIVE_ID, workspace: dir }, { intakeCutoff: '100' });
  state.setBindingReadiness('channel', 'ready');

  const listeners = new Map();
  const logs = [];
  let destroyCalls = 0;
  const client = {
    application: {
      id: 'application',
      commands: {
        async fetch() { throw Object.assign(new Error('registration transport unavailable'), { status: 503 }); }
      }
    },
    on(name, listener) { listeners.set(name, listener); },
    off(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
    async login() {},
    async destroy() { destroyCalls += 1; }
  };
  const gateway = new DiscordGateway({ state, client, providers: {}, logger: message => logs.push(message) });
  gateway.recoverTransport = async () => {
    gateway.ready = true;
    return { ready: true, state: 'ready' };
  };
  let ordinaryCalls = 0;
  gateway.consumer.handleMessage = async message => {
    ordinaryCalls += 1;
    return { accepted: true, message };
  };

  try {
    await gateway.start(secretFile);
    assert.equal(gateway.started, true);
    assert.equal(gateway.transportReady, true);
    assert.equal(destroyCalls, 0);
    assert.equal(typeof listeners.get('messageCreate'), 'function');
    assert.deepEqual(logs, ['Discord application command registration failed: registration transport unavailable']);

    listeners.get('messageCreate')({
      id: 'ordinary-after-registration-failure',
      guildId: 'guild',
      channelId: 'channel',
      author: { id: 'operator', bot: false },
      content: 'ordinary path',
      channel: { id: 'channel' }
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ordinaryCalls, 1);
  } finally {
    await gateway.stop();
    state.close();
  }
  assert.equal(destroyCalls, 1);
});
