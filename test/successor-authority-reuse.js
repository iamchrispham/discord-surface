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
test('15: same-owner reuse after a real verified steal takes the reuse path without carry or fresh predecessor proof', async () => {
  const f = buildStealFixture({ dbName: 'authority-reuse.sqlite', channelId: 'authority-reuse', threadId: 'reuse-child', messageId: '250', enroll: false });
  try {
    const first = f.runPickup();
    assert.equal(first.status, 0, first.stderr);
    const committed = new SurfaceState(f.db);
    let generationAfterSteal;
    try {
      generationAfterSteal = committed.getBinding(f.channelId).generation;
      assert.equal(generationAfterSteal, 2);
      assert.equal(committed.getMessage(f.messageId).nativeId, SUCCESSOR_ID);
    } finally { committed.close(); }
    // A reuse pass must not demand fresh predecessor proof, so remove the
    // predecessor manifest entirely; only identity and history remain.
    fs.rmSync(f.predecessorManifest, { force: true });
    const reuse = f.runPickup();
    assert.equal(reuse.status, 0, reuse.stderr);
    const reused = new SurfaceState(f.db);
    try {
      const binding = reused.getBinding(f.channelId);
      assert.equal(binding.nativeId, SUCCESSOR_ID);
      assert.equal(binding.generation, generationAfterSteal, 'reuse performs no state mutation');
      assert.equal(reused.getMessage(f.messageId).generation, generationAfterSteal);
      assert.equal(reused.getMessage(f.messageId).state, 'accepted', 'reuse stays an idempotent no-op');
      assert.equal(reused.listReceipts().filter(row => row.kind === 'conductor-custody-transferred').length, 1,
        'no additional transfer receipt is minted on reuse');
    } finally { reused.close(); }
  } finally { await f.cleanup(); }
});
