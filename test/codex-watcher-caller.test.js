const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const { resolveCurrentCodexWatcherCaller } = require('../src/cli/codex-watcher-caller');
const { createWatcherCommands } = require('../src/cli/watcher-commands');
const { SurfaceState, READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');

const nativeId = '22222222-2222-2222-2222-222222222222';
const siblingNativeId = '33333333-3333-3333-3333-333333333333';
const PARENT_PID = 4242;
const PARENT_START = 1790000000;
const AUTHORITY_PATH = ['.claude', 'skills', 'phone-notify', 'scripts', 'tg-codex-mcp-launch-authority.mjs'];
const BINDING_PATH = ['.claude', 'hooks', 'session-chat-binding.mjs'];

const AUTHORITY_SOURCE = `
globalThis.__cwf.imported.push('authority');
export function verifySealedCodexMcpOwner(...args) {
  const f = globalThis.__cwf;
  f.verify.push(args);
  if (f.verifyError) throw f.verifyError;
  return f.seal;
}
`;
const BINDING_SOURCE = `
globalThis.__cwf.imported.push('binding');
export function trustedCodexActiveParentBinding(...args) {
  const f = globalThis.__cwf;
  f.binding.push(args);
  if (f.callObserver) f.observed = args[1].observeProcessStart(PARENT_PID_PLACEHOLDER);
  return f.bindingResult(args);
}
`.replace('PARENT_PID_PLACEHOLDER', String(PARENT_PID));

function validSeal() {
  return { version: 1, parent_pid: PARENT_PID, parent_start_time: PARENT_START, owner_pid: 5151, owner_start_time: PARENT_START + 5, sealed_at: 'fixture' };
}

function bindingFor(id = nativeId, overrides = {}) {
  return {
    sessionId: id, telegramLane: 'lane', harness: 'codex', pid: PARENT_PID, processStartTime: PARENT_START,
    callerBinding: {}, caller: { sessionId: id, harness: 'codex', pid: PARENT_PID, processStartTime: PARENT_START },
    ...overrides
  };
}

function writeModule(home, parts, source) {
  const file = path.join(home, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
}

async function withOwners(setup, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-watcher-home-'));
  const forgedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-watcher-forged-'));
  const saved = {
    userInfo: os.userInfo,
    home: process.env.HOME,
    nodeOptions: process.env.NODE_OPTIONS,
    execArgv: [...process.execArgv],
    dyld: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('DYLD_')))
  };
  const fixture = {
    imported: [], verify: [], binding: [], observed: undefined, callObserver: false, seal: validSeal(), verifyError: null,
    bindingResult: args => bindingFor(args[0])
  };
  globalThis.__cwf = fixture;
  try {
    writeModule(home, AUTHORITY_PATH, AUTHORITY_SOURCE);
    writeModule(home, BINDING_PATH, BINDING_SOURCE);
    writeModule(forgedHome, AUTHORITY_PATH, AUTHORITY_SOURCE.replace("push('authority')", "push('forged-authority')"));
    writeModule(forgedHome, BINDING_PATH, BINDING_SOURCE.replace("push('binding')", "push('forged-binding')"));
    for (const key of Object.keys(saved.dyld)) delete process.env[key];
    delete process.env.NODE_OPTIONS;
    process.execArgv.length = 0;
    os.userInfo = () => ({ ...saved.userInfo.call(os), homedir: home });
    if (setup) setup({ home, forgedHome, fixture });
    return await run({ home, forgedHome, fixture });
  } finally {
    os.userInfo = saved.userInfo;
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    if (saved.nodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = saved.nodeOptions;
    for (const key of Object.keys(process.env)) if (key.startsWith('DYLD_')) delete process.env[key];
    Object.assign(process.env, saved.dyld);
    process.execArgv.length = 0;
    process.execArgv.push(...saved.execArgv);
    delete globalThis.__cwf;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(forgedHome, { recursive: true, force: true });
  }
}

function watcherFixture(provider) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-watcher-caller-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: '900', guildId: '100', secretFile: path.join(dir, 'secret') });
  state.bind({ guildId: '100', channelId: '101', provider, nativeId, generation: 1, workspace: dir, endpoint: provider === 'claude' ? path.join(dir, 'claude.sock') : null,
    conductorId: 'watcher-conductor', repoKey: 'repo:watcher' }, { intakeCutoff: '100' });
  let binding = state.getBinding('101');
  binding = state.setBindingReadiness('101', READINESS.READY, 'caller fixture ready', binding);
  state.enrollThread({ threadId: '102', parentChannelId: '101', guildId: '100', adoptionCutoff: '100' }, binding);
  state.setThreadBaseline('102', '1000', binding);
  state.markThreadBoundary('102', THREAD_STATES.READY, 'caller fixture adopted', null, null, binding);
  return { dir, db, state };
}

const armArgs = (provider, overrides = {}) => ({
  'arm-key': 'caller-arm', provider, 'channel-id': '101', 'agent-thread-id': '102', 'native-id': nativeId, generation: '1',
  ...overrides
});
const required = (args, name) => {
  if (args[name] === undefined) throw new Error(`missing --${name}`);
  return args[name];
};

function commands(overrides) {
  const printed = [];
  const calls = { claude: [], codex: [] };
  const api = createWatcherCommands({
    openState: () => { throw new Error('openState not configured'); },
    required,
    print: value => printed.push(value),
    resolveCurrentClaudeCaller: async () => { calls.claude.push(true); return { harness: 'claude-code', sessionId: nativeId, threadId: nativeId }; },
    resolveCurrentCodexWatcherCaller: async id => { calls.codex.push(id); return { harness: 'codex', sessionId: id, threadId: id }; },
    gatewayProcessStatus: () => ({ state: 'stopped' }),
    requestGatewayRecovery: () => ({}),
    ...overrides
  });
  return { api, printed, calls };
}

test('Codex caller imports authority from passwd home', async () => {
  await withOwners(({ fixture }) => { fixture.callObserver = true; }, async ({ home, fixture }) => {
    const exec = [];
    const realExec = childProcess.execFileSync;
    childProcess.execFileSync = (...args) => { exec.push(args); return ' Thu Oct  1 20:18:00 2026 \n'; };
    let caller;
    try { caller = await resolveCurrentCodexWatcherCaller(nativeId); }
    finally { childProcess.execFileSync = realExec; }
    assert.deepEqual(caller, { harness: 'codex', sessionId: nativeId, threadId: nativeId });
    assert.deepEqual(fixture.imported.sort(), ['authority', 'binding']);
    assert.deepEqual(fixture.verify, [[process.ppid]]);
    assert.equal(fixture.binding.length, 1);
    const [boundId, options] = fixture.binding[0];
    assert.equal(boundId, nativeId);
    assert.deepEqual(Object.keys(options).sort(), ['observeProcessStart', 'sessionIndexFile', 'sessionsRoot', 'workersDir']);
    assert.equal(options.workersDir, path.join(home, '.agents', 'work-control', 'workers'));
    assert.equal(options.sessionsRoot, path.join(home, '.codex', 'sessions'));
    assert.equal(options.sessionIndexFile, path.join(home, '.codex', 'session_index.jsonl'));
    assert.deepEqual(exec, [['/bin/ps', ['-o', 'lstart=', '-p', String(PARENT_PID)], { encoding: 'utf8', timeout: 2000 }]]);
    assert.equal(fixture.observed, Date.parse('Thu Oct  1 20:18:00 2026') / 1000);
  });
});

test('redirected HOME cannot select Codex authority', async () => {
  await withOwners(null, async ({ forgedHome, fixture }) => {
    process.env.HOME = forgedHome;
    const caller = await resolveCurrentCodexWatcherCaller(nativeId);
    assert.equal(caller.sessionId, nativeId);
    assert.deepEqual(fixture.imported.sort(), ['authority', 'binding']);
    assert.equal(fixture.imported.some(name => name.startsWith('forged')), false);
  });
});

test('NODE_OPTIONS refuses before owner imports', async () => {
  await withOwners(null, async ({ fixture }) => {
    process.env.NODE_OPTIONS = '--max-old-space-size=64';
    await assert.rejects(resolveCurrentCodexWatcherCaller(nativeId), /^Error: codex caller environment refused$/);
    assert.deepEqual(fixture.imported, []);
    assert.deepEqual(fixture.verify, []);
    assert.deepEqual(fixture.binding, []);
  });
});

test('execArgv refuses before owner imports', async () => {
  await withOwners(null, async ({ fixture }) => {
    process.execArgv.push('--no-warnings');
    await assert.rejects(resolveCurrentCodexWatcherCaller(nativeId), /^Error: codex caller environment refused$/);
    assert.deepEqual(fixture.imported, []);
    assert.deepEqual(fixture.verify, []);
    assert.deepEqual(fixture.binding, []);
  });
});

test('DYLD variables refuse before owner imports', async () => {
  await withOwners(null, async ({ fixture }) => {
    process.env.DYLD_INSERT_LIBRARIES = '';
    await assert.rejects(resolveCurrentCodexWatcherCaller(nativeId), /^Error: codex caller environment refused$/);
    assert.deepEqual(fixture.imported, []);
    assert.deepEqual(fixture.verify, []);
    assert.deepEqual(fixture.binding, []);
  });
});

test('absent seal refuses before active binding lookup', async () => {
  await withOwners(null, async ({ fixture }) => {
    const refusal = new Error('Codex MCP launch authority does not match this server');
    fixture.verifyError = refusal;
    await assert.rejects(resolveCurrentCodexWatcherCaller(nativeId), error => error === refusal);
    assert.equal(fixture.verify.length, 1);
    assert.equal(fixture.binding.length, 0);
  });
});

test('absent installed export fails closed', async () => {
  await withOwners(({ home }) => writeModule(home, AUTHORITY_PATH, 'export const unrelated = 1;\n'), async ({ fixture }) => {
    await assert.rejects(resolveCurrentCodexWatcherCaller(nativeId), /authority export is unavailable/);
    assert.equal(fixture.verify.length, 0);
    assert.equal(fixture.binding.length, 0);
  });
});

test('different sealed parent PID refuses', async () => {
  await withOwners(({ fixture }) => { fixture.seal = { ...validSeal(), parent_pid: PARENT_PID + 1 }; }, async () => {
    await assert.rejects(resolveCurrentCodexWatcherCaller(nativeId), /does not match the sealed parent process/);
  });
});

test('different sealed parent start refuses', async () => {
  await withOwners(({ fixture }) => { fixture.seal = { ...validSeal(), parent_start_time: PARENT_START + 1 }; }, async () => {
    await assert.rejects(resolveCurrentCodexWatcherCaller(nativeId), /does not match the sealed parent process/);
  });
});

test('sibling active session refuses', async () => {
  await withOwners(({ fixture }) => { fixture.bindingResult = () => bindingFor(siblingNativeId); }, async () => {
    await assert.rejects(resolveCurrentCodexWatcherCaller(nativeId), /does not identify the requested session/);
  });
});

test('watcher arm selects the Codex caller', async () => {
  const f = watcherFixture('codex');
  try {
    const { api, calls, printed } = commands({ openState: () => ({ state: new SurfaceState(f.db) }) });
    const armed = await api.watcherArm(armArgs('codex'));
    assert.equal(armed.armed, true);
    assert.equal(armed.arm.provider, 'codex');
    assert.deepEqual(calls.codex, [nativeId]);
    assert.equal(calls.claude.length, 0);
    assert.equal(printed.length, 1);
    assert.equal(f.state.getWatcherNoticeArm('caller-arm').provider, 'codex');
  } finally {
    f.state.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('watcher arm preserves the Claude caller', async () => {
  const f = watcherFixture('claude');
  try {
    const { api, calls } = commands({ openState: () => ({ state: new SurfaceState(f.db) }) });
    const armed = await api.watcherArm(armArgs('claude'));
    assert.equal(armed.armed, true);
    assert.equal(armed.arm.provider, 'claude');
    assert.equal(calls.claude.length, 1);
    assert.equal(calls.codex.length, 0);
    assert.equal(f.state.getWatcherNoticeArm('caller-arm').provider, 'claude');
  } finally {
    f.state.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('watcher arm refusal closes state without custody', async () => {
  const fakeState = () => {
    const counts = { arm: 0, close: 0 };
    return { counts, state: { armWatcherNotice: () => { counts.arm += 1; return {}; }, close: () => { counts.close += 1; } } };
  };
  const unsupported = fakeState();
  const first = commands({ openState: () => ({ state: unsupported.state }) });
  await assert.rejects(first.api.watcherArm(armArgs('gemini')), /supported owner provider/);
  assert.equal(unsupported.counts.arm, 0);
  assert.equal(unsupported.counts.close, 1);
  assert.deepEqual([first.calls.claude.length, first.calls.codex.length, first.printed.length], [0, 0, 0]);

  const refusal = new Error('Codex MCP launch authority does not match this server');
  const failing = fakeState();
  const second = commands({
    openState: () => ({ state: failing.state }),
    resolveCurrentCodexWatcherCaller: async () => { throw refusal; }
  });
  await assert.rejects(second.api.watcherArm(armArgs('codex')), error => error === refusal);
  assert.equal(failing.counts.arm, 0);
  assert.equal(failing.counts.close, 1);
  assert.deepEqual([second.calls.claude.length, second.printed.length], [0, 0]);
});

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function parse(file) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, child => visit(child, callback));
}

function claudeAdmissions(root) {
  const found = [];
  const isClaudeOperand = node => (ts.isStringLiteralLike(node) && node.text === 'claude') ||
    (ts.isPropertyAccessExpression(node) && node.name.text === 'CLAUDE' && node.expression.getText() === 'WATCHER_NOTICE_PROVIDERS');
  visit(root, node => {
    const comparison = ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind) &&
      (isClaudeOperand(node.left) || isClaudeOperand(node.right));
    const switchCase = ts.isCaseClause(node) && isClaudeOperand(node.expression);
    if (comparison || switchCase) found.push(node.getText().slice(0, 80));
  });
  return found;
}

function callsPredicate(root) {
  let called = false;
  visit(root, node => {
    if (ts.isCallExpression(node) && node.expression.getText() === 'isWatcherNoticeProvider') called = true;
  });
  return called;
}

function mentionsProvider(root) {
  let mentioned = false;
  visit(root, node => { if (ts.isPropertyAccessExpression(node) && node.name.text === 'provider') mentioned = true; });
  return mentioned;
}

test('watcher provider consumers use the shared owner', () => {
  const srcRoot = path.resolve(__dirname, '..', 'src');
  const watcherFiles = walk(srcRoot).filter(file => /\.(?:js|ts)$/.test(file) && !file.endsWith('.d.ts') &&
    path.relative(srcRoot, file).split(path.sep).some(part => part.includes('watcher')));
  const required = ['watcher-notice.ts', path.join('state', 'watcher-notice.ts'), path.join('cli', 'watcher-commands.js')].map(name => path.join(srcRoot, name));
  for (const file of required) assert.ok(watcherFiles.includes(file), `${file} is in the scanned inventory`);

  const problems = [];
  for (const file of watcherFiles) {
    const source = parse(file);
    const owners = [];
    visit(source, node => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'isWatcherNoticeProvider') owners.push(node);
    });
    const outsidePredicate = [];
    for (const hit of claudeAdmissions(source)) outsidePredicate.push(hit);
    for (const owner of owners) {
      for (const hit of claudeAdmissions(owner)) outsidePredicate.splice(outsidePredicate.indexOf(hit), 1);
    }
    for (const hit of outsidePredicate) problems.push(`${path.relative(srcRoot, file)} admits Claude directly: ${hit}`);
    if (mentionsProvider(source) && !callsPredicate(source) && owners.length === 0) {
      problems.push(`${path.relative(srcRoot, file)} reads a provider without isWatcherNoticeProvider`);
    }
  }

  const directPost = parse(path.join(srcRoot, 'direct-post.ts'));
  let branches = 0;
  let predicateBranches = 0;
  visit(directPost, node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'runDirectPost') {
      visit(node, inner => {
        if (ts.isIfStatement(inner) && inner.expression.getText() === 'watcherNotice') {
          branches += 1;
          if (callsPredicate(inner.thenStatement)) predicateBranches += 1;
          for (const hit of claudeAdmissions(inner.thenStatement)) problems.push(`runDirectPost watcherNotice branch admits Claude directly: ${hit}`);
        }
      });
    }
  });
  assert.ok(branches >= 1, 'runDirectPost watcherNotice branch is found');
  assert.ok(predicateBranches >= 1, 'runDirectPost watcherNotice guard calls isWatcherNoticeProvider');
  assert.deepEqual(problems, []);
});
