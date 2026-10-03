'use strict';

const {
  test, assert, fs, http, path, CLI_PATH, STATE_PATH, DISCORD_PATH, SUCCESSOR_ID, READINESS,
  BOARD_OUTCOMES, fixture, deferred, waitFor, waitForFile, spawnChild, boardRefreshArgs, boardTarget
} = require('./board-refresh-fixture');
const { OWNER_EVIDENCE, OWNER_EVIDENCE_REASON } = require('../src/state/process-owner-evidence');

test('two child owners contend, hand off, and recover an orphaned board attempt before successor refresh', async t => {
  const f = fixture();
  let predecessor;
  let successor;
  const oldReceived = deferred();
  const oldApplyRelease = deferred();
  const oldApplied = deferred();
  const controlApplied = deferred();
  const successorApplied = deferred();
  const board = {
    content: 'initial board',
    events: [],
    managedPatchCount: 0,
    postCount: 0
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
    if (request.method === 'POST') {
      board.postCount += 1;
      reply.writeHead(201, { 'content-type': 'application/json' });
      reply.end(JSON.stringify({ id: 'unexpected-post' }));
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
          board.events.push('old-received');
          oldReceived.resolve();
          oldApplyRelease.promise.then(() => {
            board.content = payload.content;
            board.events.push('old-applied');
            oldApplied.resolve();
            if (!reply.destroyed) {
              reply.writeHead(200, { 'content-type': 'application/json' });
              reply.end(JSON.stringify({ id: 'target-1', channel_id: 'channel-1', author: { id: 'bot-1', bot: true }, content: board.content }));
            }
          });
          return;
        }
        if (payload.content === 'successor revision') {
          board.events.push('successor-received');
          board.content = payload.content;
          board.events.push('successor-applied');
          successorApplied.resolve();
        } else {
          board.events.push('control-received');
          board.content = payload.content;
          board.events.push('control-applied');
          controlApplied.resolve();
        }
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
  const cleanupTimer = setTimeout(() => oldApplyRelease.resolve(), 5000);
  cleanupTimer.unref();
  t.after(async () => {
    clearTimeout(cleanupTimer);
    oldApplyRelease.resolve();
    for (const child of [predecessor?.child, successor?.child]) {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.allSettled([predecessor?.result, successor?.result].filter(Boolean));
    await new Promise(resolve => server.close(resolve));
    f.state.close();
  });
  const address = server.address();
  const boardServer = `http://127.0.0.1:${address.port}`;
  const predecessorDeadline = path.join(f.dir, 'predecessor-fixture-deadline.marker');
  const contenderTextFile = path.join(f.dir, 'contender-board.txt');
  const contenderResultFile = path.join(f.dir, 'contender-result.json');
  const ordinaryStartFile = path.join(f.dir, 'ordinary-successor.start');
  const ordinaryResultFile = path.join(f.dir, 'ordinary-successor-result.json');
  const boardStartFile = path.join(f.dir, 'successor-board.start');
  const successorResultFile = path.join(f.dir, 'successor-result.json');
  fs.writeFileSync(f.textFile, 'old revision');
  fs.writeFileSync(contenderTextFile, 'competing revision');
  const predecessorScript = `
    const fs = require('node:fs');
    const { main } = require(${JSON.stringify(CLI_PATH)});
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      const source = new URL(url);
      return nativeFetch(process.env.DISCORD_SURFACE_BOARD_SERVER + source.pathname, init);
    };
    const fixtureDeadline = setTimeout(() => {
      fs.writeFileSync(process.env.DISCORD_SURFACE_FIXTURE_DEADLINE_MARKER, 'deadline');
      process.exit(99);
    }, 5000);
    process.argv = [process.execPath, ...JSON.parse(process.env.DISCORD_SURFACE_BOARD_ARGS)];
    main().then(() => clearTimeout(fixtureDeadline), error => {
      clearTimeout(fixtureDeadline);
      process.stderr.write(error.message + '\\n');
      process.exitCode = 1;
    });
  `;
  predecessor = spawnChild(['-e', predecessorScript], {
    DISCORD_SURFACE_BOARD_SERVER: boardServer,
    DISCORD_SURFACE_BOARD_ARGS: JSON.stringify(boardRefreshArgs(f, 'refresh-old')),
    DISCORD_SURFACE_FIXTURE_DEADLINE_MARKER: predecessorDeadline,
    NODE_NO_WARNINGS: '1'
  }, { timeoutMs: 7000 });
  await waitFor(oldReceived, 'predecessor PATCH server receipt', 3000);

  const successorDeadline = path.join(f.dir, 'successor-fixture-deadline.marker');
  const successorScript = `
    const fs = require('node:fs');
    const { publishFixtureFile } = require(${JSON.stringify(path.join(__dirname, 'fixture-publication.js'))});
    const { main } = require(${JSON.stringify(CLI_PATH)});
    const { SurfaceState } = require(${JSON.stringify(STATE_PATH)});
    const { createSurfaceConsumer } = require(${JSON.stringify(DISCORD_PATH)});
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      const source = new URL(url);
      return nativeFetch(process.env.DISCORD_SURFACE_BOARD_SERVER + source.pathname, init);
    };
    const fixtureDeadline = setTimeout(() => {
      fs.writeFileSync(process.env.DISCORD_SURFACE_FIXTURE_DEADLINE_MARKER, 'deadline');
      process.exit(99);
    }, 5000);
    const waitForFile = async file => {
      while (!fs.existsSync(file)) await new Promise(resolve => setTimeout(resolve, 10));
    };
    const target = { guildId: 'guild-1', channelId: 'channel-1', messageId: 'target-1' };
    (async () => {
      process.argv = [process.execPath, ...JSON.parse(process.env.DISCORD_SURFACE_CONTENDER_ARGS)];
      const contender = await main();
      process.exitCode = 0;
      publishFixtureFile(process.env.DISCORD_SURFACE_CONTENDER_RESULT_FILE, JSON.stringify(contender));
      if (contender?.status !== 'in_flight') throw new Error('concurrent board contender was not refused as in-flight');
      await waitForFile(process.env.DISCORD_SURFACE_ORDINARY_START_FILE);

      let state = new SurfaceState(process.env.DISCORD_SURFACE_DB);
      try {
        const fenced = state.inspectBoardRequest('refresh-old', target);
        if (fenced?.status !== 'unknown') throw new Error('board was not fenced during ordinary successor work: ' + fenced?.status);
        const binding = state.getBinding('channel-1');
        if (binding?.nativeId !== process.env.DISCORD_SURFACE_SUCCESSOR_ID || binding.generation !== 2) {
          throw new Error('successor binding was not ready before ordinary work');
        }
        const events = [];
        const consumer = createSurfaceConsumer({
          state,
          providers: {
            codex: {
              async dispatch(message) {
                events.push({ phase: 'dispatch', messageId: message.id, generation: message.generation });
                return { status: 'submitted' };
              },
              async observe(message) {
                events.push({ phase: 'observe', messageId: message.id, generation: message.generation });
                return { text: 'ordinary successor answer' };
              }
            }
          },
          prepareReply: () => null,
          sendTransportReceipt: async () => {
            events.push({ phase: 'receipt' });
            return { id: 'ordinary-transport-receipt' };
          },
          sendReply: async () => {
            events.push({ phase: 'reply' });
            return { id: 'ordinary-successor-reply' };
          }
        });
        const ordinary = await consumer.handleMessage({
          id: '101',
          guildId: 'guild-1',
          channelId: 'channel-1',
          author: { id: 'operator-1', bot: false },
          content: 'ordinary successor request',
          channel: { send: async () => ({ id: 'unused-channel-send' }) }
        }, undefined, binding);
        await consumer.waitForNativeWork();
        await consumer.waitForReceipts();
        const ordinaryMessage = state.getMessage('101');
        publishFixtureFile(process.env.DISCORD_SURFACE_ORDINARY_RESULT_FILE, JSON.stringify({
          resultStatus: ordinary?.status || null,
          messageState: ordinaryMessage?.state || null,
          generation: ordinaryMessage?.generation || null,
          fencedStatus: fenced.status,
          events
        }));
        if (ordinaryMessage?.state !== 'replied') throw new Error('ordinary successor message did not complete: ' + ordinaryMessage?.state);
        state.close();
        state = null;
      } finally {
        state?.close();
      }

      await waitForFile(process.env.DISCORD_SURFACE_BOARD_START_FILE);
      state = new SurfaceState(process.env.DISCORD_SURFACE_DB);
      let oldAttempt;
      try {
        oldAttempt = state.listReceipts()
          .filter(row => row.kind === 'board-refresh-attempt' && JSON.parse(row.detail).requestId === 'refresh-old')
          .at(-1);
        if (!oldAttempt) throw new Error('predecessor board attempt is missing');
        const oldDetail = JSON.parse(oldAttempt.detail);
        const recovered = state.recoverBoardRefreshAttempt(target, oldDetail.attemptId);
        if (recovered !== 0) throw new Error('selected orphan recovery unexpectedly changed custody: ' + recovered);
        if (state.inspectBoardRequest('refresh-old', target)?.status !== 'unknown') {
          throw new Error('selected orphan was not classified as unknown before reconciliation');
        }
      } finally {
        state.close();
        state = null;
      }
      const readbackResponse = await fetch(process.env.DISCORD_SURFACE_BOARD_SERVER + '/api/v10/channels/channel-1/messages/target-1');
      const readback = await readbackResponse.json();
      if (readback.content !== 'old revision') throw new Error('readback content was ' + readback.content);
      const observedAt = new Date().toISOString();
      const oldDetail = JSON.parse(oldAttempt.detail);
      const recoveryArgs = [
        ${JSON.stringify(CLI_PATH)},
        'recover',
        '--db', process.env.DISCORD_SURFACE_DB,
        '--board-guild-id', 'guild-1',
        '--board-channel-id', 'channel-1',
        '--board-message-id', 'target-1',
        '--board-attempt-id', oldDetail.attemptId,
        '--board-resolution', 'applied',
        '--board-evidence-scope', 'local server readback after orphan classification',
        '--board-readback-at', observedAt,
        '--board-readback', readback.content,
        '--board-sole-writer', 'true',
        '--board-single-attempt', 'true',
        '--board-no-hidden-retry', 'true'
      ];
      process.argv = [process.execPath, ...recoveryArgs];
      await main();
      process.argv = [process.execPath, ...JSON.parse(process.env.DISCORD_SURFACE_SUCCESSOR_ARGS)];
      const result = await main();
      publishFixtureFile(process.env.DISCORD_SURFACE_SUCCESSOR_RESULT_FILE, JSON.stringify({ result, observedAt, readbackContent: readback.content }));
      if (result?.status !== 'applied') throw new Error('successor board refresh did not apply: ' + result?.status);
    })().then(() => clearTimeout(fixtureDeadline), error => {
      clearTimeout(fixtureDeadline);
      process.stderr.write(error.message + '\\n');
      process.exitCode = 1;
    });
  `;
  successor = spawnChild(['-e', successorScript], {
    DISCORD_SURFACE_BOARD_SERVER: boardServer,
    DISCORD_SURFACE_DB: f.dbPath,
    DISCORD_SURFACE_CONTENDER_ARGS: JSON.stringify(boardRefreshArgs(f, 'refresh-contender', { textFile: contenderTextFile })),
    DISCORD_SURFACE_CONTENDER_RESULT_FILE: contenderResultFile,
    DISCORD_SURFACE_ORDINARY_START_FILE: ordinaryStartFile,
    DISCORD_SURFACE_ORDINARY_RESULT_FILE: ordinaryResultFile,
    DISCORD_SURFACE_BOARD_START_FILE: boardStartFile,
    DISCORD_SURFACE_SUCCESSOR_ARGS: JSON.stringify(boardRefreshArgs(f, 'refresh-successor', { nativeId: SUCCESSOR_ID, generation: 2 })),
    DISCORD_SURFACE_SUCCESSOR_RESULT_FILE: successorResultFile,
    DISCORD_SURFACE_FIXTURE_DEADLINE_MARKER: successorDeadline,
    DISCORD_SURFACE_SUCCESSOR_ID: SUCCESSOR_ID,
    NODE_NO_WARNINGS: '1'
  }, { timeoutMs: 7000 });

  const contenderResult = JSON.parse(await waitForFile(contenderResultFile, 'concurrent contender result'));
  assert.equal(contenderResult.status, BOARD_OUTCOMES.IN_FLIGHT);
  assert.equal(predecessor.child.exitCode, null);
  assert.equal(successor.child.exitCode, null);

  predecessor.child.kill('SIGKILL');
  const predecessorResult = await predecessor.result;
  assert.equal(predecessorResult.timedOut, false);
  assert.equal(predecessorResult.code, null);
  assert.equal(predecessorResult.signal, 'SIGKILL');
  assert.equal(fs.existsSync(predecessorDeadline), false);

  const target = boardTarget();
  const oldAttempt = f.state.listReceipts()
    .filter(row => row.kind === 'board-refresh-attempt' && JSON.parse(row.detail).requestId === 'refresh-old')
    .at(-1);
  assert.ok(oldAttempt);
  const oldDetail = JSON.parse(oldAttempt.detail);
  assert.equal(f.state.inspectBoardRequest('refresh-old', target).status, BOARD_OUTCOMES.IN_FLIGHT);
  assert.equal(f.state.recoverBoardRefreshAttempt(target, oldDetail.attemptId, () => ({ status: OWNER_EVIDENCE.ABSENT, reason: OWNER_EVIDENCE_REASON.PROBE_ABSENT })), 1);
  assert.equal(f.state.inspectBoardRequest('refresh-old', target).status, BOARD_OUTCOMES.UNKNOWN);

  const old = f.state.getBinding('channel-1');
  const handoff = f.state.handoffConductor({
    channelId: old.channelId, provider: old.provider, conductorId: old.conductorId, repoKey: old.repoKey,
    fromNativeId: old.nativeId, fromGeneration: old.generation, nativeId: SUCCESSOR_ID,
    workspace: old.workspace, endpoint: old.endpoint, handoffId: 'board-child-handoff-1'
  });
  assert.equal(handoff.generation, 2);
  assert.equal(f.state.setBindingReadiness('channel-1', READINESS.READY, 'successor ordinary work is ready while board remains fenced', handoff).readiness, READINESS.READY);
  fs.writeFileSync(ordinaryStartFile, 'start');
  const ordinaryResult = JSON.parse(await waitForFile(ordinaryResultFile, 'ordinary successor result'));
  assert.equal(ordinaryResult.messageState, 'replied');
  assert.equal(ordinaryResult.generation, 2);
  assert.equal(ordinaryResult.fencedStatus, BOARD_OUTCOMES.UNKNOWN);
  assert.deepEqual(ordinaryResult.events.map(event => event.phase).sort(), ['dispatch', 'observe', 'receipt', 'reply'].sort());
  assert.equal(f.state.inspectBoardRequest('refresh-old', target).status, BOARD_OUTCOMES.UNKNOWN);
  assert.equal(board.managedPatchCount, 1);
  assert.equal(board.content, 'initial board');

  const control = await fetch(`${boardServer}/api/v10/channels/channel-1/messages/target-1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'control revision', allowed_mentions: { parse: [] } })
  });
  assert.equal(control.ok, true);
  await waitFor(controlApplied, 'control PATCH application', 3000);
  assert.equal(board.content, 'control revision');
  oldApplyRelease.resolve();
  await waitFor(oldApplied, 'predecessor late PATCH application', 3000);
  assert.deepEqual(board.events, ['old-received', 'control-received', 'control-applied', 'old-applied']);
  assert.equal(board.content, 'old revision');

  fs.writeFileSync(f.textFile, 'successor revision');
  fs.writeFileSync(boardStartFile, 'start');
  const successorResult = await successor.result;
  assert.equal(successorResult.timedOut, false);
  assert.equal(successorResult.code, 0, `successor child exited ${successorResult.code} signal=${successorResult.signal} stderr=${successorResult.stderr} stdout=${successorResult.stdout}`);
  assert.equal(successorResult.signal, null);
  assert.equal(successorResult.stderr, '');
  assert.equal(fs.existsSync(successorDeadline), false);
  await waitFor(successorApplied, 'successor PATCH application', 3000);
  assert.deepEqual(board.events, ['old-received', 'control-received', 'control-applied', 'old-applied', 'successor-received', 'successor-applied']);
  assert.equal(JSON.parse(fs.readFileSync(successorResultFile, 'utf8')).result.status, BOARD_OUTCOMES.APPLIED);

  const receipts = f.state.listReceipts().map(row => ({ kind: row.kind, detail: JSON.parse(row.detail) }));
  const oldOutcomes = receipts.filter(row => row.kind === 'board-refresh-outcome' && row.detail.attemptId === oldDetail.attemptId);
  assert.deepEqual(oldOutcomes.map(row => row.detail.outcome), [BOARD_OUTCOMES.UNKNOWN, BOARD_OUTCOMES.APPLIED]);
  assert.equal(oldOutcomes.at(-1).detail.reconciledFrom, BOARD_OUTCOMES.UNKNOWN);
  assert.equal(receipts.filter(row => row.kind === 'board-refresh-outcome' && row.detail.requestId === 'refresh-successor').at(-1).detail.outcome, BOARD_OUTCOMES.APPLIED);
  assert.equal(board.managedPatchCount, 2);
  assert.equal(board.postCount, 0);
  assert.equal(board.content, 'successor revision');
  assert.equal(f.state.getBinding('channel-1').generation, 2);
});
