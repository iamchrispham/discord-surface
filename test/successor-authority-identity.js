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
test('16: duplicate JSON keys and non-finite JSON numbers in a manifest both refuse', () => {
  const duplicate = runScenario('duplicate_keys');
  assertRefused(duplicate, 'duplicate manifest keys');
  assert.match(duplicate.stderr, /duplicate JSON key/);
  const nonfinite = runScenario('nonfinite');
  assertRefused(nonfinite, 'non-finite manifest number');
  assert.match(nonfinite.stderr, /non-finite JSON number/);
});
test('17: a matching manifest whose pid, start time or generation is not a positive int refuses as invalid process identity', () => {
  const rows = [
    { invalidField: 'pid', invalidShape: 'null' },
    { invalidField: 'pid', invalidShape: 'true' },
    { invalidField: 'pid', invalidShape: 'false' },
    { invalidField: 'pid', invalidShape: 'zero' },
    { invalidField: 'pid', invalidShape: 'negative' },
    { invalidField: 'pid', invalidShape: 'string' },
    { invalidField: 'pid', invalidShape: 'list' },
    { invalidField: 'processStartTime', invalidShape: 'missing' },
    { invalidField: 'processStartTime', invalidShape: 'object' },
    { invalidField: 'generation', invalidShape: 'zero' },
    { invalidField: 'generation', invalidShape: 'string' },
    { invalidField: 'pid', invalidShape: 'missing', invalidDead: true }
  ];
  for (const row of rows) {
    const label = `${row.invalidField}=${row.invalidShape}${row.invalidDead ? ' (dead pid)' : ''}`;
    const result = runScenario('invalid_identity', row);
    assertRefused(result, label);
    assert.match(result.stderr, /predecessor manifest has invalid process identity/);
  }
});
test('18: a steal whose recorded owner is not the held successor refuses for fresh and reuse handoffs', () => {
  const fresh = runScenario('steal_owner_mismatch');
  assertRefused(fresh, 'steal owner mismatch');
  assert.match(fresh.stderr, /canonical steal owner does not match the held successor/);
  const reuse = runScenario('steal_owner_mismatch_reuse');
  assertRefused(reuse, 'steal owner mismatch on reuse');
  assert.match(reuse.stderr, /canonical steal owner does not match the held successor/);
});
test('19: a steal whose immediately-prior owner-changing record is a release refuses', () => {
  const result = runScenario('release_then_steal');
  assertRefused(result, 'release immediately before steal');
  assert.match(result.stderr, /canonical steal predecessor record does not establish ownership/);
});
test('20: contradictory session identity aliases refuse while an unrelated malformed manifest is still skipped', () => {
  const session = runScenario('contradictory_session');
  assertRefused(session, 'contradictory sessionId');
  assert.match(session.stderr, /matching predecessor manifest has no exact native identity/);
  const alias = runScenario('contradictory_alias');
  assertRefused(alias, 'contradictory fullUuid alias');
  assert.match(alias.stderr, /matching predecessor manifest has no exact native identity/);
  // A PRESENT alias that is null, empty or a non-string is not a missing alias:
  // it must fail exact native identity, while an absent alias stays optional.
  const invalidAliases = [
    ['alias_null', 'present null sessionId'],
    ['alias_zero', 'present zero sessionId'],
    ['alias_false', 'present false sessionId'],
    ['alias_empty', 'present empty-string sessionId'],
    ['alias_list', 'present list sessionId'],
    ['alias_object', 'present object sessionId']
  ];
  for (const [scenario, label] of invalidAliases) {
    const result = runScenario(scenario);
    assertRefused(result, label);
    assert.match(result.stderr, /matching predecessor manifest has no exact native identity/);
  }
  const conflicting = runScenario('alias_conflict');
  assertRefused(conflicting, 'conflicting sessionId/fullUUID pair');
  assert.match(conflicting.stderr, /matching predecessor manifest has no exact native identity/);
  // Null is present on any alias key, not only sessionId, even when the other
  // aliases would otherwise resolve an exact match.
  for (const [scenario, label] of [['alias_null_fulluuid', 'present null fullUUID'],
    ['alias_null_fulluuid_lower', 'present null fullUuid']]) {
    const result = runScenario(scenario);
    assertRefused(result, label);
    assert.match(result.stderr, /matching predecessor manifest has no exact native identity/);
  }
  // F-023 regression guard (not a baseline-red F1 case; baseline also commits):
  // an OMITTED optional alias is allowed. Dropping sessionId and keeping a valid
  // fullUUID is still an exact dead match, so the normal commit path must run.
  const absentAlias = runScenario('alias_absent_session');
  assertCommitted(absentAlias, '1', 'absent optional sessionId alias stays allowed');
  // F-024 regression guard (not a baseline-red F1 case; baseline also refuses):
  // a single PRESENT non-string alias with no other alias keys can only be
  // refused by the nonempty-string type guard, so the exact reason must appear.
  const nonStringAlone = runScenario('alias_nonstring_alone');
  assertRefused(nonStringAlone, 'present non-string sessionId with no other alias');
  assert.match(nonStringAlone.stderr, /matching predecessor manifest has no exact native identity/);
  // Two readable records disagreeing about the expected identity: the canonical
  // dead exact match named after oldOwner must not win while a differently named
  // live record claims the same fullUUID. Refuse as unknown with no commit child.
  const twoRecord = runScenario('canonical_plus_contradictory_live');
  assertRefused(twoRecord, 'canonical gone plus contradictory live record');
  assert.match(twoRecord.stderr, /matching predecessor manifest has no exact native identity/);
  const noise = runScenario('extra_invalid_identity');
  assertCommitted(noise, '1', 'unrelated malformed manifest is skipped');
});
test('21: replacing the predecessor manifest inode refuses while a same-content in-place rewrite commits', () => {
  const replaced = runScenario('predecessor_inode_replace');
  assertRefused(replaced, 'predecessor inode replacement');
  assert.match(replaced.stderr, /conductor worker identity changed while acquiring the writer gate/);
  const rewritten = runScenario('predecessor_rewrite_in_place');
  assertCommitted(rewritten, '1', 'in-place same-content predecessor rewrite');
  // A byte-length-changing in-place rewrite (same inode, untracked field) must
  // not read as an identity change: only the predecessor file's device and
  // inode are stable identity, so an ordinary heartbeat rewrite still commits.
  const heartbeat = runScenario('predecessor_rewrite_in_place',
    { mutationPredecessor: { after: 2, set: { note: 'heartbeat' } } });
  assertCommitted(heartbeat, '1', 'byte-length in-place heartbeat rewrite');
  // Replacing the pathname with identical bytes immediately AFTER the manifest
  // read returns (inside the first snapshot capture, before discover_predecessor
  // returns) must still be caught: the snapshot identity comes from the read
  // descriptor, so the unlocked snapshot binds the old inode while the locked
  // recheck binds the replacement inode.
  const afterRead = runScenario('predecessor_replace_after_read');
  assertRefused(afterRead, 'predecessor replacement after the read returns');
  assert.match(afterRead.stderr, /conductor worker identity changed while acquiring the writer gate/);
});
