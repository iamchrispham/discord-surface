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
  'src/state.js|_bindOrdinaryClaude|this|bind',
  'src/state.js|enrollThread|threadEnrollmentHandlers|enrollThread',
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
  'src/discord/live-checkpoint.js|checkpointHealthyIntake|this',
  'src/discord/inbound-recovery.js|recoverInbound|this',
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

test('adoption owner inventory rejects an added private creator or history reader', { timeout: 8000 }, () => {
  const workspaceRoot = path.join(__dirname, '..');
  const entries = realInventoryEntries(workspaceRoot);
  // The new shared reader lives under src; assert it is actually scanned from disk.
  const reader = entries.find(entry => entry.file === 'src/discord/history-access.ts');
  assert.ok(reader, 'the new shared reader must be scanned from source, not build output');

  const real = scanInventory(entries);
  assert.deepEqual(real.unclassifiedBinds, [], 'an unrecognized bind() receiver is a failure');
  assert.deepEqual(real.creators, EXPECTED_CREATORS.slice().sort(),
    'creator multiset must match exactly the thirteen production tuples');
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
