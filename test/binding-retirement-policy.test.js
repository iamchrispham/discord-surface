'use strict';

// PR109 T1-T3: policy behavior for binding retirement across unresolved
// direct-post custody. Real SurfaceState, real classifier, fake transport.
// Assertions are semantic (identity, custody rows, error ownership). Cited:
// test/direct-post-attempt-projection.test.js proves multipart part resolution;
// test/ordinary-codex-handoff.test.js proves ordinary handoff refusal.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runDirectPost } = require('../src/direct-post');
const {
  CODEX_A, CODEX_B, CODEX_C, CLAUDE_A, CLAUDE_B, GUILD, createFixture, bindConductor,
  bindOrdinary, bindOrdinaryClaude, enroll, seedQueuedWork, seedAttempt, seedOutcome,
  captureCustody, assertCustodyUnchanged, sentinel, heldPost, textFile,
  rebindRequest, ordinaryRebindRequest, handoffConductorRequest, ordinaryRelocation, ordinaryHandoff
} = require('./helpers/binding-retirement-fixture');

function plainAttempt(overrides) {
  return {
    requestId: 'seed-request', channelId: '101', provider: 'codex', conductorId: null,
    repoKey: null, attemptId: 'seed-attempt', partIndex: 0, partCount: 1, ...overrides
  };
}

function heldArgs(channelId, binding, provider, ordinary = false) {
  return { channelId, nativeId: binding.nativeId, generation: binding.generation, provider, ordinary, dedupeKey: `held-${channelId}` };
}

// T1/T3: one independent fixture per mutation owner. While the admitted POST is
// held, the owner must refuse with unchanged custody; after the same request
// completes, the identical intended mutation must succeed. Conductor-Claude
// unbind is already covered by test/binding-retirement-custody.test.js.
const REBIND_PATTERN = /cannot rebind while a publication is unresolved/;
const UNBIND_PATTERN = /cannot unbind while work is unresolved/;
const HANDOFF_PATTERN = /cannot handoff while work is unresolved/;
const RELOCATION_PATTERN = /ordinary binding root relocation has unresolved post custody/;

function heldRow(name, channelId, provider, ordinary, bind, pattern, refuse, succeed) {
  return {
    name,
    setup(f) {
      const binding = bind(f);
      return {
        channelId, binding, held: heldArgs(channelId, binding, provider, ordinary), pattern,
        refuse: () => refuse(f, binding), succeed: () => succeed(f, binding)
      };
    }
  };
}

const HELD_ROWS = [
  heldRow('rebind conductor codex', '101', 'codex', false,
    f => bindConductor(f, '101', CODEX_A, 'codex'), REBIND_PATTERN,
    f => f.state.rebind(rebindRequest(f, '101', CODEX_C, 'codex')),
    f => f.state.rebind(rebindRequest(f, '101', CODEX_C, 'codex'))),
  heldRow('rebind conductor claude', '303', 'claude', false,
    f => bindConductor(f, '303', CLAUDE_A, 'claude'), REBIND_PATTERN,
    f => f.state.rebind(rebindRequest(f, '303', CLAUDE_B, 'claude')),
    f => f.state.rebind(rebindRequest(f, '303', CLAUDE_B, 'claude'))),
  heldRow('unbind conductor codex', '104', 'codex', false,
    f => bindConductor(f, '104', CODEX_A, 'codex'), UNBIND_PATTERN,
    (f, b) => f.state.unbind('104', { expectedBinding: b }),
    (f, b) => f.state.unbind('104', { expectedBinding: b })),
  heldRow('handoff conductor codex', '105', 'codex', false,
    f => bindConductor(f, '105', CODEX_A, 'codex'), HANDOFF_PATTERN,
    (f, b) => f.state.handoffConductor(handoffConductorRequest(f, b, CODEX_C)),
    (f, b) => f.state.handoffConductor(handoffConductorRequest(f, b, CODEX_C))),
  heldRow('handoff conductor claude', '304', 'claude', false,
    f => bindConductor(f, '304', CLAUDE_A, 'claude'), HANDOFF_PATTERN,
    (f, b) => f.state.handoffConductor(handoffConductorRequest(f, b, CLAUDE_B)),
    (f, b) => f.state.handoffConductor(handoffConductorRequest(f, b, CLAUDE_B))),
  heldRow('handoff ordinary codex', '201', 'codex', true,
    f => bindOrdinary(f, '201', CODEX_A), HANDOFF_PATTERN,
    (f, b) => f.state.handoffOrdinary(ordinaryHandoff(f, b, CODEX_B)),
    (f, b) => f.state.handoffOrdinary(ordinaryHandoff(f, b, CODEX_B))),
  heldRow('rebind ordinary codex root relocation', '203', 'codex', true,
    f => bindOrdinary(f, '203', CODEX_A), RELOCATION_PATTERN,
    (f, b) => { const r = ordinaryRelocation(f, b, CODEX_A); return f.state.rebindOrdinary(r.request, r.request.identity, r.proof); },
    (f, b) => { const r = ordinaryRelocation(f, b, CODEX_A); return f.state.rebindOrdinary(r.request, r.request.identity, r.proof); }),
  heldRow('rebind ordinary codex binding', '205', 'codex', true,
    f => bindOrdinary(f, '205', CODEX_A), REBIND_PATTERN,
    (f, b) => f.state.rebind(ordinaryRebindRequest(f, b)),
    (f, b) => f.state.rebind(ordinaryRebindRequest(f, b))),
  heldRow('rebind ordinary claude binding', '206', 'claude', true,
    f => bindOrdinaryClaude(f, '206', CLAUDE_A), REBIND_PATTERN,
    (f, b) => f.state.rebind(ordinaryRebindRequest(f, b)),
    (f, b) => f.state.rebind(ordinaryRebindRequest(f, b))),
  heldRow('unbind ordinary codex', '207', 'codex', true,
    f => bindOrdinary(f, '207', CODEX_A), UNBIND_PATTERN,
    (f, b) => f.state.unbind('207', { expectedBinding: b }),
    (f, b) => f.state.unbind('207', { expectedBinding: b })),
  heldRow('unbind ordinary claude', '204', 'claude', true,
    f => bindOrdinaryClaude(f, '204', CLAUDE_A), UNBIND_PATTERN,
    (f, b) => f.state.unbind('204', { expectedBinding: b }),
    (f, b) => f.state.unbind('204', { expectedBinding: b }))
];

for (const row of HELD_ROWS) {
  test(`held admitted POST refuses ${row.name} and the intended mutation succeeds after drain`, async t => {
    const f = createFixture(t);
    const ctx = row.setup(f);
    const held = await heldPost(t, f, ctx.held);
    const before = captureCustody(f.state, ctx.channelId);
    assert.equal(f.state.hasUnresolvedBindingPost(ctx.channelId), true, 'admitted publication holds the channel');
    assert.throws(ctx.refuse, ctx.pattern);
    assertCustodyUnchanged(f.state, ctx.channelId, before);
    held.release();
    assert.equal((await held.pending).status, 'sent', 'the held request completes as sent');
    assert.equal(f.state.hasUnresolvedBindingPost(ctx.channelId), false, 'sent outcome releases the hold');
    assert.doesNotThrow(() => ctx.succeed(), 'the same intended mutation succeeds after custody drains');
    assert.equal(held.posts(), 1, 'exactly one network POST');
  });
}

// T4 sentinel: the classifier is false for every outer call and true only from
// inside a real transaction callback. rebindOrdinary selects its relocation
// branch through ordinary queued work (hasUnresolved), not the classifier, so
// all classifier outer reads stay clear here.
const SENTINEL_ROWS = [
  {
    name: 'rebind',
    setup(f) {
      const binding = bindConductor(f, '101', CODEX_A, 'codex');
      return { channelId: '101', binding, pattern: /cannot rebind while a publication is unresolved/,
        run: () => f.state.rebind(rebindRequest(f, '101', CODEX_C, 'codex')) };
    }
  },
  {
    name: 'unbind',
    setup(f) {
      const binding = bindConductor(f, '104', CODEX_A, 'codex');
      return { channelId: '104', binding, pattern: /cannot unbind while work is unresolved/,
        run: () => f.state.unbind('104', { expectedBinding: binding }) };
    }
  },
  {
    name: 'conductor handoff',
    setup(f) {
      const binding = bindConductor(f, '105', CODEX_A, 'codex');
      return { channelId: '105', binding, pattern: /cannot handoff while work is unresolved/,
        run: () => f.state.handoffConductor(handoffConductorRequest(f, binding, CODEX_C)) };
    }
  },
  {
    name: 'ordinary handoff',
    setup(f) {
      const binding = bindOrdinary(f, '201', CODEX_A);
      return { channelId: '201', binding, pattern: /cannot handoff while work is unresolved/,
        run: () => f.state.handoffOrdinary(ordinaryHandoff(f, binding, CODEX_B)) };
    }
  },
  {
    name: 'ordinary root relocation',
    setup(f) {
      const binding = bindOrdinary(f, '203', CODEX_A);
      seedQueuedWork(f.state, '203');
      const relocation = ordinaryRelocation(f, binding, CODEX_A);
      return { channelId: '203', binding, pattern: /ordinary binding root relocation has unresolved post custody/,
        run: () => f.state.rebindOrdinary(relocation.request, relocation.request.identity, relocation.proof) };
    }
  }
];

for (const row of SENTINEL_ROWS) {
  test(`transaction-only guard refuses ${row.name} before side effects`, async t => {
    const f = createFixture(t);
    const ctx = row.setup(f);
    sentinel(f.state);
    const before = captureCustody(f.state, ctx.channelId);
    assert.throws(ctx.run, ctx.pattern);
    assertCustodyUnchanged(f.state, ctx.channelId, before);
  });
}

test('admission committed after the outer precheck is still caught inside the transaction', t => {
  const f = createFixture(t);
  const binding = bindConductor(f, '101', CODEX_A, 'codex');
  const real = f.state.hasUnresolvedBindingPost.bind(f.state);
  let calls = 0;
  f.state.hasUnresolvedBindingPost = channelId => {
    calls += 1;
    if (calls === 1) {
      seedAttempt(f.second, plainAttempt({ channelId, provider: 'codex', conductorId: binding.conductorId, repoKey: binding.repoKey, requestId: 'raced-admission', attemptId: 'raced-attempt' }));
      return false; // outer precheck observed the channel before the admission committed
    }
    return real(channelId);
  };
  assert.throws(() => f.state.unbind('101', { expectedBinding: binding }), /cannot unbind while work is unresolved/);
  assert.equal(calls, 2, 'the in-transaction guard re-read custody');
  assert.equal(f.state.getBinding('101').active, true, 'the raced retirement did not commit');
});

test('public retirement committed before admission stops the stale sender before POST', async t => {
  const f = createFixture(t);
  const binding = bindConductor(f, '101', CODEX_A, 'codex');
  const file = textFile(f, 'stale-sender.txt', 'stale send');
  let posts = 0;
  const originalCurrent = f.state.directPostBindingCurrent.bind(f.state);
  let retired = false;
  f.state.directPostBindingCurrent = (...args) => {
    if (!retired) {
      retired = true;
      assert.equal(f.second.unbind('101', { expectedBinding: binding }), true, 'public retirement commits before admission');
    }
    return originalCurrent(...args);
  };
  try {
    const result = await runDirectPost({
      state: f.state, token: 'fixture', nativeId: binding.nativeId, generation: binding.generation,
      channelId: '101', provider: 'codex', textFile: file, dedupeKey: 'stale-sender',
      fetchImpl: async (_url, options) => {
        if (options.method === 'POST') posts += 1;
        return { ok: true, status: 200, json: async () => ({ id: 'never' }) };
      }
    });
    assert.equal(posts, 0, 'the stale sender never reached the network');
    assert.equal(result.status, 'stale', 'the sender records the stale outcome');
    assert.equal(f.state.directPostRows('stale-sender').filter(row => row.kind === 'direct-post-attempt').length, 0,
      'retirement before admission prevented any admitted attempt');
    assert.equal(f.state.getBinding('101').active, false, 'the public retirement stayed committed');
  } finally {
    f.state.directPostBindingCurrent = originalCurrent;
  }
});

test('retirement still holds after both outcome persistence writes fail', async t => {
  const f = createFixture(t);
  const binding = bindConductor(f, '101', CODEX_A, 'codex');
  const file = textFile(f, 'failed-outcome.txt', 'outcome write fails');
  const original = f.state.recordDirectPostOutcome.bind(f.state);
  f.state.recordDirectPostOutcome = () => { throw new Error('outcome persistence failed'); };
  try {
    await assert.rejects(() => runDirectPost({
      state: f.state, token: 'fixture', nativeId: binding.nativeId, generation: binding.generation,
      channelId: '101', provider: 'codex', textFile: file, dedupeKey: 'failed-outcome',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ id: 'lost' }) })
    }), /outcome persistence failed/);
    const rows = f.state.directPostRows('failed-outcome');
    assert.equal(rows.filter(row => row.kind === 'direct-post-attempt').length, 1, 'the attempt was admitted');
    assert.equal(rows.filter(row => row.kind === 'direct-post-outcome').length, 0, 'neither outcome write persisted');
    assert.equal(f.state.hasUnresolvedBindingPost('101'), true, 'a missing outcome still holds retirement');
    assert.throws(() => f.state.unbind('101', { expectedBinding: binding }), /cannot unbind while work is unresolved/);
    assert.equal(f.state.getBinding('101').active, true, 'the refused retirement changed nothing');
  } finally {
    f.state.recordDirectPostOutcome = original;
  }
});

test('D3 evidence matrix classifies each receipt history semantically', t => {
  const f = createFixture(t);
  const has = channelId => f.state.hasUnresolvedBindingPost(channelId);
  const seed = (channelId, overrides) => plainAttempt({ channelId, ...overrides });

  seedAttempt(f.state, seed('missing', { requestId: 'r-missing', attemptId: 'a1' }));
  assert.equal(has('missing'), true, 'missing outcome holds');

  seedAttempt(f.state, seed('empty', { requestId: 'r-empty', attemptId: 'a1' }));
  seedOutcome(f.state, seed('empty', { requestId: 'r-empty', attemptId: 'a1' }), '');
  assert.equal(has('empty'), true, 'empty outcome holds');

  seedAttempt(f.state, seed('malformed', { requestId: 'r-bad', attemptId: 'a1' }));
  f.state.receipt(null, 'direct-post-outcome', { journal: 'direct-post-v1', ...seed('malformed', { requestId: 'r-bad', attemptId: 'a1' }), outcome: 42 });
  assert.equal(has('malformed'), true, 'non-string malformed outcome holds');

  seedAttempt(f.state, seed('unrecognized', { requestId: 'r-unrec', attemptId: 'a1' }));
  seedOutcome(f.state, seed('unrecognized', { requestId: 'r-unrec', attemptId: 'a1' }), 'exploded');
  assert.equal(has('unrecognized'), true, 'unrecognized outcome holds');

  seedAttempt(f.state, seed('unknown', { requestId: 'r-unknown', attemptId: 'a1' }));
  seedOutcome(f.state, seed('unknown', { requestId: 'r-unknown', attemptId: 'a1' }), 'unknown');
  assert.equal(has('unknown'), true, 'unknown holds');
  assert.equal(f.state.hasUnresolvedOrdinaryPost('unknown'), true, 'compatibility alias delegates to the same classifier');
  f.state.reconcileDirectPostOutcome('r-unknown', 'a1', 'sent', { reason: 'operator evidence', messageId: 'm1' });
  assert.equal(has('unknown'), false, 'qualified reconciliation releases the hold');

  seedAttempt(f.state, seed('retry', { requestId: 'r-retry', attemptId: 'old' }));
  seedOutcome(f.state, seed('retry', { requestId: 'r-retry', attemptId: 'old' }), 'rate_limited');
  seedAttempt(f.state, seed('retry', { requestId: 'r-retry', attemptId: 'new' }));
  assert.equal(has('retry'), true, 'a newer unresolved retry outlives an older definitive failure');

  seedAttempt(f.state, seed('prefix', { requestId: 'r-prefix', attemptId: 'p0', partIndex: 0, partCount: 2 }));
  seedOutcome(f.state, seed('prefix', { requestId: 'r-prefix', attemptId: 'p0', partIndex: 0, partCount: 2 }), 'sent');
  assert.equal(has('prefix'), true, 'a sent multipart prefix still holds');

  seedAttempt(f.state, seed('mixed', { requestId: 'r-mixed', attemptId: 'p0', partIndex: 0, partCount: 2 }));
  seedOutcome(f.state, seed('mixed', { requestId: 'r-mixed', attemptId: 'p0', partIndex: 0, partCount: 2 }), 'not_sent');
  seedAttempt(f.state, seed('mixed', { requestId: 'r-mixed', attemptId: 'p1', partIndex: 1, partCount: 2 }));
  assert.equal(has('mixed'), true, 'a definitive failure cannot hide an unresolved part');

  for (const partIndex of [0, 1]) {
    seedAttempt(f.state, seed('complete', { requestId: 'r-complete', attemptId: `c${partIndex}`, partIndex, partCount: 2 }));
    seedOutcome(f.state, seed('complete', { requestId: 'r-complete', attemptId: `c${partIndex}`, partIndex, partCount: 2 }), 'sent');
  }
  assert.equal(has('complete'), false, 'all represented parts sent releases');

  seedAttempt(f.state, seed('failed', { requestId: 'r-failed', attemptId: 'f1' }));
  seedOutcome(f.state, seed('failed', { requestId: 'r-failed', attemptId: 'f1' }), 'rejected');
  assert.equal(has('failed'), false, 'a fully resolved definitive failure releases');

  // Historical generation: a real current binding exists at a newer generation,
  // and prior-generation unresolved custody for the same channel still holds.
  const historical = bindConductor(f, '106', CODEX_A, 'codex');
  const current = f.state.rebind(rebindRequest(f, '106', CODEX_B, 'codex'));
  assert.equal(current.generation, historical.generation + 1, 'a real newer binding generation exists');
  seedAttempt(f.state, seed('106', { requestId: 'r-history', attemptId: 'g1', generation: 1, conductorId: historical.conductorId, repoKey: historical.repoKey }));
  assert.equal(has('106'), true, 'earlier-generation custody holds against the current owner');
  assert.throws(() => f.state.unbind('106', { expectedBinding: current }), /cannot unbind while work is unresolved/);
  assert.equal(f.state.getBinding('106').generation, current.generation, 'the current generation is preserved');
  assert.equal(has('some-other-channel'), false, 'a different source channel does not block');
});

test('stale expected-binding refusal and enrollment/intake proof checks are preserved', t => {
  const f = createFixture(t);
  const binding = bindConductor(f, '101', CODEX_A, 'codex');
  assert.throws(() => f.state.unbind('101', { expectedBinding: { ...binding, generation: binding.generation + 1 } }),
    /stale/, 'stale expected binding is refused');
  enroll(f, '101');
  assert.throws(() => f.state.rebind(rebindRequest(f, '101', CODEX_C, 'codex'), {}), /observed intake cutoff/,
    'active enrollments require an observed intake cutoff');
  assert.throws(() => f.state.handoffConductor(handoffConductorRequest(f, binding, CODEX_C)), /observed intake cutoff/,
    'conductor handoff preserves the enrollment proof gate');
  assert.throws(() => f.state.rebind(rebindRequest(f, '101', CODEX_C, 'codex'), {
    intakeCutoff: '500', enrollmentProof: { parentChannelId: '101', enrollments: [] }
  }), /enrollment proof|changed during handoff proof/, 'enrollment coverage proof is enforced');
  assert.equal(f.state.getBinding('101').generation, binding.generation, 'refused mutations changed no identity');
});
