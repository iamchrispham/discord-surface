'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SurfaceState } = require('../src/state');
const { DiscordGateway } = require('../src/discord');
const {
  NATIVE_PROOF_PHASES,
  nativeProofDeadlineDetail
} = require('../src/discord/native-proof-recovery');
const { tempDir, grant } = require('./helpers/qualified-adoption-fixture');

async function nativeProofRecovery(t, { cutoff, nullCursor = false, hasMessage = true }) {
  const dir = tempDir('qualified-native-proof-');
  const root = path.join(dir, 'sessions');
  fs.mkdirSync(root);
  const nativeId = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(root, `${nativeId}.jsonl`), `${JSON.stringify({
    type: 'session_meta', payload: { id: nativeId, cwd: dir }
  })}\n`);
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'unused') });
  state.bindOrdinary({
    channelId: '1000', guildId: 'guild', provider: 'codex', nativeId, workspace: dir
  }, { sessionId: nativeId, threadId: nativeId }, cutoff);
  state.setIntakeBaseline('1000', cutoff, 'fixture baseline');
  if (hasMessage) {
    state.acceptDiscordMessage({
      id: '101', channelId: '1000', guildId: 'guild', authorId: 'operator', isBot: false, content: 'retained'
    }, { ready: false });
  }
  if (nullCursor) {
    state.db.prepare('UPDATE intake_watermarks SET recovered_through_id=NULL WHERE channel_id=?').run('1000');
  }
  state.markIntakeBoundary('1000', 'unavailable',
    nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.BEFORE_BINDING, Date.now() - 1));
  const stats = { historyReads: 0, dispatches: 0 };
  let channel;
  channel = {
    id: '1000', guildId: 'guild', topic: null, permissionsFor: () => grant(true),
    messages: { async fetch() { return { async react() {} }; } },
    async send() { return { id: 'reply-101' }; }
  };
  let gateway;
  const options = {
    state,
    client: {
      user: { id: 'bot' },
      channels: { fetch: async () => channel },
      application: { commands: { async fetch() { return []; }, async create() {} } },
      async login() {}, on() {}, off() {}, async destroy() {}
    },
    fetchHistory: async (_channel, opts) => {
      stats.historyReads += 1;
      return BigInt(opts.after || '0') < 101n
        ? [{ id: '101', channelId: '1000', guildId: 'guild', content: 'retained', author: { id: 'operator', bot: false }, channel }]
        : [];
    },
    providers: {
      codex: {
        async dispatch() { stats.dispatches += 1; return { status: 'submitted' }; },
        async observe() { return { text: 'answer' }; }
      }
    },
    recoveryOptions: {
      ordinaryNativePreflight: async () => ({ sessionId: nativeId, threadId: nativeId, workspace: dir, file: path.join(root, `${nativeId}.jsonl`) })
    }
  };
  gateway = new DiscordGateway({ ...options, state });
  t.after(async () => {
    await gateway.stop();
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { state, gateway, stats };
}

test('historical native-proof retry without a cursor cannot exclude newest history', { timeout: 8000 }, async t => {
  const { state, gateway, stats } = await nativeProofRecovery(t, { cutoff: '100', nullCursor: true });
  await gateway.recoverInbound(new AbortController().signal, 'reconnect', gateway.lifecycleEpoch, null, Date.now() - 1);
  const watermark = state.getIntakeWatermark('1000');
  assert.equal(watermark.recovered_through_id, null, 'retained newest history must never become coverage');
  assert.match(watermark.detail, /Native proof recovery v1:/, 'the typed no-cursor boundary must be preserved');
  assert.equal(stats.dispatches, 0);
  assert.equal(state.getMessage('101')?.state, 'accepted', 'retained custody must stay accepted');
  assert.equal(stats.historyReads, 0, 'a no-cursor historical parent refuses before any history request');
});

test('prospective zero native-proof retry retains zero coverage', { timeout: 8000 }, async t => {
  const { state, gateway, stats } = await nativeProofRecovery(t, { cutoff: '0' });
  await gateway.recoverInbound(new AbortController().signal, 'reconnect', gateway.lifecycleEpoch, null, Date.now() + 5000);
  const watermark = state.getIntakeWatermark('1000');
  assert.equal(watermark.recovered_through_id, '101', 'a prospective covered route resumes from its committed "0"');
  assert.equal(watermark.state, 'ready');
  assert.equal(stats.dispatches, 0);
  assert.equal(state.getMessage('101')?.state, 'accepted');
});

test('prospective covered native-proof retry retains its historical bound', { timeout: 8000 }, async t => {
  const { state, gateway, stats } = await nativeProofRecovery(t, { cutoff: '100' });
  await gateway.recoverInbound(new AbortController().signal, 'reconnect', gateway.lifecycleEpoch, null, Date.now() + 5000);
  const watermark = state.getIntakeWatermark('1000');
  assert.equal(watermark.recovered_through_id, '101', 'a covered retry advances only from its committed bound');
  assert.equal(watermark.state, 'ready');
  assert.equal(stats.dispatches, 0);
  assert.equal(state.getMessage('101')?.state, 'accepted');
});

// ---------------------------------------------------------------------------
// Case 33: adoption owner inventory pin.
// ---------------------------------------------------------------------------

const EXPECTED_CREATORS = [
  'src/cli/binding-commands.js|bind|state|bind',
  'src/cli/provision-commands.js|provisionInternal|state|bind',
  'src/discord/thread-enrollment.ts|enrollPublicThread|state|enrollThread',
  'src/ordinary-bind/codex.js|ordinaryBind|state|bindOrdinary',
  'src/ordinary-bind/index.js|ordinaryClaudeBind|state|bindOrdinaryClaude',
  'src/ordinary/index.js|bindOrdinary|state|_bindOrdinary',
  'src/ordinary/index.js|bindOrdinaryClaude|state|_bindOrdinaryClaude',
  'src/state.js|bindOrdinary|this|_bindOrdinary',
  'src/state.js|bindOrdinaryClaude|this|_bindOrdinaryClaude',
  'src/state.js|_bindOrdinary|ordinaryBindingHandlers|bindOrdinary',
  'src/state.js|_bindOrdinaryClaude|ordinaryClaudeBindingHandlers|bindOrdinaryClaude',
  'src/state.js|enrollThread|threadEnrollmentHandlers|enrollThread',
  'src/state/ordinary-binding-claude.ts|bindOrdinaryClaude|state|bind',
  'src/state/ordinary-binding.ts|bindOrdinary|state|bind'
];

const EXPECTED_MESSAGES_FETCH = [
  'src/discord.js|constructor|channel.messages',
  'src/discord.js|projectDecisionMessage|channel?.messages',
  'src/discord/transport-receipts.js|reactToFetchedMessage|message.channel.messages',
  'src/discord/handoff-fence.ts|assertEnrolledThreadIntakeRange|channel.messages',
  'src/discord/handoff-fence.ts|assertOrdinaryIntakeRange|channel.messages!',
  'src/discord/history-access.ts|readAdoptionCutoff|channel.messages',
  'src/discord/transport-receipts.js|issueTransportReceipt|source.channel?.messages'
];

const EXPECTED_FETCH_HISTORY = [
  'src/discord.js|checkpointHealthyIntake|this',
  'src/discord.js|recoverInbound|this',
  'src/discord/thread-enrollment.ts|readHistory|gateway'
];

// Function.prototype.bind exclusions, from the committed exclusion census.
const EXCLUDED_BINDS = new Set([
  'src/agent-attachment.ts|defaultFetch|fetchImpl',
  'src/discord/handoff-fence.ts|assertEnrolledThreadIntakeRange|client?.channels?.fetch',
  'src/state/courier-route/index.ts|createCourierRouteHandlers|claimCourierForward',
  'src/state/courier-route/index.ts|createCourierRouteHandlers|recoverCourierAttempt',
  'src/state/courier-route/index.ts|createCourierRouteHandlers|getCourierDeliveryStatus'
]);

const RECOGNIZED_BIND_RECEIVERS = new Set(['state', 'this']);

function inventoryParser() {
  return require('typescript');
}

function sourceFiles(root) {
  const found = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|ts)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) found.push(full);
    }
  };
  walk(root);
  return found;
}

function relativeSourceFiles(workspaceRoot) {
  return sourceFiles(path.join(workspaceRoot, 'src')).map(file =>
    path.relative(workspaceRoot, file).split(path.sep).join('/')).sort();
}

function ownerOf(ts, node) {
  const isFunctionLike = n => ts.isArrowFunction(n) || ts.isFunctionExpression(n);
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name) return current.name.text;
    if (ts.isConstructorDeclaration(current)) return 'constructor';
    if (ts.isPropertyAssignment(current) && current.name && current.initializer && isFunctionLike(current.initializer)) {
      return current.name.getText();
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer &&
        isFunctionLike(current.initializer)) {
      return current.name.text;
    }
    current = current.parent;
  }
  return '<module>';
}

function unwrap(ts, expression) {
  let current = expression;
  while (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function calleeInfo(ts, call) {
  const expression = unwrap(ts, call.expression);
  if (ts.isPropertyAccessExpression(expression)) {
    return { receiver: expression.expression.getText(), method: expression.name.text };
  }
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
      return { receiver: expression.expression.getText(), method: argument.text };
    }
  }
  return null;
}

function isMessagesFetch(info) {
  if (!info || info.method !== 'fetch' || !/messages/.test(info.receiver)) return false;
  return /(^|[.?!])messages!?$/.test(info.receiver.replace(/\?\./g, '.'));
}

function scanInventory(entries) {
  const ts = inventoryParser();
  const creators = [];
  const messagesFetch = [];
  const fetchHistory = [];
  const unclassifiedBinds = [];
  for (const { file, text } of entries) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
      file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const visit = node => {
      if (ts.isCallExpression(node)) {
        const info = calleeInfo(ts, node);
        if (info) {
          const owner = ownerOf(ts, node);
          if (info.method === 'bind') {
            const tuple = `${file}|${owner}|${info.receiver}`;
            if (!EXCLUDED_BINDS.has(tuple)) {
              if (!RECOGNIZED_BIND_RECEIVERS.has(info.receiver)) unclassifiedBinds.push(tuple);
              creators.push(`${tuple}|bind`);
            }
          } else if (['bindOrdinary', 'bindOrdinaryClaude', '_bindOrdinary', '_bindOrdinaryClaude', 'enrollThread'].includes(info.method)) {
            creators.push(`${file}|${owner}|${info.receiver}|${info.method}`);
          }
          if (isMessagesFetch(info)) messagesFetch.push(`${file}|${owner}|${info.receiver}`);
          if (info.method === 'fetchHistory') fetchHistory.push(`${file}|${owner}|${info.receiver}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return {
    creators: creators.slice().sort(),
    messagesFetch: messagesFetch.slice().sort(),
    fetchHistory: fetchHistory.slice().sort(),
    unclassifiedBinds: unclassifiedBinds.slice().sort()
  };
}

function realInventoryEntries(workspaceRoot) {
  return relativeSourceFiles(workspaceRoot).map(file => ({
    file,
    text: fs.readFileSync(path.join(workspaceRoot, file), 'utf8')
  }));
}

// ---------------------------------------------------------------------------
// Claude owner structural census helpers (AST only: file + factory/class + method).
// ---------------------------------------------------------------------------

const CLAUDE_OWNER = 'src/state/ordinary-binding-claude.ts';
const CODEX_OWNER = 'src/state/ordinary-binding.ts';
const CLAUDE_FACTORY = 'createOrdinaryClaudeBindingHandlers';

const CLAUDE_HANDLER_METHODS = [
  'bindOrdinaryClaude',
  'rebindOrdinaryClaude',
  'isOrdinaryBindingRecord',
  'isOrdinaryBinding',
  'hasOrdinaryPreflight',
  'recordOrdinaryPreflight'
];

const FACADE_TO_HANDLER = {
  _bindOrdinaryClaude: 'bindOrdinaryClaude',
  _rebindOrdinaryClaude: 'rebindOrdinaryClaude',
  _isOrdinaryBindingRecord: 'isOrdinaryBindingRecord',
  _isOrdinaryBinding: 'isOrdinaryBinding',
  _hasOrdinaryPreflight: 'hasOrdinaryPreflight',
  _recordOrdinaryPreflight: 'recordOrdinaryPreflight'
};

const SQL_FREE_METHODS = [...Object.keys(FACADE_TO_HANDLER), ...CLAUDE_HANDLER_METHODS];

const RECEIPT_KINDS = new Set(['BOUND', 'NATIVE_PREFLIGHT']);

const EXPECTED_RECEIPT_SITES = [
  `${CODEX_OWNER}|hasOrdinaryBindingReceipt|ORDINARY_RECEIPT_KINDS.BOUND`,
  `${CODEX_OWNER}|hasOrdinaryPreflightReceipt|ORDINARY_RECEIPT_KINDS.NATIVE_PREFLIGHT`,
  `${CODEX_OWNER}|recordOrdinaryPreflight|ORDINARY_RECEIPT_KINDS.NATIVE_PREFLIGHT`,
  `${CODEX_OWNER}|handoffOrdinary|ORDINARY_RECEIPT_KINDS.BOUND`,
  'src/state/binding-lifecycle.js|bind|ORDINARY_RECEIPT_KINDS.BOUND',
  'src/state/binding-lifecycle.js|rebind|ORDINARY_RECEIPT_KINDS.BOUND',
  `${CLAUDE_OWNER}|recordOrdinaryPreflight|ORDINARY_RECEIPT_KINDS.NATIVE_PREFLIGHT`
];

const EXPECTED_HELPER_CALLS = [
  `${CODEX_OWNER}|rebindOrdinary|isOrdinaryBindingRecord`,
  `${CODEX_OWNER}|handoffOrdinary|isOrdinaryBindingRecord`,
  `${CODEX_OWNER}|isOrdinaryBindingRecord|hasOrdinaryBindingReceipt`,
  `${CODEX_OWNER}|isOrdinaryBinding|hasOrdinaryBindingReceipt`,
  `${CODEX_OWNER}|hasOrdinaryPreflight|hasOrdinaryPreflightReceipt`,
  `${CLAUDE_OWNER}|isOrdinaryBindingRecord|hasOrdinaryBindingReceipt`,
  `${CLAUDE_OWNER}|isOrdinaryBinding|isOrdinaryBindingRecord`,
  `${CLAUDE_OWNER}|hasOrdinaryPreflight|hasOrdinaryPreflightReceipt`,
  `${CLAUDE_OWNER}|rebindOrdinaryClaude|isOrdinaryBindingRecord`
];

function parseEntry(ts, entry) {
  return ts.createSourceFile(entry.file, entry.text, ts.ScriptTarget.Latest, true,
    entry.file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
}

function findClass(ts, source, name) {
  let found = null;
  const visit = node => {
    if (ts.isClassDeclaration(node) && node.name && node.name.text === name) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function classMethods(ts, classNode) {
  return classNode.members.filter(member => ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name));
}

function walkNodes(ts, root, visit) {
  visit(root);
  ts.forEachChild(root, child => walkNodes(ts, child, visit));
}

function callsIn(ts, node) {
  const calls = [];
  walkNodes(ts, node, current => { if (ts.isCallExpression(current)) calls.push(current); });
  return calls;
}

function constantStringExpression(ts, expression) {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (!ts.isTemplateExpression(expression)) return null;
  let value = expression.head.text;
  for (const span of expression.templateSpans) {
    const interpolation = constantStringExpression(ts, span.expression);
    if (interpolation === null) return null;
    value += interpolation + span.literal.text;
  }
  return value;
}

function claudeFactoryMethods(ts, source) {
  let factory = null;
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === CLAUDE_FACTORY) factory = node;
    if (!factory) ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(factory, `${CLAUDE_FACTORY} must exist in ${CLAUDE_OWNER}`);
  let objectLiteral = null;
  walkNodes(ts, factory, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'handlers' &&
      node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      objectLiteral = node.initializer;
    }
  });
  assert.ok(objectLiteral, `the ${CLAUDE_FACTORY} handlers object literal must exist`);
  return objectLiteral.properties
    .filter(property => (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) &&
      property.name && ts.isIdentifier(property.name))
    .map(property => property.name.text);
}

function facadeClaudeCensus(ts, facade) {
  return classMethods(ts, facade).map(member => member.name.text).filter(name => name.includes('Claude')).sort();
}

function facadeDelegates(ts, facade) {
  const delegates = [];
  for (const member of classMethods(ts, facade)) {
    const owner = member.name.text;
    for (const call of callsIn(ts, member)) {
      const info = calleeInfo(ts, call);
      if (info && info.receiver === 'ordinaryClaudeBindingHandlers') {
        delegates.push(`${owner}->${info.method}`);
      }
    }
  }
  return delegates.sort();
}

function receiptSites(ts, entries) {
  const sites = [];
  for (const entry of entries) {
    const source = parseEntry(ts, entry);
    walkNodes(ts, source, node => {
      if (ts.isCallExpression(node)) {
        const info = calleeInfo(ts, node);
        const kind = node.arguments[1];
        const kindText = kind && constantStringExpression(ts, kind);
        if (info?.method === 'receipt' &&
          ['ordinary-bound', 'ordinary-native-preflight'].includes(kindText)) {
          sites.push(`${entry.file}|${ownerOf(ts, node)}|${info.receiver}.receipt|literal:${kindText}`);
        }
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === 'ORDINARY_RECEIPT_KINDS' && RECEIPT_KINDS.has(node.name.text)) {
        sites.push(`${entry.file}|${ownerOf(ts, node)}|ORDINARY_RECEIPT_KINDS.${node.name.text}`);
      }
    });
  }
  return sites.sort();
}

function helperCalls(ts, entries) {
  const calls = [];
  for (const entry of entries) {
    if (entry.file !== CLAUDE_OWNER && entry.file !== CODEX_OWNER) continue;
    const source = parseEntry(ts, entry);
    walkNodes(ts, source, node => {
      if (!ts.isCallExpression(node)) return;
      const expression = unwrap(ts, node.expression);
      let method = null;
      let receiver = null;
      if (ts.isIdentifier(expression)) method = expression.text;
      else {
        const info = calleeInfo(ts, node);
        if (info) { method = info.method; receiver = info.receiver; }
      }
      if (!method) return;
      const shared = method === 'hasOrdinaryBindingReceipt' || method === 'hasOrdinaryPreflightReceipt';
      const delegate = (method === 'isOrdinaryBindingRecord' || method === '_isOrdinaryBindingRecord') &&
        (receiver === 'handlers' || receiver === 'this' || receiver === 'state');
      if (shared || delegate) calls.push(`${entry.file}|${ownerOf(ts, node)}|${method.replace(/^_/, '')}`);
    });
  }
  return calls.sort();
}

function sqlFindings(ts, source, file, methodNames) {
  const findings = [];
  walkNodes(ts, source, current => {
    let text = null;
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) text = current.text;
    else if (ts.isTemplateExpression(current)) text = current.getText();
    if (text !== null && /receipts/.test(text) && /kind/.test(text) && methodNames.has(ownerOf(ts, current))) {
      findings.push(`${file}|${ownerOf(ts, current)}|receipt SQL literal`);
    }
    if (ts.isCallExpression(current)) {
      const info = calleeInfo(ts, current);
      if (info && info.method === 'prepare' && /(^|\.)db$/.test(info.receiver.replace(/\?\./g, '.')) &&
        methodNames.has(ownerOf(ts, current))) {
        findings.push(`${file}|${ownerOf(ts, current)}|db.prepare`);
      }
    }
  });
  return findings;
}

function renderClaudeInventory(ts, entries) {
  const claudeEntry = entries.find(entry => entry.file === CLAUDE_OWNER);
  const facadeEntry = entries.find(entry => entry.file === 'src/state.js');
  assert.ok(claudeEntry, `${CLAUDE_OWNER} must be scanned from source`);
  assert.ok(facadeEntry, 'src/state.js must be scanned from source');
  const claudeSource = parseEntry(ts, claudeEntry);
  const facade = findClass(ts, parseEntry(ts, facadeEntry), 'SurfaceState');
  assert.ok(facade, 'SurfaceState class must exist in src/state.js');
  const sqlMethods = new Set(SQL_FREE_METHODS);
  return {
    factoryMethods: claudeFactoryMethods(ts, claudeSource).sort(),
    claudeNames: facadeClaudeCensus(ts, facade),
    delegates: facadeDelegates(ts, facade),
    receiptSites: receiptSites(ts, entries),
    helperCalls: helperCalls(ts, entries),
    sqlFindings: [
      ...sqlFindings(ts, claudeSource, CLAUDE_OWNER, sqlMethods),
      ...sqlFindings(ts, parseEntry(ts, facadeEntry), 'src/state.js', sqlMethods)
    ]
  };
}

test('adoption owner inventory rejects an added private creator or history reader', { timeout: 8000 }, () => {
  const workspaceRoot = path.join(__dirname, '..');
  const entries = realInventoryEntries(workspaceRoot);
  // The new shared reader lives under src; assert it is actually scanned from disk.
  const reader = entries.find(entry => entry.file === 'src/discord/history-access.ts');
  assert.ok(reader, 'the new shared reader must be scanned from source, not build output');

  const real = scanInventory(entries);
  assert.deepEqual(real.unclassifiedBinds, [], 'an unrecognized bind() receiver is a failure');
  assert.deepEqual(real.creators, EXPECTED_CREATORS.slice().sort(),
    'creator multiset must match exactly the fourteen production tuples');
  assert.deepEqual(real.messagesFetch, EXPECTED_MESSAGES_FETCH.slice().sort(),
    'direct messages.fetch multiset must match exactly the seven accepted entries');
  assert.deepEqual(real.fetchHistory, EXPECTED_FETCH_HISTORY.slice().sort(),
    'fetchHistory multiset must match exactly the three accepted entries');

  // Mutant 1: an unreachable extra state.bind()-shaped creator must fail the scan.
  const creatorMutantEntries = entries.map(entry => entry.file === 'src/cli.js'
    ? { ...entry, text: `${entry.text}\nfunction scanMutantUnreachable() { state.bind({}); }\n` }
    : entry);
  const creatorMutant = scanInventory(creatorMutantEntries);
  assert.notDeepEqual(creatorMutant.creators, EXPECTED_CREATORS.slice().sort(),
    'an added private creator must fail the inventory');
  assert.equal(creatorMutant.creators.length, EXPECTED_CREATORS.length + 1);

  // Mutant 2: an unreachable extra messages.fetch()-shaped reader must fail the scan.
  const readerMutantEntries = entries.map(entry => entry.file === 'src/discord/history-access.ts'
    ? { ...entry, text: `${entry.text}\nfunction scanMutantUnreachable() { channel.messages.fetch({ limit: 1 }); }\n` }
    : entry);
  const readerMutant = scanInventory(readerMutantEntries);
  assert.notDeepEqual(readerMutant.messagesFetch, EXPECTED_MESSAGES_FETCH.slice().sort(),
    'an added private history reader must fail the inventory');
  assert.equal(readerMutant.messagesFetch.length, EXPECTED_MESSAGES_FETCH.length + 1);

  // Restored control passes again.
  const restored = scanInventory(entries);
  assert.deepEqual(restored, real, 'the restored source must pass the inventory unchanged');
});

test('Claude binding owner inventory pins the factory dispatch, receipt census and SQL boundary', { timeout: 8000 }, () => {
  const ts = inventoryParser();
  const workspaceRoot = path.join(__dirname, '..');
  const entries = realInventoryEntries(workspaceRoot);
  const real = renderClaudeInventory(ts, entries);

  assert.deepEqual(real.factoryMethods, CLAUDE_HANDLER_METHODS.slice().sort(),
    `${CLAUDE_FACTORY} must declare exactly the six Claude handler methods`);
  assert.deepEqual(real.claudeNames, ['_bindOrdinaryClaude', '_rebindOrdinaryClaude', 'bindOrdinaryClaude', 'rebindOrdinaryClaude'],
    'SurfaceState must retain exactly the four Claude-named methods');
  assert.equal(real.delegates.length, Object.keys(FACADE_TO_HANDLER).length,
    'exactly six facade delegates must reach ordinaryClaudeBindingHandlers');
  for (const [facade, handler] of Object.entries(FACADE_TO_HANDLER)) {
    assert.ok(real.delegates.includes(`${facade}->${handler}`),
      `${facade} must delegate to ordinaryClaudeBindingHandlers.${handler}`);
  }

  assert.deepEqual(real.receiptSites, EXPECTED_RECEIPT_SITES.slice().sort(),
    'the ordinary receipt-kind census must be exactly the seven production owners');
  assert.deepEqual(real.helperCalls, EXPECTED_HELPER_CALLS.slice().sort(),
    'shared receipt-helper and classification delegates must match exactly');
  assert.deepEqual(real.sqlFindings, [],
    'receipt SELECT SQL and db.prepare must stay out of the facade and Claude owner methods');

  for (const kindLiteral of ["'ordinary-native-preflight'", '`ordinary-native-preflight`']) {
    const rawWriterEntries = entries.map(entry => entry.file === 'src/state.js'
      ? { ...entry, text: entry.text.replace('_recordOrdinaryPreflight(binding, detail = {}) {',
        `_recordOrdinaryPreflight(binding, detail = {}) { this.receipt(null, ${kindLiteral}, detail);`) }
      : entry);
    const rawWriter = renderClaudeInventory(ts, rawWriterEntries);
    assert.equal(rawWriter.receiptSites.length, real.receiptSites.length + 1);
    assert.notDeepEqual(rawWriter.receiptSites, EXPECTED_RECEIPT_SITES.slice().sort());
  }

  // Mutant: a non-Claude-named duplicate writer using a constant template
  // expression must still be rejected by the receipt-site census.
  const interpolatedWriterMutantEntries = entries.map(entry => entry.file === 'src/state.js'
    ? {
      ...entry,
      text: entry.text.replace('_recordOrdinaryPreflight(binding, detail = {}) {',
        "recordOrdinaryPreflightCopy(binding, detail = {}) { this.receipt(null, `ordinary-native-${'preflight'}`, detail); }\n\n  _recordOrdinaryPreflight(binding, detail = {}) {")
    }
    : entry);
  const interpolatedWriterMutant = renderClaudeInventory(ts, interpolatedWriterMutantEntries);
  assert.equal(interpolatedWriterMutant.receiptSites.length, real.receiptSites.length + 1,
    'a constant interpolated receipt writer must be rejected by the inventory');
  assert.notDeepEqual(interpolatedWriterMutant.receiptSites, EXPECTED_RECEIPT_SITES.slice().sort());

  // Mutant: an in-memory copied private Claude preflight policy with a receipt write
  // must be rejected by the name census and the receipt-site census.
  const facadeEntry = entries.find(entry => entry.file === 'src/state.js');
  const facadeSource = parseEntry(ts, facadeEntry);
  const classNode = findClass(ts, facadeSource, 'SurfaceState');
  assert.ok(classNode, 'SurfaceState class must exist for the mutant injection');
  const injected = '\n  _privateClaudePreflightCopy(binding, detail = {}) {\n' +
    '    return this.transaction(() => {\n' +
    '      const current = this.getBinding(binding?.channelId);\n' +
    '      if (!bindingMatchesExpected(current, binding)) return null;\n' +
    '      if (!this._isOrdinaryBinding(current)) throw new BindingError(`binding is not an ordinary ${current?.provider || \'native\'} binding`);\n' +
    "      if (!detail || typeof detail !== 'object' || typeof detail.file !== 'string' || !path.isAbsolute(detail.file) ||\n" +
    '        detail.sessionId !== current.nativeId || detail.threadId !== current.nativeId || detail.workspace !== current.workspace) {\n' +
    '        throw new BindingError(`ordinary ${current.provider} native preflight proof does not match the binding`);\n' +
    '      }\n' +
    "      if (detail.harness !== 'claude-code' || detail.endpoint !== current.endpoint) {\n" +
    "        throw new BindingError('ordinary Claude native preflight proof does not match the binding');\n" +
    '      }\n' +
    "      this.receipt(null, ORDINARY_RECEIPT_KINDS.NATIVE_PREFLIGHT, { ...detail });\n" +
    '      return current;\n' +
    '    });\n' +
    '  }\n';
  const mutantText = facadeEntry.text.slice(0, classNode.end - 1) + injected + facadeEntry.text.slice(classNode.end - 1);
  assert.ok(mutantText.includes('_privateClaudePreflightCopy'), 'sanity: the injected mutant must be present');
  const mutantEntries = entries.map(entry => entry.file === 'src/state.js' ? { ...entry, text: mutantText } : entry);
  const mutant = renderClaudeInventory(ts, mutantEntries);
  assert.notDeepEqual(mutant.claudeNames, real.claudeNames,
    'an added Claude-named private policy copy must fail the method census');
  assert.equal(mutant.claudeNames.length, real.claudeNames.length + 1);
  assert.notDeepEqual(mutant.receiptSites, real.receiptSites,
    'an added NATIVE_PREFLIGHT receipt write must fail the receipt-site census');
  assert.equal(mutant.receiptSites.length, real.receiptSites.length + 1);

  // Restored control passes again.
  const restored = renderClaudeInventory(ts, entries);
  assert.deepEqual(restored, real, 'the restored source must pass the Claude inventory unchanged');
});
