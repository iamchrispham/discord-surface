'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const modulePath = process.env.DECISION_CANONICAL_TEST_MODULE
  ? path.resolve(process.env.DECISION_CANONICAL_TEST_MODULE)
  : path.resolve(__dirname, '../src/decision-canonical.js');
const {
  CANONICAL_ERROR_CODES,
  CANONICAL_OPERATIONS,
  CANONICAL_RUN_STATUSES,
  resolveCanonicalRoute,
  runCanonicalOperation,
} = require(modulePath);

function rootsRemovedFromEnvironment() {
  const environment = { ...process.env };
  delete environment.TELEGRAM_ROOT;
  delete environment.TG_CANONICAL_STATE_ROOT;
  return environment;
}

function temporaryDirectory(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `discord-${label}-`));
}

function removeDirectory(directory) {
  fs.rmSync(directory, { force: true, recursive: true });
}

function stringValue(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  return value;
}

function fixtureSource() {
  return [
    "import * as fs from 'node:fs';",
    "import * as os from 'node:os';",
    "import * as path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    'export function resolveStateRoot(flags = {}, env = process.env) {',
    "  return String(flags['state-root'] ?? env.TG_CANONICAL_STATE_ROOT ?? '');",
    '}',
    '',
    'export function canonicalPathsFor(stateRoot, env = process.env) {',
    "  const base = stateRoot ? path.resolve(String(stateRoot)) : path.join(env.HOME || os.homedir(), '.fixture-default');",
    "  const root = env.TELEGRAM_ROOT || path.join(base, 'telegram');",
    "  const state = path.join(base, 'state');",
    '  return {',
    '    root,',
    '    stateDir: state,',
    "    questionDir: path.join(root, 'questions'),",
    "    answerDir: path.join(root, 'answers'),",
    "    answeredDir: path.join(root, 'answered'),",
    "    claimsDir: path.join(state, 'ack-claims'),",
    "    claimsDoneDir: path.join(state, 'ack-claims-done'),",
    "    acceptsFile: path.join(state, 'ack-accepts.ndjson'),",
    "    disarmFile: path.join(state, 'disarm.marker'),",
    '  };',
    '}',
    '',
    "const invokedPath = process.argv[1];",
    "const directInvocation = path.isAbsolute(invokedPath) && fs.realpathSync(invokedPath) === fs.realpathSync(fileURLToPath(import.meta.url));",
    'if (directInvocation) {',
    '  const pidFile = process.env.FIXTURE_PID_FILE;',
    '  if (pidFile) fs.writeFileSync(pidFile, String(process.pid));',
    "  if (process.env.CANONICAL_FIXTURE_MODE === 'cancel') {",
    '    setTimeout(() => {',
    "      process.stdout.write(JSON.stringify({ ok: false, error: { code: 'FIXTURE_DEADLINE' } }));",
    '      process.exitCode = 1;',
    '    }, 1500);',
    "  } else if (process.env.CANONICAL_FIXTURE_MODE === 'overflow') {",
    '    setTimeout(() => {',
    '      process.exitCode = 0;',
    '    }, 1500);',
    "    process.stdout.write('x'.repeat(8192));",
    '  } else {',
    '    process.stdout.write(JSON.stringify({ ok: true, operation: process.argv[2] }));',
    '  }',
    '}',
    '',
  ].join('\n');
}

function temporaryFixture(label) {
  const directory = temporaryDirectory(label);
  const executable = path.join(directory, 'canonical-fixture.mjs');
  const pidFile = path.join(directory, 'child.pid');
  fs.writeFileSync(executable, fixtureSource(), { mode: 0o700 });
  return { directory, executable, pidFile };
}

async function waitForFile(file, timeoutMs = 1000) {
  const started = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`timed out waiting for ${file}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs = 1000) {
  const started = Date.now();
  while (processIsAlive(pid)) {
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`child process ${pid} remained alive`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fixturePid(pidFile) {
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(Number.isInteger(pid) && pid > 0, 'fixture pid must be positive');
  return pid;
}

test('resolves owner defaults read-only and checks an explicit replay route', async () => {
  const originalHome = process.env.HOME;
  const defaults = await resolveCanonicalRoute({
    environment: rootsRemovedFromEnvironment(),
  });

  assert.equal(process.env.HOME, originalHome);
  assert.ok(path.isAbsolute(defaults.executable));
  assert.equal(
    defaults.executable,
    path.join(os.homedir(), '.claude', 'skills', 'phone-notify', 'scripts', 'tg-canonical.mjs'),
  );
  assert.ok(path.isAbsolute(defaults.paths.root));
  assert.ok(path.isAbsolute(defaults.paths.stateDir));
  assert.equal(defaults.replay.stateRoot, path.dirname(defaults.paths.stateDir));
  assert.equal(defaults.replay.telegramRoot, defaults.paths.root);
  assert.deepEqual(defaults.replay.args, [
    '--state-root',
    defaults.replay.stateRoot,
  ]);

  const stateRoot = temporaryDirectory('route-state');
  const producerRoot = temporaryDirectory('route-producer');
  const ambientStateRoot = temporaryDirectory('route-ambient');
  try {
    const route = await resolveCanonicalRoute({
      stateRoot,
      environment: {
        ...rootsRemovedFromEnvironment(),
        TELEGRAM_ROOT: producerRoot,
        TG_CANONICAL_STATE_ROOT: ambientStateRoot,
      },
    });

    assert.equal(route.paths.root, path.resolve(producerRoot));
    assert.equal(route.paths.stateDir, path.join(path.resolve(stateRoot), 'state'));
    assert.equal(route.replay.stateRoot, path.resolve(stateRoot));
    assert.equal(route.replay.telegramRoot, path.resolve(producerRoot));
    assert.equal(fs.existsSync(path.join(producerRoot, 'questions')), false);
    assert.equal(fs.existsSync(path.join(stateRoot, 'ack-claims')), false);
  } finally {
    removeDirectory(stateRoot);
    removeDirectory(producerRoot);
    removeDirectory(ambientStateRoot);
  }
});

test('registers, settles, and reads through the selected route despite changed ambient roots', async () => {
  const stateRoot = temporaryDirectory('operation-state');
  const producerRoot = temporaryDirectory('operation-producer');
  const ambientStateRoot = temporaryDirectory('operation-ambient');
  const changedProducerRoot = temporaryDirectory('operation-changed-producer');
  const changedStateRoot = temporaryDirectory('operation-changed-state');
  try {
    const route = await resolveCanonicalRoute({
      stateRoot,
      environment: {
        ...rootsRemovedFromEnvironment(),
        TELEGRAM_ROOT: producerRoot,
        TG_CANONICAL_STATE_ROOT: ambientStateRoot,
      },
    });
    const changedEnvironment = {
      ...rootsRemovedFromEnvironment(),
      TELEGRAM_ROOT: changedProducerRoot,
      TG_CANONICAL_STATE_ROOT: changedStateRoot,
    };
    const target = 'run:p2-canonical-child';
    const register = await runCanonicalOperation(
      route,
      CANONICAL_OPERATIONS.REGISTER,
      {
        namespace: 'discord-p2',
        requestId: 'child-boundary-1',
        target,
        head: '3b5dc6f816f7',
        question: 'Promote this exact head?',
        menu: ['promote', 'hold'],
        noResearch: true,
      },
      { environment: changedEnvironment },
    );

    assert.equal(register.status, CANONICAL_RUN_STATUSES.COMPLETE);
    assert.equal(register.exitCode, 0);
    assert.equal(register.payload?.ok, true);
    assert.equal(register.payload?.operation, CANONICAL_OPERATIONS.REGISTER);
    assert.equal(register.payload?.target, target);
    const qid = stringValue(register.payload?.qid, 'qid');
    const generation = stringValue(
      register.payload?.question_generation,
      'question_generation',
    );
    assert.ok(fs.existsSync(route.paths.questionDir));
    assert.ok(fs.readdirSync(route.paths.questionDir).length > 0);
    assert.equal(fs.existsSync(path.join(changedProducerRoot, 'questions')), false);
    assert.equal(fs.existsSync(path.join(changedStateRoot, 'ack-claims')), false);

    const settle = await runCanonicalOperation(
      route,
      CANONICAL_OPERATIONS.SETTLE,
      {
        qid,
        generation,
        target,
        selected: 'hold',
        provenance: 'discord:opaque-interaction-42',
      },
      { environment: changedEnvironment },
    );

    assert.equal(settle.status, CANONICAL_RUN_STATUSES.COMPLETE);
    assert.equal(settle.exitCode, 0);
    assert.equal(settle.payload?.ok, true);
    assert.equal(settle.payload?.qid, qid);
    assert.equal(settle.payload?.question_generation, generation);
    assert.equal(settle.payload?.target, target);
    assert.equal(settle.payload?.selected, 'hold');
    assert.equal(settle.payload?.outcome, 'won');
    const canonicalReference = settle.payload?.canonical_reference;
    assert.equal(typeof canonicalReference, 'object');

    const read = await runCanonicalOperation(
      route,
      CANONICAL_OPERATIONS.READ,
      { qid, generation },
      { environment: changedEnvironment },
    );

    assert.equal(read.status, CANONICAL_RUN_STATUSES.COMPLETE);
    assert.equal(read.exitCode, 0);
    assert.equal(read.payload?.ok, true);
    assert.equal(read.payload?.qid, qid);
    assert.equal(read.payload?.question_generation, generation);
    assert.equal(read.payload?.source, 'current');
    assert.equal(
      read.payload?.evidence_name,
      canonicalReference.evidence_name,
    );
    assert.equal(read.payload?.answer?.answer, 'hold');
  } finally {
    removeDirectory(stateRoot);
    removeDirectory(producerRoot);
    removeDirectory(ambientStateRoot);
    removeDirectory(changedProducerRoot);
    removeDirectory(changedStateRoot);
  }
});

test('reports cancellation as unknown and does not claim a write', async () => {
  const stateRoot = temporaryDirectory('cancel-state');
  const producerRoot = temporaryDirectory('cancel-producer');
  try {
    const route = await resolveCanonicalRoute({
      stateRoot,
      environment: {
        ...rootsRemovedFromEnvironment(),
        TELEGRAM_ROOT: producerRoot,
      },
    });
    const controller = new AbortController();
    controller.abort();
    const result = await runCanonicalOperation(
      route,
      CANONICAL_OPERATIONS.REGISTER,
      {
        namespace: 'discord-p2',
        requestId: 'cancelled-child',
        target: 'run:p2-canonical-child',
        question: 'This must not be written',
        menu: ['promote', 'hold'],
      },
      { signal: controller.signal },
    );

    assert.equal(result.status, CANONICAL_RUN_STATUSES.UNKNOWN);
    assert.equal(result.payload, null);
    assert.equal(result.error?.code, CANONICAL_ERROR_CODES.CANCELLED);
    assert.equal(fs.existsSync(path.join(producerRoot, 'questions')), false);
    assert.equal(fs.existsSync(path.join(stateRoot, 'state')), false);
  } finally {
    removeDirectory(stateRoot);
    removeDirectory(producerRoot);
  }
});

test('cancels an in-flight child and verifies the child is gone', async () => {
  const fixture = temporaryFixture('cancel-fixture');
  const stateRoot = temporaryDirectory('cancel-fixture-state');
  const producerRoot = temporaryDirectory('cancel-fixture-producer');
  const environment = {
    ...rootsRemovedFromEnvironment(),
    TELEGRAM_ROOT: producerRoot,
    CANONICAL_FIXTURE_MODE: 'cancel',
    FIXTURE_PID_FILE: fixture.pidFile,
  };
  const controller = new AbortController();
  let operation;
  try {
    const route = await resolveCanonicalRoute({
      executable: fixture.executable,
      stateRoot,
      environment,
    });
    operation = runCanonicalOperation(
      route,
      CANONICAL_OPERATIONS.REGISTER,
      {
        namespace: 'discord-p2',
        requestId: 'in-flight-cancel',
        target: 'run:p2-canonical-child',
        question: 'Cancellation must remain unknown',
        menu: ['promote', 'hold'],
      },
      { environment, signal: controller.signal },
    );
    await waitForFile(fixture.pidFile);
    controller.abort();
    const result = await operation;

    assert.equal(result.status, CANONICAL_RUN_STATUSES.UNKNOWN);
    assert.equal(result.payload, null);
    assert.equal(result.error?.code, CANONICAL_ERROR_CODES.CANCELLED);
    await waitForProcessExit(fixturePid(fixture.pidFile));
    assert.equal(fs.existsSync(path.join(producerRoot, 'questions')), false);
  } finally {
    controller.abort();
    if (operation) {
      await operation.catch(() => undefined);
    }
    if (fs.existsSync(fixture.pidFile)) {
      await waitForProcessExit(fixturePid(fixture.pidFile));
    }
    removeDirectory(fixture.directory);
    removeDirectory(stateRoot);
    removeDirectory(producerRoot);
  }
});

test('treats stdout overflow as unknown and verifies the child is gone', async () => {
  const fixture = temporaryFixture('overflow-fixture');
  const stateRoot = temporaryDirectory('overflow-fixture-state');
  const producerRoot = temporaryDirectory('overflow-fixture-producer');
  const environment = {
    ...rootsRemovedFromEnvironment(),
    TELEGRAM_ROOT: producerRoot,
    CANONICAL_FIXTURE_MODE: 'overflow',
    FIXTURE_PID_FILE: fixture.pidFile,
  };
  try {
    const route = await resolveCanonicalRoute({
      executable: fixture.executable,
      stateRoot,
      environment,
    });
    const result = await runCanonicalOperation(
      route,
      CANONICAL_OPERATIONS.REGISTER,
      {
        namespace: 'discord-p2',
        requestId: 'stdout-overflow',
        target: 'run:p2-canonical-child',
        question: 'Overflow must remain unknown',
        menu: ['promote', 'hold'],
      },
      { environment, maxOutputBytes: 4096 },
    );

    assert.equal(result.status, CANONICAL_RUN_STATUSES.UNKNOWN);
    assert.equal(result.payload, null);
    assert.equal(result.error?.code, CANONICAL_ERROR_CODES.OUTPUT_OVERFLOW);
    assert.equal('answer' in result, false);
    await waitForProcessExit(fixturePid(fixture.pidFile));
    assert.equal(fs.existsSync(path.join(producerRoot, 'questions')), false);
  } finally {
    if (fs.existsSync(fixture.pidFile)) {
      await waitForProcessExit(fixturePid(fixture.pidFile));
    }
    removeDirectory(fixture.directory);
    removeDirectory(stateRoot);
    removeDirectory(producerRoot);
  }
});
