const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { CLAUDE, fixture } = require('./fixture.cjs');
const { createOrdinaryClaudeBindingHandlers } = require('../../src/state/ordinary-binding-claude.js');

test('ordinary Claude binding owner rejects invalid proofs and preserves state on refusal', t => {
  const f = fixture(t, { preflight: false });
  const { binding, dir, session, socketPath, state } = f;
  const proof = {
    file: session.file, sessionId: CLAUDE, threadId: CLAUDE, workspace: dir, endpoint: socketPath
  };
  const mismatch = /ordinary Claude native preflight proof does not match the binding/;

  assert.throws(() => state.recordOrdinaryPreflight(binding, { ...proof, harness: 'codex' }), mismatch);
  assert.equal(state.hasOrdinaryPreflight(binding), false);

  assert.throws(() => state.recordOrdinaryPreflight(binding, {
    ...proof, endpoint: path.join(dir, 'other.sock'), harness: 'claude-code'
  }), mismatch);
  assert.equal(state.hasOrdinaryPreflight(binding), false);

  const recorded = state.recordOrdinaryPreflight(binding, { ...proof, harness: 'claude-code' });
  assert.ok(recorded);
  assert.equal(state.hasOrdinaryPreflight(binding), true);

  const classifyRecord = state._isOrdinaryBindingRecord;
  const classifyActive = state._isOrdinaryBinding;
  const beforeOverride = state.listReceipts().length;
  try {
    state._isOrdinaryBindingRecord = () => false;
    assert.equal(state.isOrdinaryBinding(binding), false);
    state._isOrdinaryBindingRecord = classifyRecord;
    state._isOrdinaryBinding = () => false;
    assert.equal(state.hasOrdinaryPreflight(binding), false);
    assert.throws(() => state.recordOrdinaryPreflight(binding, { ...proof, harness: 'claude-code' }), /not an ordinary/);
    assert.equal(state.listReceipts().length, beforeOverride);
  } finally {
    state._isOrdinaryBindingRecord = classifyRecord;
    state._isOrdinaryBinding = classifyActive;
  }

  assert.equal(state._isOrdinaryBindingRecord({ ...binding, provider: 'unknown-provider' }), false);
  assert.equal(state._isOrdinaryBinding({ ...binding, provider: 'unknown-provider' }), false);
  assert.equal(state._recordOrdinaryPreflight(
    { ...binding, provider: 'unknown-provider', generation: binding.generation + 1 },
    { ...proof, harness: 'claude-code' }
  ), null);

  assert.throws(() => state._bindOrdinaryClaude({
    channelId: 'conductor-claude', guildId: 'guild', provider: 'claude', nativeId: CLAUDE,
    workspace: dir, endpoint: socketPath, conductorId: 'conductor', repoKey: 'repo'
  }, { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' }, '100'), /ordinary bindings cannot carry conductor identity/);
  assert.equal(state.getBinding('conductor-claude'), null);

  state.unbind(binding.channelId);
  const tombstone = state.getBinding(binding.channelId);
  const receiptsBeforeRebind = state.listReceipts().length;
  try {
    state._isOrdinaryBindingRecord = () => false;
    assert.throws(() => state.rebindOrdinaryClaude(binding,
      { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' }, '100'), /tombstone is unavailable/);
    assert.deepEqual(state.getBinding(binding.channelId), tombstone);
    assert.equal(state.listReceipts().length, receiptsBeforeRebind);
  } finally { state._isOrdinaryBindingRecord = classifyRecord; }
});

test('ordinary Claude handler rejects a Codex record before writing preflight receipts', () => {
  class BindingError extends Error {}
  const handlers = createOrdinaryClaudeBindingHandlers({
    BindingError,
    PROVIDERS: { CLAUDE: 'claude' },
    READINESS: { PENDING: 'pending' },
    assertOrdinaryIdentity() {},
    assertOrdinaryNativeIdentity() {},
    bindingMatchesExpected(current, expected) { return current?.channelId === expected?.channelId; }
  });
  const binding = {
    channelId: 'codex-channel', provider: 'codex', active: true, conductorId: null, repoKey: null,
    nativeId: CLAUDE, workspace: '/tmp/codex-workspace', endpoint: '/tmp/codex.sock'
  };
  const receipts = [];
  const state = {
    getBinding() { return binding; },
    transaction(work) { return work(); },
    _isOrdinaryBinding() { return true; },
    receipt(...args) { receipts.push(args); }
  };

  assert.throws(() => handlers.recordOrdinaryPreflight(state, binding, {
    file: '/tmp/session.jsonl', sessionId: CLAUDE, threadId: CLAUDE,
    workspace: binding.workspace, harness: 'claude-code', endpoint: binding.endpoint
  }), /ordinary codex binding/);
  assert.equal(receipts.length, 0);
});
