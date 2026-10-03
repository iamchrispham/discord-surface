'use strict';

// Packet field ownership pin: both public packet codecs must decide "is this a
// required own data property?" through one exported data-property owner
// (agent-message.ts), never through a bare Object.hasOwn existence check that a
// getter or an inherited property could satisfy. This is a static source
// inventory; it does not execute the codecs.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const AGENT_OWNER = 'src/agent-message.ts';
const WATCHER_OWNER = 'src/watcher-notice.ts';
const OWNER_FILES = [AGENT_OWNER, WATCHER_OWNER];

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, child => visit(child, callback));
}

function parseSource(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const kind = file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

// Named function declarations and variable-declared arrow/function expressions.
function declarationsNamed(sourceFile, name) {
  const found = [];
  visit(sourceFile, node => {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === name) {
      found.push(node);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === name && node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      found.push(node);
    }
  });
  return found;
}

function bodyOf(declaration) {
  return ts.isFunctionDeclaration(declaration) ? declaration.body : declaration.initializer.body;
}

function callsTo(node, objectName, methodName) {
  const found = [];
  visit(node, current => {
    if (!ts.isCallExpression(current)) return;
    const callee = current.expression;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) &&
      callee.expression.text === objectName && callee.name.text === methodName) {
      found.push(current);
    }
  });
  return found;
}

function callsNamed(node, name) {
  let found = false;
  visit(node, current => {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) &&
      current.expression.text === name) found = true;
  });
  return found;
}

// git ls-files src, unioned with the two explicit codec owners so the pin still
// inventories them if a checkout ever omits tracked source.
function productionInventory() {
  const listed = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(line => line.trim()).filter(Boolean);
  const files = [...new Set([...listed, ...OWNER_FILES])]
    .filter(file => /\.(?:js|ts)$/.test(file));
  return files.map(file => ({ file, sourceFile: parseSource(file) }));
}

function exactKeysDeclarations(inventory, file) {
  const entry = inventory.find(item => item.file === file);
  return entry ? declarationsNamed(entry.sourceFile, 'exactKeys') : [];
}

test('required packet field checks use one data-property owner', () => {
  const inventory = productionInventory();
  const files = inventory.map(item => item.file);

  // (a) Production inventory is collected from tracked src plus both codec owners.
  assert.ok(files.includes(AGENT_OWNER), 'inventory includes the agent codec owner');
  assert.ok(files.includes(WATCHER_OWNER), 'inventory includes the watcher codec owner');
  assert.ok(inventory.every(item => item.sourceFile.text.length > 0), 'every inventoried source is non-empty');

  // (b) exactKeys exists exactly twice in all of src: once per codec owner.
  const exactKeysByFile = inventory
    .map(item => ({ file: item.file, count: declarationsNamed(item.sourceFile, 'exactKeys').length }))
    .filter(entry => entry.count > 0);
  assert.equal(exactKeysByFile.reduce((total, entry) => total + entry.count, 0), 2,
    'exactly two exactKeys declarations in src');
  assert.deepEqual(exactKeysByFile.map(entry => entry.file).sort(), [...OWNER_FILES].sort(),
    'exactKeys is declared only in the two codec owners');

  // (c) Exactly one ownDataProperty owner, scoped to the two codec files. The
  // unrelated private ownDataProperty in src/peer/town-hall-plan.ts is ignored.
  const ownerDeclarations = OWNER_FILES.flatMap(file =>
    declarationsNamed(inventory.find(item => item.file === file).sourceFile, 'ownDataProperty')
      .map(declaration => ({ file, declaration })));
  assert.equal(ownerDeclarations.length, 1, 'exactly one ownDataProperty declaration in the codec owners');
  const own = ownerDeclarations[0];
  assert.equal(own.file, AGENT_OWNER, 'ownDataProperty is declared by the agent codec owner');
  assert.ok(own.declaration.modifiers &&
    own.declaration.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword),
    'ownDataProperty is exported so the watcher codec can reuse it');

  const ownBody = bodyOf(own.declaration);
  const descriptorReads = callsTo(ownBody, 'Object', 'getOwnPropertyDescriptor');
  assert.ok(descriptorReads.length >= 1, 'ownDataProperty reads the property descriptor');
  const descriptorNames = new Set();
  visit(ownBody, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      callsTo(node.initializer, 'Object', 'getOwnPropertyDescriptor').length > 0) {
      descriptorNames.add(node.name.text);
    }
  });
  const descriptorValueChecks = callsTo(ownBody, 'Object', 'hasOwn').filter(call =>
    call.arguments.length === 2 && ts.isIdentifier(call.arguments[0]) &&
    descriptorNames.has(call.arguments[0].text) && ts.isStringLiteral(call.arguments[1]) &&
    call.arguments[1].text === 'value');
  assert.ok(descriptorValueChecks.length >= 1,
    "ownDataProperty requires the descriptor's own 'value' slot");

  assert.equal(declarationsNamed(inventory.find(item => item.file === WATCHER_OWNER).sourceFile, 'ownDataProperty').length, 0,
    'the watcher codec declares no ownDataProperty');
  let watcherDescriptorIdentifiers = 0;
  visit(inventory.find(item => item.file === WATCHER_OWNER).sourceFile, node => {
    if (ts.isIdentifier(node) && node.text === 'getOwnPropertyDescriptor') watcherDescriptorIdentifiers += 1;
  });
  assert.equal(watcherDescriptorIdentifiers, 0,
    'the watcher codec defines no data-property inspection');

  // The agent codec's own exactKeys must route its keys.every callback through
  // the same owner, so a revert to a bare Object.hasOwn existence check cannot
  // pass unnoticed.
  const agentExactKeys = exactKeysDeclarations(inventory, AGENT_OWNER);
  assert.equal(agentExactKeys.length, 1, 'agent codec declares exactly one exactKeys');
  let agentExactKeysEvery = null;
  visit(bodyOf(agentExactKeys[0]), node => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'keys' && callee.name.text === 'every') agentExactKeysEvery = node;
  });
  assert.ok(agentExactKeysEvery, 'agent exactKeys keys.every callback is found');
  const agentExactKeysCallback = agentExactKeysEvery.arguments[0];
  let agentExactKeysGatesOwner = false;
  if (agentExactKeysCallback &&
    (ts.isArrowFunction(agentExactKeysCallback) || ts.isFunctionExpression(agentExactKeysCallback))) {
    visit(agentExactKeysCallback, node => {
      if (!ts.isBinaryExpression(node) ||
        node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return;
      for (const operand of [node.left, node.right]) {
        if (callsNamed(operand, 'ownDataProperty')) agentExactKeysGatesOwner = true;
      }
    });
  }
  assert.ok(agentExactKeysGatesOwner, 'agent exactKeys gates its result on ownDataProperty');

  // (d) The watcher codec imports the shared owner and routes exactKeys through it.
  const watcherSource = inventory.find(item => item.file === WATCHER_OWNER).sourceFile;
  let importsOwner = false;
  visit(watcherSource, node => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== './agent-message') return;
    const bindings = node.importClause && node.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      importsOwner = bindings.elements.some(element => element.name.text === 'ownDataProperty');
    }
  });
  assert.ok(importsOwner, "watcher codec imports ownDataProperty from './agent-message'");
  const watcherExactKeys = exactKeysDeclarations(inventory, WATCHER_OWNER);
  assert.equal(watcherExactKeys.length, 1, 'watcher codec declares exactly one exactKeys');
  const watcherExactKeysBody = bodyOf(watcherExactKeys[0]);
  const watcherOwnCalls = [];
  visit(watcherExactKeysBody, node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === 'ownDataProperty') watcherOwnCalls.push(node);
  });
  assert.ok(watcherOwnCalls.length >= 1, 'watcher exactKeys calls ownDataProperty');
  assert.equal(callsTo(watcherExactKeysBody, 'Object', 'hasOwn').length, 0,
    'watcher exactKeys never falls back to Object.hasOwn');

  // (e) validateAgentMessage checks required fields before any value read.
  const agentSource = inventory.find(item => item.file === AGENT_OWNER).sourceFile;
  const validators = declarationsNamed(agentSource, 'validateAgentMessage');
  assert.equal(validators.length, 1, 'agent codec declares exactly one validateAgentMessage');
  const validatorBody = bodyOf(validators[0]);
  const requiredEvery = [];
  visit(validatorBody, node => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression) ||
      callee.expression.text !== 'required' || callee.name.text !== 'every') return;
    const callback = node.arguments[0];
    if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return;
    let callsOwner = false;
    visit(callback, current => {
      if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) &&
        current.expression.text === 'ownDataProperty') callsOwner = true;
    });
    if (callsOwner && callsTo(callback, 'Object', 'hasOwn').length === 0) requiredEvery.push(node);
  });
  assert.equal(requiredEvery.length, 1,
    'validateAgentMessage has one required.every callback that owns the data-property check');
  let firstIdRead = null;
  visit(validatorBody, node => {
    if (firstIdRead !== null) return;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === 'value' && node.name.text === 'id') {
      firstIdRead = node;
    }
  });
  assert.ok(firstIdRead, 'validateAgentMessage reads value.id');
  assert.ok(requiredEvery[0].getStart(agentSource) < firstIdRead.getStart(agentSource),
    'required fields are checked before the first value.id read');

  // (f) The structural pin itself is registered in the npm test file list.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const tokens = pkg.scripts.test.trim().split(/\s+/);
  assert.equal(tokens.filter(token => token === 'test/packet-field-owner.test.js').length, 1,
    'package.json registers the ownership pin exactly once');
  assert.ok(tokens.includes('test/agent-message.test.js'), 'agent codec suite stays registered');
  assert.ok(tokens.includes('test/watcher-notice.test.js'), 'watcher codec suite stays registered');
});
