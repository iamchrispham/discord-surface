const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createWatcherNotice,
  decodeWatcherNotice,
  encodeWatcherNotice,
  watcherNoticeId
} = require('../src/watcher-notice');
const {
  AuthorizationError,
  MESSAGE_STATES,
  READINESS,
  StaleGenerationError,
  SurfaceState
} = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { runWatcherNoticePost } = require('../src/direct-post');
const { codexPrompt, watcherNoticeCompletionCommand } = require('../src/native');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const { GATEWAY_CAPABILITIES, watcherSend } = require('../src/cli');

const token = 'codex-watcher-fixture-token';
const nativeId = '22222222-2222-2222-2222-222222222222';
const siblingNativeId = '33333333-3333-3333-3333-333333333333';

const claudeOwner = { guildId: '100', channelId: '101', provider: 'claude', nativeId, generation: 1 };
const claudeChild = { ...claudeOwner, channelId: '102' };
const codexOwner = { ...claudeOwner, provider: 'codex' };
const codexChild = { ...codexOwner, channelId: '102' };

const codexCaller = (id = nativeId) => ({ harness: 'codex', sessionId: id, threadId: id });
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function codexFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-watcher-notice-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: '900', guildId: codexOwner.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...codexOwner, workspace: dir, endpoint: null, conductorId: 'watcher-conductor', repoKey: 'repo:watcher' }, { intakeCutoff: '100' });
  let binding = state.getBinding(codexOwner.channelId);
  binding = state.setBindingReadiness(codexOwner.channelId, READINESS.READY, 'codex watcher fixture ready', binding);
  state.enrollThread({ threadId: codexChild.channelId, parentChannelId: codexOwner.channelId, guildId: codexOwner.guildId, adoptionCutoff: '100' }, binding);
  state.setThreadBaseline(codexChild.channelId, '1000', binding);
  state.markThreadBoundary(codexChild.channelId, THREAD_STATES.READY, 'codex watcher fixture adopted', null, null, binding);
  return { dir, state, armKey: 'codex-watcher-arm' };
}

function armInput(armKey, overrides = {}) {
  return {
    armKey,
    parentChannelId: codexOwner.channelId,
    childChannelId: codexChild.channelId,
    provider: 'codex',
    nativeId,
    generation: codexOwner.generation,
    caller: codexCaller(),
    ...overrides
  };
}

function armReceipts(state) {
  return state.listReceipts().filter(row => row.kind === 'watcher-notice-arm');
}

test('Claude watcher codec retains signed target compatibility', () => {
  const packet = createWatcherNotice({
    armKey: 'claude-arm', triggerKey: 'claude-trigger', source: claudeOwner, target: claudeChild, text: 'Claude notice body'
  });
  assert.equal(packet.id, watcherNoticeId('claude-arm', 'claude-trigger'));
  const wire = encodeWatcherNotice(packet, token);
  assert.deepEqual(decodeWatcherNotice(wire, token, claudeChild), packet);
  assert.throws(() => decodeWatcherNotice(wire, 'other-fixture-token', claudeChild), /invalid watcher notice signature/);
  assert.throws(() => decodeWatcherNotice(wire, token, { ...claudeChild, generation: 2 }), /stale or mismatched/);
});

test('Codex watcher codec binds signed provider and target', () => {
  const packet = createWatcherNotice({
    armKey: 'codex-arm', triggerKey: 'codex-trigger', source: codexOwner, target: codexChild, text: 'Codex notice body'
  });
  assert.equal(packet.id, watcherNoticeId('codex-arm', 'codex-trigger'));
  assert.equal(packet.source.provider, 'codex');
  assert.equal(packet.target.provider, 'codex');
  const wire = encodeWatcherNotice(packet, token);
  assert.deepEqual(decodeWatcherNotice(wire, token, codexChild), packet);
  assert.throws(() => decodeWatcherNotice(wire, 'other-fixture-token', codexChild), /invalid watcher notice signature/);
  assert.throws(() => decodeWatcherNotice(wire, token, { ...codexChild, generation: 2 }), /stale or mismatched/);
  assert.throws(() => decodeWatcherNotice(wire, token, { ...codexChild, provider: 'claude' }), /stale or mismatched/);
  assert.throws(() => decodeWatcherNotice(wire, token, { ...codexChild, nativeId: siblingNativeId }), /stale or mismatched/);
  assert.throws(() => createWatcherNotice({
    armKey: 'unknown-arm', triggerKey: 'unknown-trigger',
    source: { ...codexOwner, provider: 'gemini' }, target: { ...codexChild, provider: 'gemini' }, text: 'Unknown provider body'
  }), /invalid watcher notice/);
});

test('Codex watcher arm freezes authenticated owner and rejects route changes', () => {
  const f = codexFixture();
  try {
    const armed = f.state.armWatcherNotice(armInput(f.armKey));
    assert.equal(armed.armed, true);
    assert.equal(armed.duplicate, false);
    assert.equal(armed.arm.provider, 'codex');
    assert.deepEqual(armed.arm.source, codexOwner);
    assert.deepEqual(armed.arm.target, codexChild);
    assert.equal(armed.arm.generation, codexOwner.generation);
    assert.equal(armed.arm.endpoint, null);
    assert.deepEqual(f.state.getWatcherNoticeArm(f.armKey), armed.arm);

    const duplicate = f.state.armWatcherNotice(armInput(f.armKey));
    assert.equal(duplicate.armed, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(armReceipts(f.state).length, 1);

    const refusals = [
      { key: 'sibling-caller-arm', overrides: { caller: codexCaller(siblingNativeId) }, type: AuthorizationError, message: /caller identity/ },
      { key: 'stale-generation-arm', overrides: { generation: 2 }, type: StaleGenerationError, message: /owner is stale/ },
      { key: 'parent-as-child-arm', overrides: { childChannelId: codexOwner.channelId }, type: StaleGenerationError, message: /child route is not ready/ },
      { key: 'unenrolled-child-arm', overrides: { childChannelId: '103' }, type: StaleGenerationError, message: /child route is not ready/ }
    ];
    for (const refusal of refusals) {
      assert.throws(() => f.state.armWatcherNotice(armInput(refusal.key, refusal.overrides)), error =>
        error instanceof refusal.type && refusal.message.test(error.message), refusal.key);
      assert.equal(f.state.getWatcherNoticeArm(refusal.key), null, refusal.key);
    }
    assert.equal(armReceipts(f.state).length, 1);
  } finally {
    f.state.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('Codex watcher publication reaches enrolled custody and consumes only after ACK', async () => {
  const f = codexFixture();
  const textFile = path.join(f.dir, 'notice.txt');
  fs.writeFileSync(textFile, 'Codex watcher result: review is complete.');
  const requests = [];
  let postedBody;
  const identity = { messageId: '2001', provider: 'codex', nativeId, generation: codexOwner.generation, channelId: codexChild.channelId };
  try {
    const armed = f.state.armWatcherNotice(armInput(f.armKey));
    assert.equal(armed.armed, true);

    const sent = await runWatcherNoticePost({
      state: f.state,
      token,
      armKey: f.armKey,
      triggerKey: 'codex-verdict-watch',
      textFile,
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), method: options.method });
        if (options.method === 'GET') return response(200, { id: codexChild.channelId, guild_id: codexChild.guildId });
        postedBody = JSON.parse(options.body);
        return response(200, { id: '2001' });
      }
    });
    assert.equal(sent.status, 'sent');
    assert.equal(sent.provider, 'codex');
    assert.deepEqual(requests.map(request => request.method), ['GET', 'POST']);
    assert.match(requests[0].url, /\/channels\/102$/);
    assert.match(requests[1].url, /\/channels\/102\/messages$/);
    const packet = decodeWatcherNotice(postedBody.content, token, codexChild);
    assert.deepEqual(packet.target, codexChild);
    assert.deepEqual(packet.source, codexOwner);

    const accepted = f.state.acceptDiscordMessage({
      id: '2001', guildId: codexChild.guildId, channelId: codexChild.channelId, authorId: '901', isBot: true,
      attachments: [], content: postedBody.content
    }, { agentToken: token });
    assert.equal(accepted.accepted, true);
    assert.equal(f.state.claimDispatch('2001').claimed, true);
    f.state.markSubmitted('2001');
    const hydrated = f.state.getMessage('2001');
    assert.equal(hydrated.provider, 'codex');
    assert.deepEqual(hydrated.watcherNotice, packet);

    assert.throws(() => f.state.consumeWatcherNotice(identity), /native acknowledgment/);
    assert.equal(f.state.getMessage('2001').state, MESSAGE_STATES.SUBMITTED);
    recordNativeAcknowledgment(f.state, {
      provider: 'codex', messageId: '2001', nativeId, generation: codexOwner.generation
    });
    const consumed = f.state.consumeWatcherNotice(identity);
    assert.equal(consumed.consumed, true);
    assert.equal(consumed.message.state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
    const duplicate = f.state.consumeWatcherNotice(identity);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.consumed, false);
    assert.equal(f.state.getMessage('2001').state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
    assert.equal(f.state.listReceipts().filter(row => row.kind === 'watcher-notice-consumed').length, 1);
  } finally {
    f.state.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('Codex watcher pickup requires consume and suppresses ordinary reply', () => {
  const watcherNotice = createWatcherNotice({
    armKey: 'codex-pickup-arm', triggerKey: 'codex-pickup-trigger', source: codexOwner, target: codexChild,
    text: 'Codex watcher pickup body.'
  });
  const message = {
    id: 'codex-watcher-event',
    channelId: codexChild.channelId,
    guildId: codexChild.guildId,
    provider: 'codex',
    nativeId,
    generation: codexOwner.generation,
    workspace: '/tmp/work',
    content: 'carrier',
    attachments: [],
    state: 'accepted',
    watcherNotice
  };
  const acknowledgment = ['/usr/local/bin/node', '/tmp/cli.js', 'native-ack', '--db', '/tmp/state with spaces.sqlite',
    '--provider', 'codex', '--message-id', message.id, '--native-id', nativeId, '--generation', String(message.generation)];
  const completion = watcherNoticeCompletionCommand(message, '/tmp/state with spaces.sqlite', '/tmp/cli.js', '/tmp/state with spaces');

  const prompt = codexPrompt(message, acknowledgment, completion);
  assert.ok(prompt.includes(JSON.stringify(acknowledgment)));
  assert.ok(prompt.includes(JSON.stringify(completion)));
  assert.equal(completion[2], 'watcher-consume');
  assert.ok(prompt.includes(watcherNotice.id));
  assert.ok(prompt.includes('Codex watcher pickup body.'));
  assert.match(prompt, new RegExp(`Codex session ${nativeId}, generation 1`));
  assert.match(prompt, /Do not .*Discord reply/);
  assert.doesNotMatch(prompt, /\[\[discord-surface:/);
  assert.doesNotMatch(prompt, /Final reply: start with|Answer the user request/);
  assert.ok(prompt.indexOf(JSON.stringify(acknowledgment)) < prompt.indexOf(JSON.stringify(completion)));

  const open = codexPrompt(message, acknowledgment, null);
  assert.match(open, /keep[^.]*open/i);
  assert.match(open, /Do not .*Discord reply/);
  assert.doesNotMatch(open, /\[\[discord-surface:/);
  assert.doesNotMatch(open, /Final reply: start with|Answer the user request/);
  assert.doesNotMatch(open, /watcher-consume/);
});

test('Codex watcher send refuses the Claude-only capability before network or trigger custody', async () => {
  const f = codexFixture();
  const textFile = path.join(f.dir, 'notice.txt');
  fs.writeFileSync(textFile, 'Codex watcher capability gate.');
  try {
    assert.equal(f.state.armWatcherNotice(armInput(f.armKey)).armed, true);
    let fetchCalls = 0;
    await assert.rejects(watcherSend({
      'state-dir': f.dir,
      db: path.join(f.dir, 'surface.sqlite'),
      'arm-key': f.armKey,
      'trigger-key': 'capability-gate',
      'text-file': textFile
    }, {
      gatewayProcessStatus: () => ({
        state: 'running',
        pid: 7101,
        capabilities: [GATEWAY_CAPABILITIES.watcherNoticeIngress]
      }),
      fetchImpl: async () => { fetchCalls += 1; throw new Error('network should not be reached'); },
      print: () => {}
    }), /watcher notice ingress/);
    assert.equal(fetchCalls, 0);
    assert.equal(f.state.findWatcherNotice(f.armKey, 'capability-gate'), null);
    assert.equal(f.state.listReceipts().filter(row => row.kind === 'watcher-notice-trigger').length, 0);
  } finally {
    f.state.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
