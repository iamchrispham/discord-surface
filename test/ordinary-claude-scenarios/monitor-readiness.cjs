const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { ClaudeChannel } = require('../../src/claude-channel');
const { DiscordGateway } = require('../../src/discord');
const { probeClaudeChannel, probeUnixSocket } = require('../../src/native');
const { MESSAGE_STATES, READINESS } = require('../../src/state');
const { CLAUDE, fixture } = require('./fixture.cjs');

test('ordinary Claude Monitor readiness is unavailable without a live socket and holds intake', async t => {
  const f = fixture(t);
  const channel = {
    id: f.binding.channelId,
    guildId: 'guild',
    permissionsFor: () => ({ has: () => true })
  };
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, channels: { fetch: async () => channel }, on() {}, off() {}, async destroy() {} },
    fetchHistory: async () => [],
    providers: { claude: { async dispatch() { throw new Error('must stay held'); } } }
  });
  gateway.historyPermission = () => ({ known: true, allowed: true });
  const recovery = await gateway.recoverTransport('monitor-unavailable', 0);
  assert.equal(recovery.ready, false);
  assert.equal(f.state.getBinding(f.binding.channelId).readiness, READINESS.UNAVAILABLE);
  const accepted = f.state.acceptDiscordMessage({
    id: '900001', guildId: 'guild', channelId: f.binding.channelId,
    authorId: 'operator', isBot: false, content: 'hold this'
  }, { ready: false });
  assert.equal(accepted.accepted, true);
  assert.equal(f.state.claimDispatch(accepted.message.id).reason, 'binding-not-ready');
  assert.equal(f.state.getMessage(accepted.message.id).state, MESSAGE_STATES.ACCEPTED);
  await assert.rejects(() => probeUnixSocket(f.socketPath), /connect|socket|ENOENT|refused/i);
  await gateway.stop();
});

test('ordinary Claude preflight rejects an unrelated accepting listener', async t => {
  const f = fixture(t, { preflight: false });
  const listener = http.createServer((_request, response) => {
    response.writeHead(202);
    response.end('accepted');
  });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(f.socketPath, resolve);
  });
  t.after(() => listener.close());
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, on() {}, off() {}, async destroy() {} },
    providers: { claude: { async dispatch() { throw new Error('must not dispatch'); } } }
  });
  await assert.rejects(() => gateway.verifyOrdinaryNative(f.binding), /identity|status|Claude channel/);
  assert.equal(f.state.hasOrdinaryPreflight(f.binding), false);
  await gateway.stop();
});

test('Claude identity probe enforces an absolute deadline despite response progress', async t => {
  const f = fixture(t, { preflight: false });
  const listener = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    let writes = 0;
    const interval = setInterval(() => {
      response.write(' ');
      writes += 1;
      if (writes >= 20) {
        clearInterval(interval);
        response.end();
      }
    }, 10);
    _request.on('close', () => clearInterval(interval));
  });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(f.socketPath, resolve);
  });
  t.after(() => listener.close());
  const startedAt = Date.now();
  await assert.rejects(() => probeClaudeChannel(f.socketPath, {
    nativeId: CLAUDE, generation: f.binding.generation, workspace: f.dir, endpoint: f.socketPath
  }, { timeoutMs: 30 }), /timed out/);
  assert.ok(Date.now() - startedAt < 120, 'probe deadline must be absolute, not inactivity based');
});

test('Claude identity probe settles success, no-response, and transport-error paths', async t => {
  const f = fixture(t, { preflight: false });
  const expected = { nativeId: CLAUDE, generation: f.binding.generation, workspace: f.dir, endpoint: f.socketPath };
  const successListener = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ provider: 'claude', ...expected, channelReady: true }));
  });
  await new Promise((resolve, reject) => {
    successListener.once('error', reject);
    successListener.listen(f.socketPath, resolve);
  });
  const proof = await probeClaudeChannel(f.socketPath, expected, { timeoutMs: 100 });
  assert.equal(proof.channelReady, true);
  assert.equal(proof.listenerInstanceId, undefined);
  await new Promise((resolve, reject) => successListener.close(error => error ? reject(error) : resolve()));

  const noResponseListener = http.createServer(() => {});
  await new Promise((resolve, reject) => {
    noResponseListener.once('error', reject);
    noResponseListener.listen(f.socketPath, resolve);
  });
  await assert.rejects(() => probeClaudeChannel(f.socketPath, expected, { timeoutMs: 30 }), /timed out/);
  await new Promise((resolve, reject) => noResponseListener.close(error => error ? reject(error) : resolve()));

  await assert.rejects(() => probeClaudeChannel(f.socketPath, expected, { timeoutMs: 100 }), /ENOENT|connect|socket/i);
});

test('Claude channel identity reports a distinct listener instance across stop and restart', async t => {
  const f = fixture(t);
  const channel = new ClaudeChannel({
    state: f.state, nativeId: CLAUDE, socketPath: f.socketPath, mcp: { notification: async () => {} }
  });
  t.after(async () => { try { await channel.stop(); } catch {} });
  const expected = { nativeId: CLAUDE, generation: f.binding.generation, workspace: f.dir, endpoint: f.socketPath };
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  await channel.start();
  const first = await probeClaudeChannel(f.socketPath, expected, { timeoutMs: 100 });
  const repeated = await probeClaudeChannel(f.socketPath, expected, { timeoutMs: 100 });
  assert.match(first.listenerInstanceId, uuidV4);
  assert.equal(repeated.listenerInstanceId, first.listenerInstanceId);
  await channel.stop();
  await channel.start();
  const restarted = await probeClaudeChannel(f.socketPath, expected, { timeoutMs: 100 });
  assert.match(restarted.listenerInstanceId, uuidV4);
  assert.notEqual(restarted.listenerInstanceId, first.listenerInstanceId);
  await channel.stop();
});
