'use strict';

// Terminal custody fixtures for the PR104 socket-ownership defects. Fixture-only:
// this suite asserts the CORRECT behavior at unchanged production owners, so the
// red rows turn green when the real mechanisms are repaired. The safety
// controls in this file and its listener sibling are independent top-level tests,
// so they stay green even while the witness rows above them are red.
//
// Runner contract:
//   DISCORD_SOCKET_TEST_ROOT=<fresh dir> \
//   NODE_OPTIONS=--require=<artifact>/hermetic-preload.cjs \
//   node --test --test-concurrency=1 test/claude-socket-terminal-custody.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isolateCoordinationRoot,
  displaceReplacement,
  prepareWithDeadOwner,
  makeEndpointFixture,
  quarantineNow
} = require('./helpers/claude-terminal-quarantine.cjs');
const { runElectionContenders } = require('./helpers/claude-terminal-election.cjs');

test('delayed same-user election contender keeps the first committed namespace', { timeout: 12000 }, async t => {
  const { earlyResult, lateResult } = await runElectionContenders(t);

  assert.ok(earlyResult && earlyResult.ok && earlyResult.namespace,
    `first contender must acquire its lock (${JSON.stringify(earlyResult)})`);
  assert.ok(lateResult && lateResult.ok === true,
    `delayed contender must also acquire a lock (${JSON.stringify(lateResult)})`);
  assert.equal(lateResult.namespace, earlyResult.namespace,
    'the delayed contender must keep the first committed namespace, not change the winner');
  assert.ok(typeof lateResult.namespace === 'string' &&
    path.basename(path.dirname(lateResult.namespace)).startsWith('.claude-channel-'),
    'the coordinated namespace must live under an owner-controlled private root');
});

test('orphan quarantine restores the displaced regular file before startup', { timeout: 6000 }, async t => {
  isolateCoordinationRoot(t);
  const displaced = displaceReplacement(t, 'file');

  const error = await prepareWithDeadOwner(displaced);

  // Correct behavior: the orphan reader recognizes the authenticated non-socket
  // quarantine, restores the original regular file, clears the quarantine, and then
  // startup refuses because the endpoint is not a socket.
  assert.equal(fs.existsSync(displaced.endpoint), true,
    'the displaced regular file must be restored at the endpoint before startup');
  assert.equal(fs.lstatSync(displaced.endpoint).isFile(), true,
    'the restored endpoint must be the original regular file, not a listener');
  assert.equal(fs.lstatSync(displaced.endpoint).isSocket(), false,
    'no listener/socket may exist at the endpoint');
  assert.equal(fs.readFileSync(displaced.endpoint, 'utf8'), displaced.originalBytes,
    'the original regular-file bytes must be preserved');
  assert.equal(fs.existsSync(displaced.quarantineDir), false,
    'the authenticated orphan quarantine must be cleared after restore');
  assert.ok(error, 'startup must refuse a non-socket endpoint');
  assert.match(String(error && error.message), /not a socket/);
  assert.equal(fs.readFileSync(displaced.unrelated, 'utf8'), 'unrelated-bytes',
    'unrelated files in the root must be untouched');
});

test('orphan quarantine restores the displaced symlink before startup', { timeout: 6000 }, async t => {
  isolateCoordinationRoot(t);
  const displaced = displaceReplacement(t, 'symlink');

  const error = await prepareWithDeadOwner(displaced);

  // Correct behavior: the original symlink object (not merely its target) is
  // restored, the quarantine is cleared, and startup refuses the non-socket endpoint.
  const restored = (() => {
    try { return fs.lstatSync(displaced.endpoint); } catch { return null; }
  })();
  assert.ok(restored, 'the displaced symlink must be restored at the endpoint before startup');
  assert.equal(restored.isSymbolicLink(), true, 'the restored endpoint must be the original symlink object');
  assert.equal(restored.isSocket(), false, 'no listener/socket may exist at the endpoint');
  assert.equal(fs.readlinkSync(displaced.endpoint), displaced.originalLinkTarget,
    'the original symlink target must be preserved');
  assert.equal(fs.existsSync(displaced.quarantineDir), false,
    'the authenticated orphan quarantine must be cleared after restore');
  assert.ok(error, 'startup must refuse a non-socket endpoint');
  assert.match(String(error && error.message), /not a socket/);
  assert.equal(fs.readFileSync(displaced.unrelated, 'utf8'), 'unrelated-bytes',
    'unrelated files in the root must be untouched');
});

function assertUntouched(fixture, kind) {
  if (kind === 'file') {
    assert.equal(fs.readFileSync(fixture.endpoint, 'utf8'), fixture.originalBytes,
      'the endpoint bytes must be untouched');
  } else {
    assert.equal(fs.readlinkSync(fixture.endpoint), fixture.originalLinkTarget,
      'the symlink target must be untouched');
  }
  assert.equal(fs.readFileSync(fixture.unrelated, 'utf8'), 'unrelated-bytes',
    'unrelated bytes in the root must be untouched');
}

// The unauthenticated control never restores anything (the endpoint stays
// absent); it asserts the still-quarantined entry itself was never touched.
function assertQuarantinedEntryUntouched(quarantineDir, fixture, kind) {
  const quarantinedPath = path.join(quarantineDir, 'socket');
  if (kind === 'file') {
    assert.equal(fs.readFileSync(quarantinedPath, 'utf8'), fixture.originalBytes,
      'the quarantined entry bytes must be untouched');
  } else {
    assert.equal(fs.readlinkSync(quarantinedPath), fixture.originalLinkTarget,
      'the quarantined entry symlink target must be untouched');
  }
  assert.equal(fs.readFileSync(fixture.unrelated, 'utf8'), 'unrelated-bytes',
    'unrelated bytes in the root must be untouched');
}

// Three independent positive controls per endpoint kind: a live owner, an
// unauthenticated entry, and a fresh replacement must each survive preparation
// untouched. These reuse the real public quarantine owner, never a fabricated entry.
function defineQuarantineControls(kind, label) {
  test(`live-owner ${label} quarantine is retained`, { timeout: 6000 }, async t => {
    isolateCoordinationRoot(t);
    const fixture = makeEndpointFixture(t, kind);
    const { quarantine, quarantineDir } = quarantineNow(fixture);

    const liveError = await prepareWithDeadOwner(fixture);
    assert.equal(liveError, null,
      'a live-owner quarantine must never block startup at an absent endpoint');
    assert.equal(fs.existsSync(quarantineDir), true, 'a live-owner quarantine must never be reclaimed');
    assert.equal(quarantine.restore(), true, 'the live-owner quarantine remains restorable');
    assertUntouched(fixture, kind);
  });

  test(`unauthenticated ${label} quarantine is retained`, { timeout: 6000 }, async t => {
    isolateCoordinationRoot(t);
    const fixture = makeEndpointFixture(t, kind);
    const { quarantineDir, ownerPath } = quarantineNow(fixture);
    // Remove only the owner record: the displaced entry stays, but it is no
    // longer an authenticated manifest the orphan reader may reclaim.
    fs.unlinkSync(ownerPath);

    await prepareWithDeadOwner(fixture);
    assert.equal(fs.existsSync(quarantineDir), true,
      'an unauthenticated quarantine entry must be preserved');
    assert.equal(fs.existsSync(path.join(quarantineDir, 'socket')), true,
      'the displaced entry inside an unauthenticated quarantine must be preserved');
    assertQuarantinedEntryUntouched(quarantineDir, fixture, kind);
  });

  test(`fresh endpoint replacement preserves ${label} quarantine`, { timeout: 6000 }, async t => {
    isolateCoordinationRoot(t);
    const displaced = displaceReplacement(t, kind);
    // A fresh, unrelated replacement now occupies the endpoint (not absent),
    // so preparation must refuse it and never reach for the dead-owner quarantine.
    const freshBytes = 'fresh-endpoint-bytes';
    fs.writeFileSync(displaced.endpoint, freshBytes, { mode: 0o600 });

    const error = await prepareWithDeadOwner(displaced);

    assert.ok(error, 'startup must refuse an existing non-socket endpoint');
    assert.match(String(error && error.message), /not a socket/);
    assert.equal(fs.readFileSync(displaced.endpoint, 'utf8'), freshBytes,
      'the fresh replacement bytes must never be overwritten');
    assert.equal(fs.existsSync(displaced.quarantineDir), true,
      'the original displaced quarantine entry must be retained, not reclaimed');
    assert.equal(fs.readFileSync(displaced.unrelated, 'utf8'), 'unrelated-bytes',
      'unrelated files in the root must be untouched');
  });
}

defineQuarantineControls('file', 'regular-file');
defineQuarantineControls('symlink', 'symlink');
