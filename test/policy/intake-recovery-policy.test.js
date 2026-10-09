'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { findDeadlineGapOffenders, readSourceInventory } = require('./intake-recovery-analysis.cjs');

test('deadline policy inventory has no direct deadline-to-gap decision', () => {
  const sourceRoot = path.join(__dirname, '../../src');
  const offenders = findDeadlineGapOffenders(readSourceInventory(sourceRoot));
  assert.deepEqual(offenders, [], 'new deadline decisions must not map expiry directly to a history gap');
});

test('pre-adoption retry classifier sites stay in the audited owners', () => {
  const registered = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).scripts.test.split(/\s+/);
  assert.equal(registered.filter(value => value === 'test/policy/intake-recovery-policy.test.js').length, 1,
    'the focused recovery policy inventory must execute exactly once in npm test');
  const sourceRoot = path.join(__dirname, '../../src');
  const sites = new Map();
  for (const { relative, source } of readSourceInventory(sourceRoot)) {
    const count = source.match(/\bisPreAdoptionRetryableThread\b/g)?.length || 0;
    if (count) sites.set(relative, count);
  }
  assert.deepEqual(Object.fromEntries([...sites].sort(([left], [right]) => left.localeCompare(right))), {
    'discord.js': 5,
    'discord/inbound-recovery.js': 1,
    'discord/lifecycle.js': 1,
    'discord/live-checkpoint.js': 4,
    'discord/recovery-fetch.ts': 1,
    'discord/thread-enrollment.ts': 3
  }, 'new retryability consumers must join the class inventory before using this policy');
});
