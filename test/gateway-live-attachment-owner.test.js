'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const COMPANION_PATH = path.resolve(__dirname, '..', 'src', 'discord', 'live-attachment-recovery.js');
const GATEWAY_PATH = path.resolve(__dirname, '..', 'src', 'discord.js');
const DEPENDENCY_NAMES = [
  'recoveryKind',
  'bindingIdentityMatches',
  'AGENT_ATTACHMENT_RECOVERY_KINDS',
  'CODEX_VALIDATION_KINDS',
  'READINESS',
  'THREAD_STATES'
];

// Loads a fresh Gateway module whose companion factory returns the supplied
// sentinel handlers, then restores both require-cache entries.
async function withSentinelGateway(handlers, run) {
  const savedCompanion = require.cache[COMPANION_PATH];
  const savedGateway = require.cache[GATEWAY_PATH];
  const factoryCalls = [];
  try {
    require.cache[COMPANION_PATH] = {
      id: COMPANION_PATH,
      filename: COMPANION_PATH,
      loaded: true,
      exports: {
        createLiveAttachmentRecoveryHandlers(dependencies) {
          factoryCalls.push(dependencies);
          return handlers;
        }
      }
    };
    delete require.cache[GATEWAY_PATH];
    const { DiscordGateway } = require(GATEWAY_PATH);
    await run({ DiscordGateway, factoryCalls });
  } finally {
    if (savedCompanion) require.cache[COMPANION_PATH] = savedCompanion;
    else delete require.cache[COMPANION_PATH];
    if (savedGateway) require.cache[GATEWAY_PATH] = savedGateway;
    else delete require.cache[GATEWAY_PATH];
  }
}

async function assertDelegates(methodName, args, { returned, awaited }) {
  const calls = [];
  const handlers = {};
  for (const name of ['isAttachmentIntakeFailure', 'retryLiveAttachment', 'retryPendingLiveAttachment',
    'recordLiveAttachmentGap', 'releaseRecoveredAttachmentIntake']) {
    handlers[name] = function sentinel() {
      calls.push({ name, receiver: this, args: Array.from(arguments) });
      return name === methodName ? returned : Symbol(`unexpected ${name}`);
    };
  }
  await withSentinelGateway(handlers, async ({ DiscordGateway, factoryCalls }) => {
    assert.equal(factoryCalls.length, 1, 'factory is built once at module load');
    assert.deepEqual(Object.keys(factoryCalls[0]).sort(), [...DEPENDENCY_NAMES].sort());
    const receiver = Object.create(DiscordGateway.prototype);
    const outcome = receiver[methodName](...args);
    if (awaited) {
      assert.ok(outcome instanceof Promise, `${methodName} stays asynchronous`);
      assert.equal(await outcome, returned);
    } else {
      assert.equal(outcome, returned);
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, methodName);
    assert.equal(calls[0].receiver, receiver);
    assert.equal(calls[0].args.length, args.length);
    args.forEach((arg, index) => assert.equal(calls[0].args[index], arg));
  });
}

test('isAttachmentIntakeFailure', async () => {
  const error = new Error('intake');
  await assertDelegates('isAttachmentIntakeFailure', [error], { returned: Symbol('intake-failure'), awaited: false });
});

test('retryLiveAttachment', async () => {
  const message = { id: 'm1' };
  const binding = { channelId: 'c1' };
  await assertDelegates('retryLiveAttachment', [message, binding], { returned: Symbol('retry-live'), awaited: true });
});

test('retryPendingLiveAttachment', async () => {
  await assertDelegates('retryPendingLiveAttachment', ['c1'], { returned: Symbol('retry-pending'), awaited: false });
});

test('recordLiveAttachmentGap', async () => {
  const message = { id: 'm1' };
  const binding = { channelId: 'c1' };
  const error = new Error('gap');
  const signal = new AbortController().signal;
  await assertDelegates('recordLiveAttachmentGap', [message, binding, error, signal],
    { returned: Symbol('record-gap'), awaited: true });
  await assertDelegates('recordLiveAttachmentGap', [message, binding, error],
    { returned: Symbol('record-gap-default'), awaited: true });
});

test('releaseRecoveredAttachmentIntake', async () => {
  await assertDelegates('releaseRecoveredAttachmentIntake', ['c1'], { returned: Symbol('release'), awaited: false });
  await assertDelegates('releaseRecoveredAttachmentIntake', [], { returned: Symbol('release-default'), awaited: false });
});
