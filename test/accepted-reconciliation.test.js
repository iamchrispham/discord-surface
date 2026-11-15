const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { SurfaceState, MESSAGE_STATES, INTERACTION_ORIGIN } = require('../src/state');
const { createOwnerAdmission } = require('../src/discord/owner-admission');
const { createRecoveryCommands } = require('../src/cli/recovery-commands');
const { GATEWAY_CAPABILITIES } = require('../src/ordinary-bind/constants');
const { CODEX_ID, SUCCESSOR_ID, CLI_PATH, fixture } = require('./surface-fixtures');

function accepted(t) {
  const setup = fixture();
  const { state, dir } = setup;
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  state.bind({ channelId: 'channel-1', guildId: 'guild-1', provider: 'codex',
    nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  state.markIntakeBoundary('channel-1', 'ready');
  state.acceptDiscordMessage({ id: '101', guildId: 'guild-1', channelId: 'channel-1',
    authorId: 'operator-1', isBot: false, content: 'Expired diagnostic probe' }, { ready: true });
  return { ...setup, request: { messageId: '101', nativeId: CODEX_ID, generation: 1,
    evidenceScope: 'Expired diagnostic probe reviewed during successor recovery' } };
}

test('reviewed accepted custody is retired without native pickup or evidence loss', t => {
  const { state, db, request } = accepted(t);
  const before = state.db.prepare('SELECT * FROM messages WHERE discord_id=?').get('101');
  const receipts = state.db.prepare('SELECT * FROM receipts WHERE discord_id=? ORDER BY id').all('101');
  const result = state.reconcileAcceptedNotExecuted(request);
  assert.equal(result.message.state, MESSAGE_STATES.REJECTED);
  assert.equal(result.duplicate, false);
  const after = state.db.prepare('SELECT * FROM messages WHERE discord_id=?').get('101');
  for (const key of Object.keys(before)) {
    if (key !== 'state' && key !== 'updated_at') assert.deepEqual(after[key], before[key], key);
  }
  const recorded = state.db.prepare('SELECT * FROM receipts WHERE discord_id=? ORDER BY id').all('101');
  assert.deepEqual(recorded.slice(0, receipts.length), receipts);
  assert.equal(recorded.at(-1).kind, 'accepted-not-executed');
  assert.equal(JSON.parse(recorded.at(-1).detail).evidenceScope, request.evidenceScope);
  assert.equal(state.hasNativeAcknowledgment(result.message), false);
  assert.deepEqual(state.recoveryCandidates(), []);
  assert.equal(state.hasUnresolved('channel-1'), false);
  assert.equal(state.claimDispatch('101').claimed, false);
  const reopened = new SurfaceState(db);
  try { assert.equal(reopened.getMessage('101').state, MESSAGE_STATES.REJECTED); }
  finally { reopened.close(); }
});

test('identical reconciliation is idempotent and conflicting evidence is refused', t => {
  const { state, request } = accepted(t);
  state.reconcileAcceptedNotExecuted(request);
  const count = state.db.prepare('SELECT count(*) n FROM receipts').get().n;
  assert.equal(state.reconcileAcceptedNotExecuted(request).duplicate, true);
  assert.equal(state.db.prepare('SELECT count(*) n FROM receipts').get().n, count);
  assert.throws(() => state.reconcileAcceptedNotExecuted({ ...request, evidenceScope: 'different evidence' }));
  assert.equal(state.db.prepare('SELECT count(*) n FROM receipts').get().n, count);
});

test('unattempted status interactions retain their original acceptance evidence', t => {
  const { state, request } = accepted(t);
  const intake = state.acceptInteraction({ id: '102', guildId: 'guild-1', channelId: 'channel-1',
    userId: 'operator-1', content: '/cs', full: false }, state.getBinding('channel-1'));
  assert.equal(intake.accepted, true);
  const before = state.db.prepare('SELECT * FROM receipts WHERE discord_id=? ORDER BY id').all('102');
  assert.deepEqual(before.map(receipt => receipt.kind), [INTERACTION_ORIGIN]);
  const result = state.reconcileAcceptedNotExecuted({ ...request, messageId: '102' });
  assert.equal(result.message.state, MESSAGE_STATES.REJECTED);
  assert.equal(state.hasNativeAcknowledgment(result.message), false);
  assert.deepEqual(state.db.prepare('SELECT * FROM receipts WHERE discord_id=? ORDER BY id').all('102').slice(0, -1), before);
});

test('an accepted row without intake provenance stays held', t => {
  const { state, request } = accepted(t);
  state.db.prepare('DELETE FROM receipts WHERE discord_id=?').run('101');
  assert.throws(() => state.reconcileAcceptedNotExecuted(request));
  assert.equal(state.getMessage('101').state, MESSAGE_STATES.ACCEPTED);
});

test('reconciliation requires exact identity and a bounded evidence explanation', t => {
  const { state, request } = accepted(t);
  for (const changed of [{ nativeId: SUCCESSOR_ID }, { generation: 2 }, { generation: NaN },
    { evidenceScope: '' }, { evidenceScope: ' ' }, { evidenceScope: 'x'.repeat(2049) }, { evidenceScope: '\0' }]) {
    assert.throws(() => state.reconcileAcceptedNotExecuted({ ...request, ...changed }));
    assert.equal(state.getMessage('101').state, MESSAGE_STATES.ACCEPTED);
  }
  state.db.prepare('UPDATE bindings SET generation=generation+1 WHERE channel_id=?').run('channel-1');
  assert.throws(() => state.reconcileAcceptedNotExecuted(request));
  assert.equal(state.getMessage('101').state, MESSAGE_STATES.ACCEPTED);
});

test('every other message state refuses retirement', t => {
  const { state, request } = accepted(t);
  for (const status of Object.values(MESSAGE_STATES).filter(status => status !== MESSAGE_STATES.ACCEPTED)) {
    state.db.prepare('UPDATE messages SET state=? WHERE discord_id=?').run(status, '101');
    assert.throws(() => state.reconcileAcceptedNotExecuted(request), status);
    assert.equal(state.getMessage('101').state, status);
  }
});

test('accepted rows with prior native work or an unknown receipt remain held', t => {
  const { state, request } = accepted(t);
  for (const kind of ['dispatching', 'submitted', 'native-ack', 'courier-forward-claim', 'future-native-receipt']) {
    state.receipt('101', kind, {});
    assert.throws(() => state.reconcileAcceptedNotExecuted(request), kind);
    assert.equal(state.getMessage('101').state, MESSAGE_STATES.ACCEPTED);
    state.db.prepare('DELETE FROM receipts WHERE discord_id=? AND kind=?').run('101', kind);
  }
  for (const column of ['observer_cursor', 'observer_marker', 'reply_text', 'reply_nonce', 'reply_message_id', 'error']) {
    state.db.prepare(`UPDATE messages SET ${column}=? WHERE discord_id=?`).run('held evidence', '101');
    assert.throws(() => state.reconcileAcceptedNotExecuted(request), column);
    assert.equal(state.getMessage('101').state, MESSAGE_STATES.ACCEPTED);
    state.db.prepare(`UPDATE messages SET ${column}=NULL WHERE discord_id=?`).run('101');
  }
});

test('a dispatch committed by a second connection wins over reconciliation', t => {
  const { state, db, request } = accepted(t);
  const other = new SurfaceState(db);
  const transaction = state.transaction.bind(state);
  state.transaction = action => {
    other.claimDispatch('101');
    return transaction(action);
  };
  try {
    assert.throws(() => state.reconcileAcceptedNotExecuted(request));
    assert.equal(other.getMessage('101').state, MESSAGE_STATES.DISPATCHING);
    assert.equal(other.db.prepare('SELECT count(*) n FROM receipts WHERE kind=?').get('accepted-not-executed').n, 0);
  } finally { other.close(); }
});

test('retiring an accepted head releases the owner queue without manufacturing an ACK', async t => {
  const { state, request } = accepted(t);
  const admission = createOwnerAdmission({ state, compareDiscordIds: (a, b) => Number(BigInt(a) - BigInt(b)) });
  await admission.enqueueOwnerWork(state.getMessage('101'), null, (finish, entry) => {
    entry.dispatchBlocked = true;
    finish();
    return { status: 'not_submitted' };
  });
  state.acceptDiscordMessage({ id: '102', guildId: 'guild-1', channelId: 'channel-1',
    authorId: 'operator-1', isBot: false, content: 'Current instruction' }, { ready: true });
  let started = false;
  await admission.enqueueOwnerWork(state.getMessage('102'), null, finish => {
    started = true;
    finish();
    return { status: 'not_submitted' };
  }, true, true);
  assert.equal(started, false);
  state.reconcileAcceptedNotExecuted(request);
  assert.equal(admission.releaseHandledWithoutPost(), true);
  assert.equal(started, true);
  assert.equal(state.hasNativeAcknowledgment(state.getMessage('101')), false);
});

test('public recovery command records the selected disposition and rejects incomplete input', t => {
  const { state, db, dir, request } = accepted(t);
  const args = [CLI_PATH, 'recover', '--state-dir', dir, '--db', db, '--message-id', '101',
    '--resolution', 'not_executed', '--native-id', CODEX_ID, '--generation', '1'];
  const options = { encoding: 'utf8', timeout: 20000 };
  const missing = spawnSync(process.execPath, args, options);
  assert.notEqual(missing.status, 0);
  assert.equal(state.getMessage('101').state, MESSAGE_STATES.ACCEPTED);
  const result = spawnSync(process.execPath, [...args, '--evidence-scope', request.evidenceScope], options);
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.messageId, '101');
  assert.equal(response.state, MESSAGE_STATES.REJECTED);
  assert.equal(response.duplicate, false);
  assert.equal(response.gatewayWake.requested, false);
  const duplicate = spawnSync(process.execPath, [...args, '--evidence-scope', request.evidenceScope], options);
  assert.equal(duplicate.status, 0, duplicate.stderr);
  assert.equal(JSON.parse(duplicate.stdout).duplicate, true);
});

test('recovery refuses incompatible live Gateways and wakes a compatible exact process', t => {
  const { state, db, request } = accepted(t);
  let runtime;
  let wake;
  const { recover } = createRecoveryCommands({
    required: (args, key) => args[key],
    openState: () => ({ paths: {}, state: new SurfaceState(db) }),
    print: () => {}, gatewayProcessStatus: () => runtime,
    requestGatewayRecovery: (_paths, options) => { wake = options; return { requested: true }; },
    GATEWAY_CAPABILITIES
  });
  const args = { 'message-id': '101', resolution: 'not_executed', 'native-id': CODEX_ID,
    generation: '1', 'evidence-scope': request.evidenceScope };
  for (const refused of [null, { state: 'unknown' }, { state: 'running', pid: 42, capabilities: [] },
    { state: 'running', pid: true, capabilities: [] }, { state: 'running', pid: 42, capabilities: 'invalid' }]) {
    runtime = refused;
    assert.throws(() => recover(args));
    assert.equal(state.getMessage('101').state, MESSAGE_STATES.ACCEPTED);
    assert.equal(wake, undefined);
  }
  runtime = { state: 'running', pid: 42, capabilities: [GATEWAY_CAPABILITIES.acceptedCustodyReconciliation] };
  recover(args);
  assert.equal(state.getMessage('101').state, MESSAGE_STATES.REJECTED);
  assert.equal(wake.expectedPid, 42);
  assert.equal(wake.requiredCapability, GATEWAY_CAPABILITIES.acceptedCustodyReconciliation);
});
