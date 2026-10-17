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
function defaultWorkerEnv(home) {
  const env = {
    ...process.env,
    HOME: home,
    PYTHONPATH: path.join(__dirname, '..', 'src')
  };
  delete env.CONDUCTOR_WORKERS_DIR;
  return env;
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
function runPythonGate(body, args, env = {}) {
  return spawnSync(PYTHON, ['-c', `
import sys
import conductor_worker_proof as proof
try:
    ${body}
except proof.GateError as error:
    print(f'REFUSED: {error}', file=sys.stderr)
    sys.exit(2)
`, ...args], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PYTHONPATH: path.join(__dirname, '..', 'src'), ...env }
  });
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
    pid: predecessor.pid, processStartTime: 1700000000, generation: 1
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
module.exports = { runScenario, defaultWorkerEnv, assertRefused, assertCommitted, runPythonGate, fakeDiscordPreload, runPublicPickup, buildStealFixture, fakeDiscordClient, lockEnvFor };
