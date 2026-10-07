'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PermissionFlagsBits } = require('discord.js');

const { presentDecision } = require('../src/decision-present');
const { DiscordGateway } = require('../src/discord');
const { encodeDecisionCustomId, sendInteractionFollowup } = require('../src/discord-interaction');
const { READINESS, SurfaceState } = require('../src/state');

const NATIVE_ID = '9caa5d21-2169-429d-918b-5f08651b5dbd';

async function fixture(t, { callback = null, questionText = 'Choose the canonical answer', attachFiles = true, embedLinks = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-decision-gateway-'));
  const db = path.join(dir, 'surface.sqlite');
  const secretFile = path.join(dir, 'discord.secret');
  fs.writeFileSync(secretFile, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile });
  const binding = state.bindOrdinary({
    channelId: 'channel', guildId: 'guild', provider: 'codex', nativeId: NATIVE_ID, workspace: dir
  }, { sessionId: NATIVE_ID, threadId: NATIVE_ID }, '100');
  state.recordOrdinaryPreflight(binding, {
    file: path.join(dir, 'fixture.jsonl'), sessionId: NATIVE_ID, threadId: NATIVE_ID, workspace: dir
  });
  state.setBindingReadiness('channel', READINESS.READY);

  const request = {
    namespace: 'discord-gateway',
    requestId: `gateway-${path.basename(dir)}`,
    target: 'run:discord-gateway',
    head: '-',
    question: questionText,
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
  const permissionState = { attachFiles, embedLinks };
  const question = {
    id: presentation.messageId,
    async edit(payload) { edits.push(payload); return { id: presentation.messageId, ...payload }; }
  };
  const channel = {
    id: 'channel',
    permissionsFor() {
      return { has: permission => permission === PermissionFlagsBits.EmbedLinks ? permissionState.embedLinks : permission !== PermissionFlagsBits.AttachFiles || permissionState.attachFiles };
    },
    messages: { async fetch(messageId) { assert.equal(messageId, presentation.messageId); return question; } },
    async send(payload) { return { id: `reply-${payload.nonce || edits.length}` }; }
  };
  const listeners = new Map();
  const client = {
    user: { id: 'bot' },
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
  return { dir, db, state, request, presentation, posts, edits, callbacks, dispatches, gateway, listeners,
    setAttachFiles(value) { permissionState.attachFiles = value; },
    setEmbedLinks(value) { permissionState.embedLinks = value; } };
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

async function waitForCondition(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setImmediate(resolve));
  }
}

test('Gateway settles competing component clicks once and imports the canonical winner', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  const first = await f.gateway.handleInteraction(component(f.presentation, 'component-approve', 0), new AbortController().signal);
  const second = await f.gateway.handleInteraction(component(f.presentation, 'component-hold', 1), new AbortController().signal);

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(f.callbacks.length, 2);
  assert.deepEqual(f.callbacks.map(item => item.body), [{ type: 6 }, { type: 6 }]);
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.edits.length, 2);
  assert.deepEqual(f.edits.map(item => item.embeds), [
    [{ title: 'Selected action', description: 'approve' }],
    [{ title: 'Selected action', description: 'approve' }]
  ]);
  assert.ok(f.edits.every(item => item.components.length === 0));
  assert.deepEqual(f.edits.map(item => item.content), [f.posts[0].content, f.posts[0].content]);
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

test('bound component ingress keeps callback custody before readiness and gates continuation', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.gateway.ready = true;
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.createInteractionRecoveryBarrier();
  const listener = f.listeners.get('interactionCreate');
  assert.equal(typeof listener, 'function');
  listener(component(f.presentation, 'barrier-component', 0));

  await waitForCondition(() => f.callbacks.length === 1, 'bound component callback was not attempted');
  assert.deepEqual(f.callbacks.map(item => item.body), [{ type: 6 }]);
  assert.equal(f.edits.length, 0);
  assert.equal(f.dispatches.length, 0);
  assert.equal(decisionMessages(f.state).length, 0);
  assert.equal(f.state.getDecisionClick('barrier-component').callbackOutcome, 'sent');
  assert.equal(f.state.getDecisionClick('barrier-component').canonical, null);

  f.gateway.resolveInteractionRecovery(true);
  await waitForCondition(() => f.edits.length === 1 && f.dispatches.length === 1,
    'decision continuation did not resume after readiness barrier');
  assert.deepEqual(f.edits.map(item => item.content), [f.posts[0].content]);
  assert.equal(decisionMessages(f.state).length, 1);

  const aborted = await fixture(t);
  aborted.gateway.ready = true;
  aborted.gateway.started = true;
  aborted.gateway.transportReady = true;
  aborted.gateway.createInteractionRecoveryBarrier();
  const abortedListener = aborted.listeners.get('interactionCreate');
  assert.equal(typeof abortedListener, 'function');
  abortedListener(component(aborted.presentation, 'aborted-barrier-component', 0));
  await waitForCondition(() => aborted.callbacks.length === 1, 'aborted barrier callback was not attempted');
  await aborted.gateway.stop();
  assert.equal(aborted.edits.length, 0);
  assert.equal(aborted.dispatches.length, 0);
  assert.equal(decisionMessages(aborted.state).length, 0);
  const pending = aborted.state.getDecisionClick('aborted-barrier-component');
  assert.equal(pending.callbackOutcome, 'sent');
  assert.ok(aborted.state.listDecisionPendingWork().some(click => click.interactionId === 'aborted-barrier-component'));
});

test('decision native return is held before startup and proceeds once after a healthy start', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const listener = f.listeners.get('interactionCreate');
  assert.equal(typeof listener, 'function');
  assert.equal(f.gateway.started, false);

  listener(component(f.presentation, 'held-before-start', 0));
  await waitForCondition(() => f.callbacks.length === 1, 'held decision callback was not attempted');
  await Promise.all([...f.gateway.inFlight]);

  const held = f.state.getDecisionClick('held-before-start');
  assert.equal(held.callbackOutcome, 'sent');
  assert.equal(held.nativeReturn, null);
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.edits.length, 0);
  assert.equal(decisionMessages(f.state).length, 0);

  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  listener(component(f.presentation, 'native-after-start', 0));
  await waitForCondition(() => f.callbacks.length === 2, 'started decision callback was not attempted');
  await Promise.all([...f.gateway.inFlight]);

  assert.equal(f.dispatches.length, 1);
  assert.equal(f.edits.length, 1);
  assert.deepEqual(f.edits.map(item => item.content), [f.posts[0].content]);
  assert.equal(decisionMessages(f.state).length, 1);
  assert.equal(f.state.getDecisionClick('native-after-start').nativeReturn.outcome, 'submitted');
  assert.equal(f.state.getDecisionClick('held-before-start').nativeReturn, null);
});

test('original held click resumes through startDecisionRecovery without a second click', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const listener = f.listeners.get('interactionCreate');
  assert.equal(typeof listener, 'function');

  listener(component(f.presentation, 'held-original', 0));
  await waitForCondition(() => f.callbacks.length === 1, 'held original decision callback was not attempted');
  await Promise.all([...f.gateway.inFlight]);

  assert.equal(f.state.getDecisionClick('held-original').nativeReturn, null);
  assert.equal(f.dispatches.length, 0);

  f.gateway.ready = true;
  f.gateway.started = true;
  f.gateway.transportReady = true;
  await f.gateway.startDecisionRecovery(new AbortController().signal);

  const recovered = f.state.getDecisionClick('held-original');
  assert.equal(recovered.nativeReturn.outcome, 'submitted');
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.edits.length, 1);
  assert.equal(decisionMessages(f.state).length, 1);

  await f.gateway.startDecisionRecovery(new AbortController().signal);
  assert.equal(f.state.getDecisionClick('held-original').nativeReturn.outcome, 'submitted');
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.edits.length, 1);
  assert.equal(decisionMessages(f.state).length, 1);
});

test('queues a channel-scoped decision recovery requested during an active pass', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const calls = [];
  let releaseFirst;
  const firstPass = new Promise(resolve => { releaseFirst = resolve; });
  f.gateway.decisionConsumer.recover = async (_signal, channelIds) => {
    calls.push(channelIds ? [...channelIds] : null);
    if (calls.length === 1) await firstPass;
    return [];
  };

  const first = f.gateway.startDecisionRecovery(undefined, new Set(['channel-a']));
  await waitForCondition(() => calls.length === 1, 'first decision recovery did not start');
  const second = f.gateway.startDecisionRecovery(undefined, new Set(['channel-b']));
  assert.equal(second, first);

  releaseFirst();
  await first;
  await waitForCondition(() => calls.length === 2, 'queued decision recovery did not start');
  assert.deepEqual(calls, [['channel-a'], ['channel-b']]);
});

test('losing projection refuses binding and config drift during question fetch', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
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
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
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
  assert.equal(f.edits[0].content, f.posts[0].content);
  assert.deepEqual(f.edits[0].embeds, [{ title: 'Selected action', description: 'hold' }]);
  assert.equal(recoveredState.interactionResponseTarget('recovered-component'), f.presentation.messageId);
  assert.equal(recoveredState.listMessages().filter(message => message.decisionResult).length, 1);
});

test('restart recovery classifies an interrupted callback without resending it', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'restart-callback',
    presentationId: f.presentation.presentationId,
    selectedKey: 'hold',
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);
  f.state.close();

  const recoveredState = new SurfaceState(f.db);
  recoveredState.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(f.dir, 'discord.secret') });
  const restart = recoveredState.recoverAfterRestart();
  assert.equal(restart.interactionCallbacks, 0);
  assert.equal(recoveredState.getDecisionClick('restart-callback').callbackOutcome, 'unknown');
  let recoveryCallbacks = 0;
  const recoveredGateway = new DiscordGateway({
    state: recoveredState,
    client: f.gateway.client,
    providers: { codex: { async dispatch(message) { f.dispatches.push(message); return { status: 'submitted' }; } } },
    interactionFetch: async () => {
      recoveryCallbacks += 1;
      throw new Error('restart recovery must not repeat component callback');
    }
  });
  t.after(async () => { await recoveredGateway.stop(); recoveredState.close(); });
  const remaining = await recoveredGateway.startDecisionRecovery(new AbortController().signal);
  const click = recoveredState.getDecisionClick('restart-callback');

  assert.deepEqual(remaining, []);
  assert.equal(recoveryCallbacks, 0);
  assert.equal(click.callbackOutcome, 'unknown');
  assert.equal(click.canonical.answer, 'hold');
  assert.equal(f.edits[0].content, f.posts[0].content);
  assert.deepEqual(f.edits[0].embeds, [{ title: 'Selected action', description: 'hold' }]);
  assert.equal(recoveredState.interactionResponseTarget('restart-callback'), f.presentation.messageId);
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
    id: '9000', guildId: 'guild', channelId: 'channel', authorId: 'operator',
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

test('short-answer decision interaction does not require Attach Files permission', { timeout: 30000 }, async t => {
  const f = await fixture(t, { attachFiles: false });
  const result = await f.gateway.handleInteraction(component(f.presentation, 'missing-attach', 0), new AbortController().signal);

  assert.equal(result.accepted, true);
  assert.equal(f.state.getDecisionClick('missing-attach')?.projectionOutcome, null);
  assert.equal(f.callbacks.length, 1);
  assert.equal(f.edits.length, 0);
});

test('long-answer projection refuses attachment without Attach Files permission', { timeout: 30000 }, async t => {
  const f = await fixture(t, { attachFiles: false });
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'projection-missing-attach', presentationId: f.presentation.presentationId, selectedKey: 'approve',
    actorId: 'operator', guildId: 'guild', channelId: 'channel', messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);

  await assert.rejects(
    f.gateway.projectDecisionMessage({ click: admitted.click, presentation: f.presentation, answer: 'x'.repeat(4097) }, new AbortController().signal),
    /Attach Files permission/
  );
  assert.equal(f.edits.length, 0);
});

test('long-answer projection uses a file-only fallback without Embed Links', { timeout: 30000 }, async t => {
  const f = await fixture(t, { embedLinks: false });
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'projection-missing-embed', presentationId: f.presentation.presentationId, selectedKey: 'approve',
    actorId: 'operator', guildId: 'guild', channelId: 'channel', messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);

  await f.gateway.projectDecisionMessage({ click: admitted.click, presentation: f.presentation, answer: 'x'.repeat(4097) }, new AbortController().signal);
  assert.equal(f.edits.length, 1);
  assert.deepEqual(f.edits[0].embeds, []);
  assert.equal(f.edits[0].files.length, 1);
  assert.match(f.edits[0].content, /attached in selected-action\.txt/);
});

test('authorization denial acknowledges the component without admitting a decision', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.gateway.authorizeDecisionInteraction = async () => false;
  const result = await f.gateway.handleInteraction(component(f.presentation, 'denied-component', 0), new AbortController().signal);

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'presentation-not-admissible');
  assert.equal(f.callbacks.length, 2);
  assert.equal(f.callbacks[0].body.type, 6);
  assert.equal(f.callbacks[1].body.flags, 64);
  assert.equal(f.state.getDecisionClick('denied-component'), null);
  assert.equal(f.state.listDecisionPendingWork().length, 0);
});

test('authorization cancellation leaves pending custody and ignores a late channel lookup', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const channel = await f.gateway.client.channels.fetch('channel');
  let lookupStarted;
  const started = new Promise(resolve => { lookupStarted = resolve; });
  let releaseLookup;
  const lookupRelease = new Promise(resolve => { releaseLookup = resolve; });
  f.gateway.client.channels.fetch = async () => {
    lookupStarted();
    await lookupRelease;
    return channel;
  };
  const controller = new AbortController();
  const pending = f.gateway.handleInteraction(component(f.presentation, 'cancelled-authorization', 0), controller.signal);
  await started;
  controller.abort();
  const result = await pending;
  releaseLookup();

  assert.equal(result.accepted, true);
  assert.equal(result.click?.state, 'authorization_pending');
  assert.equal(f.state.listDecisionPendingWork().length, 1);
  assert.equal(f.edits.length, 0);
  const recoveredState = new SurfaceState(f.db);
  assert.equal(recoveredState.listDecisionPendingWork()[0]?.state, 'authorization_pending');
  recoveredState.close();
});

test('authorization lookup failure remains pending for recovery', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const recoveryCalls = [];
  f.gateway.startDecisionRecovery = (signal, channelIds) => {
    recoveryCalls.push({ signal, channelIds });
    return Promise.resolve([]);
  };
  f.gateway.authorizeDecisionInteraction = async () => null;
  const result = await f.gateway.handleInteraction(component(f.presentation, 'unknown-authorization', 0), new AbortController().signal);

  assert.equal(result.accepted, true);
  assert.equal(result.click?.state, 'authorization_pending');
  assert.equal(f.callbacks.length, 1);
  assert.equal(f.state.listDecisionPendingWork().length, 1);
  assert.equal(recoveryCalls.length, 1);
  assert.deepEqual([...recoveryCalls[0].channelIds], ['channel']);
});

test('decision recovery defers an unknown-authorization wake until an external pass', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  const interactionId = 'recovery-unknown-authorization';
  const admitted = f.state.admitDecisionClickAndBeginAuthorization({
    interactionId,
    presentationId: f.presentation.presentationId,
    selectedKey: 'approve',
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel'),
    applicationId: 'application',
    token: 'recovery-unknown-token'
  });
  assert.equal(admitted.accepted, true);
  let attempts = 0;
  f.gateway.authorizeDecisionInteraction = async () => {
    attempts += 1;
    return null;
  };

  await f.gateway.startDecisionRecovery(new AbortController().signal, new Set(['channel']));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(f.state.getDecisionClick(interactionId)?.state, 'authorization_pending');

  f.gateway.authorizeDecisionInteraction = async () => {
    attempts += 1;
    return true;
  };
  await f.gateway.startDecisionRecovery(new AbortController().signal, new Set(['channel']));
  assert.equal(attempts, 2);
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.state.listDecisionPendingWork().length, 0);
});

test('generic recovery waits for an active decision pass without a materialized projection', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  const interactionId = '9001';
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId,
    presentationId: f.presentation.presentationId,
    selectedKey: 'approve',
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);
  const ordinary = f.state.acceptDiscordMessage({
    id: interactionId,
    guildId: 'guild',
    channelId: 'channel',
    authorId: 'operator',
    isBot: false,
    attachments: [],
    content: 'accepted decision message'
  });
  assert.equal(ordinary.accepted, true);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  f.gateway.decisionConsumer.recover = () => held;
  const reconciliation = f.gateway.reconcilePending();
  await waitForCondition(() => Boolean(f.gateway.decisionRecoveryPromise), 'decision recovery did not start');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.dispatches.length, 0);

  release([]);
  await reconciliation;
  assert.equal(f.dispatches.length, 1);
});

test('duplicate denial waits for the initial component defer', { timeout: 30000 }, async t => {
  let releaseCallback;
  const callbackGate = new Promise(resolve => { releaseCallback = resolve; });
  const f = await fixture(t, {
    callback: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.type === 6) await callbackGate;
      return { ok: true, status: 204, body: { async cancel() {} } };
    }
  });
  f.gateway.authorizeDecisionInteraction = async () => false;
  const firstInput = component(f.presentation, 'defer-race', 0, { token: 'token-defer-race-initial' });
  const duplicateInput = component(f.presentation, 'defer-race', 0, { token: 'token-defer-race-duplicate' });
  const first = f.gateway.handleInteraction(firstInput, new AbortController().signal);
  await waitForCondition(() => f.callbacks.length === 1, 'initial component defer did not start');
  const duplicate = f.gateway.handleInteraction(duplicateInput, new AbortController().signal);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.callbacks.length, 1);

  releaseCallback();
  await Promise.all([first, duplicate]);
  assert.equal(f.callbacks.length, 2);
  assert.equal(f.callbacks[0].body.type, 6);
  assert.equal(f.callbacks[1].body.flags, 64);
  assert.match(f.callbacks[0].url, /token-defer-race-initial/);
  assert.match(f.callbacks[1].url, /token-defer-race-initial/);
  assert.doesNotMatch(f.callbacks[1].url, /token-defer-race-duplicate/);
});

test('decision recovery waits for the initial component defer before rejection', { timeout: 30000 }, async t => {
  let releaseCallback;
  const callbackGate = new Promise(resolve => { releaseCallback = resolve; });
  const f = await fixture(t, {
    callback: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.type === 6) await callbackGate;
      return { ok: true, status: 204, body: { async cancel() {} } };
    }
  });
  f.gateway.authorizeDecisionInteraction = async () => false;
  const first = f.gateway.handleInteraction(
    component(f.presentation, 'recovery-defer-race', 0, { token: 'token-recovery-defer-initial' }),
    new AbortController().signal
  );
  await waitForCondition(() => f.callbacks.length === 1, 'initial component defer did not start');
  const recovery = f.gateway.decisionConsumer.recover(new AbortController().signal);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.callbacks.length, 1);

  releaseCallback();
  await Promise.all([first, recovery]);
  assert.equal(f.callbacks.length, 2);
  assert.equal(f.callbacks[0].body.type, 6);
  assert.equal(f.callbacks[1].body.flags, 64);
  assert.match(f.callbacks[0].url, /token-recovery-defer-initial/);
  assert.match(f.callbacks[1].url, /token-recovery-defer-initial/);
  assert.equal(f.state.listDecisionPendingWork().length, 0);
});

test('persisted denial wins an authorization race and prevents native dispatch', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  const gates = [];
  f.gateway.authorizeDecisionInteraction = () => new Promise(resolve => gates.push(resolve));
  const first = f.gateway.handleInteraction(component(f.presentation, 'authorization-race-denied', 0), new AbortController().signal);
  await waitForCondition(() => gates.length === 1, 'first authorization did not start');
  const second = f.gateway.handleInteraction(component(f.presentation, 'authorization-race-denied', 0), new AbortController().signal);
  await waitForCondition(() => gates.length === 2, 'duplicate authorization did not start');
  gates[0](false);
  gates[1](true);
  const results = await Promise.all([first, second]);

  assert.equal(results.some(result => result.accepted), false);
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.state.listDecisionPendingWork().length, 0);
});

test('persisted authorization wins a late denial and dispatches native work once', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  const gates = [];
  f.gateway.authorizeDecisionInteraction = () => new Promise(resolve => gates.push(resolve));
  const first = f.gateway.handleInteraction(component(f.presentation, 'authorization-race-allowed', 0), new AbortController().signal);
  await waitForCondition(() => gates.length === 1, 'first authorization did not start');
  const second = f.gateway.handleInteraction(component(f.presentation, 'authorization-race-allowed', 0), new AbortController().signal);
  await waitForCondition(() => gates.length === 2, 'duplicate authorization did not start');
  gates[0](true);
  await waitForCondition(() => f.state.getDecisionClick('authorization-race-allowed')?.authorizationOutcome === 'authorized', 'authorization winner was not persisted');
  gates[1](false);
  await Promise.all([first, second]);

  assert.equal(f.dispatches.length, 1);
  assert.equal(f.state.listDecisionPendingWork().length, 0);
});

test('Embed Links loss uses a visible short-answer projection fallback', { timeout: 30000 }, async t => {
  const f = await fixture(t, { embedLinks: false });
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  const result = await f.gateway.handleInteraction(component(f.presentation, 'missing-embed-links', 0), new AbortController().signal);

  assert.equal(result.accepted, true);
  assert.equal(f.edits.length, 1);
  assert.equal(f.edits[0].embeds.length, 0);
  assert.match(f.edits[0].content, /Selected action:/);
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.state.getDecisionClick('missing-embed-links')?.projectionOutcome, 'sent');
  f.setEmbedLinks(true);
  await f.gateway.reconcilePending();
  assert.equal(f.edits.length, 1);
});

test('plain projection preserves prompt and answer whitespace', { timeout: 30000 }, async t => {
  const f = await fixture(t, { embedLinks: false });
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'whitespace-projection', presentationId: f.presentation.presentationId, selectedKey: 'approve',
    actorId: 'operator', guildId: 'guild', channelId: 'channel', messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);
  const presentation = { ...f.presentation, content: '  prompt with preserved bytes' };
  const answer = 'approve  ';

  await f.gateway.projectDecisionMessage({ click: admitted.click, presentation, answer }, new AbortController().signal);
  assert.equal(f.edits[0].content, `${presentation.content}\n\nSelected action:\n${answer}`);
  assert.deepEqual(f.edits[0].embeds, []);
});

test('plain projection size checks the untrimmed fallback at the 2000 boundary', { timeout: 30000 }, async t => {
  const f = await fixture(t, { embedLinks: false, attachFiles: false });
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'plain-size-boundary', presentationId: f.presentation.presentationId, selectedKey: 'approve',
    actorId: 'operator', guildId: 'guild', channelId: 'channel', messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);
  const overflowingPresentation = { ...f.presentation, content: `  ${'p'.repeat(1978)}` };
  await assert.rejects(
    f.gateway.projectDecisionMessage({ click: admitted.click, presentation: overflowingPresentation, answer: 'a  ' }, new AbortController().signal),
    /Attach Files permission/
  );
  assert.equal(f.edits.length, 0);

  const fittingPresentation = { ...f.presentation, content: 'p'.repeat(1980) };
  await f.gateway.projectDecisionMessage({ click: admitted.click, presentation: fittingPresentation, answer: 'a' }, new AbortController().signal);
  assert.equal(f.edits[0].content.length, 2000);
  assert.equal(f.edits[0].content, `${fittingPresentation.content}\n\nSelected action:\na`);
});

test('failed short projection remains pending after native submission', { timeout: 30000 }, async t => {
  const f = await fixture(t, { questionText: 'q'.repeat(1800), embedLinks: false, attachFiles: false });
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  const interactionId = 'short-projection-retry';
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId,
    presentationId: f.presentation.presentationId,
    selectedKey: 'approve',
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);
  assert.equal(f.state.recordDecisionCallbackOutcome(interactionId, 'sent').accepted, true);
  assert.equal(f.state.importDecisionWinner(interactionId, {
    qid: f.presentation.qid,
    questionGeneration: f.presentation.questionGeneration,
    target: f.presentation.target,
    source: 'current',
    materialized: true,
    reference: 'short-answer',
    answer: 'x'.repeat(100)
  }).accepted, true);

  const result = await f.gateway.handleInteraction(component(f.presentation, interactionId, 0), new AbortController().signal);

  assert.equal(result.accepted, true);
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.state.getDecisionClick('short-projection-retry')?.projectionOutcome, 'not_sent');
  assert.equal(f.state.getDecisionClick('short-projection-retry')?.state, 'materialized_projection_pending');
  assert.equal(f.state.listDecisionPendingWork().length, 1);

  f.setEmbedLinks(true);
  f.setAttachFiles(true);
  await f.gateway.reconcilePending();

  assert.equal(f.edits.length, 1);
  assert.equal(f.state.getDecisionClick('short-projection-retry')?.projectionOutcome, 'sent');
  assert.equal(f.state.listDecisionPendingWork().length, 0);
});

test('known-unsent long-answer projection retries after Attach Files returns', { timeout: 30000 }, async t => {
  const f = await fixture(t, { attachFiles: false });
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'recovering-attachment', presentationId: f.presentation.presentationId, selectedKey: 'approve',
    actorId: 'operator', guildId: 'guild', channelId: 'channel', messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);
  const answer = 'x'.repeat(4097);
  await assert.rejects(
    f.gateway.projectDecisionMessage({ click: admitted.click, presentation: f.presentation, answer }, new AbortController().signal),
    /Attach Files permission/
  );
  assert.equal(f.state.getDecisionClick('recovering-attachment')?.projectionOutcome, null);
  f.setAttachFiles(true);
  await f.gateway.projectDecisionMessage({ click: admitted.click, presentation: f.presentation, answer }, new AbortController().signal);
  assert.equal(f.edits.length, 1);
});

test('long-answer projection failure does not dispatch native work', { timeout: 30000 }, async t => {
  const f = await fixture(t, { attachFiles: false });
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'blocked-long-answer', presentationId: f.presentation.presentationId, selectedKey: 'approve',
    actorId: 'operator', guildId: 'guild', channelId: 'channel', messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);
  assert.equal(f.state.importDecisionWinner('blocked-long-answer', {
    qid: f.presentation.qid,
    questionGeneration: f.presentation.questionGeneration,
    target: f.presentation.target,
    source: 'current',
    materialized: true,
    reference: 'answer-1',
    answer: 'x'.repeat(4097)
  }).accepted, true);

  await f.gateway.decisionConsumer.recover(new AbortController().signal);
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.state.getDecisionClick('blocked-long-answer')?.nativeReturn?.outcome, null);
  assert.equal(f.state.listDecisionPendingWork().length, 1);
});

test('generic recovery does not dispatch while a decision projection is pending', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.gateway.decisionConsumer.recover = async () => [];
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'generic-projection-gate', presentationId: f.presentation.presentationId, selectedKey: 'approve',
    actorId: 'operator', guildId: 'guild', channelId: 'channel', messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);
  assert.equal(f.state.importDecisionWinner('generic-projection-gate', {
    qid: f.presentation.qid,
    questionGeneration: f.presentation.questionGeneration,
    target: f.presentation.target,
    source: 'current',
    materialized: true,
    reference: 'answer-generic-gate',
    answer: 'x'.repeat(4097)
  }).accepted, true);
  assert.equal(f.state.recordDecisionProjectionOutcome('generic-projection-gate', 'unknown').accepted, true);

  await f.gateway.reconcilePending();
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.state.listDecisionPendingWork().length, 1);

  assert.equal(f.state.recordDecisionProjectionOutcome('generic-projection-gate', 'rejected').accepted, true);
  await f.gateway.reconcilePending();
  assert.equal(f.dispatches.length, 1);
});

test('deleted question projection is terminal and releases long-answer native custody', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'deleted-question', presentationId: f.presentation.presentationId, selectedKey: 'approve',
    actorId: 'operator', guildId: 'guild', channelId: 'channel', messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel'), applicationId: 'application', token: 'deleted-token'
  });
  assert.equal(admitted.accepted, true);
  assert.equal(f.state.importDecisionWinner('deleted-question', {
    qid: f.presentation.qid,
    questionGeneration: f.presentation.questionGeneration,
    target: f.presentation.target,
    source: 'current',
    materialized: true,
    reference: 'answer-deleted',
    answer: 'x'.repeat(4097)
  }).accepted, true);

  f.gateway.projectDecisionMessage = async () => {
    throw Object.assign(new Error('Unknown Message'), { code: 10008, status: 404 });
  };
  await f.gateway.decisionConsumer.recover(new AbortController().signal);

  const click = f.state.getDecisionClick('deleted-question');
  assert.equal(click?.projectionOutcome, 'rejected');
  assert.equal(click?.nativeReturn?.outcome, 'submitted');
  assert.equal(click?.state, 'terminal');
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.state.listDecisionPendingWork().length, 0);
  assert.equal(click?.token, null);
});

test('deleted channel projection is terminal and releases long-answer native custody', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'deleted-channel', presentationId: f.presentation.presentationId, selectedKey: 'approve',
    actorId: 'operator', guildId: 'guild', channelId: 'channel', messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel'), applicationId: 'application', token: 'deleted-channel-token'
  });
  assert.equal(admitted.accepted, true);
  assert.equal(f.state.importDecisionWinner('deleted-channel', {
    qid: f.presentation.qid,
    questionGeneration: f.presentation.questionGeneration,
    target: f.presentation.target,
    source: 'current',
    materialized: true,
    reference: 'answer-deleted-channel',
    answer: 'x'.repeat(4097)
  }).accepted, true);

  f.gateway.projectDecisionMessage = async () => {
    throw Object.assign(new Error('Unknown Channel'), { code: 10003, status: 404, outcome: 'unknown' });
  };
  await f.gateway.decisionConsumer.recover(new AbortController().signal);

  const click = f.state.getDecisionClick('deleted-channel');
  assert.equal(click?.projectionOutcome, 'rejected');
  assert.equal(click?.nativeReturn?.outcome, 'submitted');
  assert.equal(click?.state, 'terminal');
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.state.listDecisionPendingWork().length, 0);
  assert.equal(click?.token, null);
});

test('unknown projection remains retryable after native submission and closes custody when sent', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'projection-unknown-replay', presentationId: f.presentation.presentationId, selectedKey: 'approve',
    actorId: 'operator', guildId: 'guild', channelId: 'channel', messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel'), applicationId: 'application', token: 'projection-token'
  });
  assert.equal(admitted.accepted, true);
  assert.equal(f.state.importDecisionWinner('projection-unknown-replay', {
    qid: f.presentation.qid,
    questionGeneration: f.presentation.questionGeneration,
    target: f.presentation.target,
    source: 'current',
    materialized: true,
    reference: 'answer-unknown',
    answer: 'x'.repeat(4097)
  }).accepted, true);
  assert.equal(f.state.recordDecisionProjectionOutcome('projection-unknown-replay', 'unknown').accepted, true);
  assert.equal(f.state.recordDecisionNativeReturnOutcome('projection-unknown-replay', 'submitted').accepted, true);
  assert.equal(f.state.getDecisionClick('projection-unknown-replay')?.state, 'materialized_projection_pending');
  assert.equal(f.state.listDecisionPendingWork().length, 1);

  assert.equal(f.state.recordDecisionProjectionOutcome('projection-unknown-replay', 'sent').accepted, true);
  assert.equal(f.state.getDecisionClick('projection-unknown-replay')?.state, 'terminal');
  assert.equal(f.state.listDecisionPendingWork().length, 0);
  assert.equal(f.state.getDecisionClick('projection-unknown-replay')?.token, null);
  assert.equal(f.state.listReceipts().some(row => String(row.detail).includes('projection-token')), false);
});

test('long-answer replay waits for SENT projection before dispatching native work', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'projection-replay-boundary', presentationId: f.presentation.presentationId, selectedKey: 'approve',
    actorId: 'operator', guildId: 'guild', channelId: 'channel', messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);
  assert.equal(f.state.importDecisionWinner('projection-replay-boundary', {
    qid: f.presentation.qid,
    questionGeneration: f.presentation.questionGeneration,
    target: f.presentation.target,
    source: 'current',
    materialized: true,
    reference: 'answer-replay',
    answer: 'x'.repeat(4097)
  }).accepted, true);

  let projectionAttempts = 0;
  f.gateway.projectDecisionMessage = async () => {
    projectionAttempts += 1;
    throw Object.assign(new Error('projection response was lost'), { outcome: 'unknown' });
  };
  await f.gateway.decisionConsumer.recover(new AbortController().signal);
  assert.equal(f.dispatches.length, 0);
  assert.equal(projectionAttempts, 1);

  f.gateway.projectDecisionMessage = async () => { projectionAttempts += 1; };
  await f.gateway.decisionConsumer.recover(new AbortController().signal);
  assert.equal(f.dispatches.length, 1);
  assert.equal(projectionAttempts, 2);
  await f.gateway.decisionConsumer.recover(new AbortController().signal);
  assert.equal(f.dispatches.length, 1);
});

test('same-interaction replay retries an unknown long projection before native dispatch', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  const interactionId = 'duplicate-projection-replay';
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId, presentationId: f.presentation.presentationId, selectedKey: 'approve',
    actorId: 'operator', guildId: 'guild', channelId: 'channel', messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);
  assert.equal(f.state.recordDecisionCallbackOutcome(interactionId, 'sent').accepted, true);
  assert.equal(f.state.importDecisionWinner(interactionId, {
    qid: f.presentation.qid,
    questionGeneration: f.presentation.questionGeneration,
    target: f.presentation.target,
    source: 'current',
    materialized: true,
    reference: 'answer-duplicate-replay',
    answer: 'x'.repeat(4097)
  }).accepted, true);
  let projectionAttempts = 0;
  f.gateway.projectDecisionMessage = async () => {
    projectionAttempts += 1;
    if (projectionAttempts === 1) throw Object.assign(new Error('projection response was lost'), { outcome: 'unknown' });
  };

  await f.gateway.handleInteraction(component(f.presentation, interactionId, 0), new AbortController().signal);
  assert.equal(f.dispatches.length, 0);
  await f.gateway.handleInteraction(component(f.presentation, interactionId, 0), new AbortController().signal);
  assert.equal(f.dispatches.length, 1);
  assert.equal(projectionAttempts, 2);
});

test('restart classifies an interrupted rejection as terminal without resending', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const admitted = f.state.admitDecisionClickAndBeginAuthorization({
    interactionId: 'rejection-restart', presentationId: f.presentation.presentationId, selectedKey: 'hold',
    actorId: 'operator', guildId: 'guild', channelId: 'channel', messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel'), applicationId: 'application', token: 'rejection-token'
  });
  assert.equal(admitted.accepted, true);
  assert.equal(f.state.recordDecisionAuthorizationOutcome('rejection-restart', 'denied').accepted, true);
  assert.equal(f.state.beginDecisionRejectionFollowup('rejection-restart').accepted, true);
  f.state.close();

  const recovered = new SurfaceState(f.db);
  recovered.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(f.dir, 'discord.secret') });
  assert.equal(recovered.listDecisionPendingWork().length, 1);
  recovered.recoverAfterRestart();
  assert.equal(recovered.listDecisionPendingWork().length, 0);
  assert.equal(recovered.listReceipts().some(row => String(row.detail).includes('rejection-token')), false);
  recovered.close();
});

test('permanent rejection drains denied custody and does not retry', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const admitted = f.state.admitDecisionClickAndBeginAuthorization({
    interactionId: 'rejection-permanent', presentationId: f.presentation.presentationId, selectedKey: 'hold',
    actorId: 'operator', guildId: 'guild', channelId: 'channel', messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel'), applicationId: 'application', token: 'rejected-token'
  });
  assert.equal(admitted.accepted, true);
  assert.equal(f.state.recordDecisionAuthorizationOutcome('rejection-permanent', 'denied').accepted, true);
  assert.equal(f.state.beginDecisionRejectionFollowup('rejection-permanent').accepted, true);
  assert.equal(f.state.recordDecisionRejectionOutcome('rejection-permanent', 'rejected').accepted, true);
  assert.equal(f.state.listDecisionPendingWork().length, 0);
  assert.equal(f.state.beginDecisionRejectionFollowup('rejection-permanent').accepted, false);
  assert.equal(f.state.listReceipts().some(row => String(row.detail).includes('rejected-token')), false);
});

test('rejection followup distinguishes pre-send and post-send cancellation', { timeout: 30000 }, async t => {
  const interaction = { applicationId: 'application', token: 'transport-token' };
  const before = new AbortController();
  before.abort();
  let beforeCalls = 0;
  const beforeResult = await sendInteractionFollowup(interaction, {
    signal: before.signal,
    fetchImpl: async () => { beforeCalls += 1; return { ok: true, status: 204 }; }
  });
  assert.equal(beforeResult.outcome, 'not_sent');
  assert.equal(beforeCalls, 0);

  const after = new AbortController();
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const pending = sendInteractionFollowup(interaction, {
    signal: after.signal,
    fetchImpl: (_url, options) => {
      startedResolve();
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
  });
  await started;
  after.abort();
  const afterResult = await pending;
  assert.equal(afterResult.outcome, 'unknown');
});

test('a full-length decision keeps every prompt character after selection', { timeout: 30000 }, async t => {
  const sample = await fixture(t);
  const suffixLength = sample.posts[0].content.length - sample.request.question.length;
  const f = await fixture(t, { questionText: 'Q'.repeat(2000 - suffixLength) });
  assert.equal(f.posts[0].content.length, 2000);
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'full-prompt', presentationId: f.presentation.presentationId, selectedKey: 'approve',
    actorId: 'operator', guildId: 'guild', channelId: 'channel', messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);
  await f.gateway.projectDecisionMessage({ click: admitted.click, presentation: f.presentation, answer: 'approve' },
    new AbortController().signal);
  assert.equal(f.edits[0].content, f.posts[0].content);
  assert.deepEqual(f.edits[0].embeds, [{ title: 'Selected action', description: 'approve' }]);
  assert.deepEqual(f.edits[0].components, []);
});

for (const length of [4096, 4097, 10000]) {
  test(`decision projection preserves a ${length}-character answer across repeated recovery edits`, { timeout: 30000 }, async t => {
    const f = await fixture(t);
    const admitted = f.state.admitDecisionClickAndBeginCallback({
      interactionId: `answer-${length}`, presentationId: f.presentation.presentationId, selectedKey: 'approve',
      actorId: 'operator', guildId: 'guild', channelId: 'channel', messageId: f.presentation.messageId,
      binding: f.state.getBinding('channel')
    });
    assert.equal(admitted.accepted, true);
    const answer = '文'.repeat(length);
    await f.gateway.projectDecisionMessage({ click: admitted.click, presentation: f.presentation, answer },
      new AbortController().signal);
    const recoveredState = new SurfaceState(f.db);
    const recovered = new DiscordGateway({ state: recoveredState, client: f.gateway.client });
    t.after(async () => { await recovered.stop(); recoveredState.close(); });
    await recovered.projectDecisionMessage({ click: recoveredState.getDecisionClick(`answer-${length}`), answer },
      new AbortController().signal);
    assert.equal(f.edits.length, 2);
    for (const payload of f.edits) {
      assert.equal(payload.content, f.posts[0].content);
      assert.deepEqual(payload.components, []);
      assert.deepEqual(payload.attachments, []);
      assert.deepEqual(payload.allowedMentions, { parse: [] });
      assert.ok(payload.embeds[0].description.length <= 4096);
      if (length <= 4096) {
        assert.equal(payload.embeds[0].description, answer);
        assert.equal(payload.files, undefined);
      } else {
        assert.equal(payload.files.length, 1);
        assert.equal(payload.files[0].name, 'selected-action.txt');
        assert.deepEqual(payload.files[0].attachment, Buffer.from(answer, 'utf8'));
      }
    }
  });
}
