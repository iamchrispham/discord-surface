'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { presentDecision } = require('../src/decision-present');
const { DiscordGateway } = require('../src/discord');
const { encodeDecisionCustomId } = require('../src/discord-interaction');
const { READINESS, SurfaceState } = require('../src/state');

const NATIVE_ID = '9caa5d21-2169-429d-918b-5f08651b5dbd';

async function fixture(t, { callback = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-decision-gateway-'));
  const db = path.join(dir, 'surface.sqlite');
  const secretFile = path.join(dir, 'discord.secret');
  fs.writeFileSync(secretFile, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile });
  const binding = state.bindOrdinary({
    channelId: 'channel', guildId: 'guild', provider: 'codex', nativeId: NATIVE_ID, workspace: dir
  }, { sessionId: NATIVE_ID, threadId: NATIVE_ID });
  state.recordOrdinaryPreflight(binding, {
    file: path.join(dir, 'fixture.jsonl'), sessionId: NATIVE_ID, threadId: NATIVE_ID, workspace: dir
  });
  state.setBindingReadiness('channel', READINESS.READY);

  const request = {
    namespace: 'discord-gateway',
    requestId: `gateway-${path.basename(dir)}`,
    target: 'run:discord-gateway',
    head: '-',
    question: 'Choose the canonical answer',
    menu: [{ key: 'approve', consequence: 'apply the saved choice' }, 'hold'],
    channelId: 'channel',
    provider: 'codex',
    nativeId: NATIVE_ID,
    generation: 1
  };
  const canonical = {
    stateRoot: path.join(dir, 'canonical-state'),
    environment: {
      TELEGRAM_ROOT: path.join(dir, 'canonical-telegram'),
      TG_CANONICAL_STATE_ROOT: undefined
    }
  };
  const posts = [];
  const presentation = await presentDecision({
    state,
    request,
    token: 'fixture-token',
    canonical,
    authorizeOrdinary: async () => {},
    fetchImpl: async (_url, options) => {
      posts.push(JSON.parse(options.body));
      return { ok: true, status: 200, async json() { return { id: 'question-message' }; } };
    }
  });

  const edits = [];
  const callbacks = [];
  const dispatches = [];
  const question = {
    id: presentation.messageId,
    async edit(payload) { edits.push(payload); return { id: presentation.messageId, ...payload }; }
  };
  const channel = {
    id: 'channel',
    messages: { async fetch(messageId) { assert.equal(messageId, presentation.messageId); return question; } },
    async send(payload) { return { id: `reply-${payload.nonce || edits.length}` }; }
  };
  const listeners = new Map();
  const client = {
    application: { id: 'application', commands: null },
    channels: { async fetch(channelId) { assert.equal(channelId, 'channel'); return channel; } },
    on(name, listener) { listeners.set(name, listener); },
    off(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
    async destroy() {}
  };
  const gateway = new DiscordGateway({
    state,
    client,
    providers: {
      codex: {
        async dispatch(message) { dispatches.push(message); return { status: 'submitted' }; }
      }
    },
    interactionFetch: async (url, options) => {
      callbacks.push({ url, body: JSON.parse(options.body) });
      if (callback) return callback(url, options);
      return { ok: true, status: 204, body: { async cancel() {} } };
    }
  });
  t.after(async () => {
    await gateway.stop();
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, db, state, request, presentation, posts, edits, callbacks, dispatches, gateway, listeners };
}

function component(presentation, id, selectedIndex, overrides = {}) {
  return {
    type: 3,
    id,
    applicationId: 'application',
    guildId: 'guild',
    channelId: 'channel',
    token: `token-${id}`,
    user: { id: 'operator' },
    message: { id: presentation.messageId },
    componentType: 2,
    customId: encodeDecisionCustomId(presentation.qid, selectedIndex),
    ...overrides
  };
}

function decisionMessages(state) {
  return state.listMessages().filter(message => message.decisionResult);
}

test('Gateway settles competing component clicks once and imports the canonical winner', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const first = await f.gateway.handleInteraction(component(f.presentation, 'component-approve', 0), new AbortController().signal);
  const second = await f.gateway.handleInteraction(component(f.presentation, 'component-hold', 1), new AbortController().signal);

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(f.callbacks.length, 2);
  assert.deepEqual(f.callbacks.map(item => item.body), [{ type: 6 }, { type: 6 }]);
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.edits.length, 2);
  assert.deepEqual(f.edits.map(item => item.content), ['approve', 'approve']);
  assert.equal(decisionMessages(f.state).length, 1);
  const row = decisionMessages(f.state)[0];
  assert.equal(row.decisionResult.answer, 'approve');
  assert.equal(row.decisionResult.selectedKey, 'approve');
  assert.equal(row.decisionResult.questionMessageId, f.presentation.messageId);
  assert.equal(f.state.interactionResponseTarget(row.id), f.presentation.messageId);
  const losing = f.state.getDecisionClick('component-hold');
  assert.equal(losing.selectedKey, 'hold');
  assert.equal(losing.canonical.answer, 'approve');
  assert.equal(losing.canonical.source, 'current');
});

test('losing projection refuses binding and config drift during question fetch', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.gateway.handleInteraction(component(f.presentation, 'projection-owner', 0), new AbortController().signal);
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'projection-loser',
    presentationId: f.presentation.presentationId,
    selectedKey: 'hold',
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);
  const canonical = f.state.getDecisionClick('projection-owner').canonical;
  assert.ok(canonical);
  assert.equal(f.state.importDecisionWinner('projection-loser', canonical).accepted, true);
  const click = f.state.getDecisionClick('projection-loser');
  assert.equal(f.state.getMessage('projection-loser'), null);

  const channel = await f.gateway.client.channels.fetch('channel');
  const fetchQuestion = channel.messages.fetch.bind(channel.messages);
  f.gateway.client.channels.fetch = async channelId => {
    assert.equal(channelId, 'channel');
    return channel;
  };
  let fetchStartedResolve;
  let releaseFetchResolve;
  let fetchStarted = new Promise(resolve => { fetchStartedResolve = resolve; });
  let releaseFetch = new Promise(resolve => { releaseFetchResolve = resolve; });
  channel.messages.fetch = async messageId => {
    const question = await fetchQuestion(messageId);
    fetchStartedResolve();
    await releaseFetch;
    return question;
  };
  const beforeLosingProjection = f.edits.length;
  const staleBindingProjection = f.gateway.projectDecisionMessage({ click, answer: 'approve' }, new AbortController().signal);
  await fetchStarted;
  f.state.db.prepare('UPDATE bindings SET native_id=?, generation=? WHERE channel_id=?')
    .run('6b2d4b45-9d15-4894-8f2a-fc9a7c36b7d1', 2, 'channel');
  releaseFetchResolve();
  await assert.rejects(staleBindingProjection, /authorization/);
  assert.equal(f.edits.length, beforeLosingProjection);

  f.state.db.prepare('UPDATE bindings SET native_id=?, generation=? WHERE channel_id=?')
    .run(NATIVE_ID, 1, 'channel');
  f.state.setConfig({ operatorId: 'replacement-operator', guildId: 'replacement-guild' });
  fetchStarted = new Promise(resolve => { fetchStartedResolve = resolve; });
  releaseFetch = new Promise(resolve => { releaseFetchResolve = resolve; });
  const staleConfigProjection = f.gateway.projectDecisionMessage({ click, answer: 'approve' }, new AbortController().signal);
  await fetchStarted;
  releaseFetchResolve();
  await assert.rejects(staleConfigProjection, /authorization/);
  assert.equal(f.edits.length, beforeLosingProjection);
});

test('Gateway rejects malformed, forged, stale, and unauthorized component custody before callback', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const malformed = await f.gateway.handleInteraction(component(f.presentation, 'bad-code', 0, { customId: 'd:not-valid:99' }), new AbortController().signal);
  const stale = await f.gateway.handleInteraction(component(f.presentation, 'stale-source', 0, { message: { id: 'other-question' } }), new AbortController().signal);
  const unauthorized = await f.gateway.handleInteraction(component(f.presentation, 'wrong-operator', 0, { user: { id: 'other-operator' } }), new AbortController().signal);

  assert.equal(malformed.accepted, false);
  assert.equal(stale.accepted, false);
  assert.equal(unauthorized.accepted, false);
  assert.equal(f.callbacks.length, 0);
  assert.equal(decisionMessages(f.state).length, 0);
  assert.equal(f.state.listDecisionPendingWork().length, 0);
});

test('callback uncertainty does not cancel canonical settlement or native custody', { timeout: 30000 }, async t => {
  const f = await fixture(t, {
    callback: async () => { throw new Error('Discord callback connection lost'); }
  });
  const result = await f.gateway.handleInteraction(component(f.presentation, 'callback-unknown', 0), new AbortController().signal);
  const click = f.state.getDecisionClick('callback-unknown');

  assert.equal(result.accepted, true);
  assert.equal(result.callback.outcome, 'unknown');
  assert.equal(click.callbackOutcome, 'unknown');
  assert.equal(f.dispatches.length, 1);
  assert.equal(decisionMessages(f.state).length, 1);
});

test('recovery resumes an admitted click without repeating its callback and preserves the question target', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'recovered-component',
    presentationId: f.presentation.presentationId,
    selectedKey: 'hold',
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);
  const recoveredState = new SurfaceState(f.db);
  recoveredState.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(f.dir, 'discord.secret') });
  const recoveredGateway = new DiscordGateway({
    state: recoveredState,
    client: f.gateway.client,
    providers: { codex: { async dispatch(message) { f.dispatches.push(message); return { status: 'submitted' }; } } },
    interactionFetch: async () => { throw new Error('recovery must not repeat component callback'); }
  });
  t.after(async () => { await recoveredGateway.stop(); recoveredState.close(); });
  const remaining = await recoveredGateway.startDecisionRecovery(new AbortController().signal);
  const click = recoveredState.getDecisionClick('recovered-component');

  assert.deepEqual(remaining, []);
  assert.equal(click.callbackOutcome, null);
  assert.equal(click.canonical.answer, 'hold');
  assert.equal(recoveredState.interactionResponseTarget('recovered-component'), f.presentation.messageId);
  assert.equal(recoveredState.listMessages().filter(message => message.decisionResult).length, 1);
});

test('ordinary recovery is returned while decision recovery remains independently pending', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'pending-decision',
    presentationId: f.presentation.presentationId,
    selectedKey: 'approve',
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);
  f.gateway.decisionConsumer.recover = signal => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve([]), { once: true });
  });
  const ordinary = f.state.acceptDiscordMessage({
    id: 'ordinary-sibling', guildId: 'guild', channelId: 'channel', authorId: 'operator',
    isBot: false, attachments: [], content: 'ordinary sibling'
  });
  assert.equal(ordinary.accepted, true);
  const result = await f.gateway.reconcilePending();

  assert.ok(Array.isArray(result));
  assert.equal(f.dispatches.length, 1);
});

test('cancellation leaves accepted pre-row custody and Gateway stop drains it', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  const result = await f.gateway.handleInteraction(component(f.presentation, 'cancelled-component', 0), controller.signal);

  assert.equal(result.accepted, true);
  assert.equal(result.message, null);
  assert.equal(f.state.getMessage('cancelled-component'), null);
  assert.equal(f.state.listDecisionPendingWork().length, 1);
  await f.gateway.stop();
  assert.equal(f.gateway.stopping, false);
});
