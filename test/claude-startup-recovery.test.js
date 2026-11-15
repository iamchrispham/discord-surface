'use strict';

const {
  test, assert, fs, http, path, ClaudeChannel, fixture, CLAUDE_ID,
  socketPath, removeSocketDirectory, closeListeningServer, requestOverSocket, waitForCondition
} = require('./claude-socket-recovery-fixture');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

function scheduler() {
  const pending = [];
  return {
    setTimeout(callback) {
      pending.push(callback);
      return callback;
    },
    clearTimeout(callback) {
      const index = pending.indexOf(callback);
      if (index >= 0) pending.splice(index, 1);
    },
    get pending() { return pending.length; },
    release() { pending.shift()?.(); }
  };
}

function bindFixture(t) {
  const socket = socketPath(t, { cleanup: false });
  const { dir, state } = fixture();
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket }, { intakeCutoff: '100' });
  t.after(() => state.close());
  t.after(() => {
    removeSocketDirectory(socket);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { socket, dir, state };
}

function quietMcp() {
  return { notification: async () => {}, close: async () => {} };
}

test('public start attaches after a same-process incumbent releases its listener', { timeout: 8000 }, async t => {
  const f = bindFixture(t);
  const incumbent = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  await incumbent.start();
  const waitScheduler = scheduler();
  let connected = false;
  const waiter = new ClaudeChannel({
    state: f.state,
    nativeId: CLAUDE_ID,
    socketPath: f.socket,
    startupScheduler: waitScheduler,
    mcp: {
      notification: async () => {},
      transportFactory: () => ({}),
      connect: async () => { connected = true; }
    }
  });
  t.after(async () => {
    await waiter.stop().catch(() => {});
    await incumbent.stop().catch(() => {});
  });
  const starting = waiter.start();
  await waitForCondition(() => connected && waitScheduler.pending > 0, 'waiter must connect MCP and pin the incumbent');
  assert.equal(incumbent.ready, true);
  assert.equal(waiter.ready, false);
  assert.equal((await requestOverSocket(f.socket)).statusCode, 200);
  await incumbent.stop();
  waitScheduler.release();
  await starting;
  assert.equal(waiter.ready, true);
  assert.equal((await requestOverSocket(f.socket)).statusCode, 200);
});

test('concurrent resumed starts yield one listener after incumbent release', { timeout: 8000 }, async t => {
  const f = bindFixture(t);
  const incumbent = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  await incumbent.start();
  const waiters = [0, 1].map(() => new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() }));
  t.after(async () => {
    for (const waiter of waiters) await waiter.stop().catch(() => {});
    await incumbent.stop().catch(() => {});
  });
  const starts = waiters.map(waiter => waiter.start().then(() => ({ ok: true }), error => ({ ok: false, error })));
  await new Promise(resolve => setTimeout(resolve, 10));
  await incumbent.stop();
  const results = await Promise.all(starts);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(waiters.filter(waiter => waiter.ready).length, 1);
  assert.equal((await requestOverSocket(f.socket)).statusCode, 200);
});

test('replacement during vacancy is refused and preserved', { timeout: 8000 }, async t => {
  const f = bindFixture(t);
  const incumbent = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  await incumbent.start();
  const waitScheduler = scheduler();
  const waiter = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, startupScheduler: waitScheduler, mcp: quietMcp() });
  const starting = waiter.start();
  await waitForCondition(() => waitScheduler.pending > 0, 'waiter must pin the incumbent');
  await incumbent.stop();
  const replacement = http.createServer((request, response) => {
    if (request.url === '/identity') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ provider: 'claude', nativeId: CLAUDE_ID, generation: 1, endpoint: f.socket, workspace: f.dir, channelReady: true, listenerInstanceId: '11111111-1111-4111-8111-111111111111' }));
      return;
    }
    response.writeHead(200);
    response.end('replacement');
  });
  t.after(async () => {
    await waiter.stop().catch(() => {});
    await closeListeningServer(replacement);
  });
  await new Promise((resolve, reject) => { replacement.once('error', reject); replacement.listen(f.socket, resolve); });
  waitScheduler.release();
  await assert.rejects(starting, /replaced|changed during startup recovery/);
  assert.equal((await requestOverSocket(f.socket, { requestPath: '/other' })).body, 'replacement');
});

test('binding handoff cancels the waiter before a new bind', { timeout: 8000 }, async t => {
  const f = bindFixture(t);
  const incumbent = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  await incumbent.start();
  const waitScheduler = scheduler();
  const waiter = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, startupScheduler: waitScheduler, mcp: quietMcp() });
  const starting = waiter.start();
  await waitForCondition(() => waitScheduler.pending > 0, 'waiter must pin the incumbent');
  const current = f.state.getBinding('claude');
  f.state.rebind({ ...current, generation: undefined });
  waitScheduler.release();
  await assert.rejects(starting, /binding changed during startup recovery/);
  assert.equal(waiter.ready, false);
  assert.equal(incumbent.ready, true);
  await incumbent.stop();
});

test('SDK initialization completes while waiting and close cancels startup', { timeout: 8000 }, async t => {
  const f = bindFixture(t);
  const incumbent = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  await incumbent.start();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Server({ name: 'startup-recovery-test', version: '1.0.0' });
  mcp.transportFactory = () => serverTransport;
  const client = new Client({ name: 'startup-recovery-client', version: '1.0.0' });
  const clientStarting = client.connect(clientTransport);
  const waitScheduler = scheduler();
  const waiter = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, startupScheduler: waitScheduler, mcp });
  t.after(async () => {
    await client.close().catch(() => {});
    await waiter.stop().catch(() => {});
    await incumbent.stop().catch(() => {});
  });
  const channelStarting = waiter.start();
  await clientStarting;
  await waitForCondition(() => waitScheduler.pending > 0, 'SDK-connected waiter must be waiting on the incumbent');
  assert.equal(waiter.ready, false);
  assert.equal(incumbent.ready, true);
  await incumbent.stop();
  waitScheduler.release();
  await channelStarting;
  assert.equal(waiter.ready, true);
  await waiter.stop();
});

