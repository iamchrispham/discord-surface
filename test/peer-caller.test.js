const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePeerCaller } = require('../src/peer/caller');
const id = '11111111-1111-1111-1111-111111111111';
const other = '22222222-2222-2222-2222-222222222222';
function fixture(provider = 'codex') {
  const rows = [{ active: true, guildId: '100', provider, nativeId: id, generation: 1, channelId: '101' }];
  return { rows, state: { requireConfig: () => ({ guildId: '100' }), listBindings: () => rows } };
}

test('Codex peer caller requires matching native invocation identifiers', async () => {
  const f = fixture();
  assert.equal((await resolvePeerCaller(f.state, 'codex', { environment: { CODEX_THREAD_ID: id } })).nativeId, id);
  await assert.rejects(resolvePeerCaller(f.state, 'codex', { environment: {} }), /CODEX_SESSION_ID/);
  await assert.rejects(resolvePeerCaller(f.state, 'codex', { environment: { CODEX_THREAD_ID: id, CODEX_SESSION_ID: other } }), /conflict/);
  await assert.rejects(resolvePeerCaller(f.state, 'codex', { environment: { CODEX_THREAD_ID: other } }), /no active binding/);
});

test('Claude peer caller rechecks the native resolver and binding on every call', async () => {
  const f = fixture('claude'); let current = id;
  const dependencies = { resolveClaudeCaller: async () => ({ harness: 'claude-code', sessionId: current }) };
  assert.equal((await resolvePeerCaller(f.state, 'claude', dependencies)).generation, 1);
  f.rows[0].generation = 2;
  assert.equal((await resolvePeerCaller(f.state, 'claude', dependencies)).generation, 2);
  current = other;
  await assert.rejects(resolvePeerCaller(f.state, 'claude', dependencies), /no active binding/);
  await assert.rejects(resolvePeerCaller(f.state, 'claude', { resolveClaudeCaller: async () => ({ harness: 'codex', sessionId: id }) }), /wrong harness/);
});

test('ambiguous, foreign guild, inactive and wrong-provider bindings never authorize', async () => {
  const f = fixture(); const dependencies = { environment: { CODEX_THREAD_ID: id } };
  f.rows.push({ ...f.rows[0], channelId: '102' });
  await assert.rejects(resolvePeerCaller(f.state, 'codex', dependencies), /ambiguous/);
  f.rows.pop(); f.rows[0].guildId = '200';
  await assert.rejects(resolvePeerCaller(f.state, 'codex', dependencies), /no active binding/);
  f.rows[0].guildId = '100'; f.rows[0].active = false;
  await assert.rejects(resolvePeerCaller(f.state, 'codex', dependencies), /no active binding/);
  f.rows[0].active = true; f.rows[0].provider = 'claude';
  await assert.rejects(resolvePeerCaller(f.state, 'codex', dependencies), /no active binding/);
});
