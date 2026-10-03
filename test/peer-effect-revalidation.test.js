'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, service, addRecipient } = require('./fixtures/peer-fixture');

const ORIGINAL = '11111111-1111-1111-1111-111111111111';
const CHANGED = '99999999-9999-9999-9999-999999999999';
const FIXED = process.env.PEER_EFFECT_EXPECT_FIXED === '1';
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

function transitional(desired) {
  if (FIXED) return desired();
  return assert.rejects(desired(), error => {
    assert.equal(error.code, 'ERR_ASSERTION', 'refusal must be the declared assertion');
    assert.equal(error.operator, 'strictEqual', 'refusal assertion operator');
    assert.equal(error.actual, false, 'refusal assertion actual');
    assert.equal(error.expected, true, 'refusal assertion expected');
    assert.equal(String(error.message).split('\n')[0], 'native caller must be revalidated', 'refusal assertion message');
    return true;
  });
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
  const desired = async () => {
    const nativeRefused = await nativeRefusal(peer.send({ peer: { channelId: '201' }, text: 'hello', dedupe_key: 'effect-send-get' }));
    assert.equal(nativeRefused, true, 'native caller must be revalidated');
    assert.equal(gets, 1, 'destination lookup runs once');
    assert.equal(posts, 0, 'no outbound post after the caller changed');
    assert.equal(directPostRows(f.state, 'effect-send-get').attempts.length, 0, 'no direct-post attempt after the caller changed');
  };
  await transitional(desired);
});

test('board refuses after installation lookup', async t => {
  await transitional(boardBoundary(t, 1, 'effect-board-installation', 'effect-board-installation-seed'));
});

test('board refuses after channel lookup', async t => {
  await transitional(boardBoundary(t, 2, 'effect-board-channel', 'effect-board-channel-seed'));
});

test('board refuses after target lookup', async t => {
  await transitional(boardBoundary(t, 3, 'effect-board-target', 'effect-board-target-seed'));
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
  const desired = async () => {
    const nativeRefused = await nativeRefusal(peer.post({ role: 'announce', text_file: textFile, dedupe_key: 'effect-announce-claim' }));
    assert.equal(nativeRefused, true, 'native caller must be revalidated');
    const rows = directPostRows(f.state, 'effect-announce-claim');
    assert.equal(rows.attempts.length, 1, 'the admitted attempt is retained');
    assert.equal(rows.outcomes.length, 1, 'a single known-unsent outcome is recorded');
    assert.equal(rows.outcomes[0].detail.outcome, 'stale');
    assert.equal(rows.outcomes[0].detail.nonce, rows.attempts[0].detail.nonce, 'the original nonce is retained');
    assert.equal(posts, 0, 'no outbound post after the caller changed');
  };
  await transitional(desired);
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
  const desired = async () => {
    const nativeRefused = await nativeRefusal(peer.post({ role: 'announce', text_file: textFile, dedupe_key: 'effect-announce-sent' }));
    assert.equal(nativeRefused, true, 'native caller must be revalidated');
    const rows = directPostRows(f.state, 'effect-announce-sent');
    assert.equal(rows.attempts.length, 1, 'one claimed attempt');
    assert.equal(rows.outcomes.length, 1, 'sent evidence is saved exactly once');
    assert.equal(rows.outcomes[0].detail.outcome, 'sent');
    assert.equal(rows.outcomes[0].detail.messageId, '10001');
    assert.equal(rows.outcomes[0].detail.nonce, nonce, 'the original nonce is retained');
    assert.equal(posts, 1, 'no retry after the caller changed');
  };
  await transitional(desired);
});

test('board retains applied evidence after caller changes', async t => {
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
  const desired = async () => {
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
  };
  await transitional(desired);
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
  const desired = async () => {
    const nativeRefused = await nativeRefusal(peer.post({ role: 'announce', text_file: textFile, dedupe_key: 'effect-announce-unknown' }), networkError);
    assert.equal(nativeRefused, true, 'native caller must be revalidated');
    const rows = directPostRows(f.state, 'effect-announce-unknown');
    assert.equal(rows.attempts.length, 1, 'one claimed attempt');
    assert.equal(rows.outcomes.length, 1);
    assert.equal(rows.outcomes[0].detail.outcome, 'unknown', 'the unknown classification is retained');
    assert.equal(rows.outcomes[0].detail.nonce, nonce, 'the original nonce is retained');
    assert.equal(posts, 1, 'one POST');
  };
  await transitional(desired);
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
  const desired = async () => {
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
  };
  await transitional(desired);
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
