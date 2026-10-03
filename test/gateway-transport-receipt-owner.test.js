'use strict';

// Structural ownership contract for the Gateway transport-receipt sender.
// The public DiscordGateway.sendTransportReceipt method must be a thin
// delegation to the single exported owner function that holds the moved body.
// Parsed with the TypeScript AST only; the source root is overridable so the
// same test can be pointed at scratch copies for red controls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const OWNER_NAME = 'sendGatewayTransportReceipt';
const PUBLIC_METHOD = 'sendTransportReceipt';
const FACADE_EXPORT = 'createTransportReceiptDelivery';
const SRC_ROOT = process.env.GATEWAY_TRANSPORT_RECEIPT_SRC_ROOT
  ? path.resolve(process.env.GATEWAY_TRANSPORT_RECEIPT_SRC_ROOT)
  : path.resolve(__dirname, '..', 'src');
const FACADE_FILE = path.join(SRC_ROOT, 'discord.js');
const OWNER_FILE = path.join(SRC_ROOT, 'discord', 'transport-receipts.js');

function parse(file) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}

function sourceFilesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function gatewaySourceFiles() {
  return [FACADE_FILE, ...sourceFilesUnder(path.join(SRC_ROOT, 'discord'))];
}

function classMethods(source, className) {
  const methods = [];
  walk(source, node => {
    if (!ts.isClassDeclaration(node) || !node.name || node.name.text !== className) return;
    for (const member of node.members) {
      if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) methods.push(member);
    }
  });
  return methods;
}

function isRequireCall(node, resolveFrom) {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'require') return null;
  const [specifier] = node.arguments;
  if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) return null;
  return path.resolve(path.dirname(resolveFrom), specifier.text).replace(/\.js$/, '');
}

test('Gateway receipt transport is delegated to the single receipt owner', () => {
  const facade = parse(FACADE_FILE);
  const methods = classMethods(facade, 'DiscordGateway').filter(method => method.name.text === PUBLIC_METHOD);
  assert.equal(methods.length, 1, `${PUBLIC_METHOD} must be declared exactly once on DiscordGateway`);
  const method = methods[0];
  assert.equal(method.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword), true,
    `${PUBLIC_METHOD} must stay async`);
  assert.deepEqual(method.parameters.map(parameter => parameter.name.getText()), ['message', 'receipt'],
    `${PUBLIC_METHOD} must keep its message and receipt parameters`);

  // The public method body is only `return await sendGatewayTransportReceipt(...)`.
  assert.ok(method.body && ts.isBlock(method.body), `${PUBLIC_METHOD} must have a block body`);
  assert.equal(method.body.statements.length, 1, `${PUBLIC_METHOD} must contain no receipt send body`);
  const [statement] = method.body.statements;
  assert.ok(ts.isReturnStatement(statement) && statement.expression && ts.isAwaitExpression(statement.expression),
    `${PUBLIC_METHOD} must return-await the owner call`);
  const call = statement.expression.expression;
  assert.ok(ts.isCallExpression(call), `${PUBLIC_METHOD} must call the owner`);
  assert.ok(ts.isIdentifier(call.expression) && call.expression.text === OWNER_NAME,
    `${PUBLIC_METHOD} must call ${OWNER_NAME}`);
  assert.equal(call.arguments.length, 4, `${OWNER_NAME} must receive exactly four arguments`);
  assert.equal(call.arguments[0].kind, ts.SyntaxKind.ThisKeyword, 'the live Gateway receiver must be passed as this');
  assert.deepEqual(call.arguments.slice(1).map(argument => argument.getText()),
    ['message', 'receipt', 'waitForRecoveryOperation'],
    'the owner must receive message, receipt, and the facade deadline helper');

  // Exactly one declaration of the owner function across the facade and src/discord.
  const declarations = [];
  for (const file of gatewaySourceFiles()) {
    const source = parse(file);
    walk(source, node => {
      if (ts.isFunctionDeclaration(node) && node.name && node.name.text === OWNER_NAME && node.body) {
        declarations.push(file);
      }
    });
  }
  assert.deepEqual(declarations.map(file => path.resolve(file)), [path.resolve(OWNER_FILE)],
    `${OWNER_NAME} must be declared exactly once, in ${OWNER_FILE}`);

  // The existing consumer export is preserved and the new owner export shares its module.
  const owner = parse(OWNER_FILE);
  const ownerDeclarations = [];
  walk(owner, node => {
    if (ts.isFunctionDeclaration(node) && node.name) ownerDeclarations.push(node.name.text);
  });
  assert.ok(ownerDeclarations.includes(FACADE_EXPORT), `${FACADE_EXPORT} must remain declared in the owner module`);
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
  assert.ok(exportedNames.includes(FACADE_EXPORT), `${FACADE_EXPORT} must stay exported from the owner module`);
  assert.ok(exportedNames.includes(OWNER_NAME), `${OWNER_NAME} must be exported from the owner module`);

  // The owner must not import the facade.
  const facadeModule = FACADE_FILE.replace(/\.js$/, '');
  const forbidden = [];
  walk(owner, node => {
    const resolved = isRequireCall(node, OWNER_FILE);
    if (resolved && resolved === facadeModule) forbidden.push(node.getText());
  });
  assert.deepEqual(forbidden, [], 'the owner must not require the Gateway facade');
});
