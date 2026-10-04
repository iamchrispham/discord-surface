const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { encodeAgentMessage, KINDS } = require('../src/agent-message');
const { acknowledgmentCommand } = require('../src/acknowledgment');
const { agentCompletionCommand, codexPrompt, readInitialCursor, CodexProvider } = require('../src/native');
const { parseArgs, resolveCourierRoute, start } = require('../src/cli');
const {
  COURIER_OUTCOMES,
  COURIER_SOURCE_KINDS,
  MESSAGE_STATES,
  SurfaceState,
  THREAD_STATES
} = require('../src/state');
const { createSurfaceConsumer } = require('../src/discord');
const { persistGuardRefusal } = require('../src/courier-guard');
const { TOKEN, PARENT_NATIVE, SOURCE_NATIVE, COURIER_NATIVE, RECIPIENT_THREAD, WRONG_RECIPIENT_THREAD, fixture, humanMessage, interactionMessage, materializedDecisionMessage, parentPrompt, preparedInput, consumerFor } = require('./courier-route-fixture');
test('courier fixture captures its populated transcript cursor', t => {
  const f = fixture(t);
  fs.appendFileSync(f.sessionFile, 'partial transcript ☃');
  const cursor = preparedInput(f, f.message).observerCursor;
  const transcript = fs.readFileSync(f.sessionFile);
  assert.equal(cursor.file, f.sessionFile);
  assert.equal(cursor.offset, transcript.length);
  const tail = transcript.subarray(transcript.lastIndexOf(0x0a) + 1);
  assert.equal(cursor.tail, tail.toString('utf8'));
  assert.equal(cursor.tailBytes, tail.toString('base64'));
});
test('courier route registration rejects a Claude parent', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-courier-claude-route-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  const parentNative = '55555555-5555-5555-5555-555555555555';
  const courierNative = '66666666-6666-6666-6666-666666666666';
  const sessionRoot = path.join(dir, 'sessions');
  fs.mkdirSync(sessionRoot, { recursive: true });
  state.setConfig({ operatorId: 'operator', guildId: '100', secretFile: path.join(dir, 'secret') });
  const binding = state.bind({
    channelId: '1000',
    guildId: '100',
    provider: 'claude',
    nativeId: parentNative,
    workspace: dir,
    endpoint: '/tmp/discord-courier-claude.sock'
  }, { intakeCutoff: '100' });
  state.enrollThread({ threadId: '2000', parentChannelId: '1000', guildId: '100', adoptionCutoff: '100'}, binding);
  state.setThreadBaseline('2000', null, binding);
  state.markThreadBoundary('2000', THREAD_STATES.READY, 'Claude route fixture', null, null, binding);

  assert.throws(() => state.registerCourierRoute({
    routeId: 'claude-route',
    routeGeneration: 1,
    guildId: '100',
    parentChannelId: '1000',
    deliveryChannelId: '2000',
    target: { guildId: '100', channelId: '2000', provider: 'claude', nativeId: parentNative, generation: binding.generation },
    courier: {
      provider: 'codex',
      nativeId: courierNative,
      workspace: dir,
      sessionRoot,
      recipientThreadId: RECIPIENT_THREAD,
      hostId: 'host-local'
    }
  }), /courier route parent must use codex provider/);
  state.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('courier route registration rejects a Claude courier', t => {
  const f = fixture(t);
  assert.throws(() => f.state.registerCourierRoute({
    ...f.route,
    routeId: 'claude-courier-route',
    courier: { ...f.route.courier, provider: 'claude' }
  }), /courier provider must use codex provider/);
});

test('courier route registration rejects a non-parent recipient', t => {
  const f = fixture(t);
  assert.throws(() => f.state.registerCourierRoute({
    ...f.route,
    routeId: 'wrong-recipient-route',
    courier: { ...f.route.courier, recipientThreadId: WRONG_RECIPIENT_THREAD }
  }), /courier route recipient must match parent native identity/);
});

test('human messages reject a stale courier target', t => {
  const f = fixture(t, { includeInitialAgent: false });
  const message = humanMessage(f, '9013');
  f.state.receipt(null, 'courier-route', {
    ...f.route,
    target: { ...f.route.target, nativeId: '55555555-5555-5555-5555-555555555555' },
    recordedAt: new Date().toISOString()
  });

  const rejected = f.state.beginCourierAttempt(message.id, preparedInput(f, message));
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.status, 'stale');
  assert.equal(f.state.getCourierAttempt(message.id), null);
});

test('persisted invalid courier routes stay held without parent fallback', async t => {
  const f = fixture(t);
  f.state.receipt(null, 'courier-route', {
    ...f.route,
    courier: { ...f.route.courier, provider: 'claude' },
    recordedAt: new Date().toISOString()
  });
  const courierCalls = [];
  const parentCalls = [];
  const result = await consumerFor(f, { courierCalls, parentCalls }).processAccepted(f.message);

  assert.equal(result.status, COURIER_OUTCOMES.NOT_SUBMITTED);
  assert.equal(result.message.state, MESSAGE_STATES.ACCEPTED);
  assert.equal(courierCalls.length, 0);
  assert.deepEqual(parentCalls, []);
  assert.equal(f.state.getCourierAttempt(f.message.id), null);
  assert.equal(f.state.listReceipts().some(row => row.kind === 'courier-rejection'), true);
});

test('persisted wrong recipient stays stale without parent fallback', async t => {
  const f = fixture(t);
  const storedRoute = f.state.getCourierRoute(f.route.routeId);
  f.state.receipt(null, 'courier-route', {
    ...storedRoute,
    courier: { ...storedRoute.courier, recipientThreadId: WRONG_RECIPIENT_THREAD },
    recordedAt: new Date().toISOString()
  });
  const courierCalls = [];
  const parentCalls = [];
  const result = await consumerFor(f, { courierCalls, parentCalls }).processAccepted(f.message);

  assert.equal(result.status, COURIER_OUTCOMES.NOT_SUBMITTED);
  assert.equal(result.message.state, MESSAGE_STATES.ACCEPTED);
  assert.equal(courierCalls.length, 0);
  assert.deepEqual(parentCalls, []);
  assert.equal(f.state.getCourierAttempt(f.message.id), null);
  assert.equal(f.state.listReceipts().some(row => row.kind === 'courier-rejection' && JSON.parse(row.detail).reason === 'stale'), true);
});

function disposableCourierState(t, parentNativeId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-courier-case-'));
  const sessionRoot = path.join(dir, 'sessions');
  fs.mkdirSync(sessionRoot, { recursive: true });
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => {
    try { state.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  state.setConfig({ operatorId: 'operator', guildId: '100', secretFile: path.join(dir, 'secret') });
  const binding = state.bind({
    channelId: '1000',
    guildId: '100',
    provider: 'codex',
    nativeId: parentNativeId,
    workspace: dir,
    sessionRoot
  }, { intakeCutoff: '100' });
  state.enrollThread({ threadId: '2000', parentChannelId: '1000', guildId: '100', adoptionCutoff: '100' }, binding);
  state.setThreadBaseline('2000', null, binding);
  state.markThreadBoundary('2000', THREAD_STATES.READY, 'courier case fixture', null, null, binding);
  return { dir, sessionRoot, state, binding };
}

function courierRouteInput(f, { routeId, courierNativeId }) {
  return {
    routeId,
    routeGeneration: 1,
    guildId: '100',
    parentChannelId: '1000',
    deliveryChannelId: '2000',
    target: {
      guildId: '100',
      channelId: '2000',
      provider: 'codex',
      nativeId: f.binding.nativeId,
      generation: f.binding.generation
    },
    courier: {
      provider: 'codex',
      nativeId: courierNativeId,
      workspace: f.dir,
      sessionRoot: f.sessionRoot,
      recipientThreadId: f.binding.nativeId,
      hostId: 'host-local'
    }
  };
}

test('courier route registration refuses a lowercase courier of an uppercase parent session', t => {
  const parentNative = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  const courierNative = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const f = disposableCourierState(t, parentNative);

  assert.throws(
    () => f.state.registerCourierRoute(courierRouteInput(f, { routeId: 'case-route-lower-courier', courierNativeId: courierNative })),
    /courier identity must differ from parent native identity/
  );
  assert.deepEqual(f.state.listCourierRoutes(), []);
  assert.equal(f.state.listReceipts().some(row => row.kind === 'courier-route'), false);
});

test('courier route registration refuses an uppercase courier of a lowercase parent session', t => {
  const parentNative = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const courierNative = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
  const f = disposableCourierState(t, parentNative);

  assert.throws(
    () => f.state.registerCourierRoute(courierRouteInput(f, { routeId: 'case-route-upper-courier', courierNativeId: courierNative })),
    /courier identity must differ from parent native identity/
  );
  assert.deepEqual(f.state.listCourierRoutes(), []);
  assert.equal(f.state.listReceipts().some(row => row.kind === 'courier-route'), false);
});

test('courier route registration keeps exact spelling for genuinely distinct sessions', t => {
  const parentNative = 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC';
  const courierNative = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const f = disposableCourierState(t, parentNative);

  const registered = f.state.registerCourierRoute(
    courierRouteInput(f, { routeId: 'distinct-session-route', courierNativeId: courierNative })
  );
  assert.ok(registered);
  assert.equal(registered.target.nativeId, parentNative);
  assert.equal(registered.target.generation, f.binding.generation);
  assert.equal(registered.courier.nativeId, courierNative);
  assert.equal(registered.courier.recipientThreadId, parentNative);
  const listed = f.state.listCourierRoutes().filter(route => route.routeId === 'distinct-session-route');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].target.nativeId, parentNative);
  assert.equal(listed[0].courier.nativeId, courierNative);
});
