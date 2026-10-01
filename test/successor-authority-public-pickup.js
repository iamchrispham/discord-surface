'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { SurfaceState, READINESS, THREAD_STATES } = require('../src/state');
const { DiscordGateway } = require('../src/discord');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const { conductorMarker } = require('../src/cli');
const { CODEX_ID, SUCCESSOR_ID, CONDUCTOR_LOCK, CLI_PATH, fixture, historyPermissions, conductorLock, processStartTime, lockArtifacts, waitForProcessGone } = require('./surface-fixtures');
const PYTHON = process.env.DISCORD_SURFACE_PYTHON || 'python3';
const HELPER = path.join(__dirname, 'helpers', 'successor-authority.py');
const { runScenario, defaultWorkerEnv, assertRefused, assertCommitted, runPythonGate, fakeDiscordPreload, runPublicPickup, buildStealFixture, fakeDiscordClient, lockEnvFor } = require('./successor-authority-fixture');
test('1: qualified canonical steal through the public CLI carries an enrolled child message and dispatches it once', async () => {
  const f = buildStealFixture({ dbName: 'authority-from-lock.sqlite', channelId: 'authority-channel', threadId: 'child', messageId: '150', enroll: true });
  try {
    const first = f.runPickup();
    assert.equal(first.status, 0, first.stderr);
    const updated = new SurfaceState(f.db);
    try {
      const binding = updated.getBinding(f.channelId);
      assert.equal(binding.nativeId, SUCCESSOR_ID);
      assert.equal(binding.generation, 2);
      const carried = updated.getMessage(f.messageId);
      assert.equal(carried.nativeId, SUCCESSOR_ID);
      assert.equal(carried.generation, 2);
      assert.equal(carried.state, f.acceptedBefore.state);
      assert.equal(carried.content, f.acceptedBefore.content);
      assert.equal(carried.createdAt, f.acceptedBefore.createdAt);
      assert.equal(carried.deliveryChannelId, f.threadId);
      const afterReceipt = updated.listReceipts().find(row => row.id === f.acceptanceReceipt.id);
      assert.deepEqual(afterReceipt, f.acceptanceReceipt, 'original acceptance receipt is preserved unchanged');
      updated.setBindingReadiness(f.channelId, READINESS.READY, 'fixture successor ready');
      updated.markThreadBoundary(f.threadId, THREAD_STATES.READY, 'fixture successor', null, null, updated.getBinding(f.channelId));
    } finally { updated.close(); }

    const dispatches = [];
    const reopened = new SurfaceState(f.db);
    try {
      const route = reopened.getMessageRoute(f.threadId);
      assert.equal(route?.ready, true, 'child route must be ready before dispatch');
      assert.equal(reopened.getMessage(f.messageId).state, 'accepted', 'carried child message must stay accepted');
      const gateway = new DiscordGateway({
        state: reopened,
        client: fakeDiscordClient({ channelId: f.channelId, categoryId: f.categoryId, topic: f.topic, threadId: f.threadId }),
        providers: { codex: {
          async dispatch(message) {
            dispatches.push(message);
            recordNativeAcknowledgment(reopened, { provider: 'codex', messageId: message.id, nativeId: message.nativeId, generation: message.generation });
            return { status: 'submitted' };
          },
          async observe() { return { text: 'successor answer' }; }
        } },
        logger: () => {}
      });
      try {
        await gateway.start(f.secret);
        const reconciled = await gateway.reconcilePending();
        assert.deepEqual(reconciled.map(message => message.id), [f.messageId]);
        await gateway.consumer.waitForNativeWork();
        assert.equal(dispatches.length, 1, 'the carried child message dispatches exactly once');
        assert.equal(dispatches[0].id, f.messageId);
        assert.equal(dispatches[0].nativeId, SUCCESSOR_ID);
        assert.equal(dispatches[0].generation, 2);
      } finally { await gateway.stop(); }
    } finally { reopened.close(); }

    const repeat = f.runPickup();
    assert.equal(repeat.status, 0, repeat.stderr);
    const reused = new SurfaceState(f.db);
    try {
      const binding = reused.getBinding(f.channelId);
      assert.equal(binding.nativeId, SUCCESSOR_ID);
      assert.equal(binding.generation, 2, 'idempotent reuse preserves the generation');
      assert.equal(reused.getMessage(f.messageId).generation, 2);
      assert.equal(reused.listReceipts().filter(row => row.kind === 'conductor-custody-transferred').length, 1,
        'reuse mints no second transfer receipt');
    } finally { reused.close(); }
    assert.equal(dispatches.length, 1, 'idempotent reuse must not dispatch again');
  } finally { await f.cleanup(); }
});
