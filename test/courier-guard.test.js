const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { SurfaceState, THREAD_STATES, COURIER_OUTCOMES, COURIER_RECEIPT_KINDS } = require('../src/state');
const { encodeAgentMessage, KINDS } = require('../src/agent-message');
const { codexPrompt } = require('../src/native');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const CLI = path.resolve(__dirname, '../src/cli.js');
const WRAPPER = path.resolve(__dirname, '../src/courier-guard.sh');
const PARENT = '11111111-1111-1111-1111-111111111111';
const COURIER = '22222222-2222-2222-2222-222222222222';

function fixture(t, options = {}) {
  const { agent = false, hostId = null, preAttemptReceipt = false } = options;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-guard-'));
  const sessionRoot = path.join(dir, 'sessions');
  const routeSessionRoot = Object.hasOwn(options, 'routeSessionRoot') ? options.routeSessionRoot : sessionRoot;
  const routeWorkspace = Object.hasOwn(options, 'routeWorkspace')
    ? (typeof options.routeWorkspace === 'function' ? options.routeWorkspace(dir) : options.routeWorkspace)
    : dir;
  fs.mkdirSync(sessionRoot);
  const db = path.join(dir, 'surface.sqlite');
  let state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: '100', secretFile: path.join(dir, 'unused') });
  state.bind({ channelId: '1000', guildId: '100', provider: 'codex', nativeId: PARENT, workspace: dir });
  const binding = state.getBinding('1000');
  state.enrollThread({ threadId: '2000', parentChannelId: '1000', guildId: '100' }, binding);
  state.setThreadBaseline('2000', null, binding);
  state.markThreadBoundary('2000', THREAD_STATES.READY, 'fixture', null, null, binding);
  const target = { guildId: '100', channelId: '2000', provider: 'codex', nativeId: PARENT, generation: binding.generation };
  const route = state.registerCourierRoute({ routeId: 'guard-route', routeGeneration: 1,
    guildId: '100', parentChannelId: '1000', deliveryChannelId: '2000', target,
    courier: { provider: 'codex', nativeId: COURIER, workspace: routeWorkspace, sessionRoot: routeSessionRoot, recipientThreadId: PARENT, hostId }
  });
  const packet = { id: 'request-guard', kind: KINDS.REQUEST,
    source: { ...target, provider: 'claude', channelId: '3000', nativeId: '33333333-3333-3333-3333-333333333333' },
    target, replyTo: null, text: 'Explain current status' };
  const accepted = state.acceptDiscordMessage({ id: '9000', guildId: '100', channelId: agent ? '2000' : '1000',
    authorId: agent ? 'peer-bot' : 'operator', isBot: agent, attachments: [],
    content: agent ? encodeAgentMessage(packet, 'test-secret') : 'Explain current status'
  }, { ready: true, expectedBinding: binding, agentToken: 'test-secret' });
  assert.equal(accepted.accepted, true);
  assert.equal(state.claimDispatch('9000').claimed, true);
  if (preAttemptReceipt) state.receipt('9000', COURIER_RECEIPT_KINDS.RECONCILED_NOT_SUBMITTED, {});
  const prompt = codexPrompt(state.getMessage('9000'));
  const claim = state.beginCourierAttempt('9000', { routeId: route.routeId, prompt });
  assert.equal(claim.accepted, true);
  const event = { session_id: COURIER, turn_id: 'fixture-turn', tool_use_id: 'fixture-call',
    cwd: dir, transcript_path: path.join(routeSessionRoot || sessionRoot, `${COURIER}.jsonl`), hook_event_name: 'PreToolUse',
    tool_name: 'mcp__codex_app__send_message_to_thread',
    tool_input: { threadId: PARENT, prompt, ...(hostId ? { hostId } : {}) } };
  const argv = ['--disable-warning=ExperimentalWarning', CLI, 'courier-guard', '--db', db, '--courier-route-id', route.routeId];
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, sessionRoot, route, event, argv, claim, binding, get state() { return state; },
    reopen() { state.close(); state = new SurfaceState(db); },
    claims() { return state.db.prepare('SELECT * FROM receipts WHERE kind=?').all(COURIER_RECEIPT_KINDS.FORWARD_CLAIM); }
  };
}

function invoke(f, event = f.event, extra = []) {
  const r = spawnSync(process.execPath, [...f.argv, ...extra], {
    input: typeof event === 'string' ? event : JSON.stringify(event), encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024
  });
  assert.equal(r.error, undefined, r.error?.message);
  return { ...r, decision: r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null };
}

function denied(r, reason) {
  assert.equal(r.status, 2, r.stderr);
  assert.notEqual(r.stderr.trim(), '');
  assert.equal(r.decision.permissionDecision, 'deny');
  if (reason) {
    assert.match(r.decision.permissionDecisionReason, reason);
    assert.match(r.stderr, reason);
  }
}

test('public hook claims one exact human or peer forward, without acknowledging or replying', t => {
  for (const agent of [false, true]) for (const hostId of [null, 'host-local']) {
    const f = fixture(t, { agent, hostId });
    f.state.recordCourierOutcome('9000', f.claim.attempt.attemptId, COURIER_OUTCOMES.SUBMITTED);
    f.state.markSubmitted('9000');
    const r = invoke(f);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.equal(r.decision, null);
    assert.equal(f.claims().length, 1);
    assert.equal(f.state.hasNativeAcknowledgment(f.state.getMessage('9000')), false);
    assert.equal(f.state.getMessage('9000').state, 'submitted');
    f.reopen();
    denied(invoke(f), /already claimed/);
    assert.equal(f.claims().length, 1);
  }
});

test('wrong event, caller, cwd, target, bytes, host and extra model input deny without consuming permission', t => {
  const f = fixture(t);
  const mutations = [
    e => { e.hook_event_name = 'PostToolUse'; }, e => { e.tool_name = 'other'; },
    e => { e.session_id = PARENT; }, e => { e.cwd += '/other'; },
    e => { e.tool_input.threadId = COURIER; }, e => { e.tool_input.prompt += ' altered'; },
    e => { e.tool_input.model = 'other'; }, e => { e.tool_input.hostId = 'other'; },
    e => { delete e.tool_input.prompt; }
  ];
  for (const mutate of mutations) {
    const event = structuredClone(f.event); mutate(event); denied(invoke(f, event));
    assert.equal(f.claims().length, 0);
  }
  assert.equal(invoke(f).status, 0);
});

test('courier transcript path must stay within the enrolled session root', t => {
  for (const mutate of [
    event => { delete event.transcript_path; },
    event => { event.transcript_path = path.join(path.dirname(event.transcript_path), '..', 'relocated', 'courier.jsonl'); }
  ]) {
    const f = fixture(t);
    const event = structuredClone(f.event);
    mutate(event);
    denied(invoke(f, event), /caller or route is not current/);
    assert.equal(f.claims().length, 0);
    assert.equal(f.state.getCourierAttempt('9000', f.claim.attempt.attemptId).outcome.outcome, COURIER_OUTCOMES.NOT_SUBMITTED);
    assert.equal(f.state.getMessage('9000').state, 'accepted');
  }
  const f = fixture(t);
  assert.equal(invoke(f).status, 0);
});

test('null courier roots use the configured Codex session root', t => {
  const f = fixture(t, { routeSessionRoot: null });
  const fallbackRoot = path.join(f.dir, 'configured', 'sessions');
  fs.mkdirSync(fallbackRoot, { recursive: true });
  const priorCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.dirname(fallbackRoot);
  try {
    const event = { ...f.event, transcript_path: path.join(fallbackRoot, `${COURIER}.jsonl`) };
    assert.equal(invoke(f, event).status, 0);
    assert.equal(f.state.getCourierRoute(f.route.routeId).courier.sessionRoot, null);
  } finally {
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorCodexHome;
  }
});

test('current route, generation, authorization and child readiness are rechecked at forwarding', t => {
  const mutations = [
    f => f.state.revokeCourierRoute(f.route.routeId, 'test'),
    f => f.state.db.prepare('UPDATE bindings SET generation=generation+1').run(),
    f => f.state.setConfig({ ...f.state.requireConfig(), operatorId: 'new-operator' }),
    f => f.state.markThreadBoundary('2000', THREAD_STATES.GAP, 'test', null, null, f.binding),
    f => f.state.registerCourierRoute({ ...f.route, routeGeneration: 2 }),
    f => f.state.db.prepare('UPDATE messages SET content=? WHERE discord_id=?').run('changed', '9000')
  ];
  for (const mutate of mutations) {
    const f = fixture(t); mutate(f); denied(invoke(f)); assert.equal(f.claims().length, 0);
  }
});

test('undispatched, acknowledged, settled, refused or missing attempts cannot forward', t => {
  const mutations = [
    f => f.state.db.prepare('UPDATE messages SET state=? WHERE discord_id=?').run('accepted', '9000'),
    f => { f.state.markSubmitted('9000'); recordNativeAcknowledgment(f.state, {
      provider: 'codex', messageId: '9000', nativeId: PARENT, generation: f.binding.generation }); },
    f => f.state.db.prepare('UPDATE messages SET state=? WHERE discord_id=?').run('replied', '9000'),
    f => f.state.recordCourierOutcome('9000', f.claim.attempt.attemptId, COURIER_OUTCOMES.NOT_SUBMITTED),
    f => f.state.db.prepare('DELETE FROM receipts WHERE kind=?').run(COURIER_RECEIPT_KINDS.ATTEMPT)
  ];
  for (const mutate of mutations) {
    const f = fixture(t); mutate(f); denied(invoke(f)); assert.equal(f.claims().length, 0);
  }
});

test('an uncertain queue can deliver its original attempt once after restart', t => {
  const f = fixture(t);
  f.reopen();
  f.state.recoverAfterRestart();
  assert.equal(f.state.getMessage('9000').state, 'uncertain');
  assert.equal(invoke(f).status, 0);
  f.reopen(); f.state.recoverAfterRestart();
  denied(invoke(f), /already claimed/);
});

test('a reconciled non-submission denies a stale courier retry after parent redispatch', t => {
  const f = fixture(t);
  f.state.markUncertain('9000', new Error('queue outcome unknown'));
  f.state.recordCourierOutcome('9000', f.claim.attempt.attemptId, COURIER_OUTCOMES.UNCERTAIN);
  f.state.reconcileUncertain('9000', 'not_submitted');
  assert.equal(f.state.getCourierAttempt('9000', f.claim.attempt.attemptId).outcome.outcome, COURIER_OUTCOMES.UNCERTAIN);
  assert.equal(f.state.claimDispatch('9000').claimed, true);
  denied(invoke(f), /queue submission was refused/);
  assert.equal(f.claims().length, 0);
});

test('a retired courier refusal preserves newer direct custody', t => {
  for (const stateName of ['dispatching', 'submitted']) {
    const f = fixture(t);
    f.state.markUncertain('9000', new Error('queue outcome unknown'));
    f.state.recordCourierOutcome('9000', f.claim.attempt.attemptId, COURIER_OUTCOMES.UNCERTAIN);
    f.state.reconcileUncertain('9000', 'not_submitted');
    assert.equal(f.state.claimDispatch('9000').claimed, true);
    if (stateName === 'submitted') f.state.markSubmitted('9000');
    denied(invoke(f), /queue submission was refused/);
    assert.equal(f.state.getMessage('9000').state, stateName);
    assert.equal(f.state.getCourierAttempt('9000', f.claim.attempt.attemptId).outcome.outcome, COURIER_OUTCOMES.UNCERTAIN);
  }
});

function legacyRecoveryAfterClaim(f, acknowledged = false) {
  assert.equal(invoke(f).status, 0);
  f.state.markUncertain('9000', new Error('host result unknown'));
  f.state.recordCourierOutcome('9000', f.claim.attempt.attemptId, COURIER_OUTCOMES.UNCERTAIN);
  if (acknowledged) recordNativeAcknowledgment(f.state, {
    provider: 'codex', messageId: '9000', nativeId: PARENT, generation: f.binding.generation
  });
  // Persist the state written by a pre-guard recovery CLI, which did not inspect claims.
  f.state.transaction(() => {
    f.state.db.prepare('UPDATE messages SET state=?, error=NULL WHERE discord_id=?').run('accepted', '9000');
    f.state.receipt('9000', COURIER_RECEIPT_KINDS.RECONCILED_NOT_SUBMITTED, {});
  });
  f.reopen();
}

test('dispatch claim survives legacy recovery and existing native acknowledgment still promotes custody', t => {
  const f = fixture(t);
  legacyRecoveryAfterClaim(f);
  assert.equal(f.state.claimDispatch('9000').claimed, false);
  assert.equal(f.state.getMessage('9000').state, 'accepted');
  const acknowledged = fixture(t);
  legacyRecoveryAfterClaim(acknowledged, true);
  assert.equal(acknowledged.state.claimDispatch('9000').claimed, false);
  assert.equal(acknowledged.state.getMessage('9000').state, 'submitted');
  assert.equal(f.claims().length, 1);
  assert.equal(acknowledged.claims().length, 1);
});

for (const selected of [false, true]) for (const mode of ['normal', 'handoff', 'dispatch-outcome']) {
  test(`legacy recovery preserves claimed custody and unclaimed retry: selected=${selected}, ${mode}`, { timeout: 5000 }, async t => {
    for (const claimed of [true, false]) {
      const cleanup = [];
      const f = fixture({ after: fn => cleanup.push(fn) });
      if (claimed) legacyRecoveryAfterClaim(f);
      else {
        f.state.markUncertain('9000', new Error('queue result unknown'));
        f.state.recordCourierOutcome('9000', f.claim.attempt.attemptId, COURIER_OUTCOMES.UNCERTAIN);
        f.state.reconcileUncertain('9000', 'not_submitted');
      }
      if (!selected) f.state.revokeCourierRoute(f.route.routeId, 'retry without courier');
      const calls = [];
      const { createSurfaceConsumer } = require('../src/discord');
      const consumer = createSurfaceConsumer({ state: f.state,
        ...(selected ? { courierRoute: { routeId: f.route.routeId } } : {}),
        providers: { codex: {
          async dispatch(message) { calls.push(message.id); return { status: 'not_submitted' }; },
          async dispatchCourier() { assert.fail('retired attempt must never reach the courier'); },
          async observe() { return { stopped: true }; }
        } }, sendReply: async () => ({ id: 'reply' }), sendTransportReceipt: async () => ({ id: 'receipt' })
      });
      const controller = new AbortController();
      let siblingWork;
      try {
        const first = consumer.processAccepted(f.state.getMessage('9000'), controller.signal, {
          continueUntilFinal: false, handoff: mode === 'handoff', awaitDispatchOutcome: mode === 'dispatch-outcome'
        });
        if (claimed) {
          const sibling = f.state.acceptDiscordMessage({ id: '9001', guildId: '100', channelId: '1000',
            authorId: 'operator', isBot: false, attachments: [], content: 'Later input'
          }, { ready: true, expectedBinding: f.binding });
          assert.equal(sibling.accepted, true);
          siblingWork = consumer.processAccepted(sibling.message, controller.signal, { continueUntilFinal: false });
          siblingWork.catch(() => {});
        }
        await first;
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(calls, claimed ? [] : ['9000']);
        assert.equal(f.claims().length, claimed ? 1 : 0);
      } finally {
        controller.abort(); consumer.abortNativeWork();
        await consumer.waitForNativeWork();
        await siblingWork?.catch(() => {});
        cleanup.forEach(fn => fn());
      }
    }
  });
}

test('foreign and older retirement receipts do not retire a courier attempt', t => {
  const older = fixture(t, { preAttemptReceipt: true });
  assert.equal(invoke(older).status, 0);
  assert.equal(older.claims().length, 1);

  const foreign = fixture(t);
  const foreignAccepted = foreign.state.acceptDiscordMessage({
    id: 'foreign-message', guildId: '100', channelId: '1000', authorId: 'operator', isBot: false,
    attachments: [], content: 'foreign'
  }, { ready: true, expectedBinding: foreign.binding });
  assert.equal(foreignAccepted.accepted, true);
  foreign.state.receipt('foreign-message', COURIER_RECEIPT_KINDS.RECONCILED_NOT_SUBMITTED, {});
  assert.equal(invoke(foreign).status, 0);
  assert.equal(foreign.claims().length, 1);
});

test('two actual guard processes atomically claim at most one host call', async t => {
  const f = fixture(t);
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, f.argv, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(f.event));
  });
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.map(r => r.status).sort(), [0, 2], JSON.stringify(results));
  assert.equal(f.claims().length, 1);
});

test('malformed and oversized input, missing route and unusable database deny explicitly', t => {
  const f = fixture(t);
  denied(invoke(f, '{'));
  denied(invoke(f, 'x'.repeat(1024 * 1024 + 1)), /exceeds/);
  denied(invoke(f, f.event, ['--courier-route-id', 'missing']));
  const missing = path.join(f.dir, 'missing.sqlite');
  denied(invoke(f, f.event, ['--db', missing]));
  assert.equal(fs.existsSync(missing), false);
  const corrupt = path.join(f.dir, 'corrupt.sqlite'); fs.writeFileSync(corrupt, 'not a database');
  denied(invoke(f, f.event, ['--db', corrupt]));
  denied(invoke(f, f.event, ['--courier-route-id']));
  assert.equal(f.claims().length, 0);
});

test('public hook startup blocks when its module or runtime build is missing', t => {
  const f = fixture(t);
  const isolated = path.join(f.dir, 'isolated');
  fs.mkdirSync(isolated);
  const cli = path.join(isolated, 'cli.js');
  fs.copyFileSync(CLI, cli);
  const run = () => spawnSync(process.execPath, [cli, ...f.argv.slice(2)], {
    input: JSON.stringify(f.event), encoding: 'utf8', timeout: 5000
  });
  let result = run();
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Cannot find module/);
  fs.copyFileSync(path.join(path.dirname(CLI), 'courier-guard.js'), path.join(isolated, 'courier-guard.js'));
  fs.copyFileSync(path.join(path.dirname(CLI), 'state.js'), path.join(isolated, 'state.js'));
  fs.copyFileSync(path.join(path.dirname(CLI), 'agent-message.js'), path.join(isolated, 'agent-message.js'));
  result = run();
  denied({ ...result, decision: JSON.parse(result.stdout).hookSpecificOutput }, /build is missing/);
  assert.equal(f.claims().length, 0);
});

test('courier guard help prints usage without consuming hook input', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'courier-guard', '--help'], {
    input: JSON.stringify(f.event), encoding: 'utf8', timeout: 5000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Usage: discord-surface <command> \[options\]/);
});

test('shell hook wrapper uses pinned Node instead of inherited PATH', t => {
  const f = fixture(t);
  const isolated = path.join(f.dir, 'wrapper-only');
  fs.mkdirSync(isolated);
  const wrapper = path.join(isolated, 'courier-guard.sh');
  fs.copyFileSync(WRAPPER, wrapper);
  let result = spawnSync('/bin/sh', [wrapper, '--db', f.db, '--courier-route-id', f.route.routeId], {
    input: JSON.stringify(f.event), encoding: 'utf8', timeout: 5000
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /CLI entrypoint is missing/);

  const bin = path.join(f.dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  result = spawnSync('/bin/sh', [WRAPPER, '--db', f.db, '--courier-route-id', f.route.routeId], {
    input: JSON.stringify(f.event), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: bin, DISCORD_SURFACE_NODE: process.execPath }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(f.claims().length, 1);
});

test('shell hook wrapper fails closed when the configured node override is not executable', t => {
  const f = fixture(t);
  const bogus = path.join(f.dir, 'missing-node');
  const result = spawnSync('/bin/sh', [WRAPPER, '--db', f.db, '--courier-route-id', f.route.routeId], {
    input: JSON.stringify(f.event), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, DISCORD_SURFACE_NODE: bogus }
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /configured node runtime is not executable/);
  assert.equal(f.claims().length, 0);
});

test('courier forwarding canonicalizes non-normalized workspace paths', t => {
  const f = fixture(t, { routeWorkspace: dir => path.join(dir, 'nested', '..') });
  assert.equal(f.route.courier.workspace, f.dir);
  const result = invoke(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.claims().length, 1);
});

test('courier forwarding canonicalizes a trailing separator left after dot-segment resolution', t => {
  const f = fixture(t, { routeWorkspace: dir => `${dir}${path.sep}nested${path.sep}..${path.sep}` });
  assert.equal(f.route.courier.workspace, `${f.dir}${path.sep}nested${path.sep}..${path.sep}`);
  const result = invoke(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.claims().length, 1);
});

test('a durable refusal for an unrelated reason still persists despite a trailing separator and dot segment in the registered workspace', t => {
  const f = fixture(t, { routeWorkspace: dir => `${dir}${path.sep}nested${path.sep}..${path.sep}` });
  const event = structuredClone(f.event);
  event.transcript_path = path.join(path.dirname(event.transcript_path), '..', 'relocated', 'courier.jsonl');
  denied(invoke(f, event), /caller or route is not current/);
  assert.equal(f.claims().length, 0);
  const attempt = f.state.getCourierAttempt('9000', f.claim.attempt.attemptId);
  assert.equal(attempt.attempt.attemptId, f.claim.attempt.attemptId);
  assert.equal(attempt.outcome.outcome, COURIER_OUTCOMES.NOT_SUBMITTED);
  assert.equal(f.state.getMessage('9000').state, 'accepted');
});

test('guard refusal holds custody before or after queue acceptance across restart', t => {
  for (const outcome of [null, COURIER_OUTCOMES.SUBMITTED, COURIER_OUTCOMES.UNCERTAIN]) {
    const f = fixture(t);
    if (outcome) {
      f.state.recordCourierOutcome('9000', f.claim.attempt.attemptId, outcome);
      f.state.markSubmitted('9000');
    }
    f.state.markThreadBoundary('2000', THREAD_STATES.GAP, 'test', null, null, f.binding);
    denied(invoke(f), /courier forwarding authorization held/);
    assert.equal(f.state.getMessage('9000').state, 'accepted');
    const attempt = f.state.getCourierAttempt('9000', f.claim.attempt.attemptId);
    assert.equal(attempt.outcome.outcome, COURIER_OUTCOMES.NOT_SUBMITTED);
    assert.equal(attempt.outcome.reason, 'courier guard refused before host call');
    f.reopen();
    f.state.markThreadBoundary('2000', THREAD_STATES.READY, 'recovered', null, null, f.binding);
    denied(invoke(f), /not eligible/);
    assert.equal(f.claims().length, 0);
    assert.equal(f.state.getMessage('9000').state, 'accepted');
    assert.equal(f.state.beginCourierAttempt('9000', { routeId: f.route.routeId, prompt: f.event.tool_input.prompt }).duplicate, true);
  }
});

test('refusal after a forwarding claim cannot reset custody or grant a second call', t => {
  const f = fixture(t);
  f.state.recordCourierOutcome('9000', f.claim.attempt.attemptId, COURIER_OUTCOMES.SUBMITTED);
  f.state.markSubmitted('9000');
  assert.equal(invoke(f).status, 0);
  f.state.markThreadBoundary('2000', THREAD_STATES.GAP, 'test', null, null, f.binding);
  denied(invoke(f), /authorization held/);
  assert.equal(f.state.getMessage('9000').state, 'submitted');
  assert.equal(f.state.getCourierAttempt('9000', f.claim.attempt.attemptId).outcome.outcome, COURIER_OUTCOMES.SUBMITTED);
  assert.equal(f.claims().length, 1);
});

test('a forwarding claim fences late retryable queue results and reconciliation', t => {
  const late = fixture(t);
  assert.equal(invoke(late).status, 0);
  assert.equal(late.state.markNotSubmitted('9000', new Error('late queue result')).state, 'uncertain');
  late.reopen();
  late.state.recoverAfterRestart();
  assert.equal(late.state.getMessage('9000').state, 'uncertain');

  const reconciled = fixture(t);
  reconciled.state.markUncertain('9000', new Error('queue outcome unknown'));
  assert.equal(invoke(reconciled).status, 0);
  assert.throws(() => reconciled.state.reconcileUncertain('9000', 'not_submitted'), /forwarding claim prevents retrying delivery/);
  assert.equal(reconciled.state.getMessage('9000').state, 'uncertain');
});

test('a denied hook never migrates or repairs old or incomplete state', t => {
  const mutations = [
    f => f.state.db.prepare("UPDATE meta SET value='1.7' WHERE key='schema'").run(),
    f => f.state.db.exec('ALTER TABLE bindings DROP COLUMN session_root')
  ];
  const snapshot = f => ({
    schema: f.state.db.prepare("SELECT value FROM meta WHERE key='schema'").get(),
    definitions: f.state.db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()
  });
  for (const mutate of mutations) {
    const f = fixture(t); mutate(f);
    const before = snapshot(f);
    denied(invoke(f), /schema|session_root/);
    assert.deepEqual(snapshot(f), before);
    assert.equal(f.claims().length, 0);
    f.reopen();
    assert.equal(invoke(f).status, 0, 'regular state open still initializes the schema');
  }
});

test('host changes settle the exact old attempt while malformed input preserves custody', t => {
  for (const [oldHost, newHost] of [[null, 'host-b'], ['host-a', null], ['host-a', 'host-b']]) {
    const f = fixture(t, { hostId: oldHost });
    f.state.recordCourierOutcome('9000', f.claim.attempt.attemptId, COURIER_OUTCOMES.SUBMITTED);
    f.state.markSubmitted('9000');
    f.state.registerCourierRoute({ ...f.route, routeGeneration: 2, courier: { ...f.route.courier, hostId: newHost } });
    const malformed = { ...f.event, tool_input: { ...f.event.tool_input, hostId: 'wrong-host' } };
    denied(invoke(f, malformed), /fixed recipient/);
    assert.equal(f.state.getMessage('9000').state, 'submitted');
    assert.equal(f.state.getCourierAttempt('9000', f.claim.attempt.attemptId).outcome.outcome, COURIER_OUTCOMES.SUBMITTED);
    denied(invoke(f));
    assert.equal(f.state.getMessage('9000').state, 'accepted');
    assert.equal(f.state.getCourierAttempt('9000', f.claim.attempt.attemptId).outcome.outcome, COURIER_OUTCOMES.NOT_SUBMITTED);
    assert.equal(f.claims().length, 0);
    f.reopen();
    denied(invoke(f), /not eligible/);
    assert.equal(f.state.getMessage('9000').state, 'accepted');
    assert.equal(f.claims().length, 0);
  }
});
