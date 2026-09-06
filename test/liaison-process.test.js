const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSparkCommand, runBoundedSpark } = require('../src/liaison-process');

test('sidecar disables metadata names, including symlinked skills, without changing source files', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-skills-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => home);
  const root = path.join(home, '.codex/skills');
  const normal = path.join(root, 'directory-name');
  const target = path.join(home, 'canonical');
  fs.mkdirSync(normal, { recursive: true });
  fs.mkdirSync(target);
  const metadata = '---\nname: actual-name\ndescription: test\n---\nname: body-is-not-metadata\n';
  fs.writeFileSync(path.join(normal, 'SKILL.md'), metadata);
  fs.writeFileSync(path.join(target, 'SKILL.md'), '---\nname: "linked-name"\n---\n');
  fs.symlinkSync(target, path.join(root, 'linked-directory'));
  fs.symlinkSync(normal, path.join(root, 'duplicate'));
  fs.symlinkSync(path.join(home, 'missing'), path.join(root, 'broken'));
  const { args } = buildSparkCommand({ cwd: home, schemaPath: 'schema.json', answerPath: 'answer.json' });
  assert.equal(args.find(value => value.startsWith('skills.config=')),
    'skills.config=[{name="actual-name",enabled=false},{name="linked-name",enabled=false}]');
  assert.equal(fs.readFileSync(path.join(normal, 'SKILL.md'), 'utf8'), metadata);
});

test('bounded spark contains an early child exit while writing a large prompt', async () => {
  const result = await runBoundedSpark({ command: process.execPath,
    args: ['-e', 'require("node:fs").closeSync(0); setTimeout(() => process.exit(0), 100)'], cwd: os.tmpdir(),
    prompt: 'x'.repeat(1048576), timeoutMs: 1000, terminationGraceMs: 100 });
  assert.equal(result.ok, false);
  assert.ok(['stdin-failed', 'provider-failed'].includes(result.reason));
});
