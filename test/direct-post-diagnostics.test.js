const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SurfaceState } = require('../src/state');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-diagnostics-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'unused') });
  state.bind({ channelId: 'channel', guildId: 'guild', provider: 'codex',
    nativeId: '9caa5d21-2169-429d-918b-5f08651b5dbd', workspace: dir,
    conductorId: 'conductor', repoKey: 'repo:fixture' });
  const binding = state.getBinding('channel');
  const meta = { requestId: 'request', attemptId: 'attempt', inReplyTo: null,
    sourcePath: path.join(dir, 'source'), textHash: 'text', operatorId: 'operator',
    partHash: 'part', ...binding, binding, partIndex: 0, partCount: 1, nonce: 'nonce' };
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { state, meta };
}

for (const boundary of ['preflight', 'outcome']) {
  test(`${boundary} refuses diagnostic custody collisions without writing`, t => {
    const { state, meta } = fixture(t);
    if (boundary === 'outcome') assert.equal(state.beginDirectPostPart(meta).claimed, true);
    const record = detail => boundary === 'preflight'
      ? state.recordDirectPostPreflight(meta, 'not_sent', detail)
      : state.recordDirectPostOutcome(meta.requestId, meta.attemptId, 'unknown', detail);
    const keys = ['requestId', 'attemptId', 'sourcePath', 'textHash', 'operatorId', 'partHash',
      'channelId', 'guildId', 'provider', 'nativeId', 'generation', 'conductorId', 'repoKey', 'inReplyTo', 'partIndex', 'partCount',
      'nonce', 'binding', 'journal', 'ownerPid', 'ownerStartTime', 'ownerCommand',
      'routingVersion', 'presentation', 'deliveryChannelId', 'agentPacket', 'legacyAgentPacket',
      'agentRequestTarget', 'watcherNotice', 'caption', 'fileManifest', 'outcome'];
    const before = state.listReceipts();
    for (const key of keys) {
      const broadRecord = { reason: 'diagnostic', [key]: 'changed' };
      assert.throws(() => record(broadRecord), /cannot override immutable/, key);
      assert.deepEqual(state.listReceipts(), before, key);
    }
    const result = record({ reason: 'transport failure', status: 503, error: 'unavailable' });
    assert.equal(result.requestId, meta.requestId);
    assert.equal(result.nonce, meta.nonce);
    assert.equal(result.status, 503);
    assert.equal(result.error, 'unavailable');
    assert.equal(state.directPostRows(meta.requestId).length, boundary === 'outcome' ? 2 : 1);
  });

  test(`${boundary} stores the diagnostic snapshot it validated`, t => {
    const { state, meta } = fixture(t);
    if (boundary === 'outcome') state.beginDirectPostPart(meta);
    let reads = 0;
    const detail = { get channelId() { return ++reads === 1 ? meta.channelId : 'foreign'; }, messageId: 'sent-message' };
    const result = boundary === 'preflight'
      ? state.recordDirectPostPreflight(meta, 'sent', detail)
      : state.recordDirectPostOutcome(meta.requestId, meta.attemptId, 'sent', detail);
    assert.equal(reads, 1);
    assert.equal(result.channelId, meta.channelId);
    assert.equal(result.messageId, 'sent-message');
    if (boundary === 'outcome') {
      const before = state.listReceipts().length;
      assert.deepEqual(state.recordDirectPostOutcome(meta.requestId, meta.attemptId, 'sent', { messageId: 'different' }), result);
      assert.equal(state.listReceipts().length, before);
    }
  });

  test(`${boundary} rejects diagnostic serializers before persistence`, t => {
    const { state, meta } = fixture(t);
    if (boundary === 'outcome') state.beginDirectPostPart(meta);
    const record = detail => boundary === 'preflight'
      ? state.recordDirectPostPreflight(meta, 'not_sent', detail)
      : state.recordDirectPostOutcome(meta.requestId, meta.attemptId, 'unknown', detail);
    const beforeReceipts = state.listReceipts();
    const beforeRows = state.directPostRows(meta.requestId);
    const detail = {
      reason: 'diagnostic',
      toJSON() {
        return { journal: 'foreign', requestId: 'foreign' };
      }
    };
    assert.throws(() => record(detail), /cannot define toJSON/);
    assert.deepEqual(state.listReceipts(), beforeReceipts);
    assert.deepEqual(state.directPostRows(meta.requestId), beforeRows);
    assert.equal(state.directPostRows('foreign').length, 0);
  });

  test(`${boundary} freezes nested custody before receipt serialization`, t => {
    const { state, meta } = fixture(t);
    if (boundary === 'outcome') state.beginDirectPostPart(meta);
    let reads = 0;
    const detail = {
      binding: {
        ...meta.binding,
        get readiness() {
          return ++reads === 1 ? meta.binding.readiness : 'changed';
        }
      }
    };
    const result = boundary === 'preflight'
      ? state.recordDirectPostPreflight(meta, 'sent', detail)
      : state.recordDirectPostOutcome(meta.requestId, meta.attemptId, 'sent', detail);
    assert.equal(reads, 1);
    assert.equal(result.binding.readiness, meta.binding.readiness);
  });
}

test('preflight freezes metadata before diagnostic accessors run', t => {
  const { state, meta } = fixture(t);
  const requestId = meta.requestId;
  const channelId = meta.channelId;
  const detail = {
    get reason() {
      meta.requestId = 'foreign-request';
      meta.channelId = 'foreign-channel';
      return 'diagnostic';
    }
  };
  const result = state.recordDirectPostPreflight(meta, 'not_sent', detail);
  assert.equal(result.requestId, requestId);
  assert.equal(result.channelId, channelId);
  assert.equal(state.directPostRows(requestId).length, 1);
  assert.equal(state.directPostRows('foreign-request').length, 0);
});
