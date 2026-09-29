'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { PermissionFlagsBits } = require('discord.js');

const { SurfaceState } = require('../src/state');
const { DiscordGateway } = require('../src/discord');
const {
  ADOPTION_REFUSAL_DETAILS,
  AdoptionRefusalError,
  readAdoptionCutoff
} = require('../src/discord/history-access');
const {
  NATIVE_PROOF_PHASES,
  nativeProofDeadlineDetail
} = require('../src/discord/native-proof-recovery');
const { enrollPublicThread } = require('../src/discord/thread-enrollment');
const { fixture } = require('./helpers/intake-recovery-fixture');

const WINDOW = { ViewChannel: PermissionFlagsBits.ViewChannel, ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory };

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeState(dir) {
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  return state;
}

function grant(allowed = true) {
  return { has: () => allowed };
}

function adoptionChannel(id = 'chan', overrides = {}) {
  return {
    id,
    permissionsFor: () => grant(true),
    messages: { async fetch() { return new Map(); } },
    ...overrides
  };
}

async function refusalFrom(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('operation did not refuse');
}

async function withFakeDiscord(fake, run) {
  const originalLoad = Module._load;
  const discordPath = require.resolve('discord.js');
  const cached = require.cache[discordPath];
  const originalExports = cached?.exports;
  Module._load = (request, parent, isMain) => request === 'discord.js' ? fake : originalLoad(request, parent, isMain);
  if (cached) cached.exports = fake;
  try {
    return await run();
  } finally {
    Module._load = originalLoad;
    if (cached) cached.exports = originalExports;
  }
}

function fakeDiscordClient(channel, { user = { id: 'bot' } } = {}) {
  return class FakeClient {
    constructor() {
      this.user = user;
      this.guilds = {
        fetch: async () => ({
          channels: {
            fetch: async selection => selection ? channel : new Map([[channel.id, channel]])
          }
        })
      };
    }
    async listen() {}
    async login() {}
    async destroy() {}
  };
}

// ---------------------------------------------------------------------------
// Cases 1-9: the shared permission-qualified reader.
// ---------------------------------------------------------------------------

test('qualified adoption rejects a missing history reader', { timeout: 8000 }, async () => {
  const error = await refusalFrom(() => readAdoptionCutoff(
    { id: 'chan', permissionsFor: () => grant(true) }, 'chan', {}
  ));
  assert.ok(error instanceof AdoptionRefusalError);
  assert.equal(error.detail, ADOPTION_REFUSAL_DETAILS.READER);
});

test('qualified adoption rejects unknown history permissions', { timeout: 8000 }, async () => {
  const error = await refusalFrom(() => readAdoptionCutoff(
    { id: 'chan', permissionsFor: () => null, messages: { async fetch() {} } }, 'chan', {}
  ));
  assert.ok(error instanceof AdoptionRefusalError);
  assert.equal(error.detail, ADOPTION_REFUSAL_DETAILS.UNKNOWN_PERMISSION);
});

test('qualified adoption rejects denied history permissions', { timeout: 8000 }, async () => {
  const error = await refusalFrom(() => readAdoptionCutoff(
    { id: 'chan', permissionsFor: () => grant(false), messages: { async fetch() { return new Map(); } } }, 'chan', {}
  ));
  assert.ok(error instanceof AdoptionRefusalError);
  assert.equal(error.detail, ADOPTION_REFUSAL_DETAILS.DENIED_PERMISSION);
});

test('qualified adoption rejects an unknown history collection', { timeout: 8000 }, async () => {
  for (const result of [null, undefined, 7, { values: 3 }]) {
    const error = await refusalFrom(() => readAdoptionCutoff(
      adoptionChannel('chan', { messages: { async fetch() { return result; } } }), 'chan', {}
    ));
    assert.ok(error instanceof AdoptionRefusalError, `collection ${JSON.stringify(result)} must refuse`);
    assert.equal(error.detail, ADOPTION_REFUSAL_DETAILS.COLLECTION);
  }
});

test('qualified adoption rejects a malformed message id', { timeout: 8000 }, async () => {
  for (const id of ['not-decimal', '12a', '']) {
    const error = await refusalFrom(() => readAdoptionCutoff(
      adoptionChannel('chan', { messages: { async fetch() { return new Map([[id, { id }]]); } } }), 'chan', {}
    ));
    assert.ok(error instanceof AdoptionRefusalError, `id ${JSON.stringify(id)} must refuse`);
    assert.equal(error.detail, ADOPTION_REFUSAL_DETAILS.MESSAGE_ID);
  }
});

test('qualified adoption rejects a mismatched channel identity', { timeout: 8000 }, async () => {
  const error = await refusalFrom(() => readAdoptionCutoff(
    adoptionChannel('other'), 'chan', {}
  ));
  assert.ok(error instanceof AdoptionRefusalError);
  assert.equal(error.detail, ADOPTION_REFUSAL_DETAILS.CHANNEL);
});

test('qualified adoption accepts a successful empty history collection as zero', { timeout: 8000 }, async () => {
  const cutoff = await readAdoptionCutoff(adoptionChannel('chan'), 'chan', {});
  assert.equal(cutoff, '0');
});

test('qualified adoption selects the newest qualified decimal history id', { timeout: 8000 }, async () => {
  const cutoff = await readAdoptionCutoff(
    adoptionChannel('chan', {
      messages: { async fetch() { return new Map([['102', { id: '102' }], ['205', { id: '205' }], ['100', { id: '100' }]]); } }
    }),
    'chan', {}
  );
  assert.equal(cutoff, '205');
  // BigInt order, never insertion order: a lexically smaller-but-newer id wins.
  const bigintOrder = await readAdoptionCutoff(
    adoptionChannel('chan', {
      messages: { async fetch() { return [{ id: '99' }, { id: '100' }]; } }
    }),
    'chan', {}
  );
  assert.equal(bigintOrder, '100');
});

test('qualified adoption rejects cancellation after history fetch', { timeout: 8000 }, async () => {
  const controller = new AbortController();
  let fetched = 0;
  const error = await refusalFrom(() => readAdoptionCutoff(
    adoptionChannel('chan', {
      messages: {
        async fetch() {
          fetched += 1;
          controller.abort();
          return new Map([['205', { id: '205' }]]);
        }
      }
    }),
    'chan', {}, controller.signal
  ));
  assert.equal(fetched, 1, 'cancellation must be observed after the awaited fetch, before commit');
  assert.ok(error instanceof AdoptionRefusalError);
  assert.equal(error.detail, ADOPTION_REFUSAL_DETAILS.STOPPED);
});

// ---------------------------------------------------------------------------
// Cases 10-14: the five public creation owners acquire before activation.
// ---------------------------------------------------------------------------

test('generic bind acquires qualified history before activation', { timeout: 8000 }, async () => {
  const dir = tempDir('qualified-bind-');
  fs.writeFileSync(path.join(dir, 'discord.env'), 'DISCORD_TOKEN=fixture\n', { mode: 0o600 });
  const db = path.join(dir, 'surface.sqlite');
  let fetchSeen = false;
  let bindSawAcquisition = false;
  const channel = {
    id: '500', guildId: 'guild', name: 'parent', isTextBased: () => true,
    permissionsFor: () => grant(true),
    messages: { async fetch() { fetchSeen = true; return new Map([['700', { id: '700' }]]); } }
  };
  const fake = {
    GatewayIntentBits: { Guilds: 1 },
    PermissionFlagsBits,
    Client: fakeDiscordClient(channel)
  };
  const realBind = SurfaceState.prototype.bind;
  SurfaceState.prototype.bind = function (binding, options = {}) {
    if (fetchSeen) bindSawAcquisition = true;
    return realBind.call(this, binding, options);
  };
  try {
    await withFakeDiscord(fake, async () => {
      const { main } = require('../src/cli');
      process.env.DISCORD_SURFACE_PROVISION_LOCK_HELD = '1';
      const argv = process.argv;
      try {
        process.argv = ['node', 'cli.js', 'configure', '--state-dir', dir, '--operator-id', 'operator',
          '--guild-id', 'guild', '--secret-file', path.join(dir, 'discord.env')];
        await main();
        process.argv = ['node', 'cli.js', 'bind', '--state-dir', dir, '--channel-id', '500', '--guild-id', 'guild',
          '--provider', 'codex', '--native-id', '11111111-1111-4111-8111-111111111111', '--workspace', dir,
          '--conductor-id', 'conductor', '--repo-key', 'repo:fixture'];
        await main();
      } finally {
        process.argv = argv;
        delete process.env.DISCORD_SURFACE_PROVISION_LOCK_HELD;
      }
    });
  } finally {
    SurfaceState.prototype.bind = realBind;
  }
  const state = new SurfaceState(db);
  try {
    assert.equal(bindSawAcquisition, true, 'history acquisition must complete before the activation commit');
    const binding = state.getBinding('500');
    assert.equal(binding.active, true);
    assert.equal(state.getIntakeWatermark('500').recovered_through_id, '700');
  } finally {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generic bind rejects an existing channel before Discord adoption I/O', { timeout: 8000 }, async t => {
  const dir = tempDir('qualified-bind-conflict-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'discord.env'), 'DISCORD_TOKEN=fixture\n', { mode: 0o600 });
  const state = makeState(dir);
  state.bind({
    channelId: '500', guildId: 'guild', provider: 'codex',
    nativeId: '11111111-1111-4111-8111-111111111111', workspace: dir,
    conductorId: 'conductor', repoKey: 'repo:fixture'
  }, { intakeCutoff: '100' });
  state.close();

  let clientConstructions = 0;
  const fake = {
    GatewayIntentBits: { Guilds: 1 },
    Client: class FakeClient {
      constructor() {
        clientConstructions += 1;
        throw new Error('Discord adoption I/O should not start for a local conflict');
      }
    }
  };
  await withFakeDiscord(fake, async () => {
    const { main } = require('../src/cli');
    const argv = process.argv;
    try {
      process.argv = ['node', 'cli.js', 'bind', '--state-dir', dir, '--channel-id', '500', '--guild-id', 'guild',
        '--provider', 'codex', '--native-id', '22222222-2222-4222-8222-222222222222', '--workspace', dir,
        '--conductor-id', 'replacement', '--repo-key', 'repo:replacement'];
      await assert.rejects(() => main(), /channel is already bound/);
    } finally {
      process.argv = argv;
    }
  });
  assert.equal(clientConstructions, 0);
});

test('ordinary Codex CLI preserves its qualified server fence', { timeout: 8000 }, async () => {
  const dir = tempDir('qualified-fence-');
  const db = path.join(dir, 'surface.sqlite');
  const state = makeState(dir);
  state.close();
  const codex = '9caa5d21-2169-429d-918b-5f08651b5dbd';
  let fences = 0;
  let historyReads = 0;
  const channel = {
    id: '500', guildId: 'guild', name: 'dev', isTextBased: () => true,
    permissionsFor: () => grant(true),
    async send() { fences += 1; return { id: '900000000000000001', async delete() {} }; },
    messages: { async fetch() { historyReads += 1; return new Map(); } }
  };
  const { ordinaryBind } = require('../src/cli');
  const result = await ordinaryBind({ 'state-dir': dir, channel: '#dev', workspace: dir }, {
    environment: { CODEX_SESSION_ID: codex, CODEX_THREAD_ID: codex, PWD: dir },
    requireInstalled: () => ({ Client: fakeDiscordClient(channel), GatewayIntentBits: { Guilds: 1 }, PermissionFlagsBits }),
    readSecret: () => 'fixture-token',
    validateCodexSessionIdentity: () => ({ file: path.join(dir, 'session.jsonl'), sessionId: codex, threadId: codex, workspace: dir }),
    codexSessionRoot: () => path.join(dir, 'sessions'),
    gatewayProcessStatus: () => ({ state: 'stopped' }),
    print: () => {}
  });
  const reopened = new SurfaceState(db);
  try {
    assert.equal(result.binding.active, true);
    assert.equal(fences, 1, 'the server fence is the coverage producer');
    assert.equal(historyReads, 0, 'the fence path must not add a second Discord read');
    assert.equal(reopened.getIntakeWatermark('500').recovered_through_id, '900000000000000001');
  } finally {
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('provision acquires qualified history before activation', { timeout: 8000 }, async () => {
  const dir = tempDir('qualified-provision-');
  fs.writeFileSync(path.join(dir, 'discord.env'), 'DISCORD_TOKEN=fixture\n', { mode: 0o600 });
  const db = path.join(dir, 'surface.sqlite');
  let fetchSeen = false;
  let bindSawAcquisition = false;
  const channel = {
    id: '900', guildId: 'guild', name: 'task', parentId: 'category', topic: null, isTextBased: () => true,
    permissionsFor: () => grant(true),
    async setTopic(value) { this.topic = value; },
    messages: { async fetch() { fetchSeen = true; return new Map([['800', { id: '800' }]]); } }
  };
  const category = { id: 'category', guildId: 'guild', name: 'category', type: 4 };
  const guild = {
    channels: {
      cache: { values: () => [][Symbol.iterator]() },
      fetch: async id => id ? (id === category.id ? category : channel) : undefined,
      create: async () => channel
    }
  };
  const fake = {
    GatewayIntentBits: { Guilds: 1 },
    PermissionFlagsBits,
    ChannelType: { GuildText: 0, GuildCategory: 4, GuildVoice: 2, GuildStageVoice: 13 },
    Client: class {
      constructor() { this.user = { id: 'bot' }; this.guilds = { fetch: async () => guild }; }
      async login() {}
      async destroy() {}
    }
  };
  const realBind = SurfaceState.prototype.bind;
  SurfaceState.prototype.bind = function (binding, options = {}) {
    if (fetchSeen) bindSawAcquisition = true;
    return realBind.call(this, binding, options);
  };
  try {
    await withFakeDiscord(fake, async () => {
      const { main } = require('../src/cli');
      const argv = process.argv;
      try {
        process.argv = ['node', 'cli.js', 'configure', '--state-dir', dir, '--operator-id', 'operator',
          '--guild-id', 'guild', '--secret-file', path.join(dir, 'discord.env')];
        await main();
        process.env.DISCORD_SURFACE_PROVISION_LOCK_HELD = '1';
        process.argv = ['node', 'cli.js', 'provision-run', '--state-dir', dir, '--provider', 'codex',
          '--native-id', '11111111-1111-4111-8111-111111111111', '--conductor-id', 'conductor',
          '--repo-key', 'repo:fixture', '--workspace', dir, '--category-id', 'category'];
        await main();
      } finally {
        process.argv = argv;
        delete process.env.DISCORD_SURFACE_PROVISION_LOCK_HELD;
      }
    });
  } finally {
    SurfaceState.prototype.bind = realBind;
  }
  const state = new SurfaceState(db);
  try {
    assert.equal(bindSawAcquisition, true, 'provision must acquire its boundary before inserting the binding');
    assert.equal(state.getBinding('900').active, true);
    assert.equal(state.getIntakeWatermark('900').recovered_through_id, '800');
  } finally {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exported ordinary Codex bind acquires qualified history before activation', { timeout: 8000 }, async () => {
  const dir = tempDir('qualified-ordinary-');
  const db = path.join(dir, 'surface.sqlite');
  const state = makeState(dir);
  state.close();
  const codex = '9caa5d21-2169-429d-918b-5f08651b5dbd';
  let fetchSeen = false;
  let bindSawAcquisition = false;
  const channel = {
    id: '500', guildId: 'guild', name: 'dev', isTextBased: () => true,
    permissionsFor: () => grant(true),
    messages: { async fetch() { fetchSeen = true; return new Map([['700', { id: '700' }]]); } }
  };
  const realBind = SurfaceState.prototype.bind;
  SurfaceState.prototype.bind = function (binding, options = {}) {
    if (fetchSeen) bindSawAcquisition = true;
    return realBind.call(this, binding, options);
  };
  const { ordinaryBind } = require('../src/ordinary-bind');
  try {
    const result = await ordinaryBind({ 'state-dir': dir, channel: '#dev', workspace: dir }, {
      environment: { CODEX_SESSION_ID: codex, CODEX_THREAD_ID: codex, PWD: dir },
      requireInstalled: () => ({ Client: fakeDiscordClient(channel), GatewayIntentBits: { Guilds: 1 }, PermissionFlagsBits }),
      readSecret: () => 'fixture-token',
      validateCodexSessionIdentity: () => ({ file: path.join(dir, 'session.jsonl'), sessionId: codex, threadId: codex, workspace: dir }),
      codexSessionRoot: () => path.join(dir, 'sessions'),
      gatewayProcessStatus: () => ({ state: 'stopped' }),
      print: () => {}
    });
    assert.equal(bindSawAcquisition, true, 'exported ordinary bind must acquire before activation');
    assert.equal(result.binding.active, true);
    const reopened = new SurfaceState(db);
    try {
      assert.equal(reopened.getIntakeWatermark('500').recovered_through_id, '700');
    } finally {
      reopened.close();
    }
  } finally {
    SurfaceState.prototype.bind = realBind;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ordinary Claude bind acquires qualified history before activation', { timeout: 8000 }, async () => {
  const dir = tempDir('qualified-claude-');
  const db = path.join(dir, 'surface.sqlite');
  const state = makeState(dir);
  state.close();
  const claude = '79e3da8e-94b4-4aff-8f88-b45b3a451dd1';
  const transcriptRoot = tempDir('qualified-claude-transcript-');
  const transcript = path.join(transcriptRoot, 'session.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({
    type: 'attachment', sessionId: claude, entrypoint: 'cli', version: '1.0.0', cwd: dir
  })}\n`);
  let fetchSeen = false;
  let bindSawAcquisition = false;
  const channel = {
    id: '600', guildId: 'guild', name: 'dev', isTextBased: () => true,
    permissionsFor: () => grant(true),
    messages: { async fetch() { fetchSeen = true; return new Map([['750', { id: '750' }]]); } }
  };
  const realBind = SurfaceState.prototype.bind;
  SurfaceState.prototype.bind = function (binding, options = {}) {
    if (fetchSeen) bindSawAcquisition = true;
    return realBind.call(this, binding, options);
  };
  const { ordinaryClaudeBind } = require('../src/cli');
  try {
    const result = await ordinaryClaudeBind(
      { 'state-dir': dir, channel: '#dev', transcript, socket: path.join(dir, 'claude.sock') },
      {
        resolveClaudeCaller: () => ({ sessionId: claude, harness: 'claude-code', caller: { pid: 1, processStartTime: 2 } }),
        requireInstalled: () => ({ Client: fakeDiscordClient(channel), GatewayIntentBits: { Guilds: 1 }, PermissionFlagsBits }),
        readSecret: () => 'fixture-token',
        gatewayProcessStatus: () => ({ state: 'stopped' }),
        print: () => {}
      }
    );
    assert.equal(bindSawAcquisition, true, 'ordinary Claude bind must acquire before activation');
    assert.equal(result.binding.active, true);
    const reopened = new SurfaceState(db);
    try {
      assert.equal(reopened.getIntakeWatermark('600').recovered_through_id, '750');
    } finally {
      reopened.close();
    }
  } finally {
    SurfaceState.prototype.bind = realBind;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(transcriptRoot, { recursive: true, force: true });
  }
});

test('active parent reuse preserves coverage without another history read', { timeout: 8000 }, async () => {
  const dir = tempDir('qualified-reuse-');
  const db = path.join(dir, 'surface.sqlite');
  const state = makeState(dir);
  state.close();
  const codex = '9caa5d21-2169-429d-918b-5f08651b5dbd';
  let reads = 0;
  const channel = {
    id: '500', guildId: 'guild', name: 'dev', isTextBased: () => true,
    permissionsFor: () => grant(true),
    messages: { async fetch() { reads += 1; return new Map([['700', { id: '700' }]]); } }
  };
  const dependencies = {
    environment: { CODEX_SESSION_ID: codex, CODEX_THREAD_ID: codex, PWD: dir },
    requireInstalled: () => ({ Client: fakeDiscordClient(channel), GatewayIntentBits: { Guilds: 1 }, PermissionFlagsBits }),
    readSecret: () => 'fixture-token',
    validateCodexSessionIdentity: () => ({ file: path.join(dir, 'session.jsonl'), sessionId: codex, threadId: codex, workspace: dir }),
    codexSessionRoot: () => path.join(dir, 'sessions'),
    gatewayProcessStatus: () => ({ state: 'stopped' }),
    print: () => {}
  };
  const { ordinaryBind } = require('../src/ordinary-bind');
  try {
    const first = await ordinaryBind({ 'state-dir': dir, channel: '#dev', workspace: dir }, dependencies);
    assert.equal(first.binding.active, true);
    const afterFirst = reads;
    const watermarkBefore = new SurfaceState(db);
    const cutoffBefore = watermarkBefore.getIntakeWatermark('500').recovered_through_id;
    watermarkBefore.close();
    const second = await ordinaryBind({ 'state-dir': dir, channel: '#dev', workspace: dir }, dependencies);
    assert.equal(second.reused, true);
    assert.equal(reads, afterFirst, 'active reuse must not perform another history read');
    const reopened = new SurfaceState(db);
    try {
      assert.equal(reopened.getIntakeWatermark('500').recovered_through_id, cutoffBefore);
      assert.equal(cutoffBefore, '700');
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parent recovery dispatches accepted A and offline B once while excluding H', { timeout: 8000 }, async t => {
  const f = fixture(t);
  const binding = f.state.getBinding('1000');
  const H = f.message('100', '1000');
  const A = f.message('101', '1000');
  const offlineB = f.message('102', '1000');
  f.history.set('1000', [H, A]);
  const accepted = f.state.acceptDiscordMessage(
    { ...A, authorId: 'operator', isBot: false, attachments: [] },
    { ready: false, expectedBinding: binding }
  );
  assert.equal(accepted.accepted, true, 'accepted A must enter custody before the failure');
  f.fail({ id: '1000', kind: 'history', status: 503 });
  await f.recover();
  assert.equal(f.boundary('1000').state, 'unavailable');
  assert.equal(f.cursor('1000'), '100');
  f.history.set('1000', [offlineB, A, H]);
  f.fail(null);
  f.enableDelivery();
  await f.recover();
  assert.equal(f.boundary('1000').state, 'ready');
  assert.equal(f.cursor('1000'), '102');
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  await f.gateway.reconcilePending(undefined, { readyOnly: true });
  await f.gateway.consumer.waitForNativeWork();
  const ids = f.dispatched.map(message => message.id).sort();
  assert.deepEqual(ids, ['101', '102'], 'accepted A and offline B dispatch exactly once');
  assert.equal(f.state.getMessage('100'), null, 'historical H must stay excluded');
  assert.equal(f.state.getMessage('101').state, 'replied');
  assert.equal(f.state.getMessage('102').state, 'replied');
});

// ---------------------------------------------------------------------------
// Cases 17-20: parent persistence.
// ---------------------------------------------------------------------------

test('fresh parent state activation refuses omitted adoption coverage', { timeout: 8000 }, async () => {
  const dir = tempDir('qualified-parent-refuse-');
  const state = makeState(dir);
  try {
    const error = await refusalFrom(() => state.bind({
      channelId: '1000', guildId: 'guild', provider: 'codex',
      nativeId: '11111111-1111-4111-8111-111111111111', workspace: dir
    }));
    assert.equal(error.detail, ADOPTION_REFUSAL_DETAILS.PARENT_CUTOFF);
    assert.match(error.message, /explicit decimal adoption cutoff/);
    assert.equal(state.getBinding('1000'), null, 'no activation row may exist without its boundary');
    assert.equal(state.getIntakeWatermark('1000'), null, 'no watermark may exist without activation');
    for (const malformed of [null, '', '12a', 'abc', 0]) {
      const malformedError = await refusalFrom(() => state.bind({
        channelId: `chan-${String(malformed)}`, guildId: 'guild', provider: 'codex',
        nativeId: '22222222-2222-4222-8222-222222222222', workspace: dir
      }, { intakeCutoff: malformed }));
      assert.equal(malformedError.detail, ADOPTION_REFUSAL_DETAILS.PARENT_CUTOFF);
    }
  } finally {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh parent state activation commits zero and activation atomically', { timeout: 8000 }, async () => {
  const dir = tempDir('qualified-parent-zero-');
  const state = makeState(dir);
  try {
    const binding = state.bind({
      channelId: '1000', guildId: 'guild', provider: 'codex',
      nativeId: '11111111-1111-4111-8111-111111111111', workspace: dir
    }, { intakeCutoff: '0' });
    assert.equal(binding.active, true);
    const watermark = state.getIntakeWatermark('1000');
    assert.equal(watermark.recovered_through_id, '0');
    assert.equal(watermark.last_seen_id, '0');
    assert.equal(watermark.state, 'pending');
  } finally {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed parent activation transaction leaves neither activation nor coverage', { timeout: 8000 }, async () => {
  const dir = tempDir('qualified-parent-rollback-');
  const state = makeState(dir);
  try {
    await refusalFrom(() => state.bind({
      channelId: '1000', guildId: 'guild', provider: 'codex',
      nativeId: '11111111-1111-4111-8111-111111111111', workspace: dir
    }, {
      intakeCutoff: '0',
      beforeMutation() { throw new Error('injected activation transaction failure'); }
    }));
    assert.equal(state.getBinding('1000'), null, 'a failed commit must roll back activation');
    assert.equal(state.getIntakeWatermark('1000'), null, 'a failed commit must roll back coverage');
  } finally {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parent owner change during history acquisition refuses activation', { timeout: 8000 }, async () => {
  const dir = tempDir('qualified-parent-owner-');
  const state = makeState(dir);
  const nativeId = '11111111-1111-4111-8111-111111111111';
  const original = state.assertNativeOwnerFree.bind(state);
  let injected = false;
  state.assertNativeOwnerFree = (provider, candidateNativeId, exclude) => {
    const result = original(provider, candidateNativeId, exclude);
    if (!injected) {
      injected = true;
      // A competing owner wins between the acquisition check and the commit.
      state.db.prepare(`INSERT INTO bindings(channel_id, guild_id, provider, native_id, workspace, session_root,
        endpoint, category_id, conductor_id, repo_key, readiness, generation, active, updated_at)
        VALUES(?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, 1, ?)`).run(
        'other-owner', 'guild', provider, nativeId, '/tmp', 'pending', 1, new Date().toISOString());
    }
    return result;
  };
  try {
    const error = await refusalFrom(() => state.bind({
      channelId: '1000', guildId: 'guild', provider: 'codex', nativeId, workspace: dir
    }, { intakeCutoff: '100' }));
    assert.match(error.message, /already owned|another channel/i);
    assert.equal(state.getBinding('1000'), null, 'a lost owner race must not activate the route');
    assert.equal(state.getIntakeWatermark('1000'), null);
  } finally {
    state.assertNativeOwnerFree = original;
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cases 21-26: child persistence.
// ---------------------------------------------------------------------------

function enrolledChild(f, { id = '3000', newest = '205' } = {}) {
  let reads = 0;
  const child = {
    ...f.channels.get('2000'),
    id,
    permissionsFor: () => grant(true),
    messages: {
      async fetch(input) {
        if (typeof input === 'string') return { async react() {} };
        reads += 1;
        return new Map([[newest, { id: newest }]]);
      }
    }
  };
  f.channels.set(id, child);
  return () => reads;
}

test('active child reuse preserves coverage without another history read', { timeout: 8000 }, async t => {
  const f = fixture(t);
  const reads = enrolledChild(f);
  const first = await enrollPublicThread(f.state, f.gateway.client, '1000', '3000');
  assert.equal(first.active, true);
  assert.equal(first.recoveredThroughId, '205');
  const afterFirst = reads();
  const second = await enrollPublicThread(f.state, f.gateway.client, '1000', '3000');
  assert.equal(second.active, true);
  assert.equal(second.recoveredThroughId, '205');
  assert.equal(reads(), afterFirst, 'active child reuse must not read history again');
  f.state.bind({ channelId: '9999', guildId: 'guild', provider: 'codex',
    nativeId: '99999999-9999-4999-8999-999999999999', workspace: f.state.getBinding('1000').workspace },
  { intakeCutoff: '0' });
  f.channels.set('9999', {
    ...f.channels.get('1000'),
    parentId: '2000',
    messages: { async fetch() { return new Map(); } }
  });
  const before = f.state.getThreadEnrollment('3000');
  const foreign = await refusalFrom(() => enrollPublicThread(f.state, f.gateway.client, '9999', '3000'));
  assert.ok(foreign, 'foreign parent reuse must refuse');
  assert.deepEqual(f.state.getThreadEnrollment('3000'), before);
  assert.equal(reads(), afterFirst);
  const enroll = f.state.enrollThread.bind(f.state);
  for (const [column, value] of [['generation', 99], ['guild_id', 'foreign-guild']]) {
    const binding = f.state.getBinding('1000');
    let reached = false;
    f.state.enrollThread = (input, expected) => {
      reached = true;
      f.state.db.prepare(`UPDATE bindings SET ${column}=? WHERE channel_id=?`).run(value, '1000');
      return enroll(input, expected);
    };
    try {
      await refusalFrom(() => enrollPublicThread(f.state, f.gateway.client, '1000', '3000'));
      assert.equal(reached, true, `${column} change must reach the enrollment transaction`);
      assert.deepEqual(f.state.getThreadEnrollment('3000'), before);
      assert.equal(reads(), afterFirst);
    } finally {
      f.state.enrollThread = enroll;
      f.state.db.prepare('UPDATE bindings SET generation=?, guild_id=? WHERE channel_id=?')
        .run(binding.generation, binding.guildId, '1000');
    }
  }
});

test('child parent generation change after acquisition refuses activation', { timeout: 8000 }, async t => {
  const f = fixture(t);
  enrolledChild(f);
  const realFetch = f.gateway.client.channels.fetch.bind(f.gateway.client.channels);
  let bumped = false;
  f.gateway.client.channels.fetch = async id => {
    const value = await realFetch(id);
    if (id === '3000' && !bumped) {
      bumped = true;
      f.state.db.prepare('UPDATE bindings SET generation=generation+1 WHERE channel_id=?').run('1000');
    }
    return value;
  };
  const error = await refusalFrom(() => enrollPublicThread(f.state, f.gateway.client, '1000', '3000'));
  assert.ok(error);
  assert.equal(f.state.getThreadEnrollment('3000'), null, 'a changed parent generation must leave no child row');
});

test('concurrent active child winner retains its own adoption cutoff', { timeout: 8000 }, async t => {
  const f = fixture(t);
  const parent = f.state.getBinding('1000');
  const winner = f.state.enrollThread(
    { threadId: '3000', parentChannelId: '1000', guildId: 'guild', adoptionCutoff: '111' }, parent);
  assert.equal(winner.recoveredThroughId, '111');
  // The losing snapshot reaches persistence after the winner already committed.
  const loser = f.state.enrollThread(
    { threadId: '3000', parentChannelId: '1000', guildId: 'guild', adoptionCutoff: '222' }, parent);
  assert.equal(loser.recoveredThroughId, '111', 'the concurrent active winner keeps its own snapshot');
  assert.equal(loser.active, true);
  assert.equal(f.state.getThreadEnrollment('3000').recoveredThroughId, '111');
});

test('inactive child reactivation requires a new qualified adoption cutoff', { timeout: 8000 }, async t => {
  const f = fixture(t);
  const reads = enrolledChild(f);
  const parent = f.state.getBinding('1000');
  const created = f.state.enrollThread(
    { threadId: '3000', parentChannelId: '1000', guildId: 'guild', adoptionCutoff: '111' }, parent);
  assert.equal(created.recoveredThroughId, '111');
  f.state.db.prepare("UPDATE thread_enrollments SET active=0, state='unavailable' WHERE thread_id='3000'").run();
  const error = await refusalFrom(() => f.state.enrollThread(
    { threadId: '3000', parentChannelId: '1000', guildId: 'guild' }, parent));
  assert.equal(error.detail, ADOPTION_REFUSAL_DETAILS.CHILD_CUTOFF);
  const held = f.state.getThreadEnrollment('3000');
  assert.equal(held.active, false, 'no-cutoff reuse must not reactivate the route');
  assert.equal(held.recoveredThroughId, '111');
  // A route that becomes inactive after the active-reuse check passes must refuse,
  // not silently reactivate through the public helper. Flip the row inactive in the
  // window immediately before the shared enrollment transaction commits.
  const f2 = fixture(t);
  const reads2 = enrolledChild(f2);
  await enrollPublicThread(f2.state, f2.gateway.client, '1000', '3000');
  const realEnroll = f2.state.enrollThread.bind(f2.state);
  let flipped = false;
  f2.state.enrollThread = (input, binding) => {
    if (!flipped) {
      flipped = true;
      f2.state.db.prepare("UPDATE thread_enrollments SET active=0, state='unavailable' WHERE thread_id='3000'").run();
    }
    return realEnroll(input, binding);
  };
  const publicError = await refusalFrom(() => enrollPublicThread(f2.state, f2.gateway.client, '1000', '3000'));
  assert.ok(publicError, 'a route going inactive during no-cutoff reuse must refuse');
  assert.equal(flipped, true, 'active reuse must reach the shared enrollment transaction');
  assert.equal(f2.state.getThreadEnrollment('3000').active, false);
  assert.equal(reads2(), 1, 'active reuse still performs no history read when it later refuses');
});

test('cancelled child acquisition leaves the route inactive and parent unchanged', { timeout: 8000 }, async t => {
  const f = fixture(t);
  enrolledChild(f);
  const parentBefore = f.state.getBinding('1000');
  const controller = new AbortController();
  controller.abort();
  await refusalFrom(() => enrollPublicThread(f.state, f.gateway.client, '1000', '3000', controller.signal));
  assert.equal(f.state.getThreadEnrollment('3000'), null);
  assert.deepEqual(f.state.getBinding('1000'), parentBefore);
});

test('failed child activation transaction leaves neither activation nor coverage', { timeout: 8000 }, async t => {
  const f = fixture(t);
  enrolledChild(f);
  const parentBefore = f.state.getBinding('1000');
  const realReceipt = f.state.receipt.bind(f.state);
  f.state.receipt = (discordId, kind, detail) => {
    if (kind === 'thread-enrolled') throw new Error('injected child transaction failure');
    return realReceipt(discordId, kind, detail);
  };
  try {
    await refusalFrom(() => enrollPublicThread(f.state, f.gateway.client, '1000', '3000'));
  } finally {
    f.state.receipt = realReceipt;
  }
  assert.equal(f.state.getThreadEnrollment('3000'), null, 'a failed child commit must roll back activation');
  assert.deepEqual(f.state.getBinding('1000'), parentBefore);
});

// ---------------------------------------------------------------------------
// Cases 27-29: legacy child tuples.
// ---------------------------------------------------------------------------

test('completed empty legacy child retains adoption provenance while qualifying zero', { timeout: 8000 }, async t => {
  const f = fixture(t);
  const before = f.state.getThreadEnrollment('2000');
  assert.ok(before.adoptedAt, 'the fixture child carries real adoption provenance');
  f.state.db.prepare(`UPDATE thread_enrollments
    SET adopted_through_id=NULL, recovered_through_id=NULL, last_seen_id='205'
    WHERE thread_id='2000'`).run();
  const baseline = f.state.setThreadBaseline('2000', '0', f.state.getBinding('1000'));
  assert.equal(baseline.recoveredThroughId, '0');
  assert.equal(baseline.adoptedAt, before.adoptedAt, 'adoption provenance must be preserved');
  assert.equal(baseline.adoptedThroughId, null);
  assert.equal(baseline.lastSeenId, '205');
});

test('nonempty legacy child without coverage remains held', { timeout: 8000 }, async t => {
  const f = fixture(t);
  const before = f.state.getThreadEnrollment('2000');
  f.state.db.prepare(`UPDATE thread_enrollments
    SET adopted_through_id='150', recovered_through_id=NULL, last_seen_id='205'
    WHERE thread_id='2000'`).run();
  await refusalFrom(() => f.state.setThreadBaseline('2000', '205', f.state.getBinding('1000')));
  const held = f.state.getThreadEnrollment('2000');
  assert.equal(held.recoveredThroughId, null, 'a nonempty adopted boundary without coverage stays held');
  assert.equal(held.adoptedThroughId, '150');
  assert.equal(held.adoptedAt, before.adoptedAt);
  assert.equal(held.lastSeenId, '205');
});

test('never-adopted historical child remains held', { timeout: 8000 }, async t => {
  const f = fixture(t);
  f.state.db.prepare(`UPDATE thread_enrollments
    SET adopted_at=NULL, adopted_through_id=NULL, recovered_through_id=NULL, last_seen_id='205'
    WHERE thread_id='2000'`).run();
  await refusalFrom(() => f.state.setThreadBaseline('2000', '205', f.state.getBinding('1000')));
  const held = f.state.getThreadEnrollment('2000');
  assert.equal(held.recoveredThroughId, null, 'a never-adopted historical tuple stays held');
  assert.equal(held.adoptedAt, null);
  assert.equal(held.adoptedThroughId, null);
  assert.equal(held.lastSeenId, '205');
});

// ---------------------------------------------------------------------------
// Cases 30-32: native-proof retry qualification.
// ---------------------------------------------------------------------------

async function nativeProofRecovery(t, { cutoff, nullCursor = false, hasMessage = true }) {
  const dir = tempDir('qualified-native-proof-');
  const root = path.join(dir, 'sessions');
  fs.mkdirSync(root);
  const nativeId = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(root, `${nativeId}.jsonl`), `${JSON.stringify({
    type: 'session_meta', payload: { id: nativeId, cwd: dir }
  })}\n`);
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'unused') });
  state.bindOrdinary({
    channelId: '1000', guildId: 'guild', provider: 'codex', nativeId, workspace: dir
  }, { sessionId: nativeId, threadId: nativeId }, cutoff);
  state.setIntakeBaseline('1000', cutoff, 'fixture baseline');
  if (hasMessage) {
    state.acceptDiscordMessage({
      id: '101', channelId: '1000', guildId: 'guild', authorId: 'operator', isBot: false, content: 'retained'
    }, { ready: false });
  }
  if (nullCursor) {
    state.db.prepare('UPDATE intake_watermarks SET recovered_through_id=NULL WHERE channel_id=?').run('1000');
  }
  state.markIntakeBoundary('1000', 'unavailable',
    nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.BEFORE_BINDING, Date.now() - 1));
  const stats = { historyReads: 0, dispatches: 0 };
  let channel;
  channel = {
    id: '1000', guildId: 'guild', topic: null, permissionsFor: () => grant(true),
    messages: { async fetch() { return { async react() {} }; } },
    async send() { return { id: 'reply-101' }; }
  };
  let gateway;
  const options = {
    state,
    client: {
      user: { id: 'bot' },
      channels: { fetch: async () => channel },
      application: { commands: { async fetch() { return []; }, async create() {} } },
      async login() {}, on() {}, off() {}, async destroy() {}
    },
    fetchHistory: async (_channel, opts) => {
      stats.historyReads += 1;
      return BigInt(opts.after || '0') < 101n
        ? [{ id: '101', channelId: '1000', guildId: 'guild', content: 'retained', author: { id: 'operator', bot: false }, channel }]
        : [];
    },
    providers: {
      codex: {
        async dispatch() { stats.dispatches += 1; return { status: 'submitted' }; },
        async observe() { return { text: 'answer' }; }
      }
    },
    recoveryOptions: {
      ordinaryNativePreflight: async () => ({ sessionId: nativeId, threadId: nativeId, workspace: dir, file: path.join(root, `${nativeId}.jsonl`) })
    }
  };
  gateway = new DiscordGateway({ ...options, state });
  t.after(async () => {
    await gateway.stop();
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { state, gateway, stats };
}

test('historical native-proof retry without a cursor cannot exclude newest history', { timeout: 8000 }, async t => {
  const { state, gateway, stats } = await nativeProofRecovery(t, { cutoff: '100', nullCursor: true });
  await gateway.recoverInbound(new AbortController().signal, 'reconnect', gateway.lifecycleEpoch, null, Date.now() - 1);
  const watermark = state.getIntakeWatermark('1000');
  assert.equal(watermark.recovered_through_id, null, 'retained newest history must never become coverage');
  assert.match(watermark.detail, /Native proof recovery v1:/, 'the typed no-cursor boundary must be preserved');
  assert.equal(stats.dispatches, 0);
  assert.equal(state.getMessage('101')?.state, 'accepted', 'retained custody must stay accepted');
  assert.equal(stats.historyReads, 0, 'a no-cursor historical parent refuses before any history request');
});

test('prospective zero native-proof retry retains zero coverage', { timeout: 8000 }, async t => {
  const { state, gateway, stats } = await nativeProofRecovery(t, { cutoff: '0' });
  await gateway.recoverInbound(new AbortController().signal, 'reconnect', gateway.lifecycleEpoch, null, Date.now() + 5000);
  const watermark = state.getIntakeWatermark('1000');
  assert.equal(watermark.recovered_through_id, '101', 'a prospective covered route resumes from its committed "0"');
  assert.equal(watermark.state, 'ready');
  assert.equal(stats.dispatches, 0);
  assert.equal(state.getMessage('101')?.state, 'accepted');
});

test('prospective covered native-proof retry retains its historical bound', { timeout: 8000 }, async t => {
  const { state, gateway, stats } = await nativeProofRecovery(t, { cutoff: '100' });
  await gateway.recoverInbound(new AbortController().signal, 'reconnect', gateway.lifecycleEpoch, null, Date.now() + 5000);
  const watermark = state.getIntakeWatermark('1000');
  assert.equal(watermark.recovered_through_id, '101', 'a covered retry advances only from its committed bound');
  assert.equal(watermark.state, 'ready');
  assert.equal(stats.dispatches, 0);
  assert.equal(state.getMessage('101')?.state, 'accepted');
});

// ---------------------------------------------------------------------------
// Case 33: adoption owner inventory pin.
// ---------------------------------------------------------------------------

const EXPECTED_CREATORS = [
  'src/cli.js|bind|state|bind',
  'src/cli.js|ordinaryBind|state|bindOrdinary',
  'src/cli.js|provisionInternal|state|bind',
  'src/discord/thread-enrollment.ts|enrollPublicThread|state|enrollThread',
  'src/ordinary-bind/index.js|ordinaryBind|state|bindOrdinary',
  'src/ordinary-bind/index.js|ordinaryClaudeBind|state|bindOrdinaryClaude',
  'src/ordinary/index.js|bindOrdinary|state|_bindOrdinary',
  'src/ordinary/index.js|bindOrdinaryClaude|state|_bindOrdinaryClaude',
  'src/state.js|bindOrdinary|this|_bindOrdinary',
  'src/state.js|bindOrdinaryClaude|this|_bindOrdinaryClaude',
  'src/state.js|_bindOrdinary|ordinaryBindingHandlers|bindOrdinary',
  'src/state.js|_bindOrdinaryClaude|this|bind',
  'src/state.js|enrollThread|threadEnrollmentHandlers|enrollThread',
  'src/state/ordinary-binding.ts|bindOrdinary|state|bind'
];

const EXPECTED_MESSAGES_FETCH = [
  'src/discord.js|constructor|channel.messages',
  'src/discord.js|projectDecisionMessage|channel?.messages',
  'src/discord.js|reactToFetchedMessage|message.channel.messages',
  'src/discord/handoff-fence.ts|assertEnrolledThreadIntakeRange|channel.messages',
  'src/discord/handoff-fence.ts|assertOrdinaryIntakeRange|channel.messages!',
  'src/discord/history-access.ts|readAdoptionCutoff|channel.messages',
  'src/discord/transport-receipts.js|issueTransportReceipt|source.channel?.messages'
];

const EXPECTED_FETCH_HISTORY = [
  'src/discord.js|checkpointHealthyIntake|this',
  'src/discord.js|recoverInbound|this',
  'src/discord/thread-enrollment.ts|readHistory|gateway'
];

// Function.prototype.bind exclusions, from the committed exclusion census.
const EXCLUDED_BINDS = new Set([
  'src/agent-attachment.ts|defaultFetch|fetchImpl',
  'src/discord/handoff-fence.ts|assertEnrolledThreadIntakeRange|client?.channels?.fetch',
  'src/state/courier-route/index.ts|createCourierRouteHandlers|claimCourierForward',
  'src/state/courier-route/index.ts|createCourierRouteHandlers|recoverCourierAttempt',
  'src/state/courier-route/index.ts|createCourierRouteHandlers|getCourierDeliveryStatus'
]);

const RECOGNIZED_BIND_RECEIVERS = new Set(['state', 'this']);

function inventoryParser() {
  return require('typescript');
}

function sourceFiles(root) {
  const found = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|ts)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) found.push(full);
    }
  };
  walk(root);
  return found;
}

function relativeSourceFiles(workspaceRoot) {
  return sourceFiles(path.join(workspaceRoot, 'src')).map(file =>
    path.relative(workspaceRoot, file).split(path.sep).join('/')).sort();
}

function ownerOf(ts, node) {
  const isFunctionLike = n => ts.isArrowFunction(n) || ts.isFunctionExpression(n);
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name) return current.name.text;
    if (ts.isConstructorDeclaration(current)) return 'constructor';
    if (ts.isPropertyAssignment(current) && current.name && current.initializer && isFunctionLike(current.initializer)) {
      return current.name.getText();
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer &&
        isFunctionLike(current.initializer)) {
      return current.name.text;
    }
    current = current.parent;
  }
  return '<module>';
}

function unwrap(ts, expression) {
  let current = expression;
  while (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function calleeInfo(ts, call) {
  const expression = unwrap(ts, call.expression);
  if (ts.isPropertyAccessExpression(expression)) {
    return { receiver: expression.expression.getText(), method: expression.name.text };
  }
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
      return { receiver: expression.expression.getText(), method: argument.text };
    }
  }
  return null;
}

function isMessagesFetch(info) {
  if (!info || info.method !== 'fetch' || !/messages/.test(info.receiver)) return false;
  return /(^|[.?!])messages!?$/.test(info.receiver.replace(/\?\./g, '.'));
}

function scanInventory(entries) {
  const ts = inventoryParser();
  const creators = [];
  const messagesFetch = [];
  const fetchHistory = [];
  const unclassifiedBinds = [];
  for (const { file, text } of entries) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
      file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const visit = node => {
      if (ts.isCallExpression(node)) {
        const info = calleeInfo(ts, node);
        if (info) {
          const owner = ownerOf(ts, node);
          if (info.method === 'bind') {
            const tuple = `${file}|${owner}|${info.receiver}`;
            if (!EXCLUDED_BINDS.has(tuple)) {
              if (!RECOGNIZED_BIND_RECEIVERS.has(info.receiver)) unclassifiedBinds.push(tuple);
              creators.push(`${tuple}|bind`);
            }
          } else if (['bindOrdinary', 'bindOrdinaryClaude', '_bindOrdinary', '_bindOrdinaryClaude', 'enrollThread'].includes(info.method)) {
            creators.push(`${file}|${owner}|${info.receiver}|${info.method}`);
          }
          if (isMessagesFetch(info)) messagesFetch.push(`${file}|${owner}|${info.receiver}`);
          if (info.method === 'fetchHistory') fetchHistory.push(`${file}|${owner}|${info.receiver}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return {
    creators: creators.slice().sort(),
    messagesFetch: messagesFetch.slice().sort(),
    fetchHistory: fetchHistory.slice().sort(),
    unclassifiedBinds: unclassifiedBinds.slice().sort()
  };
}

function realInventoryEntries(workspaceRoot) {
  return relativeSourceFiles(workspaceRoot).map(file => ({
    file,
    text: fs.readFileSync(path.join(workspaceRoot, file), 'utf8')
  }));
}

test('adoption owner inventory rejects an added private creator or history reader', { timeout: 8000 }, () => {
  const workspaceRoot = path.join(__dirname, '..');
  const entries = realInventoryEntries(workspaceRoot);
  // The new shared reader lives under src; assert it is actually scanned from disk.
  const reader = entries.find(entry => entry.file === 'src/discord/history-access.ts');
  assert.ok(reader, 'the new shared reader must be scanned from source, not build output');

  const real = scanInventory(entries);
  assert.deepEqual(real.unclassifiedBinds, [], 'an unrecognized bind() receiver is a failure');
  assert.deepEqual(real.creators, EXPECTED_CREATORS.slice().sort(),
    'creator multiset must match exactly the fourteen production tuples');
  assert.deepEqual(real.messagesFetch, EXPECTED_MESSAGES_FETCH.slice().sort(),
    'direct messages.fetch multiset must match exactly the seven accepted entries');
  assert.deepEqual(real.fetchHistory, EXPECTED_FETCH_HISTORY.slice().sort(),
    'fetchHistory multiset must match exactly the three accepted entries');

  // Mutant 1: an unreachable extra state.bind()-shaped creator must fail the scan.
  const creatorMutantEntries = entries.map(entry => entry.file === 'src/cli.js'
    ? { ...entry, text: `${entry.text}\nfunction scanMutantUnreachable() { state.bind({}); }\n` }
    : entry);
  const creatorMutant = scanInventory(creatorMutantEntries);
  assert.notDeepEqual(creatorMutant.creators, EXPECTED_CREATORS.slice().sort(),
    'an added private creator must fail the inventory');
  assert.equal(creatorMutant.creators.length, EXPECTED_CREATORS.length + 1);

  // Mutant 2: an unreachable extra messages.fetch()-shaped reader must fail the scan.
  const readerMutantEntries = entries.map(entry => entry.file === 'src/discord/history-access.ts'
    ? { ...entry, text: `${entry.text}\nfunction scanMutantUnreachable() { channel.messages.fetch({ limit: 1 }); }\n` }
    : entry);
  const readerMutant = scanInventory(readerMutantEntries);
  assert.notDeepEqual(readerMutant.messagesFetch, EXPECTED_MESSAGES_FETCH.slice().sort(),
    'an added private history reader must fail the inventory');
  assert.equal(readerMutant.messagesFetch.length, EXPECTED_MESSAGES_FETCH.length + 1);

  // Restored control passes again.
  const restored = scanInventory(entries);
  assert.deepEqual(restored, real, 'the restored source must pass the inventory unchanged');
});
