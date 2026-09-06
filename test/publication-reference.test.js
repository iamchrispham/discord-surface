const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { SurfaceState } = require('../src/state');
const { createSurfaceConsumer } = require('../src/discord');
const { codexPrompt, claudeEvent } = require('../src/native');
const { createMonitorMcp } = require('../src/claude-monitor');
const { REFERENCE_RECEIPT } = require('../src/publication/reference');

const NATIVE = '79e3da8e-94b4-4aff-8f88-b45b3a451dd1';
const SUCCESSOR = '9caa5d21-2169-429d-918b-5f08651b5dbd';
function fixture(t, provider = 'claude') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ref-'));
  const db = path.join(dir, 'surface.sqlite');
  let state = new SurfaceState(db);
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'secret') });
  state.bind({ channelId: 'channel', guildId: 'guild', provider, nativeId: NATIVE, workspace: dir,
    endpoint: provider === 'claude' ? path.join(dir, 'listener.sock') : undefined, conductorId: 'owner.md', repoKey: 'repo:ours' });
  state.setBindingReadiness('channel', 'ready');
  const binding = state.getBinding('channel');
  state.publications.setEnabled(binding, true);
  state.publications.stage(binding, { id: 'snapshot-original' }, 'Proof is owed to you. Next: inspect the device.');
  const post = state.publications.pending(binding);
  state.publications.begin(binding, post.id, 1000);
  state.publications.sent(post.id, '100', 2000);
  return { dir, db, binding, post, get state() { return state; },
    reopen() { state.close(); state = new SurfaceState(db); return state; } };
}
const human = (id = '200') => ({ id, channelId: 'channel', guildId: 'guild', author: { id: 'operator', bot: false },
  content: 'What evidence is still missing?', reference: { messageId: '100' } });
async function accept(f, event = human()) {
  return createSurfaceConsumer({ state: f.state, providers: {} }).intakeMessage(event, false);
}

test('exact reference survives duplicate intake, source replacement, restart and native payloads', async t => {
  for (const provider of ['codex', 'claude']) {
    const f = fixture(t, provider);
    const accepted = await accept(f);
    assert.equal(accepted.accepted, true);
    const reference = accepted.message.publicationReference;
    assert.equal(reference.content, f.post.content);
    assert.equal(reference.snapshotId, 'snapshot-original');
    assert.equal(reference.sentAt, 2000);
    assert.equal(accepted.message.content, human().content);
    f.state.publications.stage(f.binding, { id: 'snapshot-new' }, 'UNRELATED NEW CONTEXT');
    const duplicate = await accept(f, { ...human(), reference: { messageId: 'unknown' } });
    assert.equal(duplicate.duplicate, true);
    f.reopen();
    const message = f.state.getMessage('200');
    assert.deepEqual(message.publicationReference, reference);
    const plan = f.state.db.prepare('EXPLAIN QUERY PLAN SELECT detail FROM receipts WHERE discord_id=? AND kind=? ORDER BY id LIMIT 1').all('200', REFERENCE_RECEIPT);
    assert.ok(plan.some(row => row.detail.includes('SEARCH receipts USING INDEX publication_reference_message')));
    for (const text of [codexPrompt(message), claudeEvent(message).content]) {
      assert.ok(text.includes(JSON.stringify(reference)));
      assert.ok(text.includes(human().content));
      assert.ok(!text.includes('UNRELATED NEW CONTEXT'));
      assert.match(text, /historical source data/);
    }
    if (provider !== 'claude') continue;
    let line = '';
    const stdout = new Writable({ write(chunk, _encoding, done) { line += chunk; done(); } });
    const monitor = createMonitorMcp({ state: f.state, stateDir: f.dir, dbPath: f.db, stdout });
    await monitor.notification({ method: 'notifications/claude/channel', params: {
      content: 'FORGED UPSTREAM CONTENT', meta: { messageId: '200', nativeId: NATIVE, generation: '1' } } });
    const pointer = JSON.parse(line);
    const payload = JSON.parse(fs.readFileSync(pointer.payloadPath, 'utf8'));
    assert.deepEqual(payload.publicationReference, reference);
    assert.equal(payload.content, human().content);
    assert.match(payload.instructions, /historical source data/);
    assert.equal(payload.reply.messageId, '200');
    await monitor.close(); stdout.destroy();
  }
});

test('same-role successor receives explicitly referenced history with original provenance', async t => {
  const f = fixture(t);
  f.state.db.prepare('UPDATE bindings SET native_id=?,generation=2 WHERE channel_id=?').run(SUCCESSOR, 'channel');
  const result = await accept(f);
  assert.equal(result.message.nativeId, SUCCESSOR);
  assert.equal(result.message.generation, 2);
  assert.equal(result.message.publicationReference.owner.nativeId, NATIVE);
  assert.equal(result.message.publicationReference.owner.generation, 1);
  f.reopen();
  assert.deepEqual(f.state.getMessage('200').publicationReference, result.message.publicationReference);
});

test('foreign roles, unknown IDs and oversized references never replace or block human input', async t => {
  for (const column of ['repo_key', 'conductor_id', 'provider']) {
    const f = fixture(t);
    f.state.db.prepare(`UPDATE bindings SET ${column}=? WHERE channel_id=?`).run(column === 'provider' ? 'codex' : 'foreign', 'channel');
    const result = await accept(f);
    assert.equal(result.accepted, true);
    assert.equal(result.message.content, human().content);
    assert.equal(result.message.publicationReference, undefined);
  }
  const f = fixture(t);
  for (const column of ['channel_id', 'guild_id']) {
    f.state.db.prepare(`UPDATE publication_posts SET ${column}=?`).run('foreign');
    assert.equal((await accept(f, human(column))).message.publicationReference, undefined);
    f.state.db.prepare(`UPDATE publication_posts SET ${column}=?`).run(column === 'channel_id' ? 'channel' : 'guild');
  }
  f.state.db.prepare('UPDATE publication_posts SET status=?').run('unknown');
  assert.equal((await accept(f, human('unsent'))).message.publicationReference, undefined);
  f.state.db.prepare('UPDATE publication_posts SET status=?').run('sent');
  assert.equal((await accept(f, { ...human(), reference: { messageId: 'unknown' } })).message.publicationReference, undefined);
  f.state.db.prepare('UPDATE publication_posts SET content=?').run('x'.repeat(2001));
  assert.equal((await accept(f, human('201'))).message.publicationReference, undefined);
  assert.equal((await accept(f, { ...human('202'), author: { id: 'intruder', bot: false } })).accepted, false);
  assert.equal(f.state.getMessage('202'), null);
});

test('unresolved publication reply targets settle when the bot echo arrives', async t => {
  const f = fixture(t);
  f.state.db.prepare("UPDATE publication_posts SET status='unknown', message_id=NULL").run();
  const accepted = await accept(f, { ...human(), reference: { messageId: '201' } });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.message.publicationReference, undefined);
  assert.deepEqual(accepted.message.publicationReferenceTarget, { messageId: '201', status: 'unresolved' });
  f.state.publications.sent(f.post.id, '201', 3000);
  const message = f.state.getMessage('200');
  assert.equal(message.publicationReference.messageId, '201');
  assert.equal(message.publicationReferenceTarget, undefined);
  assert.equal(message.publicationReference.snapshotId, 'snapshot-original');
});

test('publication reference custody never gates dispatch and mismatched settlement stays unresolved', async t => {
  const f = fixture(t);
  f.state.db.prepare("UPDATE publication_posts SET status='unknown', message_id=NULL").run();
  const accepted = await accept(f, { ...human(), reference: { messageId: 'ordinary-earlier-message' } });
  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.message.publicationReferenceTarget, { messageId: 'ordinary-earlier-message', status: 'unresolved' });
  f.state.setBindingReadiness('channel', 'ready');

  const claimed = f.state.claimDispatch('200');
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.message.state, 'dispatching');

  f.state.publications.sent(f.post.id, '201', 3000);
  const message = f.state.getMessage('200');
  assert.equal(message.publicationReference, undefined);
  assert.deepEqual(message.publicationReferenceTarget, { messageId: 'ordinary-earlier-message', status: 'unresolved' });
  f.reopen();
  assert.deepEqual(f.state.getMessage('200').publicationReferenceTarget, { messageId: 'ordinary-earlier-message', status: 'unresolved' });
});

test('unresolved reply uses the existing native dispatch path exactly once', async t => {
  const f = fixture(t);
  f.state.db.prepare("UPDATE publication_posts SET status='unknown', message_id=NULL").run();
  let dispatches = 0;
  const consumer = createSurfaceConsumer({
    state: f.state,
    providers: { claude: { async dispatch() { dispatches += 1; return { status: 'not_submitted', error: new Error('fixture rejection') }; } } },
    sendTransportReceipt: async () => ({ id: 'receipt' })
  });
  const result = await consumer.handleMessage({ ...human(), reference: { messageId: 'ordinary-earlier-message' } });
  await consumer.waitForReceipts();
  assert.equal(result.message.state, 'accepted');
  assert.equal(dispatches, 1);
  f.state.publications.sent(f.post.id, '201', 3000);
  assert.equal(dispatches, 1);
});

test('publication custody mismatch or failure leaves the exact target unresolved', async t => {
  const f = fixture(t);
  f.state.db.prepare("UPDATE publication_posts SET status='unknown', message_id='202'").run();
  const accepted = await accept(f, { ...human(), reference: { messageId: '202' } });
  assert.deepEqual(accepted.message.publicationReferenceTarget, { messageId: '202', status: 'pending' });
  f.state.publications.sent(f.post.id, '201', 3000);
  assert.equal(f.state.getMessage('200').publicationReference, undefined);
  assert.deepEqual(f.state.getMessage('200').publicationReferenceTarget, { messageId: '202', status: 'unresolved' });

  const retry = fixture(t);
  retry.state.db.prepare("UPDATE publication_posts SET status='unknown', message_id='202'").run();
  const retryAccepted = await accept(retry, { ...human(), reference: { messageId: '202' } });
  assert.deepEqual(retryAccepted.message.publicationReferenceTarget, { messageId: '202', status: 'pending' });
  retry.state.clearPendingPublicationReferences(retry.post.id);
  assert.deepEqual(retry.state.getMessage('200').publicationReferenceTarget, { messageId: '202', status: 'unresolved' });
});

test('exact target correlation settles a pending publication reference without redispatch', async t => {
  const f = fixture(t);
  f.state.db.prepare("UPDATE publication_posts SET status='unknown', message_id='201'").run();
  const accepted = await accept(f, { ...human(), reference: { messageId: '201' } });
  assert.deepEqual(accepted.message.publicationReferenceTarget, { messageId: '201', status: 'pending' });
  f.state.setBindingReadiness('channel', 'ready');
  const claimed = f.state.claimDispatch('200');
  assert.equal(claimed.claimed, true);
  f.state.publications.sent(f.post.id, '201', 3000);
  const message = f.state.getMessage('200');
  assert.equal(message.publicationReference.messageId, '201');
  assert.equal(message.publicationReferenceTarget, undefined);
});

test('reference and accepted input roll back together when reference persistence fails', async t => {
  const f = fixture(t);
  const original = f.state.receipt.bind(f.state);
  f.state.receipt = (id, kind, detail) => { if (kind === REFERENCE_RECEIPT) throw new Error('fixture disk failure'); return original(id, kind, detail); };
  await assert.rejects(accept(f), /fixture disk failure/);
  assert.equal(f.state.getMessage('200'), null);
  f.state.receipt = original;
  assert.equal((await accept(f)).accepted, true);
  assert.equal(f.state.listReceipts().filter(row => row.kind === REFERENCE_RECEIPT).length, 1);
});
