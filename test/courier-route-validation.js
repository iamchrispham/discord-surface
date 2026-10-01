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
