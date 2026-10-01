'use strict';
// Private fixture for the courier-input suite. Ownership stays with that suite:
// this module only copies the supported public setup that test/courier-route.test.js
// already exercises, plus disposable database snapshots for refusal proofs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { acknowledgmentCommand } = require('../src/acknowledgment');
const { agentCompletionCommand, codexPrompt, readInitialCursor } = require('../src/native');
const { COURIER_OUTCOMES, SurfaceState, THREAD_STATES } = require('../src/state');

const TOKEN = 'courier-route-fixture-token';
const PARENT_NATIVE = '11111111-1111-1111-1111-111111111111';
const SOURCE_NATIVE = '22222222-2222-2222-2222-222222222222';
const COURIER_NATIVE = '33333333-3333-3333-3333-333333333333';
const RECIPIENT_THREAD = PARENT_NATIVE;

const CLI_PATH = path.resolve(__dirname, '..', 'src', 'cli.js');
const TIMEOUT_MS = 5000;
const MAX_BUFFER = 1024 * 1024;

function createCourierFixture(t, { hostId = 'host-local', dbDirName = null, prompt = 'forward this prepared parent instruction' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-courier-input-'));
  let state = null;
  t.after(() => {
    try { if (state) state.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const sessionRoot = path.join(dir, 'sessions');
  fs.mkdirSync(sessionRoot, { recursive: true });
  const sessionFile = path.join(sessionRoot, `${PARENT_NATIVE}.jsonl`);
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: 'session_meta', payload: { id: PARENT_NATIVE, session_id: PARENT_NATIVE } })}\nfixture transcript\n`);

  // A nested database directory lets case 2 make shell quoting observable in argv.
  const dbDir = dbDirName === null ? dir : path.join(dir, dbDirName);
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'surface.sqlite');

  state = new SurfaceState(dbPath);
  state.setConfig({ operatorId: 'operator', guildId: '100', secretFile: path.join(dir, 'secret') });
  state.bind({ channelId: '1000', guildId: '100', provider: 'codex', nativeId: PARENT_NATIVE, workspace: dir, sessionRoot }, { intakeCutoff: '100' });
  const binding = state.getBinding('1000');
  state.enrollThread({ threadId: '2000', parentChannelId: '1000', guildId: '100', adoptionCutoff: '100' }, binding);
  state.setThreadBaseline('2000', null, binding);
  state.markThreadBoundary('2000', THREAD_STATES.READY, 'courier input fixture', null, null, binding);

  const accepted = state.acceptDiscordMessage({
    id: '9100',
    guildId: '100',
    channelId: '1000',
    authorId: 'operator',
    isBot: false,
    attachments: [],
    content: prompt
  }, { ready: true, expectedBinding: binding });
  assert.equal(accepted.accepted, true, `fixture message refused: ${accepted.reason}`);

  const route = {
    routeId: 'route-1',
    routeGeneration: 1,
    guildId: '100',
    parentChannelId: '1000',
    deliveryChannelId: '2000',
    target: { guildId: '100', channelId: '2000', provider: 'codex', nativeId: PARENT_NATIVE, generation: binding.generation },
    courier: {
      provider: 'codex',
      nativeId: COURIER_NATIVE,
      workspace: dir,
      sessionRoot,
      recipientThreadId: RECIPIENT_THREAD,
      hostId
    }
  };
  state.registerCourierRoute(route);

  return {
    dir,
    workspace: dir,
    sessionRoot,
    sessionFile,
    dbPath,
    hostId,
    prompt,
    route,
    binding,
    get state() { return state; },
    get message() { return state.getMessage('9100'); }
  };
}

function parentPrompt(state, message) {
  const completion = message.agentMessage
    ? agentCompletionCommand(message, state.dbPath, undefined, path.dirname(state.dbPath))
    : null;
  return codexPrompt(message, acknowledgmentCommand(message, state.dbPath), completion);
}

function persistedSubmittedAttempt(f, messageId = f.message.id) {
  const message = f.state.getMessage(messageId);
  const input = {
    routeId: f.route.routeId,
    prompt: parentPrompt(f.state, message),
    observerCursor: readInitialCursor(message.nativeId, f.sessionFile)
  };
  assert.equal(f.state.claimDispatch(messageId).claimed, true);
  const started = f.state.beginCourierAttempt(messageId, input);
  assert.equal(started.accepted, true, `fixture attempt refused: ${started.status}`);
  f.state.recordCourierOutcome(messageId, started.attempt.attemptId, COURIER_OUTCOMES.SUBMITTED);
  f.state.markSubmitted(messageId);
  return { messageId, attemptId: started.attempt.attemptId, envelope: started.envelope, prompt: input.prompt };
}

function snapshotAllTables(state) {
  const tables = state.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const snapshot = {};
  for (const { name } of tables) {
    const columns = state.db.prepare(`PRAGMA table_info("${name}")`).all().map(column => column.name);
    const order = columns.length === 0 ? '' : ` ORDER BY ${columns.map(column => `"${column}"`).join(', ')}`;
    snapshot[name] = state.db.prepare(`SELECT * FROM "${name}"${order}`).all().map(row => ({ ...row }));
  }
  return snapshot;
}

function readArgvFor(f, { messageId, attemptId, nativeId = COURIER_NATIVE } = {}) {
  return [
    process.execPath,
    '--disable-warning=ExperimentalWarning',
    CLI_PATH,
    'courier-input',
    '--db', f.dbPath,
    '--courier-route-id', f.route.routeId,
    '--message-id', messageId,
    '--attempt-id', attemptId,
    '--native-id', nativeId
  ];
}

function runCourierInput(f, { cwd = f.workspace, env = {}, ...selection } = {}) {
  const argv = readArgvFor(f, selection);
  return spawnSync(argv[0], argv.slice(1), {
    cwd,
    env: {
      ...process.env,
      CODEX_SESSION_ID: COURIER_NATIVE,
      CODEX_THREAD_ID: COURIER_NATIVE,
      ...env
    },
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER
  });
}

module.exports = {
  TOKEN,
  PARENT_NATIVE,
  SOURCE_NATIVE,
  COURIER_NATIVE,
  RECIPIENT_THREAD,
  createCourierFixture,
  persistedSubmittedAttempt,
  snapshotAllTables,
  runCourierInput,
  readArgvFor
};
