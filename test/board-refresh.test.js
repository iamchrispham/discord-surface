const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { SurfaceState, BOARD_OUTCOMES, READINESS } = require('../src/state');
const { runBoardRefresh } = require('../src/board-refresh');

const NATIVE_ID = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const SUCCESSOR_ID = '7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-board-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator-1', guildId: 'guild-1', secretFile: path.join(dir, 'discord.secret') });
  const binding = state.bind({
    channelId: 'channel-1', guildId: 'guild-1', provider: 'codex', nativeId: NATIVE_ID,
    workspace: dir, conductorId: 'conductor-1', repoKey: 'repo:discord-surface'
  });
  state.receipt(null, 'direct-post-outcome', {
    journal: 'direct-post-v1', requestId: 'seed-post', attemptId: 'seed-attempt', outcome: 'sent', messageId: 'target-1',
    channelId: 'channel-1', guildId: 'guild-1', provider: 'codex', nativeId: NATIVE_ID, generation: binding.generation
  });
  const textFile = path.join(dir, 'board.txt');
  return { dir, state, binding, textFile };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, body: { cancel() {} } };
}

function fakeFetch(board, calls) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/users/@me')) return response({ id: 'bot-1' });
    if (init.method === 'GET') return response({ id: 'target-1', guild_id: 'guild-1', channel_id: 'channel-1', author: { id: 'bot-1', bot: true }, content: board.content });
    if (init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      board.content = body.content;
      return response({ id: 'target-1', guild_id: 'guild-1', channel_id: 'channel-1', author: { id: 'bot-1', bot: true }, content: board.content });
    }
    throw new Error(`unexpected board request ${init.method} ${url}`);
  };
}

function resolver(state, input) {
  const binding = state.getBinding(input.channelId);
  assert.ok(binding);
  assert.equal(binding.nativeId, input.nativeId);
  assert.equal(binding.generation, input.generation);
  return binding;
}

async function refresh(f, content, requestId, fetchImpl, options = {}) {
  fs.writeFileSync(f.textFile, content);
  return runBoardRefresh({
    state: f.state,
    token: 'fixture-token',
    nativeId: options.nativeId || f.state.getBinding('channel-1').nativeId,
    generation: options.generation || f.state.getBinding('channel-1').generation,
    channelId: 'channel-1',
    messageId: 'target-1',
    textFile: f.textFile,
    dedupeKey: requestId,
    fetchImpl,
    timeoutMs: options.timeoutMs || 1000,
    resolveBinding: resolver
  });
}

test('board refresh patches one proven target with mention suppression and no POST', async t => {
  const f = fixture();
  t.after(() => f.state.close());
  const calls = [];
  const board = { content: 'old board' };
  const result = await refresh(f, 'new board', 'refresh-1', fakeFetch(board, calls));
  assert.equal(result.status, BOARD_OUTCOMES.APPLIED);
  const patches = calls.filter(call => call.init.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].url, 'https://discord.com/api/v10/channels/channel-1/messages/target-1');
  assert.deepEqual(JSON.parse(patches[0].init.body), { content: 'new board', allowed_mentions: { parse: [] } });
  assert.equal(calls.some(call => call.init.method === 'POST'), false);
  assert.equal(f.state.listReceipts().filter(row => row.kind === 'board-designation').length, 1);
  assert.equal(JSON.parse(f.state.listReceipts().filter(row => row.kind === 'board-refresh-outcome').at(-1).detail).outcome, BOARD_OUTCOMES.APPLIED);
});

test('already desired board is an honest no-op and target qualification rejects wrong authors', async t => {
  const f = fixture();
  t.after(() => f.state.close());
  const board = { content: 'same board' };
  const sameCalls = [];
  const same = await refresh(f, 'same board', 'refresh-noop', fakeFetch(board, sameCalls));
  assert.equal(same.status, BOARD_OUTCOMES.NO_OP);
  assert.equal(sameCalls.filter(call => call.init.method === 'PATCH').length, 0);

  const wrongCalls = [];
  const wrongFetch = async (url, init = {}) => {
    wrongCalls.push({ url, init });
    if (url.endsWith('/users/@me')) return response({ id: 'bot-1' });
    return response({ id: 'target-1', guild_id: 'guild-1', channel_id: 'channel-1', author: { id: 'other-bot', bot: true }, content: 'same board' });
  };
  await assert.rejects(() => refresh(f, 'other board', 'refresh-wrong-author', wrongFetch), /not authored by this Discord installation/);
  assert.equal(wrongCalls.filter(call => call.init.method === 'PATCH').length, 0);
});

test('late PATCH stays fenced across handoff, ordinary readiness, and successor refresh', async t => {
  const f = fixture();
  t.after(() => f.state.close());
  const board = { content: 'initial board', lateApplied: false, managedPatchCount: 0 };
  const server = http.createServer((request, reply) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && requestUrl.pathname === '/api/v10/users/@me') {
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.end(JSON.stringify({ id: 'bot-1' }));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname.endsWith('/messages/target-1')) {
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.end(JSON.stringify({ id: 'target-1', guild_id: 'guild-1', channel_id: 'channel-1', author: { id: 'bot-1', bot: true }, content: board.content }));
      return;
    }
    if (request.method === 'PATCH' && requestUrl.pathname.endsWith('/messages/target-1')) {
      if (request.headers.authorization) board.managedPatchCount += 1;
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const payload = JSON.parse(body);
        const delay = payload.content === 'control revision' ? 0 : 60;
        setTimeout(() => {
          board.content = payload.content;
          board.lateApplied = true;
          if (!reply.destroyed) {
            reply.writeHead(200, { 'content-type': 'application/json' });
            reply.end(JSON.stringify({ id: 'target-1', guild_id: 'guild-1', channel_id: 'channel-1', author: { id: 'bot-1', bot: true }, content: board.content }));
          }
        }, delay).unref();
      });
      return;
    }
    reply.writeHead(404);
    reply.end();
  });
  server.unref();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const fetchImpl = (url, init) => {
    const source = new URL(url);
    return fetch(`http://127.0.0.1:${address.port}${source.pathname}`, init);
  };

  const first = await refresh(f, 'old revision', 'refresh-old', fetchImpl, { timeoutMs: 10 });
  assert.equal(first.status, BOARD_OUTCOMES.UNKNOWN);

  // Negative control: a writer that bypasses admission can be overwritten by the delayed predecessor.
  const control = await fetchImpl('https://discord.com/api/v10/channels/channel-1/messages/target-1', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'control revision', allowed_mentions: { parse: [] } })
  });
  assert.equal(control.ok, true);
  assert.equal(board.content, 'control revision');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(board.lateApplied, true);
  assert.equal(board.content, 'old revision');

  const old = f.state.getBinding('channel-1');
  const successor = f.state.handoffConductor({
    channelId: old.channelId, provider: old.provider, conductorId: old.conductorId, repoKey: old.repoKey,
    fromNativeId: old.nativeId, fromGeneration: old.generation, nativeId: SUCCESSOR_ID,
    workspace: old.workspace, endpoint: old.endpoint, handoffId: 'board-handoff-1'
  });
  assert.equal(successor.generation, 2);
  assert.equal(f.state.setBindingReadiness('channel-1', READINESS.READY, 'board fence is cosmetic', successor).readiness, READINESS.READY);
  const blocked = await refresh(f, 'successor revision', 'refresh-successor-blocked', fetchImpl, { nativeId: SUCCESSOR_ID, generation: 2 });
  assert.equal(blocked.status, BOARD_OUTCOMES.UNKNOWN);
  assert.equal(board.managedPatchCount, 1);

  const oldOutcome = f.state.listReceipts().filter(row => row.kind === 'board-refresh-outcome' && JSON.parse(row.detail).requestId === 'refresh-old').at(-1);
  const oldDetail = JSON.parse(oldOutcome.detail);
  f.state.reconcileBoardRefresh({ guildId: 'guild-1', channelId: 'channel-1', messageId: 'target-1' }, oldDetail.attemptId, BOARD_OUTCOMES.APPLIED, {
    evidenceScope: 'local controllable server readback',
    observedAt: new Date(Date.now() + 1000).toISOString(),
    readbackContent: 'old revision',
    soleWriter: true,
    singleAttempt: true,
    noHiddenRetry: true
  });
  board.content = 'old revision';
  const refreshed = await refresh(f, 'successor revision', 'refresh-successor', fetchImpl, { nativeId: SUCCESSOR_ID, generation: 2 });
  assert.equal(refreshed.status, BOARD_OUTCOMES.APPLIED);
  assert.equal(board.managedPatchCount, 2);
  const historicalRetry = await refresh(f, 'old revision', 'refresh-old', fetchImpl, { nativeId: old.nativeId, generation: old.generation });
  assert.equal(historicalRetry.status, BOARD_OUTCOMES.APPLIED);
  assert.equal(historicalRetry.historical, true);
  assert.equal(board.managedPatchCount, 2);
  const duplicateOld = f.state.recordBoardRefreshOutcome({ guildId: 'guild-1', channelId: 'channel-1', messageId: 'target-1' }, oldDetail.attemptId, BOARD_OUTCOMES.APPLIED, { duplicate: true });
  assert.equal(duplicateOld.historical, true);
  const latest = f.state.listReceipts().filter(row => row.kind === 'board-refresh-outcome').at(-1);
  assert.equal(JSON.parse(latest.detail).requestId, 'refresh-successor');
});
