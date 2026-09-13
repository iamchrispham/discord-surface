const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SurfaceState, BOARD_OUTCOMES, READINESS } = require('../src/state');
const { runBoardRefresh } = require('../src/board-refresh');

const NATIVE_ID = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const SUCCESSOR_ID = '7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b';
const CLI_PATH = path.resolve(__dirname, '../src/cli.js');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-board-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  const secretFile = path.join(dir, 'discord.secret');
  fs.writeFileSync(secretFile, 'DISCORD_TOKEN=fixture-token\n');
  fs.chmodSync(secretFile, 0o600);
  state.setConfig({ operatorId: 'operator-1', guildId: 'guild-1', secretFile });
  const binding = state.bind({
    channelId: 'channel-1', guildId: 'guild-1', provider: 'codex', nativeId: NATIVE_ID,
    workspace: dir, conductorId: 'conductor-1', repoKey: 'repo:discord-surface'
  });
  state.receipt(null, 'direct-post-outcome', {
    journal: 'direct-post-v1', requestId: 'seed-post', attemptId: 'seed-attempt', outcome: 'sent', messageId: 'target-1',
    channelId: 'channel-1', guildId: 'guild-1', provider: 'codex', nativeId: NATIVE_ID, generation: binding.generation
  });
  const textFile = path.join(dir, 'board.txt');
  return { dir, dbPath: path.join(dir, 'surface.sqlite'), state, binding, textFile, secretFile };
}

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

async function waitFor(signal, label, timeoutMs = 1000) {
  let timer;
  try {
    return await Promise.race([
      signal.promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
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
    signal: options.signal,
    resolveBinding: resolver
  });
}

function runChild(args, env = {}, options = {}) {
  const child = spawn(process.execPath, args, {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, signal: 'SIGKILL', timedOut: true });
    }, options.timeoutMs || 2000);
    child.once('error', error => finish({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => finish({ code, signal, timedOut: false }));
  });
}

function boardRefreshArgs(f, requestId) {
  return [
    CLI_PATH,
    'board-refresh',
    '--db', f.dbPath,
    '--native-id', NATIVE_ID,
    '--generation', '1',
    '--channel-id', 'channel-1',
    '--message-id', 'target-1',
    '--text-file', f.textFile,
    '--dedupe-key', requestId
  ];
}

function boardTarget() {
  return { guildId: 'guild-1', channelId: 'channel-1', messageId: 'target-1' };
}

function recoveryEvidence(content = 'new board') {
  return {
    evidenceScope: 'local fixture readback',
    observedAt: '2026-01-01T00:00:01.000Z',
    readbackContent: content,
    soleWriter: true,
    singleAttempt: true,
    noHiddenRetry: true
  };
}

function seedBoardAttempt(f, requestId, content = 'new board') {
  const target = boardTarget();
  const binding = f.state.getBinding(target.channelId);
  const provenance = f.state.boardMessageProvenance(target)[0];
  assert.ok(binding);
  assert.ok(provenance);
  const admission = f.state.beginBoardRefresh({
    requestId,
    target,
    content,
    preEditContent: 'old board',
    payloadHash: `hash-${requestId}`,
    binding,
    targetAuthorId: 'bot-1',
    provenance
  }, f.state.captureBoardRevision(target).revision);
  assert.equal(admission.status, 'admitted');
  assert.ok(admission.attemptId);
  return { target, attemptId: admission.attemptId };
}

function seedBoardOutcome(f, requestId, outcome) {
  const seeded = seedBoardAttempt(f, requestId);
  const recorded = f.state.recordBoardRefreshOutcome(seeded.target, seeded.attemptId, outcome, {
    operationEndedAt: '2026-01-01T00:00:00.000Z',
    error: `fixture ${outcome}`
  });
  assert.equal(recorded.outcome, outcome);
  return seeded;
}

function boardRecoverArgs(f, attemptId, evidence = recoveryEvidence()) {
  return [
    CLI_PATH,
    'recover',
    '--db', f.dbPath,
    '--board-guild-id', 'guild-1',
    '--board-channel-id', 'channel-1',
    '--board-message-id', 'target-1',
    '--board-attempt-id', attemptId,
    '--board-resolution', BOARD_OUTCOMES.APPLIED,
    '--board-evidence-scope', evidence.evidenceScope,
    '--board-readback-at', evidence.observedAt,
    '--board-readback', evidence.readbackContent,
    '--board-sole-writer', 'true',
    '--board-single-attempt', 'true',
    '--board-no-hidden-retry', 'true'
  ];
}

function runRecoverChild(f, attemptId, evidence = recoveryEvidence()) {
  const marker = path.join(f.dir, 'unexpected-recover-fetch.marker');
  const deadlineMarker = path.join(f.dir, 'recover-fixture-deadline.marker');
  const childScript = `
    const fs = require('node:fs');
    const { main } = require(${JSON.stringify(CLI_PATH)});
    global.fetch = async () => {
      fs.writeFileSync(process.env.DISCORD_SURFACE_UNEXPECTED_FETCH_MARKER, 'unexpected');
      throw new Error('unexpected fetch during board recovery');
    };
    process.argv = [process.execPath, ...JSON.parse(process.env.DISCORD_SURFACE_RECOVER_ARGS)];
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
  return runChild(['-e', childScript], {
    DISCORD_SURFACE_RECOVER_ARGS: JSON.stringify(boardRecoverArgs(f, attemptId, evidence)),
    DISCORD_SURFACE_UNEXPECTED_FETCH_MARKER: marker,
    DISCORD_SURFACE_FIXTURE_DEADLINE_MARKER: deadlineMarker,
    NODE_NO_WARNINGS: '1'
  }, { timeoutMs: 7000 }).then(child => ({ child, marker, deadlineMarker }));
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

test('already desired board is an honest no-op and target qualification rejects wrong authors', async t => {
  const f = fixture();
  t.after(() => f.state.close());
  const board = { content: 'same board' };
  const sameCalls = [];
  const same = await refresh(f, 'same board', 'refresh-noop', fakeFetch(board, sameCalls));
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
    return response({ id: 'target-1', guild_id: 'guild-1', channel_id: 'channel-1', author: { id: 'other-bot', bot: true }, content: 'same board' });
  };
  await assert.rejects(() => refresh(f, 'other board', 'refresh-wrong-author', wrongFetch), /not authored by this Discord installation/);
  assert.equal(wrongCalls.filter(call => call.init.method === 'PATCH').length, 0);
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
    if (init.method === 'GET') return response({ id: 'target-1', guild_id: 'guild-1', channel_id: 'channel-1', author: { id: 'bot-1', bot: true }, content: board.content });
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

test('board recovery returns applied history without writing a receipt', async t => {
  const f = fixture();
  t.after(() => f.state.close());
  const seeded = seedBoardOutcome(f, 'recover-applied', BOARD_OUTCOMES.APPLIED);
  const evidence = recoveryEvidence();
  const before = f.state.listReceipts();
  const binding = f.state.getBinding('channel-1');
  const recovered = f.state.reconcileBoardRefresh(seeded.target, seeded.attemptId, BOARD_OUTCOMES.APPLIED, evidence);
  assert.equal(recovered.status, BOARD_OUTCOMES.APPLIED);
  assert.equal(recovered.historical, true);
  assert.deepEqual(f.state.listReceipts(), before);
  assert.deepEqual(f.state.getBinding('channel-1'), binding);
});

test('board recovery refuses every terminal outcome except applied', async t => {
  for (const outcome of [
    BOARD_OUTCOMES.NO_OP,
    BOARD_OUTCOMES.STALE,
    BOARD_OUTCOMES.REJECTED,
    BOARD_OUTCOMES.RATE_LIMITED,
    BOARD_OUTCOMES.NOT_SENT
  ]) {
    const f = fixture();
    t.after(() => f.state.close());
    const seeded = seedBoardOutcome(f, `recover-${outcome}`, outcome);
    const evidence = recoveryEvidence();
    const before = f.state.listReceipts();
    const binding = f.state.getBinding('channel-1');
    assert.throws(
      () => f.state.reconcileBoardRefresh(seeded.target, seeded.attemptId, BOARD_OUTCOMES.APPLIED, evidence),
      new RegExp(`terminal outcome ${outcome}`)
    );
    assert.deepEqual(f.state.listReceipts(), before);
    assert.deepEqual(f.state.getBinding('channel-1'), binding);

    if ([BOARD_OUTCOMES.REJECTED, BOARD_OUTCOMES.RATE_LIMITED, BOARD_OUTCOMES.NOT_SENT].includes(outcome)) {
      f.state.close();
      const { child, marker, deadlineMarker } = await runRecoverChild(f, seeded.attemptId, evidence);
      assert.equal(child.timedOut, false);
      assert.equal(child.code, 1, `${outcome} child exited ${child.code} signal=${child.signal} stderr=${child.stderr} stdout=${child.stdout}`);
      assert.equal(child.signal, null);
      assert.equal(child.stdout, '');
      assert.equal(child.stderr, `board refresh attempt has terminal outcome ${outcome}\n`);
      assert.equal(fs.existsSync(marker), false);
      assert.equal(fs.existsSync(deadlineMarker), false);
      f.state = new SurfaceState(f.dbPath);
      assert.deepEqual(f.state.listReceipts(), before);
      assert.deepEqual(f.state.getBinding('channel-1'), binding);
    }
  }
});

test('board recovery preserves in-flight refusal and unknown evidence reconciliation', async t => {
  const missing = fixture();
  const unknown = fixture();
  t.after(() => missing.state.close());
  t.after(() => unknown.state.close());

  const missingSeed = seedBoardAttempt(missing, 'recover-missing');
  const missingBefore = missing.state.listReceipts();
  assert.equal(missing.state.inspectBoardRequest('recover-missing', missingSeed.target).status, BOARD_OUTCOMES.IN_FLIGHT);
  assert.throws(
    () => missing.state.reconcileBoardRefresh(missingSeed.target, missingSeed.attemptId, BOARD_OUTCOMES.APPLIED, recoveryEvidence()),
    /has no outcome to reconcile/
  );
  assert.deepEqual(missing.state.listReceipts(), missingBefore);

  const unknownSeed = seedBoardOutcome(unknown, 'recover-unknown', BOARD_OUTCOMES.UNKNOWN);
  const unknownBefore = unknown.state.listReceipts();
  const reconciled = unknown.state.reconcileBoardRefresh(unknownSeed.target, unknownSeed.attemptId, BOARD_OUTCOMES.APPLIED, recoveryEvidence());
  assert.equal(reconciled.status, BOARD_OUTCOMES.APPLIED);
  assert.equal(reconciled.reconciledFrom, BOARD_OUTCOMES.UNKNOWN);
  const afterReconcile = unknown.state.listReceipts();
  assert.equal(afterReconcile.length, unknownBefore.length + 1);
  assert.equal(JSON.parse(afterReconcile.at(-1).detail).outcome, BOARD_OUTCOMES.APPLIED);
  const beforeDuplicate = unknown.state.listReceipts();
  const duplicate = unknown.state.reconcileBoardRefresh(unknownSeed.target, unknownSeed.attemptId, BOARD_OUTCOMES.APPLIED, recoveryEvidence());
  assert.equal(duplicate.historical, true);
  assert.deepEqual(unknown.state.listReceipts(), beforeDuplicate);
});

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
              reply.end(JSON.stringify({ id: 'target-1', guild_id: 'guild-1', channel_id: 'channel-1', author: { id: 'bot-1', bot: true }, content: board.content }));
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
          reply.end(JSON.stringify({ id: 'target-1', guild_id: 'guild-1', channel_id: 'channel-1', author: { id: 'bot-1', bot: true }, content: board.content }));
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
