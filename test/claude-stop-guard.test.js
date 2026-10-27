'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { SurfaceState, MESSAGE_STATES, NATIVE_ACK_RECEIPT, PROVIDERS, READINESS } = require('../src/state');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const { STOP_GUARD_VOCABULARY } = require('../src/claude-stop-guard');

const CLI_PATH = path.resolve(__dirname, '../src/cli.js');
const CLAUDE_ID = '5d1c7f2e-8a4b-4c3d-9e6f-0a1b2c3d4e5f';
const OTHER_CLAUDE_ID = '6e2d8a3f-9b5c-4d4e-8f70-1b2c3d4e5f60';
const GUILD_ID = '100';
const OPERATOR_ID = '900';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-stop-guard-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: OPERATOR_ID, guildId: GUILD_ID, secretFile: path.join(dir, 'secret') });
  for (const [channelId, nativeId] of [['101', CLAUDE_ID], ['102', OTHER_CLAUDE_ID]]) {
    state.bind({
      channelId, guildId: GUILD_ID, provider: 'claude', nativeId,
      workspace: dir, endpoint: path.join(dir, `${channelId}.sock`)
    }, { intakeCutoff: '100' });
    state.setBindingReadiness(channelId, READINESS.READY, 'stop guard fixture ready', state.getBinding(channelId));
  }
  return { dir, db, state };
}

function dispose(f) {
  try { f.state.close(); } catch {}
  fs.rmSync(f.dir, { recursive: true, force: true });
}

function accept(f, id, channelId = '101') {
  const accepted = f.state.acceptDiscordMessage({
    id, guildId: GUILD_ID, channelId, authorId: OPERATOR_ID, isBot: false, attachments: [], content: 'Stop guard request.'
  });
  assert.equal(accepted.accepted, true, `intake rejected: ${accepted.reason}`);
  return f.state.getMessage(id);
}

function hand(f, id, channelId = '101') {
  accept(f, id, channelId);
  assert.equal(f.state.claimDispatch(id).claimed, true);
  f.state.markSubmitted(id);
  const message = f.state.getMessage(id);
  assert.equal(message.state, MESSAGE_STATES.SUBMITTED);
  return message;
}

function runGuard(db, event) {
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI_PATH, 'claude-stop-guard', '--db', db], {
    input: JSON.stringify(event), encoding: 'utf8', timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('blocks the stop while a handed message is unacknowledged', () => {
  const f = fixture();
  try {
    const message = hand(f, '2001');
    const decision = JSON.parse(runGuard(f.db, { session_id: CLAUDE_ID, stop_hook_active: false }));
    assert.equal(decision.decision, 'block');
    assert.ok(decision.reason.includes(`messageId "2001" generation ${message.generation}`), decision.reason);
    assert.match(decision.reason, /ToolSearch/);
  } finally { dispose(f); }
});

test('stays silent once the message is acknowledged', () => {
  const f = fixture();
  try {
    const message = hand(f, '2002');
    const ack = recordNativeAcknowledgment(f.state, {
      provider: 'claude', messageId: '2002', nativeId: CLAUDE_ID, generation: message.generation
    });
    assert.equal(ack.recorded, true);
    assert.equal(runGuard(f.db, { session_id: CLAUDE_ID, stop_hook_active: false }), '');
  } finally { dispose(f); }
});

test('does not block a stop that a previous block already continued', () => {
  const f = fixture();
  try {
    hand(f, '2003');
    assert.equal(runGuard(f.db, { session_id: CLAUDE_ID, stop_hook_active: true }), '');
  } finally { dispose(f); }
});

test('ignores messages handed to another session and messages not yet handed', () => {
  const f = fixture();
  try {
    hand(f, '2004', '102');
    accept(f, '2005');
    assert.equal(runGuard(f.db, { session_id: CLAUDE_ID, stop_hook_active: false }), '');
    assert.match(JSON.parse(runGuard(f.db, { session_id: OTHER_CLAUDE_ID, stop_hook_active: false })).reason, /messageId "2004"/);
  } finally { dispose(f); }
});

test('ignores a handed message from a binding generation that moved on', () => {
  const f = fixture();
  try {
    hand(f, '2007');
    f.state.db.prepare('UPDATE bindings SET generation = generation + 1 WHERE channel_id = ?').run('101');
    assert.equal(runGuard(f.db, { session_id: CLAUDE_ID, stop_hook_active: false }), '');
  } finally { dispose(f); }
});

test('ignores a handed message whose binding is inactive', () => {
  const f = fixture();
  try {
    hand(f, '2008');
    f.state.db.prepare('UPDATE bindings SET active = 0 WHERE channel_id = ?').run('101');
    assert.equal(runGuard(f.db, { session_id: CLAUDE_ID, stop_hook_active: false }), '');
  } finally { dispose(f); }
});

test('fails open without a database or a session id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-stop-guard-missing-'));
  try {
    const missing = path.join(dir, 'surface.sqlite');
    assert.equal(runGuard(missing, { session_id: CLAUDE_ID, stop_hook_active: false }), '');
    assert.equal(fs.existsSync(missing), false);
    const f = fixture();
    try {
      hand(f, '2006');
      assert.equal(runGuard(f.db, { stop_hook_active: false }), '');
    } finally { dispose(f); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('guard vocabulary matches the state owner', () => {
  assert.deepEqual(STOP_GUARD_VOCABULARY, {
    SUBMITTED: MESSAGE_STATES.SUBMITTED, CLAUDE: PROVIDERS.CLAUDE, NATIVE_ACK: NATIVE_ACK_RECEIPT
  });
});
