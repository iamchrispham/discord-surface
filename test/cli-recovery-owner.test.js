'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const DEFAULT_SRC_ROOT = path.resolve(__dirname, '..', 'src');
const SRC_ROOT = process.env.RECOVERY_OWNER_SRC_ROOT
  ? path.resolve(process.env.RECOVERY_OWNER_SRC_ROOT)
  : DEFAULT_SRC_ROOT;
const CLI_PATH = path.join(SRC_ROOT, 'cli.js');
const COMPANION_PATH = path.join(SRC_ROOT, 'cli', 'recovery-commands.js');

const FACTORY_NAME = 'createRecoveryCommands';
const HANDLER_NAMES = ['recoverCourier', 'recover'];
const FACTORY_DEPENDENCIES = [
  'required',
  'openState',
  'print',
  'gatewayProcessStatus',
  'requestGatewayRecovery',
  'GATEWAY_CAPABILITIES'
];

function parseFile(filePath) {
  const kind = filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true, kind);
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, child => visit(child, callback));
}

function functionDeclarations(node, names) {
  const found = [];
  visit(node, current => {
    if (ts.isFunctionDeclaration(current) && current.name && names.has(current.name.text)) found.push(current);
  });
  return found;
}

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

function switchCaseReturnCall(clause, caseName) {
  const expression = clause.expression;
  if (!expression || !ts.isStringLiteral(expression) || expression.text !== caseName) return null;
  if (clause.statements.length !== 1) return null;
  const statement = clause.statements[0];
  if (!ts.isReturnStatement(statement) || !statement.expression) return null;
  const call = statement.expression;
  if (!ts.isCallExpression(call)) return null;
  if (!ts.isIdentifier(call.expression)) return null;
  if (call.arguments.length !== 1 || !ts.isIdentifier(call.arguments[0]) || call.arguments[0].text !== 'args') return null;
  return call.expression.text;
}

function factoryCalls(sourceFile) {
  const calls = [];
  visit(sourceFile, node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === FACTORY_NAME) calls.push(node);
  });
  return calls;
}

function censusCliFiles() {
  const cliDir = path.join(SRC_ROOT, 'cli');
  return fs.readdirSync(cliDir)
    .filter(entry => entry.endsWith('.js'))
    .map(entry => path.join(cliDir, entry));
}

test('recovery command ownership', () => {
  const cliSource = parseFile(CLI_PATH);
  const companionSource = parseFile(COMPANION_PATH);

  const cliDeclarations = functionDeclarations(cliSource, new Set(HANDLER_NAMES));
  assert.deepEqual(cliDeclarations.map(declaration => declaration.name.text), [],
    'src/cli.js must not declare recovery handlers');

  const factories = functionDeclarations(companionSource, new Set([FACTORY_NAME]));
  assert.equal(factories.length, 1, `expected exactly one ${FACTORY_NAME} declaration`);
  const factory = factories[0];
  const nested = factory.body.statements.filter(ts.isFunctionDeclaration)
    .filter(declaration => HANDLER_NAMES.includes(declaration.name?.text));
  const companionDeclarations = functionDeclarations(companionSource, new Set(HANDLER_NAMES));
  assert.deepEqual(companionDeclarations, nested, 'handlers must occur only directly inside the factory');
  for (const sourcePath of [CLI_PATH, ...censusCliFiles()]) {
    if (sourcePath === COMPANION_PATH) continue;
    assert.equal(functionDeclarations(parseFile(sourcePath), new Set(HANDLER_NAMES)).length, 0,
      `recovery handlers must not be declared in ${path.relative(SRC_ROOT, sourcePath)}`);
  }
  assert.deepEqual(nested.map(declaration => declaration.name.text), HANDLER_NAMES,
    'companion must nest one declaration of each handler in order');

  const returns = factory.body.statements.filter(statement => ts.isReturnStatement(statement));
  assert.equal(returns.length, 1, 'factory must end with exactly one top-level return');
  const returned = returns[0].expression;
  assert.ok(ts.isObjectLiteralExpression(returned), 'factory return must be an object literal');
  assert.ok(returned.properties.every(property => ts.isShorthandPropertyAssignment(property)),
    'factory return properties must be shorthand identifiers');
  assert.deepEqual(returned.properties.map(property => property.name.text), HANDLER_NAMES,
    'factory return must list exactly the two handlers in order');

  const calls = factoryCalls(cliSource);
  assert.equal(calls.length, 1, `src/cli.js must call ${FACTORY_NAME} exactly once`);
  const call = calls[0];
  assert.equal(call.arguments.length, 1, `${FACTORY_NAME} must receive one dependency object`);
  const dependencyArgument = call.arguments[0];
  assert.ok(ts.isObjectLiteralExpression(dependencyArgument), `${FACTORY_NAME} dependencies must be an object literal`);
  assert.deepEqual(dependencyArgument.properties.map(property => property.name.getText(cliSource)).sort(),
    [...FACTORY_DEPENDENCIES].sort(), `${FACTORY_NAME} must receive all six facade dependencies`);
  const declaration = call.parent;
  assert.ok(ts.isVariableDeclaration(declaration) && ts.isObjectBindingPattern(declaration.name),
    `${FACTORY_NAME} result must be destructured into bindings`);
  assert.deepEqual(declaration.name.elements.map(element => element.name.text), HANDLER_NAMES,
    'facade must bind recoverCourier and recover from the factory');
  const cliExports = moduleExportsProperties(cliSource).map(property => property.name.getText(cliSource));
  assert.ok(cliExports.includes('recoverCourier'), 'src/cli.js module.exports must list recoverCourier');
  assert.ok(!cliExports.includes('recover'), 'src/cli.js module.exports must not list recover');

  let dispatched = null;
  visit(cliSource, node => {
    if (!ts.isSwitchStatement(node)) return;
    for (const clause of node.caseBlock.clauses) {
      const callee = switchCaseReturnCall(clause, 'recover');
      if (callee !== null) dispatched = callee;
    }
  });
  assert.equal(dispatched, 'recover', "case 'recover' must return recover(args)");

  const companionExports = moduleExportsProperties(companionSource);
  assert.equal(companionExports.length, 1, 'companion must export exactly one property');
  assert.ok(ts.isShorthandPropertyAssignment(companionExports[0]), 'companion export must be the factory identifier');
  assert.equal(companionExports[0].name.text, FACTORY_NAME, `companion must export only ${FACTORY_NAME}`);
  const isFacadeTarget = candidate =>
    candidate === CLI_PATH || `${candidate}.js` === CLI_PATH;
  visit(companionSource, node => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'require') return;
    const argument = node.arguments[0];
    assert.ok(argument && ts.isStringLiteral(argument),
      'companion must require only string-literal specifiers (computed specifier found)');
    const resolved = path.resolve(path.dirname(COMPANION_PATH), argument.text);
    assert.ok(!isFacadeTarget(resolved),
      `companion must not require the CLI facade (found require('${argument.text}'))`);
  });
});
