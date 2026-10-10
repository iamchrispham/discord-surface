'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { SurfaceState } = require('../src/state');

const INVALID_PIDS = [0, -1, 1.5, NaN, 'abc'];

// Full stat line whose post-')' split has start time at index 19.
function statLine(pid, startTime) {
  const fields = Array.from({ length: 18 }, (unused, index) => index + 1).join(' ');
  return `${pid} (node) S ${fields} ${startTime}\n`;
}

// Post-')' fields stop before index 19, so the parsed start time is absent.
function statLineNoStart(pid) {
  const fields = Array.from({ length: 17 }, (unused, index) => index + 1).join(' ');
  return `${pid} (node) S ${fields}\n`;
}

function statPath(pid) { return `/proc/${pid}/stat`; }
function cmdlinePath(pid) { return `/proc/${pid}/cmdline`; }

// ps data keys are the -o format argument.
function makeOsData({ fsData = {}, psData = {}, psError = null, killOk = true, killError = null }) {
  return { fsData, psData, psError, killOk, killError };
}

function withOs(fn) {
  const osData = makeOsData(fn && fn.osData ? fn.osData : {});
  const originalReadFileSync = fs.readFileSync;
  const originalExecFileSync = childProcess.execFileSync;
  const originalKill = process.kill;
  const calls = [];
  try {
    fs.readFileSync = (filePath, options) => {
      calls.push({ kind: 'fs', path: String(filePath), options });
      if (!Object.prototype.hasOwnProperty.call(osData.fsData, filePath)) {
        throw Object.assign(new Error(`ENOENT: no such file, open '${filePath}'`), { code: 'ENOENT' });
      }
      return osData.fsData[filePath];
    };
    childProcess.execFileSync = (command, args, options) => {
      calls.push({ kind: 'ps', command, args, options });
      if (osData.psError) throw osData.psError;
      const key = args[args.length - 1];
      if (!Object.prototype.hasOwnProperty.call(osData.psData, key)) {
        throw Object.assign(new Error(`unexpected ps ${key}`), { code: 'ENOENT' });
      }
      return osData.psData[key];
    };
    process.kill = (pid, signal) => {
      calls.push({ kind: 'kill', pid, signal });
      if (!osData.killOk) throw osData.killError;
      return true;
    };
    const result = fn.run();
    return { result, calls };
  } finally {
    fs.readFileSync = originalReadFileSync;
    childProcess.execFileSync = originalExecFileSync;
    process.kill = originalKill;
  }
}

function receiver(capture) {
  const instance = Object.create(SurfaceState.prototype);
  instance.captureCalls = [];
  if (capture === 'unavailable') {
    instance.directPostOwnerIdentity = function (pid) {
      instance.captureCalls.push(pid);
      return null;
    };
  } else {
    instance.directPostOwnerIdentity = function (pid) {
      instance.captureCalls.push(pid);
      return SurfaceState.prototype.directPostOwnerIdentity.call(this, pid);
    };
  }
  return instance;
}

function capturePid(pid) {
  return SurfaceState.prototype.directPostOwnerIdentity.call(receiver(), pid);
}

function alive(pid, expected, options) {
  const instance = receiver(options && options.capture);
  const run = () => SurfaceState.prototype.directPostOwnerAlive.call(instance, pid, expected);
  const { result, calls } = withOs(options && options.osData ? { osData: options.osData, run } : { run });
  return { result, calls, captureCalls: instance.captureCalls };
}

function aliveOmittedExpected(pid, options) {
  const instance = receiver(options && options.capture);
  const run = () => SurfaceState.prototype.directPostOwnerAlive.call(instance, pid);
  const { result, calls } = withOs(options && options.osData ? { osData: options.osData, run } : { run });
  return { result, calls, captureCalls: instance.captureCalls };
}

test('1. invalid nonpositive, fractional and nonnumeric PIDs return null without OS calls', () => {
  for (const pid of INVALID_PIDS) {
    const { result, calls } = withOs({ run: () => capturePid(pid) });
    assert.equal(result, null, `pid ${String(pid)}`);
    assert.equal(calls.length, 0, `pid ${String(pid)}`);
  }
});

test('2. numeric-string PID normalizes through paths, ps arguments and ownerPid', () => {
  const { result, calls } = withOs({
    osData: makeOsData({ fsData: { [statPath(4242)]: statLine(4242, 'PSSTART'), [cmdlinePath(4242)]: 'ps cmd' } }),
    run: () => capturePid('4242')
  });
  assert.deepEqual(result, { ownerPid: 4242, ownerStartTime: 'PSSTART', ownerCommand: 'ps cmd' });
  assert.deepEqual(calls, [
    { kind: 'fs', path: statPath(4242), options: 'utf8' },
    { kind: 'fs', path: cmdlinePath(4242), options: 'utf8' }
  ]);

  const psFallback = withOs({
    osData: makeOsData({ psData: { 'lstart=': 'PSSTART', 'command=': 'ps cmd' } }),
    run: () => capturePid('4242')
  });
  assert.deepEqual(psFallback.result, { ownerPid: 4242, ownerStartTime: 'PSSTART', ownerCommand: 'ps cmd' });
  assert.deepEqual(psFallback.calls, [
    { kind: 'fs', path: statPath(4242), options: 'utf8' },
    { kind: 'ps', command: 'ps', args: ['-p', '4242', '-o', 'lstart='], options: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] } },
    { kind: 'ps', command: 'ps', args: ['-p', '4242', '-o', 'command='], options: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] } }
  ]);
  assert.equal(psFallback.calls.some(call => call.kind === 'fs' && call.path === cmdlinePath(4242)), false);
});

test('3. Linux stat uses last closing parenthesis and index 19; cmdline keeps NUL separation and drops empty fields', () => {
  const { result, calls } = withOs({
    osData: makeOsData({
      fsData: {
        [statPath(4242)]: `4242 (node) (weird) S ${Array.from({ length: 18 }, (unused, index) => index + 1).join(' ')} 55555\n`,
        [cmdlinePath(4242)]: 'node\0\0/opt/app.js\0'
      }
    }),
    run: () => capturePid(4242)
  });
  assert.deepEqual(result, { ownerPid: 4242, ownerStartTime: '55555', ownerCommand: 'node\0/opt/app.js' });
  assert.deepEqual(calls, [
    { kind: 'fs', path: statPath(4242), options: 'utf8' },
    { kind: 'fs', path: cmdlinePath(4242), options: 'utf8' }
  ]);
});

test('4. missing Linux start evidence with nonempty command returns nullable start', () => {
  const { result, calls } = withOs({
    osData: makeOsData({ fsData: { [statPath(77)]: statLineNoStart(77), [cmdlinePath(77)]: 'proxy --flag' } }),
    run: () => capturePid(77)
  });
  assert.deepEqual(result, { ownerPid: 77, ownerStartTime: null, ownerCommand: 'proxy --flag' });
  assert.equal(calls.length, 2);
});

test('5. empty Linux command with start evidence returns nullable command', () => {
  const { result, calls } = withOs({
    osData: makeOsData({ fsData: { [statPath(77)]: statLine(77, '100'), [cmdlinePath(77)]: '' } }),
    run: () => capturePid(77)
  });
  assert.deepEqual(result, { ownerPid: 77, ownerStartTime: '100', ownerCommand: null });
  assert.equal(calls.length, 2);
});

test('6. both Linux evidence fields empty return null without inferring ownership', () => {
  const { result, calls } = withOs({
    osData: makeOsData({ fsData: { [statPath(77)]: statLineNoStart(77), [cmdlinePath(77)]: '' } }),
    run: () => capturePid(77)
  });
  assert.equal(result, null);
  assert.equal(calls.length, 2);
});

test('7. failed stat read falls back to both ps calls, collapsing start whitespace and trimming command edges', () => {
  const { result, calls } = withOs({
    osData: makeOsData({ psData: { 'lstart=': '  Mon   Jan 5 10:00:00 2026 \n', 'command=': '  node  /app.js  \n' } }),
    run: () => capturePid(4242)
  });
  assert.deepEqual(result, { ownerPid: 4242, ownerStartTime: 'Mon Jan 5 10:00:00 2026', ownerCommand: 'node  /app.js' });
  assert.deepEqual(calls, [
    { kind: 'fs', path: statPath(4242), options: 'utf8' },
    { kind: 'ps', command: 'ps', args: ['-p', '4242', '-o', 'lstart='], options: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] } },
    { kind: 'ps', command: 'ps', args: ['-p', '4242', '-o', 'command='], options: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] } }
  ]);
});

test('8. failed cmdline read falls back to both ps calls and replaces partial Linux start evidence', () => {
  const { result, calls } = withOs({
    osData: makeOsData({
      fsData: { [statPath(4242)]: statLine(4242, '111') },
      psData: { 'lstart=': 'PSSTART', 'command=': 'pscmd' }
    }),
    run: () => capturePid(4242)
  });
  assert.deepEqual(result, { ownerPid: 4242, ownerStartTime: 'PSSTART', ownerCommand: 'pscmd' });
  assert.deepEqual(calls, [
    { kind: 'fs', path: statPath(4242), options: 'utf8' },
    { kind: 'fs', path: cmdlinePath(4242), options: 'utf8' },
    { kind: 'ps', command: 'ps', args: ['-p', '4242', '-o', 'lstart='], options: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] } },
    { kind: 'ps', command: 'ps', args: ['-p', '4242', '-o', 'command='], options: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] } }
  ]);
});

test('9. failed ps start lookup returns null and never issues the ps command lookup', () => {
  const { result, calls } = withOs({
    osData: makeOsData({ psData: {} }),
    run: () => capturePid(4242)
  });
  assert.equal(result, null);
  assert.deepEqual(calls.map(call => call.kind), ['fs', 'ps']);
  assert.deepEqual(calls[1].args, ['-p', '4242', '-o', 'lstart=']);
});

test('10. failed ps command lookup returns null even when start lookup succeeded', () => {
  const { result, calls } = withOs({
    osData: makeOsData({ psData: { 'lstart=': 'PSSTART' } }),
    run: () => capturePid(4242)
  });
  assert.equal(result, null);
  assert.deepEqual(calls.map(call => call.kind), ['fs', 'ps', 'ps']);
  assert.deepEqual(calls.map(call => call.args && call.args[call.args.length - 1]).filter(Boolean), ['lstart=', 'command=']);
});

test('11. matching expected start and command with kill(pid,0) success returns true', () => {
  const { result, calls, captureCalls } = alive(4242, { ownerStartTime: '100', ownerCommand: 'node' }, {
    osData: makeOsData({ fsData: { [statPath(4242)]: statLine(4242, '100'), [cmdlinePath(4242)]: 'node' } })
  });
  assert.equal(result, true);
  assert.deepEqual(calls.map(call => call.kind), ['kill', 'fs', 'fs']);
  assert.deepEqual(calls[0], { kind: 'kill', pid: 4242, signal: 0 });
  assert.deepEqual(captureCalls, [4242]);
});

test('12. reused PID with a different start returns false', () => {
  const { result, calls, captureCalls } = alive(4242, { ownerStartTime: '100', ownerCommand: 'node' }, {
    osData: makeOsData({ fsData: { [statPath(4242)]: statLine(4242, '999'), [cmdlinePath(4242)]: 'node' } })
  });
  assert.equal(result, false);
  assert.deepEqual(calls.map(call => call.kind), ['kill', 'fs', 'fs']);
  assert.deepEqual(captureCalls, [4242]);
});

test('13. matching start with a different command returns false', () => {
  const { result, calls, captureCalls } = alive(4242, { ownerStartTime: '100', ownerCommand: 'node' }, {
    osData: makeOsData({ fsData: { [statPath(4242)]: statLine(4242, '100'), [cmdlinePath(4242)]: 'other' } })
  });
  assert.equal(result, false);
  assert.deepEqual(calls.map(call => call.kind), ['kill', 'fs', 'fs']);
  assert.deepEqual(captureCalls, [4242]);
});

test('14. ESRCH is absent while EPERM is indeterminate before identity capture', () => {
  const { result, calls, captureCalls } = alive(4242, { ownerStartTime: '100', ownerCommand: 'node' }, {
    osData: makeOsData({ killOk: false, killError: Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) })
  });
  assert.equal(result, false);
  assert.deepEqual(calls, [{ kind: 'kill', pid: 4242, signal: 0 }]);
  assert.deepEqual(captureCalls, []);

  const deniedInstance = receiver();
  const denied = withOs({
    osData: makeOsData({ killOk: false, killError: Object.assign(new Error('EPERM'), { code: 'EPERM' }) }),
    run: () => SurfaceState.prototype.directPostOwnerEvidence.call(deniedInstance, 4242, { ownerStartTime: '100', ownerCommand: 'node' })
  });
  assert.deepEqual(denied.result, { status: 'indeterminate', reason: 'probe-denied' });
  assert.deepEqual(denied.calls, [{ kind: 'kill', pid: 4242, signal: 0 }]);
  assert.deepEqual(deniedInstance.captureCalls, []);
});

test('15. either matching start alone or matching command alone is sufficient when the other expected field is empty', () => {
  const startOnly = alive(4242, { ownerStartTime: '100', ownerCommand: null }, {
    osData: makeOsData({ fsData: { [statPath(4242)]: statLine(4242, '100'), [cmdlinePath(4242)]: 'other' } })
  });
  assert.equal(startOnly.result, true);
  const commandOnly = alive(4242, { ownerStartTime: null, ownerCommand: 'node' }, {
    osData: makeOsData({ fsData: { [statPath(4242)]: statLine(4242, '999'), [cmdlinePath(4242)]: 'node' } })
  });
  assert.equal(commandOnly.result, true);
});

test('16. missing identity probes before comparison and returns false without capture; registration is unique', () => {
  const expectedProbeCalls = [{ kind: 'kill', pid: 4242, signal: 0 }];
  const invalid = alive('abc', { ownerStartTime: '100' }, {});
  assert.equal(invalid.result, false);
  assert.equal(invalid.calls.length, 0);
  assert.deepEqual(invalid.captureCalls, []);

  const missingExpected = alive(4242, null, {});
  assert.equal(missingExpected.result, false);
  assert.deepEqual(missingExpected.calls, expectedProbeCalls);
  assert.deepEqual(missingExpected.captureCalls, []);

  const undefinedExpected = alive(4242, undefined, {});
  assert.equal(undefinedExpected.result, false);
  assert.deepEqual(undefinedExpected.calls, expectedProbeCalls);
  assert.deepEqual(undefinedExpected.captureCalls, []);

  const omittedExpected = aliveOmittedExpected(4242, {});
  assert.equal(omittedExpected.result, false);
  assert.deepEqual(omittedExpected.calls, expectedProbeCalls);
  assert.deepEqual(omittedExpected.captureCalls, []);

  const emptyExpected = alive(4242, {}, {});
  assert.equal(emptyExpected.result, false);
  assert.deepEqual(emptyExpected.calls, expectedProbeCalls);
  assert.deepEqual(emptyExpected.captureCalls, []);

  const unavailable = alive(4242, { ownerStartTime: '100' }, { capture: 'unavailable' });
  assert.equal(unavailable.result, false);
  assert.deepEqual(unavailable.calls, [{ kind: 'kill', pid: 4242, signal: 0 }]);
  assert.deepEqual(unavailable.captureCalls, [4242]);

  const testScript = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).scripts.test;
  const tokens = testScript.split(/\s+/);
  const index = tokens.indexOf('test/process-owner-identity.test.js');
  assert.ok(index > -1, 'process-owner-identity registered in npm test');
  assert.equal(tokens.filter(token => token === 'test/process-owner-identity.test.js').length, 1);
});

test('17. process capture has one owner and State delegates raw arguments', () => {
  const ts = require(path.join(__dirname, '..', 'node_modules', 'typescript'));
  const root = path.join(__dirname, '..');
  const ownerPath = path.join(root, 'src', 'state', 'process-owner-capture.js');
  const statePath = path.join(root, 'src', 'state.js');
  const parse = (text, scriptKind = ts.ScriptKind.JS) => ts.createSourceFile('inventory.js', text, ts.ScriptTarget.Latest, true, scriptKind);
  const strip = text => text.replace(/\s+/g, '');
  function walk(node, visit) {
    visit(node);
    ts.forEachChild(node, child => walk(child, visit));
  }
  function staticStringText(expression) {
    while (ts.isParenthesizedExpression(expression)
      || ts.isAsExpression(expression)
      || ts.isSatisfiesExpression(expression)
      || ts.isNonNullExpression(expression)
      || ts.isTypeAssertionExpression(expression)) {
      expression = expression.expression;
    }
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticStringText(expression.left);
      const right = staticStringText(expression.right);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    if (ts.isTemplateExpression(expression)) {
      let text = expression.head.text;
      for (const span of expression.templateSpans) {
        const value = staticStringText(span.expression);
        if (value === undefined) return undefined;
        text += value + span.literal.text;
      }
      return text;
    }
    return undefined;
  }
  function propertyNameText(name) {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    if (!ts.isComputedPropertyName(name)) return undefined;
    return staticStringText(name.expression);
  }
  function assignmentPropertyNameText(expression) {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
      return staticStringText(expression.argumentExpression);
    }
    return undefined;
  }
  function unwrapExpression(expression) {
    while (ts.isParenthesizedExpression(expression)
      || ts.isAsExpression(expression)
      || ts.isSatisfiesExpression(expression)
      || ts.isNonNullExpression(expression)
      || ts.isTypeAssertionExpression(expression)) {
      expression = expression.expression;
    }
    return expression;
  }
  function hasDeclareModifier(node) {
    return (node.modifiers ?? []).some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword);
  }
  function isImplementationExpression(expression) {
    const implementation = unwrapExpression(expression);
    return ts.isFunctionExpression(implementation)
      || ts.isArrowFunction(implementation)
      || ts.isClassExpression(implementation);
  }
  function hasDirectImplementationReturn(body) {
    return Boolean(body) && body.statements.some(statement => ts.isReturnStatement(statement)
      && statement.expression
      && isImplementationExpression(statement.expression));
  }
  function isImplementationDescriptor(expression, isLocalImplementationAlias) {
    const descriptor = unwrapExpression(expression);
    if (!ts.isObjectLiteralExpression(descriptor)) return false;
    return descriptor.properties.some(property => {
      if (!property.name) return false;
      const name = propertyNameText(property.name);
      if (name === 'value') {
        if (ts.isMethodDeclaration(property)) return true;
        return ts.isPropertyAssignment(property)
          && (isImplementationExpression(property.initializer)
            || isLocalImplementationAlias(property.initializer));
      }
      if (name !== 'get') return false;
      if (ts.isMethodDeclaration(property)) return hasDirectImplementationReturn(property.body);
      if (!ts.isPropertyAssignment(property)) return false;
      const getter = unwrapExpression(property.initializer);
      if (ts.isArrowFunction(getter)) {
        return ts.isBlock(getter.body)
          ? hasDirectImplementationReturn(getter.body)
          : isImplementationExpression(getter.body);
      }
      return ts.isFunctionExpression(getter) && hasDirectImplementationReturn(getter.body);
    });
  }
  function isDefinePropertyImplementation(node, isLocalImplementationAlias) {
    return ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'Object'
      && node.expression.name.text === 'defineProperty'
      && node.arguments.length >= 3
      && isImplementationDescriptor(node.arguments[2], isLocalImplementationAlias);
  }
  function definePropertiesImplementationNames(node, isLocalImplementationAlias) {
    if (!ts.isCallExpression(node)
      || !ts.isPropertyAccessExpression(node.expression)
      || !ts.isIdentifier(node.expression.expression)
      || node.expression.expression.text !== 'Object'
      || node.expression.name.text !== 'defineProperties'
      || node.arguments.length < 2) return [];
    const descriptors = unwrapExpression(node.arguments[1]);
    if (!ts.isObjectLiteralExpression(descriptors)) return [];
    return descriptors.properties.flatMap(property => {
      if (!ts.isPropertyAssignment(property) || !property.name) return [];
      const name = propertyNameText(property.name);
      if (!name || !isImplementationDescriptor(property.initializer, isLocalImplementationAlias)) return [];
      return [name];
    });
  }
  function hasAmbientAncestor(node) {
    for (let current = node.parent; current; current = current.parent) {
      if (hasDeclareModifier(current)
        || (current.flags & ts.NodeFlags.Ambient) !== 0) {
        return true;
      }
    }
    return false;
  }
  function isAccessorExportAlias(node) {
    if (!ts.isGetAccessorDeclaration(node)
      || !node.body
      || node.body.statements.length !== 1
      || !ts.isReturnStatement(node.body.statements[0])
      || !node.body.statements[0].expression) return false;
    const returned = unwrapExpression(node.body.statements[0].expression);
    if (ts.isIdentifier(returned) || ts.isPropertyAccessExpression(returned)) return true;
    if (!ts.isElementAccessExpression(returned) || !returned.argumentExpression) return false;
    const key = unwrapExpression(returned.argumentExpression);
    return ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key);
  }
  function isCallableGetterImplementation(node) {
    if (!ts.isGetAccessorDeclaration(node) || !node.body) return false;
    return node.body.statements.some(statement => {
      if (!ts.isReturnStatement(statement) || !statement.expression) return false;
      const returned = unwrapExpression(statement.expression);
      return ts.isFunctionExpression(returned)
        || ts.isArrowFunction(returned)
        || ts.isClassExpression(returned);
    });
  }
  function isRuntimeMemberImplementation(node) {
    if (hasAmbientAncestor(node)) return false;
    if (ts.isMethodDeclaration(node)) return Boolean(node.body);
    if (ts.isGetAccessorDeclaration(node)) {
      return isCallableGetterImplementation(node) && !isAccessorExportAlias(node);
    }
    if (ts.isSetAccessorDeclaration(node)) return false;
    if (ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) {
      return Boolean(node.initializer) && isImplementationExpression(node.initializer);
    }
    return false;
  }
  function sourceChecker(ast) {
    const options = { allowJs: true, noLib: true, noResolve: true };
    const fileName = path.resolve(ast.fileName);
    const matchesSource = candidate => path.resolve(candidate) === fileName;
    const host = ts.createCompilerHost(options);
    host.getSourceFile = candidate => matchesSource(candidate) ? ast : undefined;
    host.fileExists = candidate => matchesSource(candidate);
    host.readFile = candidate => matchesSource(candidate) ? ast.text : undefined;
    return ts.createProgram([fileName], options, host).getTypeChecker();
  }
  function declaredNames(ast) {
    const names = [];
    const checker = sourceChecker(ast);
    const localImplementations = new Set();
    function recordLocalImplementation(identifier) {
      const symbol = checker.getSymbolAtLocation(identifier);
      if (symbol && (symbol.flags & ts.SymbolFlags.Alias) === 0) localImplementations.add(symbol);
    }
    function isLocalImplementationAlias(expression) {
      const identifier = unwrapExpression(expression);
      if (!ts.isIdentifier(identifier)) return false;
      const symbol = checker.getSymbolAtLocation(identifier);
      return Boolean(symbol
        && (symbol.flags & ts.SymbolFlags.Alias) === 0
        && localImplementations.has(symbol));
    }
    walk(ast, node => {
      if (ts.isFunctionDeclaration(node)
        && node.name
        && node.body
        && !hasDeclareModifier(node)) {
        recordLocalImplementation(node.name);
      }
      if ((ts.isClassDeclaration(node) || ts.isClassExpression(node))
        && node.name
        && !hasDeclareModifier(node)
        && !hasAmbientAncestor(node)) {
        recordLocalImplementation(node.name);
      }
      if (ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.initializer) {
        const initializer = unwrapExpression(node.initializer);
        if (ts.isFunctionExpression(initializer)
          || ts.isArrowFunction(initializer)
          || ts.isClassExpression(initializer)) {
          recordLocalImplementation(node.name);
        }
      }
      if (ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left)) {
        const implementation = unwrapExpression(node.right);
        if (ts.isFunctionExpression(implementation)
          || ts.isArrowFunction(implementation)
          || ts.isClassExpression(implementation)) {
          recordLocalImplementation(node.left);
        }
      }
    });
    walk(ast, node => {
      if (ts.isFunctionDeclaration(node)
        && node.name
        && node.body
        && !hasDeclareModifier(node)) {
        names.push(node.name.text);
      }
      if (ts.isFunctionExpression(node) && node.name) names.push(node.name.text);
      if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) {
        if (!hasDeclareModifier(node) && !hasAmbientAncestor(node)) names.push(node.name.text);
      }
      if (ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.initializer) {
        const initializer = unwrapExpression(node.initializer);
        if (ts.isFunctionExpression(initializer)
          || ts.isArrowFunction(initializer)
          || ts.isClassExpression(initializer)) {
          names.push(node.name.text);
        }
      }
      if (ts.isBinaryExpression(node)
        && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken
          || node.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken
          || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken)) {
        const name = assignmentPropertyNameText(node.left);
        const implementation = unwrapExpression(node.right);
        if (name && (ts.isFunctionExpression(implementation)
          || ts.isArrowFunction(implementation)
          || ts.isClassExpression(implementation)
          || isLocalImplementationAlias(implementation))) {
          names.push(name);
        }
      }
      if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'Object'
        && node.expression.name.text === 'defineProperty'
        && node.arguments.length >= 2) {
        const name = staticStringText(node.arguments[1]);
        if (name && isDefinePropertyImplementation(node, isLocalImplementationAlias)) names.push(name);
      }
      if (ts.isCallExpression(node)) {
        names.push(...definePropertiesImplementationNames(node, isLocalImplementationAlias));
      }
      if (isRuntimeMemberImplementation(node) && node.name) {
        const name = propertyNameText(node.name);
        if (name) names.push(name);
      }
    });
    return names;
  }
  const localFunctionAliasAst = parse(`function localCapture(pid) { return pid; }
    exports.captureProcessOwnerIdentity = localCapture;`);
  assert.ok(declaredNames(localFunctionAliasAst).includes('captureProcessOwnerIdentity'));
  const localClassAliasAst = parse(`class LocalCapture {}
    exports.captureProcessOwnerIdentity = LocalCapture;`);
  assert.ok(declaredNames(localClassAliasAst).includes('captureProcessOwnerIdentity'));
  const localDescriptorAliasAst = parse(`function localCapture() {}
    Object.defineProperty(exports, 'captureProcessOwnerIdentity', { value: localCapture });`);
  assert.ok(declaredNames(localDescriptorAliasAst).includes('captureProcessOwnerIdentity'));
  const localDefinePropertiesAliasAst = parse(`const localCapture = () => {};
    Object.defineProperties(exports, { captureProcessOwnerIdentity: { value: localCapture } });`);
  assert.ok(declaredNames(localDefinePropertiesAliasAst).includes('captureProcessOwnerIdentity'));
  const importedAliasAst = parse(`import { localCapture } from './capture.js';
    exports.captureProcessOwnerIdentity = localCapture;`);
  assert.equal(declaredNames(importedAliasAst).includes('captureProcessOwnerIdentity'), false);
  const shadowedImportedAliasAst = parse(`import { handler } from './capture.js';
    { const handler = function () {}; }
    exports.captureProcessOwnerIdentity = handler;`);
  assert.equal(declaredNames(shadowedImportedAliasAst).includes('captureProcessOwnerIdentity'), false);
  const logicalOwnerAssignmentAst = parse(`exports.captureProcessOwnerIdentity ||= function () {};`);
  assert.ok(declaredNames(logicalOwnerAssignmentAst).includes('captureProcessOwnerIdentity'));
  const nullishOwnerAssignmentAst = parse(`exports.captureProcessOwnerIdentity ??= () => null;`);
  assert.ok(declaredNames(nullishOwnerAssignmentAst).includes('captureProcessOwnerIdentity'));
  const nonCallableGetterAst = parse(`const unrelated = {
    get captureProcessOwnerIdentity() { return null; }
  };`);
  assert.equal(declaredNames(nonCallableGetterAst).includes('captureProcessOwnerIdentity'), false);
  const callableGetterAst = parse(`const unrelated = {
    get captureProcessOwnerIdentity() { return () => {}; }
  };`);
  assert.ok(declaredNames(callableGetterAst).includes('captureProcessOwnerIdentity'));
  function sourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(entryPath);
      return /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/.test(entry.name) ? [entryPath] : [];
    });
  }
  function sourceScriptKind(filePath) {
    switch (path.extname(filePath)) {
      case '.jsx': return ts.ScriptKind.JSX;
      case '.tsx': return ts.ScriptKind.TSX;
      case '.ts':
      case '.cts':
      case '.mts': return ts.ScriptKind.TS;
      default: return ts.ScriptKind.JS;
    }
  }

  const ownerSource = fs.readFileSync(ownerPath, 'utf8');
  const ownerAst = parse(ownerSource);
  assert.equal(ownerAst.statements.length, 3);
  assert.equal(ownerAst.statements[0].getText(ownerAst), "'use strict';");
  const ownerFunction = ownerAst.statements[1];
  assert.ok(ts.isFunctionDeclaration(ownerFunction));
  assert.equal(ownerFunction.name.getText(ownerAst), 'captureProcessOwnerIdentity');
  assert.equal(ownerFunction.parameters.length, 1);
  assert.equal(ownerFunction.parameters[0].getText(ownerAst), 'pid');
  assert.equal(strip(ownerAst.statements[2].getText(ownerAst)), 'module.exports={captureProcessOwnerIdentity};');
  assert.equal(declaredNames(ownerAst).filter(name => name === 'captureProcessOwnerIdentity').length, 1);

  const cjsFixtureDirectory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), '.process-owner-census-'));
  try {
    const cjsFixturePath = path.join(cjsFixtureDirectory, 'capture-owner.cjs');
    const definePropertiesFixturePath = path.join(cjsFixtureDirectory, 'capture-owner-descriptors.cjs');
    fs.writeFileSync(cjsFixturePath, 'function captureProcessOwnerIdentity(pid) { return pid; }');
    fs.writeFileSync(definePropertiesFixturePath, 'Object.defineProperties(exports, { captureProcessOwnerIdentity: { value() {} } });');
    const cjsDeclaringFiles = sourceFiles(cjsFixtureDirectory)
      .filter(filePath => declaredNames(parse(
        fs.readFileSync(filePath, 'utf8'),
        sourceScriptKind(filePath)
      )).includes('captureProcessOwnerIdentity'));
    assert.deepEqual(cjsDeclaringFiles.sort(), [cjsFixturePath, definePropertiesFixturePath].sort());
  } finally {
    fs.rmSync(cjsFixtureDirectory, { recursive: true, force: true });
  }

  const methodControls = [
    ['ambient namespace class', 'declare namespace Types { export class captureProcessOwnerIdentity {} }', false, ts.ScriptKind.TS],
    ['runtime class declaration', 'class captureProcessOwnerIdentity {}', true],
    ['runtime namespace class', 'namespace Types { export class captureProcessOwnerIdentity {} }', true, ts.ScriptKind.TS],
    ['class wrapped function member', 'class Example { captureProcessOwnerIdentity = (function () {}); }', true],
    ['class arrow member', 'class Example { captureProcessOwnerIdentity = () => null; }', true],
    ['class anonymous class member', 'class Example { captureProcessOwnerIdentity = class {}; }', true],
    ['class value member', 'class Example { captureProcessOwnerIdentity = null; }', false],
    ['class alias member', 'class Example { captureProcessOwnerIdentity = importedCapture; }', false],
    ['ambient namespace member', 'declare namespace Types { export class Example { captureProcessOwnerIdentity = () => null; } }', false, ts.ScriptKind.TS],
    ['class method', 'class Example { captureProcessOwnerIdentity() {} }', true],
    ['class string method', "class Example { 'captureProcessOwnerIdentity'() {} }", true],
    ['class concatenated computed method', "class Example { ['captureProcessOwner' + 'Identity']() {} }", true],
    ['class interpolated computed method', 'class Example { [`captureProcessOwner${"Identity"}`]() {} }', true],
    ['class static computed method', "class Example { static ['captureProcessOwnerIdentity']() {} }", true],
    ['class static computed template', 'class Example { static [`captureProcessOwnerIdentity`]() {} }', true],
    ['class static computed parenthesized string', "class Example { static [('captureProcessOwnerIdentity')]() {} }", true],
    ['class static computed as string', "class Example { static ['captureProcessOwnerIdentity' as string]() {} }", true, ts.ScriptKind.TS],
    ['class static computed satisfies string', "class Example { static ['captureProcessOwnerIdentity' satisfies string]() {} }", true, ts.ScriptKind.TS],
    ['class static computed non-null string', "class Example { static ['captureProcessOwnerIdentity'!]() {} }", true, ts.ScriptKind.TS],
    ['class static computed angle-bracket string', "class Example { static [<string>'captureProcessOwnerIdentity']() {} }", true, ts.ScriptKind.TS],
    ['class null property', 'class Example { captureProcessOwnerIdentity = null; }', false],
    ['class property alias', 'class Example { captureProcessOwnerIdentity = importedCapture; }', false],
    ['class function property', 'class Example { captureProcessOwnerIdentity = function () {}; }', true],
    ['class static string null property', "class Example { static 'captureProcessOwnerIdentity' = null; }", false],
    ['class static string property alias', "class Example { static 'captureProcessOwnerIdentity' = importedCapture; }", false],
    ['class getter', 'class Example { get captureProcessOwnerIdentity() { return null; } }', false],
    ['class getter alias', 'class Example { get captureProcessOwnerIdentity() { return importedCapture; } }', false],
    ['class setter', 'class Example { set captureProcessOwnerIdentity(value) {} }', false],
    ['object method', '({ captureProcessOwnerIdentity() {} });', true],
    ['object getter alias', '({ get captureProcessOwnerIdentity() { return importedCapture; } });', false],
    ['object setter', '({ set captureProcessOwnerIdentity(value) {} });', false],
    ['object null property', '({ captureProcessOwnerIdentity: null });', false],
    ['object property alias', '({ captureProcessOwnerIdentity: importedCapture });', false],
    ['object function property', '({ captureProcessOwnerIdentity: function () {} });', true],
    ['object string null property', "({ 'captureProcessOwnerIdentity': null });", false],
    ['object string property alias', "({ 'captureProcessOwnerIdentity': importedCapture });", false],
    ['object computed null property', "({ ['captureProcessOwnerIdentity']: null });", false],
    ['object computed property alias', "({ ['captureProcessOwnerIdentity']: importedCapture });", false],
    ['object computed wrapped template null', '({ [(`captureProcessOwnerIdentity`)]: null });', false],
    ['object computed wrapped template alias', '({ [(`captureProcessOwnerIdentity`)]: importedCapture });', false],
    ['object computed wrapped as string null', "({ [('captureProcessOwnerIdentity' as string)]: null });", false, ts.ScriptKind.TS],
    ['object computed wrapped as string alias', "({ [('captureProcessOwnerIdentity' as string)]: importedCapture });", false, ts.ScriptKind.TS],
    ['property access assignment', 'exports.captureProcessOwnerIdentity = function () {};', true],
    ['property access alias assignment', 'handlers.captureProcessOwnerIdentity = captureProcessOwnerIdentity;', false],
    ['string element assignment', "exports['captureProcessOwnerIdentity'] = function () {};", true],
    ['concatenated element assignment', "exports['captureProcessOwner' + 'Identity'] = function () {};", true],
    ['angle-bracket element assignment', "exports[<string>'captureProcessOwnerIdentity'] = function () {};", true, ts.ScriptKind.TS],
    ['prototype property assignment', 'Example.prototype.captureProcessOwnerIdentity = function () {};', true],
    ['named function expression', 'const other = function captureProcessOwnerIdentity() {};', true],
    ['named class expression', 'const Other = class captureProcessOwnerIdentity {};', true],
    ['parenthesized class initializer', 'const captureProcessOwnerIdentity = (class {});', true],
    ['parenthesized arrow initializer', 'const captureProcessOwnerIdentity = (() => null);', true],
    ['as-wrapped arrow initializer', 'const captureProcessOwnerIdentity = (() => null) as unknown;', true, ts.ScriptKind.TS],
    ['satisfies-wrapped arrow initializer', 'const captureProcessOwnerIdentity = (() => null) satisfies unknown;', true, ts.ScriptKind.TS],
    ['type-asserted arrow initializer', "const captureProcessOwnerIdentity = <unknown>(() => null);", true, ts.ScriptKind.TS],
    ['import initializer', "const captureProcessOwnerIdentity = require('./process-owner-capture');", false],
    ['alias initializer', 'const captureProcessOwnerIdentity = existingCapture;', false],
    ['defineProperty descriptor', "Object.defineProperty(exports, 'captureProcessOwnerIdentity', { value() {} });", true],
    ['defineProperty value implementation', "Object.defineProperty(exports, 'captureProcessOwnerIdentity', { value: function () {} });", true],
    ['defineProperty value alias', "Object.defineProperty(exports, 'captureProcessOwnerIdentity', { value: captureProcessOwnerIdentity });", false],
    ['defineProperties descriptor method', 'Object.defineProperties(exports, { captureProcessOwnerIdentity: { value() {} } });', true],
    ['defineProperties function value', 'Object.defineProperties(exports, { captureProcessOwnerIdentity: { value: function () {} } });', true],
    ['defineProperties arrow value', 'Object.defineProperties(exports, { captureProcessOwnerIdentity: { value: () => null } });', true],
    ['defineProperties class value', 'Object.defineProperties(exports, { captureProcessOwnerIdentity: { value: class {} } });', true],
    ['defineProperties computed name', "Object.defineProperties(exports, { ['captureProcessOwnerIdentity']: { value() {} } });", true],
    ['defineProperties unrelated property', 'Object.defineProperties(exports, { otherCapture: { value() {} } });', false],
    ['defineProperties value alias', 'Object.defineProperties(exports, { captureProcessOwnerIdentity: { value: importedCapture } });', false],
    ['defineProperties null value', 'Object.defineProperties(exports, { captureProcessOwnerIdentity: { value: null } });', false],
    ['defineProperty getter implementation', "Object.defineProperty(exports, 'captureProcessOwnerIdentity', { get() { return pid => null; } });", true],
    ['defineProperty getter imported alias', "Object.defineProperty(exports, 'captureProcessOwnerIdentity', { get() { return importedCapture; } });", false],
    ['defineProperties getter implementation', 'Object.defineProperties(exports, { captureProcessOwnerIdentity: { get() { return pid => null; } } });', true],
    ['defineProperties getter imported alias', 'Object.defineProperties(exports, { captureProcessOwnerIdentity: { get() { return importedCapture; } } });', false],
    ['bare binding assignment implementation', 'let captureProcessOwnerIdentity; captureProcessOwnerIdentity = function () {};', true],
    ['bare binding assignment imported alias', 'let captureProcessOwnerIdentity; captureProcessOwnerIdentity = importedCapture;', false],
    ['bare binding assignment null', 'let captureProcessOwnerIdentity; captureProcessOwnerIdentity = null;', false],
    ['ambient function declaration', 'declare function captureProcessOwnerIdentity(pid: number): Owner | null;', false, ts.ScriptKind.TS],
    ['ambient class method', 'declare class Example { captureProcessOwnerIdentity() {} }', false, ts.ScriptKind.TS],
    ['dynamic computed method', 'class Example { static [owner]() {} }', false],
    ['dynamic computed property', '({ [owner]: null });', false],
    ['dynamic wrapped computed method', 'class Example { static [(owner)]() {} }', false],
    ['dynamic as computed property', '({ [owner as string]: null });', false, ts.ScriptKind.TS],
    ['dynamic satisfies computed method', 'class Example { static [owner satisfies string]() {} }', false, ts.ScriptKind.TS],
    ['dynamic non-null computed property', '({ [owner!]: null });', false, ts.ScriptKind.TS],
    ['dynamic element assignment', 'exports[owner] = function () {};', false],
    ['dynamic angle-bracket element assignment', 'exports[<string>owner] = function () {};', false, ts.ScriptKind.TS],
    ['dynamic defineProperty descriptor', 'Object.defineProperty(exports, owner, { value() {} });', false],
  ];
  for (const [label, source, expected, scriptKind] of methodControls) {
    assert.equal(declaredNames(parse(source, scriptKind)).includes('captureProcessOwnerIdentity'), expected, label);
  }

  const declaringFiles = sourceFiles(path.join(root, 'src'))
    .filter(filePath => declaredNames(parse(
      fs.readFileSync(filePath, 'utf8'),
      sourceScriptKind(filePath)
    )).includes('captureProcessOwnerIdentity'))
    .map(filePath => path.relative(root, filePath));
  assert.deepEqual(declaringFiles, [path.relative(root, ownerPath)]);

  const stateAst = parse(fs.readFileSync(statePath, 'utf8'));
  const imports = stateAst.statements.filter(statement => ts.isVariableStatement(statement)
    && strip(statement.getText(stateAst)) === "const{captureProcessOwnerIdentity}=require('./state/process-owner-capture');");
  assert.equal(imports.length, 1);
  const surfaceStateDeclaration = stateAst.statements.find(statement => ts.isClassDeclaration(statement)
    && statement.name?.text === 'SurfaceState');
  const staticAssignmentPropertyName = expression => {
    expression = unwrapExpression(expression);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (!ts.isElementAccessExpression(expression) || !expression.argumentExpression) return null;
    return staticStringText(expression.argumentExpression);
  };
  const isSurfaceStateReceiver = expression => {
    expression = unwrapExpression(expression);
    if (ts.isPropertyAccessExpression(expression)) {
      const receiver = unwrapExpression(expression.expression);
      return ts.isIdentifier(receiver)
        && receiver.text === 'SurfaceState'
        && expression.name.text === 'prototype';
    }
    const receiver = ts.isElementAccessExpression(expression)
      ? unwrapExpression(expression.expression)
      : null;
    return ts.isElementAccessExpression(expression)
      && !!expression.argumentExpression
      && ts.isIdentifier(receiver)
      && receiver.text === 'SurfaceState'
      && staticAssignmentPropertyName(expression.argumentExpression) === 'prototype';
  };
  const isSurfaceStateConstructorReceiver = (expression, targetClass) => {
    expression = unwrapExpression(expression);
    if (!ts.isThis(expression)) return false;
    for (let current = expression.parent; current; current = current.parent) {
      if (ts.isConstructorDeclaration(current)) return current.parent === targetClass;
      if (ts.isArrowFunction(current)) continue;
      if (ts.isFunctionDeclaration(current)
        || ts.isFunctionExpression(current)
        || ts.isMethodDeclaration(current)
        || ts.isGetAccessorDeclaration(current)
        || ts.isSetAccessorDeclaration(current)) return false;
      if ((ts.isClassDeclaration(current) || ts.isClassExpression(current))
        && current !== targetClass) return false;
    }
    return false;
  };
  const isSurfaceStateFacadeReceiver = (expression, targetClass) => isSurfaceStateReceiver(expression)
    || isSurfaceStateConstructorReceiver(expression, targetClass);
  const targetsSurfaceState = (expression, targetClass = surfaceStateDeclaration) => {
    expression = unwrapExpression(expression);
    return (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
      && isSurfaceStateFacadeReceiver(expression.expression, targetClass);
  };
  const parenthesizedFacadeOverride = parse(
    "SurfaceState[('prototype')][('directPostOwnerIdentity')] = function () {};"
  ).statements[0].expression;
  assert.equal(targetsSurfaceState(parenthesizedFacadeOverride.left), true);
  assert.equal(staticAssignmentPropertyName(parenthesizedFacadeOverride.left), 'directPostOwnerIdentity');
  const definePropertyName = (node, targetClass = surfaceStateDeclaration) => {
    if (!ts.isCallExpression(node)
      || !ts.isPropertyAccessExpression(node.expression)
      || !ts.isIdentifier(node.expression.expression)
      || node.expression.expression.text !== 'Object'
      || node.expression.name.text !== 'defineProperty'
      || node.arguments.length < 3) return null;
    if (!isSurfaceStateFacadeReceiver(node.arguments[0], targetClass)) return null;
    const descriptor = unwrapExpression(node.arguments[2]);
    if (!ts.isObjectLiteralExpression(descriptor)
      || !descriptor.properties.some(property => property.name
        && ['value', 'get', 'set'].includes(propertyNameText(property.name)))) return null;
    return staticStringText(node.arguments[1]);
  };
  const definePropertiesMembers = (node, targetClass = surfaceStateDeclaration) => {
    if (!ts.isCallExpression(node)
      || !ts.isPropertyAccessExpression(node.expression)
      || !ts.isIdentifier(node.expression.expression)
      || node.expression.expression.text !== 'Object'
      || node.expression.name.text !== 'defineProperties'
      || node.arguments.length < 2
      || !isSurfaceStateFacadeReceiver(node.arguments[0], targetClass)) return [];
    const descriptors = unwrapExpression(node.arguments[1]);
    if (!ts.isObjectLiteralExpression(descriptors)) return [];
    return descriptors.properties.filter(property => property.name
      && propertyNameText(property.name) === 'directPostOwnerIdentity');
  };
  const concatenatedDefineProperty = parse(
    "Object.defineProperty(SurfaceState.prototype, 'directPostOwner' + 'Identity', { value() {} });"
  ).statements[0].expression;
  assert.equal(definePropertyName(concatenatedDefineProperty), 'directPostOwnerIdentity');
  const objectAssignProperties = (node, targetClass = surfaceStateDeclaration) => {
    if (!ts.isCallExpression(node)
      || !ts.isPropertyAccessExpression(node.expression)
      || !ts.isIdentifier(node.expression.expression)
      || node.expression.expression.text !== 'Object'
      || node.expression.name.text !== 'assign'
      || node.arguments.length < 2
      || !isSurfaceStateFacadeReceiver(node.arguments[0], targetClass)) return [];
    return node.arguments.slice(1).flatMap(argument => {
      const source = unwrapExpression(argument);
      if (!ts.isObjectLiteralExpression(source)) return [];
      return source.properties.filter(property => property.name
        && propertyNameText(property.name) === 'directPostOwnerIdentity');
    });
  };
  const isFacadeAssignmentOperator = operator => operator >= ts.SyntaxKind.FirstAssignment
    && operator <= ts.SyntaxKind.LastAssignment
    && operator !== ts.SyntaxKind.BarBarEqualsToken
    && operator !== ts.SyntaxKind.QuestionQuestionEqualsToken;
  const collectSurfaceStateFacades = ast => {
    const targetClass = ast.statements.find(statement => ts.isClassDeclaration(statement)
      && statement.name?.text === 'SurfaceState');
    const targetMembers = targetClass ? Array.from(targetClass.members) : [];
    const installations = [];
    walk(ast, node => {
      if ((ts.isMethodDeclaration(node)
        || ts.isPropertyDeclaration(node)
        || ts.isGetAccessorDeclaration(node)
        || ts.isSetAccessorDeclaration(node))
        && targetMembers.includes(node)
        && !(node.modifiers ?? []).some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)
        && propertyNameText(node.name) === 'directPostOwnerIdentity') installations.push(node);
      if (ts.isBinaryExpression(node)
        && isFacadeAssignmentOperator(node.operatorToken.kind)
        && targetsSurfaceState(node.left, targetClass)
        && staticAssignmentPropertyName(node.left) === 'directPostOwnerIdentity') installations.push(node);
      if (ts.isDeleteExpression(node)
        && targetsSurfaceState(node.expression, targetClass)
        && staticAssignmentPropertyName(node.expression) === 'directPostOwnerIdentity') installations.push(node);
      if (definePropertyName(node, targetClass) === 'directPostOwnerIdentity') installations.push(node);
      installations.push(...definePropertiesMembers(node, targetClass));
      installations.push(...objectAssignProperties(node, targetClass));
    });
    return installations;
  };
  const compoundFacadeAst = parse(`class SurfaceState {
    constructor() { this.directPostOwnerIdentity &&= replacement; }
  }`);
  assert.equal(collectSurfaceStateFacades(compoundFacadeAst).length, 1);
  const nonWritingFacadeAst = parse(`class SurfaceState {
    constructor() { this.directPostOwnerIdentity ||= replacement; }
  }`);
  assert.equal(collectSurfaceStateFacades(nonWritingFacadeAst).length, 0);
  const deletedFacadeAst = parse(`class SurfaceState {
    directPostOwnerIdentity() {}
  }
  delete SurfaceState.prototype.directPostOwnerIdentity;`);
  assert.equal(collectSurfaceStateFacades(deletedFacadeAst).length, 2);
  const facade = collectSurfaceStateFacades(stateAst);
  assert.equal(facade.length, 1);
  assert.equal(strip(facade[0].body.getText(stateAst)), '{returncaptureProcessOwnerIdentity.apply(this,arguments);}');

  const facadeInventoryAst = parse(`class SurfaceState {
    directPostOwnerIdentity() {}
    ['directPostOwner' + 'Identity']() {}
    static directPostOwnerIdentity() {}
  }
  class OtherState {
    directPostOwnerIdentity() {}
  }
  SurfaceState.prototype.directPostOwnerIdentity = function () {};
  SurfaceState['prototype'].directPostOwnerIdentity = function () {};
  SurfaceState['directPostOwner' + 'Identity'] = function () {};
  Object.assign(SurfaceState.prototype, { directPostOwnerIdentity() {} });
  Object.defineProperty(SurfaceState.prototype, 'directPostOwnerIdentity', { value() {} });
  Object.defineProperties(SurfaceState.prototype, { directPostOwnerIdentity: { value() {} } });
  Object.defineProperty(SurfaceState['prototype'], 'directPostOwnerIdentity', { value() {} });
  Object.defineProperty(SurfaceState.prototype, owner, { value() {} });
  Object.defineProperty(handlers, 'directPostOwnerIdentity', { value() {} });
  `);
  const duplicateFacade = collectSurfaceStateFacades(facadeInventoryAst);
  assert.equal(duplicateFacade.length, 8);

  const facadeRecognitionCases = [
    ['A1 grouped prototype assignment', "class SurfaceState { directPostOwnerIdentity() {} } (SurfaceState.prototype).directPostOwnerIdentity = function () {};", 2],
    ['prototype assignment null value', 'class SurfaceState { directPostOwnerIdentity() {} } SurfaceState.prototype.directPostOwnerIdentity = null;', 2],
    ['grouped prototype assignment null value', 'class SurfaceState { directPostOwnerIdentity() {} } (SurfaceState.prototype).directPostOwnerIdentity = null;', 2],
    ['prototype assignment imported value', 'class SurfaceState { directPostOwnerIdentity() {} } SurfaceState.prototype.directPostOwnerIdentity = importedCapture;', 2],
    ['A2 grouped defineProperty receiver', "class SurfaceState { directPostOwnerIdentity() {} } Object.defineProperty((SurfaceState.prototype), 'directPostOwnerIdentity', { value: function () {} });", 2],
    ['defineProperty null value', "class SurfaceState { directPostOwnerIdentity() {} } Object.defineProperty(SurfaceState.prototype, 'directPostOwnerIdentity', { value: null });", 2],
    ['defineProperty imported value', "class SurfaceState { directPostOwnerIdentity() {} } Object.defineProperty(SurfaceState.prototype, 'directPostOwnerIdentity', { value: importedCapture });", 2],
    ['defineProperties descriptor', 'class SurfaceState { directPostOwnerIdentity() {} } Object.defineProperties(SurfaceState.prototype, { directPostOwnerIdentity: { value() {} } });', 2],
    ['defineProperties null value', 'class SurfaceState { directPostOwnerIdentity() {} } Object.defineProperties(SurfaceState.prototype, { directPostOwnerIdentity: { value: null } });', 2],
    ['defineProperties imported value', 'class SurfaceState { directPostOwnerIdentity() {} } Object.defineProperties(SurfaceState.prototype, { directPostOwnerIdentity: { value: importedCapture } });', 2],
    ['defineProperties getter', 'class SurfaceState { directPostOwnerIdentity() {} } Object.defineProperties(SurfaceState.prototype, { directPostOwnerIdentity: { get: importedGetter } });', 2],
    ['defineProperties setter', 'class SurfaceState { directPostOwnerIdentity() {} } Object.defineProperties(SurfaceState.prototype, { directPostOwnerIdentity: { set: importedSetter } });', 2],
    ['grouped defineProperties receiver', 'class SurfaceState { directPostOwnerIdentity() {} } Object.defineProperties((SurfaceState.prototype), { directPostOwnerIdentity: { value: null } });', 2],
    ['defineProperties computed name', "class SurfaceState { directPostOwnerIdentity() {} } Object.defineProperties(SurfaceState.prototype, { ['directPostOwner' + 'Identity']: { value: null } });", 2],
    ['constructor defineProperties receiver', 'class SurfaceState { constructor() { Object.defineProperties(this, { directPostOwnerIdentity: { value: null } }); } directPostOwnerIdentity() {} }', 2],
    ['A3 grouped Object.assign receiver', "class SurfaceState { directPostOwnerIdentity() {} } Object.assign((SurfaceState.prototype), { directPostOwnerIdentity() {} });", 2],
    ['Object.assign null value', 'class SurfaceState { directPostOwnerIdentity() {} } Object.assign(SurfaceState.prototype, { directPostOwnerIdentity: null });', 2],
    ['Object.assign imported value', 'class SurfaceState { directPostOwnerIdentity() {} } Object.assign(SurfaceState.prototype, { directPostOwnerIdentity: importedCapture });', 2],
    ['A4 other prototype receiver', "class SurfaceState { directPostOwnerIdentity() {} } class OtherState {} (OtherState.prototype).directPostOwnerIdentity = function () {};", 1],
    ['A5 constructor object receiver', "class SurfaceState { directPostOwnerIdentity() {} } (SurfaceState).directPostOwnerIdentity = function () {};", 1],
    ['A6 constructor dot assignment', "class SurfaceState { constructor() { this.directPostOwnerIdentity = function () {}; } directPostOwnerIdentity() {} }", 2],
    ['constructor null assignment', 'class SurfaceState { constructor() { this.directPostOwnerIdentity = null; } directPostOwnerIdentity() {} }', 2],
    ['A7 constructor element assignment', "class SurfaceState { constructor() { this['directPostOwnerIdentity'] = function () {}; } directPostOwnerIdentity() {} }", 2],
    ['constructor defineProperty receiver', "class SurfaceState { constructor() { Object.defineProperty(this, 'directPostOwnerIdentity', { value: function () {} }); } directPostOwnerIdentity() {} }", 2],
    ['constructor Object.assign receiver', "class SurfaceState { constructor() { Object.assign(this, { directPostOwnerIdentity() {} }); } directPostOwnerIdentity() {} }", 2],
    ['A8 other constructor assignment', "class SurfaceState { directPostOwnerIdentity() {} } class OtherState { constructor() { this.directPostOwnerIdentity = function () {}; } }", 1],
    ['other constructor defineProperty receiver', "class SurfaceState { directPostOwnerIdentity() {} } class OtherState { constructor() { Object.defineProperty(this, 'directPostOwnerIdentity', { value: function () {} }); } }", 1],
    ['other defineProperties receiver', 'class SurfaceState { directPostOwnerIdentity() {} } class OtherState {} Object.defineProperties(OtherState.prototype, { directPostOwnerIdentity: { value: null } });', 1],
    ['constructor target defineProperties receiver', 'class SurfaceState { directPostOwnerIdentity() {} } Object.defineProperties(SurfaceState, { directPostOwnerIdentity: { value: null } });', 1],
    ['unrelated defineProperties key', 'class SurfaceState { directPostOwnerIdentity() {} } Object.defineProperties(SurfaceState.prototype, { otherMethod: { value: null } });', 1],
    ['dynamic defineProperties key', 'class SurfaceState { directPostOwnerIdentity() {} } Object.defineProperties(SurfaceState.prototype, { [owner]: { value: null } });', 1],
    ['nested function defineProperties receiver', 'class SurfaceState { constructor() { function install() { Object.defineProperties(this, { directPostOwnerIdentity: { value: null } }); } } directPostOwnerIdentity() {} }', 1],
    ['A9 unrelated constructor property', "class SurfaceState { constructor() { this.otherMethod = function () {}; } directPostOwnerIdentity() {} }", 1],
    ['A10 static method', "class SurfaceState { static directPostOwnerIdentity() {} directPostOwnerIdentity() {} }", 1],
    ['nested function this', "class SurfaceState { constructor() { function install() { this.directPostOwnerIdentity = function () {}; } } directPostOwnerIdentity() {} }", 1],
    ['prototype assignment alias', "class SurfaceState { directPostOwnerIdentity() {} } (SurfaceState.prototype).directPostOwnerIdentity = importedCapture;", 2],
    ['defineProperty alias value', "class SurfaceState { directPostOwnerIdentity() {} } Object.defineProperty((SurfaceState.prototype), 'directPostOwnerIdentity', { value: importedCapture });", 2],
    ['Object.assign alias value', "class SurfaceState { directPostOwnerIdentity() {} } Object.assign((SurfaceState.prototype), { directPostOwnerIdentity: importedCapture });", 2],
  ];
  for (const [label, source, expected] of facadeRecognitionCases) {
    assert.equal(collectSurfaceStateFacades(parse(source, ts.ScriptKind.TS)).length, expected, label);
  }

  const overridingFacadeMembers = [
    ['class field', 'class State { directPostOwnerIdentity = null; }'],
    ['getter', 'class State { get directPostOwnerIdentity() { return null; } }'],
    ['setter', 'class State { set directPostOwnerIdentity(value) {} }'],
  ];
  for (const [label, source] of overridingFacadeMembers) {
    const members = [];
    walk(parse(source, ts.ScriptKind.TS), node => {
      if ((ts.isPropertyDeclaration(node)
        || ts.isGetAccessorDeclaration(node)
        || ts.isSetAccessorDeclaration(node))
        && propertyNameText(node.name) === 'directPostOwnerIdentity') members.push(node);
    });
    assert.equal(members.length, 1, label);
  }

  const Module = require('node:module');
  const resolvedState = require.resolve('../src/state');
  const resolvedOwner = require.resolve('../src/state/process-owner-capture');
  const originalLoad = Module._load;
  const originalCache = [resolvedState, resolvedOwner].map(file => [file, require.cache[file]]);
  const sentinelResult = { ownerPid: 4242, ownerStartTime: 'sentinel', ownerCommand: 'node' };
  const identity = { ownerStartTime: 'sentinel', ownerCommand: 'node' };
  let received = null;
  Module._load = function (request, parent) {
    if (request === './state/process-owner-capture' && parent && parent.filename === resolvedState) {
      return {
        captureProcessOwnerIdentity: function () {
          received = { receiver: this, args: Array.from(arguments) };
          return sentinelResult;
        }
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    delete require.cache[resolvedState];
    delete require.cache[resolvedOwner];
    const { SurfaceState: DelegatingState } = require('../src/state');
    const instance = Object.create(DelegatingState.prototype);
    const result = DelegatingState.prototype.directPostOwnerIdentity.call(instance, identity, 'extra');
    assert.equal(received.receiver, instance);
    assert.equal(received.args.length, 2);
    assert.equal(received.args[0], identity);
    assert.equal(received.args[1], 'extra');
    assert.equal(result, sentinelResult);

    const boom = new Error('sentinel capture failed');
    Module._load = function (request, parent) {
      if (request === './state/process-owner-capture' && parent && parent.filename === resolvedState) {
        return { captureProcessOwnerIdentity: () => { throw boom; } };
      }
      return originalLoad.apply(this, arguments);
    };
    delete require.cache[resolvedState];
    const { SurfaceState: ThrowingState } = require('../src/state');
    assert.throws(
      () => ThrowingState.prototype.directPostOwnerIdentity.call(Object.create(ThrowingState.prototype), identity, 'extra'),
      error => error === boom
    );
  } finally {
    Module._load = originalLoad;
    for (const [file, entry] of originalCache) {
      if (entry === undefined) delete require.cache[file];
      else require.cache[file] = entry;
    }
  }
  assert.equal(Module._load, originalLoad);
  for (const [file, entry] of originalCache) assert.equal(require.cache[file], entry);
});
