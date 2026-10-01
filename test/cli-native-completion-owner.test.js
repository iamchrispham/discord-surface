'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const CLI_PATH = path.join(SRC_ROOT, 'cli.js');
const COMPANION_PATH = path.join(SRC_ROOT, 'cli', 'native-completion-commands.js');

const FACTORY_NAME = 'createNativeCompletionCommands';
const HANDLER_NAMES = ['nativeReply', 'claudeReply', 'agentComplete', 'agentWithdraw'];

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

// `case '<name>': return handler(args);` matched structurally, never as source text.
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

test('native completion command ownership', () => {
  const cliSource = parseFile(CLI_PATH);
  const companionSource = parseFile(COMPANION_PATH);

  // (a) src/cli.js owns none of the four handler declarations.
  const cliDeclarations = functionDeclarations(cliSource, new Set(HANDLER_NAMES));
  assert.deepEqual(cliDeclarations.map(declaration => declaration.name.text), [],
    'src/cli.js must not declare native completion handlers');

  // (b) the companion nests exactly one declaration of each handler, in order.
  const factories = functionDeclarations(companionSource, new Set([FACTORY_NAME]));
  assert.equal(factories.length, 1, `expected exactly one ${FACTORY_NAME} declaration`);
  const factory = factories[0];
  const nested = functionDeclarations(factory, new Set(HANDLER_NAMES));
  assert.deepEqual(nested.map(declaration => declaration.name.text), HANDLER_NAMES,
    'companion must nest one declaration of each handler in order');

  // (c) the factory's final ReturnStatement returns exactly the four shorthand identifiers.
  const returns = factory.body.statements.filter(statement => ts.isReturnStatement(statement));
  assert.equal(returns.length, 1, 'factory must end with exactly one top-level return');
  const returned = returns[0].expression;
  assert.ok(ts.isObjectLiteralExpression(returned), 'factory return must be an object literal');
  assert.ok(returned.properties.every(property => ts.isShorthandPropertyAssignment(property)),
    'factory return properties must be shorthand identifiers');
  assert.deepEqual(returned.properties.map(property => property.name.text), HANDLER_NAMES,
    'factory return must list exactly the four handlers in order');

  // (d) src/cli.js module.exports still re-exports all four handlers.
  const cliExports = moduleExportsProperties(cliSource).map(property => property.name.getText(cliSource));
  for (const name of HANDLER_NAMES) {
    assert.ok(cliExports.includes(name), `src/cli.js module.exports must list ${name}`);
  }

  // (e) the main switch still dispatches each case to the handler call with args.
  const expectedDispatch = new Map([
    ['native-reply', 'nativeReply'],
    ['claude-reply', 'claudeReply'],
    ['agent-complete', 'agentComplete'],
    ['agent-withdraw', 'agentWithdraw']
  ]);
  const dispatch = new Map();
  visit(cliSource, node => {
    if (!ts.isSwitchStatement(node)) return;
    for (const clause of node.caseBlock.clauses) {
      for (const [caseName, handlerName] of expectedDispatch) {
        const callee = switchCaseReturnCall(clause, caseName);
        if (callee !== null) dispatch.set(caseName, callee);
      }
    }
  });
  for (const [caseName, handlerName] of expectedDispatch) {
    assert.equal(dispatch.get(caseName), handlerName, `case '${caseName}' must call ${handlerName}(args)`);
  }

  // (f) the companion's unique export is the factory.
  const companionExports = moduleExportsProperties(companionSource);
  assert.equal(companionExports.length, 1, 'companion must export exactly one property');
  assert.ok(ts.isShorthandPropertyAssignment(companionExports[0]), 'companion export must be the factory identifier');
  assert.equal(companionExports[0].name.text, FACTORY_NAME, `companion must export only ${FACTORY_NAME}`);
});
