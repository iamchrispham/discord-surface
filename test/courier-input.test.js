'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  COURIER_NATIVE,
  PARENT_NATIVE,
  RECIPIENT_THREAD,
  SOURCE_NATIVE,
  createCourierFixture,
  persistedSubmittedAttempt,
  runCourierInput,
  snapshotAllTables
} = require('./courier-input-fixture');

const CLI_PATH = path.resolve(__dirname, '../src/cli.js');

// A successful read is a stdout line that parses to the future {threadId,prompt} shape.
function successfulRead(stdout) {
  for (const line of String(stdout || '').split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let value;
    try { value = JSON.parse(text); } catch { continue; }
    if (value && typeof value === 'object' && typeof value.threadId === 'string' && typeof value.prompt === 'string') return value;
  }
  return null;
}

function assertRefused(f, { messageId, attemptId, nativeId, cwd } = {}) {
  const before = snapshotAllTables(f.state);
  const result = runCourierInput(f, { messageId, attemptId, nativeId, ...(cwd ? { cwd } : {}) });
  assert.notEqual(result.status, 0, result.stderr || result.error?.message || 'courier-input must refuse');
  assert.equal(successfulRead(result.stdout), null, `unexpected successful read: ${result.stdout}`);
  assert.deepEqual(snapshotAllTables(f.state), before);
}

test('persisted courier input reads exact Unicode bytes without claiming', t => {
  const paragraph = 'Do not forward this packet or create unrelated agent packets.';
  const filler = 'unrelated human context with quoted JSON {"note":"keep bytes"} and a backslash \\\\ plus Unicode \u2603.\n';
  const prompt = `${filler.repeat(24)}${paragraph}\n${filler.repeat(24)}`;
  assert.ok(prompt.length > 3265, `prompt length ${prompt.length}`);
  const f = createCourierFixture(t, { prompt });
  const attempt = persistedSubmittedAttempt(f);
  const before = snapshotAllTables(f.state);
  const result = runCourierInput(f, { messageId: attempt.messageId, attemptId: attempt.attemptId });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed, {
    threadId: attempt.envelope.recipient.threadId,
    prompt: attempt.envelope.prompt,
    hostId: 'host-local'
  });
  assert.equal(parsed.prompt, attempt.envelope.prompt);
  assert.equal(Object.keys(parsed).length, 3);
  assert.deepEqual(snapshotAllTables(f.state), before);
});

test('persisted courier input checks invocation identity consistency', t => {
  const f = createCourierFixture(t);
  const attempt = persistedSubmittedAttempt(f);
  const result = runCourierInput(f, {
    messageId: attempt.messageId,
    attemptId: attempt.attemptId,
    env: { CODEX_SESSION_ID: SOURCE_NATIVE, CODEX_THREAD_ID: SOURCE_NATIVE }
  });
  assert.notEqual(result.status, 0, result.stderr || result.error?.message);
  assert.equal(successfulRead(result.stdout), null, result.stdout);
});

test('persisted courier input accepts dash-prefixed route ids', t => {
  const f = createCourierFixture(t, { routeId: '--dash-route' });
  const attempt = persistedSubmittedAttempt(f);
  const result = runCourierInput(f, { messageId: attempt.messageId, attemptId: attempt.attemptId });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), {
    threadId: attempt.envelope.recipient.threadId,
    prompt: attempt.envelope.prompt,
    hostId: f.hostId
  });
});

test('persisted courier input compares UUID native ids canonically', t => {
  const courierNative = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
  const f = createCourierFixture(t, { courierNative });
  const attempt = persistedSubmittedAttempt(f);
  const lowerNative = courierNative.toLowerCase();
  const result = runCourierInput(f, {
    messageId: attempt.messageId,
    attemptId: attempt.attemptId,
    env: { CODEX_SESSION_ID: lowerNative, CODEX_THREAD_ID: lowerNative }
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), {
    threadId: attempt.envelope.recipient.threadId,
    prompt: attempt.envelope.prompt,
    hostId: f.hostId
  });
});

test('persisted courier input opens the database read-only', t => {
  const f = createCourierFixture(t);
  const attempt = persistedSubmittedAttempt(f);
  f.state.close();
  fs.chmodSync(f.dbPath, 0o400);
  const result = runCourierInput(f, { messageId: attempt.messageId, attemptId: attempt.attemptId });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), {
    threadId: attempt.envelope.recipient.threadId,
    prompt: attempt.envelope.prompt,
    hostId: f.hostId
  });
});

test('courier program forwards parsed persisted input without transcription', async t => {
  const { readArgvFor } = require('./courier-input-fixture');
  const { courierForwardingPrompt } = require('../src/native');

  // Nested db dir with a space and a $ makes argv quoting observable in the program text.
  const f = createCourierFixture(t, {
    dbDirName: 'state dir $notavar',
    prompt: 'persisted human input for the courier program harness'
  });
  const attempt = persistedSubmittedAttempt(f);
  const readArgv = readArgvFor(f, { messageId: attempt.messageId, attemptId: attempt.attemptId });
  const output = courierForwardingPrompt(attempt.envelope, readArgv);

  assert.ok(!output.includes(attempt.envelope.prompt), 'program text must not leak the raw prompt');
  assert.ok(!output.includes(attempt.envelope.wire), 'program text must not leak the raw wire');
  assert.equal((output.match(/```/g) || []).length, 2, 'exactly one fenced javascript program');
  const fenced = /```javascript\r?\n([\s\S]*?)\r?\n?```/.exec(output);
  assert.ok(fenced, 'a ```javascript fenced program is present');
  const program = fenced[1];

  const quoted = value => new RegExp(`['"]${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(program);
  for (const value of readArgv) assert.ok(quoted(value), `argv element must be embedded quoted: ${value}`);
  assert.ok(!program.includes(`--db ${f.dbPath}`), 'db path must not be a bare shell token');

  const expectedInput = { threadId: attempt.envelope.recipient.threadId, prompt: attempt.envelope.prompt };
  if (attempt.envelope.recipient.hostId) expectedInput.hostId = attempt.envelope.recipient.hostId;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  const run = async (exit, settled = null) => {
    const calls = [];
    const sends = [];
    const known = {
      exec_command: async input => {
        calls.push('exec_command');
        calls.push(input.max_output_tokens);
        return exit;
      },
      mcp__codex_app__send_message_to_thread: async input => {
        calls.push('send_message_to_thread');
        sends.push(input);
        return { status: 'sent' };
      },
      write_stdin: async input => {
        calls.push('write_stdin');
        assert.equal(input.session_id, 'reader-1');
        return settled;
      }
    };
    const tools = new Proxy(known, {
      get(target, name) {
        if (typeof name !== 'string' || name === 'then') return undefined;
        if (Object.prototype.hasOwnProperty.call(target, name)) return target[name];
        calls.push(name);
        return async () => { throw new Error(`unexpected tool ${name}`); };
      }
    });
    try {
      await new AsyncFunction('tools', program)(tools);
    } catch {
      // Program-level refusal is acceptable; the send-count assertions below are the contract.
    }
    return { calls, sends };
  };

  const success = await run({ exit_code: 0, output: JSON.stringify(expectedInput) });
  assert.deepEqual(success.calls, ['exec_command', 1000000, 'send_message_to_thread'], 'one exec_command then one send, no other tool');
  assert.equal(success.sends.length, 1);
  assert.deepEqual(success.sends[0], expectedInput);
  assert.equal(success.sends[0].prompt, attempt.envelope.prompt, 'exact prompt bytes');
  assert.equal(success.sends[0].threadId, attempt.envelope.recipient.threadId, 'exact recipient');

  const nonzero = await run({ exit_code: 1, output: 'refused' });
  assert.deepEqual(nonzero.calls, ['exec_command', 1000000], 'nonzero exec exit must not send');

  const malformed = await run({ exit_code: 0, output: '{not json' });
  assert.deepEqual(malformed.calls, ['exec_command', 1000000], 'malformed exec stdout must not send');

  const serialized = JSON.stringify(expectedInput);
  const ambiguous = await run({ session_id: 'reader-1', exit_code: 0, output: serialized });
  assert.deepEqual(ambiguous.calls, ['exec_command', 1000000], 'completed reader with a retained session must not send');
  assert.deepEqual(ambiguous.sends, []);

  const midpoint = Math.floor(serialized.length / 2);
  const yielded = await run(
    { session_id: 'reader-1', output: serialized.slice(0, midpoint) },
    { exit_code: 0, output: serialized.slice(midpoint) }
  );
  assert.deepEqual(yielded.calls, ['exec_command', 1000000, 'write_stdin', 'send_message_to_thread'],
    'yielded reader output must be completed before sending');
  assert.deepEqual(yielded.sends, [expectedInput]);

  const receiptsBeforeExpiry = f.state.listReceipts();
  const realNow = Date.now;
  const clock = [0, 0, 60000];
  Date.now = () => clock.shift() ?? 60000;
  let expired;
  try {
    expired = await run(
      { session_id: 'reader-1', output: '' },
      { session_id: 'reader-1', output: '' }
    );
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(expired.calls, ['exec_command', 1000000, 'write_stdin'],
    'expired reader must make finite drain calls without retrying');
  assert.deepEqual(expired.sends, [], 'expired reader must not send');
  assert.deepEqual(f.state.listReceipts(), receiptsBeforeExpiry, 'expired reader must not mutate custody');
});

test('courier input refuses revoked route without mutation', t => {
  const f = createCourierFixture(t);
  const attempt = persistedSubmittedAttempt(f);
  f.state.revokeCourierRoute(f.route.routeId, 'revoked for refusal proof');
  assertRefused(f, { messageId: attempt.messageId, attemptId: attempt.attemptId });
});

test('courier input refuses wrong native identity without mutation', t => {
  const f = createCourierFixture(t);
  const attempt = persistedSubmittedAttempt(f);
  assertRefused(f, { messageId: attempt.messageId, attemptId: attempt.attemptId, nativeId: SOURCE_NATIVE });
});

test('courier input refuses a claimed attempt without mutation', t => {
  const f = createCourierFixture(t);
  const attempt = persistedSubmittedAttempt(f);
  const claimed = f.state.claimCourierForward(f.route.routeId, {
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__codex_app__send_message_to_thread',
    session_id: COURIER_NATIVE,
    cwd: f.workspace,
    transcript_path: path.join(f.sessionRoot, 'courier.jsonl'),
    tool_input: { threadId: RECIPIENT_THREAD, prompt: attempt.prompt, hostId: f.hostId }
  });
  assert.equal(claimed.attemptId, attempt.attemptId);
  assertRefused(f, { messageId: attempt.messageId, attemptId: attempt.attemptId });
});

test('courier input refuses acknowledged custody without mutation', t => {
  const f = createCourierFixture(t);
  const attempt = persistedSubmittedAttempt(f);
  const { recordNativeAcknowledgment } = require('../src/acknowledgment');
  const acked = recordNativeAcknowledgment(f.state, {
    provider: 'codex',
    messageId: attempt.messageId,
    nativeId: PARENT_NATIVE,
    generation: f.binding.generation
  });
  assert.equal(acked.recorded, true);
  assertRefused(f, { messageId: attempt.messageId, attemptId: attempt.attemptId });
});

test('courier input refuses wrong workspace without mutation', t => {
  const f = createCourierFixture(t);
  const attempt = persistedSubmittedAttempt(f);
  const otherCwd = path.join(f.dir, 'other-cwd');
  fs.mkdirSync(otherCwd);
  assertRefused(f, { messageId: attempt.messageId, attemptId: attempt.attemptId, cwd: otherCwd });
});

test('courier input refuses missing database without creation', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-courier-input-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'surface.sqlite');
  const entriesBefore = fs.readdirSync(dir);
  const result = spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    CLI_PATH,
    'courier-input',
    '--db', dbPath,
    '--courier-route-id', 'route-1',
    '--message-id', 'missing-message',
    '--attempt-id', 'missing-attempt',
    '--native-id', COURIER_NATIVE
  ], { cwd: dir, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  assert.notEqual(result.status, 0, result.stderr || result.error?.message);
  assert.equal(fs.existsSync(dbPath), false);
  assert.deepEqual(fs.readdirSync(dir), entriesBefore);
  assert.equal(successfulRead(result.stdout), null, result.stdout);
});
