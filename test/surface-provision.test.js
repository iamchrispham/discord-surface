const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { StaleGenerationError, UnresolvedWorkError, MESSAGE_STATES, READINESS } = require('../src/state');
const { createSurfaceConsumer, DiscordGateway } = require('../src/discord');
const { bindingArgs, conductorMarker, ensureProvisionedChannel, migrateLegacyTopic } = require('../src/cli');
const { conductorMarkerMatches, topicWithReadiness } = require('../src/topic');
const { CODEX_ID, CLAUDE_ID, SUCCESSOR_ID, LOCKF, CLI_PATH, fixture, discordMessage, historyPermissions, lockfRun, waitForFile, waitForChild, providers } = require('./surface-fixtures');

test('simulated: empty Discord history requires known effective read permission', async () => {
  for (const [label, allowed, known] of [['revoked', false, true], ['unknown', false, false]]) {
    const { dir, state } = fixture();
    state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
    state.setIntakeBaseline('channel-codex', '100', 'previous completed recovery');
    state.markIntakeBoundary('channel-codex', 'ready');
    const secret = path.join(dir, `discord-${label}.env`);
    fs.writeFileSync(secret, 'DISCORD_TOKEN=fake-token\n', { mode: 0o600 });
    const channel = { id: 'channel-codex', permissionsFor: known ? () => historyPermissions(allowed) : undefined };
    const client = {
      user: known ? { id: 'bot-1' } : undefined,
      on() {}, off() {}, async login() {}, channels: { fetch: async () => channel }, async destroy() {}
    };
    const gateway = new DiscordGateway({ state, client, fetchHistory: async () => { throw new Error('history must not be fetched'); } });
    await gateway.start(secret);
    assert.equal(gateway.started, true);
    assert.equal(gateway.transportReady, true);
    assert.equal(gateway.ready, false);
    const watermark = state.getIntakeWatermark('channel-codex');
    assert.equal(watermark.recovered_through_id, '100');
    assert.equal(watermark.state, 'unavailable');
    state.acceptDiscordMessage({ id: `held-${label}`, guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'held while permission is unavailable' }, { ready: false });
    assert.equal(state.getIntakeWatermark('channel-codex').state, 'unavailable');
    await gateway.stop();
    state.close();
  }
});

test('simulated: unknown Discord delivery is reconciled without native redispatch', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  let dispatches = 0;
  let sends = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: { codex: { async dispatch() { dispatches += 1; return { status: 'submitted' }; }, async observe() { return { text: 'answer' }; } } },
    sendReply: async () => { sends += 1; if (sends === 1) throw new TypeError('send result was not returned'); return { id: 'reply-reconciled' }; }
  });
  const first = await consumer.handleMessage(discordMessage({ id: 'delivery-reconcile', channelId: 'channel-codex' }));
  assert.equal(first.message.state, MESSAGE_STATES.REPLY_UNKNOWN);
  state.reconcileReplyDelivery('delivery-reconcile', 'not_sent');
  const second = await consumer.deliverReply(discordMessage({ id: 'delivery-reconcile', channelId: 'channel-codex' }), {
    status: 'reply_ready',
    message: state.getMessage('delivery-reconcile')
  });
  assert.equal(second.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(dispatches, 1);
  assert.equal(sends, 2);
  state.close();
});

test('simulated: stable conductor identity permits distinct IDs and explicit same-channel successor handoff', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'conductor-a', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'conductor-a', repoKey: 'repo:alpha' });
  state.bind({ channelId: 'conductor-b', guildId: 'guild-1', provider: 'codex', nativeId: CLAUDE_ID, workspace: dir, conductorId: 'conductor-b', repoKey: 'repo:alpha' });
  state.markIntakeBoundary('conductor-a', 'ready');
  assert.throws(() => state.bind({ channelId: 'duplicate-conductor', guildId: 'guild-1', provider: 'codex', nativeId: SUCCESSOR_ID, workspace: dir, conductorId: 'conductor-a', repoKey: 'repo:alpha' }), /already bound/);

  state.acceptDiscordMessage({ id: 'drained', guildId: 'guild-1', channelId: 'conductor-a', authorId: 'operator-1', isBot: false, content: 'drain' });
  state.claimDispatch('drained');
  state.markSubmitted('drained');
  state.recordNativeReply({ provider: 'codex', messageId: 'drained', nativeId: CODEX_ID, generation: 1, text: 'done' });
  state.beginReply('drained');
  state.markReplySent('drained', 'reply-drained');
  const successor = state.handoffConductor({
    channelId: 'conductor-a',
    provider: 'codex',
    conductorId: 'conductor-a',
    repoKey: 'repo:alpha',
    fromNativeId: CODEX_ID,
    fromGeneration: 1,
    nativeId: SUCCESSOR_ID,
    workspace: dir,
    handoffId: 'handoff-1'
  });
  assert.equal(successor.channelId, 'conductor-a');
  assert.equal(successor.generation, 2);
  assert.equal(successor.conductorId, 'conductor-a');
  assert.throws(() => state.recordNativeReply({ provider: 'codex', messageId: 'drained', nativeId: CODEX_ID, generation: 1, text: 'late' }), StaleGenerationError);
  state.markIntakeBoundary('conductor-a', 'ready');
  state.acceptDiscordMessage({ id: 'successor-input', guildId: 'guild-1', channelId: 'conductor-a', authorId: 'operator-1', isBot: false, content: 'new owner' });
  state.claimDispatch('successor-input');
  state.markSubmitted('successor-input');
  state.recordNativeReply({ provider: 'codex', messageId: 'successor-input', nativeId: SUCCESSOR_ID, generation: 2, text: 'successor answer' });
  assert.equal(state.getMessage('successor-input').state, MESSAGE_STATES.REPLY_READY);
  state.close();
});

test('simulated: conductor generations remain monotonic after unbind and new-channel bind', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'old-conductor', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'stable', repoKey: 'repo:alpha' });
  state.unbind('old-conductor');
  const rebound = state.bind({ channelId: 'new-conductor', guildId: 'guild-1', provider: 'codex', nativeId: SUCCESSOR_ID, workspace: dir, conductorId: 'stable', repoKey: 'repo:alpha' });
  assert.equal(rebound.generation, 2);
  state.close();
});

test('simulated: stable conductor markers repeat, adopt the existing setup channel, and never retry an unresolved create', async () => {
  const channels = new Map();
  let creates = 0;
  const guild = {
    channels: {
      cache: { values: () => channels.values() },
      async fetch(id) { return id ? channels.get(id) : undefined; },
      async create(options) {
        creates += 1;
        const channel = { id: `created-conductor-${creates}`, parentId: options.parent, topic: options.topic, async setTopic(topic) { this.topic = topic; } };
        channels.set(channel.id, channel);
        return channel;
      }
    }
  };
  const first = await ensureProvisionedChannel({ guild, provider: 'codex', nativeId: CODEX_ID, categoryId: 'codex-category', conductorId: 'stable-conductor', repoKey: 'repo:alpha', taskName: 'presentation only' });
  const second = await ensureProvisionedChannel({ guild, provider: 'codex', nativeId: CODEX_ID, categoryId: 'codex-category', conductorId: 'stable-conductor', repoKey: 'repo:alpha', taskName: 'renamed presentation', channelId: first.channel.id });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.channel.id, first.channel.id);
  assert.match(first.marker, /conductor=stable-conductor/);
  assert.equal(creates, 1);

  const existingId = '1545716797217570847';
  let adoptionWrites = 0;
  const existing = { id: existingId, parentId: 'codex-category', topic: `Conductor task: codex/${CODEX_ID}`, async setTopic() { adoptionWrites += 1; } };
  const adoptionGuild = { channels: {
    cache: { values: () => [existing][Symbol.iterator]() },
    async fetch(id) { return id ? existing : undefined; },
    async create() { throw new Error('adoption must not create'); }
  } };
  await assert.rejects(() => ensureProvisionedChannel({ guild: adoptionGuild, provider: 'codex', nativeId: CODEX_ID, categoryId: 'codex-category', conductorId: 'stable-conductor', repoKey: 'repo:alpha', channelId: existingId }), /explicit --migrate-legacy-topic/);
  const adopted = await ensureProvisionedChannel({ guild: adoptionGuild, provider: 'codex', nativeId: CODEX_ID, categoryId: 'codex-category', conductorId: 'stable-conductor', repoKey: 'repo:alpha', channelId: existingId, allowLegacy: true });
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.channel.id, existingId);
  assert.equal(adopted.channel.topic, `Conductor task: codex/${CODEX_ID}`);
  assert.equal(adoptionWrites, 0);

  const unresolvedGuild = { channels: { cache: { values: () => [][Symbol.iterator]() }, async fetch() {}, async create() { throw new Error('must not retry unknown create'); } } };
  await assert.rejects(() => ensureProvisionedChannel({ guild: unresolvedGuild, provider: 'codex', nativeId: CODEX_ID, categoryId: 'codex-category', conductorId: 'other-conductor', repoKey: 'repo:alpha', allowCreate: false }), /unresolved/);
});

test('simulated: explicit legacy migration records terminal custody and never rewrites a static address', async () => {
  const { dir, state } = fixture();
  const channelId = 'legacy-migration';
  state.bind({ channelId, guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'legacy-migration-conductor', repoKey: 'repo:alpha', generation: 3 });
  const binding = state.getBinding(channelId);
  const legacyTopic = `discord-surface:v2 conductor=legacy-migration-conductor provider=codex repo=repo%3Aalpha native=${CODEX_ID} generation=3 readiness=pending`;
  const channel = { id: channelId, topic: legacyTopic };
  const staticTopic = conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: binding.conductorId, repoKey: binding.repoKey });
  let requests = 0;
  const result = await migrateLegacyTopic({
    state,
    channel,
    binding,
    token: 'fake-token',
    request: async ({ signal, topic }) => {
      requests += 1;
      assert.equal(signal.aborted, false);
      return { topic };
    },
    timeoutMs: 50
  });
  assert.equal(result.migrated, true);
  assert.equal(channel.topic, staticTopic);
  assert.equal(requests, 1);
  assert.equal(state.listTopicPublications(channelId)[0].status, 'published');
  const repeated = await migrateLegacyTopic({ state, channel, binding: state.getBinding(channelId), token: 'fake-token', request: async () => { requests += 1; return { topic: staticTopic }; } });
  assert.equal(repeated.migrated, false);
  assert.equal(requests, 1);
  state.close();
});

test('simulated: unknown legacy migration keeps readiness fenced until explicit reconciliation', async () => {
  const { dir, state } = fixture();
  const channelId = 'legacy-migration-unknown';
  state.bind({ channelId, guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'legacy-unknown-conductor', repoKey: 'repo:alpha' });
  state.markIntakeBoundary(channelId, 'ready', 'prior verified history');
  const binding = state.getBinding(channelId);
  const channel = { id: channelId, topic: `discord-surface:v2 conductor=legacy-unknown-conductor provider=codex repo=repo%3Aalpha native=${CODEX_ID} generation=1 readiness=ready` };
  await assert.rejects(() => migrateLegacyTopic({
    state,
    channel,
    binding,
    token: 'fake-token',
    request: async () => { throw new Error('socket closed before a Discord response'); },
    timeoutMs: 50
  }), /socket closed/);
  assert.equal(state.listTopicPublications(channelId)[0].status, 'unknown');
  assert.equal(state.getBinding(channelId).readiness, READINESS.UNAVAILABLE);
  assert.throws(() => state.setBindingReadiness(channelId, READINESS.READY), UnresolvedWorkError);
  assert.throws(() => state.markIntakeBoundary(channelId, 'ready'), UnresolvedWorkError);
  state.close();
});

test('simulated: static address marker is strict and repeated adoption preserves it', async () => {
  const marker = conductorMarker({ provider: 'codex', nativeId: CODEX_ID, categoryId: 'unused', conductorId: 'qualified-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY });
  const publishedAt = '2026-09-05T12:00:00.000Z';
  const qualified = marker;
  const dynamicLegacy = topicWithReadiness(`discord-surface:v2 conductor=qualified-conductor provider=codex repo=repo%3Aalpha native=${CODEX_ID} generation=1 readiness=pending`, READINESS.READY, publishedAt);
  const expected = { provider: 'codex', nativeId: CODEX_ID, conductorId: 'qualified-conductor', repoKey: 'repo:alpha', generation: 1 };
  assert.equal(conductorMarkerMatches(qualified, expected), true);
  assert.equal(conductorMarkerMatches(dynamicLegacy, expected), true);
  assert.equal(conductorMarkerMatches(`${qualified} [last-published-intake=ready at=${publishedAt}]`, expected), false);
  assert.equal(conductorMarkerMatches('discord-surface:v3 conductor=%71ualified-conductor provider=codex repo=repo%3Aalpha [address only, not live status]', expected), false);
  assert.equal(conductorMarkerMatches(`${qualified} trailing text`, expected), false);
  let writes = 0;
  const existing = { id: 'qualified-channel', parentId: 'codex-category', topic: qualified, async setTopic() { writes += 1; } };
  const guild = { channels: {
    cache: { values: () => [existing][Symbol.iterator]() },
    async fetch() { return existing; },
    async create() { throw new Error('qualified marker must reuse channel'); }
  } };
  const result = await ensureProvisionedChannel({ guild, provider: 'codex', nativeId: CODEX_ID, categoryId: 'codex-category', conductorId: 'qualified-conductor', repoKey: 'repo:alpha', channelId: existing.id });
  assert.equal(result.created, false);
  assert.equal(result.adopted, false);
  assert.equal(existing.topic, qualified);
  assert.equal(writes, 0);
});

test('simulated: durable provision intent rejects a second unresolved create attempt', () => {
  const { dir, state } = fixture();
  const intent = {
    provider: 'codex',
    nativeId: CODEX_ID,
    conductorId: 'intent-conductor',
    repoKey: 'repo:alpha',
    guildId: 'guild-1',
    categoryId: 'codex-category',
    workspace: dir,
    marker: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'intent-conductor', repoKey: 'repo:alpha' })
  };
  assert.equal(state.beginProvisionIntent(intent).fresh, true);
  assert.equal(state.beginProvisionIntent(intent).fresh, false);
  state.close();
});

test('simulated: ordinary worker binding requires explicit conductor identity', () => {
  assert.throws(() => bindingArgs({ 'channel-id': 'worker', 'guild-id': 'guild-1', provider: 'codex', 'native-id': CODEX_ID, workspace: process.cwd() }), /conductor-id/);
});

test('simulated: installed lockf creates, excludes, releases, and retains the lock inode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-lock-'));
  const lockPath = path.join(dir, 'surface.lock');
  const firstMarker = path.join(dir, 'first');
  const heldMarker = path.join(dir, 'held');
  const contenderMarker = path.join(dir, 'contender');
  const secondMarker = path.join(dir, 'second');
  const crashMarker = path.join(dir, 'crash');
  const afterCrashMarker = path.join(dir, 'after-crash');
  const write = file => `require('node:fs').writeFileSync(${JSON.stringify(file)}, 'written')`;
  const first = lockfRun(lockPath, write(firstMarker));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(fs.existsSync(firstMarker), true);
  assert.equal(fs.existsSync(lockPath), true);
  const inode = fs.statSync(lockPath).ino;

  const holder = spawn(LOCKF, ['-t', '2', '-k', lockPath, process.execPath, '-e', `${write(heldMarker)}; setTimeout(() => {}, 500)`], { stdio: 'ignore' });
  let crashed = null;
  try {
    await waitForFile(heldMarker);
    const contender = lockfRun(lockPath, write(contenderMarker));
    assert.notEqual(contender.status, 0);
    assert.equal(fs.existsSync(contenderMarker), false);
    const holderResult = await waitForChild(holder);
    assert.equal(holderResult.code, 0);
    const second = lockfRun(lockPath, write(secondMarker));
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.existsSync(secondMarker), true);
    assert.equal(fs.statSync(lockPath).ino, inode);
    crashed = spawn(LOCKF, ['-t', '2', '-k', lockPath, process.execPath, '-e', `${write(crashMarker)}; process.kill(process.pid, 'SIGKILL')`], { stdio: 'ignore' });
    await waitForFile(crashMarker);
    const crashResult = await waitForChild(crashed);
    assert.notEqual(crashResult.code, 0);
    const afterCrash = lockfRun(lockPath, write(afterCrashMarker));
    assert.equal(afterCrash.status, 0, afterCrash.stderr);
    assert.equal(fs.existsSync(afterCrashMarker), true);
    assert.equal(fs.statSync(lockPath).ino, inode);
  } finally {
    if (holder.exitCode === null) holder.kill('SIGTERM');
    if (holder.exitCode === null) await waitForChild(holder).catch(() => {});
    if (crashed?.exitCode === null) crashed.kill('SIGTERM');
    if (crashed?.exitCode === null) await waitForChild(crashed).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('simulated: public provision lock reaches native validation on a fresh state directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-cli-lock-'));
  try {
    const result = spawnSync(process.execPath, [CLI_PATH, 'provision', '--state-dir', dir, '--provider', 'codex', '--native-id', 'invalid-native-id', '--conductor-id', 'cli-lock-conductor', '--repo-key', 'repo:alpha', '--workspace', dir, '--category-id', 'codex-category'], { encoding: 'utf8' });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /nativeId must be an exact UUID/);
    assert.doesNotMatch(output, /No such file or directory/);
    assert.equal(fs.existsSync(path.join(dir, 'provision.lock')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('simulated: public migration flag requires explicit channel adoption evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-cli-migration-'));
  try {
    const result = spawnSync(process.execPath, [CLI_PATH, 'provision', '--state-dir', dir, '--provider', 'codex', '--native-id', CODEX_ID, '--conductor-id', 'cli-migration-conductor', '--repo-key', 'repo:alpha', '--workspace', dir, '--category-id', 'codex-category', '--migrate-legacy-topic'], { encoding: 'utf8' });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /--migrate-legacy-topic requires --channel-id/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
