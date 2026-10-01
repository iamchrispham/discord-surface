'use strict';
// Wiring proof for issue 152: the courier forwarding prompt is generated from the
// persisted tool input read back through the shipped CLI, not transcribed by the
// model. These two cases use the real CodexProvider and the real DiscordGateway
// default provider construction; only the queue transport is replaced.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { CodexProvider, DISPATCH_STATUSES } = require('../src/native');
const { DiscordGateway } = require('../src/discord');
const {
  COURIER_NATIVE,
  createCourierFixture,
  persistedSubmittedAttempt,
  readArgvFor
} = require('./courier-input-fixture');

const CLI_PATH = path.resolve(__dirname, '../src/cli.js');

test('configured Codex provider queues persisted-input program', async t => {
  const f = createCourierFixture(t, { prompt: 'persisted payload for the configured provider proof' });
  const attempt = persistedSubmittedAttempt(f);

  const runs = [];
  let callbackCalls = 0;
  let callbackEnvelope = null;
  let callbackArgv = null;
  const provider = new CodexProvider({
    command: 'codex',
    root: f.sessionRoot,
    run: async (command, args, options) => {
      runs.push({ command, args, options });
      return { status: DISPATCH_STATUSES.SUBMITTED };
    },
    courierInputFor: envelope => {
      callbackCalls += 1;
      callbackEnvelope = envelope;
      callbackArgv = readArgvFor(f, {
        messageId: envelope.messageId,
        attemptId: envelope.attemptId,
        nativeId: envelope.courier.nativeId
      });
      return callbackArgv;
    }
  });

  const result = await provider.dispatchCourier(attempt.envelope);
  assert.equal(result.status, DISPATCH_STATUSES.SUBMITTED);

  // The callback ran exactly once and saw the admitted attempt identity.
  assert.equal(callbackCalls, 1);
  assert.equal(callbackEnvelope.route.routeId, f.route.routeId);
  assert.equal(callbackEnvelope.messageId, attempt.messageId);
  assert.equal(callbackEnvelope.attemptId, attempt.attemptId);
  assert.equal(callbackEnvelope.courier.nativeId, COURIER_NATIVE);
  assert.deepEqual(callbackArgv, readArgvFor(f, { messageId: attempt.messageId, attemptId: attempt.attemptId }));

  // Exactly one queue submission through the real provider, carrying the
  // deterministic reader program instead of the raw payload.
  assert.equal(runs.length, 1);
  assert.equal(runs[0].command, 'codex');
  assert.deepEqual(runs[0].args.slice(0, 3), ['queue', '--thread', COURIER_NATIVE]);
  const messageIndex = runs[0].args.indexOf('--message');
  assert.ok(messageIndex > 0, 'queue args carry the forwarding prompt');
  const queued = runs[0].args[messageIndex + 1];
  assert.ok(queued.includes('```javascript'), 'queued prompt is the deterministic reader program');
  assert.ok(!queued.includes(attempt.envelope.prompt), 'queued prompt must not contain the raw persisted prompt');
  assert.ok(!queued.includes(attempt.envelope.wire), 'queued prompt must not contain the raw wire');

  // No real process: every argv element of the reader invoked by the program is
  // embedded quoted, and the current package CLI is the reader entrypoint.
  assert.equal(callbackArgv[0], process.execPath);
  assert.equal(callbackArgv[2], CLI_PATH);
  assert.equal(callbackArgv[3], 'courier-input');
  assert.equal(callbackArgv[4], '--db');
  assert.equal(callbackArgv[5], f.dbPath);
});

test('default Gateway provider uses current package input reader', async t => {
  const f = createCourierFixture(t, { prompt: 'persisted payload for the default Gateway proof' });
  const attempt = persistedSubmittedAttempt(f);

  const runs = [];
  const client = {
    user: { id: 'bot-1' },
    on() {},
    off() {},
    once() {},
    async destroy() {}
  };
  const gateway = new DiscordGateway({ state: f.state, stateDir: f.dir, client });
  try {
    // The Gateway built its default provider without injected providers.
    const provider = gateway.providers.codex;
    assert.ok(provider instanceof CodexProvider, 'Gateway default codex provider is a real CodexProvider');

    // Its configured reader receives the exact route, message, attempt and
    // courier identity, resolved against the current package CLI and state DB.
    const argv = provider.courierInputFor(attempt.envelope);
    assert.deepEqual(argv, [
      process.execPath,
      '--disable-warning=ExperimentalWarning',
      CLI_PATH,
      'courier-input',
      '--db', f.dbPath,
      '--courier-route-id', f.route.routeId,
      '--message-id', attempt.messageId,
      '--attempt-id', attempt.attemptId,
      '--native-id', COURIER_NATIVE
    ]);
    assert.equal(provider.courierInputFor({ route: {}, messageId: '', attemptId: '', courier: {} }), null);

    // Intercept only the queue transport so the real default provider's
    // dispatchCourier path queues the deterministic program.
    provider.run = async (command, args, options) => {
      runs.push({ command, args, options });
      return { status: DISPATCH_STATUSES.SUBMITTED };
    };
    const result = await provider.dispatchCourier(attempt.envelope);
    assert.equal(result.status, DISPATCH_STATUSES.SUBMITTED);
    assert.equal(runs.length, 1);
    const queued = runs[0].args[runs[0].args.indexOf('--message') + 1];
    assert.ok(queued.includes('```javascript'), 'default Gateway provider queues deterministic mode');
    assert.ok(!queued.includes(attempt.envelope.prompt), 'default Gateway provider must not queue the raw prompt');
    assert.ok(!queued.includes(attempt.envelope.wire), 'default Gateway provider must not queue the raw wire');
    assert.ok(queued.includes(`'${f.dbPath}'`), 'program shell-quotes the state DB path');
  } finally {
    try { await gateway.stop(); } catch {}
  }
});
