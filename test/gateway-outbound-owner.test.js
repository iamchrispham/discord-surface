'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const GATEWAY_PATH = path.resolve(__dirname, '..', 'src', 'discord.js');
const OWNER_PATH = path.resolve(__dirname, '..', 'src', 'discord', 'outbound-delivery.js');
const DEPENDENCY_NAMES = ["bindingIdentityMatches", "recoveryKind", "CODEX_VALIDATION_KINDS", "classifyRecoveryFailure", "isRetryableFetchBoundary", "THREAD_STATES", "recoveryFetch", "assertPublicThread", "storedChannelMatches", "readDirectPostFileSnapshot", "classifyReplyError", "waitForAcknowledgment"];
const ASYNC_METHODS = new Set(['threadDeliveryMessage', 'sendReply', 'sendAcknowledgment']);
const METHOD_NAMES = ["markThreadDeliveryUnavailable", "threadDeliveryMessage", "sendReply", "prepareReply", "sendAcknowledgment"];

async function exerciseForwarding(name) {
  const calls = [];
  const rejection = new Error(`${name} sentinel rejection`);
  const outcome = { reject: false, value: null };
  const handlers = Object.fromEntries(METHOD_NAMES.map(method => {
    const invoke = function(...args) {
      calls.push({ method, receiver: this, args });
      if (outcome.reject) throw rejection;
      return outcome.value;
    };
    return [method, ASYNC_METHODS.has(method) ? async function(...args) {
      return invoke.apply(this, args);
    } : invoke];
  }));
  const savedOwner = require.cache[OWNER_PATH];
  const savedGateway = require.cache[GATEWAY_PATH];
  try {
    let factoryCalls = 0;
    let dependencies;
    require.cache[OWNER_PATH] = { id: OWNER_PATH, filename: OWNER_PATH, loaded: true,
      exports: { createOutboundDeliveryHandlers(input) {
        factoryCalls += 1;
        dependencies = input;
        return handlers;
      } } };
    delete require.cache[GATEWAY_PATH];
    const { DiscordGateway } = require(GATEWAY_PATH);
    assert.equal(factoryCalls, 1);
    assert.deepEqual(Object.keys(dependencies).sort(), [...DEPENDENCY_NAMES].sort());
    const method = DiscordGateway.prototype[name];
    const args = [Object.freeze({ argument: 1 }), 'extra argument', undefined];
    for (const receiver of [Object.create(DiscordGateway.prototype), undefined, null, 17]) {
      for (const value of [Object.freeze({ result: name }), undefined, null, 17]) {
        calls.length = 0;
        outcome.reject = false;
        outcome.value = value;
        const actual = method.apply(receiver, args);
        if (ASYNC_METHODS.has(name)) assert.equal(await actual, value);
        else assert.equal(actual, value, 'synchronous facade must return immediately');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, name);
        assert.equal(calls[0].receiver, receiver);
        assert.equal(calls[0].args.length, args.length);
        args.forEach((arg, index) => assert.equal(calls[0].args[index], arg));
      }
      calls.length = 0;
      outcome.reject = true;
      if (ASYNC_METHODS.has(name)) await assert.rejects(method.apply(receiver, args), error => error === rejection);
      else assert.throws(() => method.apply(receiver, args), error => error === rejection);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, name);
      assert.equal(calls[0].receiver, receiver);
      assert.equal(calls[0].args.length, args.length);
      args.forEach((arg, index) => assert.equal(calls[0].args[index], arg));
    }
  } finally {
    if (savedOwner) require.cache[OWNER_PATH] = savedOwner;
    else delete require.cache[OWNER_PATH];
    if (savedGateway) require.cache[GATEWAY_PATH] = savedGateway;
    else delete require.cache[GATEWAY_PATH];
  }

  const { createOutboundDeliveryHandlers } = require(OWNER_PATH);
  const strictDependencies = Object.fromEntries(DEPENDENCY_NAMES.map(key => [key, undefined]));
  strictDependencies.storedChannelMatches = () => true;
  const real = createOutboundDeliveryHandlers(strictDependencies);
  const channel = { async send() { return { id: 'synthetic-sent' }; } };
  const message = { id: 'synthetic-message', channel };
  const reply = { id: 'synthetic-message', replyText: 'synthetic answer', replyNonce: 'synthetic-nonce' };
  const globals = {
    state: { getMessage() { return null; }, assertMessageCurrent() {}, isInteractionMessage() { return false; } },
    stopping: name === 'prepareReply',
    threadDeliveryMessage: async input => input,
    sendTransportReceipt: async () => ({ id: 'synthetic-receipt' })
  };
  const savedGlobals = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const args = name === 'prepareReply' ? [message.id, undefined] : name === 'sendReply' ? [message, reply] : [message, 'synthetic-reaction'];
    for (const receiver of [undefined, null]) {
      if (ASYNC_METHODS.has(name)) await assert.rejects(real[name].apply(receiver, args), TypeError);
      else assert.throws(() => real[name].apply(receiver, args), TypeError);
    }
  } finally {
    for (const [key, prior] of Object.entries(savedGlobals)) {
      if (prior) Object.defineProperty(globalThis, key, prior);
      else delete globalThis[key];
    }
  }
}

test('gateway markThreadDeliveryUnavailable preserves receiver, arguments, return timing and outcome', async () => {
  await exerciseForwarding('markThreadDeliveryUnavailable');
});

test('gateway threadDeliveryMessage preserves receiver, arguments, return timing and outcome', async () => {
  await exerciseForwarding('threadDeliveryMessage');
});

test('gateway sendReply preserves receiver, arguments, return timing and outcome', async () => {
  await exerciseForwarding('sendReply');
});

test('gateway prepareReply preserves receiver, arguments, return timing and outcome', async () => {
  await exerciseForwarding('prepareReply');
});

test('gateway sendAcknowledgment preserves receiver, arguments, return timing and outcome', async () => {
  await exerciseForwarding('sendAcknowledgment');
});
