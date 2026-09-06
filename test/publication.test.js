const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SurfaceState } = require('../src/state');
const { readSnapshot } = require('../src/snapshot');
const { watchPublications } = require('../src/publication/publisher');
const { STATUS } = require('../src/publication/store');
const { DiscordGateway, createSurfaceConsumer } = require('../src/discord');

const NATIVE = '9caa5d21-2169-429d-918b-5f08651b5dbd';
function fixture(t, provider = 'codex') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-'));
  const ladderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-ladder-'));
  fs.writeFileSync(path.join(ladderDir, 'lane_progress_ladder.py'), [
    'PCT = {"building": 50, "held": 50, "parked": 50, "frozen": 50}',
    'def canonical(value):',
    '    return value if isinstance(value, str) else ""',
    ''
  ].join('\n'));
  let state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'fixture.secret') });
  const binding = { channelId: 'channel', guildId: 'guild', provider, nativeId: NATIVE,
    conductorId: 'owner.md', repoKey: 'repo:ours', workspace: dir,
    ...(provider === 'claude' ? { endpoint: path.join(dir, 'c.sock') } : {}) };
  state.bind(binding);
  state.setBindingReadiness('channel', 'ready');
  state.publications.setEnabled(state.getBinding('channel'), true);
  const registry = path.join(dir, 'registry.json');
  const data = { _conductors: { 'owner.md': { repository: 'repo:ours', vendor: provider, nativeId: NATIVE,
    generation: 1, updated: new Date().toISOString(), intent: 'Return device evidence',
    next: ['Run the check'], owed_by_operator: [], owed_to_operator: [{ id: 'proof', text: 'Return proof', since: new Date().toISOString() }] } } };
  function write() {
    fs.writeFileSync(registry + '.next', JSON.stringify(data));
    fs.renameSync(registry + '.next', registry);
  }
  write();
  const publishers = [];
  t.after(async () => {
    for (const publisher of publishers) await publisher.stop();
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(ladderDir, { recursive: true, force: true });
  });
  const readFixture = (binding, options = {}) => readSnapshot(binding, { ...options, ladderDir });
  return { dir, ladderDir, registry, data, write, readSnapshot: readFixture, publishers, get state() { return state; },
    get binding() { return state.getBinding('channel'); },
    reopen() { const dbPath = state.dbPath; state.close(); state = new SurfaceState(dbPath); return state; } };
}
async function until(check, message = 'condition', timeout = 4000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) assert.fail('timed out: ' + message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function start(f, options = {}) {
  const requestedRead = options.read;
  const read = requestedRead
    ? (binding, readOptions) => requestedRead(binding, { ...readOptions, ladderDir: f.ladderDir })
    : (binding, readOptions) => f.readSnapshot(binding, readOptions);
  const p = watchPublications({ state: f.state, registry: f.registry, interpret: async () => ({ status: 'unavailable', reason: 'fixture' }),
    cadence: { burstMs: 15, publicationMs: 150, retryMs: 150 }, ...options, read });
  f.publishers.push(p);
  return p;
}

test('real file events coalesce, retain newest source during cooldown, and stay quiet after restart', async t => {
  const f = fixture(t);
  const sent = [];
  let reads = 0;
  const send = async (_binding, post) => { sent.push(post); return { id: String(100 + sent.length) }; };
  const p = start(f, { send, read: async (...args) => { reads++; return f.readSnapshot(...args); } });
  await until(() => sent.length === 1, 'startup publication');
  await new Promise(resolve => setTimeout(resolve, 80));
  const stableReads = reads;
  f.state.receipt(null, 'fixture-unrelated-write', {});
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(reads, stableReads, 'publication DB writes must not reread source');
  assert.match(sent[0].content, /Owed by you: none recorded/);
  assert.match(sent[0].content, /Owed to you: Return proof/);
  f.data._conductors['owner.md'].next = ['Superseded instruction']; f.write();
  f.data._conductors['owner.md'].next = ['Latest instruction']; f.write();
  await until(() => sent.length === 2, 'latest pending publication');
  assert.match(sent[1].content, /Latest instruction/);
  assert.doesNotMatch(sent[1].content, /Superseded instruction/);
  f.data.foreign = { vendor: 'claude', conductor: 'foreign', phase: 'building' }; f.write();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(sent.length, 2, 'foreign churn is silent');
  await p.stop(); f.reopen();
  const restarted = start(f, { send });
  await restarted.drain();
  assert.equal(sent.length, 2, 'restart does not duplicate delivered state');
  f.data._conductors['owner.md'].next = ['Run the check']; f.write();
  await until(() => sent.length === 3, 'return to previous state is a real change');
  assert.notEqual(sent[0].nonce, sent[2].nonce);
});

test('expiry and unreadable source replace freshness instead of flushing old drafts', async t => {
  const f = fixture(t);
  let clock = Date.now();
  const sent = [];
  f.data._conductors['owner.md'].updated = new Date(clock - 1799900).toISOString(); f.write();
  const p = start(f, { clock: () => clock, send: async (_binding, post) => { sent.push(post); return { id: String(200 + sent.length) }; } });
  await p.drain();
  assert.match(sent[0].content, /as of source/);
  clock += 1000;
  await until(() => sent.length === 2, 'one-shot expiry without source write');
  assert.match(sent[1].content, /stale/);
  clock += 1000;
  fs.writeFileSync(f.registry, '{');
  await until(() => sent.length === 3, 'source unavailable');
  assert.match(sent[2].content, /source unavailable/);
  f.data._conductors['owner.md'].updated = new Date(clock).toISOString(); f.write();
  clock += 1000;
  await until(() => sent.length === 4, 'valid source resumes');
});

test('failed send preserves successful cursor and newest pending snapshot across reopen', async t => {
  const f = fixture(t);
  let clock = Date.now();
  const p = start(f, { clock: () => clock, send: async () => { throw Object.assign(new Error('rate limited'), { outcome: 'not_sent' }); } });
  await p.drain();
  assert.equal(f.state.publications.head(f.binding).successful_at, null);
  assert.equal(f.state.publications.pending(f.binding).status, STATUS.PENDING);
  await p.stop(); f.reopen();
  let sends = 0;
  const retry = start(f, { clock: () => clock, send: async () => { sends++; return { id: '300' }; } });
  await retry.drain(); assert.equal(sends, 0, 'remaining retry delay survives');
  f.data._conductors['owner.md'].next = ['New plan']; f.write();
  clock += 1000;
  await retry.drain();
  assert.equal(sends, 1);
  assert.ok(f.state.publications.head(f.binding).successful_at);
  assert.match(f.state.db.prepare('SELECT content FROM publication_posts WHERE status=?').get(STATUS.SENT).content, /New plan/);
});

test('uncertain send stays held, bot echo settles it, replay never enters either native provider', async t => {
  for (const provider of ['codex', 'claude']) {
    const f = fixture(t, provider);
    const p = start(f, { send: async () => { throw new Error('socket closed after write'); } });
    await p.drain();
    const post = f.state.db.prepare('SELECT * FROM publication_posts').get();
    assert.equal(post.status, STATUS.UNKNOWN);
    await p.stop(); f.reopen();
    assert.equal(f.state.publications.pending(f.binding), null);
    let nativeCalls = 0;
    const consumer = createSurfaceConsumer({ state: f.state,
      providers: { [provider]: { submit: async () => { nativeCalls++; } } }, sendReply: async () => { throw new Error('no native reply expected'); } });
    const echo = { id: '400', guildId: 'guild', channelId: 'channel', content: post.content,
      nonce: post.nonce, author: { id: 'bot', bot: true } };
    assert.equal((await consumer.handleMessage(echo)).accepted, false);
    assert.equal(f.state.db.prepare('SELECT status FROM publication_posts WHERE id=?').get(post.id).status, STATUS.SENT);
    const replay = { ...echo, nonce: undefined, author: { id: 'operator', bot: false } };
    assert.equal((await consumer.intakeMessage(replay, false)).accepted, false);
    assert.equal(nativeCalls, 0);
    assert.equal(f.state.getMessage('400'), null);
    assert.equal((await consumer.intakeMessage({ ...replay, id: '401', content: 'Explain this update' }, false)).accepted, true);
  }
});

test('binding change during source read suppresses old owner and stop aborts outstanding send', async t => {
  const f = fixture(t);
  let calls = 0;
  const p = start(f, { read: async (...args) => {
    const result = await f.readSnapshot(...args);
    f.state.db.prepare('UPDATE bindings SET generation=generation+1 WHERE channel_id=?').run('channel');
    return result;
  }, send: async () => { calls++; return { id: '500' }; } });
  await p.drain(); assert.equal(calls, 0); await p.stop();
  f.data._conductors['owner.md'].generation = f.binding.generation; f.write();
  let started = false, aborted = false;
  const sending = start(f, { send: async (_binding, _post, signal) => {
    started = true;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }));
  } });
  await until(() => started);
  await sending.stop();
  assert.equal(aborted, true);
  assert.equal(f.state.db.prepare('SELECT status FROM publication_posts').get().status, STATUS.UNKNOWN);
});

test('Gateway sends bounded automatic content without a reply target and fences stale binding', async t => {
  const f = fixture(t);
  const requests = [];
  const client = { rest: {}, on() {}, off() {} };
  const gateway = new DiscordGateway({ state: f.state, client, providers: {} });
  gateway.discordToken = 'fixture-only'; gateway.ready = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ id: '600' }) }; };
  t.after(() => { globalThis.fetch = originalFetch; });
  const binding = f.binding;
  await gateway.sendPublication(binding, { content: 'Automatic snapshot', nonce: 'sp-fixture' }, new AbortController().signal);
  assert.equal(requests[0].message_reference, undefined);
  assert.deepEqual(requests[0].allowed_mentions.parse, []);
  f.state.db.prepare('UPDATE bindings SET generation=2').run();
  await assert.rejects(gateway.sendPublication(binding, { content: 'old', nonce: 'old' }, new AbortController().signal), /binding/);
  assert.equal(requests.length, 1);
  await gateway.stop();
});

test('published custody cannot silently disappear after table loss', async t => {
  const f = fixture(t);
  f.state.db.exec('DROP TABLE publication_posts');
  assert.throws(() => new SurfaceState(f.state.dbPath), /publication_posts/);
});

test('Gateway startup owns one publisher and stop leaves no file-triggered sends', async t => {
  const f = fixture(t);
  const secret = path.join(f.dir, 'fixture.secret');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fixture-only\n', { mode: 0o600 });
  let logins = 0, sends = 0;
  const client = { on() {}, off() {}, login: async () => { logins++; }, destroy: async () => {},
    channels: { fetch: async () => ({ send: async () => ({ id: String(700 + ++sends) }) }) } };
  const gateway = new DiscordGateway({ state: f.state, client, providers: {},
    publicationOptions: { registry: f.registry, interpret: async () => ({ status: 'unavailable', reason: 'fixture' }), cadence: { burstMs: 10, publicationMs: 50, retryMs: 50 } } });
  gateway.recoverInbound = async () => ({ ready: true, state: 'ready' });
  await gateway.start(secret);
  const publisher = gateway.publications;
  await gateway.start(secret);
  assert.equal(logins, 1);
  assert.equal(gateway.publications, publisher);
  await until(() => sends === 1);
  await gateway.stop();
  f.data._conductors['owner.md'].next = ['Should remain unsent']; f.write();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(sends, 1);
});

test('crash between claim and response holds custody after startup and exposes it in CLI status', async t => {
  const { spawnSync } = require('node:child_process');
  const f = fixture(t);
  const snapshot = await f.readSnapshot(f.binding, { registry: f.registry });
  f.state.publications.stage(f.binding, snapshot, 'Automatic fixture');
  const post = f.state.publications.pending(f.binding);
  assert.equal(f.state.publications.begin(f.binding, post.id, Date.now()), true);
  f.reopen();
  let sends = 0;
  const p = start(f, { send: async () => { sends++; return { id: '800' }; } });
  await p.drain();
  assert.equal(sends, 0);
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../src/cli.js'), 'status', '--state-dir', f.dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout).publications[0];
  assert.equal(status.successfulAt, null);
  assert.equal(status.counts.unknown, 1);
});

test('publication needs explicit role selection, survives same-role pickup, and disable fences pending sends', async t => {
  const { spawnSync } = require('node:child_process');
  const f = fixture(t);
  f.state.db.prepare("DELETE FROM config WHERE key LIKE 'publication:%'").run();
  const sent = [];
  const p = start(f, { send: async (_binding, post) => { sent.push(post); return { id: String(900 + sent.length) }; } });
  await p.drain(); assert.equal(sent.length, 0, 'an active binding is not publication authorization');
  const cli = (...args) => spawnSync(process.execPath, [path.resolve(__dirname, '../src/cli.js'), 'publication', ...args,
    '--state-dir', f.dir, '--channel-id', 'channel', '--native-id', NATIVE], { encoding: 'utf8' });
  assert.notEqual(cli('enable', '--generation', '9').status, 0, 'stale selection rejected');
  assert.equal(cli('enable', '--generation', '1').status, 0);
  await until(() => sent.length === 1, 'policy DB event activates selected role');
  f.data._conductors['owner.md'].next = ['Disable before this sends']; f.write();
  assert.equal(cli('disable', '--generation', '1').status, 0);
  await p.drain(); assert.equal(sent.length, 1);
  const post = { content: 'must not send', nonce: 'sp-policy' };
  const gateway = new DiscordGateway({ state: f.state, client: { on() {}, off() {} }, providers: {} });
  gateway.ready = true;
  await assert.rejects(gateway.sendPublication(f.binding, post, new AbortController().signal), /binding or connection/);
  await gateway.stop();
  f.state.publications.setEnabled(f.binding, true);
  const successor = f.state.rebind({ ...f.binding, nativeId: '7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b' });
  assert.equal(f.state.publications.enabled(successor), true, 'same durable role retains standing policy');
  assert.equal(f.state.publications.enabled({ ...successor, repoKey: 'repo:foreign' }), false);
  assert.equal(f.state.publications.enabled({ ...successor, provider: 'claude' }), false);
});

test('human nonce collision is accepted but known automatic message IDs remain excluded', async t => {
  const f = fixture(t);
  const snapshot = await f.readSnapshot(f.binding, { registry: f.registry });
  f.state.publications.stage(f.binding, snapshot, 'Automatic snapshot');
  const post = f.state.publications.pending(f.binding);
  f.state.publications.begin(f.binding, post.id, Date.now());
  const event = { id: '1001', guildId: 'guild', channelId: 'channel', authorId: 'operator',
    isBot: false, nonce: post.nonce, content: 'This is a real question' };
  assert.equal(f.state.acceptDiscordMessage(event).accepted, true);
  assert.equal(f.state.getMessage(event.id).content, event.content);
  assert.equal(f.state.publications.head(f.binding).successful_at, null);
  f.state.publications.sent(post.id, '1002', Date.now());
  assert.equal(f.state.acceptDiscordMessage({ ...event, id: '1002', nonce: null }).accepted, false);
});

test('schema constraints cannot be removed while retaining superficially matching columns', async t => {
  const f = fixture(t);
  const ddl = f.state.db.prepare("SELECT sql FROM sqlite_master WHERE name='publication_posts'").get().sql;
  f.state.db.exec('DROP TABLE publication_posts');
  f.state.db.exec(ddl.replaceAll(' UNIQUE', '').replace(" CHECK(status IN ('pending','sending','sent','unknown','superseded'))", ''));
  assert.throws(() => new SurfaceState(f.state.dbPath), /publication schema mismatch/);
});

test('old-generation unknown custody stays visible after a handoff', async t => {
  const f = fixture(t);
  const p = start(f, { send: async () => { throw new Error('unknown transport'); } });
  await p.drain(); await p.stop();
  f.state.rebind({ ...f.binding, nativeId: '7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b' });
  const rows = f.state.publications.status();
  assert.equal(rows.find(row => row.generation === 1).counts.unknown, 1);
  assert.equal(rows.find(row => row.generation === 1).current, false);
  assert.equal(rows.find(row => row.generation === 2).successfulAt, null);
});

test('watch failure rearms the subscription and reads missed changes without source polling', async t => {
  const f = fixture(t);
  const watchers = [];
  const sent = [];
  let reads = 0;
  const p = start(f, { rearmMs: 30, send: async (_binding, post) => { sent.push(post); return { id: String(1100 + sent.length) }; },
    read: async (...args) => { reads++; return f.readSnapshot(...args); },
    watchFactory: (...args) => { const watcher = fs.watch(...args); watchers.push(watcher); return watcher; } });
  await until(() => sent.length === 1);
  watchers[0].emit('error', new Error('fixture watcher failure'));
  f.data._conductors['owner.md'].next = ['Changed while subscription was down']; f.write();
  await until(() => sent.length === 2, 'rearm reads missed change');
  assert.match(sent[1].content, /Changed while subscription was down/);
  assert.equal(watchers.length, 3, 'one replacement subscription');
  const count = reads;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(reads, count, 'successful rearm has no repeating source read');
  watchers[2].emit('error', new Error('stop while rearm pending'));
  await p.stop();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(watchers.length, 3, 'stop cancels pending rearm');
});

test('shutdown aborts the real bounded Python reader while its source FIFO is blocked', async t => {
  const { spawnSync } = require('node:child_process');
  const f = fixture(t);
  const fifo = path.join(f.dir, 'blocked-registry');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  let reading = false, settled = false;
  const p = start(f, { registry: fifo, read: async (...args) => {
    reading = true;
    try { return await f.readSnapshot(...args); } finally { settled = true; }
  }, send: async () => { assert.fail('blocked source must not send'); } });
  await until(() => reading);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(settled, false, 'actual FIFO read is blocked');
  const before = Date.now();
  await p.stop();
  assert.equal(settled, true);
  assert.ok(Date.now() - before < 1500, 'abort completes before the three-second fallback timeout');
});

test('a request begun before handoff records its late success only against its original owner', async t => {
  const f = fixture(t);
  const requests = [];
  let finish;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ id: '1200' }) }); });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const gateway = new DiscordGateway({ state: f.state, client: { rest: {}, on() {}, off() {} }, providers: {} });
  gateway.discordToken = 'fixture-only'; gateway.ready = true;
  const old = f.binding;
  const p = start(f, { send: (...args) => gateway.sendPublication(...args) });
  await until(() => requests.length === 1, 'request actually initiated');
  const originalPost = f.state.db.prepare('SELECT * FROM publication_posts').get();
  assert.equal(originalPost.status, STATUS.SENDING);
  f.state.rebind({ ...old, nativeId: '7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b' });
  finish();
  await until(() => f.state.db.prepare('SELECT status FROM publication_posts WHERE id=?').get(originalPost.id).status === STATUS.SENT);
  assert.equal(f.state.publications.head(f.binding), undefined, 'late success did not advance successor cursor');
  assert.equal(requests.length, 1, 'no request initiated after handoff');
  assert.ok(f.state.publications.head(old).successful_at);
  await p.stop(); await gateway.stop();
});

test('publication authorization does not survive changing the Discord operator or guild', t => {
  const f = fixture(t);
  const binding = f.binding;
  assert.equal(f.state.publications.enabled(binding), true);
  f.state.setConfig({ operatorId: 'another-operator' });
  assert.equal(f.state.publications.enabled(binding), false);
  f.state.setConfig({ operatorId: 'operator', guildId: 'another-guild' });
  assert.equal(f.state.publications.enabled(binding), false);
  assert.throws(() => f.state.publications.setEnabled(binding, true), /stale/);
});


test('bot echo releases newer pending publication through events and preserves cooldown', async t => {
  const f = fixture(t);
  const sent = [];
  const cadence = { burstMs: 15, publicationMs: 150, retryMs: 150 };
  const p = start(f, { cadence, send: async (_binding, post) => {
    sent.push({ ...post, observedAt: Date.now() });
    if (sent.length === 1) throw new Error('uncertain write');
    return { id: 'after-echo' };
  } });
  await until(() => f.state.db.prepare('SELECT id FROM publication_posts WHERE status=?').get(STATUS.UNKNOWN));
  f.data._conductors['owner.md'].next = ['Deliver the newer plan']; f.write();
  await until(() => f.state.db.prepare('SELECT id FROM publication_posts WHERE status=?').get(STATUS.PENDING));
  const consumer = createSurfaceConsumer({ state: f.state, providers: {} });
  assert.equal((await consumer.handleMessage({ id: 'settled-echo', guildId: 'guild', channelId: 'channel',
    content: sent[0].content, nonce: sent[0].nonce, author: { id: 'bot', bot: true } })).accepted, false);
  const settledAt = f.state.publications.head(f.binding).successful_at;
  await until(() => sent.length === 2, 'pending update wakes without another source write');
  assert.ok(sent[1].observedAt >= settledAt + cadence.publicationMs, 'echo confirmation starts ordinary cooldown');
  assert.match(sent[1].content, /Deliver the newer plan/);
  assert.equal(f.state.listMessages().length, 0);
  await p.stop();
  assert.equal(f.state.publications.listenerCount('settled'), 0);
});

function heldInterpreter() {
  const calls = [];
  const interpret = (snapshot, { signal }) => new Promise(resolve => {
    let timer;
    const finish = result => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(result); };
    const abort = () => { timer = setTimeout(() => finish({ status: 'unavailable', reason: 'cancelled' }), 50); };
    signal.addEventListener('abort', abort, { once: true });
    calls.push({ snapshot, finish, signal });
  });
  return { calls, interpret };
}
function usefulContext(snapshot) {
  return { status: 'ready', snapshotId: snapshot.id, preview: '**Possible connection · Luna**\nDevice evidence supports the recorded proof obligation.',
    interpretation: { decision: 'context' } };
}

test('board-only default survives restart and CLI context opt-in starts one model', async t => {
  const { spawnSync } = require('node:child_process');
  const f = fixture(t);
  const model = heldInterpreter();
  const sent = [];
  const send = async (_binding, post) => { sent.push(post); return { id: String(8900 + sent.length) }; };
  const first = start(f, { send, interpret: model.interpret });
  await until(() => sent.length === 1);
  await first.drain();
  assert.equal(model.calls.length, 0);
  assert.equal(f.state.db.prepare('SELECT COUNT(*) AS n FROM publication_context').get().n, 0);
  await first.stop(); f.reopen();
  const second = start(f, { send, interpret: model.interpret });
  await second.drain();
  assert.equal(model.calls.length, 0);
  const cli = spawnSync(process.execPath, [require.resolve('../src/cli'), 'publication', 'enable',
    '--state-dir', f.dir, '--channel-id', 'channel', '--native-id', NATIVE, '--generation', '1', '--context'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).contextEnabled, true);
  await until(() => model.calls.length === 1, 'policy file event starts opted-in model');
  model.calls[0].finish(usefulContext(model.calls[0].snapshot));
  await until(() => sent.length === 2);
  assert.equal(sent[1].kind, 'context');
  await second.stop(); f.reopen();
  assert.equal(f.state.publications.contextEnabled(f.binding), true);
  f.state.setConfig({ operatorId: 'other-operator' });
  assert.equal(f.state.publications.contextEnabled(f.binding), false);
});

test('removing context policy aborts inference and discards late output without stopping boards', async t => {
  const f = fixture(t);
  f.state.publications.setEnabled(f.binding, true, { context: true });
  const model = heldInterpreter();
  const sent = [];
  const send = async (_binding, post) => { sent.push(post); return { id: String(8950 + sent.length) }; };
  const p = start(f, { send, interpret: model.interpret });
  await until(() => model.calls.length === 1 && sent.length === 1);
  const active = model.calls[0];
  f.state.publications.setEnabled(f.binding, true);
  await until(() => active.signal.aborted, 'policy change aborts without registry event');
  active.finish(usefulContext(active.snapshot));
  f.data._conductors['owner.md'].next = ['Continue deterministic proof']; f.write();
  await until(() => sent.length === 2);
  assert.ok(sent.every(post => post.kind === 'board'));
  assert.equal(f.state.db.prepare("SELECT COUNT(*) AS n FROM publication_posts WHERE kind='context'").get().n, 0);
  await p.stop(); f.reopen();
  const restarted = start(f, { send, interpret: model.interpret });
  await restarted.drain();
  assert.equal(model.calls.length, 1);
  assert.equal(f.state.publications.status()[0].contextEnabled, false);
});

test('disabled context stays pending and cannot start a request after asynchronous lookup', async t => {
  const f = fixture(t);
  f.state.publications.setEnabled(f.binding, true, { context: true });
  const store = f.state.publications;
  const snapshot = await f.readSnapshot(f.binding, { registry: f.registry });
  store.stage(f.binding, snapshot, 'Board');
  const board = store.pending(f.binding);
  assert.equal(store.begin(f.binding, board.id, Date.now()), true);
  store.sent(board.id, '8970', Date.now());
  store.queueContext(f.binding, snapshot);
  store.finishContext(store.contextWork()[0], usefulContext(snapshot), Date.now());
  const post = store.pending(f.binding);
  assert.equal(post.kind, 'context');
  f.state.publications.setEnabled(f.binding, true);
  assert.equal(store.pending(f.binding), null);
  assert.equal(store.begin(f.binding, post.id, Date.now()), false);
  f.state.publications.setEnabled(f.binding, true, { context: true });
  assert.equal(store.begin(f.binding, post.id, Date.now()), true);
  let release;
  let sends = 0;
  const channel = { send: async () => { sends++; return { id: '8971' }; } };
  const gateway = new DiscordGateway({ state: f.state,
    client: { channels: { fetch: () => new Promise(resolve => { release = () => resolve(channel); }) }, on() {}, off() {} }, providers: {} });
  gateway.ready = true;
  t.after(() => gateway.stop());
  const pending = gateway.sendPublication(f.binding, post, new AbortController().signal);
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.outcome, 'not_sent');
    store.failed(post.id, error, Date.now(), 150);
    return true;
  });
  await until(() => release);
  store.setEnabled(f.binding, true);
  release();
  await rejected;
  assert.equal(sends, 0);
  assert.equal(store.pending(f.binding), null);
  assert.equal(f.state.db.prepare('SELECT status FROM publication_posts WHERE id=?').get(post.id).status, STATUS.PENDING);
});

test('slow interpretation never delays board and current note wakes once without a file event or restart repeat', async t => {
  const f = fixture(t);
  f.state.publications.setEnabled(f.binding, true, { context: true });
  const model = heldInterpreter();
  const sent = [];
  const send = async (_binding, post) => { sent.push({ ...post, at: Date.now() }); return { id: String(9000 + sent.length) }; };
  const p = start(f, { send, interpret: model.interpret });
  await until(() => sent.length === 1 && model.calls.length === 1);
  assert.equal(sent[0].kind, 'board');
  model.calls[0].finish(usefulContext(model.calls[0].snapshot));
  await until(() => sent.length === 2, 'context completion wakes sender');
  assert.equal(sent[1].kind, 'context');
  assert.ok(sent[1].at >= sent[0].at + 150);
  assert.equal(sent[1].board_id, sent[0].id);
  await p.stop(); f.reopen();
  const restarted = start(f, { send, interpret: model.interpret });
  await restarted.drain();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(sent.length, 2);
  assert.equal(model.calls.length, 1);
});

test('newer source and shutdown discard late interpretation without reviving its note', async t => {
  const f = fixture(t);
  f.state.publications.setEnabled(f.binding, true, { context: true });
  const model = heldInterpreter();
  const sent = [];
  const p = start(f, { interpret: model.interpret, send: async (_binding, post) => { sent.push(post); return { id: String(9100 + sent.length) }; } });
  await until(() => model.calls.length === 1);
  const old = model.calls[0];
  f.data._conductors['owner.md'].next = ['Newer device check']; f.write();
  await until(() => old.signal.aborted);
  old.finish(usefulContext(old.snapshot));
  await until(() => model.calls.length === 2 && sent.length === 2);
  assert.ok(sent.every(post => post.kind === 'board'));
  assert.match(sent[1].content, /Newer device check/);
  const stop = p.stop();
  model.calls[1].finish(usefulContext(model.calls[1].snapshot));
  await stop;
  assert.equal(f.state.db.prepare("SELECT COUNT(*) AS n FROM publication_posts WHERE kind='context'").get().n, 0);
});

test('unknown context delivery does not block a newer deterministic board', async t => {
  const f = fixture(t);
  f.state.publications.setEnabled(f.binding, true, { context: true });
  const sent = [];
  const p = start(f, { interpret: async snapshot => usefulContext(snapshot), send: async (_binding, post) => {
    sent.push(post);
    if (post.kind === 'context') throw new Error('context send outcome unknown');
    return { id: String(9200 + sent.length) };
  } });
  await until(() => f.state.db.prepare("SELECT id FROM publication_posts WHERE kind='context' AND status='unknown'").get());
  f.data._conductors['owner.md'].next = ['Urgent new deterministic step']; f.write();
  await until(() => sent.filter(post => post.kind === 'board').length === 2);
  assert.match(sent.at(-1).content, /Urgent new deterministic step/);
  await p.stop(); f.reopen();
  let retries = 0;
  const restarted = start(f, { interpret: async () => { throw new Error('must not repeat'); }, send: async () => { retries++; return { id: 'unexpected' }; } });
  await restarted.drain();
  assert.equal(retries, 0);
});

test('ready context survives result-before-send restart and abandoned inference never relaunches', async t => {
  const f = fixture(t);
  f.state.publications.setEnabled(f.binding, true, { context: true });
  const sent = [];
  let models = 0;
  const send = async (_binding, post) => { sent.push(post); return { id: String(9300 + sent.length) }; };
  const p = start(f, { send, interpret: async snapshot => { models++; return usefulContext(snapshot); } });
  await until(() => f.state.db.prepare("SELECT id FROM publication_posts WHERE kind='context' AND status='pending'").get());
  await p.stop(); f.reopen();
  const restarted = start(f, { send, interpret: async () => { models++; return { status: 'unavailable' }; } });
  await until(() => sent.length === 2);
  assert.equal(models, 1);
  await restarted.stop();
  f.state.db.prepare("UPDATE publication_context SET status='running'").run();
  f.reopen();
  const recovered = start(f, { send, interpret: async () => { models++; return { status: 'unavailable' }; } });
  await recovered.drain();
  assert.equal(models, 1);
  assert.equal(sent.length, 2);
  assert.equal(f.state.db.prepare('SELECT reason FROM publication_context').get().reason, 'interrupted');
});

test('two selected bindings share one inference slot while both boards remain independent', async t => {
  const f = fixture(t);
  f.state.publications.setEnabled(f.binding, true, { context: true });
  const second = { ...f.binding, channelId: 'second', nativeId: '79e3da8e-94b4-4aff-8f88-b45b3a451dd1', conductorId: 'second.md', repoKey: 'repo:second' };
  f.state.bind(second); f.state.setBindingReadiness('second', 'ready');
  f.state.publications.setEnabled(f.state.getBinding('second'), true, { context: true });
  f.data._conductors['second.md'] = { ...f.data._conductors['owner.md'], repository: second.repoKey, nativeId: second.nativeId };
  f.write();
  const model = heldInterpreter();
  const sent = [];
  const p = start(f, { interpret: model.interpret, send: async (binding, post) => { sent.push({ ...post, channel: binding.channelId }); return { id: String(9400 + sent.length) }; } });
  await until(() => sent.length === 2 && model.calls.length === 1);
  assert.equal(new Set(sent.map(post => post.channel)).size, 2);
  model.calls[0].finish({ status: 'ready', snapshotId: model.calls[0].snapshot.id, interpretation: { decision: 'quiet' } });
  await until(() => model.calls.length === 2);
  model.calls[1].finish(usefulContext(model.calls[1].snapshot));
  await until(() => sent.length === 3);
  assert.equal(sent[2].kind, 'context');
  await p.stop();
  assert.equal(f.state.db.prepare("SELECT COUNT(*) AS n FROM publication_context WHERE status='quiet'").get().n, 1);
});

test('automatic publication consumes the bounded interpreter process and its validated rendered result', async t => {
  const { interpretSnapshot } = require('../src/context-interpretation');
  const f = fixture(t);
  f.state.publications.setEnabled(f.binding, true, { context: true });
  const sent = [];
  let pid, directory;
  const p = start(f, { interpret: (snapshot, options) => interpretSnapshot(snapshot, { ...options,
    onSpawn: child => { pid = child.pid; }, buildCommand: ({ cwd, answerPath }) => {
      directory = cwd;
      return { command: process.execPath, args: ['-e', `
        const fs = require('node:fs'); let input = '';
        process.stdin.on('data', chunk => input += chunk);
        process.stdin.on('end', () => {
          const packet = JSON.parse(input.trim().split('\\n').at(-1));
          fs.writeFileSync(${JSON.stringify(answerPath)}, JSON.stringify({ snapshotId: packet.snapshotId,
            decision: 'context', summary: 'The recorded check connects the device-evidence intent with the proof owed to the operator.',
            evidenceIds: ['context.intent','context.next','context.owedToOperator'], uncertainties: [] }));
        });`] };
    }
  }), send: async (_binding, post) => { sent.push(post); return { id: String(9500 + sent.length) }; } });
  await until(() => sent.length === 2);
  assert.equal(sent[0].kind, 'board');
  assert.equal(sent[1].kind, 'context');
  assert.match(sent[1].content, /Possible connection · Luna/);
  assert.match(sent[1].content, /Sources: context.intent/);
  await p.stop();
  assert.equal(fs.existsSync(directory), false);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
