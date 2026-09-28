'use strict';

const {
  test, assert, fs, http, path, CLI_PATH, SUCCESSOR_ID, READINESS, BOARD_OUTCOMES, SurfaceState,
  fixture, response, boardChannelResponse, boardMessageResponse, deferred, waitFor,
  refresh, runChild, boardRefreshArgs, boardTarget, seedBoardOutcome
} = require('./board-refresh-fixture');

test('preflight signal stop exits with signal status and sends no PATCH', async t => {
  const f = fixture();
  t.after(() => f.state.close());
  fs.writeFileSync(f.textFile, 'signal board');
  f.state.close();
  const childScript = `
    const fs = require('node:fs');
    const { main } = require(${JSON.stringify(CLI_PATH)});
    global.fetch = async (_url, init = {}) => new Promise((_, reject) => {
      if (init.method === 'PATCH') fs.appendFileSync(process.env.DISCORD_SURFACE_PATCH_MARKER, 'patch\\n');
      const abort = () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); };
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener('abort', abort, { once: true });
    });
    process.argv = [process.execPath, ${JSON.stringify(CLI_PATH)}, ...JSON.parse(process.env.DISCORD_SURFACE_BOARD_ARGS)];
    const fallback = setTimeout(() => {
      fs.writeFileSync(process.env.DISCORD_SURFACE_FIXTURE_DEADLINE_MARKER, 'deadline');
      process.exit(99);
    }, 4000);
    const signalTimer = setTimeout(() => process.kill(process.pid, process.env.DISCORD_SURFACE_TEST_SIGNAL), 25);
    main().catch(error => { process.stderr.write(error.message + '\\n'); process.exitCode = 1; }).finally(() => {
      clearTimeout(fallback);
      clearTimeout(signalTimer);
    });
  `;
  const marker = path.join(f.dir, 'signal-patch.marker');
  const deadlineMarker = path.join(f.dir, 'signal-fixture-deadline.marker');
  const args = boardRefreshArgs(f, 'refresh-signal').slice(1);
  for (const [signal, expectedExit] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const child = await runChild(['-e', childScript], {
      DISCORD_SURFACE_BOARD_ARGS: JSON.stringify(args),
      DISCORD_SURFACE_PATCH_MARKER: marker,
      DISCORD_SURFACE_FIXTURE_DEADLINE_MARKER: deadlineMarker,
      DISCORD_SURFACE_TEST_SIGNAL: signal,
      NODE_NO_WARNINGS: '1'
    }, { timeoutMs: 7000 });
    assert.equal(child.timedOut, false);
    assert.equal(child.code, expectedExit, `${signal} child exited ${child.code} signal=${child.signal} stderr=${child.stderr} stdout=${child.stdout}`);
    assert.equal(child.signal, null);
    assert.equal(child.stderr, '');
  }
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(deadlineMarker), false);
  f.state = new SurfaceState(f.dbPath);
  assert.equal(f.state.listReceipts().some(row => row.kind === 'board-refresh-attempt'), false);
});

test('unresolved board PATCH fences binding retirement until its outcome is recorded', async t => {
  const f = fixture();
  t.after(() => f.state.close());
  const patchStarted = deferred();
  const releasePatch = deferred();
  const board = { content: 'initial board' };
  fs.writeFileSync(f.textFile, 'pending board');
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/users/@me')) return response({ id: 'bot-1' });
    if (init.method === 'GET' && url.endsWith('/channels/channel-1')) return boardChannelResponse();
    if (init.method === 'GET') return boardMessageResponse(board.content);
    if (init.method === 'PATCH') {
      patchStarted.resolve();
      await releasePatch.promise;
      board.content = JSON.parse(init.body).content;
      return boardMessageResponse(board.content);
    }
    throw new Error(`unexpected board request ${init.method} ${url}`);
  };

  const running = refresh(f, 'pending board', 'refresh-fence', fetchImpl);
  await waitFor(patchStarted, 'board PATCH admission');
  assert.equal(f.state.hasUnresolvedBindingPost('channel-1'), true);
  assert.throws(() => f.state.unbind('channel-1', { expectedBinding: f.binding }), /cannot unbind while work is unresolved/);

  releasePatch.resolve();
  assert.equal((await running).status, BOARD_OUTCOMES.APPLIED);
  assert.equal(f.state.hasUnresolvedBindingPost('channel-1'), false);
  assert.doesNotThrow(() => f.state.unbind('channel-1', { expectedBinding: f.binding }));
});

test('recovered unknown board outcome permits ordinary binding handoff', t => {
  const f = fixture();
  t.after(() => f.state.close());
  const target = boardTarget();
  seedBoardOutcome(f, 'unknown-retirement', BOARD_OUTCOMES.UNKNOWN);

  assert.equal(f.state.hasUnresolvedBindingPost(target.channelId), false);
  const old = f.state.getBinding(target.channelId);
  const handoff = f.state.handoffConductor({
    channelId: old.channelId,
    provider: old.provider,
    conductorId: old.conductorId,
    repoKey: old.repoKey,
    fromNativeId: old.nativeId,
    fromGeneration: old.generation,
    nativeId: SUCCESSOR_ID,
    workspace: old.workspace,
    endpoint: old.endpoint,
    handoffId: 'unknown-board-handoff'
  });
  assert.equal(handoff.generation, old.generation + 1);
});

test('malformed board outcome remains binding-fenced instead of becoming valid unknown recovery', t => {
  const f = fixture();
  t.after(() => f.state.close());
  const target = boardTarget();
  const seeded = seedBoardOutcome(f, 'malformed-unknown-retirement', BOARD_OUTCOMES.UNKNOWN);
  const row = f.state.db.prepare("SELECT id, detail FROM receipts WHERE kind='board-refresh-outcome' AND json_extract(detail, '$.attemptId')=?").get(seeded.attemptId);
  assert.ok(row);
  const detail = JSON.parse(row.detail);
  f.state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(
    JSON.stringify({ ...detail, outcome: 'not-a-board-outcome' }), row.id
  );
  assert.equal(f.state.hasUnresolvedBindingPost(target.channelId), true);
  const old = f.state.getBinding(target.channelId);
  assert.throws(() => f.state.handoffConductor({
    channelId: old.channelId,
    provider: old.provider,
    conductorId: old.conductorId,
    repoKey: old.repoKey,
    fromNativeId: old.nativeId,
    fromGeneration: old.generation,
    nativeId: SUCCESSOR_ID,
    workspace: old.workspace,
    endpoint: old.endpoint,
    handoffId: 'malformed-unknown-handoff'
  }), /cannot handoff while work is unresolved/);
});

test('late PATCH stays fenced across handoff, ordinary readiness, and successor refresh', async t => {
  const f = fixture();
  t.after(() => f.state.close());
  const oldReceived = deferred();
  const oldApplyRelease = deferred();
  const oldApplied = deferred();
  const controlApplied = deferred();
  const board = {
    content: 'initial board',
    managedPatchCount: 0,
    oldReceived: false,
    controlReceived: false,
    oldApplied: false,
    controlApplied: false,
    events: []
  };
  const server = http.createServer((request, reply) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && requestUrl.pathname === '/api/v10/users/@me') {
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.end(JSON.stringify({ id: 'bot-1' }));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/v10/channels/channel-1') {
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.end(JSON.stringify({ id: 'channel-1', guild_id: 'guild-1' }));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname.endsWith('/messages/target-1')) {
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.end(JSON.stringify({ id: 'target-1', channel_id: 'channel-1', author: { id: 'bot-1', bot: true }, content: board.content }));
      return;
    }
    if (request.method === 'PATCH' && requestUrl.pathname.endsWith('/messages/target-1')) {
      if (request.headers.authorization) board.managedPatchCount += 1;
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const payload = JSON.parse(body);
        if (payload.content === 'old revision') {
          board.oldReceived = true;
          board.events.push('old-received');
          oldReceived.resolve();
          oldApplyRelease.promise.then(() => {
            board.content = payload.content;
            board.oldApplied = true;
            board.events.push('old-applied');
            oldApplied.resolve();
            if (!reply.destroyed) {
              reply.writeHead(200, { 'content-type': 'application/json' });
              reply.end(JSON.stringify({ id: 'target-1', channel_id: 'channel-1', author: { id: 'bot-1', bot: true }, content: board.content }));
            }
          });
          return;
        }
        board.controlReceived = true;
        board.events.push('control-received');
        board.content = payload.content;
        board.controlApplied = true;
        board.events.push('control-applied');
        controlApplied.resolve();
        if (!reply.destroyed) {
          reply.writeHead(200, { 'content-type': 'application/json' });
          reply.end(JSON.stringify({ id: 'target-1', channel_id: 'channel-1', author: { id: 'bot-1', bot: true }, content: board.content }));
        }
      });
      return;
    }
    reply.writeHead(404);
    reply.end();
  });
  server.unref();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const cleanupTimer = setTimeout(() => oldApplyRelease.resolve(), 1000);
  cleanupTimer.unref();
  t.after(async () => {
    clearTimeout(cleanupTimer);
    oldApplyRelease.resolve();
    await new Promise(resolve => server.close(resolve));
  });
  const address = server.address();
  const fetchImpl = (url, init) => {
    const source = new URL(url);
    return fetch(`http://127.0.0.1:${address.port}${source.pathname}`, init);
  };

  const cancel = new AbortController();
  const firstPromise = refresh(f, 'old revision', 'refresh-old', fetchImpl, { signal: cancel.signal });
  await waitFor(oldReceived, 'old PATCH server receipt');
  cancel.abort();
  const first = await firstPromise;
  assert.equal(first.status, BOARD_OUTCOMES.UNKNOWN);
  assert.equal(board.oldReceived, true);

  // Negative control: a writer that bypasses admission can be overwritten by the received predecessor.
  const control = await fetchImpl('https://discord.com/api/v10/channels/channel-1/messages/target-1', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'control revision', allowed_mentions: { parse: [] } })
  });
  assert.equal(control.ok, true);
  await waitFor(controlApplied, 'control PATCH application');
  assert.equal(board.content, 'control revision');
  oldApplyRelease.resolve();
  await waitFor(oldApplied, 'old PATCH late application');
  assert.deepEqual(board.events, ['old-received', 'control-received', 'control-applied', 'old-applied']);
  assert.equal(board.controlApplied, true);
  assert.equal(board.oldApplied, true);
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
