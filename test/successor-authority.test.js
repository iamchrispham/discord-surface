'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { SurfaceState, READINESS, THREAD_STATES } = require('../src/state');
const { DiscordGateway } = require('../src/discord');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const { conductorMarker } = require('../src/cli');
const { CODEX_ID, SUCCESSOR_ID, CONDUCTOR_LOCK, CLI_PATH, fixture, historyPermissions, conductorLock, processStartTime, lockArtifacts, waitForProcessGone } = require('./surface-fixtures');

const PYTHON = process.env.DISCORD_SURFACE_PYTHON || 'python3';
const HELPER = path.join(__dirname, 'helpers', 'successor-authority.py');

// Fixture-only Python driver. The Python side owns disposable canonical roots,
// worker manifests and bounded children; this file only asserts outcomes.
function runScenario(name, overrides = {}) {
  const result = spawnSync(PYTHON, [HELPER, 'run', name, JSON.stringify(overrides)], {
    encoding: 'utf8', timeout: 60000, cwd: __dirname
  });
  assert.equal(result.status, 0, `helper failed for ${name}: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

function assertRefused(result, label) {
  assert.equal(result.status, 2, `${label}: expected refusal exit 2, got ${result.status}: ${result.stderr}`);
  assert.equal(result.refused, true, `${label}: stderr must carry REFUSED:`);
  assert.match(result.stderr, /REFUSED:/);
  assert.equal(result.committed, false, `${label}: no commit child may be invoked`);
  assert.equal(result.child, null, `${label}: marker child record must be absent`);
}

function assertCommitted(result, carry, label) {
  assert.equal(result.status, 0, `${label}: gate should commit: ${result.stderr}`);
  assert.equal(result.committed, true, `${label}: stub commit child must run`);
  assert.equal(result.child.carry, carry, `${label}: carry marker value`);
}

function fakeDiscordPreload({ channelId, categoryId, topic }) {
  return `
const fs = require('node:fs');
const Module = require('node:module');
const originalLoad = Module._load;
const channelId = ${JSON.stringify(channelId)};
const categoryId = ${JSON.stringify(categoryId)};
const topic = ${JSON.stringify(topic)};
const childId = 'child';
const parent = {
  id: channelId, parentId: categoryId, topic, guildId: 'guild-1',
  isThread: () => false, permissionsFor: () => ({ has: () => true }),
  async setTopic(next) { this.topic = next; },
  messages: { async fetch() { return []; } },
  async send() { return { id: '200', async delete() {} }; }
};
const child = {
  id: childId, parentId: channelId, guildId: 'guild-1', archived: false, locked: false,
  isThread: () => true, permissionsFor: () => ({ has: () => true }),
  messages: { async fetch() { return []; } },
  async send() { return { id: 'reply-1' }; }
};
const fake = {
  GatewayIntentBits: { Guilds: 1 },
  Client: class {
    constructor() {
      this.guilds = { fetch: async () => ({ channels: { fetch: async () => parent } }) };
      this.channels = { fetch: async id => id === childId ? child : parent };
    }
    async login() {}
    async destroy() {}
  }
};
Module._load = (request, parentModule, isMain) => request === 'discord.js' ? fake : originalLoad(request, parentModule, isMain);
`;
}

function runPublicPickup({ db, dir, lockDir, repo, repoKey, conductorId, nativeId, transcript, workerManifest, preload }) {
  return spawnSync(process.execPath, [CLI_PATH, 'handoff', '--from-lock', '--state-dir', dir, '--db', db,
    '--repo', repo, '--provider', 'codex', '--conductor-id', conductorId, '--repo-key', repoKey,
    '--native-id', nativeId, '--workspace', dir, '--session-file', transcript, '--worker-file', workerManifest], {
    env: {
      ...process.env,
      CONDUCTOR_LOCK_FILE: path.join(lockDir, 'conductor.lock.json'),
      CONDUCTOR_WORKERS_DIR: path.join(lockDir, 'workers'),
      CONDUCTOR_CODEX_SESSIONS_DIR: path.join(lockDir, 'sessions'),
      CONDUCTOR_CLAUDE_PROJECTS_DIR: path.join(lockDir, 'claude-projects'),
      CONDUCTOR_SOCKETS_DIR: path.join(lockDir, 'sockets'),
      CONDUCTOR_STALE_MIN: '1',
      DISCORD_SURFACE_LOCK_SCRIPT: CONDUCTOR_LOCK,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' ')
    },
    timeout: 60000, encoding: 'utf8'
  });
}

module.exports = { runScenario, assertRefused, assertCommitted };

// Shared real-canonical-steal fixture: a disposable lock history written by the
// canonical lock script, full worker evidence, and a queued enrolled-child
// message. Used by the public-CLI successful steal (1) and reuse (15) cases.
function buildStealFixture({ dbName, channelId, threadId, messageId, enroll }) {
  const { dir, db, state } = fixture(dbName);
  const repo = 'https://github.com/example/discord-pickup.git';
  const oldOwner = `session-codex-${CODEX_ID.slice(0, 8)}`;
  const successorOwner = `session-codex-${SUCCESSOR_ID.slice(0, 8)}`;
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-steal-lock-'));
  fs.mkdirSync(path.join(lockDir, 'workers'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(lockDir, 'sessions'), { recursive: true, mode: 0o700 });
  const predecessor = spawn(PYTHON, ['-c', 'import time; time.sleep(8)'], { stdio: 'ignore' });
  let worker = null;
  const preload = path.join(dir, 'authority-discord-preload.cjs');
  const secret = path.join(dir, 'discord.secret');
  // Real canonical steal history written by the canonical lock script itself.
  const claim = conductorLock(lockEnvFor(lockDir), ['--repo', repo, '--vendor', 'codex', 'claim', oldOwner, 'predecessor claim']);
  assert.equal(claim.status, 0, claim.stderr);
  const lockPath = path.join(lockDir, 'conductor.lock.json');
  const lockDocument = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lockDocument.repos['github.com/example/discord-pickup'].vendors.codex.beat = Math.floor(Date.now() / 1000) - 600;
  fs.writeFileSync(lockPath, JSON.stringify(lockDocument), { mode: 0o600 });
  const stolen = conductorLock(lockEnvFor(lockDir), ['--repo', repo, '--vendor', 'codex', 'steal', successorOwner, 'predecessor death proof']);
  assert.equal(stolen.status, 0, stolen.stderr);
  const identity = JSON.parse(conductorLock(lockEnvFor(lockDir), ['--repo', repo, '--vendor', 'codex', 'identity']).stdout);
  const { repo_key: repoKey } = identity;
  const conductorId = path.basename(identity.beacon);
  lockArtifacts(identity, repoKey, 'codex', successorOwner);
  const workerManifest = path.join(lockDir, 'workers', `${successorOwner}.json`);
  const predecessorManifest = path.join(lockDir, 'workers', `${oldOwner}.json`);
  fs.writeFileSync(predecessorManifest, JSON.stringify({
    sessionId: CODEX_ID, fullUUID: CODEX_ID, worktree: dir, state: 'done', harness: 'codex',
    pid: predecessor.pid, processStartTime: 1700000000
  }), { mode: 0o600 });
  const transcript = path.join(lockDir, 'sessions', `rollout-test-${SUCCESSOR_ID}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'session_meta', payload: { id: SUCCESSOR_ID } })}\n`, { mode: 0o600 });

  const categoryId = 'codex-category';
  state.setConfig({ codexCategoryId: categoryId });
  state.bind({ channelId, guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, categoryId, conductorId, repoKey }, { intakeCutoff: '100' });
  const predecessorBinding = state.getBinding(channelId);
  if (enroll) {
    state.enrollThread({ threadId, parentChannelId: channelId, guildId: 'guild-1', adoptionCutoff: '100' }, predecessorBinding);
    state.setThreadBaseline(threadId, '100', predecessorBinding);
    state.markThreadBoundary(threadId, THREAD_STATES.READY, 'fixture adoption', null, null, predecessorBinding);
  }
  state.setIntakeCutoff(channelId, predecessorBinding.guildId, '100', 'fixture parent coverage');
  state.markIntakeBoundary(channelId, READINESS.READY, 'fixture parent ready', null, null, predecessorBinding);
  state.setBindingReadiness(channelId, READINESS.READY, 'fixture ready', predecessorBinding);
  state.acceptDiscordMessage({ id: messageId, channelId: enroll ? threadId : channelId, guildId: 'guild-1', authorId: 'operator-1', content: 'accepted predecessor work' });
  const acceptedBefore = state.getMessage(messageId);
  const acceptanceReceipt = state.listReceipts().find(row => row.kind === 'accepted' && row.discord_id === messageId);
  const topic = conductorMarker({ provider: 'codex', conductorId, repoKey });
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fake-token\n', { mode: 0o600 });
  fs.writeFileSync(preload, fakeDiscordPreload({ channelId, categoryId, topic }), { mode: 0o600 });
  state.close();
  // Every real fixture child is bounded: the successor worker self-expires in
  // 8s, so each gate invocation refreshes the same manifest with the live pid.
  const runPickup = () => {
    if (worker) { try { worker.kill('SIGKILL'); } catch {} }
    worker = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 8000)'], { cwd: dir, stdio: 'ignore' });
    const started = processStartTime(worker.pid);
    fs.writeFileSync(workerManifest, JSON.stringify({
      laneId: `${successorOwner}-9eaba20295e60eb88306d751eb0aeae1`, worktree: dir, state: 'active', harness: 'codex',
      sessionId: SUCCESSOR_ID, fullUUID: SUCCESSOR_ID, pid: worker.pid,
      processStartTime: started, generation: 1
    }), { mode: 0o600 });
    return runPublicPickup({ db, dir, lockDir, repo, repoKey, conductorId, nativeId: SUCCESSOR_ID, transcript, workerManifest, preload });
  };
  const cleanup = async () => {
    predecessor.kill('SIGTERM');
    if (worker) worker.kill('SIGTERM');
    await waitForProcessGone(predecessor.pid).catch(() => {});
    if (worker) await waitForProcessGone(worker.pid).catch(() => {});
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, db, channelId, threadId, messageId, categoryId, conductorId, repoKey, topic, secret, preload,
    lockDir, workerManifest, predecessorManifest, acceptedBefore, acceptanceReceipt, runPickup, cleanup };
}

function fakeDiscordClient({ channelId, categoryId, topic, threadId }) {
  const { ChannelType } = require('discord.js');
  const channel = { id: channelId, guildId: 'guild-1', parentId: categoryId, topic, type: ChannelType.GuildText,
    isThread: () => false, permissionsFor: () => historyPermissions(), async setTopic(next) { this.topic = next; },
    messages: { async fetch() { return []; } } };
  const thread = { id: threadId, guildId: 'guild-1', parentId: channelId, type: ChannelType.PublicThread, archived: false, locked: false,
    isThread: () => true, permissionsFor: () => historyPermissions(),
    async send() { return { id: 'reply-1' }; }, messages: { async fetch() { return []; } } };
  return { user: { id: 'bot' }, on() {}, off() {}, async login() {}, async destroy() {},
    channels: { async fetch(id) { return id === threadId ? thread : channel; } } };
}

test('1: qualified canonical steal through the public CLI carries an enrolled child message and dispatches it once', async () => {
  const f = buildStealFixture({ dbName: 'authority-from-lock.sqlite', channelId: 'authority-channel', threadId: 'child', messageId: '150', enroll: true });
  try {
    const first = f.runPickup();
    assert.equal(first.status, 0, first.stderr);
    const updated = new SurfaceState(f.db);
    try {
      const binding = updated.getBinding(f.channelId);
      assert.equal(binding.nativeId, SUCCESSOR_ID);
      assert.equal(binding.generation, 2);
      const carried = updated.getMessage(f.messageId);
      assert.equal(carried.nativeId, SUCCESSOR_ID);
      assert.equal(carried.generation, 2);
      assert.equal(carried.state, f.acceptedBefore.state);
      assert.equal(carried.content, f.acceptedBefore.content);
      assert.equal(carried.createdAt, f.acceptedBefore.createdAt);
      assert.equal(carried.deliveryChannelId, f.threadId);
      const afterReceipt = updated.listReceipts().find(row => row.id === f.acceptanceReceipt.id);
      assert.deepEqual(afterReceipt, f.acceptanceReceipt, 'original acceptance receipt is preserved unchanged');
      updated.setBindingReadiness(f.channelId, READINESS.READY, 'fixture successor ready');
      updated.markThreadBoundary(f.threadId, THREAD_STATES.READY, 'fixture successor', null, null, updated.getBinding(f.channelId));
    } finally { updated.close(); }

    const dispatches = [];
    const reopened = new SurfaceState(f.db);
    try {
      const route = reopened.getMessageRoute(f.threadId);
      assert.equal(route?.ready, true, 'child route must be ready before dispatch');
      assert.equal(reopened.getMessage(f.messageId).state, 'accepted', 'carried child message must stay accepted');
      const gateway = new DiscordGateway({
        state: reopened,
        client: fakeDiscordClient({ channelId: f.channelId, categoryId: f.categoryId, topic: f.topic, threadId: f.threadId }),
        providers: { codex: {
          async dispatch(message) {
            dispatches.push(message);
            recordNativeAcknowledgment(reopened, { provider: 'codex', messageId: message.id, nativeId: message.nativeId, generation: message.generation });
            return { status: 'submitted' };
          },
          async observe() { return { text: 'successor answer' }; }
        } },
        logger: () => {}
      });
      try {
        await gateway.start(f.secret);
        const reconciled = await gateway.reconcilePending();
        assert.deepEqual(reconciled.map(message => message.id), [f.messageId]);
        await gateway.consumer.waitForNativeWork();
        assert.equal(dispatches.length, 1, 'the carried child message dispatches exactly once');
        assert.equal(dispatches[0].id, f.messageId);
        assert.equal(dispatches[0].nativeId, SUCCESSOR_ID);
        assert.equal(dispatches[0].generation, 2);
      } finally { await gateway.stop(); }
    } finally { reopened.close(); }

    const repeat = f.runPickup();
    assert.equal(repeat.status, 0, repeat.stderr);
    const reused = new SurfaceState(f.db);
    try {
      const binding = reused.getBinding(f.channelId);
      assert.equal(binding.nativeId, SUCCESSOR_ID);
      assert.equal(binding.generation, 2, 'idempotent reuse preserves the generation');
      assert.equal(reused.getMessage(f.messageId).generation, 2);
      assert.equal(reused.listReceipts().filter(row => row.kind === 'conductor-custody-transferred').length, 1,
        'reuse mints no second transfer receipt');
    } finally { reused.close(); }
    assert.equal(dispatches.length, 1, 'idempotent reuse must not dispatch again');
  } finally { await f.cleanup(); }
});

function lockEnvFor(lockDir) {
  return {
    CONDUCTOR_LOCK_FILE: path.join(lockDir, 'conductor.lock.json'),
    CONDUCTOR_WORKERS_DIR: path.join(lockDir, 'workers'),
    CONDUCTOR_CODEX_SESSIONS_DIR: path.join(lockDir, 'sessions'),
    CONDUCTOR_CLAUDE_PROJECTS_DIR: path.join(lockDir, 'claude-projects'),
    CONDUCTOR_SOCKETS_DIR: path.join(lockDir, 'sockets'),
    CONDUCTOR_STALE_MIN: '1'
  };
}


test('2: live predecessor refuses even though its manifest lifecycle state is done', () => {
  const result = runScenario('live_predecessor');
  assertRefused(result, 'live predecessor');
  assert.match(result.stderr, /predecessor process is still live/);
});

test('3: missing predecessor manifest entirely refuses', () => {
  const result = runScenario('missing_predecessor');
  assertRefused(result, 'missing predecessor');
  assert.match(result.stderr, /no readable manifest matches the bound predecessor identity exactly/);
});

test('4: matching-filename malformed manifest refuses as unknown, never ignored', () => {
  const result = runScenario('malformed_predecessor');
  assertRefused(result, 'malformed predecessor');
  assert.match(result.stderr, /matching predecessor manifest is unreadable/);
});

test('5: readable exact identity under a different filename is inspected and refuses while live', () => {
  const result = runScenario('different_filename');
  assertRefused(result, 'different-filename predecessor');
  assert.match(result.stderr, /predecessor process is still live/);
});

test('6: conflicting candidate full identities refuse for provider and workspace disagreement', () => {
  const provider = runScenario('conflict_provider');
  assertRefused(provider, 'conflicting provider');
  assert.match(provider.stderr, /conflicting predecessor identity records disagree/);
  const workspace = runScenario('conflict_workspace');
  assertRefused(workspace, 'conflicting workspace');
  assert.match(workspace.stderr, /conflicting predecessor identity records disagree/);
});

test('7: reused PID whose live process start differs from the manifest qualifies as gone', () => {
  const result = runScenario('different_start');
  assertCommitted(result, '1', 'reused-PID predecessor');
  assert.match(result.child.argv.join(' '), /--handoff-id lock-handoff-/);
});

test('8: EPERM and unavailable process-start evidence both refuse', () => {
  const eperm = runScenario('eperm');
  assertRefused(eperm, 'EPERM probe');
  assert.match(eperm.stderr, /predecessor process liveness is unknown/);
  const unknown = runScenario('unknown_start');
  assertRefused(unknown, 'unknown start evidence');
  assert.match(unknown.stderr, /predecessor process liveness is unknown/);
});

test('9: override and preempt transitions both refuse even with otherwise-qualifying history', () => {
  const override = runScenario('override');
  assertRefused(override, 'override transition');
  assert.match(override.stderr, /forced takeover is not a normal release-to-claim handoff/);
  const preempt = runScenario('preempt');
  assertRefused(preempt, 'preempt transition');
  assert.match(preempt.stderr, /forced takeover is not a normal release-to-claim handoff/);
});

test('10: steal whose immediately-prior owner does not match the bound predecessor refuses', () => {
  const result = runScenario('wrong_predecessor');
  assertRefused(result, 'wrong bound predecessor');
  assert.match(result.stderr, /predecessor/);
});

test('11: successor identity change between the pre-lock and locked snapshots refuses', () => {
  const result = runScenario('successor_change');
  assertRefused(result, 'successor snapshot change');
  assert.match(result.stderr, /conductor worker identity changed while acquiring the writer gate/);
});

test('12: predecessor manifest identity change between the pre-lock and locked checks refuses', () => {
  const result = runScenario('predecessor_change');
  assertRefused(result, 'predecessor snapshot change');
  assert.match(result.stderr, /conductor worker identity changed while acquiring the writer gate/);
});

test('13: an intervening different owner-changing event after the steal refuses', () => {
  const result = runScenario('intervening');
  assertRefused(result, 'intervening owner mutation');
  assert.match(result.stderr, /changed owner after the identified steal|forced takeover/);
});

test('14: normal release/claim still works and clears any inherited carry marker', () => {
  const result = runScenario('normal_release_claim', { preCarryEnv: '1' });
  assertCommitted(result, null, 'normal release/claim');
  assert.match(result.child.argv.join(' '), /--handoff-id lock-handoff-/);
  assert.ok(!result.child.argv.includes('--reuse'));
});

test('15: same-owner reuse after a real verified steal takes the reuse path without carry or fresh predecessor proof', async () => {
  const f = buildStealFixture({ dbName: 'authority-reuse.sqlite', channelId: 'authority-reuse', threadId: 'reuse-child', messageId: '250', enroll: false });
  try {
    const first = f.runPickup();
    assert.equal(first.status, 0, first.stderr);
    const committed = new SurfaceState(f.db);
    let generationAfterSteal;
    try {
      generationAfterSteal = committed.getBinding(f.channelId).generation;
      assert.equal(generationAfterSteal, 2);
      assert.equal(committed.getMessage(f.messageId).nativeId, SUCCESSOR_ID);
    } finally { committed.close(); }
    // A reuse pass must not demand fresh predecessor proof, so remove the
    // predecessor manifest entirely; only identity and history remain.
    fs.rmSync(f.predecessorManifest, { force: true });
    const reuse = f.runPickup();
    assert.equal(reuse.status, 0, reuse.stderr);
    const reused = new SurfaceState(f.db);
    try {
      const binding = reused.getBinding(f.channelId);
      assert.equal(binding.nativeId, SUCCESSOR_ID);
      assert.equal(binding.generation, generationAfterSteal, 'reuse performs no state mutation');
      assert.equal(reused.getMessage(f.messageId).generation, generationAfterSteal);
      assert.equal(reused.getMessage(f.messageId).state, 'accepted', 'reuse stays an idempotent no-op');
      assert.equal(reused.listReceipts().filter(row => row.kind === 'conductor-custody-transferred').length, 1,
        'no additional transfer receipt is minted on reuse');
    } finally { reused.close(); }
  } finally { await f.cleanup(); }
});

test('16: duplicate JSON keys and non-finite JSON numbers in a manifest both refuse', () => {
  const duplicate = runScenario('duplicate_keys');
  assertRefused(duplicate, 'duplicate manifest keys');
  assert.match(duplicate.stderr, /duplicate JSON key/);
  const nonfinite = runScenario('nonfinite');
  assertRefused(nonfinite, 'non-finite manifest number');
  assert.match(nonfinite.stderr, /non-finite JSON number/);
});
