const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { SurfaceState, MESSAGE_STATES, READINESS } = require('../src/state');
const { DiscordGateway } = require('../src/discord');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const { conductorMarker } = require('../src/cli');
const { CODEX_ID, SUCCESSOR_ID, CONDUCTOR_LOCK, CLI_PATH, fixture, historyPermissions, conductorLock, processStartTime, lockArtifacts, waitForFile, waitForProcessGone, waitForChild, providers } = require('./surface-fixtures');

for (const operation of ['handoff', 'rebind']) test(`simulated: from-lock pickup verifies the successor and commits through the lock gate (${operation})`, async () => {
  const { dir, db, state } = fixture('from-lock.sqlite');
  const repo = 'https://github.com/example/discord-pickup.git';
  const oldNativeId = CODEX_ID;
  const successorNativeId = SUCCESSOR_ID;
  const oldOwner = `session-codex-${oldNativeId.slice(0, 8)}`;
  const successorOwner = `session-codex-${successorNativeId.slice(0, 8)}`;
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-pickup-lock-'));
  const lockEnv = {
    CONDUCTOR_LOCK_FILE: path.join(lockDir, 'conductor.lock.json'),
    CONDUCTOR_WORKERS_DIR: path.join(lockDir, 'workers'),
    CONDUCTOR_CODEX_SESSIONS_DIR: path.join(lockDir, 'sessions'),
    CONDUCTOR_CLAUDE_PROJECTS_DIR: path.join(lockDir, 'claude-projects')
  };
  fs.mkdirSync(lockEnv.CONDUCTOR_CODEX_SESSIONS_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(lockEnv.CONDUCTOR_WORKERS_DIR, { recursive: true, mode: 0o700 });
  const claim = conductorLock(lockEnv, ['--repo', repo, '--vendor', 'codex', 'claim', oldOwner, 'pickup predecessor']);
  assert.equal(claim.status, 0, claim.stderr);
  const identityResult = conductorLock(lockEnv, ['--repo', repo, '--vendor', 'codex', 'identity']);
  assert.equal(identityResult.status, 0, identityResult.stderr);
  const identity = JSON.parse(identityResult.stdout);
  const repoKey = identity.repo_key;
  const conductorId = path.basename(identity.beacon);
  lockArtifacts(identity, repoKey, 'codex', oldOwner);
  const release = conductorLock(lockEnv, ['--repo', repo, '--vendor', 'codex', 'release', oldOwner, 'successor pickup']);
  assert.equal(release.status, 0, release.stderr);
  const successorClaim = conductorLock(lockEnv, ['--repo', repo, '--vendor', 'codex', 'claim', successorOwner, 'pickup successor']);
  assert.equal(successorClaim.status, 0, successorClaim.stderr);
  lockArtifacts(identity, repoKey, 'codex', successorOwner);

  const categoryId = 'codex-category';
  state.setConfig({ codexCategoryId: categoryId });
  state.bind({ channelId: 'from-lock-channel', guildId: 'guild-1', provider: 'codex', nativeId: oldNativeId, workspace: dir, categoryId, conductorId, repoKey });
  const { THREAD_STATES } = require('../src/state/thread-enrollment');
  const predecessor = state.getBinding('from-lock-channel');
  state.enrollThread({ threadId: 'child', parentChannelId: predecessor.channelId, guildId: predecessor.guildId }, predecessor);
  state.setThreadBaseline('child', '100', predecessor);
  state.markThreadBoundary('child', THREAD_STATES.READY, 'fixture adoption', null, null, predecessor);
  state.setIntakeCutoff(predecessor.channelId, predecessor.guildId, '100', 'fixture parent coverage');
  state.markIntakeBoundary(predecessor.channelId, READINESS.READY, 'fixture parent ready', null, null, predecessor);
  state.setBindingReadiness(predecessor.channelId, READINESS.READY, 'fixture ready', predecessor);
  state.acceptDiscordMessage({ id: '150', channelId: 'child', guildId: 'guild-1', authorId: 'operator-1', content: 'accepted predecessor work' });
  const marker = conductorMarker({ provider: 'codex', conductorId, repoKey });
  const secret = path.join(dir, 'discord.secret');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fake-token\n', { mode: 0o600 });
  const transcriptRoot = lockEnv.CONDUCTOR_CODEX_SESSIONS_DIR;
  const transcript = path.join(transcriptRoot, `rollout-test-${successorNativeId}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'session_meta', payload: { id: successorNativeId } })}\n`, { mode: 0o600 });
  const worker = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 120000)'], { cwd: dir, stdio: 'ignore' });
  const workerManifest = path.join(lockDir, 'workers', `${successorOwner}.json`);
  const preload = path.join(dir, 'from-lock-discord-preload.cjs');
  const fenceLog = path.join(dir, 'observed-fences.jsonl');
  fs.writeFileSync(preload, `
const fs = require('node:fs');
const Module = require('node:module');
const originalLoad = Module._load;
const parentId = process.env.DISCORD_SURFACE_TEST_CHANNEL;
const childId = 'child';
const latestFenceId = () => {
  const log = process.env.DISCORD_SURFACE_TEST_FENCES;
  if (!log || !fs.existsSync(log)) return '0';
  const lines = fs.readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean);
  return lines.length ? JSON.parse(lines.at(-1)).id : '0';
};
const parent = {
  id: parentId, parentId: process.env.DISCORD_SURFACE_TEST_CATEGORY, topic: process.env.DISCORD_SURFACE_TEST_TOPIC,
  messages: { async fetch() { return new Map([['fence', { id: latestFenceId() }]]); } },
  async send(payload) {
    const log = process.env.DISCORD_SURFACE_TEST_FENCES;
    const count = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).length : 0;
    const id = String(200 + count);
    fs.appendFileSync(log, JSON.stringify({ id, payload }) + '\\n');
    return { id, async delete() {} };
  }
};
const child = {
  id: childId,
  messages: { async fetch() { return new Map([['unrecorded', { id: '160' }]]); } }
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
Module._load = (request, parent, isMain) => request === 'discord.js' ? fake : originalLoad(request, parent, isMain);
`, { mode: 0o600 });
  state.close();
  try {
    fs.writeFileSync(workerManifest, JSON.stringify({
      laneId: `${successorOwner}-9eaba20295e60eb88306d751eb0aeae1`, worktree: dir, state: 'active', harness: 'codex',
      sessionId: successorNativeId, fullUUID: successorNativeId, pid: worker.pid,
      processStartTime: processStartTime(worker.pid), generation: 1
    }), { mode: 0o600 });
    const pickupArgs = operation === 'handoff'
      ? ['handoff', '--state-dir', dir, '--db', db, '--from-lock', '--repo', repo, '--provider', 'codex',
        '--conductor-id', conductorId, '--repo-key', repoKey, '--native-id', successorNativeId, '--workspace', dir,
        '--session-file', transcript, '--worker-file', workerManifest]
      : ['rebind', '--state-dir', dir, '--db', db, '--channel-id', 'from-lock-channel', '--guild-id', 'guild-1',
        '--provider', 'codex', '--conductor-id', conductorId, '--repo-key', repoKey,
        '--native-id', successorNativeId, '--workspace', dir, '--category-id', categoryId];
    const runPickup = () => spawnSync(process.execPath, [CLI_PATH, ...pickupArgs], {
      env: { ...process.env, ...lockEnv, DISCORD_SURFACE_LOCK_SCRIPT: CONDUCTOR_LOCK,
        DISCORD_SURFACE_TEST_FENCES: fenceLog, DISCORD_SURFACE_TEST_CHANNEL: 'from-lock-channel',
        DISCORD_SURFACE_TEST_CATEGORY: categoryId, DISCORD_SURFACE_TEST_TOPIC: marker,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' ') },
      timeout: 40000, encoding: 'utf8'
    });
    const refused = runPickup();
    assert.notEqual(refused.status, 0, 'accepted child work must refuse public transfer');
    const held = new SurfaceState(db);
    try {
      assert.equal(held.getBinding('from-lock-channel').nativeId, oldNativeId);
      assert.equal(held.getMessage('150').state, MESSAGE_STATES.ACCEPTED);
      held.claimDispatch('150'); held.markSubmitted('150');
      held.recordNativeReply({ provider: 'codex', messageId: '150', nativeId: oldNativeId, generation: 1, text: 'predecessor answer' });
      held.beginReply('150');
      held.markReplySent('150', 'predecessor-reply');
    } finally { held.close(); }
    const gap = runPickup();
    assert.notEqual(gap.status, 0, 'unrecorded child history before the fence must refuse public transfer');
    const gapState = new SurfaceState(db);
    try {
      const oldBinding = gapState.getBinding('from-lock-channel');
      assert.equal(oldBinding.nativeId, oldNativeId);
      assert.equal(oldBinding.generation, 1);
      const acceptedGap = gapState.acceptDiscordMessage({
        id: '160', channelId: 'child', guildId: 'guild-1', authorId: 'operator-1', content: 'recovered predecessor history'
      }, { ready: true, coverageId: '160', expectedBinding: oldBinding });
      assert.equal(acceptedGap.accepted, true);
      gapState.claimDispatch('160');
      gapState.markSubmitted('160');
      gapState.recordNativeReply({ provider: 'codex', messageId: '160', nativeId: oldNativeId, generation: 1, text: 'predecessor answer' });
      gapState.beginReply('160');
      gapState.markReplySent('160', 'predecessor-gap-reply');
    } finally { gapState.close(); }
    const result = runPickup();
    assert.equal(result.status, 0, result.stderr);
    const updated = new SurfaceState(db);
    const binding = updated.getBinding('from-lock-channel');
    assert.equal(binding.nativeId, successorNativeId);
    assert.equal(binding.generation, 2);
    assert.equal(binding.channelId, 'from-lock-channel');
    const fences = fs.readFileSync(fenceLog, 'utf8').trim().split('\n').map(JSON.parse);
    const cutoff = fences.at(-1).id;
    assert.equal(updated.getThreadEnrollment('child').active, true);
    assert.equal(updated.getThreadEnrollment('child').recoveredThroughId, cutoff);
    assert.equal(updated.getMessageRoute('child').handoffCutoffId, cutoff);
    const delayed = updated.acceptDiscordMessage({ id: '199', channelId: 'child', guildId: 'guild-1', authorId: 'operator-1', content: 'delayed predecessor' });
    assert.equal(delayed.accepted, false);
    assert.equal(delayed.reason, 'before-intake-cutoff');
    const { ChannelType } = require('discord.js');
    const delivered = [], sent = [];
    const channel = { id: 'from-lock-channel', guildId: 'guild-1', parentId: categoryId, type: ChannelType.GuildText, topic: marker,
      isThread: () => false, permissionsFor: () => historyPermissions(), async setTopic(topic) { this.topic = topic; },
      messages: { async fetch() { return []; } } };
    const child = { id: 'child', guildId: 'guild-1', parentId: channel.id, type: ChannelType.PublicThread, archived: false, locked: false,
      isThread: () => true, permissionsFor: () => historyPermissions(),
      async send(payload) { sent.push(payload); return { id: 'child-answer' }; },
      messages: { async fetch(options) { return typeof options === 'string' ? { async react() {} } : (BigInt(options.after || '0') < 203n ? [later] : []); } } };
    const later = { id: '203', channelId: child.id, guildId: 'guild-1', content: 'successor question', author: { id: 'operator-1', bot: false }, channel: child };
    const client = { user: { id: 'bot' }, on() {}, off() {}, async login() {}, async destroy() {},
      channels: { async fetch(id) { return id === child.id ? child : channel; } } };
    const gateway = new DiscordGateway({ state: updated, client, providers: { codex: {
      async dispatch(message) { delivered.push(message); recordNativeAcknowledgment(updated, { provider: 'codex', messageId: message.id, nativeId: message.nativeId, generation: message.generation }); return { status: 'submitted' }; },
      async observe() { return { text: 'successor answer' }; }
    } } });
    try {
      await gateway.start(secret);
      await gateway.reconcilePending(new Date().toISOString());
      await gateway.consumer.waitForNativeWork();
      await gateway.consumer.waitForReceipts();
      assert.equal(updated.getThreadEnrollment('child').active, true);
      assert.equal(updated.getMessage('203').state, MESSAGE_STATES.REPLIED);
      assert.equal(updated.getMessage('203').deliveryChannelId, child.id);
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].nativeId, successorNativeId);
      assert.equal(delivered[0].generation, 2);
      assert.ok(sent.some(payload => payload.content === 'successor answer'));
    } finally { await gateway.stop(); updated.close(); }
    if (operation === 'rebind') return;

    const retry = spawnSync(process.execPath, [CLI_PATH, 'handoff', '--state-dir', dir, '--db', db,
      '--from-lock', '--repo', repo, '--provider', 'codex', '--conductor-id', conductorId,
      '--repo-key', repoKey, '--native-id', successorNativeId, '--workspace', dir,
      '--session-file', transcript, '--worker-file', workerManifest], {
      env: {
        ...process.env, ...lockEnv, DISCORD_SURFACE_LOCK_SCRIPT: CONDUCTOR_LOCK,
        DISCORD_SURFACE_TEST_FENCES: fenceLog, DISCORD_SURFACE_TEST_CHANNEL: 'from-lock-channel', DISCORD_SURFACE_TEST_CATEGORY: categoryId, DISCORD_SURFACE_TEST_TOPIC: marker,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' ')
      }, timeout: 40000, stdio: 'ignore'
    });
    assert.equal(retry.status, 0);
    const reusedState = new SurfaceState(db);
    try {
      const reused = reusedState.getBinding('from-lock-channel');
      assert.equal(reused.generation, 2);
      assert.equal(reused.nativeId, successorNativeId);
    } finally { reusedState.close(); }

    const lockDocument = JSON.parse(fs.readFileSync(lockEnv.CONDUCTOR_LOCK_FILE, 'utf8'));
    const slot = lockDocument.repos[repoKey].vendors.codex;
    const releaseRow = slot.history.find(row => row.verb === 'release');
    releaseRow.verb = 'override';
    fs.writeFileSync(lockEnv.CONDUCTOR_LOCK_FILE, JSON.stringify(lockDocument), { mode: 0o600 });
    const forced = spawnSync(process.execPath, [CLI_PATH, 'handoff', '--state-dir', dir, '--db', db,
      '--from-lock', '--repo', repo, '--provider', 'codex', '--conductor-id', conductorId,
      '--repo-key', repoKey, '--native-id', successorNativeId, '--workspace', dir,
      '--session-file', transcript, '--worker-file', workerManifest], {
      env: {
        ...process.env, ...lockEnv, DISCORD_SURFACE_LOCK_SCRIPT: CONDUCTOR_LOCK,
        DISCORD_SURFACE_TEST_FENCES: fenceLog, DISCORD_SURFACE_TEST_CHANNEL: 'from-lock-channel', DISCORD_SURFACE_TEST_CATEGORY: categoryId, DISCORD_SURFACE_TEST_TOPIC: marker,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' ')
      }, timeout: 40000, stdio: 'ignore'
    });
    assert.notEqual(forced.status, 0);
  } finally {
    worker.kill('SIGTERM');
    await waitForProcessGone(worker.pid);
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('simulated: handoff gate survives parent termination until its child exits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-pickup-gate-'));
  const lockDir = path.join(dir, 'lock');
  const sessionRoot = path.join(dir, 'sessions');
  const workersDir = path.join(dir, 'workers');
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workersDir, { recursive: true, mode: 0o700 });
  const repo = 'https://github.com/example/discord-pickup.git';
  const repoKey = 'github.com/example/discord-pickup';
  const oldNativeId = CODEX_ID;
  const successorNativeId = SUCCESSOR_ID;
  const oldOwner = `session-codex-${oldNativeId.slice(0, 8)}`;
  const successorOwner = `session-codex-${successorNativeId.slice(0, 8)}`;
  const conductorId = 'conductor-gate.md';
  const beacon = path.join(lockDir, conductorId);
  const lockFile = path.join(lockDir, 'conductor.lock.json');
  const lockScript = path.join(dir, 'lock-readback.sh');
  const identity = { repo_key: repoKey, vendor: 'codex', beacon };
  const inspect = {
    repo_key: repoKey,
    vendor: 'codex',
    slot: {
      state: 'HELD',
      vendor: 'codex',
      beacon,
      owner: successorOwner,
      history: [
        { at: '2026-09-05T00:00:00Z', verb: 'release', who: oldOwner, note: 'release predecessor' },
        { at: '2026-09-05T00:01:00Z', verb: 'claim', who: successorOwner, note: 'claim successor' }
      ]
    }
  };
  const identityJson = JSON.stringify(identity);
  const inspectJson = JSON.stringify(inspect);
  fs.writeFileSync(lockScript, `#!/bin/sh
case "$5" in
  identity) printf '%s\\n' ${JSON.stringify(identityJson)} ;;
  inspect) printf '%s\\n' ${JSON.stringify(inspectJson)} ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  fs.writeFileSync(lockFile, '{}', { mode: 0o600 });
  fs.writeFileSync(beacon, 'beacon', { mode: 0o600 });
  const transcript = path.join(sessionRoot, `rollout-test-${successorNativeId}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'session_meta', payload: { id: successorNativeId } })}\n`, { mode: 0o600 });
  const worker = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(124), 7000)'], { cwd: dir, stdio: 'ignore' });
  const workerManifest = path.join(workersDir, `${successorOwner}.json`);
  const childStarted = path.join(dir, 'child-started');
  const childRelease = path.join(dir, 'child-release');
  const childDone = path.join(dir, 'child-done');
  const childScript = path.join(dir, 'commit-child.cjs');
  fs.writeFileSync(childScript, `
const fs = require('node:fs');
const waiter = new Int32Array(new SharedArrayBuffer(4));
fs.writeFileSync(process.env.DISCORD_SURFACE_GATE_CHILD_STARTED, String(process.pid));
const deadline = Date.now() + 5000;
while (!fs.existsSync(process.env.DISCORD_SURFACE_GATE_CHILD_RELEASE)) {
  if (Date.now() >= deadline) process.exit(124);
  Atomics.wait(waiter, 0, 0, 25);
}
fs.writeFileSync(process.env.DISCORD_SURFACE_GATE_CHILD_DONE, 'done');
`, { mode: 0o700 });
  const contenderScript = `
import fcntl, os, signal, sys
signal.alarm(5)
fd = os.open(sys.argv[1], os.O_RDONLY)
fcntl.flock(fd, fcntl.LOCK_EX)
with open(sys.argv[2], 'w', encoding='utf-8') as output:
    output.write('acquired')
`;
  const boundedGate = path.join(dir, 'bounded-gate.py');
  fs.writeFileSync(boundedGate, `import runpy, signal, sys
signal.alarm(7)
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
`);
  let gateStderr = '';
  let gate;
  let contender;
  let childPid = null;
  try {
    fs.writeFileSync(workerManifest, JSON.stringify({
      laneId: `${successorOwner}-9eaba20295e60eb88306d751eb0aeae1`, worktree: dir, state: 'active', harness: 'codex',
      sessionId: successorNativeId, fullUUID: successorNativeId, pid: worker.pid,
      processStartTime: processStartTime(worker.pid), generation: 1
    }), { mode: 0o600 });
    gate = spawn(process.env.DISCORD_SURFACE_PYTHON || 'python3', [boundedGate, path.resolve(__dirname, '../src/conductor-lock-gate.py'),
      '--lock-script', lockScript, '--repo', repo, '--repo-key', repoKey, '--provider', 'codex',
      '--conductor-id', conductorId, '--channel-id', 'gate-channel', '--from-native-id', oldNativeId,
      '--from-generation', '1', '--from-workspace', dir, '--native-id', successorNativeId,
      '--workspace', dir, '--session-file', transcript, '--worker-file', workerManifest,
      '--node-path', process.execPath, '--cli-path', childScript, '--state-dir', path.join(dir, 'state'),
      '--db', path.join(dir, 'state.sqlite')], {
      env: {
        ...process.env,
        CONDUCTOR_LOCK_FILE: lockFile,
        CONDUCTOR_CODEX_SESSIONS_DIR: sessionRoot,
        DISCORD_SURFACE_GATE_CHILD_STARTED: childStarted,
        DISCORD_SURFACE_GATE_CHILD_RELEASE: childRelease,
        DISCORD_SURFACE_GATE_CHILD_DONE: childDone
      }, stdio: ['ignore', 'ignore', 'pipe']
    });
    gate.stderr.setEncoding('utf8');
    gate.stderr.on('data', chunk => { gateStderr += chunk; });
    try {
      await waitForFile(childStarted, 2000);
    } catch (error) {
      error.message += `; gate stderr: ${gateStderr}`;
      throw error;
    }
    childPid = Number(fs.readFileSync(childStarted, 'utf8'));
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    gate.kill('SIGTERM');
    const gateExit = await waitForChild(gate);
    assert.equal(gateExit.signal, 'SIGTERM');

    const acquired = path.join(dir, 'writer-acquired');
    contender = spawn(process.env.DISCORD_SURFACE_PYTHON || 'python3', ['-c', contenderScript, lockDir, acquired], { stdio: 'ignore' });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(fs.existsSync(acquired), false);
    fs.writeFileSync(childRelease, 'release');
    await waitForFile(childDone, 2000);
    await waitForProcessGone(childPid, 2000);
    const contenderExit = await waitForChild(contender);
    assert.equal(contenderExit.code, 0);
    assert.equal(fs.existsSync(acquired), true);
  } finally {
    fs.writeFileSync(childRelease, 'release');
    if (gate?.exitCode === null) gate.kill('SIGTERM');
    if (contender?.exitCode === null) contender.kill('SIGTERM');
    if (gate?.exitCode === null) await waitForChild(gate).catch(() => {});
    if (contender?.exitCode === null) await waitForChild(contender).catch(() => {});
    if (!childPid && fs.existsSync(childStarted)) childPid = Number(fs.readFileSync(childStarted, 'utf8'));
    if (childPid) {
      try { process.kill(childPid, 'SIGTERM'); } catch {}
      await waitForProcessGone(childPid).catch(() => {});
    }
    if (worker.exitCode === null) worker.kill('SIGTERM');
    if (worker.exitCode === null) await waitForChild(worker).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
