'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const GATEWAY_PATH = path.resolve(__dirname, '..', 'src', 'discord.js');
const OWNER_PATH = path.resolve(__dirname, '..', 'src', 'discord', 'lifecycle.js');
const DEPENDENCY_NAMES = [
  'readSecret',
  'recoveryError',
  'CODEX_VALIDATION_KINDS',
  'READINESS',
  'THREAD_STATES',
  'isNativeProofRetryBoundary',
  'CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX',
  'watchAcknowledgments',
  'MESSAGE_STATES',
  'ACK_WAITING',
  'invalidateReconciliationWaiters',
  'DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS',
  'LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS'
];

function assertForwardedCall(calls, expected) {
  assert.equal(calls.length, 1, `${expected.method}: expected one delegated call`);
  const call = calls[0];
  assert.equal(call.name, expected.method, `${expected.method}: wrong handler invoked`);
  assert.equal(call.receiver, expected.receiver, `${expected.method}: receiver changed`);
  assert.equal(call.args.length, expected.args.length, `${expected.method}: argument count changed`);
  for (let index = 0; index < expected.args.length; index += 1) {
    assert.equal(call.args[index], expected.args[index], `${expected.method}: argument ${index} changed`);
  }
}

// Loads a fresh public Gateway facade whose lifecycle companion factory is a
// sentinel, exercises the real public method across receivers and outcomes,
// then reloads the real strict owner with undefined dependencies to prove it
// refuses to coerce an undefined/null receiver onto globalThis.
async function exerciseForwarding(methodName) {
  const objectSentinel = Object.freeze({ method: methodName, kind: 'object' });
  const rejection = new Error(`sentinel ${methodName} rejection`);
  const calls = [];
  const settle = { reject: false, value: objectSentinel };
  const handlers = {
    async start(...args) {
      calls.push({ name: 'start', receiver: this, args });
      if (settle.reject) throw rejection;
      return settle.value;
    },
    async stop(...args) {
      calls.push({ name: 'stop', receiver: this, args });
      if (settle.reject) throw rejection;
      return settle.value;
    }
  };
  const savedOwner = require.cache[OWNER_PATH];
  const savedGateway = require.cache[GATEWAY_PATH];
  try {
    let factoryCalls = 0;
    let capturedDependencies = null;
    require.cache[OWNER_PATH] = {
      id: OWNER_PATH,
      filename: OWNER_PATH,
      loaded: true,
      exports: {
        createGatewayLifecycleHandlers(dependencies) {
          factoryCalls += 1;
          capturedDependencies = dependencies;
          return handlers;
        }
      }
    };
    delete require.cache[GATEWAY_PATH];
    const { DiscordGateway } = require(GATEWAY_PATH);
    assert.equal(factoryCalls, 1, `${methodName}: lifecycle factory built once at module load`);
    assert.deepEqual(Object.keys(capturedDependencies).sort(), [...DEPENDENCY_NAMES].sort(),
      `${methodName}: dependency wiring changed`);

    const method = DiscordGateway.prototype[methodName];
    assert.equal(typeof method, 'function', `${methodName}: public method missing`);
    const markedReceiver = Object.create(DiscordGateway.prototype);
    markedReceiver.marker = `receiver:${methodName}`;
    const args = [Object.freeze({ argument: 1 }), `extra:${methodName}`, undefined];
    const receivers = [markedReceiver, undefined, null, 17];
    const resolvedValues = [objectSentinel, undefined, null, 17];

    for (const receiver of receivers) {
      for (const value of resolvedValues) {
        settle.reject = false;
        settle.value = value;
        calls.length = 0;
        const resolved = await method.apply(receiver, args);
        assert.equal(resolved, value, `${methodName}: resolved identity changed`);
        assertForwardedCall(calls, { method: methodName, receiver, args });
      }
      settle.reject = true;
      settle.value = undefined;
      calls.length = 0;
      await assert.rejects(method.apply(receiver, args), error => error === rejection,
        `${methodName}: rejection identity changed`);
      assertForwardedCall(calls, { method: methodName, receiver, args });
    }
  } finally {
    if (savedOwner) require.cache[OWNER_PATH] = savedOwner;
    else delete require.cache[OWNER_PATH];
    if (savedGateway) require.cache[GATEWAY_PATH] = savedGateway;
    else delete require.cache[GATEWAY_PATH];
  }

  const marker = Object.freeze({ marker: `${methodName} resolved without a receiver` });
  const globalKey = `${methodName}Promise`;
  const priorGlobal = Object.getOwnPropertyDescriptor(globalThis, globalKey);
  try {
    Object.defineProperty(globalThis, globalKey, { configurable: true, writable: true, value: Promise.resolve(marker) });
    const { createGatewayLifecycleHandlers } = require(OWNER_PATH);
    assert.equal(typeof createGatewayLifecycleHandlers, 'function', `${methodName}: real owner factory missing`);
    const realOwner = createGatewayLifecycleHandlers(Object.fromEntries(DEPENDENCY_NAMES.map(name => [name, undefined])));
    assert.equal(typeof realOwner[methodName], 'function', `${methodName}: real owner handler missing`);
    for (const receiver of [undefined, null]) {
      await assert.rejects(realOwner[methodName].call(receiver), TypeError,
        `${methodName}: strict owner coerced a ${receiver === undefined ? 'undefined' : 'null'} receiver`);
    }
  } finally {
    if (priorGlobal) Object.defineProperty(globalThis, globalKey, priorGlobal);
    else delete globalThis[globalKey];
  }
}

test('gateway start forwards the exact receiver, arguments and outcome through the lifecycle owner', async () => {
  await exerciseForwarding('start');
});

test('gateway stop forwards the exact receiver, arguments and outcome through the lifecycle owner', async () => {
  await exerciseForwarding('stop');
});
