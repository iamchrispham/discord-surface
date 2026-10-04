'use strict';


const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, service, addRecipient } = require('./fixtures/peer-fixture');
const { READINESS } = require('../src/state');

const ORIGINAL = '11111111-1111-1111-1111-111111111111';
const CHANGED = '99999999-9999-9999-9999-999999999999';
const REFUSAL = /peer caller|native caller|caller changed|caller has no active binding|caller binding is ambiguous|caller identity is unavailable|binding changed|binding is stale/i;

const response = body => ({ ok: true, status: 200, json: async () => body });
const identity = current => ({
  resolveClaudeCaller: async () => ({ harness: 'claude-code', sessionId: current() })
});

async function nativeRefusal(work, simulatedNetworkError = null) {
  try {
    await work;
    return false;
  } catch (error) {
    if (error === simulatedNetworkError) throw error;
    if (!(error instanceof Error) || !REFUSAL.test(error.message)) throw error;
    return true;
  }
}

function messageFile(t, f, name) {
  const file = path.join(path.dirname(f.state.requireConfig().secretFile), name);
  t.after(() => fs.rmSync(file, { force: true }));
  return file;
}

function directPostRows(state, requestId) {
  const rows = state.directPostRows(requestId);
  return {
    attempts: rows.filter(row => row.kind === 'direct-post-attempt'),
    outcomes: rows.filter(row => row.kind === 'direct-post-outcome')
  };
}

function boardReceipts(state, requestId) {
  return state.listReceipts()
    .map(row => ({ kind: row.kind, detail: JSON.parse(row.detail) }))
    .filter(row => row.kind.startsWith('board-refresh') && row.detail.requestId === requestId);
}

function addChangedCaller(f) {
  f.state.bind({ guildId: '100', channelId: '301', provider: 'claude', nativeId: CHANGED,
    workspace: '/tmp', endpoint: '/tmp/changed-caller.sock',
    conductorId: 'changed-caller', repoKey: 'github.com/test/changed' }, { intakeCutoff: '100' });
  f.state.markIntakeBoundary('301', 'ready', 'fixture history recovered');
  f.state.setBindingReadiness('301', READINESS.READY, 'fixture', f.state.getBinding('301'));
}

// A board duplicate or historical return performs no network request and writes no
// receipt, but the peer service must still revalidate the native caller before it
// hands the stored result back.
async function boardReturnRefusal(t, mode) {
  const f = fixture(t);
  const requestId = `effect-board-${mode}`;
  const seedKey = `${requestId}-seed`;
  const textFile = messageFile(t, f, `${requestId}.txt`);
  fs.writeFileSync(textFile, 'Initial board');
  addChangedCaller(f);
  let call = 0;
  let resolutions = 0;
  let gets = 0;
  let patches = 0;
  let failPatch = false;
  const peer = service(f, { callerDependencies: { resolveClaudeCaller: async () => {
    resolutions += 1;
    if (call > 0 && resolutions > 1) return { harness: 'claude-code', sessionId: CHANGED };
    return { harness: 'claude-code', sessionId: ORIGINAL };
  } }, fetchImpl: async (url, options) => {
    if (options.method === 'POST') {
      return response({ id: '10001', channel_id: '101', author: { id: 'bot', bot: true }, content: 'Initial board' });
    }
    if (options.method === 'PATCH') {
      patches += 1;
      if (failPatch) throw new Error('simulated board transport failure');
      return response({ id: '10001', channel_id: '101', author: { id: 'bot', bot: true }, content: 'Updated board' });
    }
    gets += 1;
    if (url.endsWith('/users/@me')) return response({ id: 'bot' });
    if (url.endsWith('/channels/101')) return response({ id: '101', guild_id: '100' });
    assert.match(url, /\/channels\/101\/messages\/10001$/);
    return response({ id: '10001', channel_id: '101', author: { id: 'bot', bot: true }, content: 'Initial board' });
  } });
  const seeded = await peer.post({ role: 'announce', text_file: textFile, dedupe_key: seedKey });
  assert.equal(seeded.status, 'sent', 'the provenance seed stays sent');
  fs.writeFileSync(textFile, 'Updated board');
  failPatch = mode === 'duplicate';
  await peer.post({ role: 'board', message_id: '10001', text_file: textFile, dedupe_key: requestId });
  call = 1;
  resolutions = 0;
  gets = 0;
  patches = 0;
  const before = JSON.stringify(boardReceipts(f.state, requestId));
  const refused = await nativeRefusal(peer.post({ role: 'board', message_id: '10001', text_file: textFile, dedupe_key: requestId }));
  return {
    mode,
    refused,
    gets,
    patches,
    unchanged: JSON.stringify(boardReceipts(f.state, requestId)) === before
  };
}

function boardBoundary(t, boundary, requestId, seedKey) {
  const f = fixture(t);
  const textFile = messageFile(t, f, `${requestId}.txt`);
  fs.writeFileSync(textFile, 'Initial board');
  let current = ORIGINAL;
  let boardGets = 0;
  let patches = 0;
  const peer = service(f, { callerDependencies: identity(() => current), fetchImpl: async (url, options) => {
    if (options.method === 'POST') {
      return response({ id: '10001', channel_id: '101', author: { id: 'bot', bot: true }, content: 'Initial board' });
    }
    if (options.method === 'PATCH') {
      patches += 1;
      return response({ id: '10001', channel_id: '101', author: { id: 'bot', bot: true }, content: 'Updated board' });
    }
    boardGets += 1;
    if (boardGets === boundary) current = CHANGED;
    if (url.endsWith('/users/@me')) return response({ id: 'bot' });
    if (url.endsWith('/channels/101')) return response({ id: '101', guild_id: '100' });
    assert.match(url, /\/channels\/101\/messages\/10001$/);
    return response({ id: '10001', channel_id: '101', author: { id: 'bot', bot: true }, content: 'Initial board' });
  } });
  return async () => {
    const seeded = await peer.post({ role: 'announce', text_file: textFile, dedupe_key: seedKey });
    boardGets = 0;
    patches = 0;
    fs.writeFileSync(textFile, 'Updated board');
    const nativeRefused = await nativeRefusal(peer.post({ role: 'board', message_id: '10001', text_file: textFile, dedupe_key: requestId }));
    assert.equal(nativeRefused, true, 'native caller must be revalidated');
    assert.equal(seeded.status, 'sent', 'the seed announcement stays sent');
    assert.equal(boardGets, boundary, 'board GETs stop at the selected lookup boundary');
    assert.equal(patches, 0, 'no board PATCH after the caller changed');
    assert.equal(boardReceipts(f.state, requestId).filter(row => row.kind === 'board-refresh-attempt').length, 0,
      'no board admission after the caller changed');
    const seed = directPostRows(f.state, seedKey).outcomes;
    assert.deepEqual(seed.map(row => [row.detail.outcome, row.detail.messageId]), [['sent', '10001']]);
  };
}

test('peer send refuses after destination lookup', async t => {
  // The channelName selector really calls loadChannels. Each case changes one
  // captured caller identity field during that lookup and requires a refusal
  // before any later HTTP request or attempt.
  const changes = [
    { name: 'provider', mutate(f) {
      f.state.db.prepare("UPDATE bindings SET provider='codex' WHERE channel_id='101'").run();
    } },
    { name: 'guildId', mutate(f) {
      const guildId = '200';
      f.state.setConfig({ guildId });
      f.state.db.prepare('UPDATE bindings SET guild_id=? WHERE guild_id=?').run(guildId, '100');
      f.state.db.prepare('UPDATE thread_enrollments SET guild_id=? WHERE guild_id=?').run(guildId, '100');
    } },
    { name: 'channelId', mutate(f) {
      // The bindings and thread_enrollments tables reference each other, so move
      // both rows together and defer the foreign-key check to commit.
      f.state.db.exec('PRAGMA defer_foreign_keys = ON');
      f.state.db.exec('BEGIN');
      f.state.db.prepare("UPDATE bindings SET channel_id='103' WHERE channel_id='101'").run();
      f.state.db.prepare("UPDATE thread_enrollments SET parent_channel_id='103' WHERE parent_channel_id='101'").run();
      f.state.db.exec('COMMIT');
    } },
    { name: 'nativeId', mutate(f) {
      f.state.db.prepare("UPDATE bindings SET native_id='33333333-3333-3333-3333-333333333333' WHERE channel_id='101'").run();
    } },
    { name: 'generation', mutate(f) {
      f.state.db.prepare("UPDATE bindings SET generation=generation+1 WHERE channel_id='101'").run();
    } }
  ];
  const failures = [];
  for (const change of changes) {
    const f = fixture(t);
    f.enroll('102');
    addRecipient(f);
    let requests = 0;
    const peer = service(f, {
      loadChannels: async () => {
        change.mutate(f);
        return [{ id: '201', guildId: f.state.requireConfig().guildId, name: 'general' }];
      },
      fetchImpl: async () => {
        requests += 1;
        return response({ id: '10001' });
      }
    });
    const dedupeKey = `effect-send-channel-name-${change.name}`;
    let refused = false;
    try {
      refused = await nativeRefusal(peer.send({ peer: { channelName: 'general' }, text: 'hello', dedupe_key: dedupeKey }));
    } catch (error) {
      failures.push(`${change.name}: unexpected error ${error.message}`);
      continue;
    }
    const attempts = directPostRows(f.state, dedupeKey).attempts.length;
    if (!refused || requests !== 0 || attempts !== 0) {
      failures.push(`${change.name}: refused=${refused} requests=${requests} attempts=${attempts}`);
    }
  }
  assert.deepEqual(failures, [], `channelName lookup identity changes must refuse before any later HTTP request or attempt: ${failures.join('; ')}`);

  const f = fixture(t);
  f.enroll('102');
  addRecipient(f);
  let current = ORIGINAL;
  let gets = 0;
  let posts = 0;
  const peer = service(f, { callerDependencies: identity(() => current), fetchImpl: async (url, options) => {
    if (options.method === 'GET') {
      gets += 1;
      assert.match(url, /\/channels\/202$/);
      current = CHANGED;
      return response({ id: '202', guild_id: '100' });
    }
    posts += 1;
    return response({ id: '10001' });
  } });
  const nativeRefused = await nativeRefusal(peer.send({ peer: { channelId: '201' }, text: 'hello', dedupe_key: 'effect-send-get' }));
  assert.equal(nativeRefused, true, 'native caller must be revalidated');
  assert.equal(gets, 1, 'destination lookup runs once');
  assert.equal(posts, 0, 'no outbound post after the caller changed');
  assert.equal(directPostRows(f.state, 'effect-send-get').attempts.length, 0, 'no direct-post attempt after the caller changed');
});

test('board refuses after installation lookup', async t => {
  await boardBoundary(t, 1, 'effect-board-installation', 'effect-board-installation-seed')();
});

test('board refuses after channel lookup', async t => {
  await boardBoundary(t, 2, 'effect-board-channel', 'effect-board-channel-seed')();
});

test('board refuses after target lookup', async t => {
  await boardBoundary(t, 3, 'effect-board-target', 'effect-board-target-seed')();
});

test('announcement refuses after admitted claim', async t => {
  const f = fixture(t);
  const textFile = messageFile(t, f, 'effect-announce-claim.txt');
  fs.writeFileSync(textFile, 'Announcement');
  let current = ORIGINAL;
  let posts = 0;
  const original = f.state.beginDirectPostPart.bind(f.state);
  f.state.beginDirectPostPart = (...args) => {
    const claim = original(...args);
    if (claim.claimed) current = CHANGED;
    return claim;
  };
  const peer = service(f, { callerDependencies: identity(() => current), fetchImpl: async () => {
    posts += 1;
    return response({ id: '10001' });
  } });
  const nativeRefused = await nativeRefusal(peer.post({ role: 'announce', text_file: textFile, dedupe_key: 'effect-announce-claim' }));
  assert.equal(nativeRefused, true, 'native caller must be revalidated');
  const rows = directPostRows(f.state, 'effect-announce-claim');
  assert.equal(rows.attempts.length, 1, 'the admitted attempt is retained');
  assert.equal(rows.outcomes.length, 1, 'a single known-unsent outcome is recorded');
  assert.equal(rows.outcomes[0].detail.outcome, 'stale');
  assert.equal(rows.outcomes[0].detail.nonce, rows.attempts[0].detail.nonce, 'the original nonce is retained');
  assert.equal(posts, 0, 'no outbound post after the caller changed');
});

test('announcement retains sent evidence after caller changes', async t => {
  const f = fixture(t);
  const textFile = messageFile(t, f, 'effect-announce-sent.txt');
  fs.writeFileSync(textFile, 'Announcement');
  let current = ORIGINAL;
  let posts = 0;
  let nonce = null;
  const peer = service(f, { callerDependencies: identity(() => current), fetchImpl: async (url, options) => {
    posts += 1;
    const body = JSON.parse(options.body);
    nonce = body.nonce;
    current = CHANGED;
    return response({ id: '10001', channel_id: '101', author: { id: 'bot', bot: true }, content: body.content });
  } });
  const nativeRefused = await nativeRefusal(peer.post({ role: 'announce', text_file: textFile, dedupe_key: 'effect-announce-sent' }));
  assert.equal(nativeRefused, true, 'native caller must be revalidated');
  const rows = directPostRows(f.state, 'effect-announce-sent');
  assert.equal(rows.attempts.length, 1, 'one claimed attempt');
  assert.equal(rows.outcomes.length, 1, 'sent evidence is saved exactly once');
  assert.equal(rows.outcomes[0].detail.outcome, 'sent');
  assert.equal(rows.outcomes[0].detail.messageId, '10001');
  assert.equal(rows.outcomes[0].detail.nonce, nonce, 'the original nonce is retained');
  assert.equal(posts, 1, 'no retry after the caller changed');
});

test('board retains applied evidence after caller changes', async t => {
  // A historical (applied outcome) and a duplicate (unresolved outcome) board
  // return each revalidate before handing the stored result back: no HTTP request
  // and no change to the saved evidence.
  const failures = [];
  for (const mode of ['historical', 'duplicate']) {
    const returned = await boardReturnRefusal(t, mode);
    if (!returned.refused || returned.gets !== 0 || returned.patches !== 0 || !returned.unchanged) {
      failures.push(`${mode}: refused=${returned.refused} gets=${returned.gets} patches=${returned.patches} unchanged=${returned.unchanged}`);
    }
  }
  assert.deepEqual(failures, [], `stored board returns must revalidate before disclosure: ${failures.join('; ')}`);

  const f = fixture(t);
  const textFile = messageFile(t, f, 'effect-board-applied.txt');
  fs.writeFileSync(textFile, 'Initial board');
  let current = ORIGINAL;
  let patches = 0;
  const peer = service(f, { callerDependencies: identity(() => current), fetchImpl: async (url, options) => {
    if (options.method === 'GET' && url.endsWith('/users/@me')) return response({ id: 'bot' });
    if (options.method === 'GET' && url.endsWith('/channels/101')) return response({ id: '101', guild_id: '100' });
    if (options.method === 'GET') return response({ id: '10001', channel_id: '101', author: { id: 'bot', bot: true }, content: 'Initial board' });
    if (options.method === 'POST') return response({ id: '10001', channel_id: '101', author: { id: 'bot', bot: true }, content: 'Initial board' });
    patches += 1;
    current = CHANGED;
    return response({ id: '10001', channel_id: '101', author: { id: 'bot', bot: true }, content: 'Updated board' });
  } });
  const seeded = await peer.post({ role: 'announce', text_file: textFile, dedupe_key: 'effect-board-applied-seed' });
  fs.writeFileSync(textFile, 'Updated board');
  const nativeRefused = await nativeRefusal(peer.post({ role: 'board', message_id: '10001', text_file: textFile, dedupe_key: 'effect-board-applied' }));
  assert.equal(nativeRefused, true, 'native caller must be revalidated');
  assert.equal(seeded.status, 'sent', 'the seed announcement stays sent');
  assert.equal(patches, 1, 'one board PATCH');
  const rows = boardReceipts(f.state, 'effect-board-applied');
  assert.equal(rows.filter(row => row.kind === 'board-refresh-attempt').length, 1);
  const outcomes = rows.filter(row => row.kind === 'board-refresh-outcome');
  assert.equal(outcomes.length, 1, 'applied evidence is saved exactly once');
  assert.equal(outcomes[0].detail.outcome, 'applied');
  assert.equal(outcomes[0].detail.targetMessageId, '10001');
  assert.equal(outcomes[0].detail.observedContent, 'Updated board');
  assert.equal(outcomes[0].detail.revision, 1, 'the original revision identity is retained');
  const admission = f.state.inspectBoardRequest('effect-board-applied', { guildId: '100', channelId: '101', messageId: '10001' });
  assert.equal(admission.outcome, 'applied');
  assert.equal(admission.revision, 1);
});

test('unknown announcement retains outcome after caller changes', async t => {
  const f = fixture(t);
  const textFile = messageFile(t, f, 'effect-announce-unknown.txt');
  fs.writeFileSync(textFile, 'Announcement');
  let current = ORIGINAL;
  let posts = 0;
  let nonce = null;
  const networkError = new Error('simulated transport failure');
  const peer = service(f, { callerDependencies: identity(() => current), fetchImpl: async (url, options) => {
    posts += 1;
    nonce = JSON.parse(options.body).nonce;
    current = CHANGED;
    throw networkError;
  } });
  const nativeRefused = await nativeRefusal(peer.post({ role: 'announce', text_file: textFile, dedupe_key: 'effect-announce-unknown' }), networkError);
  assert.equal(nativeRefused, true, 'native caller must be revalidated');
  const rows = directPostRows(f.state, 'effect-announce-unknown');
  assert.equal(rows.attempts.length, 1, 'one claimed attempt');
  assert.equal(rows.outcomes.length, 1);
  assert.equal(rows.outcomes[0].detail.outcome, 'unknown', 'the unknown classification is retained');
  assert.equal(rows.outcomes[0].detail.nonce, nonce, 'the original nonce is retained');
  assert.equal(posts, 1, 'one POST');
});

test('duplicate announcement revalidates without network', async t => {
  const f = fixture(t);
  const textFile = messageFile(t, f, 'effect-announce-duplicate.txt');
  fs.writeFileSync(textFile, 'Announcement');
  let resolutions = 0;
  let switchAfterFirst = false;
  let posts = 0;
  let nonce = null;
  const peer = service(f, { callerDependencies: { resolveClaudeCaller: async () => {
    resolutions += 1;
    const sessionId = switchAfterFirst && resolutions > 1 ? CHANGED : ORIGINAL;
    return { harness: 'claude-code', sessionId };
  } }, fetchImpl: async (url, options) => {
    posts += 1;
    nonce = JSON.parse(options.body).nonce;
    return response({ id: '10001' });
  } });
  const first = await peer.post({ role: 'announce', text_file: textFile, dedupe_key: 'effect-announce-duplicate' });
  switchAfterFirst = true;
  resolutions = 0;
  const nativeRefused = await nativeRefusal(peer.post({ role: 'announce', text_file: textFile, dedupe_key: 'effect-announce-duplicate' }));
  assert.equal(nativeRefused, true, 'native caller must be revalidated');
  assert.equal(first.status, 'sent', 'the first publish stays sent');
  assert.equal(posts, 1, 'the duplicate issues no additional HTTP');
  const outcomes = directPostRows(f.state, 'effect-announce-duplicate').outcomes;
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].detail.outcome, 'sent');
  assert.equal(outcomes[0].detail.messageId, '10001');
  assert.equal(outcomes[0].detail.nonce, nonce, 'the original nonce is unchanged');
});

test('cancelled peer call starts no network or attempt', async t => {
  const f = fixture(t);
  f.enroll('102');
  addRecipient(f);
  let requests = 0;
  const peer = service(f, { fetchImpl: async () => {
    requests += 1;
    return response({ id: '10001' });
  } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(peer.send({ peer: { channelId: '201' }, text: 'hello', dedupe_key: 'effect-cancelled' }, controller.signal));
  assert.equal(requests, 0);
  assert.equal(f.state.directPostRows('effect-cancelled').length, 0);
});

test('unchanged caller publishes once and duplicate does not resend', async t => {
  const f = fixture(t);
  const textFile = messageFile(t, f, 'effect-announce-stable.txt');
  fs.writeFileSync(textFile, 'Announcement');
  let posts = 0;
  let nonce = null;
  const peer = service(f, { fetchImpl: async (url, options) => {
    posts += 1;
    nonce = JSON.parse(options.body).nonce;
    return response({ id: '10001' });
  } });
  const first = await peer.post({ role: 'announce', text_file: textFile, dedupe_key: 'effect-announce-stable' });
  const retry = await peer.post({ role: 'announce', text_file: textFile, dedupe_key: 'effect-announce-stable' });
  assert.equal(first.status, 'sent');
  assert.equal(retry.status, 'sent');
  assert.deepEqual(first.messageIds, ['10001']);
  assert.deepEqual(retry.messageIds, ['10001']);
  assert.equal(posts, 1, 'the duplicate does not resend');
  const rows = directPostRows(f.state, 'effect-announce-stable');
  assert.equal(rows.attempts.length, 1);
  assert.equal(rows.outcomes.length, 1);
  assert.equal(rows.outcomes[0].detail.outcome, 'sent');
  assert.equal(rows.outcomes[0].detail.messageId, '10001');
  assert.equal(rows.outcomes[0].detail.nonce, nonce, 'the nonce is unchanged');
});

test('binding generation changes independently after destination GET', async t => {
  const f = fixture(t);
  f.enroll('102');
  addRecipient(f);
  let current = ORIGINAL;
  let gets = 0;
  let nativeLookupsAfterGet = 0;
  let posts = 0;
  const oldGeneration = f.state.getBinding('101').generation;
  const peer = service(f, { callerDependencies: identity(() => {
    if (gets > 0) nativeLookupsAfterGet += 1;
    return current;
  }), fetchImpl: async (url, options) => {
    if (options.method === 'GET') {
      gets += 1;
      assert.match(url, /\/channels\/202$/);
      f.state.db.prepare("UPDATE bindings SET generation=? WHERE channel_id='101'").run(oldGeneration + 1);
      assert.equal(f.state.getBinding('101').generation, oldGeneration + 1, 'the binding generation advanced under the caller');
      return response({ id: '202', guild_id: '100' });
    }
    posts += 1;
    return response({ id: '10001' });
  } });
  const desired = async () => {
    const refused = await nativeRefusal(peer.send({ peer: { channelId: '201' }, text: 'hello', dedupe_key: 'effect-send-generation' }));
    assert.equal(refused, true, 'native caller must be revalidated');
    assert.ok(nativeLookupsAfterGet > 0, 'native caller is resolved after the destination GET');
    assert.equal(gets, 1, 'destination lookup runs once');
    assert.equal(posts, 0, 'no outbound post after the binding generation changed');
    assert.equal(directPostRows(f.state, 'effect-send-generation').attempts.length, 0, 'no direct-post attempt after the binding generation changed');
  };
  await desired();
});

test('multipart announcement revalidates after first part sent', async t => {
  const f = fixture(t);
  const textFile = messageFile(t, f, 'effect-announce-multipart.txt');
  const { REPLY_LIMIT, splitReply } = require('../src/state');
  const text = 'a'.repeat(REPLY_LIMIT * 2);
  fs.writeFileSync(textFile, text);
  const parts = splitReply(text);
  assert.ok(parts.length > 1, 'fixture text must split into multiple parts');
  let current = ORIGINAL;
  let posts = 0;
  let nonce = null;
  const peer = service(f, { callerDependencies: identity(() => current), fetchImpl: async (url, options) => {
    posts += 1;
    const body = JSON.parse(options.body);
    nonce = body.nonce;
    current = CHANGED;
    return response({ id: '10001', channel_id: '101', author: { id: 'bot', bot: true }, content: body.content });
  } });
  const refused = await nativeRefusal(peer.post({ role: 'announce', text_file: textFile, dedupe_key: 'effect-announce-multipart' }));
  assert.equal(refused, true, 'native caller must be revalidated');
  assert.equal(posts, 1, 'one POST total');
  const rows = directPostRows(f.state, 'effect-announce-multipart');
  assert.equal(rows.attempts.length, 1, 'one claimed part attempt is retained');
  assert.equal(rows.outcomes.length, 1, 'the sent part outcome is saved exactly once');
  assert.equal(rows.outcomes[0].detail.outcome, 'sent');
  assert.equal(rows.outcomes[0].detail.messageId, '10001');
  assert.equal(rows.outcomes[0].detail.nonce, nonce, 'the original nonce is retained');
});

test('abort while caller resolution is pending starts no network or attempt', { timeout: 5000 }, async t => {
  const f = fixture(t);
  f.enroll('102');
  addRecipient(f);
  let release;
  const pending = new Promise(r => { release = r; });
  let enteredResolve;
  const entered = new Promise(r => { enteredResolve = r; });
  let fetches = 0;
  const peer = service(f, { callerDependencies: { resolveClaudeCaller: async () => {
    enteredResolve();
    await pending;
    return { harness: 'claude-code', sessionId: ORIGINAL };
  } }, fetchImpl: async () => {
    fetches += 1;
    return response({ id: '10001' });
  } });
  const originalMkdtemp = fs.mkdtempSync;
  let stagedDirectories = 0;
  fs.mkdtempSync = function (prefix, ...args) {
    if (path.basename(String(prefix)).startsWith('discord-peer-')) stagedDirectories += 1;
    return originalMkdtemp.call(this, prefix, ...args);
  };
  t.after(() => { fs.mkdtempSync = originalMkdtemp; });
  const controller = new AbortController();
  const sending = peer.send({ peer: { channelId: '201' }, text: 'hello', dedupe_key: 'effect-abort-pending' }, controller.signal);
  t.after(() => release());
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('caller resolver was not entered')), 1000); });
  try {
    await Promise.race([entered, deadline]);
  } finally {
    clearTimeout(timer);
  }
  controller.abort();
  await assert.rejects(sending);
  assert.equal(fetches, 0);
  assert.equal(directPostRows(f.state, 'effect-abort-pending').attempts.length, 0);
  assert.equal(directPostRows(f.state, 'effect-abort-pending').outcomes.length, 0);
  assert.equal(stagedDirectories, 0, 'peer send never staged a message temp directory');
});
