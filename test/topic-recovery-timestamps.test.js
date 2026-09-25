const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { READINESS } = require('../src/state');
const { CODEX_ID, fixture } = require('./surface-fixtures');

function seededRecovery(t) {
  const { dir, db, state } = fixture();
  t.after(() => {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const channelId = 'topic-time-proof';
  const oldTopic = 'old topic';
  const desiredTopic = 'new topic';
  state.bind({ channelId, guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'topic-time-proof', repoKey: 'repo:alpha' });
  const binding = state.getBinding(channelId);
  const custody = state.beginTopicPublication(channelId, { desiredReadiness: READINESS.READY, desiredTopic }, binding);
  state.recordTopicPublication(channelId, { requestId: custody.requestId, desiredReadiness: READINESS.READY, outcome: 'unknown', remoteTerminal: true, observedTopic: oldTopic }, binding);
  const endedAt = state.getTopicPublication(custody.requestId).operationEndedAt;
  const instant = new Date(Date.parse(endedAt) + 1000).toISOString();
  const offsetInput = new Date(Date.parse(instant) + 3_600_000).toISOString().replace(/Z$/, '+01:00');
  return { state, db, channelId, requestId: custody.requestId, oldTopic, instant, offsetInput };
}

function recover(input, observedAt, tz = 'UTC') {
  return spawnSync(process.execPath, [
    path.join(__dirname, '../src/cli.js'), 'recover', '--db', input.db,
    '--topic-channel-id', input.channelId,
    '--topic-request-id', input.requestId,
    '--resolution', 'not_published',
    '--evidence-scope', 'fresh Discord GET after terminal publication',
    '--topic-readback', input.oldTopic,
    '--topic-readback-at', observedAt
  ], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, TZ: tz } });
}

test('topic recovery refuses ambiguous and invalid instants before custody changes', t => {
  const input = seededRecovery(t);
  const before = input.state.listReceipts();
  for (const observedAt of [
    input.instant.slice(0, -1),
    '2026-02-30T00:00:01Z',
    '2026-01-01T00:00:01-00:00',
    '2026-01-01T00:00:01+24:00'
  ]) {
    const child = recover(input, observedAt);
    assert.notEqual(child.status, 0, observedAt);
    assert.match(child.stderr, /readback\.observedAt must be a timezone-qualified ISO timestamp/);
    assert.equal(input.state.getTopicPublication(input.requestId).status, 'unknown');
    assert.deepEqual(input.state.listReceipts(), before);
  }
});

test('topic recovery normalizes an offset identically across host timezones', t => {
  for (const tz of ['UTC', 'America/Los_Angeles']) {
    const input = seededRecovery(t);
    const child = recover(input, input.offsetInput, tz);
    assert.equal(child.status, 0, child.stderr);
    const custody = input.state.getTopicPublication(input.requestId);
    assert.equal(custody.status, 'not_published');
    assert.equal(custody.readbackAt, input.instant);
    const receipt = input.state.listReceipts().filter(row => row.kind === 'topic-publication-reconciled').at(-1);
    assert.equal(JSON.parse(receipt.detail).readbackAt, input.instant);
  }
});
