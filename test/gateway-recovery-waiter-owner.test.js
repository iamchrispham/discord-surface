'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const OWNER_NAME = 'createTransportRecoveryWaiter';
const PUBLIC_METHOD = 'recoverTransport';
const SRC_ROOT = process.env.GATEWAY_RECOVERY_WAITER_SRC_ROOT
  ? path.resolve(process.env.GATEWAY_RECOVERY_WAITER_SRC_ROOT)
  : path.resolve(__dirname, '..', 'src');
const FACADE_FILE = path.join(SRC_ROOT, 'discord.js');
const OWNER_FILE = path.join(SRC_ROOT, 'discord', 'transport-recovery-waiter.js');
const WORKFLOW_FILE = path.join(SRC_ROOT, 'discord', 'transport-recovery.js');
const WAITER_FIELDS = new Set(['ownDone', 'parents', 'pending', 'promise', 'settled', 'stopped']);

function parse(file) {
  const kind = file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind);
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}

function sourceFilesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'test', 'tests', '__tests__'].includes(entry.name)) return [];
      return sourceFilesUnder(full);
    }
    return entry.name.endsWith('.js') || entry.name.endsWith('.ts') ? [full] : [];
  });
}

function isRequireCall(node, resolveFrom) {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'require') return null;
  const [specifier] = node.arguments;
  if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) return null;
  return path.resolve(path.dirname(resolveFrom), specifier.text).replace(/\.js$/, '');
}

function propertyNames(node) {
  const names = [];
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
      const name = property.name;
      names.push(ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null);
    }
  }
  return names;
}

function isCallableInitializer(node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function declaresOwnerName(node) {
  if (ts.isFunctionDeclaration(node) && node.name && node.name.text === OWNER_NAME && node.body) return true;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === OWNER_NAME &&
      node.initializer && isCallableInitializer(node.initializer)) return true;
  if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.name.text === OWNER_NAME) return true;
  if (ts.isPropertyAssignment(node) && node.name && ts.isIdentifier(node.name) &&
      node.name.text === OWNER_NAME && isCallableInitializer(node.initializer)) return true;
  return false;
}

test('Gateway waiter construction belongs to its single scoped owner', () => {
  const facade = parse(FACADE_FILE);

  const methods = [];
  walk(facade, node => {
    if (!ts.isClassDeclaration(node) || !node.name || node.name.text !== 'DiscordGateway') return;
    for (const member of node.members) {
      if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name) &&
          member.name.text === PUBLIC_METHOD) methods.push(member);
    }
  });
  assert.equal(methods.length, 1, `${PUBLIC_METHOD} must be declared exactly once on DiscordGateway`);
  const facadeMethod = methods[0];
  assert.equal(Boolean(facadeMethod.modifiers?.some(node => node.kind === ts.SyntaxKind.AsyncKeyword)), false,
    'the facade must return the owner promise without async adoption');
  assert.deepEqual(facadeMethod.parameters.map(node => node.getText()), ['reason', '...args'],
    'only the async owner may evaluate transport defaults');
  assert.ok(facadeMethod.body && ts.isBlock(facadeMethod.body), `${PUBLIC_METHOD} must have a block body`);
  assert.equal(facadeMethod.body.getText().replace(/\s+/g, ''),
    '{returntransportRecovery.recoverTransport.apply(this,arguments);}',
    'the facade must delegate with its original receiver and arguments');

  const workflow = parse(WORKFLOW_FILE);
  assert.equal(workflow.statements[0]?.expression?.text, 'use strict',
    'the extracted object method must retain class-method strictness');
  const workflowImport = [];
  const workflowInitializers = [];
  walk(facade, node => {
    if (!ts.isVariableDeclaration(node)) return;
    if (node.initializer && isRequireCall(node.initializer, FACADE_FILE) === WORKFLOW_FILE.replace(/\.js$/, '')) {
      workflowImport.push(node.name.getText().replace(/\s/g, ''));
    }
    if (node.name.getText() === 'transportRecovery') workflowInitializers.push(node.initializer);
  });
  assert.deepEqual(workflowImport, ['{createTransportRecoveryHandlers}']);
  assert.equal(workflowInitializers.length, 1);
  const initializer = workflowInitializers[0];
  assert.ok(initializer && ts.isCallExpression(initializer));
  assert.equal(initializer.expression.getText(), 'createTransportRecoveryHandlers');
  assert.equal(initializer.arguments.length, 1);
  assert.ok(ts.isObjectLiteralExpression(initializer.arguments[0]));
  const injected = initializer.arguments[0].properties;
  assert.ok(injected.every(node => ts.isShorthandPropertyAssignment(node)));
  assert.deepEqual(injected.map(node => node.name.getText()).sort(),
    ['READINESS', 'THREAD_STATES', 'RECOVERY_POLICIES', 'recoveryKind',
      'createTransportRecoveryWaiter', 'RECOVERY_WAITER_DEADLINE_GRACE_MS'].sort());
  const handlers = [];
  walk(workflow, node => {
    if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) &&
        node.name.text === PUBLIC_METHOD) handlers.push(node);
  });
  assert.equal(handlers.length, 1, 'the workflow must declare exactly one transport recovery handler');
  const method = handlers[0];
  assert.ok(method.body && ts.isBlock(method.body), 'the transport recovery handler must have a block body');

  const makeWaiterReferences = [];
  walk(method, node => {
    if (ts.isIdentifier(node) && node.text === 'makeWaiter') makeWaiterReferences.push(node.getText());
  });
  assert.deepEqual(makeWaiterReferences, [], `recoverTransport must not reference a local makeWaiter`);

  const ownerModule = OWNER_FILE.replace(/\.js$/, '');
  const requireBindings = [];
  walk(facade, node => {
    if (!ts.isVariableDeclaration(node) || !ts.isObjectBindingPattern(node.name) || !node.initializer) return;
    if (isRequireCall(node.initializer, FACADE_FILE) !== ownerModule) return;
    for (const element of node.name.elements) {
      if (ts.isBindingElement(element) && element.name && ts.isIdentifier(element.name)) {
        requireBindings.push(element.name.text);
      }
    }
  });
  assert.ok(requireBindings.includes(OWNER_NAME),
    `discord.js must destructure ${OWNER_NAME} from require('./discord/transport-recovery-waiter')`);

  const constructionCalls = [];
  walk(method, node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === OWNER_NAME) {
      constructionCalls.push(node);
    }
  });
  assert.equal(constructionCalls.length, 1, `${PUBLIC_METHOD} must construct the waiter exactly once via ${OWNER_NAME}`);
  const call = constructionCalls[0];
  assert.equal(call.arguments.length, 4, `${OWNER_NAME} must receive exactly four arguments`);
  assert.deepEqual(call.arguments.map(argument => argument.getText()),
    ['callerScope', 'queuedScoped ? null : overallDeadline', 'makeResult', 'RECOVERY_WAITER_DEADLINE_GRACE_MS'],
    'the owner must receive callerScope, the scoped deadline, makeResult, and the facade grace constant');

  const makeWaiterDeclarations = [];
  for (const file of sourceFilesUnder(SRC_ROOT)) {
    const source = parse(file);
    walk(source, node => {
      if (ts.isFunctionDeclaration(node) && node.name && node.name.text === 'makeWaiter') makeWaiterDeclarations.push(file);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'makeWaiter') makeWaiterDeclarations.push(file);
    });
  }
  assert.deepEqual(makeWaiterDeclarations, [], 'the nested makeWaiter factory must not be declared anywhere in src');

  const waiterConstructors = [];
  for (const file of sourceFilesUnder(SRC_ROOT)) {
    const source = parse(file);
    walk(source, node => {
      if (!ts.isObjectLiteralExpression(node)) return;
      const names = new Set(propertyNames(node).filter(Boolean));
      if ([...WAITER_FIELDS].every(field => names.has(field))) {
        waiterConstructors.push(path.resolve(file));
      }
    });
  }
  assert.deepEqual(waiterConstructors, [path.resolve(OWNER_FILE)],
    `exactly one waiter constructor must exist, in ${OWNER_FILE}`);

  const implementations = [];
  for (const file of sourceFilesUnder(SRC_ROOT)) {
    const source = parse(file);
    walk(source, node => {
      if (declaresOwnerName(node)) implementations.push(path.resolve(file));
    });
  }
  assert.deepEqual(implementations, [path.resolve(OWNER_FILE)],
    `${OWNER_NAME} must be implemented exactly once, in ${OWNER_FILE}`);

  const owner = parse(OWNER_FILE);
  let exported = null;
  walk(owner, node => {
    if (!ts.isExpressionStatement(node) || !ts.isBinaryExpression(node.expression)) return;
    const { left, right } = node.expression;
    if (!ts.isPropertyAccessExpression(left) || left.getText() !== 'module.exports') return;
    if (ts.isObjectLiteralExpression(right)) exported = right;
  });
  assert.ok(exported, 'the owner module must assign an object literal to module.exports');
  const exportedNames = exported.properties
    .filter(property => ts.isShorthandPropertyAssignment(property) || ts.isPropertyAssignment(property))
    .map(property => property.name.getText());
  assert.ok(exportedNames.includes(OWNER_NAME), `${OWNER_NAME} must be exported from the owner module`);

  const facadeModule = FACADE_FILE.replace(/\.js$/, '');
  const forbidden = [];
  walk(owner, node => {
    const resolved = isRequireCall(node, OWNER_FILE);
    if (resolved && resolved === facadeModule) forbidden.push(node.getText());
  });
  assert.deepEqual(forbidden, [], 'the owner must not require the Gateway facade');
});

test('transport defaults execute once and getter failures reject asynchronously', async () => {
  const { DiscordGateway } = require('../src/discord.js');
  const method = DiscordGateway.prototype.recoverTransport;
  let lifecycleReads = 0;
  let policyReads = 0;
  const receiver = {
    get lifecycleEpoch() { lifecycleReads++; return 1; },
    isCurrentLifecycle() { return false; }
  };
  const options = {
    get recoveryPolicy() {
      policyReads++;
      if (policyReads > 1) throw new Error('duplicate policy read');
      return 'full';
    }
  };
  assert.equal(method.length, 1);
  assert.deepEqual(await method.call(receiver, 'probe', undefined, undefined, undefined, options),
    { ready: false, state: 'stopped' });
  assert.equal(lifecycleReads, 1);
  assert.equal(policyReads, 1);
  const broken = { get lifecycleEpoch() { throw new Error('lifecycle getter failed'); } };
  let rejected;
  assert.doesNotThrow(() => { rejected = method.call(broken, 'probe'); });
  await assert.rejects(rejected, /lifecycle getter failed/);
});

test('public waiter factory retains completion and stop semantics', async (t) => {
  const ownerModule = require(path.resolve(__dirname, '..', 'src', 'discord', 'transport-recovery-waiter.js'));
  const makeResult = (waiter, fallback = null) =>
    fallback || waiter.ownResult || { ready: false, state: 'unavailable' };

  const waiterA = ownerModule.createTransportRecoveryWaiter(null, null, makeResult, 250);
  const parentA = { childFinishedCalls: 0, lastResult: null };
  parentA.childFinished = result => {
    parentA.childFinishedCalls += 1;
    parentA.lastResult = result;
  };
  waiterA.parents.add(parentA);
  const resultA = { ready: true, state: 'ready', marker: 'A' };
  waiterA.completeOwn(resultA);
  const settledA = await waiterA.promise;
  assert.strictEqual(settledA, resultA, 'completion must settle with the exact own result object');
  assert.equal(parentA.childFinishedCalls, 1, 'a settled waiter must notify each parent exactly once');
  assert.strictEqual(parentA.lastResult, resultA, 'the parent must receive the exact settled result');
  t.after(() => waiterA.stop());

  const waiterB = ownerModule.createTransportRecoveryWaiter(null, null, makeResult, 250);
  const parentB = { childFinishedCalls: 0, lastResult: null };
  parentB.childFinished = result => {
    parentB.childFinishedCalls += 1;
    parentB.lastResult = result;
  };
  waiterB.parents.add(parentB);
  waiterB.stop();
  const stoppedB = await waiterB.promise;
  assert.deepEqual(stoppedB, { ready: false, state: 'stopped' }, 'stop must resolve the stopped payload');
  assert.equal(parentB.childFinishedCalls, 1, 'stop must notify each parent exactly once');

  waiterB.stop();
  waiterB.completeOwn({ ready: true, state: 'ready' });
  assert.equal(parentB.childFinishedCalls, 1, 'a second stop or a late completion must not notify again');
  const stillStoppedB = await waiterB.promise;
  assert.strictEqual(stillStoppedB, stoppedB, 'a late completion must not replace the settled result');
  assert.deepEqual(stillStoppedB, { ready: false, state: 'stopped' }, 'the settled result stays stopped');
  t.after(() => waiterB.stop());
});
