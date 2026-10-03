'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const sourceRoot = process.env.BOARD_COMMAND_SRC_ROOT || path.resolve(__dirname, '../src');
const ownerPath = path.join(sourceRoot, 'cli/board-refresh-commands.js');
function parse(file) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}
function find(tree, predicate) {
  const found = [];
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(tree);
  return found;
}
function declares(node, name) {
  return (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
    (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name &&
      node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)));
}
test('board refresh handler has one command owner', () => {
  const files = [path.join(sourceRoot, 'cli.js'), ...fs.readdirSync(path.join(sourceRoot, 'cli'))
    .filter(name => name.endsWith('.js')).map(name => path.join(sourceRoot, 'cli', name))];
  for (const file of files) {
    const handlers = find(parse(file), node => declares(node, 'boardRefresh'));
    assert.equal(handlers.length, file === ownerPath ? 1 : 0, `unexpected board handler in ${file}`);
  }
  const tree = parse(ownerPath);
  const factories = find(tree, node => declares(node, 'createBoardRefreshCommands'));
  assert.equal(factories.length, 1);
  const factory = factories[0];
  assert.ok(ts.isObjectBindingPattern(factory.parameters[0].name));
  assert.deepEqual(factory.parameters[0].name.elements.map(item => item.name.text), ['required', 'openState', 'print']);
  assert.equal(factory.body.statements.filter(node => declares(node, 'boardRefresh')).length, 1);
});
test('board refresh command preserves public dispatch and dependencies', () => {
  const tree = parse(path.join(sourceRoot, 'cli.js'));
  const calls = find(tree, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === 'createBoardRefreshCommands');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].arguments.length, 1);
  assert.ok(ts.isObjectLiteralExpression(calls[0].arguments[0]));
  assert.deepEqual(calls[0].arguments[0].properties.map(node => node.getText(tree)), ['required', 'openState', 'print']);
  const clauses = find(tree, node => ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'board-refresh');
  assert.equal(clauses.length, 1);
  assert.equal(clauses[0].statements.length, 1);
  assert.equal(clauses[0].statements[0].getText(tree), 'return boardRefresh(args);');
  const exports = find(tree, node => ts.isBinaryExpression(node) && node.left.getText(tree) === 'module.exports');
  assert.equal(exports.length, 1);
  assert.ok(ts.isObjectLiteralExpression(exports[0].right));
  assert.equal(exports[0].right.properties.filter(node => node.getText(tree) === 'boardRefresh').length, 1);
});
