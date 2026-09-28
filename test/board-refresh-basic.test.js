'use strict';

const {
  test, assert, fs, path, SurfaceState, BOARD_OUTCOMES, hashBoardText, CLI_PATH,
  fixture, response, boardChannelResponse, boardMessageResponse, fakeFetch, refresh,
  runChild, boardRefreshArgs, seedBoardAttempt
} = require('./board-refresh-fixture');

test('board refresh accepts Discord message REST shape without guild_id', async t => {
  const f = fixture();
  t.after(() => f.state.close());
  const calls = [];
  const board = { content: 'old board' };
  const result = await refresh(f, 'new board', 'refresh-1', fakeFetch(board, calls));
  assert.equal(result.status, BOARD_OUTCOMES.APPLIED);
  assert.deepEqual(calls.map(call => [call.init.method, call.url]), [
    ['GET', 'https://discord.com/api/v10/users/@me'],
    ['GET', 'https://discord.com/api/v10/channels/channel-1'],
    ['GET', 'https://discord.com/api/v10/channels/channel-1/messages/target-1'],
    ['PATCH', 'https://discord.com/api/v10/channels/channel-1/messages/target-1']
  ]);
  const patches = calls.filter(call => call.init.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].url, 'https://discord.com/api/v10/channels/channel-1/messages/target-1');
  assert.deepEqual(JSON.parse(patches[0].init.body), { content: 'new board', allowed_mentions: { parse: [] } });
  assert.equal(calls.some(call => call.init.method === 'POST'), false);
  assert.equal(f.state.listReceipts().filter(row => row.kind === 'board-designation').length, 1);
  assert.equal(JSON.parse(f.state.listReceipts().filter(row => row.kind === 'board-refresh-outcome').at(-1).detail).outcome, BOARD_OUTCOMES.APPLIED);
});

test('board refresh rejects untrusted channel and message identity before admission or PATCH', async () => {
  const cases = [
    {
      name: 'wrong channel guild',
      channel: { id: 'channel-1', guild_id: 'guild-other' },
      messageChannelId: 'channel-1',
      error: /bound guild and channel/,
      expectedCalls: 2
    },
    {
      name: 'wrong channel id',
      channel: { id: 'channel-other', guild_id: 'guild-1' },
      messageChannelId: 'channel-1',
      error: /bound guild and channel/,
      expectedCalls: 2
    },
    {
      name: 'missing channel guild',
      channel: { id: 'channel-1' },
      messageChannelId: 'channel-1',
      error: /channel\.guild_id must be a non-empty string/,
      expectedCalls: 2
    },
    {
      name: 'wrong message channel after valid channel authority',
      channel: { id: 'channel-1', guild_id: 'guild-1' },
      messageChannelId: 'channel-other',
      error: /board target message does not belong to the bound channel/,
      expectedCalls: 3
    }
  ];

  for (const scenario of cases) {
    const f = fixture();
    try {
      const calls = [];
      const fetchImpl = async (url, init = {}) => {
        calls.push({ url, init });
        if (url.endsWith('/users/@me')) return response({ id: 'bot-1' });
        if (init.method === 'GET' && url.endsWith('/channels/channel-1')) return response(scenario.channel);
        if (init.method === 'GET') return response({
          id: 'target-1',
          channel_id: scenario.messageChannelId,
          author: { id: 'bot-1', bot: true },
          content: 'old board'
        });
        if (init.method === 'PATCH') return boardMessageResponse('new board');
        throw new Error(`unexpected board request ${init.method} ${url}`);
      };

      await assert.rejects(() => refresh(f, 'new board', `refresh-${scenario.name.replaceAll(' ', '-')}`, fetchImpl), scenario.error, scenario.name);
      assert.equal(calls.length, scenario.expectedCalls, scenario.name);
      assert.equal(calls.some(call => call.init.method === 'PATCH'), false, scenario.name);
      assert.equal(f.state.listReceipts().some(row => row.kind === 'board-refresh-attempt'), false, scenario.name);
      assert.equal(f.state.listReceipts().some(row => row.kind === 'board-refresh-outcome'), false, scenario.name);
    } finally {
      f.state.close();
    }
  }
});

test('multiline board content reaches one mention-suppressed PATCH', async t => {
  const f = fixture();
  t.after(() => f.state.close());
  const calls = [];
  const board = { content: 'old board' };
  const content = 'first line\nsecond line';
  const result = await refresh(f, content, 'refresh-multiline', fakeFetch(board, calls));
  assert.equal(result.status, BOARD_OUTCOMES.APPLIED);
  const patches = calls.filter(call => call.init.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.deepEqual(JSON.parse(patches[0].init.body), { content, allowed_mentions: { parse: [] } });
});

test('board refresh canonicalizes terminal line endings while retaining raw evidence', async t => {
  const f = fixture();
  t.after(() => f.state.close());
  const calls = [];
  const rawContent = '  first line\nsecond line \nthird\t\n\n';
  const canonicalContent = '  first line\nsecond line \nthird\t';
  const board = { content: 'old board\r\n' };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/users/@me')) return response({ id: 'bot-1' });
    if (init.method === 'GET' && url.endsWith('/channels/channel-1')) return boardChannelResponse();
    if (init.method === 'GET') return boardMessageResponse(board.content);
    if (init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      board.content = `${body.content.replace(/[\r\n]+$/u, '')}\n`;
      return boardMessageResponse(board.content);
    }
    throw new Error(`unexpected board request ${init.method} ${url}`);
  };

  const result = await refresh(f, rawContent, 'refresh-terminal-line-endings', fetchImpl);
  assert.equal(result.status, BOARD_OUTCOMES.APPLIED);
  const patches = calls.filter(call => call.init.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.equal(JSON.parse(patches[0].init.body).content, canonicalContent);
  const rows = f.state.listReceipts().map(row => ({ kind: row.kind, detail: JSON.parse(row.detail) }));
  const attempt = rows.find(row => row.kind === 'board-refresh-attempt' && row.detail.requestId === 'refresh-terminal-line-endings').detail;
  const outcome = rows.find(row => row.kind === 'board-refresh-outcome' && row.detail.requestId === 'refresh-terminal-line-endings').detail;
  assert.equal(attempt.content, canonicalContent);
  assert.equal(attempt.preEditContent, 'old board\r\n');
  assert.equal(attempt.payloadHash, hashBoardText(canonicalContent));
  assert.equal(outcome.observedContent, `${canonicalContent}\n`);
});

test('installation preflight failure does not start the target read', async t => {
  const f = fixture();
  t.after(() => f.state.close());
  const calls = [];
  const failedFetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/users/@me')) throw new Error('installation lookup failed');
    throw new Error(`unexpected request ${init.method} ${url}`);
  };
  await assert.rejects(() => refresh(f, 'new board', 'refresh-installation-failure', failedFetch), /installation lookup failed/);
  assert.deepEqual(calls.map(call => call.url), ['https://discord.com/api/v10/users/@me']);
});

test('already desired board is an honest no-op and target qualification rejects wrong authors', async t => {
  const f = fixture();
  t.after(() => f.state.close());
  const board = { content: 'same board\r\n' };
  const sameCalls = [];
  const same = await refresh(f, 'same board\n\n', 'refresh-noop', fakeFetch(board, sameCalls));
  assert.equal(same.status, BOARD_OUTCOMES.NO_OP);
  assert.equal(sameCalls.filter(call => call.init.method === 'PATCH').length, 0);
  const noopAttempt = f.state.listReceipts()
    .filter(row => row.kind === 'board-refresh-attempt' && JSON.parse(row.detail).requestId === 'refresh-noop')
    .at(-1);
  assert.ok(noopAttempt);
  const noopAttemptId = JSON.parse(noopAttempt.detail).attemptId;
  const noopOutcome = f.state.listReceipts()
    .filter(row => row.kind === 'board-refresh-outcome' && JSON.parse(row.detail).attemptId === noopAttemptId)
    .at(-1);
  assert.equal(JSON.parse(noopOutcome.detail).outcome, BOARD_OUTCOMES.NO_OP);
  f.state.close();
  f.state = new SurfaceState(f.dbPath);
  const historicalNoop = await refresh(f, 'same board', 'refresh-noop', fakeFetch(board, []));
  assert.equal(historicalNoop.status, BOARD_OUTCOMES.NO_OP);
  assert.equal(historicalNoop.historical, true);

  const wrongCalls = [];
  const wrongFetch = async (url, init = {}) => {
    wrongCalls.push({ url, init });
    if (url.endsWith('/users/@me')) return response({ id: 'bot-1' });
    if (url.endsWith('/channels/channel-1')) return boardChannelResponse();
    return boardMessageResponse('same board', 'other-bot');
  };
  await assert.rejects(() => refresh(f, 'other board', 'refresh-wrong-author', wrongFetch), /not authored by this Discord installation/);
  assert.equal(wrongCalls.filter(call => call.init.method === 'PATCH').length, 0);
});

test('same-key replay accepts legacy terminal line endings but refuses changed content', async t => {
  const f = fixture();
  t.after(() => f.state.close());
  const seeded = seedBoardAttempt(f, 'replay-legacy-terminal-line-endings', 'new board\n\n');
  f.state.recordBoardRefreshOutcome(seeded.target, seeded.attemptId, BOARD_OUTCOMES.APPLIED, {
    operationEndedAt: '2026-01-01T00:00:00.000Z'
  });
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    throw new Error(`unexpected replay request ${init.method} ${url}`);
  };

  const replay = await refresh(f, 'new board\n\n', 'replay-legacy-terminal-line-endings', fetchImpl);
  assert.equal(replay.status, BOARD_OUTCOMES.APPLIED);
  assert.equal(replay.historical, true);
  assert.equal(calls.length, 0);

  await assert.rejects(
    () => refresh(f, 'changed board', 'replay-legacy-terminal-line-endings', fetchImpl),
    /dedupe key is already used for another board payload/
  );
  assert.equal(calls.length, 0);
});

test('no-op admission and outcome roll back together when the outcome receipt fails', async t => {
  const f = fixture();
  t.after(() => f.state.close());
  const originalReceipt = f.state.receipt.bind(f.state);
  f.state.receipt = (discordId, kind, detail) => {
    if (kind === 'board-refresh-outcome' && detail?.outcome === BOARD_OUTCOMES.NO_OP) {
      throw new Error('simulated no-op outcome receipt failure');
    }
    return originalReceipt(discordId, kind, detail);
  };
  await assert.rejects(() => refresh(f, 'same board', 'refresh-noop-rollback', fakeFetch({ content: 'same board' }, [])), /simulated no-op outcome receipt failure/);
  const rows = f.state.listReceipts().map(row => ({ kind: row.kind, detail: JSON.parse(row.detail) }));
  assert.equal(rows.some(row => row.kind === 'board-refresh-attempt' && row.detail.requestId === 'refresh-noop-rollback'), false);
  assert.equal(rows.some(row => row.kind === 'board-refresh-outcome' && row.detail.requestId === 'refresh-noop-rollback'), false);
});

test('historical board failure exits nonzero without a retry', async t => {
  const f = fixture();
  t.after(() => f.state.close());
  const board = { content: 'old board' };
  const failedFetch = async (url, init = {}) => {
    if (url.endsWith('/users/@me')) return response({ id: 'bot-1' });
    if (init.method === 'GET' && url.endsWith('/channels/channel-1')) return boardChannelResponse();
    if (init.method === 'GET') return boardMessageResponse(board.content);
    if (init.method === 'PATCH') return response({ message: 'rate limited' }, 429);
    throw new Error(`unexpected board request ${init.method} ${url}`);
  };
  const requestId = 'refresh-cli-history';
  const result = await refresh(f, 'failed board', requestId, failedFetch);
  assert.equal(result.status, BOARD_OUTCOMES.RATE_LIMITED);
  f.state.close();
  const marker = path.join(f.dir, 'unexpected-fetch.marker');
  const childScript = `
    const fs = require('node:fs');
    const { main } = require(${JSON.stringify(CLI_PATH)});
    global.fetch = async () => {
      fs.writeFileSync(process.env.DISCORD_SURFACE_UNEXPECTED_FETCH_MARKER, 'unexpected');
      throw new Error('unexpected fetch during historical lookup');
    };
    process.argv = [process.execPath, ${JSON.stringify(CLI_PATH)}, ...JSON.parse(process.env.DISCORD_SURFACE_BOARD_ARGS)];
    const fixtureDeadline = setTimeout(() => {
      fs.writeFileSync(process.env.DISCORD_SURFACE_FIXTURE_DEADLINE_MARKER, 'deadline');
      process.exit(99);
    }, 4000);
    main().then(() => clearTimeout(fixtureDeadline), error => {
      clearTimeout(fixtureDeadline);
      process.stderr.write(error.message + '\\n');
      process.exitCode = 1;
    });
  `;
  const child = await runChild(['-e', childScript], {
    DISCORD_SURFACE_BOARD_ARGS: JSON.stringify(boardRefreshArgs(f, requestId).slice(1)),
    DISCORD_SURFACE_UNEXPECTED_FETCH_MARKER: marker,
    DISCORD_SURFACE_FIXTURE_DEADLINE_MARKER: path.join(f.dir, 'fixture-deadline.marker'),
    NODE_NO_WARNINGS: '1'
  }, { timeoutMs: 7000 });
  assert.equal(child.timedOut, false);
  assert.equal(child.code, 1, `historical child exited ${child.code} signal=${child.signal} stderr=${child.stderr} stdout=${child.stdout}`);
  assert.equal(child.signal, null);
  const historical = JSON.parse(child.stdout);
  assert.equal(historical.status, BOARD_OUTCOMES.RATE_LIMITED);
  assert.equal(historical.historical, true);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(path.join(f.dir, 'fixture-deadline.marker')), false);
  assert.equal(child.stderr, '');
});
