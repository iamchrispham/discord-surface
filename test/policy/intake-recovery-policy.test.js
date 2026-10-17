'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('deadline policy inventory has no direct deadline-to-gap decision outside its classifier', () => {
  const sourceRoot = path.join(__dirname, '../../src');
  const files = ['discord.js', 'discord/inbound-recovery.js', 'discord/thread-enrollment.ts'];
  const offenders = [];
  for (const relative of files) {
    const lines = fs.readFileSync(path.join(sourceRoot, relative), 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!/\b(?:DEADLINE|deadlineReached)\b/.test(lines[index])) continue;
      const window = lines.slice(index, index + 4).join('\n');
      if (/\b(?:READINESS\.GAP|THREAD_STATES\.GAP)\b|\?\s*['"]gap['"]/.test(window)) {
        offenders.push(`${relative}:${index + 1}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'new deadline decisions must use the shared recovery classifier');
});

test('pre-adoption retry classifier sites stay in the audited owners', () => {
  const registered = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).scripts.test.split(/\s+/);
  assert.equal(registered.filter(value => value === 'test/policy/intake-recovery-policy.test.js').length, 1,
    'the focused recovery policy inventory must execute exactly once in npm test');
  const sourceRoot = path.join(__dirname, '../../src');
  const collect = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return collect(absolute);
    return /\.(?:js|ts)$/.test(entry.name) ? [absolute] : [];
  });
  const sites = new Map();
  for (const file of collect(sourceRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    const count = source.match(/\bisPreAdoptionRetryableThread\b/g)?.length || 0;
    if (count) sites.set(path.relative(sourceRoot, file).split(path.sep).join('/'), count);
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
