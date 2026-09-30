'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');

const { SurfaceState } = require('../src/state');
const {
  ADOPTION_REFUSAL_DETAILS,
  AdoptionRefusalError,
  readAdoptionCutoff
} = require('../src/discord/history-access');
const {
  tempDir,
  makeState,
  grant,
  adoptionChannel,
  refusalFrom,
  withFakeDiscord,
  fakeDiscordClient
} = require('./helpers/qualified-adoption-fixture');

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
