const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { SurfaceState, MESSAGE_STATES, PROVIDERS, READINESS } = require('../src/state');
const { THREAD_INTAKE_REASONS, THREAD_RECEIPT_KINDS, THREAD_STATES } = require('../src/state/thread-enrollment');

const NATIVE = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const SUCCESSOR = 'f8296579-092b-4503-bf98-1f3c2b6d4913';
const CONDUCTOR_NATIVE = '2ccf0a8d-4d5e-4a0f-9a91-8b12f6e4c0d7';
const CONDUCTOR_SUCCESSOR = 'f5f11e29-1d1e-4b8d-a8cc-03c65d26c9b4';

function fixture(t, { ordinary = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-thread-state-'));
  const db = path.join(dir, 'surface.sqlite');
  let state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'unused.secret') });
  const input = {
    channelId: 'parent',
    guildId: 'guild',
    provider: PROVIDERS.CODEX,
    nativeId: NATIVE,
    workspace: dir
  };
  const binding = ordinary
    ? state.bindOrdinary(input, { sessionId: NATIVE, threadId: NATIVE })
    : state.bind(input);
  t.after(() => {
    try { state.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    db,
    get state() { return state; },
    reopen() {
      state.close();
      state = new SurfaceState(db);
      return state;
    },
    binding,
    enroll() {
      const enrollment = state.enrollThread(
        { threadId: 'child', parentChannelId: 'parent', guildId: 'guild' },
        state.getBinding('parent')
      );
      return enrollment;
    }
  };
}

function event(id, channelId = 'child', overrides = {}) {
  return {
    id,
    guildId: 'guild',
    channelId,
    authorId: 'operator',
    isBot: false,
    content: 'question',
    attachments: [],
    ...overrides
  };
}

function adoptReady(f, latestId = null) {
  f.enroll();
  f.state.setThreadBaseline('child', latestId, f.state.getBinding('parent'));
  f.state.markThreadBoundary('child', THREAD_STATES.READY, 'test adoption', null, null, f.state.getBinding('parent'));
}

test('thread enrollment is durable, idempotent, parent-scoped, and readiness-gated', t => {
  const f = fixture(t);
  const parentRoute = f.state.getMessageRoute('parent');
  assert.equal(parentRoute.enrollment, null);
  assert.equal(parentRoute.deliveryChannelId, 'parent');
  assert.equal(parentRoute.ready, true);

  const first = f.enroll();
  assert.equal(first.state, THREAD_STATES.PENDING);
  assert.equal(first.parentChannelId, 'parent');
  assert.equal(f.state.getMessageRoute('child').ready, false);
  assert.deepEqual(f.state.enrollThread(
    { threadId: 'child', parentChannelId: 'parent', guildId: 'guild' },
    f.state.getBinding('parent')
  ), first);

  const adopted = f.state.setThreadBaseline('child', '100', f.state.getBinding('parent'));
  assert.equal(adopted.adoptedThroughId, '100');
  assert.equal(adopted.adoptedAt !== null, true);
  assert.equal(adopted.recoveredThroughId, '100');
  const ready = f.state.markThreadBoundary('child', THREAD_STATES.READY, 'history complete', null, null, f.state.getBinding('parent'));
  assert.equal(ready.state, THREAD_STATES.READY);
  assert.equal(f.state.getMessageRoute('child').ready, true);
  assert.equal(f.state.getReadiness().threadEnrollments[0].threadId, 'child');

  assert.equal(f.state.enrollThread(
    { threadId: 'child', parentChannelId: 'other-parent', guildId: 'guild' },
    f.state.getBinding('parent')
  ), null);
});

test('unbound child stays dark then re-enrolls under the same parent with a fresh pending boundary', t => {
  const f = fixture(t);
  const original = f.state.getBinding('parent');
  f.enroll();

  assert.equal(f.state.unbind('parent', { expectedBinding: original }), true);
  assert.equal(f.state.getMessageRoute('child'), null);
  const during = f.state.acceptDiscordMessage(event('150'), { expectedBinding: original });
  assert.equal(during.accepted, false);
  assert.equal(during.reason, 'stale-binding');
  assert.equal(f.state.getMessage('150'), null);

  const successor = f.state.rebind({
    channelId: 'parent',
    guildId: 'guild',
    provider: PROVIDERS.CODEX,
    nativeId: SUCCESSOR,
    workspace: f.dir
  });
  const reopened = f.state.enrollThread(
    { threadId: 'child', parentChannelId: 'parent', guildId: 'guild' },
    successor
  );
  assert.equal(reopened.active, true);
  assert.equal(reopened.state, THREAD_STATES.PENDING);
  assert.equal(reopened.adoptedAt, null);
  assert.equal(reopened.recoveredThroughId, null);
  assert.equal(f.state.getMessageRoute('child').ready, false);
});

test('parent generation changes retire active thread enrollments', t => {
  const f = fixture(t);
  f.enroll();
  const predecessor = f.state.getBinding('parent');
  const successor = f.state.rebind({ ...predecessor, nativeId: SUCCESSOR });
  assert.equal(successor.generation, predecessor.generation + 1);
  assert.equal(f.state.getThreadEnrollment('child').active, false);
  assert.equal(f.state.getThreadEnrollment('child').state, THREAD_STATES.UNAVAILABLE);

  const conductorBinding = f.state.bind({
    channelId: 'conductor-parent',
    guildId: 'guild',
    provider: PROVIDERS.CODEX,
    nativeId: CONDUCTOR_NATIVE,
    workspace: f.dir,
    conductorId: 'conductor',
    repoKey: 'repo'
  });
  f.state.enrollThread(
    { threadId: 'conductor-child', parentChannelId: conductorBinding.channelId, guildId: 'guild' },
    conductorBinding
  );
  const conductorSuccessor = f.state.handoffConductor({
    channelId: conductorBinding.channelId,
    provider: PROVIDERS.CODEX,
    conductorId: 'conductor',
    repoKey: 'repo',
    fromNativeId: conductorBinding.nativeId,
    fromGeneration: conductorBinding.generation,
    nativeId: CONDUCTOR_SUCCESSOR,
    workspace: f.dir,
    handoffId: 'conductor-enrollment-fence'
  });
  assert.equal(conductorSuccessor.generation, conductorBinding.generation + 1);
  assert.equal(f.state.getThreadEnrollment('conductor-child').active, false);
  assert.equal(f.state.getThreadEnrollment('conductor-child').state, THREAD_STATES.UNAVAILABLE);
});

test('child intake records parent authority and child delivery while preserving custody', t => {
  const f = fixture(t);
  adoptReady(f, '100');
  const accepted = f.state.acceptDiscordMessage(event('101'), {
    ready: true,
    coverageId: '101',
    expectedBinding: f.state.getBinding('parent')
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.message.channelId, 'parent');
  assert.equal(accepted.message.deliveryChannelId, 'child');
  assert.equal(accepted.message.state, MESSAGE_STATES.ACCEPTED);
  assert.equal(f.state.getIntakeWatermark('parent'), null);

  const current = f.state.currentMessageBinding(accepted.message);
  assert.equal(current.current, true);
  assert.equal(current.identity, true);
  assert.equal(current.deliveryChannelId, 'child');
  assert.equal(current.enrollment.threadId, 'child');
  assert.equal(current.ready, true);
  assert.equal(f.state.hasUnresolved('parent'), true);
  assert.equal(f.state.getThreadEnrollment('child').lastAcceptedId, '101');
  assert.equal(f.state.getThreadEnrollment('child').recoveredThroughId, '101');
});

test('pending child transport receipts expose paused route readiness', t => {
  const f = fixture(t);
  f.enroll();
  const accepted = f.state.acceptDiscordMessage(event('111'), {
    expectedBinding: f.state.getBinding('parent')
  });
  assert.equal(accepted.accepted, true);
  const attempt = f.state.beginTransportReceipt('111');
  assert.equal(attempt.attempt.readiness, READINESS.PENDING);
});

test('inactive enrollment tombstones do not shadow direct bindings', t => {
  const f = fixture(t);
  f.enroll();
  f.state.unbind('parent', { expectedBinding: f.state.getBinding('parent') });
  f.state.bind({
    channelId: 'child',
    guildId: 'guild',
    provider: PROVIDERS.CODEX,
    nativeId: SUCCESSOR,
    workspace: f.dir
  });
  const route = f.state.getMessageRoute('child');
  assert.equal(route.enrollment, null);
  assert.equal(route.binding.channelId, 'child');
  assert.equal(route.ready, true);
});

test('pending and failed child routes never demote or substitute the parent', t => {
  const f = fixture(t);
  f.enroll();
  const bot = f.state.acceptDiscordMessage(event('101', 'child', {
    isBot: true,
    content: 'discord-tether:agent:v1:not-decoded'
  }), { coverageId: '101', expectedBinding: f.state.getBinding('parent') });
  assert.equal(bot.accepted, false);
  assert.equal(bot.reason, 'bot-source');
  assert.equal(f.state.getThreadEnrollment('child').lastSeenId, '101');
  assert.equal(f.state.listReceipts().some(row => row.kind === 'agent-message'), false);

  const held = f.state.acceptDiscordMessage(event('102'), {
    ready: false,
    coverageId: '102',
    expectedBinding: f.state.getBinding('parent')
  });
  assert.equal(held.accepted, true);
  assert.equal(held.message.channelId, 'parent');
  assert.equal(held.message.deliveryChannelId, 'child');
  assert.equal(f.state.currentMessageBinding(held.message).ready, false);

  f.state.markThreadBoundary('child', THREAD_STATES.GAP, 'child history gap', '102', '103', f.state.getBinding('parent'));
  const failed = f.state.acceptDiscordMessage(event('103'), {
    coverageId: '103',
    expectedBinding: f.state.getBinding('parent')
  });
  assert.equal(failed.accepted, false);
  assert.equal(failed.reason, THREAD_INTAKE_REASONS.GAP);
  assert.equal(f.state.getBinding('parent').readiness, READINESS.READY);
  assert.equal(f.state.getMessage('103'), null);
  assert.throws(() => f.state.bind({
    channelId: 'child',
    guildId: 'guild',
    provider: PROVIDERS.CODEX,
    nativeId: 'f8296579-092b-4503-bf98-1f3c2b6d4913',
    workspace: f.dir
  }), /already enrolled/);
});

test('child reconciliation reopens terminal history without losing custody or cursors', t => {
  const f = fixture(t);
  adoptReady(f, '100');
  const accepted = f.state.acceptDiscordMessage(event('101'), {
    ready: false,
    coverageId: '101',
    expectedBinding: f.state.getBinding('parent')
  });
  assert.equal(accepted.accepted, true);
  f.state.markThreadBoundary('child', THREAD_STATES.UNAVAILABLE, 'gateway unavailable', '102', '103', f.state.getBinding('parent'));
  const before = f.state.getThreadEnrollment('child');

  const reconciled = f.state.reconcileIntake('child');

  assert.equal(reconciled.state, THREAD_STATES.PENDING);
  assert.equal(reconciled.adoptedThroughId, before.adoptedThroughId);
  assert.equal(reconciled.recoveredThroughId, before.recoveredThroughId);
  assert.equal(reconciled.lastSeenId, before.lastSeenId);
  assert.equal(reconciled.lastAcceptedId, before.lastAcceptedId);
  assert.equal(reconciled.gapFrom, null);
  assert.equal(reconciled.gapTo, null);
  assert.equal(reconciled.detail, null);
  assert.equal(f.state.getBinding('parent').readiness, READINESS.READY);
  assert.equal(f.state.getMessage('101').channelId, 'parent');
  assert.equal(f.state.listReceipts().some(row => row.kind === THREAD_RECEIPT_KINDS.RECONCILED), true);
});

test('child route readiness fences dispatch claims without demoting the parent', t => {
  const f = fixture(t);
  f.enroll();
  const accepted = f.state.acceptDiscordMessage(event('301'), {
    expectedBinding: f.state.getBinding('parent')
  });
  assert.equal(accepted.accepted, true);

  for (const boundary of [THREAD_STATES.PENDING, THREAD_STATES.GAP, THREAD_STATES.UNAVAILABLE]) {
    if (boundary !== THREAD_STATES.PENDING) {
      f.state.markThreadBoundary('child', boundary, `child ${boundary}`, null, null, f.state.getBinding('parent'));
    }
    const held = f.state.claimDispatch('301');
    assert.equal(held.claimed, false);
    assert.equal(held.reason, 'binding-not-ready');
    assert.equal(f.state.getMessage('301').state, MESSAGE_STATES.ACCEPTED);
    assert.equal(f.state.getBinding('parent').readiness, READINESS.READY);
  }

  f.state.markThreadBoundary('child', THREAD_STATES.READY, 'child recovered', null, null, f.state.getBinding('parent'));
  const claimed = f.state.claimDispatch('301');
  assert.equal(claimed.claimed, true);
  assert.equal(f.state.getMessage('301').state, MESSAGE_STATES.DISPATCHING);
});

test('paused child intake preserves source custody without claiming recovery coverage', t => {
  const f = fixture(t);
  adoptReady(f, '100');
  const parent = f.state.getBinding('parent');
  f.state.pauseOrdinaryHandoffIntake('parent', parent);
  const held = f.state.acceptDiscordMessage(event('401'), { coverageId: '401', expectedBinding: parent });
  assert.equal(held.accepted, true);
  assert.equal(held.message.nativeId, NATIVE);
  assert.equal(held.message.generation, parent.generation);
  assert.equal(held.message.channelId, 'parent');
  assert.equal(held.message.deliveryChannelId, 'child');
  assert.equal(f.state.getThreadEnrollment('child').recoveredThroughId, '100');
  assert.equal(f.state.claimDispatch('401').claimed, false);
  for (const [id, overrides, reason] of [
    ['402', { content: '' }, 'invalid-event'],
    ['403', { authorId: 'other' }, 'unauthorized-sender'],
    ['404', { isBot: true }, 'bot-source']
  ]) {
    const rejected = f.state.acceptDiscordMessage(event(id, 'child', overrides), { expectedBinding: parent });
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.reason, reason);
    assert.equal(f.state.getMessage(id), null);
  }
  assert.equal(f.state.getThreadEnrollment('child').recoveredThroughId, '100');
  f.state.restoreOrdinaryHandoffIntake('parent', parent);
  assert.equal(f.state.claimDispatch('401').claimed, true);
  assert.equal(f.state.claimDispatch('401').claimed, false);
  assert.equal(f.state.acceptDiscordMessage(event('401'), { expectedBinding: parent }).duplicate, true);
});

test('child handoff fence rejects delayed predecessor events under the successor', t => {
  const f = fixture(t, { ordinary: true });
  adoptReady(f, '100');
  const predecessor = f.state.getBinding('parent');
  const transcriptFile = path.join(f.dir, 'successor.jsonl');
  fs.writeFileSync(transcriptFile, '');

  const successor = f.state.handoffOrdinary({
    channelId: 'parent', provider: PROVIDERS.CODEX, fromNativeId: NATIVE, fromGeneration: predecessor.generation,
    nativeId: SUCCESSOR, workspace: f.dir, sessionRoot: null, handoffId: 'child-fence-handoff', intakeCutoff: '150',
    identity: { sessionId: SUCCESSOR, threadId: SUCCESSOR },
    nativeProof: { file: transcriptFile, sessionId: SUCCESSOR, threadId: SUCCESSOR, workspace: f.dir, sessionRoot: null }
  });
  assert.equal(successor.generation, predecessor.generation + 1);
  assert.equal(f.state.getThreadEnrollment('child').recoveredThroughId, '150');

  const delayed = f.state.acceptDiscordMessage(event('120'), { expectedBinding: successor });
  assert.equal(delayed.accepted, false);
  assert.equal(delayed.reason, 'before-intake-cutoff');
  assert.equal(f.state.getMessage('120'), null);

  const current = f.state.acceptDiscordMessage(event('151'), { expectedBinding: successor });
  assert.equal(current.accepted, true);
  assert.equal(current.message.generation, successor.generation);
});

test('accepted child custody blocks parent handoff and unbind during a pause', t => {
  const f = fixture(t, { ordinary: true });
  adoptReady(f, '100');
  const parent = f.state.getBinding('parent');
  f.state.pauseOrdinaryHandoffIntake('parent', parent);
  assert.equal(f.state.acceptDiscordMessage(event('401'), { expectedBinding: parent }).accepted, true);
  const file = path.join(f.dir, 'successor.jsonl');
  fs.writeFileSync(file, '');
  assert.throws(() => f.state.handoffOrdinary({
    channelId: 'parent', provider: PROVIDERS.CODEX, fromNativeId: NATIVE, fromGeneration: parent.generation,
    nativeId: SUCCESSOR, workspace: f.dir, sessionRoot: null, handoffId: 'child-pause-handoff',
    identity: { sessionId: SUCCESSOR, threadId: SUCCESSOR },
    nativeProof: { file, sessionId: SUCCESSOR, threadId: SUCCESSOR, workspace: f.dir, sessionRoot: null }
  }), /unresolved/);
  assert.throws(() => f.state.unbind('parent', { expectedBinding: parent }), /unresolved/);
  assert.equal(f.state.getBinding('parent').generation, parent.generation);
  assert.equal(f.state.getThreadEnrollment('child').active, true);
  assert.equal(f.state.getMessage('401').state, MESSAGE_STATES.ACCEPTED);
});

test('schema 1.6 rows migrate additively to 1.7 on reopen', t => {
  const f = fixture(t);
  const accepted = f.state.acceptDiscordMessage(event('201', 'parent'), { expectedBinding: f.state.getBinding('parent') });
  assert.equal(accepted.accepted, true);
  f.state.close();
  const legacy = new DatabaseSync(f.db);
  legacy.exec("DROP INDEX IF EXISTS thread_enrollments_parent_idx; DROP TABLE thread_enrollments; ALTER TABLE messages DROP COLUMN delivery_channel_id; UPDATE meta SET value='1.6' WHERE key='schema';");
  legacy.close();
  const reopened = f.reopen();
  assert.equal(reopened.getMessage('201').deliveryChannelId, 'parent');
  assert.equal(reopened.db.prepare("SELECT value FROM meta WHERE key='schema'").get().value, '1.7');
  assert.equal(reopened.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='thread_enrollments'").get().name, 'thread_enrollments');
  assert.equal(reopened.db.prepare('PRAGMA table_info(messages)').all().some(row => row.name === 'delivery_channel_id'), true);
});
