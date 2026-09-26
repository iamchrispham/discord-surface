'use strict';

// Shared builder for the PR109 binding-retirement suites.
//
// Everything here is disposable and synchronous: a temp-directory SQLite state
// plus one extra connection on the same file (bounded two-connection fixture),
// fake transport, receipt seeders, and a transaction-depth sentinel that proves
// a guard exists *inside* a mutation transaction rather than only at its outer
// precheck. No sleeps, no polling, no network.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { SurfaceState } = require('../../src/state');
const { runDirectPost } = require('../../src/direct-post');

const CODEX_A = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const CODEX_B = '79e3da8e-94b4-4aff-8f88-b45b3a451dd1';
const CODEX_C = '2f1c6e5a-57d1-4d0e-8c2f-6b6f6d0a9e11';
const CLAUDE_A = '11111111-1111-1111-1111-111111111111';
const CLAUDE_B = '22222222-2222-2222-2222-222222222222';
const CONDUCTOR = 'fixture-conductor';
const REPO = 'repo:fixture';
const GUILD = 'guild';
const JOURNAL = 'direct-post-v1';

function createFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-retirement-'));
  const dbPath = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(dbPath);
  const second = new SurfaceState(dbPath);
  const config = { operatorId: 'operator', guildId: GUILD, secretFile: path.join(dir, 'secret') };
  state.setConfig(config);
  t.after(() => {
    try { state.close(); } catch {}
    try { second.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, state, second, config };
}

function bindConductor(f, channelId = '101', nativeId = CODEX_A, provider = 'codex') {
  return f.state.bind({
    channelId, guildId: GUILD, provider, nativeId, workspace: f.dir,
    conductorId: CONDUCTOR, repoKey: REPO,
    ...(provider === 'claude' ? { endpoint: path.join(f.dir, `${channelId}.sock`) } : {})
  });
}

function bindOrdinary(f, channelId = '201', nativeId = CODEX_A) {
  return f.state.bindOrdinary({
    channelId, guildId: GUILD, provider: 'codex', nativeId, workspace: f.dir
  }, { sessionId: nativeId, threadId: nativeId });
}

function bindOrdinaryClaude(f, channelId = '202', nativeId = CLAUDE_A) {
  return f.state.bindOrdinaryClaude({
    channelId, guildId: GUILD, provider: 'claude', nativeId,
    workspace: f.dir, endpoint: path.join(f.dir, `${channelId}.sock`)
  }, { sessionId: nativeId, threadId: nativeId, harness: 'claude-code' });
}

function enroll(f, parentChannelId, threadId = '102') {
  const binding = f.state.getBinding(parentChannelId);
  f.state.enrollThread({ threadId, parentChannelId, guildId: GUILD }, binding);
  f.state.markThreadBoundary(threadId, 'ready', 'fixture', null, null, binding);
  return binding;
}

// Real queued, undispatched owner work: accepted but not yet claimed. This
// selects rebindOrdinary's root-relocation branch through hasUnresolved while
// the direct-post classifier itself stays clear outside the transaction.
function seedQueuedWork(state, channelId, id = `queued-${channelId}`) {
  const accepted = state.acceptDiscordMessage({
    id, guildId: GUILD, channelId, authorId: 'operator', isBot: false, content: 'queued work'
  });
  assert.equal(accepted.accepted, true, 'queued work was accepted');
  return accepted.message;
}

function textFile(f, name, text = 'held publication') {
  const target = path.join(f.dir, name);
  fs.writeFileSync(target, text);
  return target;
}

function seedAttempt(state, detail) {
  state.receipt(null, 'direct-post-attempt', { journal: JOURNAL, ...detail });
}

function seedOutcome(state, detail, outcome, extra = {}) {
  state.receipt(null, 'direct-post-outcome', { journal: JOURNAL, ...detail, outcome, ...extra });
}

function captureCustody(state, channelId) {
  return {
    binding: state.getBinding(channelId),
    enrollments: state.listThreadEnrollments(channelId),
    watermark: state.getIntakeWatermark(channelId),
    messages: state.listMessages(),
    receipts: state.listReceipts()
  };
}

function assertCustodyUnchanged(state, channelId, before) {
  assert.deepEqual(state.getBinding(channelId), before.binding, 'binding identity must be unchanged');
  assert.deepEqual(state.listThreadEnrollments(channelId), before.enrollments, 'thread enrollments must be unchanged');
  assert.deepEqual(state.getIntakeWatermark(channelId), before.watermark, 'intake watermark must be unchanged');
  assert.deepEqual(state.listMessages(), before.messages, 'messages must be unchanged');
  assert.deepEqual(state.listReceipts(), before.receipts, 'receipts must be unchanged');
}

// Report unresolved only while a real transaction callback is executing. There
// is no outer override: every classifier read outside a transaction is false,
// so a guard that exists only at an outer precheck cannot pass this sentinel.
function sentinel(state) {
  const original = state.transaction.bind(state);
  let depth = 0;
  state.transaction = operation => {
    depth += 1;
    try { return original(operation); } finally { depth -= 1; }
  };
  state.hasUnresolvedBindingPost = () => depth > 0;
  return state;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Run a real direct post and hold the network POST open once the attempt is
// admitted, so mutation owners can be exercised against live unresolved custody.
async function heldPost(t, f, { channelId, nativeId, generation, provider = 'codex', ordinary = false, dedupeKey }) {
  const entered = deferred();
  const release = deferred();
  let posts = 0;
  const file = textFile(f, `${dedupeKey}.txt`);
  const pending = runDirectPost({
    state: f.state, token: 'fixture', nativeId, generation, channelId, provider, ordinary,
    textFile: file, dedupeKey,
    fetchImpl: async (_url, options) => {
      if (options.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ id: channelId, guild_id: GUILD }) };
      }
      posts += 1;
      entered.resolve();
      await release.promise;
      return { ok: true, status: 200, json: async () => ({ id: `sent-${posts}` }) };
    }
  });
  t.after(() => release.resolve());
  await entered.promise;
  return { pending, release: release.resolve, posts: () => posts };
}

function rebindRequest(f, channelId, nativeId = CODEX_B, provider = 'codex', endpoint = null) {
  return {
    channelId, guildId: GUILD, provider, nativeId, workspace: f.dir, conductorId: CONDUCTOR, repoKey: REPO,
    ...(provider === 'claude' ? { endpoint: endpoint || path.join(f.dir, `${channelId}.sock`) } : {})
  };
}

function ordinaryRebindRequest(f, binding) {
  return {
    channelId: binding.channelId, guildId: GUILD, provider: binding.provider, nativeId: binding.nativeId,
    workspace: f.dir, ordinaryIdentity: { sessionId: binding.nativeId, threadId: binding.nativeId, harness: 'claude-code' },
    ...(binding.provider === 'claude' ? { endpoint: binding.endpoint } : {})
  };
}

function handoffConductorRequest(f, binding, nativeId = CODEX_B, overrides = {}) {
  return {
    channelId: binding.channelId, provider: binding.provider, conductorId: CONDUCTOR, repoKey: REPO,
    fromNativeId: binding.nativeId, fromGeneration: binding.generation, nativeId, workspace: f.dir,
    endpoint: binding.endpoint || null, handoffId: `conductor-handoff-${nativeId}`, ...overrides
  };
}

function ordinaryRelocation(f, binding, nativeId = CODEX_A) {
  const root = path.join(f.dir, `relocation-${nativeId}`);
  return {
    request: {
      provider: 'codex', channelId: binding.channelId, guildId: GUILD, nativeId,
      workspace: f.dir, sessionRoot: root, identity: { sessionId: nativeId, threadId: nativeId }
    },
    proof: {
      file: path.join(root, `${nativeId}.jsonl`), sessionId: nativeId, threadId: nativeId,
      workspace: f.dir, sessionRoot: root
    }
  };
}

function ordinaryHandoff(f, binding, nativeId = CODEX_B, overrides = {}) {
  const root = path.join(f.dir, `handoff-${nativeId}`);
  return {
    channelId: binding.channelId, provider: 'codex',
    fromNativeId: binding.nativeId, fromGeneration: binding.generation, nativeId,
    workspace: f.dir, sessionRoot: root, handoffId: `ordinary-handoff-${nativeId}`,
    identity: { sessionId: nativeId, threadId: nativeId },
    nativeProof: {
      file: path.join(root, `${nativeId}.jsonl`), sessionId: nativeId, threadId: nativeId,
      workspace: f.dir, sessionRoot: root
    },
    ...overrides
  };
}

module.exports = {
  CODEX_A, CODEX_B, CODEX_C, CLAUDE_A, CLAUDE_B, CONDUCTOR, REPO, GUILD, JOURNAL,
  createFixture, bindConductor, bindOrdinary, bindOrdinaryClaude, enroll, seedQueuedWork, textFile,
  seedAttempt, seedOutcome, captureCustody, assertCustodyUnchanged,
  sentinel, heldPost, rebindRequest, ordinaryRebindRequest, handoffConductorRequest,
  ordinaryRelocation, ordinaryHandoff
};
