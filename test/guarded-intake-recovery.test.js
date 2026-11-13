'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main, openState, parseArgs } = require('../src/cli');
const { createRecoveryCommands } = require('../src/cli/recovery-commands');
const { SurfaceState } = require('../src/state');

const channel = '1000';
const dns = 'getaddrinfo ENOTFOUND discord.com';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guarded-intake-'));
  const file = path.join(dir, 'expectation.json');
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  state.setConfig({ operatorId: 'operator', guildId: '100', secretFile: path.join(dir, 'unused') });
  state.bind({ channelId: channel, guildId: '100', provider: 'codex',
    nativeId: '11111111-1111-1111-1111-111111111111', workspace: dir }, { intakeCutoff: '100' });
  state.markIntakeBoundary(channel, 'unavailable', dns, '100', '120');
  state.db.prepare("UPDATE intake_watermarks SET last_seen_id='120', last_accepted_id='119' WHERE channel_id=?").run(channel);
  const snapshot = () => ({
    binding: { ...state.db.prepare('SELECT * FROM bindings WHERE channel_id=?').get(channel) },
    watermark: { ...state.getIntakeWatermark(channel) }
  });
  const write = proof => fs.writeFileSync(file, JSON.stringify(proof), { mode: 0o600 });
  const proof = { requestId: 'incident-1', deadlineMs: Date.now() + 300000, ...snapshot() };
  write(proof);
  const args = ['recover', '--state-dir', dir, '--intake-channel-id', channel, '--intake-expectation-file', file];
  const receipts = () => state.db.prepare('SELECT kind,detail FROM receipts ORDER BY id').all();
  return { state, dir, file, args, proof, write, snapshot, receipts };
}

function required(args, key) {
  if (typeof args[key] !== 'string' || !args[key]) throw new Error('missing ' + key);
  return args[key];
}

function run(args, hooks = {}) {
  const parsed = parseArgs(args);
  assert.equal(parsed.command, 'recover');
  let output;
  const { recover } = createRecoveryCommands({
    required, openState: hooks.openState || openState, print: value => { output = value; },
    gatewayProcessStatus: () => assert.fail('parent recovery inspected the Gateway'),
    requestGatewayRecovery: () => assert.fail('parent recovery woke the Gateway'),
    GATEWAY_CAPABILITIES: { threadEnrollmentRecoveryWake: 'fixture' }
  });
  const oldCode = process.exitCode;
  try {
    process.exitCode = undefined;
    recover(parsed.args);
    return { output, exitCode: process.exitCode || 0 };
  } finally {
    process.exitCode = oldCode;
  }
}

test('public guarded recovery commits pending, preserves the exact route and skips the old-message backfill', async t => {
  const f = setup(t);
  f.state.db.prepare("INSERT INTO messages(discord_id,guild_id,channel_id,author_id,content,provider,native_id,workspace,generation,state,created_at,updated_at) VALUES('119','100',?,'fixture','old fixture message','codex',?,?,1,'accepted','before','before')")
    .run(channel, f.proof.binding.native_id, f.dir);
  const message = () => ({ ...f.state.db.prepare("SELECT * FROM messages WHERE discord_id='119'").get() });
  const oldMessage = message();
  assert.equal(oldMessage.delivery_channel_id, null);
  const oldReceipts = f.receipts();
  const argv = process.argv;
  let stdout = '';
  const write = t.mock.method(process.stdout, 'write', chunk => { stdout += String(chunk); return true; });
  try {
    process.argv = [process.execPath, 'src/cli.js', ...f.args];
    await main();
  } finally {
    process.argv = argv;
    write.mock.restore();
  }
  assert.deepEqual(JSON.parse(stdout), { status: 'pending', channelId: channel, requestId: f.proof.requestId });
  const { binding, watermark } = f.snapshot();
  assert.deepEqual(binding, { ...f.proof.binding, readiness: 'pending', updated_at: binding.updated_at });
  assert.deepEqual(watermark, { ...f.proof.watermark, state: 'pending', detail: 'explicit intake reconciliation requested', updated_at: watermark.updated_at });
  assert.deepEqual(message(), oldMessage);
  const added = f.receipts().slice(oldReceipts.length);
  assert.deepEqual(added.map(row => row.kind), ['intake-boundary']);
  assert.equal(JSON.parse(added[0].detail).requestId, f.proof.requestId);
  assert.equal(run(f.args).output.status, 'refused');
  assert.deepEqual(f.receipts().slice(oldReceipts.length), added);
});

test('a matching guarded parent records pending without consulting or waking any Gateway', t => {
  const f = setup(t);
  const result = run(f.args);
  assert.deepEqual(result, { exitCode: 0, output: { status: 'pending', channelId: channel, requestId: f.proof.requestId } });
  assert.equal(f.snapshot().watermark.state, 'pending');
});

test('all raw tuple fields, including nullable fields, are mandatory before opening state', t => {
  const f = setup(t);
  let opens = 0;
  const hooks = { openState() { opens++; throw new Error('unexpected database open'); } };
  for (const tuple of ['binding', 'watermark']) {
    for (const field of Object.keys(f.proof[tuple])) {
      const proof = structuredClone(f.proof);
      delete proof[tuple][field];
      f.write(proof);
      assert.throws(() => run(f.args, hooks), /expectation/, tuple + '.' + field);
    }
  }
  for (const mutate of [
    p => { p.deadlineMs = 0; }, p => { delete p.deadlineMs; }, p => { p.requestId = ''; },
    p => { p.binding.active = true; }, p => { p.watermark.state = 'ready'; },
    p => { p.watermark.detail = dns + ' extra'; }, p => { p.watermark.channel_id = '2000'; },
    p => { p.binding.extra = 'unsafe'; }, p => { p.watermark.last_accepted_id = 119; }
  ]) {
    const proof = structuredClone(f.proof);
    mutate(proof);
    f.write(proof);
    assert.throws(() => run(f.args, hooks), /intake|parent|expired/);
  }
  f.write(f.proof);
  for (const selector of [['--topic-channel-id', channel], ['--message-id', '119'],
    ['--board-attempt-id', 'a'], ['--courier-attempt-id', 'a', '--courier-message-id', '119']]) {
    assert.throws(() => run([...f.args, ...selector], hooks), /unknown|cannot be combined/);
  }
  assert.throws(() => run(['recover', '--intake-expectation-file', f.file], hooks), /unknown/);
  fs.chmodSync(f.file, 0o644);
  assert.throws(() => run(f.args, hooks), /private/);
  fs.chmodSync(f.file, 0o600);
  const link = path.join(f.dir, 'link');
  fs.symlinkSync(f.file, link);
  assert.throws(() => run([...f.args.slice(0, -1), link], hooks));
  assert.equal(opens, 0);
});

test('stale raw binding, watermark, and an active child with the requested key refuse without a write or wake', t => {
  const f = setup(t);
  f.state.db.prepare('UPDATE bindings SET conductor_id=?, repo_key=? WHERE channel_id=?')
    .run('original-conductor', 'example/original', channel);
  f.proof.binding = f.snapshot().binding;
  const baseline = f.snapshot(), receipts = f.receipts();
  for (const [tuple, changes] of [
    ['binding', { guild_id: 'other', native_id: '22222222-2222-2222-2222-222222222222',
      generation: 2, workspace: f.dir + '-other', session_root: f.dir, endpoint: '/tmp/other.sock',
      category_id: '155', conductor_id: 'other', repo_key: 'other', updated_at: 'other' }],
    ['watermark', { last_seen_id: '121', last_accepted_id: '118', recovered_through_id: '99',
      gap_from: '99', gap_to: '121', updated_at: 'other' }]
  ]) {
    for (const [field, value] of Object.entries(changes)) {
      const proof = structuredClone(f.proof);
      proof[tuple][field] = value;
      if (field === 'guild_id') proof.watermark.guild_id = value;
      f.write(proof);
      const result = run(f.args);
      assert.equal(result.exitCode, 1, field);
      assert.equal(result.output.status, 'refused', field);
      assert.deepEqual(f.snapshot(), baseline, field);
    }
  }
  f.write(f.proof);
  f.state.db.prepare("UPDATE intake_watermarks SET detail='new failure' WHERE channel_id=?").run(channel);
  assert.equal(run(f.args).output.status, 'refused');
  assert.equal(f.snapshot().watermark.detail, 'new failure');
  f.state.db.prepare("UPDATE intake_watermarks SET state='ready', detail=? WHERE channel_id=?").run(dns, channel);
  assert.equal(run(f.args).output.status, 'refused');
  assert.equal(f.snapshot().watermark.state, 'ready');
  f.state.db.prepare("UPDATE intake_watermarks SET state='unavailable' WHERE channel_id=?").run(channel);
  // Both rows exist in this synthetic collision. Parent-only recovery must never dispatch to the child.
  f.state.db.prepare("INSERT INTO thread_enrollments(thread_id,parent_channel_id,guild_id,state,active,created_at,updated_at) VALUES(?,?,'100','gap',1,'before','before')").run(channel, channel);
  assert.equal(run(f.args).output.status, 'refused');
  assert.equal(f.state.getThreadEnrollment(channel).state, 'gap');
  assert.deepEqual(f.snapshot(), baseline);
  assert.deepEqual(f.receipts(), receipts);
});

test('deadline after acquisition and after actual writes refuses, with atomic rollback before commit', t => {
  const f = setup(t), before = f.snapshot(), receipts = f.receipts();
  const clock = f.proof.deadlineMs;
  let wall = clock - 10000;
  t.mock.method(Date, 'now', () => wall);
  const afterOpen = (args, options) => {
    assert.deepEqual(options, { requireCurrentSchema: true });
    const result = openState(args, options);
    wall = clock;
    return result;
  };
  const earlyReceipt = t.mock.method(SurfaceState.prototype, 'receipt');
  try {
    assert.equal(run(f.args, { openState: afterOpen }).output.status, 'refused');
    assert.equal(earlyReceipt.mock.callCount(), 0, 'expired parent recovery reached receipt insertion');
  } finally {
    earlyReceipt.mock.restore();
  }
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.receipts(), receipts);
  wall = clock - 10000;
  let wrote = 0;
  const actual = SurfaceState.prototype.receipt;
  t.mock.method(SurfaceState.prototype, 'receipt', function(id, kind, detail) {
    const result = actual.call(this, id, kind, detail);
    if (detail?.requestId === f.proof.requestId) {
      assert.equal(this.getIntakeWatermark(channel).state, 'pending');
      assert.equal(this.getBinding(channel).readiness, 'pending');
      wrote++;
      wall = clock;
    }
    return result;
  });
  assert.equal(run(f.args).output.status, 'refused');
  assert.equal(wrote, 1);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.receipts(), receipts);
});


test('impossible binding identities refuse before database opening; valid raw limits reach the stale check unchanged', t => {
  const f = setup(t);
  let opens = 0;
  const unavailable = new Error('unexpected database open');
  const hooks = { openState() { opens++; throw unavailable; } };
  const overChannel = 'x'.repeat(129);
  const overGuild = 'g'.repeat(129);
  const invalid = [
    ['channel', { channel_id: overChannel }],
    ['guild', { guild_id: overGuild }],
    ['provider', { provider: 'unsupported' }],
    ['native UUID', { native_id: 'not-a-uuid' }],
    ['relative workspace', { workspace: 'relative/workspace' }],
    ['long workspace', { workspace: '/' + 'w'.repeat(4096) }],
    ['relative session root', { session_root: 'sessions' }],
    ['long session root', { session_root: '/' + 's'.repeat(4096) }],
    ['relative endpoint', { endpoint: 'channel.sock' }],
    ['long endpoint', { endpoint: '/' + 'e'.repeat(90) }],
    ['missing Claude endpoint', { provider: 'claude', endpoint: null }],
    ['category', { category_id: 'c'.repeat(129) }],
    ['unpaired conductor', { conductor_id: 'only-conductor' }],
    ['unpaired repo', { repo_key: 'only-repo' }],
    ['long conductor', { conductor_id: 'c'.repeat(257), repo_key: 'example/repo' }],
    ['long repo', { conductor_id: 'conductor', repo_key: 'r'.repeat(1025) }],
    ['absolute repo', { conductor_id: 'conductor', repo_key: '/local' }],
    ['repo control', { conductor_id: 'conductor', repo_key: 'repo\u001fkey' }],
    ['repo DEL', { conductor_id: 'conductor', repo_key: 'repo\u007fkey' }]
  ];
  for (const [label, changes] of invalid) {
    const proof = structuredClone(f.proof);
    Object.assign(proof.binding, changes);
    proof.watermark.channel_id = proof.binding.channel_id;
    proof.watermark.guild_id = proof.binding.guild_id;
    f.write(proof);
    const args = [...f.args];
    args[args.indexOf('--intake-channel-id') + 1] = proof.binding.channel_id;
    let caughtError;
    try {
      run(args, hooks);
    } catch (error) {
      caughtError = error;
    }
    assert.equal(opens, 0, label + ' opened state');
    assert.ok(caughtError instanceof Error && caughtError !== unavailable, label);
    assert.match(caughtError.message, /binding identity|UUID/, label);
  }

  const valid = structuredClone(f.proof);
  Object.assign(valid.binding, {
    channel_id: 'x'.repeat(128), guild_id: 'g'.repeat(128), provider: 'claude',
    native_id: 'ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB', workspace: '/' + 'w'.repeat(4095),
    session_root: '/' + 's'.repeat(4095), endpoint: '/' + 'e'.repeat(89), category_id: 'c'.repeat(128),
    conductor_id: 'c'.repeat(256), repo_key: 'r'.repeat(1024)
  });
  valid.watermark.channel_id = valid.binding.channel_id;
  valid.watermark.guild_id = valid.binding.guild_id;
  f.write(valid);
  const args = [...f.args];
  args[args.indexOf('--intake-channel-id') + 1] = valid.binding.channel_id;
  let received;
  const actualMark = SurfaceState.prototype.markIntakeBoundary;
  t.mock.method(SurfaceState.prototype, 'markIntakeBoundary', function(...params) {
    received = params.at(-1);
    return actualMark.apply(this, params);
  });
  const observed = run(args, { openState(...openArgs) { opens++; return openState(...openArgs); } });
  assert.equal(opens, 1);
  assert.deepEqual(received.binding, valid.binding);
  assert.deepEqual(received.watermark, valid.watermark);
  assert.deepEqual(observed, { exitCode: 1, output: { status: 'refused', channelId: valid.binding.channel_id, requestId: valid.requestId } });
});
