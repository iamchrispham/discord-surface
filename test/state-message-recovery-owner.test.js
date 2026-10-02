'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(ROOT, 'src');
const STATE_PATH = path.join(SRC_ROOT, 'state.js');
const OWNER_PATH = path.join(SRC_ROOT, 'state', 'message-recovery.js');
const OWNER_RELATIVE = path.join('src', 'state', 'message-recovery.js');

const FACTORY_NAME = 'createMessageRecoveryHandlers';
const BINDING_NAME = 'messageRecoveryHandlers';
const HANDLER_NAMES = ['recoverAfterRestart', 'recoveryCandidates', 'reconcileUncertain'];
const DEPENDENCIES = [
  'boardRefreshHandlers',
  'topicPublicationHandlers',
  'decisionHandlers',
  'courierRouteHandlers',
  'MESSAGE_STATES',
  'COURIER_OUTCOMES',
  'COURIER_RECEIPT_KINDS',
  'TRANSPORT_RECEIPT_OUTCOME',
  'TRANSPORT_RECEIPT_ATTEMPT',
  'INTERACTION_TRANSPORT',
  'parseJson',
  'now',
  'BindingError'
];

function parseFile(filePath) {
  const kind = filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true, kind);
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, child => visit(child, callback));
}

function namedFunctionDeclarations(node, names) {
  const found = [];
  visit(node, current => {
    if (ts.isFunctionDeclaration(current) && current.name && names.has(current.name.text)) found.push(current);
  });
  return found;
}

// The single `module.exports = { ... }` object literal in a file.
function moduleExportsProperties(sourceFile) {
  const assignments = [];
  visit(sourceFile, node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) && node.left.expression.text === 'module' &&
      node.left.name.text === 'exports' &&
      ts.isObjectLiteralExpression(node.right)) {
      assignments.push(node.right);
    }
  });
  assert.equal(assignments.length, 1, 'expected exactly one module.exports object literal');
  return assignments[0].properties;
}

// The name a declaration binds, accepting identifiers, string-literal names
// (`"name"() {}`) and computed string-literal names (`["name"]() {}`).
function declaredName(node) {
  if (!node.name) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  if (ts.isComputedPropertyName(node.name) && ts.isStringLiteral(node.name.expression)) return node.name.expression.text;
  return null;
}

function isFunctionValue(node) {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

// A recoverable implementation shape: method/accessor declaration, class field
// arrow/function, function declaration, function/arrow property or variable
// assignment, function/arrow property-access assignment, or an
// Object.defineProperty(...) descriptor carrying a function/arrow value.
function isMethodImplementationNamed(node, names) {
  if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node) || ts.isFunctionDeclaration(node)) {
    const name = declaredName(node);
    return name !== null && names.has(name);
  }
  if (ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) {
    const name = declaredName(node);
    return name !== null && names.has(name) && Boolean(node.initializer) && isFunctionValue(node.initializer);
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.has(node.name.text) &&
    node.initializer && isFunctionValue(node.initializer)) return true;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.name) && names.has(node.left.name.text) &&
    isFunctionValue(node.right)) return true;
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Object' &&
    node.expression.name.text === 'defineProperty' && node.arguments.length >= 3 &&
    ts.isStringLiteral(node.arguments[1]) && names.has(node.arguments[1].text) &&
    ts.isObjectLiteralExpression(node.arguments[2])) {
    return node.arguments[2].properties.some(property =>
      ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'value' &&
      isFunctionValue(property.initializer));
  }
  return false;
}

function methodImplementationsNamed(node, names) {
  const found = [];
  visit(node, current => {
    if (isMethodImplementationNamed(current, names)) found.push(current);
  });
  return found;
}

function bindingPatternNames(bindingPattern, sourceFile) {
  assert.ok(ts.isObjectBindingPattern(bindingPattern), 'expected an object binding pattern');
  return bindingPattern.elements.map(element => {
    assert.ok(ts.isBindingElement(element), 'expected a binding element');
    assert.ok(!element.propertyName, 'destructured dependency list must not rename bindings');
    assert.ok(ts.isIdentifier(element.name), 'destructured dependency must be a plain identifier');
    return element.name.text;
  });
}

function propertyNames(objectLiteral) {
  return objectLiteral.properties.map(property => {
    assert.ok(ts.isIdentifier(property.name), 'expected an identifier property name');
    return property.name.text;
  });
}

// `const messageRecoveryHandlers = createMessageRecoveryHandlers({ ... });`
function recoveryBinding(sourceFile) {
  const bindings = [];
  visit(sourceFile, node => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== BINDING_NAME) return;
    assert.ok(node.initializer, `${BINDING_NAME} binding must have an initializer`);
    assert.ok(ts.isCallExpression(node.initializer), `${BINDING_NAME} must be bound to a factory call`);
    const call = node.initializer;
    assert.ok(ts.isIdentifier(call.expression) && call.expression.text === FACTORY_NAME,
      `${BINDING_NAME} must be bound via ${FACTORY_NAME}`);
    assert.equal(call.arguments.length, 1, `${FACTORY_NAME} binding must pass exactly one dependency object`);
    assert.ok(ts.isObjectLiteralExpression(call.arguments[0]), 'dependency argument must be an object literal');
    bindings.push(call.arguments[0]);
  });
  assert.equal(bindings.length, 1, `expected exactly one ${BINDING_NAME} binding`);
  return bindings[0];
}

function surfaceStateClass(sourceFile) {
  const classes = [];
  visit(sourceFile, node => {
    if (ts.isClassDeclaration(node) && node.name && node.name.text === 'SurfaceState') classes.push(node);
  });
  assert.equal(classes.length, 1, 'expected exactly one SurfaceState class declaration');
  return classes[0];
}

function wrapperMethod(classNode, name) {
  const methods = classNode.members.filter(member =>
    ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name) && member.name.text === name);
  assert.equal(methods.length, 1, `SurfaceState must contain exactly one ${name} wrapper`);
  return methods[0];
}

function assertWrapper(method, name, parameterNames, sourceFile) {
  const parameters = method.parameters;
  assert.equal(parameters.length, parameterNames.length, `${name} must declare exactly ${parameterNames.length} parameters`);
  for (let index = 0; index < parameterNames.length; index += 1) {
    const parameter = parameters[index];
    assert.ok(ts.isIdentifier(parameter.name), `${name} parameter must be a plain identifier`);
    assert.equal(parameter.name.text, parameterNames[index], `${name} parameter ${index} name`);
  }
  const expectedDefaults = parameters.map(parameter => parameter.initializer ? parameter.initializer.getText(sourceFile) : null);
  assert.deepEqual(expectedDefaults, parameterNames.map((parameterName, index) =>
    (parameterName === 'ownerAlive' || parameterName === 'before') ? 'null' : null),
  `${name} must preserve its parameter defaults`);

  const statements = method.body.statements;
  assert.equal(statements.length, 1, `${name} wrapper body must contain exactly one statement`);
  const statement = statements[0];
  assert.ok(ts.isReturnStatement(statement), `${name} wrapper body must be a return`);
  const call = statement.expression;
  assert.ok(call && ts.isCallExpression(call), `${name} wrapper body must return a call`);
  const callee = call.expression;
  assert.ok(ts.isPropertyAccessExpression(callee), `${name} wrapper must return a property call`);
  assert.equal(callee.name.text, 'apply', `${name} wrapper must use .apply`);
  const target = callee.expression;
  assert.ok(ts.isPropertyAccessExpression(target), `${name} wrapper must call messageRecoveryHandlers.<name>.apply`);
  assert.ok(ts.isIdentifier(target.expression) && target.expression.text === BINDING_NAME,
    `${name} wrapper must call through the ${BINDING_NAME} binding`);
  assert.equal(target.name.text, name, `${name} wrapper must call its own method`);
  assert.equal(call.arguments.length, 2, `${name} wrapper .apply must receive exactly two arguments`);
  assert.ok(ts.isThis(call.arguments[0]), `${name} wrapper apply first argument must be this`);
  assert.ok(ts.isIdentifier(call.arguments[1]) && call.arguments[1].text === 'arguments',
    `${name} wrapper apply second argument must be arguments`);
}

test('message recovery handler ownership', () => {
  const stateSource = parseFile(STATE_PATH);
  const ownerSource = parseFile(OWNER_PATH);

  // (a) the owner module exports only the factory, and has no imports.
  const ownerExports = moduleExportsProperties(ownerSource);
  assert.equal(ownerExports.length, 1, 'owner module must export exactly one property');
  assert.ok(ts.isShorthandPropertyAssignment(ownerExports[0]), 'owner export must be the factory identifier');
  assert.equal(ownerExports[0].name.text, FACTORY_NAME, `owner module must export only ${FACTORY_NAME}`);
  let ownerImports = 0;
  let ownerRequires = 0;
  visit(ownerSource, node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) ownerImports += 1;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') ownerRequires += 1;
  });
  assert.equal(ownerImports, 0, 'owner module must not use import/export declarations');
  assert.equal(ownerRequires, 0, 'owner module must not call require');
  const ownerDeclarations = namedFunctionDeclarations(ownerSource, new Set([FACTORY_NAME]));
  assert.equal(ownerDeclarations.length, 1, `expected exactly one ${FACTORY_NAME} declaration`);
  const factory = ownerDeclarations[0];

  // (b) the factory destructures exactly the 13 dependencies, in order, without renames.
  assert.equal(factory.parameters.length, 1, `${FACTORY_NAME} must take exactly one parameter`);
  const factoryDependencies = bindingPatternNames(factory.parameters[0].name, ownerSource);
  assert.deepEqual(factoryDependencies, DEPENDENCIES, `${FACTORY_NAME} dependency list must be exactly the 13 names`);

  // (c) the factory returns an object literal with exactly the three methods, in order.
  const factoryReturns = factory.body.statements.filter(statement => ts.isReturnStatement(statement));
  assert.equal(factoryReturns.length, 1, `${FACTORY_NAME} must have exactly one top-level return`);
  const returned = factoryReturns[0].expression;
  assert.ok(ts.isObjectLiteralExpression(returned), `${FACTORY_NAME} must return an object literal`);
  const returnedHandlers = methodImplementationsNamed(returned, new Set(HANDLER_NAMES));
  assert.equal(returnedHandlers.length, 3, `${FACTORY_NAME} return must nest exactly three handlers`);
  assert.deepEqual(returnedHandlers.map(method => method.name.text), HANDLER_NAMES,
    `${FACTORY_NAME} return must list exactly the three handlers in order`);
  assert.deepEqual(returned.properties.map(property => property.name && property.name.text), HANDLER_NAMES,
    `${FACTORY_NAME} return object must contain only the three handler properties`);
  for (const handler of returnedHandlers) {
    const nested = handler.body ? methodImplementationsNamed(handler.body, new Set(HANDLER_NAMES)) : [];
    assert.equal(nested.length, 0,
      `${handler.name.text} must not contain a nested handler implementation`);
  }

  // (d) state.js binds the factory with exactly the 13 dependencies, in order.
  const binding = recoveryBinding(stateSource);
  assert.deepEqual(propertyNames(binding), DEPENDENCIES,
    `${BINDING_NAME} must be bound with exactly the 13 dependencies in order`);

  // (e) state.js wrappers survive with their parameter defaults and one-line bodies.
  const stateClass = surfaceStateClass(stateSource);
  const stateImplementations = methodImplementationsNamed(stateClass, new Set(HANDLER_NAMES));
  assert.deepEqual(stateImplementations.map(method => method.name.text), HANDLER_NAMES,
    'SurfaceState must contain exactly the three wrappers in order');
  assertWrapper(wrapperMethod(stateClass, 'recoverAfterRestart'), 'recoverAfterRestart', ['ownerAlive'], stateSource);
  assertWrapper(wrapperMethod(stateClass, 'recoveryCandidates'), 'recoveryCandidates', ['before'], stateSource);
  assertWrapper(wrapperMethod(stateClass, 'reconcileUncertain'), 'reconcileUncertain', ['messageId', 'resolution'], stateSource);

  // (f) census every git-tracked src .js/.ts file (plus the untracked-in-progress
  // owner module and any other untracked src file, so a new sibling cannot hide):
  // each handler is implemented exactly three times in state.js and three times
  // in the owner module, and nowhere else.
  const gitList = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const tracked = gitList(['ls-files', 'src']);
  const untracked = gitList(['ls-files', '--others', '--exclude-standard', 'src']);
  assert.ok(tracked.length > 0, 'git ls-files src must return tracked files');
  const scanned = [...new Set([...tracked, ...untracked, 'src/state.js', OWNER_RELATIVE.split(path.sep).join('/')])]
    .filter(relativePath => /\.(?:js|ts)$/.test(relativePath));
  const census = new Map();
  for (const relativePath of scanned) {
    const counts = methodImplementationsNamed(parseFile(path.join(ROOT, relativePath)), new Set(HANDLER_NAMES));
    if (counts.length > 0) census.set(relativePath, counts.map(method => method.name.text));
  }
  assert.deepEqual([...census.keys()].sort(), ['src/state.js', OWNER_RELATIVE.split(path.sep).join('/')].sort(),
    'the three handlers must be implemented only in src/state.js and the owner module');
  assert.equal(census.get('src/state.js').length, 3, 'src/state.js must implement the three handlers exactly three times');
  assert.equal(census.get('src/state/message-recovery.js').length, 3,
    'src/state/message-recovery.js must implement the three handlers exactly three times');
  for (const name of HANDLER_NAMES) {
    assert.equal(census.get('src/state.js').filter(entry => entry === name).length, 1,
      `src/state.js must implement ${name} exactly once (the wrapper)`);
    assert.equal(census.get('src/state/message-recovery.js').filter(entry => entry === name).length, 1,
      `src/state/message-recovery.js must implement ${name} exactly once`);
  }
});
