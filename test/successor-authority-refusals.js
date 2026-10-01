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
test('2: live predecessor refuses even though its manifest lifecycle state is done', () => {
  const result = runScenario('live_predecessor');
  assertRefused(result, 'live predecessor');
  assert.match(result.stderr, /predecessor process is still live/);
});
test('3: missing predecessor manifest entirely refuses', () => {
  const result = runScenario('missing_predecessor');
  assertRefused(result, 'missing predecessor');
  assert.match(result.stderr, /no readable manifest matches the bound predecessor identity exactly/);
});
test('4: matching-filename malformed manifest refuses as unknown, never ignored', () => {
  const result = runScenario('malformed_predecessor');
  assertRefused(result, 'malformed predecessor');
  assert.match(result.stderr, /matching predecessor manifest is unreadable/);
});
test('5: readable exact identity under a different filename is inspected and refuses while live', () => {
  const result = runScenario('different_filename');
  assertRefused(result, 'different-filename predecessor');
  assert.match(result.stderr, /predecessor process is still live/);
});
test('6: conflicting candidate full identities refuse for provider and workspace disagreement', () => {
  const provider = runScenario('conflict_provider');
  assertRefused(provider, 'conflicting provider');
  assert.match(provider.stderr, /conflicting predecessor identity records disagree/);
  const workspace = runScenario('conflict_workspace');
  assertRefused(workspace, 'conflicting workspace');
  assert.match(workspace.stderr, /conflicting predecessor identity records disagree/);
});
test('7: reused PID whose live process start differs from the manifest qualifies as gone', () => {
  const result = runScenario('different_start');
  assertCommitted(result, '1', 'reused-PID predecessor');
  assert.match(result.child.argv.join(' '), /--handoff-id lock-handoff-/);
});
test('8: EPERM and unavailable process-start evidence both refuse', () => {
  const eperm = runScenario('eperm');
  assertRefused(eperm, 'EPERM probe');
  assert.match(eperm.stderr, /predecessor process liveness is unknown/);
  const unknown = runScenario('unknown_start');
  assertRefused(unknown, 'unknown start evidence');
  assert.match(unknown.stderr, /predecessor process liveness is unknown/);
});
test('9: override and preempt transitions both refuse even with otherwise-qualifying history', () => {
  const override = runScenario('override');
  assertRefused(override, 'override transition');
  assert.match(override.stderr, /forced takeover is not a normal release-to-claim handoff/);
  const preempt = runScenario('preempt');
  assertRefused(preempt, 'preempt transition');
  assert.match(preempt.stderr, /forced takeover is not a normal release-to-claim handoff/);
});
test('10: steal whose immediately-prior owner does not match the bound predecessor refuses', () => {
  const result = runScenario('wrong_predecessor');
  assertRefused(result, 'wrong bound predecessor');
  assert.match(result.stderr, /predecessor/);
});
test('11: successor identity change between the pre-lock and locked snapshots refuses', () => {
  const result = runScenario('successor_change');
  assertRefused(result, 'successor snapshot change');
  assert.match(result.stderr, /conductor worker identity changed while acquiring the writer gate/);
});
test('12: predecessor manifest identity change between the pre-lock and locked checks refuses', () => {
  const result = runScenario('predecessor_change');
  assertRefused(result, 'predecessor snapshot change');
  assert.match(result.stderr, /conductor worker identity changed while acquiring the writer gate/);
});
test('13: an intervening different owner-changing event after the steal refuses', () => {
  const result = runScenario('intervening');
  assertRefused(result, 'intervening owner mutation');
  assert.match(result.stderr, /changed owner after the identified steal|forced takeover/);
});
test('14: normal release/claim still works and clears any inherited carry marker', () => {
  const result = runScenario('normal_release_claim', { preCarryEnv: '1' });
  assertCommitted(result, null, 'normal release/claim');
  assert.match(result.child.argv.join(' '), /--handoff-id lock-handoff-/);
  assert.ok(!result.child.argv.includes('--reuse'));
});
