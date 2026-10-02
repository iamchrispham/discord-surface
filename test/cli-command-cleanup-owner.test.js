'use strict';

// Lifecycle contract for completeCommandCleanup plus an inventory of every
// command that owns a Discord client, so a new client exit cannot skip it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { completeCommandCleanup } = require('../src/cli/command-cleanup');

const ROOT = path.join(__dirname, '..');
const OWNER_MODULE = path.join(ROOT, 'src', 'cli', 'command-cleanup');
const CLIENT_COMMANDS = [
  { file: 'src/cli.js', name: 'bind' },
  { file: 'src/cli.js', name: 'threadEnroll' },
  { file: 'src/cli.js', name: 'unbind' },
  { file: 'src/cli/provision-commands.js', name: 'provisionInternal' },
  { file: 'src/cli/conductor-handoff.js', name: 'handoffInternal' },
  { file: 'src/cli/conductor-handoff.js', name: 'handoffFromLockInternal' },
  { file: 'src/cli/ordinary-handoff.js', name: 'ordinaryHandoffInternal' },
  { file: 'src/ordinary-bind/index.js', name: 'ordinaryClaudeBind' },
  { file: 'src/ordinary-bind/codex.js', name: 'ordinaryBind' }
];

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function captureOutcome(run) {
  try {
    await run();
    return { threw: false };
  } catch (error) {
    return { threw: true, error };
  }
}

async function assertFalsyFailureRetained(value) {
  const calls = [];
  const outcome = await captureOutcome(() => completeCommandCleanup([
    () => { calls.push('first'); throw value; },
    () => { calls.push('second'); }
  ]));
  assert.equal(outcome.threw, true);
  assert.equal(outcome.error, value);
  assert.deepEqual(calls, ['first', 'second']);
}

test('cleanup steps complete sequentially and once', async () => {
  const gate = deferred();
  const calls = [];
  const run = completeCommandCleanup([
    async () => { calls.push('first:start'); await gate.promise; calls.push('first:end'); },
    () => { calls.push('second'); }
  ]);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ['first:start']);
  gate.resolve();
  await run;
  assert.deepEqual(calls, ['first:start', 'first:end', 'second']);
});

test('absent resources allow later steps', async () => {
  const absent = undefined;
  const calls = [];
  await completeCommandCleanup([
    () => absent?.destroy(),
    () => { calls.push('close'); }
  ]);
  assert.deepEqual(calls, ['close']);
});

test('synchronous failure attempts later cleanup', async () => {
  const failure = new Error('synchronous cleanup failure');
  const calls = [];
  const outcome = await captureOutcome(() => completeCommandCleanup([
    () => { throw failure; },
    () => { calls.push('next'); }
  ]));
  assert.equal(outcome.threw, true);
  assert.equal(outcome.error, failure);
  assert.deepEqual(calls, ['next']);
});

test('asynchronous failure attempts later cleanup', async () => {
  const failure = new Error('asynchronous cleanup failure');
  const calls = [];
  const outcome = await captureOutcome(() => completeCommandCleanup([
    () => Promise.reject(failure),
    () => { calls.push('next'); }
  ]));
  assert.equal(outcome.threw, true);
  assert.equal(outcome.error, failure);
  assert.deepEqual(calls, ['next']);
});

test('multiple cleanup failures retain the first value', async () => {
  const first = new Error('first cleanup failure');
  const second = new Error('second cleanup failure');
  const third = new Error('third cleanup failure');
  const calls = [];
  const outcome = await captureOutcome(() => completeCommandCleanup([
    () => { calls.push(1); throw first; },
    async () => { calls.push(2); throw second; },
    () => { calls.push(3); throw third; }
  ]));
  assert.equal(outcome.threw, true);
  assert.equal(outcome.error, first);
  assert.deepEqual(calls, [1, 2, 3]);
});

test('body failure survives cleanup failures', async () => {
  const bodyFailure = { kind: 'body failure' };
  const calls = [];
  const outcome = await captureOutcome(async () => {
    let hadBodyFailure = false;
    try {
      throw bodyFailure;
    } catch (error) {
      hadBodyFailure = true;
      throw error;
    } finally {
      await completeCommandCleanup([
        () => { calls.push('first'); throw new Error('first cleanup failure'); },
        async () => { calls.push('second'); throw new Error('second cleanup failure'); },
        () => { calls.push('third'); }
      ], hadBodyFailure);
    }
  });
  assert.equal(outcome.threw, true);
  assert.equal(outcome.error, bodyFailure);
  assert.deepEqual(calls, ['first', 'second', 'third']);
});

test('undefined cleanup failure remains a failure', async () => {
  await assertFalsyFailureRetained(undefined);
});

test('null cleanup failure remains a failure', async () => {
  await assertFalsyFailureRetained(null);
});

test('false cleanup failure remains a failure', async () => {
  await assertFalsyFailureRetained(false);
});

test('close failure retains its value after successful preceding steps', async () => {
  const closeFailure = new Error('close failed');
  const calls = [];
  const outcome = await captureOutcome(() => completeCommandCleanup([
    async () => { calls.push('destroy'); },
    async () => { calls.push('close'); throw closeFailure; }
  ]));
  assert.equal(outcome.threw, true);
  assert.equal(outcome.error, closeFailure);
  assert.deepEqual(calls, ['destroy', 'close']);
});

function sourceFileFor(relative) {
  return ts.createSourceFile(relative, fs.readFileSync(path.join(ROOT, relative), 'utf8'), ts.ScriptTarget.Latest, true, relative.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}

function enclosingFunctionName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) && current.name) return current.name.text;
  }
  return null;
}

function isClientDestroyCall(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  return node.expression.name.text === 'destroy' && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'client';
}

function sourceFiles(directory) {
  return fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.(?:js|ts)$/.test(entry.name) ? [relative.split(path.sep).join('/')] : [];
  });
}

function functionsNamed(source, name) {
  const found = [];
  walk(source, node => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name && node.name.text === name && node.body) found.push(node);
  });
  return found;
}

function importsOwner(source, relative) {
  let imported = false;
  walk(source, node => {
    if (!ts.isVariableDeclaration(node) || !ts.isObjectBindingPattern(node.name) || !node.initializer) return;
    if (!node.name.elements.some(element => ts.isIdentifier(element.name) && element.name.text === 'completeCommandCleanup')) return;
    const call = node.initializer;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'require') return;
    const [specifier] = call.arguments;
    if (!specifier || !ts.isStringLiteral(specifier)) return;
    const resolved = path.resolve(path.dirname(path.join(ROOT, relative)), specifier.text).replace(/\.js$/, '');
    if (resolved === OWNER_MODULE) imported = true;
  });
  return imported;
}

function delegationCalls(fn) {
  const calls = [];
  walk(fn.body, node => {
    if (!ts.isTryStatement(node) || !node.finallyBlock) return;
    walk(node.finallyBlock, inner => {
      if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === 'completeCommandCleanup') calls.push({ call: inner, tryStatement: node });
    });
  });
  return calls;
}

test('all nine client command exits delegate to the cleanup owner', () => {
  const observed = [];
  for (const file of sourceFiles('src')) {
    const source = sourceFileFor(file);
    walk(source, node => {
      if (isClientDestroyCall(node)) observed.push({ file, name: enclosingFunctionName(node) });
    });
  }
  const label = site => `${site.file}:${site.name}`;
  assert.deepEqual(observed.map(label).sort(), CLIENT_COMMANDS.map(label).sort(),
    'every client.destroy site must be a listed command, and every listed command must still have one');

  for (const site of CLIENT_COMMANDS) {
    const source = sourceFileFor(site.file);
    assert.equal(importsOwner(source, site.file), true, `${label(site)} must import completeCommandCleanup from src/cli/command-cleanup`);
    const owners = functionsNamed(source, site.name);
    assert.equal(owners.length, 1, `${label(site)} must be declared exactly once`);
    const delegations = delegationCalls(owners[0]);
    assert.equal(delegations.length, 1, `${label(site)} must delegate teardown from one finally block`);
    const { call, tryStatement } = delegations[0];
    const [steps, failureFlag] = call.arguments;
    assert.ok(steps && ts.isArrayLiteralExpression(steps), `${label(site)} must pass its teardown steps as an array`);
    assert.ok(failureFlag && ts.isIdentifier(failureFlag) && failureFlag.text === 'hadBodyFailure', `${label(site)} must pass hadBodyFailure`);
    const stepsContainDestroy = [];
    walk(steps, node => { if (isClientDestroyCall(node)) stepsContainDestroy.push(node); });
    assert.equal(stepsContainDestroy.length, 1, `${label(site)} must destroy its client inside the cleanup steps`);
    const rethrows = tryStatement.catchClause && (() => {
      const caught = tryStatement.catchClause.variableDeclaration?.name.getText();
      let marks = false;
      let throwsCaught = false;
      walk(tryStatement.catchClause.block, node => {
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left) && node.left.text === 'hadBodyFailure' && node.right.kind === ts.SyntaxKind.TrueKeyword) marks = true;
        if (ts.isThrowStatement(node) && ts.isIdentifier(node.expression) && node.expression.text === caught) throwsCaught = true;
      });
      return marks && throwsCaught;
    })();
    assert.equal(Boolean(rethrows), true, `${label(site)} must record the body failure and rethrow the caught value`);
  }
});

test('unbind missing channel does not leak acquired command state', async () => {
  const { unbind } = require('../src/cli');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-command-cleanup-owner-'));
  let installed = 0;
  try {
    await assert.rejects(
      unbind({ 'state-dir': directory }, { requireInstalled: () => { installed += 1; throw new Error('Discord must not load'); } }),
      /missing --channel-id/
    );
    assert.equal(installed, 0);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('thread enrollment cleanup failure still closes state once', async () => {
  const { threadEnroll } = require('../src/cli');
  const { SurfaceState } = require('../src/state');
  const originalController = global.AbortController;
  const originalClose = SurfaceState.prototype.close;
  const interruptListeners = process.listeners('SIGINT');
  const terminateListeners = process.listeners('SIGTERM');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-command-cleanup-thread-'));
  const cleanupFailure = new Error('abort cleanup failed');
  let closes = 0;
  let installed = 0;
  let aborts = 0;
  try {
    global.AbortController = class FixtureController {
      abort() { aborts += 1; throw cleanupFailure; }
    };
    SurfaceState.prototype.close = function fixtureClose() {
      closes += 1;
      return originalClose.call(this);
    };
    const outcome = await captureOutcome(() => threadEnroll({ 'state-dir': directory }, {
      requireInstalled() { installed += 1; throw new Error('Discord must not load'); }
    }));
    assert.equal(outcome.threw, true);
    assert.match(outcome.error.message, /missing --channel-id/);
    assert.notEqual(outcome.error, cleanupFailure);
    assert.equal(aborts, 1);
    assert.equal(closes, 1);
    assert.equal(installed, 0);
    assert.deepEqual(process.listeners('SIGINT'), interruptListeners);
    assert.deepEqual(process.listeners('SIGTERM'), terminateListeners);
  } finally {
    global.AbortController = originalController;
    SurfaceState.prototype.close = originalClose;
    for (const listener of process.listeners('SIGINT')) if (!interruptListeners.includes(listener)) process.off('SIGINT', listener);
    for (const listener of process.listeners('SIGTERM')) if (!terminateListeners.includes(listener)) process.off('SIGTERM', listener);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
