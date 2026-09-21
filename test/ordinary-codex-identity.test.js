const {
  test,
  assert,
  fs,
  os,
  path,
  ordinaryBind,
  readCodexSessionIdentityAsync,
  sessionRoot,
  validateCodexSessionIdentity,
  validateCodexSessionIdentityAsync,
  SurfaceState,
  CODEX,
  OTHER,
  fixture,
  ordinary,
  transcript,
  controlRootEnumeration
} = require('./ordinary-codex-fixture');

test('native preflight requires exact session metadata and workspace', async t => {
  const f = fixture(t);
  const matching = transcript(t, f.dir);
  const proof = validateCodexSessionIdentity(CODEX, f.dir, matching.root);
  assert.equal(proof.file, matching.file);
  const singleField = transcript(t, f.dir, CODEX, { id: undefined });
  const singleFieldProof = validateCodexSessionIdentity(CODEX, f.dir, singleField.root);
  assert.deepEqual({ sessionId: singleFieldProof.sessionId, threadId: singleFieldProof.threadId }, { sessionId: CODEX, threadId: CODEX });
  const asyncSingleFieldProof = await readCodexSessionIdentityAsync(CODEX, singleField.root);
  assert.deepEqual({ sessionId: asyncSingleFieldProof.sessionId, threadId: asyncSingleFieldProof.threadId }, { sessionId: CODEX, threadId: CODEX });
  const otherSingleField = transcript(t, f.dir, CODEX, { session_id: undefined });
  const otherSingleFieldProof = validateCodexSessionIdentity(CODEX, f.dir, otherSingleField.root);
  assert.deepEqual({ sessionId: otherSingleFieldProof.sessionId, threadId: otherSingleFieldProof.threadId }, { sessionId: CODEX, threadId: CODEX });
  assert.equal(validateCodexSessionIdentity(CODEX, undefined, matching.root).workspace, f.dir);
  const wrongWorkspace = transcript(t, '/tmp/other-workspace');
  assert.throws(() => validateCodexSessionIdentity(CODEX, f.dir, wrongWorkspace.root), /workspace/);
  const wrongIdentity = transcript(t, f.dir, CODEX, { id: OTHER });
  assert.throws(() => validateCodexSessionIdentity(CODEX, f.dir, wrongIdentity.root), /identity/);
});

test('ordinary bind validates a session beyond the historical entry cutoff', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-large-root-'));
  const workspace = path.join(dir, 'workspace');
  const sessionRoot = path.join(dir, 'sessions');
  fs.mkdirSync(workspace);
  fs.mkdirSync(sessionRoot);
  const targetName = `target-${CODEX}.jsonl`;
  const targetFile = path.join(sessionRoot, targetName);
  fs.writeFileSync(targetFile, `${JSON.stringify({ type: 'session_meta', payload: {
    session_id: CODEX, id: CODEX, cwd: workspace
  } })}\n`);
  for (let index = 0; index < 2050; index += 1) {
    fs.writeFileSync(path.join(sessionRoot, `filler-${String(index).padStart(4, '0')}.jsonl`), '{}\n');
  }
  const orders = controlRootEnumeration(t, sessionRoot, [targetName]);
  const opened = [];
  const originalOpen = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (target, ...args) => {
    opened.push(String(target));
    return originalOpen.call(fs.promises, target, ...args);
  });
  const setup = new SurfaceState(path.join(dir, 'surface.sqlite'));
  setup.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  setup.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const identity = await validateCodexSessionIdentityAsync(CODEX, undefined, sessionRoot);
  assert.equal(identity.file, targetFile);
  assert.equal(identity.workspace, workspace);
  assert.ok(orders[0].indexOf(targetName) > 2048);
  assert.deepEqual(opened, [targetFile]);

  const channel = { id: 'large-root-channel', guildId: 'guild', name: 'dev', isTextBased: () => true };
  class FakeClient {
    constructor() {
      this.guilds = { fetch: async () => ({ channels: {
        fetch: async selection => selection ? channel : new Map([[channel.id, channel]])
      } }) };
    }
    async login() {}
    async destroy() {}
  }
  const result = await ordinaryBind({
    'state-dir': dir, channel: '#dev', workspace, 'session-root': sessionRoot
  }, {
    environment: { CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: workspace },
    requireInstalled: () => ({ Client: FakeClient, GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    gatewayProcessStatus: () => ({ state: 'stopped' }),
    print: () => {}
  });
  assert.equal(result.nativeProof.status, 'verified');
  assert.equal(result.binding.sessionRoot, sessionRoot);
});

test('async identity discovery returns ambiguity after two valid candidates', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-ambiguous-root-'));
  const workspace = path.join(dir, 'workspace');
  const sessionRoot = path.join(dir, 'sessions');
  fs.mkdirSync(workspace);
  fs.mkdirSync(sessionRoot);
  const candidateNames = ['first', 'second', 'third'].map(prefix => `${prefix}-${CODEX}.jsonl`);
  for (const name of candidateNames) {
    fs.writeFileSync(path.join(sessionRoot, name), `${JSON.stringify({ type: 'session_meta', payload: {
      session_id: CODEX, id: CODEX, cwd: workspace
    } })}\n`);
  }
  controlRootEnumeration(t, sessionRoot, candidateNames);
  const opened = [];
  const originalOpen = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (target, ...args) => {
    opened.push(String(target));
    return originalOpen.call(fs.promises, target, ...args);
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(
    () => validateCodexSessionIdentityAsync(CODEX, undefined, sessionRoot),
    /ambiguous/
  );
  assert.equal(opened.length, 2);
  assert.equal(new Set(opened.map(file => path.basename(file))).size, 2);
  assert.ok(opened.every(file => candidateNames.includes(path.basename(file))));
});

test('async identity discovery closes its directory on deadline', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-deadline-root-'));
  fs.mkdirSync(path.join(root, 'sessions'));
  const sessionRoot = path.join(root, 'sessions');
  const originalNow = Date.now;
  const started = originalNow();
  let calls = 0;
  let closes = 0;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  Date.now = () => {
    calls += 1;
    return calls >= 4 ? started + 6000 : started;
  };
  const originalOpendir = fs.promises.opendir;
  t.mock.method(fs.promises, 'opendir', async (target, ...args) => {
    const handle = await originalOpendir(target, ...args);
    return {
      read: (...readArgs) => handle.read(...readArgs),
      close: async (...closeArgs) => {
        closes += 1;
        resolveClosed();
        return handle.close(...closeArgs);
      }
    };
  });
  t.after(() => {
    Date.now = originalNow;
    fs.rmSync(root, { recursive: true, force: true });
  });

  await assert.rejects(
    () => validateCodexSessionIdentityAsync(CODEX, undefined, sessionRoot),
    /unavailable/
  );
  await closed;
  assert.equal(closes, 1);
});

test('async identity discovery closes a directory that opens after its deadline', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-late-open-root-'));
  fs.mkdirSync(path.join(root, 'sessions'));
  const sessionRoot = path.join(root, 'sessions');
  const originalNow = Date.now;
  const started = originalNow();
  let calls = 0;
  let resolveOpen;
  let closes = 0;
  Date.now = () => {
    calls += 1;
    return calls >= 3 ? started + 4999 : started;
  };
  t.mock.method(fs.promises, 'opendir', () => new Promise(resolve => { resolveOpen = resolve; }));
  t.after(() => {
    Date.now = originalNow;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const rejected = assert.rejects(
    () => validateCodexSessionIdentityAsync(CODEX, undefined, sessionRoot),
    /unavailable/
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  resolveOpen({
    read: async () => null,
    close: async () => { closes += 1; }
  });
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 1);
});

test('async identity discovery closes a directory after a pending read deadline', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-pending-read-root-'));
  fs.mkdirSync(path.join(root, 'sessions'));
  const sessionRoot = path.join(root, 'sessions');
  const originalNow = Date.now;
  const started = originalNow();
  let calls = 0;
  let resolveRead;
  let closes = 0;
  Date.now = () => {
    calls += 1;
    return calls >= 3 ? started + 4999 : started;
  };
  t.mock.method(fs.promises, 'opendir', async () => ({
    read: () => new Promise(resolve => { resolveRead = resolve; }),
    close: async () => { closes += 1; }
  }));
  t.after(() => {
    Date.now = originalNow;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const rejected = assert.rejects(
    () => validateCodexSessionIdentityAsync(CODEX, undefined, sessionRoot),
    /unavailable/
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  resolveRead(null);
  await rejected;
  assert.equal(closes, 1);
});
