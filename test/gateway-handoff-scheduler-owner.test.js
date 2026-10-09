'use strict';


const assert = require('node:assert/strict');

const fs = require('node:fs');

const os = require('node:os');

const path = require('node:path');

const test = require('node:test');

const Module = require('node:module');

const ts = require('typescript');

const { facadeOwnerInventory } = require('./helpers/facade-owner-inventory.cjs');

const {
  GATEWAY_PATH, OWNER_PATH, METHOD_HASHES, DEPENDENCY_NAMES,
  sourceFile, methodOf, hasExactFacade, classStateInventory, exactOwnerContract, withFakeTimers,
  schedulerReceiver, ownerFromText, EXPECTED_SCHEDULER_CALLSITES,
  schedulerCallsiteInventory, assertSchedulerCallsiteInventory
} = require('./helpers/handoff-scheduler-owner.cjs');


test('public scheduler facades preserve receiver, extra arguments, synchronous return and thrown identity', () => {
  const sentinel = Object.freeze({ scheduler: 'return' });
  const rejection = new Error('scheduler throw sentinel');
  const calls = [];
  const results = { throws: false, value: sentinel };
  const handlers = Object.fromEntries(Object.keys(METHOD_HASHES).map(methodName => [methodName, function(...args) {
    calls.push({ methodName, receiver: this, args });
    if (results.throws) throw rejection;
    return results.value;
  }]));
  const savedOwner = require.cache[OWNER_PATH];
  const savedGateway = require.cache[GATEWAY_PATH];
  try {
    let factoryCalls = 0;
    let captured = null;
    require.cache[OWNER_PATH] = {
      id: OWNER_PATH, filename: OWNER_PATH, loaded: true,
      exports: { createHandoffSchedulerHandlers(dependencies) {
        factoryCalls += 1;
        captured = dependencies;
        return handlers;
      } }
    };
    delete require.cache[GATEWAY_PATH];
    const { DiscordGateway } = require(GATEWAY_PATH);
    assert.equal(factoryCalls, 1);
    assert.deepEqual(Object.keys(captured).sort(), DEPENDENCY_NAMES.slice().sort());
    assert.equal(captured.READINESS, require('../src/state').READINESS);
    assert.equal(captured.DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS, 100);
    assert.equal(captured.DEFERRED_HANDOFF_RECOVERY_MAX_DELAY_MS, 5000);
    assert.equal(captured.PENDING_HANDOFF_RECOVERY_POLL_MS, 100);
    for (const [methodName, arity] of [['scheduleDeferredHandoffRecovery', 1], ['schedulePendingHandoffRecoveryPoll', 0]]) {
      const method = DiscordGateway.prototype[methodName];
      assert.equal(method.length, arity);
      const receiver = Object.freeze({ marker: methodName });
      const argumentRows = [
        [Object.freeze({ first: methodName }), undefined, 42],
        [Object.freeze({ first: methodName }), Object.freeze({ second: methodName }), Object.freeze({ extra: methodName })]
      ];
      for (const args of argumentRows) {
      calls.length = 0;
      results.throws = false;
      const returned = method.apply(receiver, args);
      assert.equal(returned, sentinel);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].receiver, receiver);
      assert.equal(calls[0].methodName, methodName);
      assert.equal(calls[0].args.length, args.length);
      args.forEach((argument, index) => assert.equal(calls[0].args[index], argument));
      calls.length = 0;
      results.throws = true;
      assert.throws(() => method.apply(receiver, args), error => error === rejection);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].receiver, receiver);
      assert.equal(calls[0].methodName, methodName);
      assert.equal(calls[0].args.length, args.length);
      args.forEach((argument, index) => assert.equal(calls[0].args[index], argument));
      }
    }
  } finally {
    if (savedOwner) require.cache[OWNER_PATH] = savedOwner;
    else delete require.cache[OWNER_PATH];
    if (savedGateway) require.cache[GATEWAY_PATH] = savedGateway;
    else delete require.cache[GATEWAY_PATH];
  }
});


test('real strict owner keeps defaults in one place and reads option getters once', () => {
  const { createHandoffSchedulerHandlers } = require(OWNER_PATH);
  const handlers = createHandoffSchedulerHandlers({
    READINESS: { PENDING: 'pending', RECOVERING: 'recovering', READY: 'ready' },
    DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS: 100,
    DEFERRED_HANDOFF_RECOVERY_MAX_DELAY_MS: 500,
    PENDING_HANDOFF_RECOVERY_POLL_MS: 1000
  });
  for (const handler of Object.values(handlers)) {
    assert.throws(() => handler.call(undefined), TypeError);
    assert.throws(() => handler.call(null), TypeError);
  }
  withFakeTimers(timers => {
    const { DiscordGateway } = require(GATEWAY_PATH);
    const receiver = schedulerReceiver(DiscordGateway);
    let reads = 0;
    const options = Object.defineProperty({}, 'pendingGeneration', {
      enumerable: true,
      get() { reads += 1; return true; }
    });
    DiscordGateway.prototype.scheduleDeferredHandoffRecovery.call(receiver, 'getter-channel', options);
    assert.equal(reads, 1);
    assert.deepEqual([...receiver.deferredHandoffRecoveryChannels], []);
    assert.deepEqual([...receiver.pendingHandoffRecoveryChannels], ['getter-channel']);
    assert.equal(timers.length, 1);
  });
});


test('deferred scheduler replaces earlier timers, ignores stale callbacks and requeues separate sets through the facade', () => {
  withFakeTimers(timers => {
    const { DiscordGateway } = require(GATEWAY_PATH);
    const receiver = schedulerReceiver(DiscordGateway);
    const calls = [];
    const schedule = receiver.scheduleDeferredHandoffRecovery;
    receiver.scheduleDeferredHandoffRecovery = function(...args) {
      calls.push(args);
      return schedule.apply(this, args);
    };
    receiver.scheduleDeferredHandoffRecovery('ordinary-a');
    const stale = receiver.deferredHandoffRecoveryTimer;
    receiver.deferredHandoffRecoveryDelayMs = 1;
    receiver.scheduleDeferredHandoffRecovery('pending-b', { pendingGeneration: true });
    const current = receiver.deferredHandoffRecoveryTimer;
    assert.notEqual(current, stale);
    assert.equal(stale.cleared, true);
    stale.callback();
    assert.equal(receiver.deferredHandoffRecoveryTimer, current);
    assert.deepEqual([...receiver.deferredHandoffRecoveryChannels], ['ordinary-a']);
    assert.deepEqual([...receiver.pendingHandoffRecoveryChannels], ['pending-b']);
    receiver.transportReady = false;
    current.callback();
    assert.deepEqual(calls.map(args => args[0]), ['ordinary-a', 'pending-b', 'ordinary-a', 'pending-b']);
    assert.equal(calls[2][1].pendingGeneration, false);
    assert.deepEqual(calls[3][1], { pendingGeneration: true });
    assert.deepEqual([...receiver.deferredHandoffRecoveryChannels], ['ordinary-a']);
    assert.deepEqual([...receiver.pendingHandoffRecoveryChannels], ['pending-b']);
    assert.equal(timers.length, 3);
  });
});


test('busy recovery and pending poll re-enter through public scheduling methods', async () => {
  await withFakeTimers(async timers => {
    const { DiscordGateway } = require(GATEWAY_PATH);
    const receiver = schedulerReceiver(DiscordGateway);
    receiver.recoveryPromise = Promise.resolve();
    const deferredCalls = [];
    const scheduleDeferred = receiver.scheduleDeferredHandoffRecovery;
    receiver.scheduleDeferredHandoffRecovery = function(...args) {
      deferredCalls.push(args);
      return scheduleDeferred.apply(this, args);
    };
    receiver.scheduleDeferredHandoffRecovery('busy-ordinary');
    receiver.scheduleDeferredHandoffRecovery('busy-pending', { pendingGeneration: true });
    timers[0].callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(deferredCalls.slice(2).map(args => args[0]), [
      'busy-ordinary', 'busy-pending', 'busy-ordinary', 'busy-pending'
    ]);
    assert.equal(deferredCalls[3][1].pendingGeneration, true);
    assert.equal(deferredCalls[5][1].pendingGeneration, true);

    const pollReceiver = schedulerReceiver(DiscordGateway);
    pollReceiver.state.listPendingOrdinaryHandoffChannels = () => ['listed-pending'];
    pollReceiver.state.listBindings = () => [
      { active: true, readiness: 'pending', channelId: 'binding-pending' },
      { active: false, readiness: 'pending', channelId: 'inactive' }
    ];
    pollReceiver.state.isOrdinaryBinding = binding => binding.channelId === 'binding-pending';
    const polled = [];
    const pendingSchedule = pollReceiver.scheduleDeferredHandoffRecovery;
    pollReceiver.scheduleDeferredHandoffRecovery = function(...args) {
      polled.push(args);
      return pendingSchedule.apply(this, args);
    };
    const pollSchedule = pollReceiver.schedulePendingHandoffRecoveryPoll;
    let recursivePolls = 0;
    pollReceiver.schedulePendingHandoffRecoveryPoll = function(...args) {
      recursivePolls += 1;
      return pollSchedule.apply(this, args);
    };
    pollReceiver.schedulePendingHandoffRecoveryPoll();
    timers.at(-1).callback();
    assert.deepEqual(polled.map(args => args[0]), ['listed-pending', 'binding-pending']);
    assert.ok(polled.every(args => args[1].pendingGeneration === true));
    assert.equal(recursivePolls, 2);
    assert.ok(pollReceiver.pendingHandoffRecoveryPollTimer);
  });
});


test('recursive dispatch controls reject owner-local calls that bypass public overrides', async () => {
  const originalOwner = fs.readFileSync(OWNER_PATH, 'utf8');
  const deferredCall = 'this.scheduleDeferredHandoffRecovery(deferredChannelId, { pendingGeneration });';
  const pollCall = 'this.schedulePendingHandoffRecoveryPoll();';
  assert.equal(originalOwner.split(deferredCall).length - 1, 1);
  assert.equal(originalOwner.split(pollCall).length - 1, 1);
  for (const [kind, bypassOwner] of [
    ['deferred', originalOwner.replace(deferredCall, 'scheduleDeferredHandoffRecovery.call(this, deferredChannelId, { pendingGeneration });')],
    ['poll', originalOwner.replace(pollCall, 'schedulePendingHandoffRecoveryPoll.call(this);')]
  ]) {
  const { createHandoffSchedulerHandlers } = ownerFromText(bypassOwner);
  const handlers = createHandoffSchedulerHandlers({
    READINESS: { PENDING: 'pending', RECOVERING: 'recovering', READY: 'ready' },
    DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS: 100,
    DEFERRED_HANDOFF_RECOVERY_MAX_DELAY_MS: 500,
    PENDING_HANDOFF_RECOVERY_POLL_MS: 1000
  });
  const { DiscordGateway } = require(GATEWAY_PATH);
  await withFakeTimers(async timers => {
    const deferredReceiver = schedulerReceiver(DiscordGateway);
    deferredReceiver.transportReady = false;
    let deferredFacadeCalls = 0;
    deferredReceiver.scheduleDeferredHandoffRecovery = function(...args) {
      deferredFacadeCalls += 1;
      return handlers.scheduleDeferredHandoffRecovery.apply(this, args);
    };
    deferredReceiver.scheduleDeferredHandoffRecovery('ordinary');
    timers[0].callback();
    if (kind === 'deferred') {
      assert.equal(deferredFacadeCalls, 1);
      assert.throws(() => assert.ok(deferredFacadeCalls > 1), assert.AssertionError);
    } else assert.ok(deferredFacadeCalls > 1);

    const pollReceiver = schedulerReceiver(DiscordGateway);
    let pollFacadeCalls = 0;
    pollReceiver.schedulePendingHandoffRecoveryPoll = function(...args) {
      pollFacadeCalls += 1;
      return handlers.schedulePendingHandoffRecoveryPoll.apply(this, args);
    };
    pollReceiver.schedulePendingHandoffRecoveryPoll();
    timers.at(-1).callback();
    if (kind === 'poll') {
      assert.equal(pollFacadeCalls, 1);
      assert.throws(() => assert.ok(pollFacadeCalls > 1), assert.AssertionError);
    } else assert.ok(pollFacadeCalls > 1);
  });
  }
});


test('lifecycle stop cancels scheduler timers and clears both custody sets', async t => {
  const { fixture, DiscordGateway } = require('./ordinary-codex-fixture');
  const stateFixture = fixture(t);
  const gateway = new DiscordGateway({
    state: stateFixture.state,
    client: { user: { id: 'bot' }, on() {}, off() {}, async destroy() {} },
    providers: {},
    fetchHistory: async () => []
  });
  gateway.started = true;
  await withFakeTimers(async timers => {
    gateway.scheduleDeferredHandoffRecovery('ordinary-stop');
    gateway.scheduleDeferredHandoffRecovery('pending-stop', { pendingGeneration: true });
    gateway.schedulePendingHandoffRecoveryPoll();
    const deferredTimer = gateway.deferredHandoffRecoveryTimer;
    const pollTimer = gateway.pendingHandoffRecoveryPollTimer;
    assert.equal(timers.length, 2);
    await gateway.stop();
    assert.equal(deferredTimer.cleared, true);
    assert.equal(pollTimer.cleared, true);
    assert.equal(gateway.deferredHandoffRecoveryTimer, null);
    assert.equal(gateway.deferredHandoffRecoveryTimerDeadline, null);
    assert.equal(gateway.pendingHandoffRecoveryPollTimer, null);
    assert.deepEqual([...gateway.deferredHandoffRecoveryChannels], []);
    assert.deepEqual([...gateway.pendingHandoffRecoveryChannels], []);
  });
});


test('isolated forwarding counter-controls reject identity, result, throw and arity regressions', () => {
  const original = fs.readFileSync(GATEWAY_PATH, 'utf8');
  const forwarding = 'return handoffSchedulerHandlers.scheduleDeferredHandoffRecovery.apply(this, arguments);';
  const sentinel = Object.freeze({ result: 'sentinel' });
  const failure = new Error('identity');
  const receiver = Object.freeze({ receiver: true });
  const args = [Object.freeze({ first: true }), Object.freeze({ second: true }), Object.freeze({ extra: true })];
  let captured;
  let shouldThrow = false;
  const saved = require.cache[OWNER_PATH];
  function compile(text) {
    const loaded = new Module(`${GATEWAY_PATH}.control`, module);
    loaded.filename = GATEWAY_PATH;
    loaded.paths = Module._nodeModulePaths(path.dirname(GATEWAY_PATH));
    loaded._compile(text, GATEWAY_PATH);
    return loaded.exports.DiscordGateway.prototype.scheduleDeferredHandoffRecovery;
  }
  try {
    require.cache[OWNER_PATH] = { id: OWNER_PATH, filename: OWNER_PATH, loaded: true, exports: {
      createHandoffSchedulerHandlers() {
        return { scheduleDeferredHandoffRecovery(...values) {
          captured = { receiver: this, args: values };
          if (shouldThrow) throw failure;
          return sentinel;
        } };
      }
    } };
    function verify(text, axis) {
      const method = compile(text);
      shouldThrow = axis === 'throw';
      if (shouldThrow) {
        assert.throws(() => method.apply(receiver, args), error => error === failure);
        return;
      }
      const result = method.apply(receiver, args);
      if (axis === 'receiver') assert.equal(captured.receiver, receiver);
      if (axis.startsWith('arguments')) args.forEach((argument, index) => assert.equal(captured.args[index], argument));
      if (axis === 'return') assert.equal(result, sentinel);
      if (axis === 'arity') assert.equal(method.length, 1);
    }
    for (const [axis, replacement] of [
      ['receiver', 'return handoffSchedulerHandlers.scheduleDeferredHandoffRecovery.apply({ ...this }, arguments);'],
      ['arguments-first', 'return handoffSchedulerHandlers.scheduleDeferredHandoffRecovery.apply(this, [{ ...arguments[0] }, arguments[1], arguments[2]]);'],
      ['arguments-second', 'return handoffSchedulerHandlers.scheduleDeferredHandoffRecovery.apply(this, [arguments[0], { ...arguments[1] }, arguments[2]]);'],
      ['arguments-extra', 'return handoffSchedulerHandlers.scheduleDeferredHandoffRecovery.apply(this, [arguments[0], arguments[1], { ...arguments[2] }]);'],
      ['return', 'handoffSchedulerHandlers.scheduleDeferredHandoffRecovery.apply(this, arguments);'],
      ['throw', 'try { return handoffSchedulerHandlers.scheduleDeferredHandoffRecovery.apply(this, arguments); } catch (error) { throw new Error(error.message); }']
    ]) {
      verify(original, axis);
      const mutant = original.replace(forwarding, replacement);
      assert.notEqual(mutant, original);
      assert.throws(() => verify(mutant, axis), assert.AssertionError, axis);
    }
    verify(original, 'arity');
    const arityMutant = original.replace('scheduleDeferredHandoffRecovery(channelId)', 'scheduleDeferredHandoffRecovery(channelId, options)');
    assert.notEqual(arityMutant, original);
    assert.throws(() => verify(arityMutant, 'arity'), assert.AssertionError);
  } finally {
    if (saved) require.cache[OWNER_PATH] = saved;
    else delete require.cache[OWNER_PATH];
  }
  function verifyDefaults(text) {
    withFakeTimers(() => {
      const method = compile(text);
      let reads = 0;
      const options = Object.defineProperty({}, 'pendingGeneration', { get() { reads++; return false; } });
      method.call(schedulerReceiver(require(GATEWAY_PATH).DiscordGateway), 'channel', options);
      assert.equal(reads, 1);
    });
  }
  verifyDefaults(original);
  const doubleDefault = original.replace('scheduleDeferredHandoffRecovery(channelId)', 'scheduleDeferredHandoffRecovery(channelId, { pendingGeneration = false } = {})');
  assert.notEqual(doubleDefault, original);
  assert.throws(() => verifyDefaults(doubleDefault), assert.AssertionError);
  const ownerText = fs.readFileSync(OWNER_PATH, 'utf8');
  function verifyStrict(text) {
    const { createHandoffSchedulerHandlers } = ownerFromText(text);
    const handlers = createHandoffSchedulerHandlers({ READINESS: {}, DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS: 100, DEFERRED_HANDOFF_RECOVERY_MAX_DELAY_MS: 5000, PENDING_HANDOFF_RECOVERY_POLL_MS: 100 });
    assert.throws(() => handlers.scheduleDeferredHandoffRecovery.call(undefined), TypeError);
  }
  verifyStrict(ownerText);
  const nonStrict = ownerText.replace("'use strict';", '');
  assert.notEqual(nonStrict, ownerText);
  assert.throws(() => verifyStrict(nonStrict), assert.AssertionError);
});