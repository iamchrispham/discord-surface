const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const facade = require('../src/topic');
const emitted = require('../dist/topic');

test('CommonJS facade exposes the emitted topic module', () => {
  assert.equal(facade.staticConductorMarker, emitted.staticConductorMarker);
  const marker = emitted.staticConductorMarker({ provider: 'codex', conductorId: 'typed-conductor', repoKey: 'repo:typed' });
  assert.equal(marker, 'discord-surface:v3 conductor=typed-conductor provider=codex repo=repo%3Atyped [address only, not live status]');
});

test('CLI and Gateway imports remain side-effect free', () => {
  assert.doesNotThrow(() => require('../src/cli'));
  assert.doesNotThrow(() => require('../src/discord'));
});

test('emitted topic module preserves malformed-input behavior', () => {
  assert.deepEqual(emitted.topicPresentation(null), {
    base: '',
    readiness: null,
    publishedReadiness: null,
    publishedAt: null,
    hasValidSuffix: false
  });
  assert.equal(emitted.conductorMarkerMatches(null, {
    provider: 'codex',
    conductorId: 'typed-conductor',
    repoKey: 'repo:typed'
  }), false);
  assert.throws(() => emitted.staticConductorMarker({ provider: 'github', conductorId: 'typed-conductor', repoKey: 'repo:typed' }), /unsupported provider/);
  assert.throws(() => emitted.topicWithReadiness('legacy topic', 'online'), /invalid Discord topic readiness/);
});

test('missing emitted output fails clearly without a JavaScript fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-topic-missing-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.copyFileSync(path.resolve(__dirname, '../src/topic.js'), path.join(root, 'src/topic.js'));
    const result = spawnSync(process.execPath, ['-e', "require('./src/topic')"], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /run npm run build before starting/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
