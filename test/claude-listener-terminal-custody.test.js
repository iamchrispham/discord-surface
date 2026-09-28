'use strict';

// Public-wrapper terminal custody fixtures for the PR104 stop-retry defects.
// Fixture-only: asserts the CORRECT behavior of the real cli.claudeChannel and
// cli.claudeMonitor wrappers, so the red rows turn green when the real retry
// mechanism is repaired. The readiness-revoke controls are independent
// top-level tests per wrapper, so they stay green even while the retry rows
// above them are red.
//
// Runner contract:
//   DISCORD_SOCKET_TEST_ROOT=<fresh dir> \
//   NODE_OPTIONS=--require=<artifact>/hermetic-preload.cjs \
//   node --test --test-concurrency=1 test/claude-listener-terminal-custody.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { startWrapperChild } = require('./helpers/claude-terminal-wrapper.cjs');

test('public Claude channel retries retained teardown without closing state early', { timeout: 8000 }, async t => {
  const harness = startWrapperChild(t, { mode: 'channel', failFirstStop: true, revokeReadiness: false });
  await harness.waitFor('started');

  // First close: transport.stop() rejects and retains ownership, so the wrapper must
  // NOT close the state store yet.
  harness.child.send({ cmd: 'close' });
  const first = await harness.waitFor('after-first');
  assert.equal(first.stopCalls, 1, 'the first close must attempt transport teardown');
  assert.equal(first.stateCloses, 0,
    'a retained teardown must not close the state store after the first failed attempt');

  // Second close: the wrapper must retry transport.stop() rather than reuse the
  // cached rejected promise.
  harness.child.send({ cmd: 'close' });
  const second = await harness.waitFor('after-second');
  assert.equal(second.stopCalls, 2,
    'the second close attempt must call transport.stop() again, not reuse the rejected promise');
  assert.equal(second.stateCloses, 1,
    'the successful teardown must close the state store exactly once');

  const outcome = await harness.finish();
  assert.equal(outcome.code, 1, 'the reported first-attempt stop failure must be reflected in the exit code');
});

test('public Claude Monitor retries retained teardown without closing state early', { timeout: 8000 }, async t => {
  const harness = startWrapperChild(t, { mode: 'monitor', failFirstStop: true, revokeReadiness: false });
  await harness.waitFor('started');

  // Real SIGINT triggers the wrapper's own stop path; the first attempt rejects and
  // must retain both the transport and the state store.
  harness.child.kill('SIGINT');
  const first = await harness.waitFor('after-first');
  assert.equal(first.stopCalls, 1, 'SIGINT must attempt transport teardown once');
  assert.equal(first.stateCloses, 0,
    'a retained teardown after SIGINT must not close the state store');

  // Real SIGTERM must retry transport.stop(), not replay the cached rejected promise.
  harness.child.kill('SIGTERM');
  const second = await harness.waitFor('after-second');
  assert.equal(second.stopCalls, 2,
    'SIGTERM must call transport.stop() again after the retained failure');
  assert.equal(second.stateCloses, 1,
    'the successful teardown must close the state store exactly once');

  const outcome = await harness.exited;
  assert.equal(outcome.code, 143, 'a successful SIGTERM teardown must exit 128+SIGTERM');
});

test('public Claude channel teardown still runs after readiness revoke fails', { timeout: 6000 }, async t => {
  const harness = startWrapperChild(t, { mode: 'channel', failFirstStop: false, revokeReadiness: true });
  await harness.waitFor('started');

  harness.child.send({ cmd: 'close' });
  const observed = await harness.waitFor('after-first');
  // Positive control: today the wrapper's finally semantics already run the transport
  // stop even though the readiness revoke threw, and the failure still surfaces.
  assert.equal(observed.stopCalls, 1,
    'transport teardown must still run when the readiness revoke throws');
  assert.equal(observed.stateCloses, 1,
    'the state store must be closed once after the teardown');
  assert.equal(observed.readinessRevokeCalls, 1,
    'the readiness revoke must have been attempted exactly once');
  assert.equal(observed.exitCode, 1,
    'a reported stop failure must be reflected in the process exit code');

  const outcome = await harness.finish();
  assert.equal(outcome.code, 1, 'the reported revoke failure must be reflected in the exit code');
});

test('public Claude Monitor teardown still runs after readiness revoke fails', { timeout: 6000 }, async t => {
  const harness = startWrapperChild(t, { mode: 'monitor', failFirstStop: false, revokeReadiness: true });
  await harness.waitFor('started');

  // For the Monitor control the real SIGINT handler drives the same readiness/stop path.
  harness.child.kill('SIGINT');
  const observed = await harness.waitFor('after-first');
  assert.equal(observed.stopCalls, 1,
    'transport teardown must still run when the readiness revoke throws');
  assert.equal(observed.stateCloses, 1,
    'the state store must be closed once after the teardown');
  assert.equal(observed.readinessRevokeCalls, 1,
    'the readiness revoke must have been attempted exactly once');
  assert.equal(observed.exitCode, 1,
    'a reported stop failure must be reflected in the process exit code');

  const outcome = await harness.exited;
  assert.equal(outcome.code, 1, 'the reported revoke failure must be reflected in the exit code');
});
