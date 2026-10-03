'use strict';

// Issue 131 owner pin. Five top-level tests pin the two shared network-effect
// owners (direct-post and board-refresh), the peer caller assertion factory, the
// public caller wiring, and the suite registration. The inventory checkers are
// pure functions over source text so test five can mutate in-memory strings
// without ever executing a mutant against the worktree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

const EXPECTED_TRANSPORT = {
  'src/direct-post.ts': {
    verifyAgentDestination: 1,
    sendDiscordMessage: 1
  },
  // The destination lookup itself lives one owner deeper: direct-post.ts calls
  // verifyAgentDestination, which calls fetchDiscordChannel here. Pin the
  // primitive too, so a new unbracketed GET added at this layer fails.
  'src/direct-post/delivery-identity.ts': {
    fetchDiscordChannel: 1
  },
  'src/board-refresh.ts': {
    fetchBoardInstallation: 1,
    fetchBoardChannel: 1,
    fetchBoardTarget: 1,
    patchBoardMessage: 1
  }
};

// Files that must never call fetch directly. Peer service injects loadChannels,
// so a raw fetch there would bypass the bracketed lookup.
const NO_RAW_FETCH = new Set([
  ...Object.keys(EXPECTED_TRANSPORT),
  'src/peer/service.js',
  'src/peer/post.js'
]);

const REFUSAL = /native caller|peer caller|caller changed|caller has no active binding|caller binding is ambiguous|caller identity is unavailable|binding changed|binding is stale|aborted|closing/i;

function parse(fileName, text) {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
}

// Walk from a call expression to the nearest enclosing named function or method.
function enclosingOwner(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText();
    if (ts.isPropertyAssignment(current) && current.name &&
      (ts.isFunctionExpression(current.initializer) || ts.isArrowFunction(current.initializer))) {
      return current.name.getText();
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer &&
      (ts.isFunctionExpression(current.initializer) || ts.isArrowFunction(current.initializer))) {
      return current.name.text;
    }
    if (ts.isClassDeclaration(current)) return null;
    current = current.parent;
  }
  return null;
}

function calleeName(node) {
  const expression = node.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

// local alias -> canonical imported name, resolved from ES imports and CommonJS
// require destructuring, so `import { sendDiscordMessage as send }` still counts.
function importedAliases(sourceFile) {
  const aliases = new Map();
  const visit = node => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)) {
      for (const element of node.importClause.namedBindings.elements) {
        aliases.set(element.name.text, (element.propertyName || element.name).text);
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'require' &&
        ts.isObjectBindingPattern(node.name)) {
      const argument = node.initializer.arguments[0];
      if (argument && ts.isStringLiteral(argument)) {
        for (const element of node.name.elements) {
          aliases.set(element.name.text, (element.propertyName || element.name).text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

function callSites(sourceFile) {
  const sites = [];
  const aliases = importedAliases(sourceFile);
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name) sites.push({ node, name, canonical: aliases.get(name) || name, owner: enclosingOwner(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

// Names bound to a createCallerAssertion(...) result in one source file.
function assertionFactoryNames(sourceFile) {
  const names = [];
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'createCallerAssertion') {
      if (ts.isIdentifier(node.name)) names.push(node.name.text);
      else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) names.push(element.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function hasFactoryCall(sourceFile) {
  return callSites(sourceFile).some(site => site.canonical === 'createCallerAssertion');
}

// Resolve an object literal's named properties, following identifier spreads of
// other object-literal variable declarations one level deep.
function objectProperties(expression, variableInitializers) {
  const properties = new Map();
  if (!expression || !ts.isObjectLiteralExpression(expression)) return properties;
  for (const property of expression.properties) {
    if (ts.isPropertyAssignment(property) && property.name) {
      properties.set(property.name.getText().replace(/['"]/g, ''), property.initializer);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      properties.set(property.name.getText(), property.name);
    } else if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) {
      const spread = objectProperties(variableInitializers.get(property.expression.text), variableInitializers);
      for (const [key, value] of spread) if (!properties.has(key)) properties.set(key, value);
    }
  }
  return properties;
}

function variableInitializers(sourceFile) {
  const initializers = new Map();
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      initializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return initializers;
}

function referencesRequestField(initializer) {
  if (!initializer) return true;
  const text = initializer.getText();
  return /\b(input|args|request)\s*\./.test(text) || /\[\s*['"]assertCallerCurrent['"]\s*\]/.test(text) ||
    /objectAssign|Object\.assign/.test(text);
}

// A property that is written as null or undefined is treated as absent.
function suppliesValue(initializer) {
  if (!initializer) return false;
  if (initializer.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isIdentifier(initializer) && initializer.text === 'undefined') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Inventory checkers. Each returns an array of human-readable violations.

function transportViolations(sources) {
  const violations = [];
  for (const [file, expected] of Object.entries(EXPECTED_TRANSPORT)) {
    const text = sources[file];
    if (typeof text !== 'string') {
      violations.push(`${file}: source is missing`);
      continue;
    }
    const sourceFile = parse(file, text);
    const counts = new Map();
    for (const site of callSites(sourceFile)) {
      if (site.canonical === 'fetch' || site.name === 'fetch' ||
          (ts.isPropertyAccessExpression(site.node.expression) && site.name === 'fetch')) {
        violations.push(`${file}: direct fetch call at ${site.owner || '<top>'}`);
      }
      if (Object.hasOwn(expected, site.canonical)) {
        counts.set(site.canonical, (counts.get(site.canonical) || 0) + 1);
      }
    }
    for (const [name, wanted] of Object.entries(expected)) {
      const got = counts.get(name) || 0;
      if (got !== wanted) violations.push(`${file}: ${name} expected ${wanted}, found ${got}`);
    }
    // A transport import that is not part of the pinned inventory is a new site.
    const visit = node => {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings)) {
        const specifier = node.moduleSpecifier.getText();
        if (/discord|delivery-identity|direct-post/.test(specifier)) {
          for (const element of node.importClause.namedBindings.elements) {
            if (element.isTypeOnly) continue;
            const canonical = (element.propertyName || element.name).text;
            if (!Object.hasOwn(expected, canonical) && /fetch|send|patch|Destination/i.test(canonical)) {
              violations.push(`${file}: unexpected transport import ${canonical} from ${specifier}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  // Raw fetch must not appear in any owner that is expected to route through
  // an inventoried transport helper, including peer service (which injects
  // loadChannels) and post.
  for (const file of NO_RAW_FETCH) {
    if (Object.hasOwn(EXPECTED_TRANSPORT, file)) continue;
    const text = sources[file];
    if (typeof text !== 'string') {
      violations.push(`${file}: source is missing`);
      continue;
    }
    for (const site of callSites(parse(file, text))) {
      if (site.name === 'fetch') violations.push(`${file}: direct fetch call at ${site.owner || '<top>'}`);
    }
  }
  return violations;
}

function channelLookupViolations(sources) {
  const violations = [];
  const text = sources['src/peer/service.js'];
  if (typeof text !== 'string') {
    violations.push('src/peer/service.js: source is missing');
    return violations;
  }
  const sourceFile = parse('src/peer/service.js', text);
  const sites = callSites(sourceFile);
  const lookups = sites.filter(site => site.canonical === 'loadChannels');
  if (lookups.length !== 1) violations.push(`src/peer/service.js: loadChannels expected 1, found ${lookups.length}`);
  const factoryNames = new Set(assertionFactoryNames(sourceFile));
  factoryNames.add('assertCallerCurrent');
  const assertions = sites.filter(site => factoryNames.has(site.name) || factoryNames.has(site.canonical));
  if (!hasFactoryCall(sourceFile)) violations.push('src/peer/service.js: no createCallerAssertion call found');
  if (lookups.length === 1) {
    const lookup = lookups[0].node;
    const before = assertions.some(site => site.node.pos < lookup.pos && site.owner === lookups[0].owner);
    const after = assertions.some(site => site.node.end > lookup.end && site.owner === lookups[0].owner);
    if (!before) violations.push('src/peer/service.js: no caller assertion before loadChannels');
    if (!after) violations.push('src/peer/service.js: no caller assertion after loadChannels');
  }
  return violations;
}

// Public peer roles must forward the assertion produced by the peer caller owner.
function wiringViolations(sources) {
  const violations = [];
  for (const file of ['src/peer/service.js', 'src/peer/post.js']) {
    const text = sources[file];
    if (typeof text !== 'string') {
      violations.push(`${file}: source is missing`);
      continue;
    }
    const sourceFile = parse(file, text);
    const initializers = variableInitializers(sourceFile);
    const factoryNames = new Set(assertionFactoryNames(sourceFile));
    if (!hasFactoryCall(sourceFile)) violations.push(`${file}: no createCallerAssertion call found`);
    const runCalls = callSites(sourceFile).filter(site =>
      site.canonical === 'runDirectPost' || site.canonical === 'runBoardRefresh');
    if (file.endsWith('service.js')) {
      const sendRun = runCalls.filter(site => site.owner === 'send');
      if (sendRun.length !== 1) violations.push('src/peer/service.js: send must call runDirectPost exactly once');
      for (const site of sendRun) {
        const properties = objectProperties(site.node.arguments[0], initializers);
        const value = properties.get('assertCallerCurrent');
        if (!suppliesValue(value)) violations.push('src/peer/service.js: send does not supply assertCallerCurrent');
        else if (referencesRequestField(value)) violations.push('src/peer/service.js: assertCallerCurrent comes from request fields');
        else if (!(ts.isIdentifier(value) && factoryNames.has(value.text)) &&
                 !(ts.isCallExpression(value) && calleeName(value) === 'createCallerAssertion')) {
          violations.push('src/peer/service.js: assertCallerCurrent is not derived from createCallerAssertion');
        }
      }
    } else {
      const announce = runCalls.filter(site => site.owner === 'postByRole');
      const board = announce.filter(site => site.canonical === 'runBoardRefresh');
      const direct = announce.filter(site => site.canonical === 'runDirectPost');
      if (direct.length !== 1) violations.push('src/peer/post.js: postByRole must call announcement runDirectPost exactly once');
      if (board.length !== 1) violations.push('src/peer/post.js: postByRole must call runBoardRefresh exactly once');
      for (const site of [...direct, ...board]) {
        const properties = objectProperties(site.node.arguments[0], initializers);
        const value = properties.get('assertCallerCurrent');
        if (!suppliesValue(value)) violations.push(`src/peer/post.js: ${site.canonical} does not receive assertCallerCurrent`);
        else if (referencesRequestField(value)) violations.push(`src/peer/post.js: ${site.canonical} assertion comes from request fields`);
        else if (!(ts.isIdentifier(value) && factoryNames.has(value.text)) &&
                 !(ts.isCallExpression(value) && calleeName(value) === 'createCallerAssertion')) {
          violations.push(`src/peer/post.js: ${site.canonical} assertion is not derived from createCallerAssertion`);
        }
      }
    }
    // bindingCurrent and agentDestinationCurrent stay synchronous.
    const visit = node => {
      if (ts.isPropertyAssignment(node) && node.name && ['bindingCurrent', 'agentDestinationCurrent'].includes(node.name.getText())) {
        const initializer = node.initializer;
        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
          if (initializer.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
            violations.push(`${file}: ${node.name.getText()} must remain synchronous`);
          }
          const containsAwait = node => {
            if (ts.isAwaitExpression(node)) return true;
            return ts.forEachChild(node, containsAwait) || false;
          };
          if (containsAwait(initializer)) violations.push(`${file}: ${node.name.getText()} must not await`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  const revalidation = sources['test/peer-effect-revalidation.test.js'];
  if (typeof revalidation !== 'string') violations.push('test/peer-effect-revalidation.test.js: source is missing');
  else if (/FIXED|PEER_EFFECT_EXPECT_FIXED|transitional\s*\(/.test(revalidation)) {
    violations.push('test/peer-effect-revalidation.test.js: still contains a transitional expected-red mode');
  }
  return violations;
}

function realSources() {
  const files = [
    'src/direct-post.ts', 'src/direct-post/delivery-identity.ts', 'src/board-refresh.ts',
    'src/peer/service.js', 'src/peer/post.js', 'test/peer-effect-revalidation.test.js'
  ];
  return Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(ROOT, file), 'utf8')]));
}

function ownerViolations(sources) {
  return [...transportViolations(sources), ...channelLookupViolations(sources), ...wiringViolations(sources)];
}

// ---------------------------------------------------------------------------
// Runtime harness for the shared effect owners.

const DIRECT_POST_OWNER = 'src/direct-post.ts';
const BOARD_OWNER = 'src/board-refresh.ts';

function refusalError() {
  return new Error('native caller must be revalidated: peer caller changed');
}

function buildHarness({ snapshot, rejectWhen = null }) {
  const events = [];
  let fetchCount = 0;
  const assertCallerCurrent = async () => {
    const state = snapshot();
    events.push({ kind: 'assert', snapshot: state });
    if (rejectWhen && rejectWhen({ fetchCount, snapshot: state, events })) throw refusalError();
  };
  const wrapFetch = inner => async (url, init = {}) => {
    fetchCount += 1;
    events.push({ kind: 'fetch', method: init.method || 'GET', url });
    return inner(url, init);
  };
  return { events, assertCallerCurrent, wrapFetch, fetchCount: () => fetchCount };
}

function directSnapshot(state, requestId) {
  const rows = state.directPostRows(requestId);
  return {
    attempts: rows.filter(row => row.kind === 'direct-post-attempt').length,
    outcomes: rows.filter(row => row.kind === 'direct-post-outcome'),
    sent: rows.some(row => row.kind === 'direct-post-outcome' && row.detail.outcome === 'sent'),
    unknown: rows.some(row => row.kind === 'direct-post-outcome' && row.detail.outcome === 'unknown'),
    preflight: rows.filter(row => row.kind === 'direct-post-outcome' && row.detail.phase === 'preflight')
  };
}

function boardSnapshot(state, requestId) {
  const rows = state.listReceipts()
    .map(row => ({ kind: row.kind, detail: JSON.parse(row.detail) }))
    .filter(row => row.kind.startsWith('board-refresh') && row.detail.requestId === requestId);
  return {
    attempts: rows.filter(row => row.kind === 'board-refresh-attempt'),
    outcomes: rows.filter(row => row.kind === 'board-refresh-outcome'),
    applied: rows.some(row => row.kind === 'board-refresh-outcome' && row.detail.outcome === 'applied')
  };
}

function fetchEventIndex(events, method) {
  return events.findIndex(event => event.kind === 'fetch' && event.method === method);
}

function assertBracketed(events, method) {
  const index = fetchEventIndex(events, method);
  assert.ok(index > 0, `a ${method} request must be preceded by a caller assertion`);
  const before = events.slice(0, index).some(event => event.kind === 'assert');
  const after = events.slice(index + 1).some(event => event.kind === 'assert');
  assert.equal(before, true, `caller assertion before ${method}`);
  assert.equal(after, true, `caller assertion after ${method}`);
  return index;
}

// ---------------------------------------------------------------------------

test('transport inventory pins every peer network effect and the channel-list lookup', async t => {
  assert.deepEqual(ownerViolations(realSources()), []);

  // The channel-list lookup is bracketed: the post-assertion still runs when
  // loadChannels itself rejects, so a caller change during the failed lookup
  // refuses instead of returning the transport error.
  const { fixture } = require('./fixtures/peer-fixture');
  const f = fixture(t);
  f.enroll('102');
  const CHANGED = '99999999-9999-9999-9999-999999999999';
  let current = '11111111-1111-1111-1111-111111111111';
  const { createPeerService } = require('../src/peer/service');
  const peer = createPeerService({
    state: f.state,
    provider: 'claude',
    token: 'fixture',
    callerDependencies: { resolveClaudeCaller: async () => ({ harness: 'claude-code', sessionId: current }) },
    loadChannels: async () => { current = CHANGED; throw new Error('simulated channel list failure'); },
    fetchImpl: async () => { throw new Error('no network expected'); }
  });
  await assert.rejects(peer.send({ peer: { channelName: 'general' }, text: 'hello', dedupe_key: 'owner-channel-list' }),
    REFUSAL, 'a caller change during a failed channel list must refuse');
  assert.equal(f.state.directPostRows('owner-channel-list').length, 0, 'no attempt after the refusal');

  // With a stable caller the post-assertion still runs and the original
  // channel-list transport error propagates unchanged.
  const stable = fixture(t);
  stable.enroll('102');
  const stableError = new Error('simulated channel list failure');
  const stablePeer = createPeerService({
    state: stable.state,
    provider: 'claude',
    token: 'fixture',
    callerDependencies: { resolveClaudeCaller: async () => ({ harness: 'claude-code', sessionId: '11111111-1111-1111-1111-111111111111' }) },
    loadChannels: async () => { throw stableError; },
    fetchImpl: async () => { throw new Error('no network expected'); }
  });
  await assert.rejects(stablePeer.send({ peer: { channelName: 'general' }, text: 'hello', dedupe_key: 'owner-channel-list-stable' }),
    error => { assert.strictEqual(error, stableError); return true; },
    'a stable caller sees the original channel-list transport error');
  assert.equal(stable.state.directPostRows('owner-channel-list-stable').length, 0);
});

test('public peer roles supply the caller assertion from the peer caller owner', () => {
  const sources = realSources();
  assert.deepEqual(wiringViolations(sources), []);
});

test('the caller assertion factory compares all five captured identity fields', async t => {
  const { createCallerAssertion, resolvePeerCaller } = require('../src/peer/caller');
  const { fixture } = require('./fixtures/peer-fixture');
  const ORIGINAL = '11111111-1111-1111-1111-111111111111';
  const CHANGED = '99999999-9999-9999-9999-999999999999';
  const CODEX_ID = '22222222-2222-2222-2222-222222222222';

  function capturedId(state) {
    return state.getBinding('101').nativeId;
  }

  function claudeDeps(sessionId) {
    return { resolveClaudeCaller: async () => ({ harness: 'claude-code', sessionId }) };
  }

  const base = fixture(t);
  const captured = await resolvePeerCaller(base.state, 'claude', claudeDeps(ORIGINAL));
  const assertion = createCallerAssertion(base.state, 'claude', claudeDeps(ORIGINAL), captured);
  await assertion();
  await assertion(undefined);

  const aborted = new AbortController();
  aborted.abort();
  let resolverCalls = 0;
  const abortedAssertion = createCallerAssertion(base.state, 'claude', {
    resolveClaudeCaller: async () => { resolverCalls += 1; return { harness: 'claude-code', sessionId: ORIGINAL }; }
  }, captured);
  await assert.rejects(abortedAssertion(aborted.signal), REFUSAL);
  assert.equal(resolverCalls, 0, 'an already-aborted assertion refuses before the resolver runs');

  // Case-only UUID spelling stays equivalent.
  const caseFold = fixture(t);
  caseFold.state.db.prepare("UPDATE bindings SET native_id=upper(native_id) WHERE channel_id='101'").run();
  const foldedCaptured = { ...captured, nativeId: capturedId(caseFold.state).toLowerCase() };
  await createCallerAssertion(caseFold.state, 'claude', claudeDeps(capturedId(caseFold.state)), foldedCaptured)();

  // Mutating the original captured object cannot change the frozen expectation.
  const frozen = fixture(t);
  const mutable = { ...captured, nativeId: capturedId(frozen.state) };
  const frozenAssertion = createCallerAssertion(frozen.state, 'claude', claudeDeps(mutable.nativeId), mutable);
  mutable.channelId = '999';
  mutable.guildId = '999';
  mutable.generation = 999;
  mutable.nativeId = CHANGED;
  mutable.provider = 'codex';
  await frozenAssertion();

  // Each identity field is replaced independently and every change refuses.
  const cases = [
    {
      name: 'provider',
      setup() {
        const f = fixture(t);
        f.state.bind({ guildId: '100', channelId: '301', provider: 'codex', nativeId: CODEX_ID,
          workspace: '/tmp', conductorId: 'codex-owner', repoKey: 'github.com/test/codex' }, { intakeCutoff: '100' });
        return { state: f.state, provider: 'codex', deps: { resolveCodexCaller: async () => ({ sessionId: CODEX_ID, threadId: CODEX_ID, turnId: 't1' }) } };
      }
    },
    {
      name: 'guildId',
      setup() {
        const f = fixture(t);
        const id = capturedId(f.state);
        f.state.setConfig({ guildId: '200' });
        f.state.db.prepare("UPDATE bindings SET guild_id='200' WHERE channel_id='101'").run();
        return { state: f.state, provider: 'claude', deps: claudeDeps(id) };
      }
    },
    {
      name: 'channelId',
      setup() {
        const f = fixture(t);
        const id = capturedId(f.state);
        f.state.db.exec('PRAGMA defer_foreign_keys = ON');
        f.state.db.exec('BEGIN');
        f.state.db.prepare("UPDATE bindings SET channel_id='103' WHERE channel_id='101'").run();
        f.state.db.prepare("UPDATE thread_enrollments SET parent_channel_id='103' WHERE parent_channel_id='101'").run();
        f.state.db.exec('COMMIT');
        return { state: f.state, provider: 'claude', deps: claudeDeps(id) };
      }
    },
    {
      name: 'nativeId',
      setup() {
        const f = fixture(t);
        f.state.db.prepare("UPDATE bindings SET native_id=? WHERE channel_id='101'").run(CHANGED);
        return { state: f.state, provider: 'claude', deps: claudeDeps(CHANGED) };
      }
    },
    {
      name: 'generation',
      setup() {
        const f = fixture(t);
        const id = capturedId(f.state);
        f.state.db.prepare("UPDATE bindings SET generation=generation+1 WHERE channel_id='101'").run();
        return { state: f.state, provider: 'claude', deps: claudeDeps(id) };
      }
    }
  ];
  for (const scenario of cases) {
    const { state, provider, deps } = scenario.setup();
    await assert.rejects(createCallerAssertion(state, provider, deps, captured)(),
      REFUSAL, `${scenario.name} replacement must refuse`);
  }
});

test('direct-post and board execution bracket each network effect with the assertion', async t => {
  const { agentFixture, response, CLAUDE } = require('./direct-post-fixture');
  const { runDirectPost } = require('../src/direct-post');
  const boardFixture = require('./board-refresh-fixture');
  const { runBoardRefresh, BOARD_OUTCOMES } = boardFixture;

  const destination = { guildId: '100', channelId: '102', provider: 'claude', nativeId: CLAUDE, generation: 1 };
  const channelResponse = () => ({ ok: true, status: 200, json: async () => ({ id: destination.channelId, guild_id: destination.guildId }), body: { cancel() {} } });
  const agentTarget = require('../src/agent-message').issueAgentAddress(destination, 'fixture');
  const directFetch = harness => harness.wrapFetch(async (url, options) => options.method === 'GET'
    ? channelResponse()
    : response('direct-1'));

  // Direct-post: successful send persists the sent receipt before its post-assert.
  {
    const f = agentFixture(t);
    fs.writeFileSync(f.textFile, 'sequence text');
    const harness = buildHarness({ snapshot: () => directSnapshot(f.state, 'sequence-ok') });
    const result = await runDirectPost({
      state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
      agentThreadId: f.agentThreadId, textFile: f.textFile, dedupeKey: 'sequence-ok',
      agentTarget,
      assertCallerCurrent: harness.assertCallerCurrent,
      fetchImpl: directFetch(harness)
    });
    assert.equal(result.status, 'sent');
    assertBracketed(harness.events, 'GET');
    const postIndex = fetchEventIndex(harness.events, 'POST');
    assert.ok(postIndex > 0);
    assertBracketed(harness.events, 'POST');
    assert.equal(harness.events[postIndex + 1].kind === 'assert', true, 'an assertion follows the POST');
    assert.equal(harness.events.at(-1).snapshot.sent, true, 'the sent receipt is persisted before the post-assert');
  }

  // Direct-post: a successful receipt survives a post-assertion refusal.
  {
    const f = agentFixture(t);
    fs.writeFileSync(f.textFile, 'sequence refusal');
    const requestId = 'sequence-post-refusal';
    const harness = buildHarness({
      snapshot: () => directSnapshot(f.state, requestId),
      rejectWhen: ({ fetchCount }) => fetchCount >= 2
    });
    await assert.rejects(runDirectPost({
      state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
      agentThreadId: f.agentThreadId, textFile: f.textFile, dedupeKey: requestId,
      agentTarget,
      assertCallerCurrent: harness.assertCallerCurrent,
      fetchImpl: directFetch(harness)
    }), REFUSAL);
    const snapshot = directSnapshot(f.state, requestId);
    assert.equal(snapshot.outcomes.length, 1, 'sent evidence saved exactly once');
    assert.equal(snapshot.outcomes[0].detail.outcome, 'sent');
    assert.equal(snapshot.outcomes[0].detail.messageId, 'direct-1');
  }

  // Direct-post: an unknown outcome survives a post-assertion refusal.
  {
    const f = agentFixture(t);
    fs.writeFileSync(f.textFile, 'sequence unknown');
    const requestId = 'sequence-unknown';
    const networkError = new Error('simulated transport failure');
    const harness = buildHarness({
      snapshot: () => directSnapshot(f.state, requestId),
      rejectWhen: ({ fetchCount }) => fetchCount >= 2
    });
    await assert.rejects(runDirectPost({
      state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
      agentThreadId: f.agentThreadId, textFile: f.textFile, dedupeKey: requestId,
      agentTarget,
      assertCallerCurrent: harness.assertCallerCurrent,
      fetchImpl: harness.wrapFetch(async (url, options) => {
        if (options.method === 'GET') return channelResponse();
        throw networkError;
      })
    }), REFUSAL);
    const snapshot = directSnapshot(f.state, requestId);
    assert.equal(snapshot.unknown, true, 'the unknown classification is preserved');
    assert.equal(snapshot.outcomes.length, 1);
  }

  // Direct-post: a rejected destination GET persists its existing preflight
  // classification before the refusal escapes.
  {
    const f = agentFixture(t);
    fs.writeFileSync(f.textFile, 'sequence preflight');
    const requestId = 'sequence-preflight';
    const harness = buildHarness({
      snapshot: () => directSnapshot(f.state, requestId),
      rejectWhen: ({ fetchCount }) => fetchCount >= 1
    });
    await assert.rejects(runDirectPost({
      state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
      agentThreadId: f.agentThreadId, textFile: f.textFile, dedupeKey: requestId,
      agentTarget,
      assertCallerCurrent: harness.assertCallerCurrent,
      fetchImpl: harness.wrapFetch(async () => { throw new Error('destination lookup failed'); })
    }), REFUSAL);
    const snapshot = directSnapshot(f.state, requestId);
    assert.equal(snapshot.outcomes.length, 1, 'a preflight receipt is persisted before the refusal');
    assert.equal(snapshot.outcomes[0].detail.phase, 'preflight');
    assert.equal(snapshot.outcomes[0].detail.outcome, 'not_sent', 'the existing destination-GET classification is preserved');
    assert.equal(snapshot.attempts, 0, 'no mutation attempt is recorded');
  }

  // Board: successful refresh persists applied evidence before its post-assert.
  {
    const f = boardFixture.fixture();
    t.after(() => f.state.close());
    const requestId = 'sequence-board-ok';
    const board = { content: 'old board' };
    const harness = buildHarness({ snapshot: () => boardSnapshot(f.state, requestId) });
    const result = await boardRun(f, 'new board', requestId, harness, board);
    assert.equal(result.status, BOARD_OUTCOMES.APPLIED);
    assertBracketed(harness.events, 'GET');
    const patchIndex = fetchEventIndex(harness.events, 'PATCH');
    assert.ok(patchIndex > 0, 'the refresh PATCHes once');
    assertBracketed(harness.events, 'PATCH');
    assert.equal(harness.events.at(-1).snapshot.applied, true, 'applied evidence is persisted before the post-assert');
  }

  // Board: applied evidence survives a post-assertion refusal with no resend.
  {
    const f = boardFixture.fixture();
    t.after(() => f.state.close());
    const requestId = 'sequence-board-post-refusal';
    const board = { content: 'old board' };
    const harness = buildHarness({
      snapshot: () => boardSnapshot(f.state, requestId),
      rejectWhen: ({ snapshot }) => snapshot.applied
    });
    let patches = 0;
    await assert.rejects(boardRun(f, 'new board', requestId, harness, board, {
      onPatch() { patches += 1; }
    }), REFUSAL);
    assert.equal(patches, 1, 'exactly one PATCH before the post-assertion refusal');
    const snapshot = boardSnapshot(f.state, requestId);
    assert.equal(snapshot.applied, true, 'applied evidence is retained');
    assert.equal(snapshot.outcomes.length, 1, 'applied evidence is saved exactly once');
    assert.equal(snapshot.outcomes[0].detail.outcome, 'applied');
  }

  // Board: each rejected GET refuses with no attempt or outcome and no later GET.
  for (const boundary of [1, 2, 3]) {
    const f = boardFixture.fixture();
    t.after(() => f.state.close());
    const requestId = `sequence-board-get-${boundary}`;
    const networkError = new Error(`board GET ${boundary} failed`);
    const harness = buildHarness({
      snapshot: () => boardSnapshot(f.state, requestId),
      rejectWhen: ({ fetchCount }) => fetchCount >= boundary
    });
    let gets = 0;
    await assert.rejects(boardRun(f, 'new board', requestId, harness, { content: 'old board' }, {
      onGet() { gets += 1; if (gets === boundary) throw networkError; }
    }), REFUSAL, `board GET ${boundary} refusal`);    assert.equal(gets, boundary, 'GETs stop at the rejected lookup');
    const snapshot = boardSnapshot(f.state, requestId);
    assert.equal(snapshot.attempts.length, 0, 'no admission after a rejected board GET');
    assert.equal(snapshot.outcomes.length, 0, 'no outcome after a rejected board GET');
  }

  // Board: a stable caller lets the original transport error propagate unchanged.
  {
    const f = boardFixture.fixture();
    t.after(() => f.state.close());
    const harness = buildHarness({ snapshot: () => boardSnapshot(f.state, 'sequence-board-stable') });
    const networkError = new Error('stable board transport failure');
    await assert.rejects(boardRun(f, 'new board', 'sequence-board-stable', harness, { content: 'old board' }, {
      onGet() { throw networkError; }
    }), error => { assert.strictEqual(error, networkError); return true; });
    const snapshot = boardSnapshot(f.state, 'sequence-board-stable');
    assert.equal(snapshot.attempts.length, 0);
    assert.equal(snapshot.outcomes.length, 0, 'no board preflight classification is persisted');
  }

  // Board: an admitted attempt whose caller switches before the PATCH records the
  // same attempt as stale known-unsent and issues zero PATCHes.
  {
    const f = boardFixture.fixture();
    t.after(() => f.state.close());
    const requestId = 'sequence-board-stale';
    const harness = buildHarness({
      snapshot: () => boardSnapshot(f.state, requestId),
      rejectWhen: ({ snapshot }) => snapshot.attempts.length > 0
    });
    let patches = 0;
    await assert.rejects(boardRun(f, 'new board', requestId, harness, { content: 'old board' }, {
      onPatch() { patches += 1; }
    }), REFUSAL);
    assert.equal(patches, 0, 'no PATCH after the caller changed before the mutation');
    const snapshot = boardSnapshot(f.state, requestId);
    assert.equal(snapshot.attempts.length, 1, 'the admitted attempt is retained');
    assert.equal(snapshot.outcomes.length, 1);
    assert.equal(snapshot.outcomes[0].detail.outcome, 'stale');
    assert.equal(snapshot.outcomes[0].detail.requestId, requestId, 'the request identity is retained');
    assert.equal(snapshot.outcomes[0].detail.revision, snapshot.attempts[0].detail.revision, 'the revision identity is retained');
  }

  // Board: historical and duplicate returns revalidate without network or
  // receipt change and disclose no result.
  for (const mode of ['historical', 'duplicate']) {
    const f = boardFixture.fixture();
    t.after(() => f.state.close());
    const requestId = `sequence-board-${mode}`;
    const seeded = boardFixture.seedBoardAttempt(f, requestId, 'new board');
    if (mode === 'historical') {
      f.state.recordBoardRefreshOutcome(seeded.target, seeded.attemptId, BOARD_OUTCOMES.APPLIED, {
        operationEndedAt: '2026-01-01T00:00:00.000Z'
      });
    }
    const before = JSON.stringify(boardFixtureBoardRows(f.state, requestId));
    const harness = buildHarness({
      snapshot: () => boardSnapshot(f.state, requestId),
      rejectWhen: () => true
    });
    await assert.rejects(boardRun(f, 'new board', requestId, harness, { content: 'old board' }), REFUSAL, `${mode} board return refusal`);
    assert.equal(harness.fetchCount(), 0, `no HTTP request on a ${mode} board return`);
    assert.equal(JSON.stringify(boardFixtureBoardRows(f.state, requestId)), before,
      `saved evidence is unchanged on a ${mode} board return`);
  }
});

test('the effect-owner inventory is sensitive to new or removed network calls and the suites are registered once', () => {
  const sources = realSources();
  assert.deepEqual(ownerViolations(sources), [], 'the real source passes the combined inventory');

  const mutants = [
    ['extra destination GET', 'src/direct-post.ts',
      'const sent = await sendDiscordMessage({',
      'await verifyAgentDestination({ token, agentTarget: deliveryTarget, fetchImpl, signal, timeoutMs });\n      const sent = await sendDiscordMessage({'],
    ['extra board GET', 'src/board-refresh.ts',
      '    remoteTarget = await fetchBoardTarget(',
      '    await fetchBoardChannel({ token, channelId, signal, timeoutMs, fetchImpl });\n    remoteTarget = await fetchBoardTarget('],
    ['extra POST', 'src/direct-post.ts',
      'const sent = await sendDiscordMessage({',
      "await sendDiscordMessage({ token, channelId: binding.channelId, content: 'x', nonce: 'n', signal, fetchImpl });\n      const sent = await sendDiscordMessage({"],
    ['extra PATCH', 'src/board-refresh.ts',
      'const patched = await patchBoardMessage(',
      'await patchBoardMessage({ token, channelId, messageId, content, signal, timeoutMs, fetchImpl });\n    const patched = await patchBoardMessage('],
    ['deleted public role assertion input', 'src/peer/post.js',
      '    bindingCurrent,\n    resolveBinding:',
      '    bindingCurrent, assertCallerCurrent: null,\n    resolveBinding:'],
    ['extra destination GET at the delivery-identity primitive', 'src/direct-post/delivery-identity.ts',
      '  const channel = await fetchDiscordChannel({',
      '  await fetchDiscordChannel({ token, channelId: agentTarget.channelId, fetchImpl, signal, timeoutMs });\n  const channel = await fetchDiscordChannel({'],
    ['raw fetch added to peer service', 'src/peer/service.js',
      '      const initial = await caller(signal);',
      "      await fetch('https://discord.com/api/v10/users/@me');\n      const initial = await caller(signal);"]
  ];
  const results = [];
  for (const [name, file, needle, replacement] of mutants) {
    const mutated = { ...sources };
    const before = mutated[file];
    assert.ok(before.includes(needle), `mutant ${name} target text is present`);
    mutated[file] = before.replace(needle, replacement);
    const violations = ownerViolations(mutated);
    assert.ok(violations.length > 0, `mutant ${name} must fail the inventory`);
    results.push(`${name}: ${violations.join(' | ')}`);
  }

  const pkg = require('../package.json');
  const files = pkg.scripts.test.split(/\s+/);
  for (const suite of ['test/peer-effect-revalidation.test.js', 'test/peer-effect-owner.test.js']) {
    assert.equal(files.filter(file => file === suite).length, 1, `${suite} is registered exactly once`);
  }

  const scratch = process.env.PEER_EFFECT_SCRATCH ||
    '/Users/cphamballer/Documents/Codex/2026-09-04/is-there-a-discord-mcp/outputs/peer-effect-source-131-1003/scratch';
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'owner-mutants.log'),
    `Issue 131 owner mutant results\n\n${results.join('\n')}\n\nregistration: both suites appear once in package.json scripts.test\n`);
});

// Board run helper local to this suite, so mutant checks never touch the
// worktree and runtime fixtures stay disposable.
async function boardRun(f, content, requestId, harness, board, hooks = {}) {
  const { runBoardRefresh } = require('../src/board-refresh');
  const { response } = require('./board-refresh-fixture');
  fs.writeFileSync(f.textFile, content);
  const binding = f.state.getBinding('channel-1');
  const fetchImpl = harness.wrapFetch(async (url, init = {}) => {
    if (url.endsWith('/users/@me')) { hooks.onGet?.('installation'); return response({ id: 'bot-1' }); }
    if (init.method === 'GET' && url.endsWith('/channels/channel-1')) { hooks.onGet?.('channel'); return response({ id: 'channel-1', guild_id: 'guild-1' }); }
    if (init.method === 'GET') { hooks.onGet?.('target'); return response({ id: 'target-1', channel_id: 'channel-1', author: { id: 'bot-1', bot: true }, content: board.content }); }
    if (init.method === 'PATCH') {
      hooks.onPatch?.();
      const body = JSON.parse(init.body);
      board.content = body.content;
      return response({ id: 'target-1', channel_id: 'channel-1', author: { id: 'bot-1', bot: true }, content: board.content });
    }
    hooks.onAny?.();
    throw new Error(`unexpected board request ${init.method} ${url}`);
  });
  try {
    return await runBoardRefresh({
      state: f.state,
      token: 'fixture-token',
      nativeId: binding.nativeId,
      generation: binding.generation,
      channelId: 'channel-1',
      messageId: 'target-1',
      textFile: f.textFile,
      dedupeKey: requestId,
      fetchImpl,
      timeoutMs: 1000,
      resolveBinding: state => state.getBinding('channel-1'),
      assertCallerCurrent: harness.assertCallerCurrent
    });
  } finally {
    hooks.onAny?.();
  }
}

function boardFixtureBoardRows(state, requestId) {
  return state.listReceipts()
    .map(row => ({ kind: row.kind, detail: row.detail }))
    .filter(row => row.kind.startsWith('board-refresh') && JSON.parse(row.detail).requestId === requestId);
}
