const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readSnapshot } = require('../src/snapshot');
const { buildContextCommand, buildSparkCommand } = require('../src/liaison-process');
const { contextPacket, interpretSnapshot, validateAnswer } = require('../src/context-interpretation');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'context-check-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ladderDir = path.join(directory, 'ladder');
  fs.mkdirSync(ladderDir);
  fs.writeFileSync(path.join(ladderDir, 'lane_progress_ladder.py'), [
    'PCT = {"building": 50, "held": 50, "parked": 50, "frozen": 50}',
    'def canonical(value):',
    '    return value if isinstance(value, str) else ""',
    ''
  ].join('\n'));
  const binding = { conductorId: 'owner.md', repoKey: 'repo:ours', provider: 'codex',
    nativeId: '9caa5d21-2169-429d-918b-5f08651b5dbd', generation: 1, channelId: 'ours' };
  const registry = path.join(directory, 'registry.json');
  const original = JSON.stringify({ _conductors: { 'owner.md': {
    repository: binding.repoKey, vendor: binding.provider, nativeId: binding.nativeId, generation: 1,
    updated: '2026-09-06T06:00:00Z', intent: 'Prove cold start', next: ['Run the device check'],
    owed_by_operator: [{ id: 'device', text: 'Provide test device', since: '2026-09-06T05:00:00Z' }],
    owed_to_operator: [{ id: 'proof', text: 'Return device evidence', since: '2026-09-06T05:00:00Z' }]
  } }, mine: { conductor: 'owner.md', vendor: 'codex', repository: 'repo:ours', phase: 'building',
    state_note: 'Waiting for test device', next: 'Run the device check', pr: 1 },
  foreign: { conductor: 'elsewhere', vendor: 'codex', phase: 'building', state_note: 'FOREIGN PRIVATE CONTEXT', pr: 2 } });
  fs.writeFileSync(registry, original);
  const snapshot = await readSnapshot(binding, { registry, ladderDir, now: Date.parse('2026-09-06T06:05:00Z') / 1000 });
  assert.equal(snapshot.unavailable, undefined);
  return { directory, ladderDir, registry, original, snapshot, binding };
}

test('snapshot does not share an abbreviated Claude owner across full native identities', async t => {
  const { ladderDir, registry } = await fixture(t);
  const ids = ['12345678-1111-4111-8111-111111111111', '12345678-2222-4222-8222-222222222222'];
  const bindings = ids.map((nativeId, index) => ({ conductorId: `owner-${index}.md`, repoKey: 'repo:ours',
    provider: 'claude', nativeId, generation: 1, channelId: `channel-${index}` }));
  const data = { _conductors: Object.fromEntries(bindings.map(binding => [binding.conductorId,
    { repository: binding.repoKey, vendor: binding.provider, nativeId: binding.nativeId, generation: 1 }])),
    ambiguous: { conductor: 'session-claude-12345678', repository: 'repo:ours', vendor: 'claude', phase: 'building' } };
  data.exact = { ...data.ambiguous, nativeId: ids[0], generation: 1 };
  fs.writeFileSync(registry, JSON.stringify(data));
  for (const [index, binding] of bindings.entries()) {
    const result = await readSnapshot(binding, { registry, ladderDir });
    assert.equal(result.unavailable, undefined);
    assert.deepEqual(result.lanes.map(lane => lane.id), index === 0 ? ['exact'] : []);
  }
});

test('snapshot rejects stale lane identity when its conductor record matches', async t => {
  const { directory, ladderDir, registry, original, binding } = await fixture(t);
  const data = JSON.parse(original);
  data.stale = { conductor: binding.conductorId, vendor: binding.provider, repository: binding.repoKey,
    nativeId: binding.nativeId, generation: binding.generation - 1, phase: 'building' };
  data.current = { conductor: binding.conductorId, vendor: binding.provider, repository: binding.repoKey,
    nativeId: binding.nativeId, generation: binding.generation, phase: 'building' };
  fs.writeFileSync(registry, JSON.stringify(data));
  const snapshot = await readSnapshot(binding, { registry, ladderDir, now: Date.parse('2026-09-06T06:05:00Z') / 1000 });
  assert.equal(snapshot.lanes.some(lane => lane.id === 'stale'), false);
  assert.equal(snapshot.lanes.some(lane => lane.id === 'current'), true);
});

function childCommand(directory, mode = 'valid') {
  return ({ cwd, answerPath }) => {
    fs.writeFileSync(path.join(directory, 'child-directory'), cwd);
    return { command: process.execPath, args: ['-e', `
      const fs = require('node:fs');
      let text = '';
      process.stdin.on('data', chunk => text += chunk);
      process.stdin.on('end', () => {
        fs.writeFileSync(${JSON.stringify(path.join(directory, 'prompt'))}, text);
        const packet = JSON.parse(text.trim().split('\\n').at(-1));
        const answer = { snapshotId: packet.snapshotId, decision: 'context',
          summary: 'The recorded device dependency connects the pending check to the evidence owed by the conductor.',
          evidenceIds: ['context.owedByOperator', 'context.owedToOperator', 'lane.0'], uncertainties: [] };
        const mode = ${JSON.stringify(mode)};
        if (mode === 'hold') { setInterval(() => {}, 1000); return; }
        if (mode === 'foreign') answer.evidenceIds = ['foreign'];
        if (mode === 'old') answer.snapshotId = 'previous-snapshot';
        if (mode === 'quiet') Object.assign(answer, { decision: 'quiet', summary: '', evidenceIds: [], uncertainties: [] });
        fs.writeFileSync(${JSON.stringify(answerPath)}, mode === 'huge' ? 'x'.repeat(9000) : JSON.stringify(answer));
      });`] };
  };
}

test('actual snapshot feeds bounded Luna command and retains direction without touching source', async t => {
  const { directory, registry, original, snapshot } = await fixture(t);
  const options = { cwd: directory, answerPath: 'answer', schemaPath: 'schema' };
  const luna = buildContextCommand(options);
  const spark = buildSparkCommand(options);
  assert.equal(luna.args[luna.args.indexOf('--model') + 1], 'gpt-5.6-luna');
  assert.equal(spark.args[spark.args.indexOf('--model') + 1], 'gpt-5.3-codex-spark');
  assert.ok(luna.args.includes('model_reasoning_effort="low"'));
  const result = await interpretSnapshot(snapshot, { buildCommand: childCommand(directory) });
  assert.equal(result.status, 'ready');
  assert.match(result.preview, /recorded device dependency/);
  const prompt = fs.readFileSync(path.join(directory, 'prompt'), 'utf8');
  const packet = JSON.parse(prompt.trim().split('\n').at(-1));
  assert.equal(packet.identity.nativeId, snapshot.identity.nativeId);
  assert.equal(packet.sources.find(row => row.id === 'context.owedToOperator').value[0].id, 'proof');
  assert.equal(packet.sources.find(row => row.id === 'context.owedByOperator').value[0].id, 'device');
  assert.equal(prompt.includes('FOREIGN PRIVATE CONTEXT'), false);
  assert.equal(fs.readFileSync(registry, 'utf8'), original);
  assert.equal(fs.existsSync(fs.readFileSync(path.join(directory, 'child-directory'), 'utf8')), false);
});

test('actual process outputs with foreign evidence, stale snapshot and oversized bytes are rejected', async t => {
  const { directory, snapshot } = await fixture(t);
  for (const [mode, reason] of [['foreign', 'invalid-output'], ['old', 'invalid-output'], ['huge', 'output-too-large']]) {
    const result = await interpretSnapshot(snapshot, { buildCommand: childCommand(directory, mode) });
    assert.equal(result.reason, reason, mode);
    assert.equal(result.interpretation, null, mode);
  }
  const quiet = await interpretSnapshot(snapshot, { buildCommand: childCommand(directory, 'quiet') });
  assert.equal(quiet.status, 'ready');
  assert.equal(quiet.interpretation.decision, 'quiet');
  assert.equal(quiet.preview, null);
});

test('unavailable sources and packet overflow do not start inference', async t => {
  const { snapshot } = await fixture(t);
  let spawned = false;
  const options = { buildCommand: () => { spawned = true; throw new Error('must not spawn'); } };
  const wrong = structuredClone(snapshot);
  wrong.context.state = 'wrong-owner';
  const huge = structuredClone(snapshot);
  huge.context.intent.value = 'x'.repeat(33000);
  assert.equal((await interpretSnapshot(wrong, options)).reason, 'source-unavailable-or-too-large');
  assert.equal((await interpretSnapshot(huge, options)).reason, 'source-unavailable-or-too-large');
  assert.equal(spawned, false);
  assert.equal(contextPacket(snapshot).snapshotId, snapshot.id);
});

test('one interpreter per process, cancellation reaps child, next job remains usable', async t => {
  const { directory, snapshot } = await fixture(t);
  const controller = new AbortController();
  let pid;
  const pending = interpretSnapshot(snapshot, { signal: controller.signal,
    buildCommand: childCommand(directory, 'hold'), onSpawn: child => { pid = child.pid; } });
  assert.ok(Number.isInteger(pid));
  try {
    const second = await interpretSnapshot(snapshot, { buildCommand: () => { throw new Error('second child forbidden'); } });
    assert.equal(second.reason, 'busy');
  } finally { controller.abort(); }
  assert.equal((await pending).reason, 'cancelled');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const next = await interpretSnapshot(snapshot, { buildCommand: childCommand(directory) });
  assert.equal(next.status, 'ready');
});

test('deadline terminates actual child and removes the packet directory', async t => {
  const { directory, snapshot } = await fixture(t);
  let pid;
  const result = await interpretSnapshot(snapshot, { timeoutMs: 60, terminationGraceMs: 20,
    buildCommand: childCommand(directory, 'hold'), onSpawn: child => { pid = child.pid; } });
  assert.equal(result.reason, 'timeout');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(fs.existsSync(fs.readFileSync(path.join(directory, 'child-directory'), 'utf8')), false);
});

test('public snapshot command consumes interpreter while preserving deterministic preview', async t => {
  const { directory, ladderDir, snapshot, registry, binding } = await fixture(t);
  const { SurfaceState } = require('../src/state');
  const state = new SurfaceState(path.join(directory, 'surface.sqlite'));
  state.setConfig({ guildId: 'guild', operatorId: 'operator', secretFile: path.join(directory, 'unused') });
  state.bind({ ...binding, guildId: 'guild', workspace: directory });
  state.close();
  const preload = path.join(directory, 'preload.cjs');
  const processModule = require.resolve('../src/liaison-process');
  fs.writeFileSync(preload, `const fs = require('node:fs'); const path = require('node:path'); require(${JSON.stringify(processModule)}).buildContextCommand = ${childCommand.toString()}(${JSON.stringify(directory)});`);
  const result = spawnSync(process.execPath, ['--require', preload, require.resolve('../src/cli'),
    'snapshot', '--state-dir', directory, '--registry', registry, '--ladder-dir', ladderDir, '--channel-id', 'ours', '--interpret'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.preview, /Owed by you: Provide test device/);
  assert.match(output.preview, /Owed to you: Return device evidence/);
  assert.equal(output.context.status, 'ready');
  assert.equal(output.context.interpretation.snapshotId, output.snapshot.id);
  assert.match(output.context.preview, /recorded device dependency/);
  const packet = contextPacket(snapshot);
  assert.equal(validateAnswer({ ...output.context.interpretation, snapshotId: packet.snapshotId,
    decision: 'quiet', summary: 'still says something' }, packet), null);

  const originalBuild = fs.readFileSync(preload, 'utf8');
  fs.writeFileSync(preload, originalBuild + `
    const owner = require(${JSON.stringify(processModule)});
    const build = owner.buildContextCommand;
    owner.buildContextCommand = options => {
      const reg = JSON.parse(fs.readFileSync(${JSON.stringify(registry)}, 'utf8'));
      reg._conductors['owner.md'].intent = 'Newly recorded intent';
      fs.writeFileSync(${JSON.stringify(registry)}, JSON.stringify(reg));
      return build(options);
    };`);
  const changed = spawnSync(process.execPath, ['--require', preload, require.resolve('../src/cli'),
    'snapshot', '--state-dir', directory, '--registry', registry, '--ladder-dir', ladderDir, '--channel-id', 'ours', '--interpret'], { encoding: 'utf8' });
  assert.equal(changed.status, 0, changed.stderr);
  const newer = JSON.parse(changed.stdout);
  assert.equal(newer.context.reason, 'snapshot-changed');
  assert.equal(newer.context.interpretation, null);
  assert.match(newer.preview, /Newly recorded intent/);
  const failurePreload = fs.readFileSync(preload, 'utf8').replace('Newly recorded intent', 'Intent recorded during model failure')
    .replace('return build(options);', "return { command: process.execPath, args: ['-e', 'process.stdin.resume(); process.stdin.on(\"end\", () => process.exit(1));'] };");
  fs.writeFileSync(preload, failurePreload);
  const failed = spawnSync(process.execPath, ['--require', preload, require.resolve('../src/cli'),
    'snapshot', '--state-dir', directory, '--registry', registry, '--ladder-dir', ladderDir, '--channel-id', 'ours', '--interpret'], { encoding: 'utf8' });
  assert.equal(failed.status, 0, failed.stderr);
  const fallback = JSON.parse(failed.stdout);
  assert.equal(fallback.context.reason, 'provider-failed');
  assert.match(fallback.preview, /Intent recorded during model failure/);
});
