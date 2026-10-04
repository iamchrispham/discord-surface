'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rejectionViolations, wiringViolations, realSources, ownerViolations, REFUSAL } = require('./peer-effects/owner-inventory');
const { buildHarness, directSnapshot, boardSnapshot, fetchEventIndex, assertBracketed, boardRun, boardFixtureBoardRows } = require('./peer-effects/execution-fixtures');

test('transport inventory pins every peer network effect and the channel-list lookup', async t => {
  assert.deepEqual(ownerViolations(realSources()), []);

  // The channel-list lookup is bracketed: the post-assertion still runs when
  // loadChannels itself rejects, so a caller change during the failed lookup
  // refuses instead of returning the transport error.
  const { fixture } = require('./fixtures/peer-fixture');
  const f = fixture(t);
  f.enroll('102');
  const CHANGED = '99999999-9999-9999-9999-999999999999';
  let current = '11111111-1111-1111-1111-111111111111';
  const { createPeerService } = require('../src/peer/service');
  const peer = createPeerService({
    state: f.state,
    provider: 'claude',
    token: 'fixture',
    callerDependencies: { resolveClaudeCaller: async () => ({ harness: 'claude-code', sessionId: current }) },
    loadChannels: async () => { current = CHANGED; throw new Error('simulated channel list failure'); },
    fetchImpl: async () => { throw new Error('no network expected'); }
  });
  await assert.rejects(peer.send({ peer: { channelName: 'general' }, text: 'hello', dedupe_key: 'owner-channel-list' }),
    REFUSAL, 'a caller change during a failed channel list must refuse');
  assert.equal(f.state.directPostRows('owner-channel-list').length, 0, 'no attempt after the refusal');

  // With a stable caller the post-assertion still runs and the original
  // channel-list transport error propagates unchanged.
  const stable = fixture(t);
  stable.enroll('102');
  const stableError = new Error('simulated channel list failure');
  const stablePeer = createPeerService({
    state: stable.state,
    provider: 'claude',
    token: 'fixture',
    callerDependencies: { resolveClaudeCaller: async () => ({ harness: 'claude-code', sessionId: '11111111-1111-1111-1111-111111111111' }) },
    loadChannels: async () => { throw stableError; },
    fetchImpl: async () => { throw new Error('no network expected'); }
  });
  await assert.rejects(stablePeer.send({ peer: { channelName: 'general' }, text: 'hello', dedupe_key: 'owner-channel-list-stable' }),
    error => { assert.strictEqual(error, stableError); return true; },
    'a stable caller sees the original channel-list transport error');
  assert.equal(stable.state.directPostRows('owner-channel-list-stable').length, 0);
});

test('public peer roles supply the caller assertion from the peer caller owner', () => {
  const sources = realSources();
  assert.deepEqual(wiringViolations(sources), []);
});

test('the caller assertion factory compares all five captured identity fields', async t => {
  const { TransportRejection } = require('../dist/direct-post/transport-rejection');
  for (const reason of [null, undefined, false, 0, '']) {
    const rejection = new TransportRejection();
    assert.equal(rejection.rejected, false);
    rejection.capture(reason);
    assert.equal(rejection.rejected, true);
    assert.strictEqual(rejection.reason, reason);
  }
  const { fixture, service, addRecipient } = require('./fixtures/peer-fixture');
  for (const reason of [null, undefined]) {
    const f = fixture(t);
    f.enroll('102');
    addRecipient(f);
    let caught = false;
    let observed;
    const peer = service(f, { loadChannels: async () => { throw reason; } });
    try {
      await peer.send({ peer: { channelName: 'recipient' }, text: 'hi', dedupe_key: 'empty-rejection' });
    } catch (error) {
      caught = true;
      observed = error;
    }
    assert.equal(caught, true);
    assert.strictEqual(observed, reason);
    assert.equal(f.state.directPostRows('empty-rejection').length, 0);
  }

  const { createCallerAssertion, resolvePeerCaller } = require('../src/peer/caller');
  const ORIGINAL = '11111111-1111-1111-1111-111111111111';
  const CHANGED = '99999999-9999-9999-9999-999999999999';
  const CODEX_ID = '22222222-2222-2222-2222-222222222222';

  function capturedId(state) {
    return state.getBinding('101').nativeId;
  }

  function claudeDeps(sessionId) {
    return { resolveClaudeCaller: async () => ({ harness: 'claude-code', sessionId }) };
  }

  const base = fixture(t);
  const captured = await resolvePeerCaller(base.state, 'claude', claudeDeps(ORIGINAL));
  const assertion = createCallerAssertion(base.state, 'claude', claudeDeps(ORIGINAL), captured);
  await assertion();
  await assertion(undefined);

  const aborted = new AbortController();
  aborted.abort();
  let resolverCalls = 0;
  const abortedAssertion = createCallerAssertion(base.state, 'claude', {
    resolveClaudeCaller: async () => { resolverCalls += 1; return { harness: 'claude-code', sessionId: ORIGINAL }; }
  }, captured);
  await assert.rejects(abortedAssertion(aborted.signal), REFUSAL);
  assert.equal(resolverCalls, 0, 'an already-aborted assertion refuses before the resolver runs');

  // Case-only UUID spelling stays equivalent.
  const caseFold = fixture(t);
  caseFold.state.db.prepare("UPDATE bindings SET native_id=upper(native_id) WHERE channel_id='101'").run();
  const foldedCaptured = { ...captured, nativeId: capturedId(caseFold.state).toLowerCase() };
  await createCallerAssertion(caseFold.state, 'claude', claudeDeps(capturedId(caseFold.state)), foldedCaptured)();

  // Mutating the original captured object cannot change the frozen expectation.
  const frozen = fixture(t);
  const mutable = { ...captured, nativeId: capturedId(frozen.state) };
  const frozenAssertion = createCallerAssertion(frozen.state, 'claude', claudeDeps(mutable.nativeId), mutable);
  mutable.channelId = '999';
  mutable.guildId = '999';
  mutable.generation = 999;
  mutable.nativeId = CHANGED;
  mutable.provider = 'codex';
  await frozenAssertion();

  // Each identity field is replaced independently and every change refuses.
  const cases = [
    {
      name: 'provider',
      setup() {
        const f = fixture(t);
        f.state.bind({ guildId: '100', channelId: '301', provider: 'codex', nativeId: CODEX_ID,
          workspace: '/tmp', conductorId: 'codex-owner', repoKey: 'github.com/test/codex' }, { intakeCutoff: '100' });
        return { state: f.state, provider: 'codex', deps: { resolveCodexCaller: async () => ({ sessionId: CODEX_ID, threadId: CODEX_ID, turnId: 't1' }) } };
      }
    },
    {
      name: 'guildId',
      setup() {
        const f = fixture(t);
        const id = capturedId(f.state);
        f.state.setConfig({ guildId: '200' });
        f.state.db.prepare("UPDATE bindings SET guild_id='200' WHERE channel_id='101'").run();
        return { state: f.state, provider: 'claude', deps: claudeDeps(id) };
      }
    },
    {
      name: 'channelId',
      setup() {
        const f = fixture(t);
        const id = capturedId(f.state);
        f.state.db.exec('PRAGMA defer_foreign_keys = ON');
        f.state.db.exec('BEGIN');
        f.state.db.prepare("UPDATE bindings SET channel_id='103' WHERE channel_id='101'").run();
        f.state.db.prepare("UPDATE thread_enrollments SET parent_channel_id='103' WHERE parent_channel_id='101'").run();
        f.state.db.exec('COMMIT');
        return { state: f.state, provider: 'claude', deps: claudeDeps(id) };
      }
    },
    {
      name: 'nativeId',
      setup() {
        const f = fixture(t);
        f.state.db.prepare("UPDATE bindings SET native_id=? WHERE channel_id='101'").run(CHANGED);
        return { state: f.state, provider: 'claude', deps: claudeDeps(CHANGED) };
      }
    },
    {
      name: 'generation',
      setup() {
        const f = fixture(t);
        const id = capturedId(f.state);
        f.state.db.prepare("UPDATE bindings SET generation=generation+1 WHERE channel_id='101'").run();
        return { state: f.state, provider: 'claude', deps: claudeDeps(id) };
      }
    }
  ];
  for (const scenario of cases) {
    const { state, provider, deps } = scenario.setup();
    await assert.rejects(createCallerAssertion(state, provider, deps, captured)(),
      REFUSAL, `${scenario.name} replacement must refuse`);
  }
});

test('direct-post and board execution bracket each network effect with the assertion', async t => {
  const { agentFixture, response, CLAUDE } = require('./direct-post-fixture');
  const { runDirectPost } = require('../src/direct-post');
  const boardFixture = require('./board-refresh-fixture');
  const { runBoardRefresh, BOARD_OUTCOMES } = boardFixture;

  const destination = { guildId: '100', channelId: '102', provider: 'claude', nativeId: CLAUDE, generation: 1 };
  const channelResponse = () => ({ ok: true, status: 200, json: async () => ({ id: destination.channelId, guild_id: destination.guildId }), body: { cancel() {} } });
  const agentTarget = require('../src/agent-message').issueAgentAddress(destination, 'fixture');
  const directFetch = harness => harness.wrapFetch(async (url, options) => options.method === 'GET'
    ? channelResponse()
    : response('direct-1'));

  // Direct-post: successful send persists the sent receipt before its post-assert.
  {
    const f = agentFixture(t);
    fs.writeFileSync(f.textFile, 'sequence text');
    const harness = buildHarness({ snapshot: () => directSnapshot(f.state, 'sequence-ok') });
    const result = await runDirectPost({
      state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
      agentThreadId: f.agentThreadId, textFile: f.textFile, dedupeKey: 'sequence-ok',
      agentTarget,
      assertCallerCurrent: harness.assertCallerCurrent,
      fetchImpl: directFetch(harness)
    });
    assert.equal(result.status, 'sent');
    assertBracketed(harness.events, 'GET');
    const postIndex = fetchEventIndex(harness.events, 'POST');
    assert.ok(postIndex > 0);
    assertBracketed(harness.events, 'POST');
    assert.equal(harness.events[postIndex + 1].kind === 'assert', true, 'an assertion follows the POST');
    assert.equal(harness.events.at(-1).snapshot.sent, true, 'the sent receipt is persisted before the post-assert');
  }

  // Direct-post: a successful receipt survives a post-assertion refusal.
  {
    const f = agentFixture(t);
    fs.writeFileSync(f.textFile, 'sequence refusal');
    const requestId = 'sequence-post-refusal';
    const harness = buildHarness({
      snapshot: () => directSnapshot(f.state, requestId),
      rejectWhen: ({ fetchCount }) => fetchCount >= 2
    });
    await assert.rejects(runDirectPost({
      state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
      agentThreadId: f.agentThreadId, textFile: f.textFile, dedupeKey: requestId,
      agentTarget,
      assertCallerCurrent: harness.assertCallerCurrent,
      fetchImpl: directFetch(harness)
    }), REFUSAL);
    const snapshot = directSnapshot(f.state, requestId);
    assert.equal(snapshot.outcomes.length, 1, 'sent evidence saved exactly once');
    assert.equal(snapshot.outcomes[0].detail.outcome, 'sent');
    assert.equal(snapshot.outcomes[0].detail.messageId, 'direct-1');
  }

  // Direct-post: an unknown outcome survives a post-assertion refusal.
  {
    const f = agentFixture(t);
    fs.writeFileSync(f.textFile, 'sequence unknown');
    const requestId = 'sequence-unknown';
    const networkError = new Error('simulated transport failure');
    const harness = buildHarness({
      snapshot: () => directSnapshot(f.state, requestId),
      rejectWhen: ({ fetchCount }) => fetchCount >= 2
    });
    await assert.rejects(runDirectPost({
      state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
      agentThreadId: f.agentThreadId, textFile: f.textFile, dedupeKey: requestId,
      agentTarget,
      assertCallerCurrent: harness.assertCallerCurrent,
      fetchImpl: harness.wrapFetch(async (url, options) => {
        if (options.method === 'GET') return channelResponse();
        throw networkError;
      })
    }), REFUSAL);
    const snapshot = directSnapshot(f.state, requestId);
    assert.equal(snapshot.unknown, true, 'the unknown classification is preserved');
    assert.equal(snapshot.outcomes.length, 1);
  }

  // Direct-post: a rejected destination GET persists its existing preflight
  // classification before the refusal escapes.
  {
    const f = agentFixture(t);
    fs.writeFileSync(f.textFile, 'sequence preflight');
    const requestId = 'sequence-preflight';
    const harness = buildHarness({
      snapshot: () => directSnapshot(f.state, requestId),
      rejectWhen: ({ fetchCount }) => fetchCount >= 1
    });
    await assert.rejects(runDirectPost({
      state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
      agentThreadId: f.agentThreadId, textFile: f.textFile, dedupeKey: requestId,
      agentTarget,
      assertCallerCurrent: harness.assertCallerCurrent,
      fetchImpl: harness.wrapFetch(async () => { throw new Error('destination lookup failed'); })
    }), REFUSAL);
    const snapshot = directSnapshot(f.state, requestId);
    assert.equal(snapshot.outcomes.length, 1, 'a preflight receipt is persisted before the refusal');
    assert.equal(snapshot.outcomes[0].detail.phase, 'preflight');
    assert.equal(snapshot.outcomes[0].detail.outcome, 'not_sent', 'the existing destination-GET classification is preserved');
    assert.equal(snapshot.attempts, 0, 'no mutation attempt is recorded');
  }

  // Board: successful refresh persists applied evidence before its post-assert.
  {
    const f = boardFixture.fixture();
    t.after(() => f.state.close());
    const requestId = 'sequence-board-ok';
    const board = { content: 'old board' };
    const harness = buildHarness({ snapshot: () => boardSnapshot(f.state, requestId) });
    const result = await boardRun(f, 'new board', requestId, harness, board);
    assert.equal(result.status, BOARD_OUTCOMES.APPLIED);
    assertBracketed(harness.events, 'GET');
    const patchIndex = fetchEventIndex(harness.events, 'PATCH');
    assert.ok(patchIndex > 0, 'the refresh PATCHes once');
    assertBracketed(harness.events, 'PATCH');
    assert.equal(harness.events.at(-1).snapshot.applied, true, 'applied evidence is persisted before the post-assert');
  }

  // Board: applied evidence survives a post-assertion refusal with no resend.
  {
    const f = boardFixture.fixture();
    t.after(() => f.state.close());
    const requestId = 'sequence-board-post-refusal';
    const board = { content: 'old board' };
    const harness = buildHarness({
      snapshot: () => boardSnapshot(f.state, requestId),
      rejectWhen: ({ snapshot }) => snapshot.applied
    });
    let patches = 0;
    await assert.rejects(boardRun(f, 'new board', requestId, harness, board, {
      onPatch() { patches += 1; }
    }), REFUSAL);
    assert.equal(patches, 1, 'exactly one PATCH before the post-assertion refusal');
    const snapshot = boardSnapshot(f.state, requestId);
    assert.equal(snapshot.applied, true, 'applied evidence is retained');
    assert.equal(snapshot.outcomes.length, 1, 'applied evidence is saved exactly once');
    assert.equal(snapshot.outcomes[0].detail.outcome, 'applied');
  }

  // Board: each rejected GET refuses with no attempt or outcome and no later GET.
  for (const boundary of [1, 2, 3]) {
    const f = boardFixture.fixture();
    t.after(() => f.state.close());
    const requestId = `sequence-board-get-${boundary}`;
    const networkError = new Error(`board GET ${boundary} failed`);
    const harness = buildHarness({
      snapshot: () => boardSnapshot(f.state, requestId),
      rejectWhen: ({ fetchCount }) => fetchCount >= boundary
    });
    let gets = 0;
    await assert.rejects(boardRun(f, 'new board', requestId, harness, { content: 'old board' }, {
      onGet() { gets += 1; if (gets === boundary) throw networkError; }
    }), REFUSAL, `board GET ${boundary} refusal`);    assert.equal(gets, boundary, 'GETs stop at the rejected lookup');
    const snapshot = boardSnapshot(f.state, requestId);
    assert.equal(snapshot.attempts.length, 0, 'no admission after a rejected board GET');
    assert.equal(snapshot.outcomes.length, 0, 'no outcome after a rejected board GET');
  }

  // Board: a stable caller lets the original transport error propagate unchanged.
  {
    const f = boardFixture.fixture();
    t.after(() => f.state.close());
    const harness = buildHarness({ snapshot: () => boardSnapshot(f.state, 'sequence-board-stable') });
    const networkError = new Error('stable board transport failure');
    await assert.rejects(boardRun(f, 'new board', 'sequence-board-stable', harness, { content: 'old board' }, {
      onGet() { throw networkError; }
    }), error => { assert.strictEqual(error, networkError); return true; });
    const snapshot = boardSnapshot(f.state, 'sequence-board-stable');
    assert.equal(snapshot.attempts.length, 0);
    assert.equal(snapshot.outcomes.length, 0, 'no board preflight classification is persisted');
  }

  // Board: an admitted attempt whose caller switches before the PATCH records the
  // same attempt as stale known-unsent and issues zero PATCHes.
  {
    const f = boardFixture.fixture();
    t.after(() => f.state.close());
    const requestId = 'sequence-board-stale';
    const harness = buildHarness({
      snapshot: () => boardSnapshot(f.state, requestId),
      rejectWhen: ({ snapshot }) => snapshot.attempts.length > 0
    });
    let patches = 0;
    await assert.rejects(boardRun(f, 'new board', requestId, harness, { content: 'old board' }, {
      onPatch() { patches += 1; }
    }), REFUSAL);
    assert.equal(patches, 0, 'no PATCH after the caller changed before the mutation');
    const snapshot = boardSnapshot(f.state, requestId);
    assert.equal(snapshot.attempts.length, 1, 'the admitted attempt is retained');
    assert.equal(snapshot.outcomes.length, 1);
    assert.equal(snapshot.outcomes[0].detail.outcome, 'stale');
    assert.equal(snapshot.outcomes[0].detail.requestId, requestId, 'the request identity is retained');
    assert.equal(snapshot.outcomes[0].detail.revision, snapshot.attempts[0].detail.revision, 'the revision identity is retained');
  }

  // Board: historical and duplicate returns revalidate without network or
  // receipt change and disclose no result.
  for (const mode of ['historical', 'duplicate']) {
    const f = boardFixture.fixture();
    t.after(() => f.state.close());
    const requestId = `sequence-board-${mode}`;
    const seeded = boardFixture.seedBoardAttempt(f, requestId, 'new board');
    if (mode === 'historical') {
      f.state.recordBoardRefreshOutcome(seeded.target, seeded.attemptId, BOARD_OUTCOMES.APPLIED, {
        operationEndedAt: '2026-01-01T00:00:00.000Z'
      });
    }
    const before = JSON.stringify(boardFixtureBoardRows(f.state, requestId));
    const harness = buildHarness({
      snapshot: () => boardSnapshot(f.state, requestId),
      rejectWhen: () => true
    });
    await assert.rejects(boardRun(f, 'new board', requestId, harness, { content: 'old board' }), REFUSAL, `${mode} board return refusal`);
    assert.equal(harness.fetchCount(), 0, `no HTTP request on a ${mode} board return`);
    assert.equal(JSON.stringify(boardFixtureBoardRows(f.state, requestId)), before,
      `saved evidence is unchanged on a ${mode} board return`);
  }
});

test('the effect-owner inventory is sensitive to new or removed network calls and the suites are registered once', () => {
  const base = realSources();
  assert.deepEqual(rejectionViolations(base), []);
  const nullable = { ...base, 'src/peer/service.js': base['src/peer/service.js'] + '\nasync function privateFailure() { let failure = null; try {} catch (error) { failure = error; } }' };
  assert.ok(rejectionViolations(nullable).some(message => message.includes('nullable rejection sentinel')));
  const captures = {
    'src/peer/service.js': ['lookupRejection'],
    'src/direct-post.ts': ['destinationRejection', 'mutationRejection'],
    'src/board-refresh.ts': ['installationRejection', 'channelRejection', 'targetRejection', 'mutationRejection']
  };
  for (const [file, owners] of Object.entries(captures)) {
    for (const owner of owners) {
      const needle = `${owner}.capture(error);`;
      assert.equal(base[file].split(needle).length - 1, 1);
      for (const replacement of [`${owner}.capture(error.message);`, '']) {
        const mutant = { ...base, [file]: base[file].replace(needle, replacement) };
        assert.ok(rejectionViolations(mutant).some(message => message.includes(owner)),
          `${file} ${owner} must reject transformed or omitted capture`);
      }
    }
  }

  const sources = realSources();
  assert.deepEqual(ownerViolations(sources), [], 'the real source passes the combined inventory');

  const ordinaryAlias = { ...sources, 'src/direct-post.ts': `${sources['src/direct-post.ts']}\nconst ordinarySource = JSON.stringify; const ordinaryAlias = ordinarySource; ordinaryAlias({});\n` };
  assert.deepEqual(ownerViolations(ordinaryAlias), [], 'ordinary local aliases are not transport effects');

  const mutants = [
    ['second fetch inside channel loader', 'src/peer/server.js',
      '      loadChannels: async signal => {',
      "      loadChannels: async signal => { await fetch('https://example.invalid/extra');"],
    ['fetch outside channel loader', 'src/peer/server.js',
      "const config = state.requireConfig();",
      "await fetch('https://example.invalid/extra'); const config = state.requireConfig();"],
    ['extra destination GET', 'src/direct-post.ts',
      'const sent = await sendDiscordMessage({',
      'await verifyAgentDestination({ token, agentTarget: deliveryTarget, fetchImpl, signal, timeoutMs });\n      const sent = await sendDiscordMessage({'],
    ['extra board GET', 'src/board-refresh.ts',
      '    remoteTarget = await fetchBoardTarget(',
      '    await fetchBoardChannel({ token, channelId, signal, timeoutMs, fetchImpl });\n    remoteTarget = await fetchBoardTarget('],
    ['extra POST', 'src/direct-post.ts',
      'const sent = await sendDiscordMessage({',
      "await sendDiscordMessage({ token, channelId: binding.channelId, content: 'x', nonce: 'n', signal, fetchImpl });\n      const sent = await sendDiscordMessage({"],
    ['extra PATCH', 'src/board-refresh.ts',
      'const patched = await patchBoardMessage(',
      'await patchBoardMessage({ token, channelId, messageId, content, signal, timeoutMs, fetchImpl });\n    const patched = await patchBoardMessage('],
    ['deleted public role assertion input', 'src/peer/post.js',
      '    bindingCurrent,\n    resolveBinding:',
      '    bindingCurrent, assertCallerCurrent: null,\n    resolveBinding:'],
    ['extra destination GET at the delivery-identity primitive', 'src/direct-post/delivery-identity.ts',
      '  const channel = await fetchDiscordChannel({',
      '  await fetchDiscordChannel({ token, channelId: agentTarget.channelId, fetchImpl, signal, timeoutMs });\n  const channel = await fetchDiscordChannel({'],
    ['raw fetch added to peer service', 'src/peer/service.js',
      '      const initial = await caller(signal);',
      "      await fetch('https://discord.com/api/v10/users/@me');\n      const initial = await caller(signal);"],
    ['aliased extra channel fetch', 'src/peer/server.js',
      '      loadChannels: async signal => {',
      "      loadChannels: async signal => { const request = fetch; await request('https://example.invalid/extra');"],
    ['aliased extra send', 'src/direct-post.ts',
      'const sent = await sendDiscordMessage({',
      "const send = sendDiscordMessage; await send({});\n      const sent = await sendDiscordMessage({"]
  ];
  const results = [];
  for (const [name, file, needle, replacement] of mutants) {
    const mutated = { ...sources };
    const before = mutated[file];
    assert.ok(before.includes(needle), `mutant ${name} target text is present`);
    mutated[file] = before.replace(needle, replacement);
    const violations = ownerViolations(mutated);
    assert.ok(violations.length > 0, `mutant ${name} must fail the inventory`);
    results.push(`${name}: ${violations.join(' | ')}`);
  }

  const pkg = require('../package.json');
  const files = pkg.scripts.test.split(/\s+/);
  for (const suite of ['test/peer-effect-revalidation.test.js', 'test/peer-effect-owner.test.js']) {
    assert.equal(files.filter(file => file === suite).length, 1, `${suite} is registered exactly once`);
  }

  const scratch = process.env.PEER_EFFECT_SCRATCH ||
    '/Users/cphamballer/Documents/Codex/2026-09-04/is-there-a-discord-mcp/outputs/peer-effect-source-131-1003/scratch';
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'owner-mutants.log'),
    `Issue 131 owner mutant results\n\n${results.join('\n')}\n\nregistration: both suites appear once in package.json scripts.test\n`);
});

// Board run helper local to this suite, so mutant checks never touch the
// worktree and runtime fixtures stay disposable.
