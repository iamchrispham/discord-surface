const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChannelType, GatewayIntentBits } = require('discord.js');
const { SurfaceState, MESSAGE_STATES, READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { DiscordGateway, waitForRecoveryOperation } = require('../src/discord');
const { enrollPublicThread, recoverThread, AdoptionRefusalError, ADOPTION_REFUSAL_DETAILS } = require('../src/discord/thread-enrollment');
const { GATEWAY_CAPABILITIES, gatewayProcessStatus, main, pathsFor, threadEnroll } = require('../src/cli');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const { startReconciliationLookup } = require('../dist/discord/reconciliation-lookups');
const { fixture, NATIVE, SUCCESSOR } = require('./issue-thread-fixture');
test('old enrolled receipt cannot finish under a new direct binding', { timeout: 5000 }, async t => {
  const f = fixture(t); f.ready('100');
  f.gateway.boundMessage(f.message('101'));
  await Promise.all([...f.gateway.inFlight]);
  await f.gateway.consumer.waitForNativeWork();
  await f.gateway.consumer.waitForReceipts();
  const stored = f.state.getMessage('101');
  assert.equal(stored.state, MESSAGE_STATES.REPLIED);
  const parent = f.state.getBinding(f.parent.id);
  const before = f.reactions.length;
  const fetch = f.client.channels.fetch;
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.client.channels.fetch = async id => { if (id === f.child.id) { entered(); await blocked; } return fetch(id); };
  const pending = f.gateway.sendTransportReceipt(stored, { reaction: 'eyes-control', targetMessageId: stored.id });
  try {
    await started;
    assert.equal(f.state.unbind(f.parent.id, { expectedBinding: parent }), true);
    const direct = f.state.bind({ channelId: f.child.id, guildId: 'guild', provider: 'codex', nativeId: parent.nativeId, workspace: f.dir }, { intakeCutoff: '100' });
    assert.equal(direct.generation, stored.generation);
    release();
    await assert.rejects(pending, /message binding generation is stale/);
  } finally { release(); f.client.channels.fetch = fetch; }
  assert.equal(f.reactions.length, before, 'old authority must not publish a receipt after parent retirement');
});

test('checkpoint deadline before recursive fetch retains a bounded recovery wake', { timeout: 5000 }, async t => {
  const f = fixture(t); f.ready('100');
  f.gateway.liveCheckpointThreshold = 50;
  f.histories.set(f.child.id, [f.message('101')]);
  const originalNow = Date.now;
  const hasEvidence = f.state.hasIntakeEvidence.bind(f.state);
  let expired = false;
  f.state.hasIntakeEvidence = id => {
    const exists = hasEvidence(id);
    if (!exists && !expired) { expired = true; const later = originalNow() + f.gateway.recoveryTimeoutMs + 10; Date.now = () => later; }
    return exists;
  };
  try {
    f.gateway.beginLiveCheckpoint(new Map([[f.child.id, 50]]));
    await f.gateway.liveCheckpointPromise;
  } finally { Date.now = originalNow; f.state.hasIntakeEvidence = hasEvidence; }
  assert.equal(expired, true);
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.PENDING);
  f.histories.set(f.child.id, [f.message('101'), f.message('102')]);
  f.gateway.boundMessage(f.message('102'));
  await Promise.all([...f.gateway.inFlight]);
  await f.gateway.consumer.waitForReceipts();
  const retry = f.gateway.liveCheckpointPromise || f.gateway.recoveryPromise;
  if (retry) await retry;
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.READY);
  assert.deepEqual(f.dispatched.map(message => message.id), ['101', '102']);
  for (const id of ['101', '102']) assert.equal(f.state.getMessage(id).state, MESSAGE_STATES.REPLIED);
});

test('bounded child checkpoint retains a retry for an unseen tail', { timeout: 5000 }, async t => {
  const f = fixture(t); f.ready('100');
  f.gateway.historyPageLimit = 2;
  f.gateway.historyMaxMessages = 1;
  f.gateway.liveCheckpointThreshold = 1;
  f.gateway.liveCheckpointRetryDelayMs = 10;
  f.histories.set(f.child.id, [f.message('101'), f.message('102')]);
  const binding = f.state.getBinding(f.parent.id);
  for (const id of ['101']) {
    const accepted = f.state.acceptDiscordMessage({
      id, guildId: 'guild', channelId: f.child.id, authorId: 'operator', isBot: false,
      content: 'checkpointed child work', attachments: []
    }, { ready: true, expectedBinding: binding });
    assert.equal(accepted.accepted, true);
  }
  f.state.db.prepare('UPDATE thread_enrollments SET recovered_through_id=? WHERE thread_id=?').run('100', f.child.id);
  assert.equal(f.state.hasIntakeEvidence('101'), true);
  assert.equal(f.state.getMessage('102'), null);
  assert.equal(f.state.hasIntakeEvidence('102'), false);

  f.gateway.beginLiveCheckpoint(new Map([[f.child.id, 1]]));
  await f.gateway.liveCheckpointPromise;
  assert.equal(f.state.getThreadEnrollment(f.child.id).recoveredThroughId, '101');
  assert.ok(f.gateway.liveCheckpointRetryTimer);

  for (let attempt = 0; attempt < 100 && f.state.getMessage('102')?.state !== MESSAGE_STATES.REPLIED; attempt += 1) {
    if (f.gateway.liveCheckpointPromise) await f.gateway.liveCheckpointPromise;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getThreadEnrollment(f.child.id).recoveredThroughId, '102');
  assert.equal(f.state.getMessage('102').state, MESSAGE_STATES.REPLIED);
  assert.ok(f.dispatched.some(message => message.id === '102'));
  assert.ok(f.sends.some(send => send.channelId === f.child.id));
});

test('bounded child checkpoint does not complete a short page before its tail', { timeout: 5000 }, async t => {
  const f = fixture(t); f.ready('100');
  f.gateway.historyPageLimit = 3;
  f.gateway.historyMaxMessages = 1;
  f.gateway.liveCheckpointThreshold = 1;
  f.gateway.liveCheckpointRetryDelayMs = 10;
  f.histories.set(f.child.id, [f.message('101'), f.message('102')]);
  const binding = f.state.getBinding(f.parent.id);
  const accepted = f.state.acceptDiscordMessage({
    id: '101', guildId: 'guild', channelId: f.child.id, authorId: 'operator', isBot: false,
    content: 'checkpointed child work', attachments: []
  }, { ready: true, expectedBinding: binding });
  assert.equal(accepted.accepted, true);
  f.state.db.prepare('UPDATE thread_enrollments SET recovered_through_id=? WHERE thread_id=?').run('100', f.child.id);
  assert.equal(f.state.hasIntakeEvidence('101'), true);
  assert.equal(f.state.getMessage('102'), null);
  assert.equal(f.state.hasIntakeEvidence('102'), false);

  f.gateway.beginLiveCheckpoint(new Map([[f.child.id, 1]]));
  await f.gateway.liveCheckpointPromise;
  assert.equal(f.state.getThreadEnrollment(f.child.id).recoveredThroughId, '101');
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.READY);
  assert.equal(f.state.getMessage('102'), null);
  assert.equal(f.state.hasIntakeEvidence('102'), false);
  assert.ok(f.gateway.liveCheckpointRetryTimer);
});

async function pendingScenario(t, secondDeadline) {
  const f = fixture(t);
  let checkpointStarts = 0;
  const checkpointEntries = [];
  const originalBegin = f.gateway.beginLiveCheckpoint.bind(f.gateway);
  let capped = null;
  f.gateway.beginLiveCheckpoint = function(counts = new Map(), ...options) {
    checkpointStarts++;
    const entry = { start: checkpointStarts, at: performance.now(), channels: [...counts.keys()] };
    if (checkpointStarts <= 4 || checkpointStarts === 64) checkpointEntries.push(entry);
    if (checkpointStarts === 64) {
      capped = { counts: [...counts], live: [...this.liveIntakeCounts], recovery: Boolean(this.recoveryPromise) };
      return;
    }
    return originalBegin(counts, ...options);
  };
  f.gateway.recoveryTimeoutMs = 30;
  const slowChild = f.makeChannel('1500', ChannelType.PublicThread);
  if (secondDeadline) {
    f.channels.set(slowChild.id, slowChild);
    f.histories.set(slowChild.id, []);
    f.state.enrollThread({ threadId: slowChild.id, parentChannelId: f.parent.id, guildId: 'guild' , adoptionCutoff: '100'}, f.state.getBinding(f.parent.id));
  }
  f.state.enrollThread({ threadId: f.child.id, parentChannelId: f.parent.id, guildId: 'guild' , adoptionCutoff: '100'}, f.state.getBinding(f.parent.id));
  f.state.setThreadBaseline(f.child.id, '100', f.state.getBinding(f.parent.id));
  f.histories.set(f.child.id, [f.message('101')]);
  f.gateway.boundMessage(f.message('101'));
  await Promise.all([...f.gateway.inFlight]);
  await f.gateway.consumer.waitForReceipts();
  const slowParent = f.makeChannel('3000', ChannelType.GuildText);
  f.channels.set(slowParent.id, slowParent);
  f.histories.set(slowParent.id, []);
  f.state.bind({ channelId: slowParent.id, guildId: 'guild', provider: 'codex', nativeId: SUCCESSOR, workspace: f.dir }, { intakeCutoff: '100' });
  const fetch = f.client.channels.fetch;
  let slowParentCalls = 0;
  let slowChildCalls = 0;
  f.client.channels.fetch = async id => {
    if (id === slowParent.id) { slowParentCalls++; await new Promise(resolve => setTimeout(resolve, 60)); }
    if (secondDeadline && id === slowChild.id && slowChildCalls++ === 0) await new Promise(resolve => setTimeout(resolve, 60));
    return fetch(id);
  };
  await f.gateway.recoverTransport('reconnect');
  const firstRetry = f.gateway.liveCheckpointPromise;
  if (firstRetry) await firstRetry;
  await new Promise(resolve => setTimeout(resolve, 120));
  await f.gateway.consumer.waitForReceipts();
  await f.gateway.consumer.waitForNativeWork();
  const snapshot = {
    secondDeadline, checkpointStarts, checkpointEntries, capped, slowParentCalls, slowChildCalls, firstRetryStarted: Boolean(firstRetry),
    parentState: f.state.getBinding(f.parent.id).readiness,
    childState: f.state.getThreadEnrollment(f.child.id).state,
    messageState: f.state.getMessage('101').state,
    dispatched: f.dispatched.map(message => message.id),
    checkpointActive: Boolean(f.gateway.liveCheckpointPromise),
    recoveryActive: Boolean(f.gateway.recoveryPromise),
    heldCount: f.gateway.liveIntakeCounts.get(f.child.id)
  };
  assert.equal(capped, null, 'checkpoint recursion exceeded fixed 64-entry observation cap');
  assert.equal(snapshot.childState, THREAD_STATES.READY);
  assert.equal(snapshot.messageState, MESSAGE_STATES.REPLIED);
  assert.deepEqual(snapshot.dispatched, ['101']);
}

test('untouched pending child resumes after one shared deadline without arrival', { timeout: 3000 }, async t => {
  await pendingScenario(t, false);
});

test('healthy pending child is not stranded after an earlier retry consumes the deadline', { timeout: 3000 }, async t => {
  await pendingScenario(t, true);
});

test('live arrivals respect an existing checkpoint retry timer', { timeout: 3000 }, async t => {
  const f = fixture(t);
  f.ready('100');
  let calls = 0;
  f.gateway.checkpointHealthyIntake = async () => { calls++; return new Set(); };
  f.gateway.beginLiveCheckpoint(new Map([[f.child.id, f.gateway.liveCheckpointThreshold]]));
  await f.gateway.liveCheckpointPromise;
  assert.ok(f.gateway.liveCheckpointRetryTimer);
  const initialCalls = calls;
  for (let index = 0; index < 5; index++) {
    f.gateway.noteLiveIntake(f.message(String(101 + index)));
    if (f.gateway.liveCheckpointPromise) await f.gateway.liveCheckpointPromise;
  }
  f.gateway.liveIntakeCounts.set(f.child.id, f.gateway.liveCheckpointThreshold);
  f.gateway.scheduleHeldLiveCheckpoints();
  assert.equal(calls, initialCalls, 'arrivals must not bypass the pending retry delay');
});
