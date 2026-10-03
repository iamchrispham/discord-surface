'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '../..');
const AGENT_OWNER = 'src/agent-message.ts';
const PLANNER_OWNER = 'src/peer/town-hall-plan.ts';
const WATCHER_OWNER = 'src/watcher-notice.ts';
const CHILD_OWNER = 'src/town-hall-child.ts';
const SELF_REFUSAL_CONSUMER_INVENTORY = Object.freeze([
  Object.freeze({ file: AGENT_OWNER, functionName: 'validateAgentMessage' }),
  Object.freeze({ file: PLANNER_OWNER, functionName: 'planTownHallBroadcast' }),
  Object.freeze({ file: CHILD_OWNER, functionName: 'snapshotPacket' })
]);

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

function sourceFilesUnder(relativeDirectory) {
  const files = [];
  const visitDirectory = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visitDirectory(absolute);
      } else if (entry.isFile() && /\.(?:js|ts)$/.test(entry.name)) {
        files.push(path.relative(ROOT, absolute).split(path.sep).join('/'));
      }
    }
  };
  visitDirectory(path.join(ROOT, relativeDirectory));
  return files.sort();
}

function productionSources() {
  return sourceFilesUnder('src').map(file => ({
    file,
    sourceFile: parseSource(file)
  }));
}

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

function namedFunctionDeclarations(sourceFile) {
  const found = [];
  visit(sourceFile, node => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      found.push({ name: node.name.text, declaration: node });
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      found.push({ name: node.name.text, declaration: node });
    }
  });
  return found;
}

function bodyOf(declaration) {
  return ts.isFunctionDeclaration(declaration) ? declaration.body : declaration.initializer.body;
}

function callsNamed(node, name) {
  let found = false;
  visit(node, current => {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) &&
      current.expression.text === name) found = true;
  });
  return found;
}

function propertyPath(node) {
  const parts = [];
  let current = node;
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = current.expression;
  }
  if (ts.isIdentifier(current)) parts.unshift(current.text);
  return parts.join('.');
}

function watcherRouteEqualityFields(body) {
  const fields = [];
  visit(body, node => {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return;
    const left = propertyPath(node.left);
    const right = propertyPath(node.right);
    const pair = [left, right].sort();
    for (const field of ['provider', 'nativeId', 'generation']) {
      const expected = [`packet.source.${field}`, `packet.target.${field}`].sort();
      if (pair[0] === expected[0] && pair[1] === expected[1]) fields.push(field);
    }
  });
  return fields.sort();
}

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
    return `${node.expression.text}.${node.name.text}`;
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
    // Both halves of the native session identity must meet on both sides,
    // whether they are direct reads, hoisted locals, or concatenated identities.
    if (kinds.has('source.provider') && kinds.has('target.provider') &&
      kinds.has('source.nativeId') && kinds.has('target.nativeId')) found.push(node);
  });
  return found;
}

// The production census covers only src/**/*.ts and src/**/*.js. A self-refusal
// consumer is any named function that delegates to sameAgentSession or carries
// an inline provider/nativeId comparison over source/target identities. The
// watcher route is intentionally outside this class: validateWatcherNotice
// keeps strict source/target provider, nativeId, and generation predicates.
function selfRefusalConsumerSites(sources) {
  const sites = [];
  for (const { file, sourceFile } of sources) {
    for (const { name, declaration } of namedFunctionDeclarations(sourceFile)) {
      const body = bodyOf(declaration);
      if (!body) continue;
      const delegated = callsNamed(body, 'sameAgentSession');
      const inline = inlineNativeSelfComparisons(body);
      if (delegated || inline.length) sites.push({ file, functionName: name, delegated, inline });
    }
  }
  return sites.sort((left, right) => `${left.file}:${left.functionName}`.localeCompare(`${right.file}:${right.functionName}`));
}

function assertSelfRefusalConsumerInventory(sources) {
  const actual = selfRefusalConsumerSites(sources);
  const expected = SELF_REFUSAL_CONSUMER_INVENTORY.map(({ file, functionName }) => ({ file, functionName }));
  assert.deepEqual(actual.map(({ file, functionName }) => ({ file, functionName })), expected,
    'production self-refusal consumers are inventoried exactly once');
  for (const { file, functionName } of expected) {
    const site = actual.find(candidate => candidate.file === file && candidate.functionName === functionName);
    assert.ok(site.delegated, `${file}:${functionName} delegates self refusal to sameAgentSession`);
    assert.equal(site.inline.length, 0, `${file}:${functionName} carries no inline provider/nativeId self comparator`);
  }
}

function assertWatcherRouteEqualityException(sources) {
  const source = sources.find(candidate => candidate.file === WATCHER_OWNER);
  assert.ok(source, `${WATCHER_OWNER} is included in the production census`);
  const declarations = declarationsNamed(source.sourceFile, 'validateWatcherNotice');
  assert.equal(declarations.length, 1, 'validateWatcherNotice is declared exactly once');
  assert.deepEqual(watcherRouteEqualityFields(bodyOf(declarations[0])), ['generation', 'nativeId', 'provider'],
    'watcher route keeps strict source/target provider, nativeId, and generation equality predicates');
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
  const sources = productionSources();
  assertSelfRefusalConsumerInventory(sources);
  assertWatcherRouteEqualityException(sources);

  const agentSource = sources.find(candidate => candidate.file === AGENT_OWNER).sourceFile;
  const plannerSource = sources.find(candidate => candidate.file === PLANNER_OWNER).sourceFile;
  const childSource = sources.find(candidate => candidate.file === CHILD_OWNER).sourceFile;

  assertDelegatedSelfRefusal(agentSource, 'validateAgentMessage');
  assertDelegatedSelfRefusal(childSource, 'snapshotPacket');
  assertDelegatedSelfRefusal(plannerSource, 'planTownHallBroadcast',
    { forbiddenIdentifiers: ['sourceIdentity'] });

  const thirdFileInlineBypass = parseSourceText('src/peer/third-self-refusal.ts', `
export function rejectThirdAgentMessage(packet: unknown): void {
  const source = packet.source;
  const target = packet.target;
  if (source.provider === target.provider && source.nativeId === target.nativeId) {
    throw new Error('invalid third agent message');
  }
}
`);
  assert.throws(() => assertSelfRefusalConsumerInventory([
    ...sources,
    { file: 'src/peer/third-self-refusal.ts', sourceFile: thirdFileInlineBypass }
  ]), /production self-refusal consumers are inventoried exactly once/,
  'a third-file inline self comparator cannot leave the inventory green');

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
  const agentModule = require('../../dist/agent-message');
  const { planTownHallBroadcast } = require('../../dist/peer/town-hall-plan');
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
  const original = agentModule.sameAgentSession;
  try {
    agentModule.sameAgentSession = () => true;
    assert.throws(() => planTownHallBroadcast(nonSelfInput), error => {
      assert.equal(error.message, 'invalid town-hall broadcast plan');
      return true;
    }, 'planner reads the owner through the module exports and refuses on a forced true');

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
    const filename = require.resolve('../../dist/agent-message');
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
});
