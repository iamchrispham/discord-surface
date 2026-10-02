'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const COMPANION_PATH = path.resolve(__dirname, '..', 'src', 'state', 'provision-intents.js');
const STATE_PATH = path.resolve(__dirname, '..', 'src', 'state.js');
const DEPENDENCY_NAMES = [
  'assertProvider',
  'assertUuid',
  'assertConductorId',
  'assertRepoKey',
  'assertText',
  'assertEndpoint',
  'BindingError',
  'now'
];

// Loads a fresh State module whose companion factory returns the supplied
// sentinel handlers, then restores both require-cache entries.
async function withSentinelState(handlers, run) {
  const savedCompanion = require.cache[COMPANION_PATH];
  const savedState = require.cache[STATE_PATH];
  const factoryCalls = [];
  try {
    require.cache[COMPANION_PATH] = {
      id: COMPANION_PATH,
      filename: COMPANION_PATH,
      loaded: true,
      exports: {
        createProvisionIntentHandlers(dependencies) {
          factoryCalls.push(dependencies);
          return handlers;
        }
      }
    };
    delete require.cache[STATE_PATH];
    const { SurfaceState } = require(STATE_PATH);
    await run({ SurfaceState, factoryCalls });
  } finally {
    if (savedCompanion) require.cache[COMPANION_PATH] = savedCompanion;
    else delete require.cache[COMPANION_PATH];
    if (savedState) require.cache[STATE_PATH] = savedState;
    else delete require.cache[STATE_PATH];
  }
}

async function assertCacheRestoration() {
  const initialCompanion = require.cache[COMPANION_PATH];
  const initialState = require.cache[STATE_PATH];
  try {
    for (const preloaded of [true, false]) {
      for (const throws of [false, true]) {
        if (preloaded) {
          require(COMPANION_PATH);
          require(STATE_PATH);
        } else {
          delete require.cache[COMPANION_PATH];
          delete require.cache[STATE_PATH];
        }
        const companion = require.cache[COMPANION_PATH];
        const state = require.cache[STATE_PATH];
        const companionExports = companion && companion.exports;
        const stateExports = state && state.exports;
        const failure = new Error('callback failure');
        const outcome = withSentinelState({}, async () => {
          if (throws) throw failure;
        });
        if (throws) await assert.rejects(outcome, (error) => error === failure);
        else await outcome;
        assert.equal(require.cache[COMPANION_PATH], companion);
        assert.equal(require.cache[STATE_PATH], state);
        if (preloaded) {
          assert.equal(companion.exports, companionExports);
          assert.equal(state.exports, stateExports);
        } else {
          assert.equal(COMPANION_PATH in require.cache, false);
          assert.equal(STATE_PATH in require.cache, false);
        }
      }
    }
  } finally {
    if (initialCompanion) require.cache[COMPANION_PATH] = initialCompanion;
    else delete require.cache[COMPANION_PATH];
    if (initialState) require.cache[STATE_PATH] = initialState;
    else delete require.cache[STATE_PATH];
  }
}

async function assertDelegates(methodName, args, returned) {
  const calls = [];
  const handlers = {};
  for (const name of ['beginProvisionIntent', 'completeProvisionIntent']) {
    handlers[name] = function sentinel() {
      calls.push({ name, receiver: this, args: Array.from(arguments) });
      return name === methodName ? returned : Symbol(`unexpected ${name}`);
    };
  }
  await withSentinelState(handlers, async ({ SurfaceState, factoryCalls }) => {
    assert.equal(factoryCalls.length, 1, 'factory is built once at module load');
    assert.deepEqual(Object.keys(factoryCalls[0]).sort(), [...DEPENDENCY_NAMES].sort());
    const receiver = Object.create(SurfaceState.prototype);
    assert.equal(receiver[methodName](...args), returned);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, methodName);
    assert.equal(calls[0].receiver, handlers);
    assert.equal(calls[0].args.length, args.length + 1);
    assert.equal(calls[0].args[0], receiver);
    args.forEach((arg, index) => assert.equal(calls[0].args[index + 1], arg));
  });
}

test('beginProvisionIntent', async () => {
  const intent = { provider: 'codex', nativeId: 'native' };
  await assertDelegates('beginProvisionIntent', [intent], Symbol('begin'));
  await assertCacheRestoration();
});

test('completeProvisionIntent', async () => {
  const provider = 'codex';
  const nativeId = 'native';
  const channelId = 'channel';
  const conductorId = 'conductor';
  await assertDelegates('completeProvisionIntent', [provider, nativeId, channelId, conductorId], Symbol('complete'));
  await assertDelegates('completeProvisionIntent', [provider, nativeId, channelId], Symbol('complete-default'));
  await assertCacheRestoration();
});
