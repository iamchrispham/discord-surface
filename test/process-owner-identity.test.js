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
  function propertyNameText(name) {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    if (!ts.isComputedPropertyName(name)) return undefined;
    let expression = name.expression;
    while (ts.isParenthesizedExpression(expression)
      || ts.isAsExpression(expression)
      || ts.isSatisfiesExpression(expression)
      || ts.isNonNullExpression(expression)) {
      expression = expression.expression;
    }
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
    return undefined;
  }
  function declaredNames(ast) {
    const names = [];
    walk(ast, node => {
      if (ts.isFunctionDeclaration(node) && node.name) names.push(node.name.text);
      if (ts.isClassDeclaration(node) && node.name) names.push(node.name.text);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) names.push(node.name.text);
      if ((ts.isMethodDeclaration(node)
        || ts.isPropertyDeclaration(node)
        || ts.isPropertyAssignment(node)
        || ts.isGetAccessorDeclaration(node)
        || ts.isSetAccessorDeclaration(node)) && node.name) {
        const name = propertyNameText(node.name);
        if (name) names.push(name);
      }
    });
    return names;
  }
  function sourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(entryPath);
      return /\.(?:js|ts)$/.test(entry.name) ? [entryPath] : [];
    });
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

  const methodControls = [
    ['class method', 'class Example { captureProcessOwnerIdentity() {} }', true],
    ['class string method', "class Example { 'captureProcessOwnerIdentity'() {} }", true],
    ['class static computed method', "class Example { static ['captureProcessOwnerIdentity']() {} }", true],
    ['class static computed template', 'class Example { static [`captureProcessOwnerIdentity`]() {} }', true],
    ['class static computed parenthesized string', "class Example { static [('captureProcessOwnerIdentity')]() {} }", true],
    ['class static computed as string', "class Example { static ['captureProcessOwnerIdentity' as string]() {} }", true, ts.ScriptKind.TS],
    ['class static computed satisfies string', "class Example { static ['captureProcessOwnerIdentity' satisfies string]() {} }", true, ts.ScriptKind.TS],
    ['class static computed non-null string', "class Example { static ['captureProcessOwnerIdentity'!]() {} }", true, ts.ScriptKind.TS],
    ['class property', 'class Example { captureProcessOwnerIdentity = null; }', true],
    ['class static string property', "class Example { static 'captureProcessOwnerIdentity' = null; }", true],
    ['class getter', 'class Example { get captureProcessOwnerIdentity() { return null; } }', true],
    ['object method', '({ captureProcessOwnerIdentity() {} });', true],
    ['object property', '({ captureProcessOwnerIdentity: null });', true],
    ['object string property', "({ 'captureProcessOwnerIdentity': null });", true],
    ['object computed property', "({ ['captureProcessOwnerIdentity']: null });", true],
    ['object computed wrapped template', '({ [(`captureProcessOwnerIdentity`)]: null });', true],
    ['object computed wrapped as string', "({ [('captureProcessOwnerIdentity' as string)]: null });", true, ts.ScriptKind.TS],
    ['dynamic computed method', 'class Example { static [owner]() {} }', false],
    ['dynamic computed property', '({ [owner]: null });', false],
    ['dynamic wrapped computed method', 'class Example { static [(owner)]() {} }', false],
    ['dynamic as computed property', '({ [owner as string]: null });', false, ts.ScriptKind.TS],
    ['dynamic satisfies computed method', 'class Example { static [owner satisfies string]() {} }', false, ts.ScriptKind.TS],
    ['dynamic non-null computed property', '({ [owner!]: null });', false, ts.ScriptKind.TS],
  ];
  for (const [label, source, expected, scriptKind] of methodControls) {
    assert.equal(declaredNames(parse(source, scriptKind)).includes('captureProcessOwnerIdentity'), expected, label);
  }

  const declaringFiles = sourceFiles(path.join(root, 'src'))
    .filter(filePath => declaredNames(parse(fs.readFileSync(filePath, 'utf8'))).includes('captureProcessOwnerIdentity'))
    .map(filePath => path.relative(root, filePath));
  assert.deepEqual(declaringFiles, [path.relative(root, ownerPath)]);

  const stateAst = parse(fs.readFileSync(statePath, 'utf8'));
  const imports = stateAst.statements.filter(statement => ts.isVariableStatement(statement)
    && strip(statement.getText(stateAst)) === "const{captureProcessOwnerIdentity}=require('./state/process-owner-capture');");
  assert.equal(imports.length, 1);
  const facade = [];
  walk(stateAst, node => {
    if (ts.isMethodDeclaration(node) && node.name.getText(stateAst) === 'directPostOwnerIdentity') facade.push(node);
  });
  assert.equal(facade.length, 1);
  assert.equal(strip(facade[0].body.getText(stateAst)), '{returncaptureProcessOwnerIdentity.apply(this,arguments);}');

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
