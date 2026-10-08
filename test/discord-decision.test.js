'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PermissionFlagsBits } = require('discord.js');

const { presentDecision } = require('../src/decision-present');
const { DiscordGateway } = require('../src/discord');
const { createDecisionConsumer } = require('../src/discord/decision');
const { encodeDecisionCustomId, sendInteractionFollowup } = require('../src/discord-interaction');
const { DECISION_RECEIPT_KINDS, READINESS, SurfaceState } = require('../src/state');

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
  const dispatchResults = [];
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
        async dispatch(message) { dispatches.push(message); return dispatchResults.shift() || { status: 'submitted' }; }
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
  return { dir, db, state, request, presentation, posts, edits, callbacks, dispatches, dispatchResults, gateway, listeners,
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

test('decision recovery retains authorized clicks when their saved binding is replaced or retired', { timeout: 30000 }, async t => {
  const scenarios = [
    { name: 'replacement generation', current: binding => ({ ...binding, generation: binding.generation + 1 }) },
    { name: 'inactive binding', current: binding => ({ ...binding, active: false }) }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async subtest => {
      const f = await fixture(subtest);
      const interactionId = `held-authorized-${scenario.name.replaceAll(' ', '-')}`;
      const listener = f.listeners.get('interactionCreate');
      assert.equal(typeof listener, 'function');
      f.gateway.authorizeDecisionInteraction = async () => true;

      listener(component(f.presentation, interactionId, 0));
      await waitForCondition(() => f.callbacks.length === 1, 'held decision callback was not attempted');
      await Promise.all([...f.gateway.inFlight]);

      const held = f.state.getDecisionClick(interactionId);
      assert.equal(held.authorizationOutcome, 'authorized');
      assert.equal(held.state, 'canonical_pending');
      assert.equal(held.canonical, null);

      const getBinding = f.state.getBinding.bind(f.state);
      f.state.getBinding = channelId => {
        const binding = getBinding(channelId);
        return channelId === 'channel' && binding ? scenario.current(binding) : binding;
      };
      f.gateway.ready = true;
      f.gateway.started = true;
      f.gateway.transportReady = true;

      const remaining = await f.gateway.startDecisionRecovery(new AbortController().signal, new Set(['channel']));
      const recovered = f.state.getDecisionClick(interactionId);
      assert.equal(recovered.state, 'canonical_pending');
      assert.equal(recovered.canonical, null);
      assert.equal(recovered.nativeReturn, null);
      assert.deepEqual(f.state.listDecisionPendingWork().map(click => click.interactionId), [interactionId]);
      assert.deepEqual(remaining.map(click => click.interactionId), [interactionId]);
      assert.equal(f.dispatches.length, 0);
    });
  }
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

test('a normal recovery request wakes a pass that also has deferred work', { timeout: 8000 }, async t => {
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
  f.gateway.startDecisionRecovery(undefined, new Set(['channel-deferred']), { deferIfActive: true });
  f.gateway.startDecisionRecovery(undefined, new Set(['channel-live']));

  releaseFirst();
  await first;
  await waitForCondition(() => calls.length === 2, 'normal queued recovery did not wake the follow-up pass');
  assert.deepEqual(calls, [['channel-a'], ['channel-deferred', 'channel-live']]);
});

test('delayed decision recovery wakes after its retry window', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const calls = [];
  f.gateway.decisionConsumer.recover = async (_signal, channelIds) => {
    calls.push(channelIds ? [...channelIds] : null);
    return [];
  };

  const startedAt = Date.now();
  f.gateway.scheduleDecisionRecovery(new Set(['channel']), { delayMs: 25 });
  assert.deepEqual(calls, []);
  await waitForCondition(() => calls.length === 1, 'delayed decision recovery did not wake');
  assert.ok(Date.now() - startedAt >= 20);
  assert.deepEqual(calls, [['channel']]);
});

test('delayed decision recovery wakes each channel at its own deadline', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const calls = [];
  f.gateway.decisionConsumer.recover = async (_signal, channelIds) => {
    calls.push(channelIds ? [...channelIds] : null);
    return [];
  };

  f.gateway.scheduleDecisionRecovery(new Set(['channel-a']), { delayMs: 25 });
  f.gateway.scheduleDecisionRecovery(new Set(['channel-b']), { delayMs: 100 });
  await waitForCondition(() => calls.length === 1, 'first channel recovery did not wake');
  assert.deepEqual(calls, [['channel-a']]);
  await waitForCondition(() => calls.length === 2, 'second channel recovery did not wake');
  assert.deepEqual(calls, [['channel-a'], ['channel-b']]);
});

test('decision recovery does not retry a later deadline in an early channel wake', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const attempts = [];
  for (const interactionId of ['short-retry', 'long-retry']) {
    const admitted = f.state.admitDecisionClickAndBeginAuthorization({
      interactionId,
      presentationId: f.presentation.presentationId,
      selectedKey: 'hold',
      actorId: 'operator',
      guildId: 'guild',
      channelId: 'channel',
      messageId: f.presentation.messageId,
      binding: f.state.getBinding('channel'),
      applicationId: 'application',
      token: `token-${interactionId}`
    });
    assert.equal(admitted.accepted, true);
    assert.equal(f.state.recordDecisionAuthorizationOutcome(interactionId, 'denied').accepted, true);
    assert.equal(f.state.recordDecisionCallbackOutcome(interactionId, 'sent').accepted, true);
  }
  f.gateway.sendInteractionRejection = async interaction => {
    attempts.push(interaction.id);
    return { outcome: 'rate_limited', retryAfterMs: interaction.id === 'short-retry' ? 25 : 180 };
  };

  await f.gateway.decisionConsumer.recover(new AbortController().signal);
  assert.deepEqual(attempts, ['short-retry', 'long-retry']);
  await waitForCondition(() => attempts.filter(id => id === 'short-retry').length >= 2,
    'short retry did not wake');
  assert.equal(attempts.filter(id => id === 'long-retry').length, 1);
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

for (const callbackOutcome of ['rate_limited', 'rejected', 'not_sent', 'unknown']) {
  test(`rejection recovery resolves ${callbackOutcome} callback custody without a follow-up`, { timeout: 30000 }, async t => {
    const f = await fixture(t);
    const interactionId = `rejection-callback-${callbackOutcome}`;
    const admitted = f.state.admitDecisionClickAndBeginAuthorization({
      interactionId,
      presentationId: f.presentation.presentationId,
      selectedKey: 'hold',
      actorId: 'operator',
      guildId: 'guild',
      channelId: 'channel',
      messageId: f.presentation.messageId,
      binding: f.state.getBinding('channel'),
      applicationId: 'application',
      token: `token-${interactionId}`
    });
    assert.equal(admitted.accepted, true);
    assert.equal(f.state.recordDecisionAuthorizationOutcome(interactionId, 'denied').accepted, true);
    assert.equal(f.state.recordDecisionCallbackOutcome(interactionId, callbackOutcome).accepted, true);

    const remaining = await f.gateway.decisionConsumer.recover(new AbortController().signal);

    assert.equal(f.callbacks.length, 0);
    assert.deepEqual(remaining, []);
    assert.equal(f.state.listDecisionPendingWork().length, 0);
    const rejection = f.state.listReceipts()
      .filter(row => row.kind === DECISION_RECEIPT_KINDS.REJECTION_OUTCOME)
      .map(row => JSON.parse(row.detail))
      .find(detail => detail.interactionId === interactionId);
    assert.equal(rejection.outcome,
      callbackOutcome === 'rejected' ? 'rejected' : 'unknown');
  });
}

test('rejection recovery sends a follow-up only after an accepted callback', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const interactionId = 'rejection-callback-sent';
  const admitted = f.state.admitDecisionClickAndBeginAuthorization({
    interactionId,
    presentationId: f.presentation.presentationId,
    selectedKey: 'hold',
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel'),
    applicationId: 'application',
    token: `token-${interactionId}`
  });
  assert.equal(admitted.accepted, true);
  assert.equal(f.state.recordDecisionAuthorizationOutcome(interactionId, 'denied').accepted, true);
  assert.equal(f.state.recordDecisionCallbackOutcome(interactionId, 'sent').accepted, true);

  const remaining = await f.gateway.decisionConsumer.recover(new AbortController().signal);

  assert.deepEqual(remaining, []);
  assert.equal(f.callbacks.length, 1);
  assert.equal(f.callbacks[0].body.flags, 64);
  assert.equal(f.state.listDecisionPendingWork().length, 0);
});

test('rejection outcome persistence failures escape both follow-up paths', { timeout: 30000 }, async t => {
  const source = fs.readFileSync(path.join(__dirname, '../src/discord/decision.ts'), 'utf8');
  assert.equal((source.match(/state\.recordDecisionRejectionOutcome\(/g) || []).length, 1);

  const interrupted = await fixture(t);
  const interruptedId = 'rejection-write-interrupted';
  const admitted = interrupted.state.admitDecisionClickAndBeginAuthorization({
    interactionId: interruptedId,
    presentationId: interrupted.presentation.presentationId,
    selectedKey: 'hold',
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    messageId: interrupted.presentation.messageId,
    binding: interrupted.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);
  assert.equal(interrupted.state.recordDecisionAuthorizationOutcome(interruptedId, 'denied').accepted, true);
  assert.equal(interrupted.state.recordDecisionCallbackOutcome(interruptedId, 'unknown').accepted, true);
  interrupted.state.recordDecisionRejectionOutcome = () => { throw new Error('rejection outcome write failed'); };

  await assert.rejects(
    interrupted.gateway.handleInteraction(component(interrupted.presentation, interruptedId, 1), new AbortController().signal),
    /rejection outcome write failed/
  );

  const followup = await fixture(t);
  followup.gateway.authorizeDecisionInteraction = async () => false;
  followup.state.recordDecisionRejectionOutcome = () => { throw new Error('rejection outcome write failed'); };

  await assert.rejects(
    followup.gateway.handleInteraction(component(followup.presentation, 'rejection-write-followup', 1), new AbortController().signal),
    /rejection outcome write failed/
  );
  assert.equal(followup.callbacks.length, 2);
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

test('missing projection handler retains short-answer custody after native submission', { timeout: 30000 }, async t => {
  const f = await fixture(t, { questionText: 'q'.repeat(1800) });
  const interactionId = 'short-answer-without-projector';
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
    reference: 'short-answer-without-projector',
    answer: 'accepted answer'
  }).accepted, true);

  const consumer = createDecisionConsumer({
    state: f.state,
    processAccepted: (message, signal, options) => f.gateway.consumer.processAccepted(message, signal, options)
  });
  await consumer.recover(new AbortController().signal);

  const click = f.state.getDecisionClick(interactionId);
  assert.equal(f.dispatches.length, 1);
  assert.equal(click.nativeReturn?.outcome, 'submitted');
  assert.equal(click.projectionOutcome, 'not_sent');
  assert.equal(click.state, 'materialized_projection_pending');
  assert.equal(f.state.listDecisionPendingWork().length, 1);
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

test('decision recovery refuses a pending click after its binding is replaced', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  const interactionId = 'recovery-replaced-binding';
  const savedBinding = f.state.getBinding('channel');
  const admitted = f.state.admitDecisionClickAndBeginAuthorization({
    interactionId,
    presentationId: f.presentation.presentationId,
    selectedKey: 'approve',
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    messageId: f.presentation.messageId,
    binding: savedBinding,
    applicationId: 'application',
    token: 'recovery-replaced-token'
  });
  assert.equal(admitted.accepted, true);
  assert.equal(f.state.recordDecisionCallbackOutcome(interactionId, 'sent').accepted, true);
  const authorizationOutcomes = [];
  const recordAuthorizationOutcome = f.state.recordDecisionAuthorizationOutcome.bind(f.state);
  f.state.recordDecisionAuthorizationOutcome = (id, outcome) => {
    authorizationOutcomes.push(outcome);
    return recordAuthorizationOutcome(id, outcome);
  };
  f.gateway.authorizeDecisionInteraction = async () => null;
  await f.gateway.startDecisionRecovery(new AbortController().signal, new Set(['channel']));

  const getBinding = f.state.getBinding.bind(f.state);
  f.state.getBinding = channelId => {
    const binding = getBinding(channelId);
    return binding && channelId === 'channel' ? { ...binding, generation: binding.generation + 1 } : binding;
  };
  let authorizationCalls = 0;
  f.gateway.authorizeDecisionInteraction = async () => {
    authorizationCalls += 1;
    return true;
  };

  await f.gateway.startDecisionRecovery(new AbortController().signal, new Set(['channel']));

  assert.equal(authorizationCalls, 0);
  assert.deepEqual(authorizationOutcomes, ['denied']);
  assert.equal(f.state.getDecisionClick(interactionId), null);
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.state.listDecisionPendingWork().length, 0);
});

test('decision recovery rechecks binding generation after authorization awaits', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  const interactionId = 'recovery-binding-retired-during-authorization';
  const savedBinding = f.state.getBinding('channel');
  const admitted = f.state.admitDecisionClickAndBeginAuthorization({
    interactionId,
    presentationId: f.presentation.presentationId,
    selectedKey: 'approve',
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    messageId: f.presentation.messageId,
    binding: savedBinding,
    applicationId: 'application',
    token: 'recovery-retired-token'
  });
  assert.equal(admitted.accepted, true);
  assert.equal(f.state.recordDecisionCallbackOutcome(interactionId, 'sent').accepted, true);
  const authorizationOutcomes = [];
  const recordAuthorizationOutcome = f.state.recordDecisionAuthorizationOutcome.bind(f.state);
  f.state.recordDecisionAuthorizationOutcome = (id, outcome) => {
    authorizationOutcomes.push(outcome);
    return recordAuthorizationOutcome(id, outcome);
  };

  let resolveAuthorization;
  let enteredAuthorization;
  const authorizationEntered = new Promise(resolve => { enteredAuthorization = resolve; });
  f.gateway.authorizeDecisionInteraction = async () => {
    enteredAuthorization();
    return await new Promise(resolve => { resolveAuthorization = resolve; });
  };
  const recovering = f.gateway.startDecisionRecovery(new AbortController().signal, new Set(['channel']));
  await authorizationEntered;

  const getBinding = f.state.getBinding.bind(f.state);
  f.state.getBinding = channelId => {
    const binding = getBinding(channelId);
    return binding && channelId === 'channel' ? { ...binding, generation: binding.generation + 1 } : binding;
  };
  resolveAuthorization(true);
  await recovering;

  assert.deepEqual(authorizationOutcomes, ['denied']);
  assert.equal(f.state.getDecisionClick(interactionId), null);
  assert.equal(f.dispatches.length, 0);
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

test('decision recovery join is bounded by the reconciliation deadline', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  f.gateway.recoveryTimeoutMs = 50;
  const interactionId = '9002';
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
  assert.equal(f.state.acceptDiscordMessage({
    id: interactionId,
    guildId: 'guild',
    channelId: 'channel',
    authorId: 'operator',
    isBot: false,
    attachments: [],
    content: 'accepted decision message'
  }).accepted, true);

  let releaseDecisionRecovery;
  const stalledDecisionRecovery = new Promise(resolve => { releaseDecisionRecovery = resolve; });
  f.gateway.decisionConsumer.recover = () => stalledDecisionRecovery;
  const reconciliation = f.gateway.reconcilePending();
  await waitForCondition(() => Boolean(f.gateway.decisionRecoveryPromise), 'decision recovery did not start');
  const decisionPass = f.gateway.decisionRecoveryPromise;

  await reconciliation;
  assert.equal(f.dispatches.length, 0);

  releaseDecisionRecovery([]);
  await decisionPass;
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

for (const retryableOutcome of ['rate_limited', 'not_sent']) {
  test(`rejection recovery preserves custody without an exponential retry service: ${retryableOutcome}`, { timeout: 30000 }, async t => {
    const f = await fixture(t);
    const recoveryCalls = [];
    f.gateway.scheduleDecisionRecovery = (channelIds, options) => {
      recoveryCalls.push({ channelIds: channelIds ? [...channelIds] : null, options });
      return null;
    };
    f.gateway.authorizeDecisionInteraction = async () => false;
    f.gateway.sendInteractionRejection = async () => ({
      outcome: retryableOutcome,
      ...(retryableOutcome === 'rate_limited' ? { retryAfterMs: 25 } : {})
    });

    const result = await f.gateway.handleInteraction(
      component(f.presentation, `retryable-rejection-${retryableOutcome}`, 0),
      new AbortController().signal
    );

    assert.equal(result.accepted, false);
    assert.deepEqual(recoveryCalls, retryableOutcome === 'rate_limited' ? [{
      channelIds: ['channel'],
      options: { delayMs: 25, decisionId: `retryable-rejection-${retryableOutcome}` }
    }] : []);
    const interactionId = `retryable-rejection-${retryableOutcome}`;
    assert.equal(f.state.getDecisionClick(interactionId)?.rejectionRetryDeadline, undefined);
    const rejection = f.state.listReceipts()
      .filter(row => row.kind === DECISION_RECEIPT_KINDS.REJECTION_OUTCOME)
      .map(row => JSON.parse(row.detail))
      .find(detail => detail.interactionId === interactionId);
    assert.equal(rejection.outcome, retryableOutcome);
    assert.equal('retryDeadline' in rejection, false);
    assert.equal(f.state.listDecisionPendingWork().some(click => click.interactionId === interactionId), true);
  });
}

test('duplicate denial honors in-memory Retry-After through channel recovery', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const interactionId = 'duplicate-rate-limited-rejection';
  const recoveryCalls = [];
  f.gateway.scheduleDecisionRecovery = (channelIds, options) => {
    recoveryCalls.push({ channelIds: [...channelIds], options });
    return null;
  };
  f.gateway.authorizeDecisionInteraction = async () => false;
  let rejectionCalls = 0;
  f.gateway.sendInteractionRejection = async () => {
    rejectionCalls += 1;
    return { outcome: 'rate_limited', retryAfterMs: 500 };
  };

  const first = await f.gateway.handleInteraction(
    component(f.presentation, interactionId, 0, { token: 'duplicate-rate-limited-initial' }),
    new AbortController().signal
  );
  assert.equal(first.accepted, false);
  assert.equal(rejectionCalls, 1);

  const duplicate = await f.gateway.handleInteraction(
    component(f.presentation, interactionId, 0, { token: 'duplicate-rate-limited-replay' }),
    new AbortController().signal
  );
  assert.equal(duplicate.accepted, false);
  assert.equal(rejectionCalls, 1);
  assert.equal(recoveryCalls.length, 2);
  assert.deepEqual(recoveryCalls[0].options, { delayMs: 500, decisionId: interactionId });
  assert.ok(recoveryCalls[1].options.delayMs > 0);
  assert.ok(recoveryCalls[1].options.delayMs <= 500);
  assert.equal(recoveryCalls[1].options.decisionId, interactionId);

  const fullRecovery = await f.gateway.decisionConsumer.recover(new AbortController().signal);
  assert.equal(rejectionCalls, 1);
  assert.equal(fullRecovery.some(click => click.interactionId === interactionId), true);
  assert.equal(recoveryCalls.length, 3);
  assert.ok(recoveryCalls[2].options.delayMs > 0);
  assert.ok(recoveryCalls[2].options.delayMs <= 500);
});

test('scheduled rejection retry does not restart a repeated rate-limit loop', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const recoveryCalls = [];
  f.gateway.scheduleDecisionRecovery = (channelIds, options) => {
    recoveryCalls.push({ channelIds: channelIds ? [...channelIds] : null, options });
    return null;
  };
  f.gateway.authorizeDecisionInteraction = async () => false;
  let rejectionCalls = 0;
  f.gateway.sendInteractionRejection = async () => {
    rejectionCalls += 1;
    return { outcome: 'rate_limited', retryAfterMs: 25 };
  };
  const interactionId = 'bounded-rate-limited-rejection';

  await f.gateway.handleInteraction(
    component(f.presentation, interactionId, 0),
    new AbortController().signal
  );
  assert.equal(rejectionCalls, 1);
  assert.equal(recoveryCalls.length, 1);

  await new Promise(resolve => setTimeout(resolve, 40));
  await f.gateway.decisionConsumer.recover(new AbortController().signal, new Set(['channel']));

  assert.equal(rejectionCalls, 2);
  assert.equal(recoveryCalls.length, 1);
  assert.equal(f.state.listDecisionPendingWork().some(click => click.interactionId === interactionId), true);
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

  const recoveryCalls = [];
  f.gateway.scheduleDecisionRecovery = (channelIds, options) => {
    recoveryCalls.push({ channelIds: [...channelIds], options });
    return null;
  };

  const result = await f.gateway.handleInteraction(component(f.presentation, interactionId, 0), new AbortController().signal);

  assert.equal(result.accepted, true);
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.state.getDecisionClick('short-projection-retry')?.projectionOutcome, 'not_sent');
  assert.equal(f.state.getDecisionClick('short-projection-retry')?.state, 'materialized_projection_pending');
  assert.equal(f.state.listDecisionPendingWork().length, 1);
  assert.deepEqual(recoveryCalls, [{
    channelIds: ['channel'],
    options: { delayMs: 1000, decisionId: 'short-projection-retry' }
  }]);

  f.setEmbedLinks(true);
  f.setAttachFiles(true);
  await f.gateway.reconcilePending();

  assert.equal(f.edits.length, 1);
  assert.equal(f.state.getDecisionClick('short-projection-retry')?.projectionOutcome, 'sent');
  assert.equal(f.state.listDecisionPendingWork().length, 0);
});

test('known-unsent native delivery resumes after short projection retry', { timeout: 30000 }, async t => {
  const f = await fixture(t, { questionText: 'q'.repeat(1800), embedLinks: false, attachFiles: false });
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  const interactionId = 'short-projection-known-unsent';
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
    reference: 'known-unsent-answer',
    answer: 'x'.repeat(100)
  }).accepted, true);
  f.dispatchResults.push({ status: 'not_submitted' }, { status: 'submitted' });

  await f.gateway.handleInteraction(component(f.presentation, interactionId, 0), new AbortController().signal);

  assert.equal(f.dispatches.length, 1);
  assert.equal(f.state.getDecisionClick(interactionId)?.projectionOutcome, 'not_sent');
  assert.equal(f.state.getDecisionClick(interactionId)?.nativeReturn?.outcome, 'not_submitted');
  assert.equal(f.state.listDecisionPendingWork().length, 1);

  f.setEmbedLinks(true);
  await f.gateway.reconcilePending();

  assert.equal(f.edits.length, 1);
  assert.equal(f.dispatches.length, 2);
  assert.equal(f.state.getDecisionClick(interactionId)?.projectionOutcome, 'sent');
  assert.equal(f.state.getDecisionClick(interactionId)?.nativeReturn?.outcome, 'submitted');
  assert.equal(f.state.listDecisionPendingWork().length, 0);
});

test('persistent projection failure stops self-scheduled retries but allows external recovery', { timeout: 30000 }, async t => {
  const f = await fixture(t, { questionText: 'q'.repeat(1800), embedLinks: false, attachFiles: false });
  const interactionId = 'bounded-projection-retry';
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
    reference: 'bounded-answer',
    answer: 'x'.repeat(100)
  }).accepted, true);

  const recoveryCalls = [];
  f.gateway.scheduleDecisionRecovery = (channelIds, options) => {
    recoveryCalls.push({ channelIds: [...channelIds], options });
    return null;
  };
  let projectionAttempts = 0;
  f.gateway.projectDecisionMessage = async () => {
    projectionAttempts += 1;
    throw Object.assign(new Error('projection permission remains unavailable'), { outcome: 'not_sent', retryable: true });
  };

  for (let attempt = 0; attempt < 6; attempt += 1) {
    await f.gateway.decisionConsumer.recover(new AbortController().signal);
  }

  assert.equal(projectionAttempts, 6);
  assert.deepEqual(recoveryCalls.map(call => call.options.delayMs), [1000, 2000, 4000, 8000, 16000]);
  assert.equal(f.state.getDecisionClick(interactionId)?.projectionOutcome, 'not_sent');
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

test('long-answer projection failure does not block native work', { timeout: 30000 }, async t => {
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
  const click = f.state.getDecisionClick('blocked-long-answer');
  assert.equal(f.dispatches.length, 1);
  assert.equal(click?.projectionOutcome, 'not_sent');
  assert.equal(click?.nativeReturn?.outcome, 'submitted');
  assert.equal(click?.state, 'materialized_projection_pending');
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

test('long-answer replay dispatches native work while projection remains pending', { timeout: 30000 }, async t => {
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
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.state.getDecisionClick('projection-replay-boundary')?.nativeReturn?.outcome, 'submitted');
  assert.equal(f.state.getDecisionClick('projection-replay-boundary')?.state, 'materialized_projection_pending');
  assert.equal(projectionAttempts, 1);

  f.gateway.projectDecisionMessage = async () => { projectionAttempts += 1; };
  await f.gateway.decisionConsumer.recover(new AbortController().signal);
  assert.equal(f.dispatches.length, 1);
  assert.equal(projectionAttempts, 2);
  await f.gateway.decisionConsumer.recover(new AbortController().signal);
  assert.equal(f.dispatches.length, 1);
});

test('same-interaction replay retries an unknown long projection after native dispatch', { timeout: 30000 }, async t => {
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
  const recoveryCalls = [];
  f.gateway.scheduleDecisionRecovery = (channelIds, options) => {
    recoveryCalls.push({ channelIds: [...channelIds], options });
    return null;
  };
  const currentTime = Date.now;
  let now = currentTime();
  Date.now = () => now;
  try {
    await f.gateway.handleInteraction(component(f.presentation, interactionId, 0), new AbortController().signal);
    assert.equal(f.dispatches.length, 1);
    await f.gateway.handleInteraction(component(f.presentation, interactionId, 0), new AbortController().signal);
    assert.equal(f.dispatches.length, 1);
    assert.equal(projectionAttempts, 1);
    assert.deepEqual(recoveryCalls.map(call => call.options.delayMs), [1000, 1000]);

    now += 1001;
    await f.gateway.handleInteraction(component(f.presentation, interactionId, 0), new AbortController().signal);
    assert.equal(f.dispatches.length, 1);
    assert.equal(projectionAttempts, 2);
  } finally {
    Date.now = currentTime;
  }
});

test('restart retains custody for an interrupted rejection followup', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const admitted = f.state.admitDecisionClickAndBeginAuthorization({
    interactionId: 'rejection-restart', presentationId: f.presentation.presentationId, selectedKey: 'hold',
    actorId: 'operator', guildId: 'guild', channelId: 'channel', messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel'), applicationId: 'application', token: 'rejection-token'
  });
  assert.equal(admitted.accepted, true);
  assert.equal(f.state.recordDecisionAuthorizationOutcome('rejection-restart', 'denied').accepted, true);
  assert.equal(f.state.recordDecisionCallbackOutcome('rejection-restart', 'sent').accepted, true);
  assert.equal(f.state.beginDecisionRejectionFollowup('rejection-restart').accepted, true);
  f.state.close();

  const recovered = new SurfaceState(f.db);
  recovered.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(f.dir, 'discord.secret') });
  assert.equal(recovered.listDecisionPendingWork().length, 1);
  recovered.recoverAfterRestart();
  const pending = recovered.listDecisionPendingWork();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.rejectionOutcome, 'unknown');
  assert.equal(pending[0]?.token, 'rejection-token');
  assert.equal(recovered.listReceipts().some(row => String(row.detail).includes('rejection-token')), false);
  recovered.close();
});

test('unknown rejection followup retries once and clears custody after delivery', { timeout: 30000 }, async t => {
  let calls = 0;
  const f = await fixture(t, {
    callback: async () => {
      calls += 1;
      if (calls === 2) throw new Error('followup response timed out');
      return { ok: true, status: 204 };
    }
  });
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  f.gateway.authorizeDecisionInteraction = async () => false;

  const result = await f.gateway.handleInteraction(component(f.presentation, 'rejection-timeout', 0), new AbortController().signal);
  assert.equal(result.accepted, false);
  assert.equal(calls, 2);
  const pending = f.state.listDecisionPendingWork();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.rejectionOutcome, 'unknown');
  assert.equal(pending[0]?.token, 'token-rejection-timeout');

  await waitForCondition(() => calls === 3, 'unknown rejection followup was not retried');
  assert.equal(f.state.listDecisionPendingWork().length, 0);
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

  const rateLimited = await sendInteractionFollowup(interaction, {
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get(name) { return name.toLowerCase() === 'retry-after' ? '4.5' : null; } },
      body: { async cancel() {} }
    })
  });
  assert.equal(rateLimited.outcome, 'rate_limited');
  assert.equal(rateLimited.retryAfterMs, 4500);
});

test('rejection followup keeps a received rate limit when metadata cleanup times out', { timeout: 30000 }, async t => {
  const interaction = { applicationId: 'application', token: 'transport-timeout-token' };
  const result = await sendInteractionFollowup(interaction, {
    timeoutMs: 20,
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get() { return null; } },
      async json() { return new Promise(() => {}); },
      body: { cancel() { return new Promise(() => {}); } }
    })
  });

  assert.equal(result.outcome, 'rate_limited');
  assert.equal(result.statusCode, 429);
  assert.equal(result.retryAfterMs, undefined);
});

test('rejection followup preserves known statuses when body cleanup times out', { timeout: 30000 }, async t => {
  const interaction = { applicationId: 'application', token: 'transport-timeout-token' };

  for (const response of [
    { ok: true, status: 204, expected: 'sent' },
    { ok: false, status: 400, expected: 'rejected' }
  ]) {
    const result = await sendInteractionFollowup(interaction, {
      timeoutMs: 20,
      fetchImpl: async () => ({
        ok: response.ok,
        status: response.status,
        body: { cancel() { return new Promise(() => {}); } }
      })
    });

    assert.equal(result.outcome, response.expected);
    assert.equal(result.statusCode, response.status);
  }
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
