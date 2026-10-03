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

test('Codex peer caller matches UUIDs without changing stored spelling', async () => {
  const f = fixture();
  f.rows[0].nativeId = '9CAA5D21-2169-429D-918B-5F08651B5DBD';
  const caller = await resolvePeerCaller(f.state, 'codex', {
    environment: { CODEX_THREAD_ID: '9caa5d21-2169-429d-918b-5f08651b5dbd' }
  });
  assert.equal(caller.nativeId, f.rows[0].nativeId);
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

test('Claude peer caller resolution observes shutdown cancellation', async () => {
  const f = fixture('claude');
  const stop = new AbortController();
  const pending = resolvePeerCaller(f.state, 'claude', { resolveClaudeCaller: () => new Promise(() => {}) }, stop.signal);
  stop.abort();
  await assert.rejects(pending, /aborted|closing/);
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

function countingState(f) {
  const counts = { listBindings: 0 };
  return {
    counts,
    state: { requireConfig: () => ({ guildId: '100' }), listBindings: () => { counts.listBindings++; return f.rows; } }
  };
}

test('Codex injected resolver exclusively selects identity over conflicting environment', async () => {
  const f = fixture();
  const stop = new AbortController();
  let received;
  const caller = await resolvePeerCaller(f.state, 'codex', {
    environment: { CODEX_THREAD_ID: other },
    resolveCodexCaller: signal => { received = signal; return { sessionId: id, threadId: id, turnId: 't1' }; }
  }, stop.signal);
  assert.strictEqual(received, stop.signal);
  assert.equal(caller.nativeId, id);
});

test('Codex injected resolver is invoked again and selects the new binding generation', async () => {
  const f = fixture();
  let calls = 0;
  const dependencies = { resolveCodexCaller: () => { calls++; return { sessionId: id, threadId: id, turnId: 't1' }; } };
  assert.equal((await resolvePeerCaller(f.state, 'codex', dependencies)).generation, 1);
  f.rows[0].generation = 2;
  assert.equal((await resolvePeerCaller(f.state, 'codex', dependencies)).generation, 2);
  f.rows[0].generation = 3;
  assert.equal((await resolvePeerCaller(f.state, 'codex', dependencies)).generation, 3);
  assert.equal(calls, 3);
});

test('Codex injected resolver rejection propagates despite valid environment data', async () => {
  const f = fixture();
  const { state, counts } = countingState(f);
  const refusal = new Error('trusted resolver refused');
  await assert.rejects(
    resolvePeerCaller(state, 'codex', {
      environment: { CODEX_THREAD_ID: id },
      resolveCodexCaller: () => { throw refusal; }
    }),
    error => { assert.strictEqual(error, refusal); return true; }
  );
  assert.equal(counts.listBindings, 0);
});

test('Codex injected resolver refuses missing, empty or conflicting turn identity before binding lookup', async () => {
  const f = fixture();
  const { state, counts } = countingState(f);
  const candidates = [
    { sessionId: id, threadId: id },
    { sessionId: id, threadId: id, turnId: '' },
    { sessionId: id, threadId: id, turnId: '   ' },
    { sessionId: id, threadId: id, turnId: 5 },
    { sessionId: id, turnId: 't1' },
    { sessionId: id, threadId: other, turnId: 't1' },
    { threadId: id, turnId: 't1' }
  ];
  for (const identity of candidates) {
    await assert.rejects(
      resolvePeerCaller(state, 'codex', { resolveCodexCaller: () => identity }),
      /turn identity is unavailable or conflicting/
    );
  }
  assert.equal(counts.listBindings, 0);
});

test('Codex nonfunction injected resolver refuses despite valid environment data', async () => {
  const f = fixture();
  for (const resolveCodexCaller of [{}, 'x', null]) {
    await assert.rejects(
      resolvePeerCaller(f.state, 'codex', { environment: { CODEX_THREAD_ID: id }, resolveCodexCaller }),
      /must be a function/
    );
  }
});

test('Codex pending injected resolution observes cancellation', async () => {
  const f = fixture();
  const stop = new AbortController();
  const pending = resolvePeerCaller(f.state, 'codex', { resolveCodexCaller: () => new Promise(() => {}) }, stop.signal);
  stop.abort();
  await assert.rejects(pending, /aborted|closing/);
});

test('Codex already-aborted resolution invokes no injected resolver and no binding lookup', async () => {
  const f = fixture();
  const { state, counts } = countingState(f);
  const stop = new AbortController();
  stop.abort();
  let calls = 0;
  await assert.rejects(
    resolvePeerCaller(state, 'codex', { resolveCodexCaller: () => { calls++; return { sessionId: id, threadId: id, turnId: 't1' }; } }, stop.signal),
    /aborted|closing/
  );
  assert.equal(calls, 0);
  assert.equal(counts.listBindings, 0);
});

test('Claude already-aborted resolution invokes no native resolver and no binding lookup', async () => {
  const f = fixture('claude');
  const { state, counts } = countingState(f);
  const stop = new AbortController();
  stop.abort();
  let calls = 0;
  await assert.rejects(
    resolvePeerCaller(state, 'claude', { resolveClaudeCaller: () => { calls++; return { harness: 'claude-code', sessionId: id }; } }, stop.signal),
    /aborted|closing/
  );
  assert.equal(calls, 0);
  assert.equal(counts.listBindings, 0);
});
