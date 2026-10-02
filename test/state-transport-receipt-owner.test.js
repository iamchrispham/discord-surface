'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const STATE_PATH = require.resolve('../src/state.js');
const OWNER_PATH = path.join(path.dirname(STATE_PATH), 'state', 'transport-receipts.js');

const METHODS = ['getTransportReceipt', 'beginTransportReceipt', 'authorizeTransportReceipt', 'recordTransportReceiptOutcome'];
const DEPENDENCIES = [
  'assertText', 'BindingError', 'MESSAGE_STATES', 'INTERACTION_TRANSPORT', 'READINESS', 'bindingMatchesExpected',
  'parseJson', 'TRANSPORT_RECEIPT_ATTEMPT', 'TRANSPORT_RECEIPT_OUTCOME', 'TRANSPORT_RECEIPT_OUTCOMES', 'discordNonce'
];
const OWNER_STATES = ['preloaded', 'absent'];

// Loads a fresh State module whose transport-receipt owner is a sentinel factory.
// Cache entries are replaced, never mutated, and restored exactly as found.
function withSentinelOwner(ownerState, run) {
  const hadState = Object.prototype.hasOwnProperty.call(require.cache, STATE_PATH);
  const originalState = require.cache[STATE_PATH];
  const hadOwner = Object.prototype.hasOwnProperty.call(require.cache, OWNER_PATH);
  const originalOwner = require.cache[OWNER_PATH];
  try {
    if (ownerState === 'preloaded') require(OWNER_PATH);
    else delete require.cache[OWNER_PATH];
    const calls = [];
    const returns = {};
    const factoryDeps = [];
    const handlers = {};
    for (const name of METHODS) {
      returns[name] = { sentinel: name };
      handlers[name] = function sentinelHandler() {
        calls.push({ name, receiver: this, args: Array.from(arguments) });
        return returns[name];
      };
    }
    const sentinelOwner = new Module(OWNER_PATH);
    sentinelOwner.filename = OWNER_PATH;
    sentinelOwner.loaded = true;
    sentinelOwner.exports = {
      createTransportReceiptHandlers(deps) {
        factoryDeps.push(deps);
        return handlers;
      }
    };
    require.cache[OWNER_PATH] = sentinelOwner;
    delete require.cache[STATE_PATH];
    const state = require(STATE_PATH);
    assert.equal(factoryDeps.length, 1, 'State constructs the owner once at module initialization');
    assert.deepEqual(Object.keys(factoryDeps[0]), DEPENDENCIES);
    run({ state, calls, returns, receiver: Object.create(state.SurfaceState.prototype) });
  } finally {
    if (hadState) require.cache[STATE_PATH] = originalState;
    else delete require.cache[STATE_PATH];
    if (hadOwner) require.cache[OWNER_PATH] = originalOwner;
    else delete require.cache[OWNER_PATH];
  }
}

function assertOnlyCall(calls, name, receiver, expectedArgs) {
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, name);
  assert.equal(calls[0].receiver, receiver);
  assert.equal(calls[0].args.length, expectedArgs.length);
  expectedArgs.forEach((arg, index) => assert.equal(calls[0].args[index], arg, `argument ${index} identity`));
}

test('getTransportReceipt', () => {
  for (const ownerState of OWNER_STATES) {
    withSentinelOwner(ownerState, ({ calls, returns, receiver }) => {
      const messageId = 'message-id';
      const transport = 'transport-id';
      assert.equal(receiver.getTransportReceipt(messageId, transport), returns.getTransportReceipt);
      assertOnlyCall(calls, 'getTransportReceipt', receiver, [messageId, transport]);
      calls.length = 0;
      assert.equal(receiver.getTransportReceipt(messageId), returns.getTransportReceipt);
      assertOnlyCall(calls, 'getTransportReceipt', receiver, [messageId]);
      calls.length = 0;
      receiver.getTransportReceipt(messageId, undefined);
      assertOnlyCall(calls, 'getTransportReceipt', receiver, [messageId, undefined]);
    });
  }
});

test('beginTransportReceipt', () => {
  for (const ownerState of OWNER_STATES) {
    withSentinelOwner(ownerState, ({ calls, returns, receiver }) => {
      const messageId = 'message-id';
      const options = { transport: 'transport-id', ownerPid: 7, ownerIdentity: { id: 1 }, inTransaction: true };
      assert.equal(receiver.beginTransportReceipt(messageId, options), returns.beginTransportReceipt);
      assertOnlyCall(calls, 'beginTransportReceipt', receiver, [messageId, options]);
      calls.length = 0;
      assert.equal(receiver.beginTransportReceipt(messageId), returns.beginTransportReceipt);
      assertOnlyCall(calls, 'beginTransportReceipt', receiver, [messageId]);
      calls.length = 0;
      const empty = {};
      receiver.beginTransportReceipt(messageId, empty);
      assertOnlyCall(calls, 'beginTransportReceipt', receiver, [messageId, empty]);
      assert.deepEqual(empty, {});
    });
  }
});

test('authorizeTransportReceipt', () => {
  for (const ownerState of OWNER_STATES) {
    withSentinelOwner(ownerState, ({ calls, returns, receiver }) => {
      const messageId = 'message-id';
      const expectedBinding = { channelId: 'channel', generation: 3 };
      assert.equal(receiver.authorizeTransportReceipt(messageId, expectedBinding), returns.authorizeTransportReceipt);
      assertOnlyCall(calls, 'authorizeTransportReceipt', receiver, [messageId, expectedBinding]);
      calls.length = 0;
      assert.equal(receiver.authorizeTransportReceipt(messageId), returns.authorizeTransportReceipt);
      assertOnlyCall(calls, 'authorizeTransportReceipt', receiver, [messageId]);
    });
  }
});

test('recordTransportReceiptOutcome', () => {
  for (const ownerState of OWNER_STATES) {
    withSentinelOwner(ownerState, ({ calls, returns, receiver }) => {
      const messageId = 'message-id';
      const outcome = 'sent';
      const detail = { note: 'detail' };
      const transport = 'transport-id';
      assert.equal(receiver.recordTransportReceiptOutcome(messageId, outcome, detail, transport), returns.recordTransportReceiptOutcome);
      assertOnlyCall(calls, 'recordTransportReceiptOutcome', receiver, [messageId, outcome, detail, transport]);
      calls.length = 0;
      assert.equal(receiver.recordTransportReceiptOutcome(messageId, outcome), returns.recordTransportReceiptOutcome);
      assertOnlyCall(calls, 'recordTransportReceiptOutcome', receiver, [messageId, outcome]);
      calls.length = 0;
      receiver.recordTransportReceiptOutcome(messageId, outcome, detail);
      assertOnlyCall(calls, 'recordTransportReceiptOutcome', receiver, [messageId, outcome, detail]);
      assert.deepEqual(detail, { note: 'detail' });
    });
  }
});
