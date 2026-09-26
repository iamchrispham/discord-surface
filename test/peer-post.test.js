const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./fixtures/peer-fixture');
const { READINESS } = require('../src/state');
const { createPeerService } = require('../src/peer/service');
const id = '11111111-1111-1111-1111-111111111111';
const response = body => ({ ok: true, status: 200, json: async () => body });
const identity = { resolveClaudeCaller: async () => ({ harness: 'claude-code', sessionId: id }) };

test('announcement creates parent custody and board role edits that exact message', async t => {
  const f = fixture(t); let posts = 0; let patches = 0; let content = '';
  const textFile = path.join(path.dirname(f.state.requireConfig().secretFile), 'text.txt');
  fs.writeFileSync(textFile, 'Initial board');
  const peer = createPeerService({ state: f.state, provider: 'claude', token: 'fixture', callerDependencies: identity,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/users/@me')) return response({ id: 'bot' });
      if (options.method === 'GET' && url.endsWith('/channels/101')) return response({ id: '101', guild_id: '100' });
      if (options.method === 'POST') {
        assert.match(url, /channels\/101\/messages$/); posts++;
        content = JSON.parse(options.body).content;
      } else if (options.method === 'PATCH') {
        assert.match(url, /channels\/101\/messages\/10001$/); patches++;
        content = JSON.parse(options.body).content;
      }
      return response({ id: '10001', channel_id: '101', author: { id: 'bot', bot: true }, content });
    } });
  assert.equal((await peer.post({ role: 'announce', text_file: textFile, dedupe_key: 'announce-fixture' })).status, 'sent');
  fs.writeFileSync(textFile, 'Updated board');
  assert.equal((await peer.post({ role: 'board', message_id: '10001', text_file: textFile, dedupe_key: 'board-fixture' })).status, 'applied');
  assert.equal(posts, 1); assert.equal(patches, 1); assert.equal(content, 'Updated board');
});

test('announcement refuses a readiness transition before custody', async t => {
  const f = fixture(t); let posts = 0; let checks = 0;
  const originalCurrent = f.state.directPostBindingCurrent.bind(f.state);
  f.state.directPostBindingCurrent = (...args) => {
    const current = originalCurrent(...args);
    if (++checks === 1) f.state.setBindingReadiness('101', READINESS.GAP, 'fixture gap', f.state.getBinding('101'));
    return current;
  };
  const textFile = path.join(path.dirname(f.state.requireConfig().secretFile), 'text.txt');
  fs.writeFileSync(textFile, 'Announcement');
  const peer = createPeerService({ state: f.state, provider: 'claude', token: 'fixture', callerDependencies: identity,
    fetchImpl: async () => { posts++; return response({ id: '10001' }); } });
  const result = await peer.post({ role: 'announce', text_file: textFile, dedupe_key: 'announce-gap' });
  assert.equal(result.status, 'stale');
  assert.equal(posts, 0);
  assert.equal(f.state.directPostRows('announce-gap').filter(row => row.kind === 'direct-post-attempt').length, 0);
});

test('board role refuses a readiness transition before admission', async t => {
  const f = fixture(t); let patches = 0; let boardFetch = false; let content = '';
  const textFile = path.join(path.dirname(f.state.requireConfig().secretFile), 'text.txt');
  fs.writeFileSync(textFile, 'Initial board');
  const peer = createPeerService({ state: f.state, provider: 'claude', token: 'fixture', callerDependencies: identity,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/users/@me')) return response({ id: 'bot' });
      if (options.method === 'POST') {
        content = JSON.parse(options.body).content;
        return response({ id: '10001', channel_id: '101', author: { id: 'bot', bot: true }, content });
      }
      if (options.method === 'GET' && url.endsWith('/channels/101')) {
        if (boardFetch) f.state.setBindingReadiness('101', READINESS.GAP, 'fixture gap', f.state.getBinding('101'));
        return response({ id: '101', guild_id: '100' });
      }
      if (options.method === 'GET') return response({ id: '10001', channel_id: '101', author: { id: 'bot', bot: true }, content });
      if (options.method === 'PATCH') { patches++; return response({ id: '10001', channel_id: '101', author: { id: 'bot', bot: true }, content }); }
      throw new Error(`unexpected request ${options.method}`);
    } });
  assert.equal((await peer.post({ role: 'announce', text_file: textFile, dedupe_key: 'announce-board' })).status, 'sent');
  f.state.setBindingReadiness('101', READINESS.READY, 'fixture ready', f.state.getBinding('101'));
  boardFetch = true;
  fs.writeFileSync(textFile, 'Updated board');
  const result = await peer.post({ role: 'board', message_id: '10001', text_file: textFile, dedupe_key: 'board-gap' });
  assert.equal(result.status, 'stale');
  assert.equal(patches, 0);
});

test('child role cannot fall through to an unaddressed human post', async t => {
  const f = fixture(t);
  const peer = createPeerService({ state: f.state, provider: 'claude', token: 'fixture', callerDependencies: identity,
    fetchImpl: async () => { assert.fail('invalid role reached transport'); } });
  const before = f.state.listReceipts().length;
  await assert.rejects(peer.post({ role: 'child', text_file: '/unused', dedupe_key: 'child-fixture' }), /exactly one of peer/);
  await assert.rejects(peer.post({ role: 'board', text_file: '/unused', dedupe_key: 'board-fixture' }), /invalid board/);
  await assert.rejects(peer.post({ role: 'announce', text_file: '/unused', dedupe_key: 'announce-fixture', channel_id: 'other' }), /invalid announce/);
  assert.equal(f.state.listReceipts().length, before);
});
