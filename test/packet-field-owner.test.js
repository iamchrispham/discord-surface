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
  return parseSourceText(file, text);
}

function parseSourceText(file, text) {
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

function assertNonemptyCodecSources(inventory) {
  const codecInventory = inventory.filter(item => OWNER_FILES.includes(item.file));
  assert.ok(codecInventory.every(item => item.sourceFile.text.length > 0),
    'codec owner sources are non-empty');
}

function exactKeysDeclarations(inventory, file) {
  const entry = inventory.find(item => item.file === file);
  return entry ? declarationsNamed(entry.sourceFile, 'exactKeys') : [];
}

function assertExactKeysOwnerPin(inventory) {
  const exactKeysByFile = OWNER_FILES
    .map(file => ({ file, count: exactKeysDeclarations(inventory, file).length }))
    .filter(entry => entry.count > 0);
  assert.equal(exactKeysByFile.reduce((total, entry) => total + entry.count, 0), 2,
    'exactly two exactKeys declarations in the codec owners');
  assert.deepEqual(exactKeysByFile.map(entry => entry.file).sort(), [...OWNER_FILES].sort(),
    'exactKeys is declared only in the two codec owners');
}

test('exactKeys ownership pin ignores unrelated helpers but rejects codec duplicates', () => {
  const codecInventory = productionInventory().filter(item => OWNER_FILES.includes(item.file));
  const unrelated = {
    file: 'src/unrelated-helper.ts',
    sourceFile: parseSourceText('src/unrelated-helper.ts', 'const exactKeys = () => true;')
  };
  assert.doesNotThrow(() => assertExactKeysOwnerPin([...codecInventory, unrelated]));

  const duplicateAgent = {
    file: AGENT_OWNER,
    sourceFile: parseSourceText(AGENT_OWNER,
      `${fs.readFileSync(path.join(ROOT, AGENT_OWNER), 'utf8')}\nconst exactKeys = () => true;`)
  };
  assert.throws(() => assertExactKeysOwnerPin([
    duplicateAgent,
    codecInventory.find(item => item.file === WATCHER_OWNER)
  ]), /exactly two exactKeys/);
});

test('required packet field checks use one data-property owner', () => {
  const inventory = productionInventory();
  const ownershipInventory = [...inventory, {
    file: 'src/unrelated-empty.ts',
    sourceFile: parseSourceText('src/unrelated-empty.ts', '')
  }];
  const files = inventory.map(item => item.file);

  // (a) Production inventory is collected from tracked src plus both codec owners.
  assert.ok(files.includes(AGENT_OWNER), 'inventory includes the agent codec owner');
  assert.ok(files.includes(WATCHER_OWNER), 'inventory includes the watcher codec owner');
  assert.doesNotThrow(() => assertNonemptyCodecSources(ownershipInventory),
    'unrelated empty sources do not affect codec nonempty checks');
  assert.throws(() => assertNonemptyCodecSources([
    { file: AGENT_OWNER, sourceFile: parseSourceText(AGENT_OWNER, '') },
    inventory.find(item => item.file === WATCHER_OWNER)
  ]), /codec owner sources are non-empty/,
  'empty codec sources fail the codec nonempty check');

  // (b) exactKeys exists exactly twice in the codec owners: once per owner.
  assertExactKeysOwnerPin(ownershipInventory);

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

const PLANNER_OWNER = 'src/peer/town-hall-plan.ts';
const CHILD_OWNER = 'src/town-hall-child.ts';

// A BinaryExpression that combines provider and nativeId reads reached from the
// `source`/`target` locals is the inline self comparator the shared owner
// replaced. Direct property reads are the obvious form, but the pin must also
// follow hoisted locals (`const sameProvider = ...; sameProvider && sameNative`)
// and concatenated identities (`sourceIdentity = source.provider + '\0' +
// source.nativeId`), so a taint pass records which provider/nativeId kinds each
// local carries before scanning comparisons.
const COMPARATOR_OR_LOGICAL = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken
]);

// Direct `source|target.provider` / `source|target.nativeId` read, if any.
function nativePropertyKind(node) {
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
    (node.expression.text === 'source' || node.expression.text === 'target') &&
    (node.name.text === 'provider' || node.name.text === 'nativeId')) {
    return node.name.text;
  }
  return null;
}

// Kinds of native identity read by an expression: direct property access,
// tainted local, string/template concatenation, or any binary/prefix operand.
function nativeKindTaint(node, tainted) {
  const kinds = new Set();
  if (!node) return kinds;
  const direct = nativePropertyKind(node);
  if (direct) {
    kinds.add(direct);
    return kinds;
  }
  if (ts.isIdentifier(node)) {
    for (const kind of tainted.get(node.text) || []) kinds.add(kind);
    return kinds;
  }
  if (ts.isParenthesizedExpression(node)) return nativeKindTaint(node.expression, tainted);
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      for (const kind of nativeKindTaint(span.expression, tainted)) kinds.add(kind);
    }
    return kinds;
  }
  if (ts.isBinaryExpression(node)) {
    for (const kind of nativeKindTaint(node.left, tainted)) kinds.add(kind);
    for (const kind of nativeKindTaint(node.right, tainted)) kinds.add(kind);
    return kinds;
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    return nativeKindTaint(node.operand, tainted);
  }
  return kinds;
}

// Locals whose initializer touches provider and/or nativeId off source/target.
// Declarations are collected first so a hoisted local can be tainted by the
// time a later comparison consumes it.
function collectTaintedLocals(body) {
  const tainted = new Map();
  visit(body, node => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
    const kinds = nativeKindTaint(node.initializer, tainted);
    if (kinds.size) tainted.set(node.name.text, kinds);
  });
  return tainted;
}

function inlineNativeSelfComparisons(body) {
  const tainted = collectTaintedLocals(body);
  const found = [];
  visit(body, node => {
    if (!ts.isBinaryExpression(node) || !COMPARATOR_OR_LOGICAL.has(node.operatorToken.kind)) return;
    const kinds = new Set();
    for (const operand of [node.left, node.right]) {
      for (const kind of nativeKindTaint(operand, tainted)) kinds.add(kind);
    }
    // Both halves of the native session identity must meet, whether they are
    // direct reads, hoisted comparison locals, or concatenated identities.
    if (kinds.has('provider') && kinds.has('nativeId')) found.push(node);
  });
  return found;
}

// Pin one consumer to the shared self-refusal owner: it must call
// sameAgentSession and must not carry a private inline native comparator or a
// forbidden leftover identifier.
function assertDelegatedSelfRefusal(sourceFile, functionName, options = {}) {
  const declarations = declarationsNamed(sourceFile, functionName);
  assert.equal(declarations.length, 1, `${functionName} is declared exactly once`);
  const body = bodyOf(declarations[0]);
  assert.ok(callsNamed(body, 'sameAgentSession'),
    `${functionName} delegates self refusal to sameAgentSession`);
  for (const name of options.forbiddenIdentifiers || []) {
    let seen = 0;
    visit(body, node => {
      if (ts.isIdentifier(node) && node.text === name) seen += 1;
    });
    assert.equal(seen, 0, `${functionName} no longer declares or uses ${name}`);
  }
  assert.equal(inlineNativeSelfComparisons(body).length, 0,
    `${functionName} carries no inline provider/nativeId self comparator`);
  return body;
}

test('self-refusal is delegated to one shared sameAgentSession owner in current consumers', () => {
  const agentSource = parseSource(AGENT_OWNER);
  const plannerSource = parseSource(PLANNER_OWNER);
  const childSource = parseSource(CHILD_OWNER);

  // (a) All current consumers route their self refusal through the owner.
  assertDelegatedSelfRefusal(childSource, 'snapshotPacket');
  assertDelegatedSelfRefusal(agentSource, 'validateAgentMessage');
  assertDelegatedSelfRefusal(plannerSource, 'planTownHallBroadcast',
    { forbiddenIdentifiers: ['sourceIdentity'] });

  // (b) The pin genuinely rejects a synthetic inline bypass of each consumer,
  // not just the absence of a call.
  const agentBypass = parseSourceText(AGENT_OWNER, `
export function validateAgentMessage(packet: unknown): void {
  const source = packet.source;
  const target = packet.target;
  if (source.provider === target.provider && source.nativeId === target.nativeId) {
    throw new Error('invalid agent message');
  }
}
`);
  assert.throws(() => assertDelegatedSelfRefusal(agentBypass, 'validateAgentMessage'),
    /delegates self refusal to sameAgentSession/,
    'inline bypass without the owner call is rejected');

  const decoy = parseSourceText(AGENT_OWNER, `
export function validateAgentMessage(packet: unknown): void {
  const source = packet.source;
  const target = packet.target;
  if (sameAgentSession(source, target) ||
      (source.provider === target.provider && source.nativeId === target.nativeId)) {
    throw new Error('invalid agent message');
  }
}
`);
  assert.throws(() => assertDelegatedSelfRefusal(decoy, 'validateAgentMessage'),
    /inline provider\/nativeId self comparator/,
    'a decoy owner call cannot hide an inline comparator');

  const plannerBypass = parseSourceText(PLANNER_OWNER, `
export function planTownHallBroadcast(input: unknown): void {
  const source = input.source;
  for (const target of input.recipients) {
    if (sameAgentSession(source, target)) throw new Error('invalid town-hall broadcast plan');
    const sourceIdentity = source.provider + source.nativeId;
    const identity = target.provider + target.nativeId;
    if (identity === sourceIdentity) throw new Error('invalid town-hall broadcast plan');
  }
}
`);
  assert.throws(() => assertDelegatedSelfRefusal(plannerBypass, 'planTownHallBroadcast',
    { forbiddenIdentifiers: ['sourceIdentity'] }), /sourceIdentity/,
    'a leftover sourceIdentity is rejected');

  // (b2) F-008 evasions: hoisted comparison locals and concatenated identities
  // must not slip past the pin behind a decoy owner call.
  const hoistedComparator = parseSourceText(AGENT_OWNER, `
export function validateAgentMessage(packet: unknown): void {
  const source = packet.source;
  const target = packet.target;
  const sameProvider = source.provider === target.provider;
  const sameNative = source.nativeId === target.nativeId;
  if (sameAgentSession(source, target) || (sameProvider && sameNative)) {
    throw new Error('invalid agent message');
  }
}
`);
  assert.throws(() => assertDelegatedSelfRefusal(hoistedComparator, 'validateAgentMessage'),
    /inline provider\/nativeId self comparator/,
    'hoisted provider/native comparison locals are rejected');

  const concatIdentity = parseSourceText(AGENT_OWNER, `
export function validateAgentMessage(packet: unknown): void {
  const source = packet.source;
  const target = packet.target;
  const sourceIdentity = source.provider + '\\0' + source.nativeId;
  const identity = target.provider + '\\0' + target.nativeId;
  if (sameAgentSession(source, target) || identity === sourceIdentity) {
    throw new Error('invalid agent message');
  }
}
`);
  assert.throws(() => assertDelegatedSelfRefusal(concatIdentity, 'validateAgentMessage'),
    /inline provider\/nativeId self comparator/,
    'concatenated source/target identities are rejected');

  // The real planner's target-only `identity` local is consumed by seen.has()
  // (a call, not a self comparison), so the hardened taint pass must accept it.
  assert.doesNotThrow(() => assertDelegatedSelfRefusal(plannerSource, 'planTownHallBroadcast',
    { forbiddenIdentifiers: ['sourceIdentity'] }),
  'real planner identity dedup is not mistaken for an inline self comparator');

  // (c) Runtime sentinel: the planner resolves the owner through the module
  // exports, so replacing that export with an always-true function must make
  // the planner refuse a recipient that is not the source session.
  const agentModule = require('../dist/agent-message');
  const { planTownHallBroadcast } = require('../dist/peer/town-hall-plan');
  assert.equal(typeof agentModule.sameAgentSession, 'function',
    'dist exports sameAgentSession');
  assert.equal(typeof planTownHallBroadcast, 'function', 'dist exports the planner');

  const lowA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const lowB = '11111111-1111-4111-8111-aabbccddeeff';
  const nonSelfInput = {
    broadcastId: 'b1',
    townHall: { guildId: '100', channelId: '900' },
    source: { guildId: '100', channelId: '200', provider: 'codex', nativeId: lowA, generation: 1 },
    recipients: [{ guildId: '100', channelId: '300', provider: 'codex', nativeId: lowB, generation: 1 }],
    text: 'hello'
  };
  const childCodec = require('../dist/town-hall-child');
  const childPacket = {
    id: `townhall_${'a'.repeat(64)}`, kind: 'request',
    source: { ...nonSelfInput.source }, target: { ...nonSelfInput.recipients[0] },
    replyTo: null, routingVersion: 2, text: 'hello', purpose: 'town-hall-child/v1',
    broadcastId: 'b1', journalKey: 'b'.repeat(64), planFingerprint: 'c'.repeat(64),
    room: { ...nonSelfInput.townHall }, roomMessageId: '400'
  };
  const token = 'disposable-owner-pin';
  const childWire = childCodec.encodeTownHallChild(childPacket, token);
  const original = agentModule.sameAgentSession;
  try {
    agentModule.sameAgentSession = () => true;
    assert.throws(() => planTownHallBroadcast(nonSelfInput), error => {
      assert.equal(error.message, 'invalid town-hall broadcast plan');
      return true;
    }, 'planner reads the owner through the module exports and refuses on a forced true');

    for (const act of [
      () => childCodec.validateTownHallChild(childPacket),
      () => childCodec.encodeTownHallChild(childPacket, token),
      () => childCodec.decodeTownHallChild(childWire, token, childPacket.target)
    ]) {
      assert.throws(act, /invalid town-hall child packet/,
        'child entrypoints refuse when the shared session comparator is forced true');
    }

    const nonSelfPacket = {
      id: 'm1',
      kind: 'request',
      source: { guildId: '100', channelId: '200', provider: 'codex', nativeId: lowA, generation: 1 },
      target: { guildId: '100', channelId: '300', provider: 'claude', nativeId: lowB, generation: 1 },
      replyTo: null,
      text: 'hi'
    };
    assert.doesNotThrow(() => agentModule.validateAgentMessage(nonSelfPacket));

    // CommonJS keeps the validator's local binding separate from its export.
    const Module = require('node:module');
    const filename = require.resolve('../dist/agent-message');
    const compiledText = fs.readFileSync(filename, 'utf8');
    const compiledSource = parseSourceText(filename, compiledText);
    const owners = declarationsNamed(compiledSource, 'sameAgentSession');
    assert.equal(owners.length, 1, 'compiled module has exactly one comparator owner');
    const ownerBody = bodyOf(owners[0]);
    const sentinelText = compiledText.slice(0, ownerBody.getStart(compiledSource)) +
      '{ return true; }' + compiledText.slice(ownerBody.end);
    const isolated = new Module(filename, module);
    isolated.filename = filename;
    isolated.paths = module.paths;
    isolated._compile(sentinelText, filename);
    assert.throws(() => isolated.exports.validateAgentMessage(nonSelfPacket), error => {
      assert.equal(error.message, 'invalid agent message');
      return true;
    }, 'validator refuses when its local comparator owner is forced true');
  } finally {
    agentModule.sameAgentSession = original;
  }

  // (d) After restore the planner accepts the same non-self input again.
  assert.equal(planTownHallBroadcast(nonSelfInput).recipients.length, 1);
  assert.deepEqual(childCodec.decodeTownHallChild(childWire, token, childPacket.target), childPacket);
});
