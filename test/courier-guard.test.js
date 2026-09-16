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
const PARENT = '11111111-1111-1111-1111-111111111111';
const COURIER = '22222222-2222-2222-2222-222222222222';

function fixture(t, { agent = false, hostId = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-guard-'));
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
    courier: { provider: 'codex', nativeId: COURIER, workspace: dir, recipientThreadId: PARENT, hostId }
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
  const prompt = codexPrompt(state.getMessage('9000'));
  const claim = state.beginCourierAttempt('9000', { routeId: route.routeId, prompt });
  assert.equal(claim.accepted, true);
  const event = { session_id: COURIER, turn_id: 'fixture-turn', tool_use_id: 'fixture-call',
    cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'mcp__codex_app__send_message_to_thread',
    tool_input: { threadId: PARENT, prompt, ...(hostId ? { hostId } : {}) } };
  const argv = ['--disable-warning=ExperimentalWarning', CLI, 'courier-guard', '--db', db, '--courier-route-id', route.routeId];
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, route, event, argv, claim, binding, get state() { return state; },
    reopen() { state.close(); state = new SurfaceState(db); },
    claims() { return state.db.prepare('SELECT * FROM receipts WHERE kind=?').all(COURIER_RECEIPT_KINDS.FORWARD_CLAIM); }
  };
}

function invoke(f, event = f.event, extra = []) {
  const r = spawnSync(process.execPath, [...f.argv, ...extra], {
    input: typeof event === 'string' ? event : JSON.stringify(event), encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024
  });
  assert.equal(r.error, undefined, r.error?.message);
  return { ...r, decision: JSON.parse(r.stdout).hookSpecificOutput };
}

function denied(r, reason) {
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.decision.permissionDecision, 'deny');
  if (reason) assert.match(r.decision.permissionDecisionReason, reason);
}

test('public hook claims one exact human or peer forward, without acknowledging or replying', t => {
  for (const agent of [false, true]) for (const hostId of [null, 'host-local']) {
    const f = fixture(t, { agent, hostId });
    f.state.recordCourierOutcome('9000', f.claim.attempt.attemptId, COURIER_OUTCOMES.SUBMITTED);
    f.state.markSubmitted('9000');
    const r = invoke(f);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.decision.permissionDecision, 'allow');
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

test('acknowledged, settled, refused or missing attempts cannot forward', t => {
  const mutations = [
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
