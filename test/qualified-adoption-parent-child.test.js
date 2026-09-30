'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');

const { SurfaceState } = require('../src/state');
const { ADOPTION_REFUSAL_DETAILS } = require('../src/discord/history-access');
const { enrollPublicThread } = require('../src/discord/thread-enrollment');
const { fixture } = require('./helpers/intake-recovery-fixture');
const {
  tempDir,
  makeState,
  grant,
  refusalFrom,
  fakeDiscordClient
} = require('./helpers/qualified-adoption-fixture');

test('active parent reuse preserves coverage without another history read', { timeout: 8000 }, async () => {
  const dir = tempDir('qualified-reuse-');
  const db = path.join(dir, 'surface.sqlite');
  const state = makeState(dir);
  state.close();
  const codex = '9caa5d21-2169-429d-918b-5f08651b5dbd';
  let reads = 0;
  const channel = {
    id: '500', guildId: 'guild', name: 'dev', isTextBased: () => true,
    permissionsFor: () => grant(true),
    messages: { async fetch() { reads += 1; return new Map([['700', { id: '700' }]]); } }
  };
  const dependencies = {
    environment: { CODEX_SESSION_ID: codex, CODEX_THREAD_ID: codex, PWD: dir },
    requireInstalled: () => ({ Client: fakeDiscordClient(channel), GatewayIntentBits: { Guilds: 1 }, PermissionFlagsBits }),
    readSecret: () => 'fixture-token',
    validateCodexSessionIdentity: () => ({ file: path.join(dir, 'session.jsonl'), sessionId: codex, threadId: codex, workspace: dir }),
    codexSessionRoot: () => path.join(dir, 'sessions'),
    gatewayProcessStatus: () => ({ state: 'stopped' }),
    print: () => {}
  };
  const { ordinaryBind } = require('../src/ordinary-bind');
  try {
    const first = await ordinaryBind({ 'state-dir': dir, channel: '#dev', workspace: dir }, dependencies);
    assert.equal(first.binding.active, true);
    const afterFirst = reads;
    const watermarkBefore = new SurfaceState(db);
    const cutoffBefore = watermarkBefore.getIntakeWatermark('500').recovered_through_id;
    watermarkBefore.close();
    const second = await ordinaryBind({ 'state-dir': dir, channel: '#dev', workspace: dir }, dependencies);
    assert.equal(second.reused, true);
    assert.equal(reads, afterFirst, 'active reuse must not perform another history read');
    const reopened = new SurfaceState(db);
    try {
      assert.equal(reopened.getIntakeWatermark('500').recovered_through_id, cutoffBefore);
      assert.equal(cutoffBefore, '700');
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parent recovery dispatches accepted A and offline B once while excluding H', { timeout: 8000 }, async t => {
  const f = fixture(t);
  const binding = f.state.getBinding('1000');
  const H = f.message('100', '1000');
  const A = f.message('101', '1000');
  const offlineB = f.message('102', '1000');
  f.history.set('1000', [H, A]);
  const accepted = f.state.acceptDiscordMessage(
    { ...A, authorId: 'operator', isBot: false, attachments: [] },
    { ready: false, expectedBinding: binding }
  );
  assert.equal(accepted.accepted, true, 'accepted A must enter custody before the failure');
  f.fail({ id: '1000', kind: 'history', status: 503 });
  await f.recover();
  assert.equal(f.boundary('1000').state, 'unavailable');
  assert.equal(f.cursor('1000'), '100');
  f.history.set('1000', [offlineB, A, H]);
  f.fail(null);
  f.enableDelivery();
  await f.recover();
  assert.equal(f.boundary('1000').state, 'ready');
  assert.equal(f.cursor('1000'), '102');
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  await f.gateway.reconcilePending(undefined, { readyOnly: true });
  await f.gateway.consumer.waitForNativeWork();
  const ids = f.dispatched.map(message => message.id).sort();
  assert.deepEqual(ids, ['101', '102'], 'accepted A and offline B dispatch exactly once');
  assert.equal(f.state.getMessage('100'), null, 'historical H must stay excluded');
  assert.equal(f.state.getMessage('101').state, 'replied');
  assert.equal(f.state.getMessage('102').state, 'replied');
});

// ---------------------------------------------------------------------------
// Cases 17-20: parent persistence.
// ---------------------------------------------------------------------------

test('fresh parent state activation refuses omitted adoption coverage', { timeout: 8000 }, async () => {
  const dir = tempDir('qualified-parent-refuse-');
  const state = makeState(dir);
  try {
    const error = await refusalFrom(() => state.bind({
      channelId: '1000', guildId: 'guild', provider: 'codex',
      nativeId: '11111111-1111-4111-8111-111111111111', workspace: dir
    }));
    assert.equal(error.detail, ADOPTION_REFUSAL_DETAILS.PARENT_CUTOFF);
    assert.match(error.message, /explicit decimal adoption cutoff/);
    assert.equal(state.getBinding('1000'), null, 'no activation row may exist without its boundary');
    assert.equal(state.getIntakeWatermark('1000'), null, 'no watermark may exist without activation');
    for (const malformed of [null, '', '12a', 'abc', 0]) {
      const malformedError = await refusalFrom(() => state.bind({
        channelId: `chan-${String(malformed)}`, guildId: 'guild', provider: 'codex',
        nativeId: '22222222-2222-4222-8222-222222222222', workspace: dir
      }, { intakeCutoff: malformed }));
      assert.equal(malformedError.detail, ADOPTION_REFUSAL_DETAILS.PARENT_CUTOFF);
    }
  } finally {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh parent state activation commits zero and activation atomically', { timeout: 8000 }, async () => {
  const dir = tempDir('qualified-parent-zero-');
  const state = makeState(dir);
  try {
    const binding = state.bind({
      channelId: '1000', guildId: 'guild', provider: 'codex',
      nativeId: '11111111-1111-4111-8111-111111111111', workspace: dir
    }, { intakeCutoff: '0' });
    assert.equal(binding.active, true);
    const watermark = state.getIntakeWatermark('1000');
    assert.equal(watermark.recovered_through_id, '0');
    assert.equal(watermark.last_seen_id, '0');
    assert.equal(watermark.state, 'pending');
  } finally {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed parent activation transaction leaves neither activation nor coverage', { timeout: 8000 }, async () => {
  const dir = tempDir('qualified-parent-rollback-');
  const state = makeState(dir);
  try {
    await refusalFrom(() => state.bind({
      channelId: '1000', guildId: 'guild', provider: 'codex',
      nativeId: '11111111-1111-4111-8111-111111111111', workspace: dir
    }, {
      intakeCutoff: '0',
      beforeMutation() { throw new Error('injected activation transaction failure'); }
    }));
    assert.equal(state.getBinding('1000'), null, 'a failed commit must roll back activation');
    assert.equal(state.getIntakeWatermark('1000'), null, 'a failed commit must roll back coverage');
  } finally {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parent owner change during history acquisition refuses activation', { timeout: 8000 }, async () => {
  const dir = tempDir('qualified-parent-owner-');
  const state = makeState(dir);
  const nativeId = '11111111-1111-4111-8111-111111111111';
  const original = state.assertNativeOwnerFree.bind(state);
  let injected = false;
  state.assertNativeOwnerFree = (provider, candidateNativeId, exclude) => {
    const result = original(provider, candidateNativeId, exclude);
    if (!injected) {
      injected = true;
      // A competing owner wins between the acquisition check and the commit.
      state.db.prepare(`INSERT INTO bindings(channel_id, guild_id, provider, native_id, workspace, session_root,
        endpoint, category_id, conductor_id, repo_key, readiness, generation, active, updated_at)
        VALUES(?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, 1, ?)`).run(
        'other-owner', 'guild', provider, nativeId, '/tmp', 'pending', 1, new Date().toISOString());
    }
    return result;
  };
  try {
    const error = await refusalFrom(() => state.bind({
      channelId: '1000', guildId: 'guild', provider: 'codex', nativeId, workspace: dir
    }, { intakeCutoff: '100' }));
    assert.match(error.message, /already owned|another channel/i);
    assert.equal(state.getBinding('1000'), null, 'a lost owner race must not activate the route');
    assert.equal(state.getIntakeWatermark('1000'), null);
  } finally {
    state.assertNativeOwnerFree = original;
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cases 21-26: child persistence.
// ---------------------------------------------------------------------------

function enrolledChild(f, { id = '3000', newest = '205' } = {}) {
  let reads = 0;
  const child = {
    ...f.channels.get('2000'),
    id,
    permissionsFor: () => grant(true),
    messages: {
      async fetch(input) {
        if (typeof input === 'string') return { async react() {} };
        reads += 1;
        return new Map([[newest, { id: newest }]]);
      }
    }
  };
  f.channels.set(id, child);
  return () => reads;
}

test('active child reuse preserves coverage without another history read', { timeout: 8000 }, async t => {
  const f = fixture(t);
  const reads = enrolledChild(f);
  const first = await enrollPublicThread(f.state, f.gateway.client, '1000', '3000');
  assert.equal(first.active, true);
  assert.equal(first.recoveredThroughId, '205');
  const afterFirst = reads();
  const second = await enrollPublicThread(f.state, f.gateway.client, '1000', '3000');
  assert.equal(second.active, true);
  assert.equal(second.recoveredThroughId, '205');
  assert.equal(reads(), afterFirst, 'active child reuse must not read history again');
  f.state.bind({ channelId: '9999', guildId: 'guild', provider: 'codex',
    nativeId: '99999999-9999-4999-8999-999999999999', workspace: f.state.getBinding('1000').workspace },
  { intakeCutoff: '0' });
  f.channels.set('9999', {
    ...f.channels.get('1000'),
    parentId: '2000',
    messages: { async fetch() { return new Map(); } }
  });
  const before = f.state.getThreadEnrollment('3000');
  const foreign = await refusalFrom(() => enrollPublicThread(f.state, f.gateway.client, '9999', '3000'));
  assert.ok(foreign, 'foreign parent reuse must refuse');
  assert.deepEqual(f.state.getThreadEnrollment('3000'), before);
  assert.equal(reads(), afterFirst);
  const enroll = f.state.enrollThread.bind(f.state);
  for (const [column, value] of [['generation', 99], ['guild_id', 'foreign-guild']]) {
    const binding = f.state.getBinding('1000');
    let reached = false;
    f.state.enrollThread = (input, expected) => {
      reached = true;
      f.state.db.prepare(`UPDATE bindings SET ${column}=? WHERE channel_id=?`).run(value, '1000');
      return enroll(input, expected);
    };
    try {
      await refusalFrom(() => enrollPublicThread(f.state, f.gateway.client, '1000', '3000'));
      assert.equal(reached, true, `${column} change must reach the enrollment transaction`);
      assert.deepEqual(f.state.getThreadEnrollment('3000'), before);
      assert.equal(reads(), afterFirst);
    } finally {
      f.state.enrollThread = enroll;
      f.state.db.prepare('UPDATE bindings SET generation=?, guild_id=? WHERE channel_id=?')
        .run(binding.generation, binding.guildId, '1000');
    }
  }
});

test('child parent generation change after acquisition refuses activation', { timeout: 8000 }, async t => {
  const f = fixture(t);
  enrolledChild(f);
  const realFetch = f.gateway.client.channels.fetch.bind(f.gateway.client.channels);
  let bumped = false;
  f.gateway.client.channels.fetch = async id => {
    const value = await realFetch(id);
    if (id === '3000' && !bumped) {
      bumped = true;
      f.state.db.prepare('UPDATE bindings SET generation=generation+1 WHERE channel_id=?').run('1000');
    }
    return value;
  };
  const error = await refusalFrom(() => enrollPublicThread(f.state, f.gateway.client, '1000', '3000'));
  assert.ok(error);
  assert.equal(f.state.getThreadEnrollment('3000'), null, 'a changed parent generation must leave no child row');
});

test('concurrent active child winner retains its own adoption cutoff', { timeout: 8000 }, async t => {
  const f = fixture(t);
  const parent = f.state.getBinding('1000');
  const winner = f.state.enrollThread(
    { threadId: '3000', parentChannelId: '1000', guildId: 'guild', adoptionCutoff: '111' }, parent);
  assert.equal(winner.recoveredThroughId, '111');
  // The losing snapshot reaches persistence after the winner already committed.
  const loser = f.state.enrollThread(
    { threadId: '3000', parentChannelId: '1000', guildId: 'guild', adoptionCutoff: '222' }, parent);
  assert.equal(loser.recoveredThroughId, '111', 'the concurrent active winner keeps its own snapshot');
  assert.equal(loser.active, true);
  assert.equal(f.state.getThreadEnrollment('3000').recoveredThroughId, '111');
});

test('inactive child reactivation requires a new qualified adoption cutoff', { timeout: 8000 }, async t => {
  const f = fixture(t);
  const reads = enrolledChild(f);
  const parent = f.state.getBinding('1000');
  const created = f.state.enrollThread(
    { threadId: '3000', parentChannelId: '1000', guildId: 'guild', adoptionCutoff: '111' }, parent);
  assert.equal(created.recoveredThroughId, '111');
  f.state.db.prepare("UPDATE thread_enrollments SET active=0, state='unavailable' WHERE thread_id='3000'").run();
  const error = await refusalFrom(() => f.state.enrollThread(
    { threadId: '3000', parentChannelId: '1000', guildId: 'guild' }, parent));
  assert.equal(error.detail, ADOPTION_REFUSAL_DETAILS.CHILD_CUTOFF);
  const held = f.state.getThreadEnrollment('3000');
  assert.equal(held.active, false, 'no-cutoff reuse must not reactivate the route');
  assert.equal(held.recoveredThroughId, '111');
  // A route that becomes inactive after the active-reuse check passes must refuse,
  // not silently reactivate through the public helper. Flip the row inactive in the
  // window immediately before the shared enrollment transaction commits.
  const f2 = fixture(t);
  const reads2 = enrolledChild(f2);
  await enrollPublicThread(f2.state, f2.gateway.client, '1000', '3000');
  const realEnroll = f2.state.enrollThread.bind(f2.state);
  let flipped = false;
  f2.state.enrollThread = (input, binding) => {
    if (!flipped) {
      flipped = true;
      f2.state.db.prepare("UPDATE thread_enrollments SET active=0, state='unavailable' WHERE thread_id='3000'").run();
    }
    return realEnroll(input, binding);
  };
  const publicError = await refusalFrom(() => enrollPublicThread(f2.state, f2.gateway.client, '1000', '3000'));
  assert.ok(publicError, 'a route going inactive during no-cutoff reuse must refuse');
  assert.equal(flipped, true, 'active reuse must reach the shared enrollment transaction');
  assert.equal(f2.state.getThreadEnrollment('3000').active, false);
  assert.equal(reads2(), 1, 'active reuse still performs no history read when it later refuses');
});

test('cancelled child acquisition leaves the route inactive and parent unchanged', { timeout: 8000 }, async t => {
  const f = fixture(t);
  enrolledChild(f);
  const parentBefore = f.state.getBinding('1000');
  const controller = new AbortController();
  controller.abort();
  await refusalFrom(() => enrollPublicThread(f.state, f.gateway.client, '1000', '3000', controller.signal));
  assert.equal(f.state.getThreadEnrollment('3000'), null);
  assert.deepEqual(f.state.getBinding('1000'), parentBefore);
});

test('failed child activation transaction leaves neither activation nor coverage', { timeout: 8000 }, async t => {
  const f = fixture(t);
  enrolledChild(f);
  const parentBefore = f.state.getBinding('1000');
  const realReceipt = f.state.receipt.bind(f.state);
  f.state.receipt = (discordId, kind, detail) => {
    if (kind === 'thread-enrolled') throw new Error('injected child transaction failure');
    return realReceipt(discordId, kind, detail);
  };
  try {
    await refusalFrom(() => enrollPublicThread(f.state, f.gateway.client, '1000', '3000'));
  } finally {
    f.state.receipt = realReceipt;
  }
  assert.equal(f.state.getThreadEnrollment('3000'), null, 'a failed child commit must roll back activation');
  assert.deepEqual(f.state.getBinding('1000'), parentBefore);
});

// ---------------------------------------------------------------------------
// Cases 27-29: legacy child tuples.
// ---------------------------------------------------------------------------

test('completed empty legacy child retains adoption provenance while qualifying zero', { timeout: 8000 }, async t => {
  const f = fixture(t);
  const before = f.state.getThreadEnrollment('2000');
  assert.ok(before.adoptedAt, 'the fixture child carries real adoption provenance');
  f.state.db.prepare(`UPDATE thread_enrollments
    SET adopted_through_id=NULL, recovered_through_id=NULL, last_seen_id='205'
    WHERE thread_id='2000'`).run();
  const baseline = f.state.setThreadBaseline('2000', '0', f.state.getBinding('1000'));
  assert.equal(baseline.recoveredThroughId, '0');
  assert.equal(baseline.adoptedAt, before.adoptedAt, 'adoption provenance must be preserved');
  assert.equal(baseline.adoptedThroughId, null);
  assert.equal(baseline.lastSeenId, '205');
});

test('nonempty legacy child without coverage remains held', { timeout: 8000 }, async t => {
  const f = fixture(t);
  const before = f.state.getThreadEnrollment('2000');
  f.state.db.prepare(`UPDATE thread_enrollments
    SET adopted_through_id='150', recovered_through_id=NULL, last_seen_id='205'
    WHERE thread_id='2000'`).run();
  await refusalFrom(() => f.state.setThreadBaseline('2000', '205', f.state.getBinding('1000')));
  const held = f.state.getThreadEnrollment('2000');
  assert.equal(held.recoveredThroughId, null, 'a nonempty adopted boundary without coverage stays held');
  assert.equal(held.adoptedThroughId, '150');
  assert.equal(held.adoptedAt, before.adoptedAt);
  assert.equal(held.lastSeenId, '205');
});

test('never-adopted historical child remains held', { timeout: 8000 }, async t => {
  const f = fixture(t);
  f.state.db.prepare(`UPDATE thread_enrollments
    SET adopted_at=NULL, adopted_through_id=NULL, recovered_through_id=NULL, last_seen_id='205'
    WHERE thread_id='2000'`).run();
  await refusalFrom(() => f.state.setThreadBaseline('2000', '205', f.state.getBinding('1000')));
  const held = f.state.getThreadEnrollment('2000');
  assert.equal(held.recoveredThroughId, null, 'a never-adopted historical tuple stays held');
  assert.equal(held.adoptedAt, null);
  assert.equal(held.adoptedThroughId, null);
  assert.equal(held.lastSeenId, '205');
});
