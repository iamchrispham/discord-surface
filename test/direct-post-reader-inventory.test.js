'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

require('../src/state');

const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');
const QUERIES_PATH = path.join(DIST_ROOT, 'state', 'direct-post', 'receipt-queries.js');
const BARREL_PATH = path.join(DIST_ROOT, 'state', 'direct-post.js');
const RESULT_PATH = path.resolve(SRC_ROOT, 'peer', 'result.js');
const READER_CALLEES = new Set(['directPostRows', 'queryDirectPostRows']);

// Frozen reader inventory for PR109 F2. Owner keys are `<src-relative path>\0<enclosing function>`.
const ADOPTING_OWNERS = new Map([
  ['peer/result.js\u0000inspectPeerResult', 1],
  ['state/direct-post.ts\u0000inspectPart', 1],
  ['state/direct-post.ts\u0000hasUnresolvedOrdinaryPost', 1]
]);
const EXCLUDED_OWNERS = new Map([
  ['state/agent-routing.ts\u0000legacyParentSourcedReceipt', 1],
  ['state/direct-post.ts\u0000releaseDirectPostFilePreparation', 2],
  ['state/direct-post.ts\u0000recordDirectPostPreflight', 1],
  ['state/direct-post.ts\u0000recordDirectPostOutcome', 1],
  ['state/direct-post.ts\u0000reconcileDirectPostOutcome', 1],
  ['state.js\u0000recoverDirectPostReceiptsInternal', 1]
]);
const FACADE_OWNER = 'state.js\u0000directPostRows';

function sourceFiles(root) {
  const found = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|ts)$/.test(entry.name)) found.push(full);
    }
  };
  walk(root);
  return found;
}

// Walk up from a call expression to the nearest enclosing named function or object method.
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

// Parse one source text and return every directPostRows/queryDirectPostRows call expression.
function parseReaders(fileName, text) {
  const kind = fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const readers = [];
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const callee = ts.isIdentifier(expression) ? expression.text
        : (ts.isPropertyAccessExpression(expression) ? expression.name.text : null);
      if (READER_CALLEES.has(callee)) {
        readers.push({ file: fileName, callee, owner: enclosingOwner(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return readers;
}

function enumerateReaders(root) {
  const readers = [];
  for (const full of sourceFiles(root)) {
    const relative = path.relative(root, full).split(path.sep).join('/');
    readers.push(...parseReaders(relative, fs.readFileSync(full, 'utf8')));
  }
  return readers;
}

// Any directPostRows caller not named here makes the pin fail, by design.
function classifyReaders(readers) {
  const adopting = new Map();
  const excluded = new Map();
  const facade = [];
  for (const reader of readers) {
    if (reader.callee === 'queryDirectPostRows') {
      assert.equal(`${reader.file}\u0000${reader.owner}`, FACADE_OWNER,
        `unclassified queryDirectPostRows caller: ${reader.file}:${reader.owner}`);
      facade.push(reader);
      continue;
    }
    const key = `${reader.file}\u0000${reader.owner}`;
    const bucket = ADOPTING_OWNERS.has(key) ? adopting : (EXCLUDED_OWNERS.has(key) ? excluded : null);
    if (!bucket) throw new Error(`unclassified directPostRows reader: ${reader.file}:${reader.owner}`);
    bucket.set(key, (bucket.get(key) || 0) + 1);
  }
  return { adopting, excluded, facade };
}

test('reader inventory classifies exactly the adopted, excluded and facade owners', () => {
  const readers = enumerateReaders(SRC_ROOT);
  const direct = readers.filter(reader => reader.callee === 'directPostRows');
  const facadeCalls = readers.filter(reader => reader.callee === 'queryDirectPostRows');
  assert.equal(direct.length, 10, 'directPostRows call expression count');
  assert.equal(facadeCalls.length, 1, 'queryDirectPostRows facade call count');
  const { adopting, excluded, facade } = classifyReaders(readers);
  assert.deepEqual(adopting, ADOPTING_OWNERS);
  assert.deepEqual(excluded, EXCLUDED_OWNERS);
  assert.equal(facade.length, 1);
  assert.equal(facade[0].file, 'state.js');
  assert.equal(facade[0].owner, 'directPostRows');
});

test('reader inventory rejects an unclassified new reader', () => {
  const syntheticFile = 'state/direct-post.ts';
  const synthetic = [
    'function newlyAddedReader(state: DirectPostState): void {',
    '  state.directPostRows("new-request");',
    '}'
  ].join('\n');
  const readers = parseReaders(syntheticFile, synthetic);
  assert.equal(readers.length, 1);
  assert.equal(readers[0].owner, 'newlyAddedReader');
  assert.throws(() => classifyReaders(readers), /unclassified directPostRows reader: state\/direct-post\.ts:newlyAddedReader/);
  // The real tree must stay fully classified at the same time.
  assert.doesNotThrow(() => classifyReaders(enumerateReaders(SRC_ROOT)));
});

// --- Helper sentinel: load a consumer with a fake receipt-owner helper and prove
// --- each consumer follows the projected evidence instead of raw re-selection.

function withMockedProjection(project, load) {
  const real = require(QUERIES_PATH);
  const fake = {
    ...real,
    projectNewestDirectPostAttempt: (...args) => project(...args)
  };
  const originalLoad = Module._load;
  const saved = new Map();
  for (const file of [QUERIES_PATH, BARREL_PATH, RESULT_PATH]) {
    if (require.cache[file]) {
      saved.set(file, require.cache[file]);
      delete require.cache[file];
    }
  }
  Module._load = function mockedLoad(request, parent, isMain) {
    if (parent && parent.filename) {
      let resolved = null;
      try { resolved = Module._resolveFilename(request, parent, isMain); } catch { resolved = null; }
      if (resolved === QUERIES_PATH) return fake;
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return load();
  } finally {
    Module._load = originalLoad;
    for (const file of [QUERIES_PATH, BARREL_PATH, RESULT_PATH]) delete require.cache[file];
    for (const [file, cached] of saved) require.cache[file] = cached;
  }
}

function handlerDependencies() {
  return {
    BindingError: class BindingError extends Error {},
    StaleGenerationError: class StaleGenerationError extends Error {},
    StateCorruptError: class StateCorruptError extends Error {},
    DIRECT_POST_ATTEMPT: 'direct-post-attempt',
    DIRECT_POST_OUTCOME: 'direct-post-outcome',
    DIRECT_POST_FILE_PREPARATION: 'direct-post-file-preparation',
    DIRECT_POST_OUTCOMES: ['sent', 'not_sent', 'rejected', 'rate_limited', 'unknown', 'stale'],
    assertText(value, name, max = 512) {
      if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new TypeError(`${name} invalid`);
      return value;
    },
    bindingMatchesExpected: () => true,
    parseJson(value, fallback) {
      if (typeof value !== 'string') return fallback;
      try { return JSON.parse(value); } catch { return fallback; }
    },
    now: () => '2026-09-26T00:00:00.000Z'
  };
}

function inspectPartState(rows) {
  return {
    transaction: operation => operation(),
    isAgentResultForWithdrawnRequest: () => false,
    directPostBindingCurrent: () => true,
    directPostRows: () => rows.map(row => ({ ...row, detail: { ...row.detail } }))
  };
}

test('inspectDirectPostPart follows the projected attempt instead of raw rows', () => {
  const meta = {
    requestId: 'request-1', attemptId: 'projected-attempt', sourcePath: '/tmp/source.md',
    textHash: 'text-hash', operatorId: 'operator-1', partHash: 'part-hash',
    channelId: 'channel-1', guildId: 'guild-1', provider: 'codex',
    nativeId: '9caa5d21-2169-429d-918b-5f08651b5dbd', generation: 1,
    conductorId: null, repoKey: null, partIndex: 0, partCount: 1, nonce: 'projected-nonce',
    binding: { active: true, channelId: 'channel-1', guildId: 'guild-1', provider: 'codex',
      nativeId: '9caa5d21-2169-429d-918b-5f08651b5dbd', generation: 1 }
  };
  const rawAttempt = { journal: 'direct-post-v1', ...meta, attemptId: 'stale-attempt', status: 'attempted' };
  const rows = [
    { id: 1, kind: 'direct-post-attempt', detail: rawAttempt },
    { id: 2, kind: 'direct-post-outcome', detail: { ...rawAttempt, attemptId: 'stale-attempt', outcome: 'rate_limited' } }
  ];
  const projection = {
    attempt: { id: 9, kind: 'direct-post-attempt', detail: { attemptId: 'projected-attempt', nonce: 'projected-nonce', partIndex: 0 } },
    outcome: null,
    latestPreflight: null
  };
  const result = withMockedProjection(() => projection, () => {
    const { createDirectPostHandlers } = require(BARREL_PATH);
    return createDirectPostHandlers(handlerDependencies()).inspectDirectPostPart(inspectPartState(rows), meta);
  });
  // Raw rows alone would resolve the only attempt as rate_limited (not claimed, null status).
  assert.deepEqual(result, { claimed: false, status: 'in_flight', attemptId: 'projected-attempt', nonce: 'projected-nonce' });
});

function ordinaryState(rows) {
  return { directPostRows: () => rows.map(row => ({ ...row, detail: { ...row.detail } })) };
}

test('hasUnresolvedOrdinaryPost follows the projected outcome instead of raw rows', () => {
  const attempt = {
    requestId: 'ordinary-request', attemptId: 'ordinary-attempt', channelId: 'ordinary-channel',
    provider: 'codex', conductorId: null, repoKey: null, partIndex: 0, partCount: 1, nonce: 'ordinary-nonce'
  };
  const rows = [
    { id: 1, kind: 'direct-post-attempt', detail: { journal: 'direct-post-v1', ...attempt } },
    { id: 2, kind: 'direct-post-outcome', detail: { journal: 'direct-post-v1', ...attempt, outcome: 'unknown' } }
  ];
  const projection = {
    attempt: { id: 1, kind: 'direct-post-attempt', detail: rows[0].detail },
    outcome: { id: 2, kind: 'direct-post-outcome', detail: { ...attempt, outcome: 'sent' } },
    latestPreflight: null
  };
  const unresolved = withMockedProjection(() => projection, () => {
    const { createDirectPostHandlers } = require(BARREL_PATH);
    return createDirectPostHandlers(handlerDependencies()).hasUnresolvedOrdinaryPost(ordinaryState(rows), 'ordinary-channel');
  });
  // Raw rows hold an unknown outcome for the represented part, so a raw re-selection would fence retirement.
  assert.equal(unresolved, false);
});

const PACKET_SOURCE = { guildId: '100', channelId: '101', provider: 'claude', nativeId: '11111111-1111-1111-1111-111111111111', generation: 1 };
const PACKET_TARGET = { guildId: '100', channelId: '201', provider: 'codex', nativeId: '22222222-2222-2222-2222-222222222222', generation: 1 };
const PACKET = { id: 'correlation-1', kind: 'request', source: PACKET_SOURCE, target: PACKET_TARGET, replyTo: null, text: 'inspect the failure' };

test('inspectPeerResult follows the projected attempt instead of raw outcome rows', () => {
  const rows = [
    { id: 1, kind: 'direct-post-attempt', detail: { journal: 'direct-post-v1', requestId: 'peer-request',
      attemptId: 'peer-attempt', nativeId: PACKET_SOURCE.nativeId, provider: PACKET_SOURCE.provider,
      generation: PACKET_SOURCE.generation, guildId: PACKET_SOURCE.guildId, partIndex: 0, partCount: 1, agentPacket: PACKET } },
    { id: 2, kind: 'direct-post-outcome', detail: { journal: 'direct-post-v1', requestId: 'peer-request',
      attemptId: 'peer-attempt', outcome: 'rate_limited', nativeId: PACKET_SOURCE.nativeId, provider: PACKET_SOURCE.provider,
      generation: PACKET_SOURCE.generation, guildId: PACKET_SOURCE.guildId, agentPacket: PACKET } }
  ];
  const projection = {
    attempt: { id: 1, kind: 'direct-post-attempt', detail: rows[0].detail },
    outcome: null,
    latestPreflight: null
  };
  const state = {
    directPostRows: () => rows.map(row => ({ ...row, detail: { ...row.detail } })),
    listAgentMessageReceiptIds: () => []
  };
  const result = withMockedProjection(() => projection, () => {
    const { inspectPeerResult } = require(RESULT_PATH);
    return inspectPeerResult(state, PACKET_SOURCE, PACKET.id);
  });
  // The newest raw outcome row is rate_limited; the projection says the newest admitted attempt is unresolved.
  assert.equal(result.sendOutcome, 'in_flight');
});
