'use strict';

const {
  test, assert, fs, http, path, spawn, once, EventEmitter, ClaudeChannel, SurfaceState, fixture, CLAUDE_ID,
  socketOwnership,
  SUITE_HOME_ROOT, SUITE_SHARED_TEMP_ROOT,
  socketPath, removeSocketDirectory, closeListeningServer, requestOverSocket, waitForCondition
} = require('./claude-socket-recovery-fixture');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { PassThrough } = require('node:stream');
const { createClaudeMonitor } = require('../src/claude-monitor');
const { createDefaultMcp } = require('../src/claude-channel');
const createClaudeListeners = require('../src/cli/claude-listeners');
const claudeIdentity = require('../dist/native/claude-identity');
const { MESSAGE_STATES, READINESS } = require('../src/state');

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
  const { dir, db, state } = fixture();
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket }, { intakeCutoff: '100' });
  t.after(() => state.close());
  t.after(() => {
    removeSocketDirectory(socket);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { socket, dir, db, state };
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

test('initial socket replacement during pin is refused before ordinary preparation', { timeout: 8000 }, async t => {
  const f = bindFixture(t);
  const incumbent = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  await incumbent.start();
  const originalLstat = fs.lstatSync;
  let socketReads = 0;
  let injectReplacement = true;
  t.mock.method(fs, 'lstatSync', (candidate, options) => {
    const observed = originalLstat(candidate, options);
    if (!injectReplacement || candidate !== f.socket || !observed.isSocket()) return observed;
    socketReads += 1;
    if (socketReads !== 2) return observed;
    const replacement = Object.create(Object.getPrototypeOf(observed));
    Object.assign(replacement, observed, { ino: observed.ino + 1n });
    return replacement;
  });
  const waiter = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  t.after(async () => {
    injectReplacement = false;
    await waiter.stop().catch(() => {});
    await incumbent.stop().catch(() => {});
  });
  await assert.rejects(waiter.start(), /incumbent socket was replaced during startup recovery/);
  assert.equal(incumbent.ready, true);
  assert.equal((await requestOverSocket(f.socket)).statusCode, 200);
});

test('public start proceeds when the incumbent releases socket and lock after serving identity', { timeout: 8000 }, async t => {
  const f = bindFixture(t);
  const incumbent = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  await incumbent.start();
  const originalProbe = claudeIdentity.probeClaudeChannel;
  let incumbentStopped = false;
  t.mock.method(claudeIdentity, 'probeClaudeChannel', async (...args) => {
    const identity = await originalProbe(...args);
    await incumbent.stop();
    incumbentStopped = true;
    return identity;
  });
  const waiter = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  t.after(async () => {
    await waiter.stop().catch(() => {});
    await incumbent.stop().catch(() => {});
  });

  await waiter.start();

  assert.equal(incumbentStopped, true);
  assert.equal(waiter.ready, true);
  assert.equal((await requestOverSocket(f.socket)).statusCode, 200);
});

test('public start reclaims a dead incumbent socket without a second start call', { timeout: 10000 }, async t => {
  const f = bindFixture(t);
  f.state.close();
  const childScript = `
    const fs = require('node:fs');
    const os = require('node:os');
    const [channelPath, statePath, dbPath, nativeId, socketPath, workspace, homeRoot, tempRoot] = process.argv.slice(1);
    const deadline = setTimeout(() => process.exit(124), 5000);
    deadline.unref();
    const originalUserInfo = os.userInfo;
    os.userInfo = () => ({ ...originalUserInfo(), homedir: homeRoot });
    const originalRealpath = fs.realpathSync;
    fs.realpathSync = (target, ...args) => String(target) === '/tmp' ? tempRoot : originalRealpath(target, ...args);
    const { ClaudeChannel } = require(channelPath);
    const { SurfaceState } = require(statePath);
    const state = new SurfaceState(dbPath);
    const channel = new ClaudeChannel({ state, nativeId, socketPath, mcp: { notification: async () => {} } });
    channel.start().then(() => {
      process.stdout.write('ready');
      process.stdin.resume();
      process.stdin.once('end', () => process.exit(0));
    }).catch(error => {
      process.stderr.write(String(error));
      process.exit(1);
    });
  `;
  const child = spawn(process.execPath, ['-e', childScript, path.resolve('src/claude-channel.js'), path.resolve('src/state.js'), f.db, CLAUDE_ID, f.socket, f.dir, SUITE_HOME_ROOT, SUITE_SHARED_TEMP_ROOT], { stdio: ['pipe', 'pipe', 'pipe'] });
  const childErrors = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => childErrors.push(chunk));
  const childExit = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    await childExit.catch(() => {});
  });
  await Promise.race([
    once(child.stdout, 'data'),
    childExit.then(([code, signal]) => { throw new Error(`holder exited before ready (${code}, ${signal}): ${childErrors.join('')}`); })
  ]);
  const resumedState = new SurfaceState(f.db);
  const waitScheduler = scheduler();
  const waiter = new ClaudeChannel({ state: resumedState, nativeId: CLAUDE_ID, socketPath: f.socket, startupScheduler: waitScheduler, mcp: quietMcp() });
  const starting = waiter.start();
  await waitForCondition(() => waitScheduler.pending > 0, 'waiter must pin the live child incumbent');
  child.stdin.end();
  const [code, signal] = await childExit;
  assert.equal(code, 0);
  assert.equal(signal, null);
  waitScheduler.release();
  await starting;
  assert.equal(waiter.ready, true);
  await waiter.stop();
  resumedState.close();
  assert.equal(fs.existsSync(f.socket), false);
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

test('expected incumbent shutdown response keeps the waiter cancellably waiting', { timeout: 8000 }, async t => {
  const f = bindFixture(t);
  const incumbent = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  await incumbent.start();
  const waitScheduler = scheduler();
  const waiter = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, startupScheduler: waitScheduler, mcp: quietMcp() });
  t.after(async () => {
    await waiter.stop().catch(() => {});
    await incumbent.stop().catch(() => {});
  });
  const starting = waiter.start();
  await waitForCondition(() => waitScheduler.pending > 0, 'waiter must pin the incumbent');
  incumbent.ready = false;
  waitScheduler.release();
  await waitForCondition(() => waitScheduler.pending > 0, '503 identity response must preserve the wait');
  assert.equal(waiter.ready, false);
  await waiter.stop();
  await assert.rejects(starting, /stopped during incumbent wait/);
  assert.equal(incumbent.ready, false);
});

test('confirmed foreign identity failure refuses the pinned wait', { timeout: 8000 }, async t => {
  const f = bindFixture(t);
  const incumbent = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  await incumbent.start();
  const waitScheduler = scheduler();
  const waiter = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, startupScheduler: waitScheduler, mcp: quietMcp() });
  t.after(async () => {
    await waiter.stop().catch(() => {});
    await incumbent.stop().catch(() => {});
  });
  const starting = waiter.start();
  await waitForCondition(() => waitScheduler.pending > 0, 'waiter must pin the incumbent');
  incumbent.bindingIdentity.nativeId = '7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b';
  waitScheduler.release();
  await assert.rejects(starting, /identity endpoint returned HTTP 409/);
  assert.equal(waiter.ready, false);
  assert.equal((await requestOverSocket(f.socket)).statusCode, 409);
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

test('SDK transport closes when a successor wins during acquisition', { timeout: 8000 }, async t => {
  const f = bindFixture(t);
  const incumbent = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  await incumbent.start();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Server({ name: 'acquisition-cleanup-test', version: '1.0.0' });
  mcp.transportFactory = () => serverTransport;
  const client = new Client({ name: 'acquisition-cleanup-client', version: '1.0.0' });
  const clientStarting = client.connect(clientTransport);
  let closeCalls = 0;
  const originalClose = mcp.close.bind(mcp);
  mcp.close = async () => { closeCalls += 1; return originalClose(); };
  const waitScheduler = scheduler();
  const waiter = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, startupScheduler: waitScheduler, mcp });
  const replacement = http.createServer((request, response) => {
    response.writeHead(200);
    response.end('successor');
  });
  let replacementStarted = false;
  let injectReplacement = false;
  let successorRelease;
  const originalLstat = fs.lstatSync;
  const originalAcquire = socketOwnership.acquireSocketLock;
  t.mock.method(fs, 'lstatSync', (candidate, options) => {
    try {
      return originalLstat(candidate, options);
    } catch (error) {
      if (candidate === f.socket && injectReplacement && error.code === 'ENOENT' && !replacementStarted) {
        replacementStarted = true;
        replacement.listen(f.socket);
        throw error;
      }
      throw error;
    }
  });
  t.mock.method(socketOwnership, 'acquireSocketLock', candidate => {
    if (candidate === f.socket && !successorRelease) {
      successorRelease = originalAcquire(candidate);
      throw new Error('Claude channel socket preparation is already in progress');
    }
    return originalAcquire(candidate);
  });
  const starting = waiter.start();
  t.after(async () => {
    successorRelease?.();
    await client.close().catch(() => {});
    await waiter.stop().catch(() => {});
    await incumbent.stop().catch(() => {});
    await closeListeningServer(replacement);
  });
  await clientStarting;
  await waitForCondition(() => waitScheduler.pending > 0, 'SDK waiter must pin the incumbent');
  await incumbent.stop();
  injectReplacement = true;
  waitScheduler.release();
  await assert.rejects(starting, /Claude channel socket already exists; stop its owner first/);
  assert.ok(closeCalls >= 1, 'acquisition refusal must close the connected MCP transport');
  assert.equal(waiter.startupAbort, null, 'acquisition refusal must clear startup cancellation');
  assert.equal((await requestOverSocket(f.socket)).statusCode, 200);
});

test('stopping during identity probe joins the delayed request close before stop returns', { timeout: 8000 }, async t => {
  const f = bindFixture(t);
  let startRequest;
  const started = new Promise(resolve => { startRequest = resolve; });
  const server = http.createServer((request, response) => {
    if (request.url !== '/identity') {
      response.writeHead(404);
      response.end();
      return;
    }
    startRequest();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(f.socket, resolve); });
  t.after(() => closeListeningServer(server));
  const release = socketOwnership.acquireSocketLock(f.socket);
  const originalDestroy = http.ClientRequest.prototype.destroy;
  const originalEmit = http.ClientRequest.prototype.emit;
  let destroyRequested = false;
  let closeObserved = false;
  let releaseClose;
  let requestToClose;
  const closeGate = new Promise(resolve => { releaseClose = resolve; });
  t.mock.method(http.ClientRequest.prototype, 'destroy', function (...args) {
    if (!destroyRequested) {
      destroyRequested = true;
      const request = this;
      requestToClose = () => originalDestroy.call(request, ...args);
      void closeGate.then(() => requestToClose());
      return this;
    }
    return originalDestroy.apply(this, args);
  });
  t.mock.method(http.ClientRequest.prototype, 'emit', function (event, ...args) {
    if (event === 'close') closeObserved = true;
    return originalEmit.call(this, event, ...args);
  });
  const waiter = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  t.after(async () => {
    releaseClose();
    release();
    await waiter.stop().catch(() => {});
  });
  const starting = waiter.start();
  const rejected = assert.rejects(starting, /stopped during incumbent wait/);
  await started;
  let stopReturned = false;
  const stopping = waiter.stop().finally(() => { stopReturned = true; });
  await waitForCondition(() => destroyRequested && requestToClose, 'stop must request identity teardown');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopReturned, false, 'stop must wait for the identity request close');
  releaseClose();
  await stopping;
  await rejected;
  assert.equal(closeObserved, true, 'the request close must finish before stop returns');
  assert.equal(waiter.ready, false);
});

test('startup cleanup failure is preserved and blocks another start until stop succeeds', { timeout: 8000 }, async t => {
  const f = bindFixture(t);
  let closeCalls = 0;
  const waiter = new ClaudeChannel({
    state: f.state,
    nativeId: CLAUDE_ID,
    socketPath: f.socket,
    mcp: {
      notification: async () => {},
      transportFactory: () => ({}),
      connect: async () => {},
      close: async () => {
        closeCalls += 1;
        if (closeCalls === 1) throw new Error('simulated startup close failure');
      }
    }
  });
  t.mock.method(socketOwnership, 'acquireSocketLock', () => {
    throw new Error('Claude channel socket preparation is already in progress');
  });
  t.after(async () => { await waiter.stop().catch(() => {}); });

  await assert.rejects(waiter.start(), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /startup cleanup failed/);
    assert.match(error.errors[0].message, /already in progress/);
    assert.match(error.errors[1].message, /simulated startup close failure/);
    return true;
  });
  assert.equal(waiter.startupCleanupPending, true);
  await assert.rejects(waiter.start(), /startup cleanup is pending/);
  await waiter.stop();
  assert.equal(waiter.startupCleanupPending, false);
  assert.equal(closeCalls, 2);
});

test('SDK close cancels a waiter while it remains detached', { timeout: 8000 }, async t => {
  const f = bindFixture(t);
  const incumbent = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  await incumbent.start();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Server({ name: 'wait-cancel-test', version: '1.0.0' });
  mcp.transportFactory = () => serverTransport;
  const client = new Client({ name: 'wait-cancel-client', version: '1.0.0' });
  const clientStarting = client.connect(clientTransport);
  let closeCalls = 0;
  const originalClose = mcp.close.bind(mcp);
  mcp.close = async () => { closeCalls += 1; return originalClose(); };
  const waitScheduler = scheduler();
  const waiter = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, startupScheduler: waitScheduler, mcp });
  const starting = waiter.start();
  t.after(async () => {
    await client.close().catch(() => {});
    await waiter.stop().catch(() => {});
    await incumbent.stop().catch(() => {});
  });
  await clientStarting;
  await waitForCondition(() => waitScheduler.pending > 0, 'SDK waiter must enter incumbent wait');
  const stopping = waiter.stop();
  await stopping;
  await assert.rejects(starting, /stopped during incumbent wait/);
  assert.equal(waiter.ready, false);
  assert.ok(closeCalls >= 1, 'SDK close must propagate through waiter cancellation');
  assert.equal(incumbent.ready, true);
});

test('buffered MCP initialization followed by EOF cancels startup while detached', { timeout: 8000 }, async t => {
  const f = bindFixture(t);
  const incumbent = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  await incumbent.start();
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new StdioServerTransport(input, output);
  const mcp = new Server({ name: 'buffered-init-test', version: '1.0.0' });
  mcp.transportFactory = () => transport;
  const frame = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'buffered-init-test', version: '1.0.0' }
    }
  };
  input.write(`${JSON.stringify(frame)}\n`);
  let responseText = '';
  let resolveInitialized;
  const initialized = new Promise(resolve => { resolveInitialized = resolve; });
  output.on('data', chunk => {
    responseText += chunk.toString();
    if (/"id":1/.test(responseText)) resolveInitialized();
  });
  const waitScheduler = scheduler();
  const waiter = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, startupScheduler: waitScheduler, mcp });
  const starting = waiter.start();
  t.after(async () => {
    input.destroy();
    output.destroy();
    await waiter.stop().catch(() => {});
    await incumbent.stop().catch(() => {});
  });

  await initialized;
  await waitForCondition(() => waitScheduler.pending > 0, 'buffered SDK initialization must finish before EOF');
  input.end();
  await transport.close();
  await assert.rejects(starting, /stopped during incumbent wait/);
  assert.equal(waiter.ready, false);
  assert.equal(incumbent.ready, true);
  assert.equal((await requestOverSocket(f.socket)).statusCode, 200);
});

test('MCP transport error cancels startup while detached', { timeout: 8000 }, async t => {
  const f = bindFixture(t);
  const incumbent = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  await incumbent.start();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Server({ name: 'wait-error-test', version: '1.0.0' });
  mcp.transportFactory = () => serverTransport;
  const client = new Client({ name: 'wait-error-client', version: '1.0.0' });
  const clientStarting = client.connect(clientTransport);
  const waitScheduler = scheduler();
  const waiter = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, startupScheduler: waitScheduler, mcp });
  const starting = waiter.start();
  t.after(async () => {
    await client.close().catch(() => {});
    await waiter.stop().catch(() => {});
    await incumbent.stop().catch(() => {});
  });

  await clientStarting;
  await waitForCondition(() => waitScheduler.pending > 0, 'SDK waiter must enter incumbent wait');
  assert.equal(typeof serverTransport.onerror, 'function');
  serverTransport.onerror(new Error('simulated MCP transport failure'));
  await assert.rejects(starting, /stopped during incumbent wait/);
  assert.equal(waiter.ready, false);
  assert.equal(incumbent.ready, true);
  assert.equal((await requestOverSocket(f.socket)).statusCode, 200);
});

test('Monitor stdout error cancels a waiter while incumbent stays ready', { timeout: 8000 }, async t => {
  const f = bindFixture(t);
  const incumbent = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  await incumbent.start();
  const stdout = new EventEmitter();
  stdout.write = (_chunk, callback) => { callback?.(); return true; };
  const waitScheduler = scheduler();
  const monitor = createClaudeMonitor({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, stateDir: f.dir, dbPath: f.db, stdout, startupScheduler: waitScheduler });
  const starting = monitor.start();
  t.after(async () => {
    await monitor.stop().catch(() => {});
    await incumbent.stop().catch(() => {});
  });
  await waitForCondition(() => waitScheduler.pending > 0, 'Monitor must enter incumbent wait');
  stdout.emit('error', new Error('simulated Monitor stdout failure'));
  await assert.rejects(starting, /stopped during incumbent wait/);
  assert.equal(monitor.ready, false);
  assert.equal(incumbent.ready, true);
});

test('Monitor SIGTERM cancels public startup while incumbent stays ready', { timeout: 8000 }, async t => {
  const f = bindFixture(t);
  const incumbent = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  await incumbent.start();
  const signals = new Map();
  const originalOnce = process.once;
  t.mock.method(process, 'once', function (event, listener) {
    if (event === 'SIGINT' || event === 'SIGTERM') {
      signals.set(event, listener);
      return this;
    }
    return originalOnce.call(this, event, listener);
  });
  const previousExitCode = process.exitCode;
  const monitorState = new SurfaceState(f.db);
  let resolveRequest;
  const requestStarted = new Promise(resolve => { resolveRequest = resolve; });
  incumbent.server.once('request', request => {
    if (request.url === '/identity') resolveRequest();
  });
  const commands = createClaudeListeners({
    openState: () => ({ paths: { stateDir: f.dir, db: f.db }, state: monitorState }),
    required: (args, key) => args[key],
    requestGatewayRecovery: async () => {},
    cliPath: path.resolve(__dirname, '../src/cli.js')
  });
  const starting = commands.claudeMonitor({ 'native-id': CLAUDE_ID, socket: f.socket, 'state-dir': f.dir, db: f.db });
  t.after(async () => {
    signals.get('SIGTERM')?.('SIGTERM');
    await starting.catch(() => {});
    try { monitorState.close(); } catch {}
    await incumbent.stop().catch(() => {});
    process.exitCode = previousExitCode;
  });

  await requestStarted;
  assert.equal(typeof signals.get('SIGTERM'), 'function');
  signals.get('SIGTERM')('SIGTERM');
  await assert.rejects(starting, /stopped during incumbent wait/);
  assert.equal(incumbent.ready, true);
  assert.equal((await requestOverSocket(f.socket)).statusCode, 200);
});

test('Monitor stdout close cancels a waiter while incumbent stays ready', { timeout: 8000 }, async t => {
  const f = bindFixture(t);
  const incumbent = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  await incumbent.start();
  const stdout = new EventEmitter();
  stdout.write = (_chunk, callback) => { callback?.(); return true; };
  const waitScheduler = scheduler();
  const monitor = createClaudeMonitor({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, stateDir: f.dir, dbPath: f.db, stdout, startupScheduler: waitScheduler });
  const starting = monitor.start();
  t.after(async () => {
    await monitor.stop().catch(() => {});
    await incumbent.stop().catch(() => {});
  });
  await waitForCondition(() => waitScheduler.pending > 0, 'Monitor must enter incumbent wait');
  stdout.emit('close');
  await assert.rejects(starting, /stopped during incumbent wait/);
  assert.equal(monitor.ready, false);
  assert.equal(incumbent.ready, true);
});

test('cleanup failure during waiting retains incumbent ownership', { timeout: 8000 }, async t => {
  const f = bindFixture(t);
  const incumbent = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  await incumbent.start();
  const waitScheduler = scheduler();
  const waiter = new ClaudeChannel({
    state: f.state,
    nativeId: CLAUDE_ID,
    socketPath: f.socket,
    startupScheduler: waitScheduler,
    mcp: { notification: async () => {}, close: async () => { throw new Error('simulated MCP cleanup failure'); } }
  });
  const starting = waiter.start();
  t.after(async () => {
    await waiter.stop().catch(() => {});
    await incumbent.stop().catch(() => {});
  });
  await waitForCondition(() => waitScheduler.pending > 0, 'waiter must enter incumbent wait');
  await assert.rejects(waiter.stop(), /Claude channel stop failed/);
  await assert.rejects(starting, error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /startup cleanup failed/);
    assert.match(error.errors[0].message, /stopped during incumbent wait/);
    assert.match(error.errors[1].message, /simulated MCP cleanup failure/);
    return true;
  });
  assert.equal(incumbent.ready, true);
  assert.equal((await requestOverSocket(f.socket)).statusCode, 200);
});

test('detached stale native identity remains unauthorized while waiter is detached', { timeout: 10000 }, async t => {
  const f = bindFixture(t);
  const currentBinding = f.state.getBinding('claude');
  f.state.setBindingReadiness('claude', READINESS.READY, 'detached stale identity fixture', currentBinding);
  const accepted = f.state.acceptDiscordMessage({
    id: '103', guildId: 'guild-1', channelId: 'claude', authorId: 'operator-1', isBot: false,
    content: 'stale native identity must not complete this message'
  }, { ready: true });
  assert.equal(accepted.accepted, true);
  assert.equal(f.state.claimDispatch('103').claimed, true);
  f.state.markSubmitted('103');
  const message = f.state.getMessage('103');
  const incumbent = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  await incumbent.start();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = createDefaultMcp({ nativeId: '00000000-0000-4000-8000-000000000001', state: f.state });
  mcp.transportFactory = () => serverTransport;
  const client = new Client({ name: 'stale-native-id-client', version: '1.0.0' });
  const clientStarting = client.connect(clientTransport);
  const waitScheduler = scheduler();
  const waiter = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, startupScheduler: waitScheduler, mcp });
  const starting = waiter.start();
  t.after(async () => {
    await client.close().catch(() => {});
    await waiter.stop().catch(() => {});
    await starting.catch(() => {});
    await incumbent.stop().catch(() => {});
  });
  await clientStarting;
  await waitForCondition(() => waitScheduler.pending > 0, 'stale native client must initialize while waiter is detached');
  assert.equal(waiter.ready, false);
  await assert.rejects(
    client.callTool({ name: 'acknowledge', arguments: { messageId: message.id, generation: message.generation } }),
    /native acknowledgment owner or generation is stale/
  );
  assert.equal(f.state.getMessage(message.id).state, MESSAGE_STATES.SUBMITTED);
  assert.equal(incumbent.ready, true);
  assert.equal((await requestOverSocket(f.socket)).statusCode, 200);
});

test('detached valid native completion remains authorized while stale generation is rejected', { timeout: 10000 }, async t => {
  const f = bindFixture(t);
  const currentBinding = f.state.getBinding('claude');
  f.state.setBindingReadiness('claude', READINESS.READY, 'detached authorization fixture', currentBinding);
  const accepted = f.state.acceptDiscordMessage({
    id: '102', guildId: 'guild-1', channelId: 'claude', authorId: 'operator-1', isBot: false,
    content: 'complete while listener waits'
  }, { ready: true });
  assert.equal(accepted.accepted, true);
  assert.equal(f.state.claimDispatch('102').claimed, true);
  f.state.markSubmitted('102');
  const message = f.state.getMessage('102');
  const incumbent = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, mcp: quietMcp() });
  await incumbent.start();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = createDefaultMcp({ nativeId: CLAUDE_ID, state: f.state });
  mcp.transportFactory = () => serverTransport;
  const client = new Client({ name: 'detached-authorization-client', version: '1.0.0' });
  const clientStarting = client.connect(clientTransport);
  const waitScheduler = scheduler();
  const waiter = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.socket, startupScheduler: waitScheduler, mcp });
  const starting = waiter.start();
  t.after(async () => {
    await client.close().catch(() => {});
    await waiter.stop().catch(() => {});
    await incumbent.stop().catch(() => {});
  });
  await clientStarting;
  await waitForCondition(() => waitScheduler.pending > 0, 'default MCP must initialize before detached authorization');
  assert.equal(waiter.ready, false);
  assert.equal(incumbent.ready, true);
  const acknowledgment = await client.callTool({ name: 'acknowledge', arguments: { messageId: message.id, generation: message.generation } });
  assert.equal(acknowledgment.isError, undefined);
  const reply = await client.callTool({ name: 'reply', arguments: { messageId: message.id, generation: message.generation, text: 'detached completion' } });
  assert.equal(reply.isError, undefined);
  assert.equal(f.state.getMessage(message.id).state, MESSAGE_STATES.REPLY_READY);
  assert.equal(f.state.getMessage(message.id).replyText, 'detached completion');
  await assert.rejects(
    client.callTool({ name: 'reply', arguments: { messageId: message.id, generation: message.generation + 1, text: 'stale completion' } }),
    /native reply is stale/
  );
  await incumbent.stop();
  waitScheduler.release();
  await starting;
  await waiter.stop();
});
