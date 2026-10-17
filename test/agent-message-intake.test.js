const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { encodeAgentMessage, KINDS } = require('../src/agent-message');
const { SurfaceState, READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { AGENT_PRESENTATIONS } = require('../src/agent-presentation');
const { currentPeerDestination } = require('../dist/peer/resolution');
const { agentCompletionCommand, codexPrompt, claudeEvent, messageRequest } = require('../src/native');
const { createMonitorMcp, monitorEvent } = require('../src/claude-monitor');
const { source, target, packet, token, enrollChild } = require('./agent-message-fixtures');

test('durable agent intake survives reopen, preserves provenance and deduplicates replay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-packet-'));
  const db = path.join(dir, 'surface.sqlite');
  let state = new SurfaceState(db);
  try {
    state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'claude.sock') }, { intakeCutoff: '100' });
    const destination = enrollChild(state, target, '103', null);
    const addressed = { ...packet, target: destination };
    const event = { id: '1001', guildId: destination.guildId, channelId: destination.channelId, authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(addressed, token) };
    assert.equal(state.acceptDiscordMessage(event, { agentToken: 'wrong' }).accepted, false);
    const intake = state.acceptDiscordMessage(event, { agentToken: token });
    assert.equal(intake.accepted, true);
    assert.equal(intake.message.authorId, '901');
    assert.equal(state.currentMessageBinding(intake.message).current, true);
    assert.equal(state.acceptDiscordMessage({ ...event, id: '1002' }, { agentToken: token }).accepted, false);
    assert.equal(state.listMessages().length, 1);
    state.close();
    state = new SurfaceState(db);
    const restored = state.getMessage(event.id);
    assert.deepEqual(restored.agentMessage, addressed);
    assert.equal(restored.agentPresentation, undefined);
    assert.equal(state.currentMessageBinding(restored).current, true);
    assert.match(codexPrompt(restored), /not as the operator/);
    assert.match(claudeEvent(restored).content, /not as the operator/);
    assert.ok(codexPrompt(restored).includes(packet.text));
    assert.equal(state.acceptDiscordMessage({ ...event, id: '1003', content: 'Ordinary bot milestone' }, { agentToken: token }).accepted, false);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('authenticated request freezes readable presentation for a local source through reopen and all native callers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-readable-request-'));
  const db = path.join(dir, 'surface.sqlite');
  let state = new SurfaceState(db);
  const stdout = new EventEmitter();
  const events = [];
  stdout.write = (chunk, callback) => {
    events.push(JSON.parse(String(chunk)));
    callback?.();
    return true;
  };
  try {
    state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'target.sock') }, { intakeCutoff: '100' });
    const destination = enrollChild(state, target, '103', null);
    state.bind({ ...source, workspace: dir, endpoint: path.join(dir, 'source.sock') }, { intakeCutoff: '100' });
    const sourceBinding = state.getBinding(source.channelId);
    state.setBindingReadiness(source.channelId, READINESS.READY, 'local requester ready', sourceBinding);
    assert.equal(state.acceptDiscordMessage({
      id: '1090', guildId: sourceBinding.guildId, channelId: sourceBinding.channelId,
      authorId: '900', isBot: false, attachments: [], content: 'Requester route is ready.'
    }).accepted, true);
    const localSource = {
      guildId: sourceBinding.guildId,
      channelId: sourceBinding.channelId,
      provider: sourceBinding.provider,
      nativeId: sourceBinding.nativeId,
      generation: sourceBinding.generation
    };
    const addressed = { ...packet, source: localSource, target: destination };
    assert.equal(addressed.kind, KINDS.REQUEST);
    assert.equal(currentPeerDestination(state, localSource), true);
    const event = {
      id: '1101', guildId: destination.guildId, channelId: destination.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(addressed, token)
    };

    assert.equal(state.acceptDiscordMessage(event, { agentToken: 'wrong' }).accepted, false);
    state.failNextIntakeFlag = true;
    assert.throws(() => state.acceptDiscordMessage({ ...event, id: '1100' }, { agentToken: token }), /injected intake transaction failure/);
    assert.equal(state.getMessage('1100'), null);
    assert.equal(state.getAgentMessage('1100'), null);
    assert.equal(state.acceptDiscordMessage(event, { agentToken: token }).accepted, true);
    const firstReceipt = state.getAgentMessage(event.id);
    assert.equal(firstReceipt.agentPresentation, AGENT_PRESENTATIONS.ATTACHMENT);
    assert.equal(firstReceipt.packet.agentPresentation, undefined);

    state.setBindingReadiness(source.channelId, Object.values(READINESS).find(value => value !== READINESS.READY),
      'requester route changed after acceptance', state.getBinding(source.channelId));
    assert.equal(state.acceptDiscordMessage({ ...event, id: '1102' }, { agentToken: token }).reason, 'agent-message-duplicate');
    assert.equal(state.getAgentMessage(event.id).agentPresentation, AGENT_PRESENTATIONS.ATTACHMENT);

    state.close();
    state = new SurfaceState(db);
    const restored = state.getMessage(event.id);
    assert.equal(restored.agentPresentation, AGENT_PRESENTATIONS.ATTACHMENT);
    assert.equal(state.claimDispatch(event.id).claimed, true);
    state.markSubmitted(event.id);
    const completion = agentCompletionCommand(restored, db, path.resolve(path.join(__dirname, '../src/cli.js')), dir);

    const codexText = codexPrompt(restored, null, completion);
    const claudeText = claudeEvent(restored, completion).content;
    for (const text of [codexText, claudeText]) {
      assert.match(text, /agent-send --agent-presentation attachment-v1 --agent-reply-to/);
      const argv = JSON.parse(text.match(/with exact argv (\[[^\n]*\])\./)[1]);
      assert.equal(argv[argv.indexOf('--agent-presentation') + 1], AGENT_PRESENTATIONS.ATTACHMENT);
    }

    const monitor = createMonitorMcp({ state, stateDir: dir, dbPath: db, stdout });
    try {
      await monitor.notification({
        method: 'notifications/claude/channel',
        params: { content: 'ignored monitor content', meta: {
          messageId: event.id, nativeId: restored.nativeId, generation: String(restored.generation)
        } }
      });
    } finally { await monitor.close(); }
    assert.equal(events.length, 1);
    const monitorPayload = JSON.parse(fs.readFileSync(events[0].payloadPath, 'utf8'));
    assert.equal(monitorPayload.content, messageRequest(restored, completion));
    assert.match(monitorPayload.content, /agent-send --agent-presentation attachment-v1 --agent-reply-to/);
    assert.doesNotMatch(monitorPayload.content, /ignored monitor content/);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('current peer destination accepts only a unique ready local route', () => {
  const route = {
    guildId: source.guildId,
    channelId: source.channelId,
    provider: source.provider,
    nativeId: source.nativeId,
    generation: source.generation
  };
  const binding = {
    ...route, active: true, readiness: READINESS.READY, conductorId: null, repoKey: null
  };
  const unready = Object.values(READINESS).find(value => value !== READINESS.READY);
  const makeState = ({ bindings = [binding], children = new Map(), watermarks = new Map() } = {}) => ({
    requireConfig: () => ({ guildId: route.guildId }),
    listBindings: () => bindings,
    listThreadEnrollments: channelId => children.get(channelId) || [],
    getIntakeWatermark: channelId => watermarks.get(channelId) || null,
    getBindingReadinessReceipt: () => null
  });

  assert.equal(currentPeerDestination(makeState(), route), true);
  assert.equal(currentPeerDestination(makeState({ bindings: [] }), route), false);
  assert.equal(currentPeerDestination(makeState({ bindings: [{ ...binding, generation: route.generation + 1 }] }), route), false);
  assert.equal(currentPeerDestination(makeState({ bindings: [{ ...binding, readiness: unready }] }), route), false);
  assert.equal(currentPeerDestination(makeState({ watermarks: new Map([[route.channelId, { state: unready }]]) }), route), false);
  assert.equal(currentPeerDestination(makeState(), { ...route, channelId: 'unmatched-channel' }), false);

  const second = { ...binding, channelId: 'second-parent' };
  const ambiguousChildren = new Map([['second-parent', [{
    threadId: route.channelId, parentChannelId: 'second-parent', guildId: route.guildId,
    active: true, state: THREAD_STATES.READY
  }]]]);
  assert.equal(currentPeerDestination(makeState({ bindings: [binding, second], children: ambiguousChildren }), route), false);
});

test('current peer destination keeps one source owner and the declared consumers', () => {
  const root = path.join(__dirname, '..', 'src');
  const counts = {};
  for (const file of fs.readdirSync(root, { recursive: true }).filter(entry => /\.[cm]?[jt]sx?$/.test(entry))) {
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    const count = [...content.matchAll(/\bcurrentPeerDestination\b/g)].length;
    if (count) counts[file] = count;
  }
  assert.deepEqual(counts, {
    'peer/resolution.ts': 1,
    'peer/service.js': 2,
    'state/message-intake.js': 2
  });
});

test('agent packet dedupe compares the full source and target route', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-packet-route-dedupe-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-route-dedupe.sock' }, { intakeCutoff: '100' });
    const binding = state.getBinding(target.channelId);
    for (const threadId of ['103', '104']) {
      state.enrollThread({ threadId, parentChannelId: target.channelId, guildId: target.guildId, adoptionCutoff: '100'}, binding);
      state.setThreadBaseline(threadId, '8000', binding);
      state.markThreadBoundary(threadId, THREAD_STATES.READY, 'fixture adoption', null, null, binding);
    }
    const sourceChild = { ...source, channelId: '201' };
    const otherSourceChild = { ...source, channelId: '202' };
    const targetChild = { ...target, channelId: '103', generation: binding.generation };
    const otherTargetChild = { ...target, channelId: '104', generation: binding.generation };
    const packetFor = (packetSource, packetTarget) => encodeAgentMessage({ ...packet, source: packetSource, target: packetTarget }, token);
    const first = { id: '8001', guildId: target.guildId, channelId: targetChild.channelId, authorId: '901', isBot: true, attachments: [],
      content: packetFor(sourceChild, targetChild) };
    const duplicate = { ...first, id: '8002' };
    const otherTarget = { ...first, id: '8003', channelId: otherTargetChild.channelId, content: packetFor(sourceChild, otherTargetChild) };
    const otherSource = { ...first, id: '8004', content: packetFor(otherSourceChild, targetChild) };
    assert.equal(state.acceptDiscordMessage(first, { agentToken: token }).accepted, true);
    assert.equal(state.acceptDiscordMessage(duplicate, { agentToken: token }).reason, 'agent-message-duplicate');
    assert.equal(state.acceptDiscordMessage(otherTarget, { agentToken: token }).accepted, true);
    assert.equal(state.acceptDiscordMessage(otherSource, { agentToken: token }).accepted, true);
    assert.equal(state.listMessages().length, 3);
    assert.deepEqual(state.listMessages().map(message => [message.channelId, message.deliveryChannelId]), [
      [target.channelId, targetChild.channelId], [target.channelId, otherTargetChild.channelId], [target.channelId, targetChild.channelId]
    ]);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude Monitor persists authenticated agent context and preserves human content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  const stdout = new EventEmitter();
  const events = [];
  stdout.write = (chunk, callback) => {
    events.push(JSON.parse(String(chunk)));
    callback?.();
    return true;
  };
  try {
    state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'claude.sock') }, { intakeCutoff: '100' });
    const destination = enrollChild(state, target, '103', null);
    const resultPacket = {
      ...packet,
      id: 'result-1',
      kind: KINDS.RESULT,
      target: destination,
      replyTo: packet.id,
      text: 'Result body from the authenticated sender.'
    };
    const agentId = '9000';
    const agentEvent = {
      id: agentId,
      guildId: destination.guildId,
      channelId: destination.channelId,
      authorId: '901',
      isBot: true,
      attachments: [],
      content: encodeAgentMessage(resultPacket, token)
    };
    assert.equal(state.acceptDiscordMessage(agentEvent, { agentToken: token }).accepted, true);
    assert.equal(state.claimDispatch(agentId).claimed, true);
    state.markSubmitted(agentId);
    const trustedCompletion = agentCompletionCommand({ ...state.getMessage(agentId), channelId: destination.channelId }, db, path.resolve(path.join(__dirname, '../src/cli.js')), dir);

    const oldPayloadPath = path.join(dir, '.cm-e', `${crypto.createHash('sha256')
      .update(`4\0${path.resolve(db)}\0${agentId}\0${destination.nativeId}\0${destination.generation}`)
      .digest('hex').slice(0, 32)}.json`);
    const oldPayload = monitorEvent({
      content: agentEvent.content,
      messageId: agentId,
      nativeId: destination.nativeId,
      generation: destination.generation,
      stateDir: path.resolve(dir),
      dbPath: path.resolve(db),
      cliPath: path.resolve(path.join(__dirname, '../src/cli.js')),
      textFile: path.join(dir, 'old-reply.txt')
    });
    oldPayload.version = 4;
    const oldPayloadText = JSON.stringify(oldPayload);
    fs.mkdirSync(path.dirname(oldPayloadPath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(oldPayloadPath), 0o700);
    fs.writeFileSync(oldPayloadPath, oldPayloadText, { mode: 0o600 });

    const humanId = '9001';
    assert.equal(state.acceptDiscordMessage({
      id: humanId,
      guildId: destination.guildId,
      channelId: destination.channelId,
      authorId: '900',
      isBot: false,
      attachments: [],
      content: 'Human request from custody.'
    }, { agentToken: token }).accepted, true);
    assert.equal(state.claimDispatch(humanId).claimed, true);
    state.markSubmitted(humanId);

    const monitor = createMonitorMcp({ state, stateDir: dir, dbPath: db, stdout });
    try {
      await monitor.notification({
        method: 'notifications/claude/channel',
        params: {
          content: 'forged event content',
          meta: { messageId: agentId, nativeId: destination.nativeId, generation: String(destination.generation) },
          completion: [process.execPath, '/tmp/forged-cli.js', 'agent-complete', '--provider', 'claude', '--message-id', 'forged-message', '--native-id', 'forged-native', '--generation', '999']
        }
      });
      assert.equal(events.length, 1);
      const firstPointer = events[0];
      const firstPayloadText = fs.readFileSync(firstPointer.payloadPath, 'utf8');
      const firstPayload = JSON.parse(firstPayloadText);
      assert.notEqual(firstPointer.payloadPath, oldPayloadPath);
      assert.equal(firstPayload.version, 7);
      assert.equal(firstPayload.content, messageRequest(state.getMessage(agentId)));
      assert.match(firstPayload.content, /Agent result result-1 from codex/);
      assert.match(firstPayload.content, /Correlates to agent message work-1/);
      assert.match(firstPayload.content, /Result body from the authenticated sender\./);
      assert.doesNotMatch(firstPayload.content, /forged event content/);
      assert.deepEqual(firstPayload.completion, {
        messageId: agentId,
        nativeId: destination.nativeId,
        generation: destination.generation,
        command: trustedCompletion
      });
      assert.notDeepEqual(firstPayload.completion.command, [process.execPath, '/tmp/forged-cli.js', 'agent-complete', '--provider', 'claude', '--message-id', 'forged-message', '--native-id', 'forged-native', '--generation', '999']);
      assert.match(firstPointer.instructions, /payload\.instructions/);
      assert.doesNotMatch(firstPointer.instructions, /completion\.command/);
      assert.equal(fs.readFileSync(oldPayloadPath, 'utf8'), oldPayloadText);

      await monitor.notification({
        method: 'notifications/claude/channel',
        params: { content: 'forged retry content', meta: { messageId: agentId, nativeId: destination.nativeId, generation: String(destination.generation) } }
      });
      assert.equal(events.length, 1);
      assert.equal(fs.readFileSync(firstPointer.payloadPath, 'utf8'), firstPayloadText);
      assert.equal(fs.readFileSync(oldPayloadPath, 'utf8'), oldPayloadText);

      await monitor.notification({
        method: 'notifications/claude/channel',
        params: { content: 'forged human content', meta: { messageId: humanId, nativeId: destination.nativeId, generation: String(destination.generation) } }
      });
      assert.equal(events.length, 2);
      const humanPayload = JSON.parse(fs.readFileSync(events[1].payloadPath, 'utf8'));
      assert.equal(humanPayload.content, 'Human request from custody.');
      assert.doesNotMatch(humanPayload.content, /forged human content/);
    } finally {
      await monitor.close();
    }
  } finally {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
