const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SurfaceState, BOARD_OUTCOMES, READINESS } = require('../src/state');
const { runBoardRefresh } = require('../src/board-refresh');
const { hashBoardText } = require('../src/discord/board-refresh');
const STATE_PATH = path.resolve(__dirname, '../src/state');
const DISCORD_PATH = path.resolve(__dirname, '../src/discord');

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
  }, { intakeCutoff: '100' });
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

async function waitForFile(file, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return fs.readFileSync(file, 'utf8');
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, body: { cancel() {} } };
}

function boardChannelResponse() {
  return response({ id: 'channel-1', guild_id: 'guild-1' });
}

function boardMessageResponse(content, authorId = 'bot-1') {
  return response({ id: 'target-1', channel_id: 'channel-1', author: { id: authorId, bot: true }, content });
}

function fakeFetch(board, calls) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/users/@me')) return response({ id: 'bot-1' });
    if (init.method === 'GET' && url.endsWith('/channels/channel-1')) return boardChannelResponse();
    if (init.method === 'GET') return boardMessageResponse(board.content);
    if (init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      board.content = body.content;
      return boardMessageResponse(board.content);
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
    resolveBinding: resolver,
    bindingCurrent: options.bindingCurrent,
    assertCallerCurrent: options.assertCallerCurrent
  });
}

function spawnChild(args, env = {}, options = {}) {
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
  const result = new Promise(resolve => {
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
  return { child, result };
}

function runChild(args, env = {}, options = {}) {
  return spawnChild(args, env, options).result;
}

function boardRefreshArgs(f, requestId, options = {}) {
  return [
    CLI_PATH,
    'board-refresh',
    '--db', f.dbPath,
    '--native-id', options.nativeId || NATIVE_ID,
    '--generation', String(options.generation || 1),
    '--channel-id', 'channel-1',
    '--message-id', 'target-1',
    '--text-file', options.textFile || f.textFile,
    '--dedupe-key', requestId
  ];
}

function boardTarget() {
  return { guildId: 'guild-1', channelId: 'channel-1', messageId: 'target-1' };
}

function recoveryEvidence(content = 'new board', observedAt = '2026-01-01T00:00:01.000Z') {
  return {
    evidenceScope: 'local fixture readback',
    observedAt,
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

function rewriteBoardAttemptContent(f, attemptId, content) {
  const row = f.state.db.prepare("SELECT id, detail FROM receipts WHERE kind='board-refresh-attempt' AND json_extract(detail, '$.attemptId')=?").get(attemptId);
  assert.ok(row);
  const detail = JSON.parse(row.detail);
  f.state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(
    JSON.stringify({ ...detail, content, payloadHash: hashBoardText(content) }),
    row.id
  );
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

module.exports = {
  test, assert, fs, http, os, path, spawn,
  SurfaceState, BOARD_OUTCOMES, READINESS, runBoardRefresh, hashBoardText,
  NATIVE_ID, SUCCESSOR_ID, CLI_PATH, STATE_PATH, DISCORD_PATH,
  fixture, deferred, waitFor, waitForFile, response, boardChannelResponse, boardMessageResponse,
  fakeFetch, refresh, spawnChild, runChild, boardRefreshArgs, boardTarget, recoveryEvidence,
  seedBoardAttempt, rewriteBoardAttemptContent, seedBoardOutcome, boardRecoverArgs, runRecoverChild
};
