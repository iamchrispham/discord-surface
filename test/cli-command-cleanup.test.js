'use strict';

// Pins command cleanup order in the public provisionInternal handler. Discord is
// replaced through the CommonJS require cache before the companion loads; the
// handler itself is never copied or bypassed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Loaded first so modules that capture '../discord' at load time keep the real one.
require('../src/discord');
require('../src/discord/channel-provisioning');
const { staticConductorMarker } = require('../src/topic');

const DISCORD_PATH = require.resolve('../src/discord');
const PROVISION_PATH = require.resolve('../src/cli/provision-commands');
const NATIVE_ID = '00000000-0000-4000-8000-000000000001';
const CONFIG = { codexCategoryId: 'fixture-category', guildId: 'fixture-guild', secretFile: 'fixture-only' };
const MARKER = staticConductorMarker({ provider: 'codex', conductorId: 'fixture-conductor', repoKey: 'fixture-repo' });

async function invokeProvisionInternal({ configError, loginError, destroy = 'succeed' }, cleanupError) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-command-cleanup-'));
  const events = [];
  const printed = [];
  let constructed = 0;
  let closed = false;
  const binding = { provider: 'codex', nativeId: NATIVE_ID, conductorId: 'fixture-conductor', repoKey: 'fixture-repo', workspace: path.resolve(dir), endpoint: null, channelId: 'fixture-channel', generation: 1 };
  const channel = { topic: MARKER, parentId: CONFIG.codexCategoryId };
  const guild = { channels: { fetch: async () => channel } };
  const logins = [];

  class FakeClient {
    constructor() {
      constructed += 1;
      this.guilds = { fetch: async () => guild };
    }
    async login(token) {
      logins.push(token);
      if (loginError) throw loginError;
    }
    destroy() {
      events.push('destroy');
      if (destroy === 'throw') throw cleanupError;
      return destroy === 'reject' ? Promise.reject(cleanupError) : Promise.resolve();
    }
  }

  const live = () => {
    if (closed) throw new Error('state used after close');
  };
  const state = {
    requireConfig() {
      live();
      if (configError) throw configError;
      return CONFIG;
    },
    findConductorBinding() {
      live();
      return binding;
    },
    getBinding() {
      live();
      return binding;
    },
    close() {
      events.push('close');
      if (closed) throw new Error('state closed twice');
      closed = true;
    }
  };

  const discordMock = {
    requireInstalled: () => ({ Client: FakeClient, GatewayIntentBits: { Guilds: 1 } }),
    readSecret: file => {
      assert.equal(file, CONFIG.secretFile);
      return 'fixture-token';
    }
  };
  const previousDiscord = require.cache[DISCORD_PATH];
  const previousProvision = require.cache[PROVISION_PATH];
  let error;
  try {
    require.cache[DISCORD_PATH] = { id: DISCORD_PATH, filename: DISCORD_PATH, loaded: true, exports: discordMock };
    delete require.cache[PROVISION_PATH];
    const { createProvisionCommands } = require('../src/cli/provision-commands');
    const { provisionInternal } = createProvisionCommands({
      required(args, key) {
        if (!args[key]) throw new Error(`missing --${key}`);
        return args[key];
      },
      openState: () => ({ state }),
      pathsFor: () => { throw new Error('pathsFor must not run'); },
      print: value => printed.push(value),
      cliPath: 'fixture-cli'
    });
    try {
      await provisionInternal({ provider: 'codex', 'native-id': NATIVE_ID, 'conductor-id': 'fixture-conductor', 'repo-key': 'fixture-repo', workspace: dir });
    } catch (caught) {
      error = caught;
    }
  } finally {
    if (previousDiscord) require.cache[DISCORD_PATH] = previousDiscord;
    else delete require.cache[DISCORD_PATH];
    if (previousProvision) require.cache[PROVISION_PATH] = previousProvision;
    else delete require.cache[PROVISION_PATH];
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const count = name => events.filter(event => event === name).length;
  return { error, events, printed, logins, constructed, binding, closes: count('close'), destroys: count('destroy') };
}

test('successful provisioning closes state once', async () => {
  const result = await invokeProvisionInternal({});
  assert.equal(result.error, undefined);
  assert.equal(result.closes, 1);
  assert.equal(result.destroys, 1);
  assert.deepEqual(result.events, ['destroy', 'close']);
  assert.deepEqual(result.logins, ['fixture-token']);
  assert.deepEqual(result.printed, [{
    created: false,
    adopted: false,
    legacy: false,
    migrated: false,
    bound: true,
    marker: MARKER,
    conductorId: 'fixture-conductor',
    repoKey: 'fixture-repo',
    channelId: 'fixture-channel',
    url: 'https://discord.com/channels/fixture-guild/fixture-channel',
    binding: result.binding
  }]);
});

test('configuration failure closes state without a client', async () => {
  const bodyError = new Error('configuration failed');
  const result = await invokeProvisionInternal({ configError: bodyError });
  assert.equal(result.error, bodyError);
  assert.equal(result.closes, 1);
  assert.equal(result.constructed, 0);
  assert.equal(result.destroys, 0);
  assert.deepEqual(result.printed, []);
});

test('login failure closes state after client shutdown', async () => {
  const bodyError = new Error('login failed');
  const result = await invokeProvisionInternal({ loginError: bodyError });
  assert.equal(result.error, bodyError);
  assert.equal(result.closes, 1);
  assert.equal(result.destroys, 1);
  assert.deepEqual(result.events, ['destroy', 'close']);
});

test('rejected shutdown still closes command state', { todo: 'issue201: shutdown rejection skips state.close' }, async () => {
  const cleanupError = new Error('shutdown rejected');
  const result = await invokeProvisionInternal({ destroy: 'reject' }, cleanupError);
  assert.equal(result.closes, 1);
  assert.equal(result.destroys, 1);
  assert.equal(result.error, cleanupError);
});

test('command failure survives rejected shutdown', { todo: 'issue201: shutdown masks primary failure' }, async () => {
  const bodyError = new Error('login failed');
  const cleanupError = new Error('shutdown rejected');
  const result = await invokeProvisionInternal({ loginError: bodyError, destroy: 'reject' }, cleanupError);
  assert.equal(result.error, bodyError);
  assert.equal(result.closes, 1);
  assert.equal(result.destroys, 1);
});

test('throwing shutdown still closes command state', { todo: 'issue201: synchronous shutdown skips state.close' }, async () => {
  const cleanupError = new Error('shutdown threw');
  const result = await invokeProvisionInternal({ destroy: 'throw' }, cleanupError);
  assert.equal(result.closes, 1);
  assert.equal(result.destroys, 1);
  assert.equal(result.error, cleanupError);
});
