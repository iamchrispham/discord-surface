const {
  assert,
  fs,
  path,
  spawn,
  EventEmitter,
  readline,
  test,
  SurfaceState,
  MESSAGE_STATES,
  DiscordGateway,
  fixture,
  submitted,
  waitForCondition
} = require('./native-reply-file-fixture');

const CONCURRENT_CHILD_DEADLINE_MS = 8000;
const CONCURRENT_PARENT_CASE_TIMEOUT_MS = 3000;
const CONCURRENT_PARENT_DEADLINE_MS = 20000;
function concurrentPreparationWorker() {
  const fs = require('node:fs');
  const path = require('node:path');
  const { parentPort, workerData } = require('node:worker_threads');
  const { SurfaceState } = require(path.join(workerData.snapshot, 'src/state'));
  const state = new SurfaceState(workerData.dbPath);
  const realOpenSync = fs.openSync;
  let stageHeld = true;
  function waitForFile(file) {
    const started = Date.now();
    const cell = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(file)) {
      if (Date.now() - started > workerData.deadlineMs - 500) throw new Error('child self-deadline waiting for marker');
      Atomics.wait(cell, 0, 0, 20);
    }
  }
  fs.openSync = function controlledOpenSync(file, ...args) {
    if (stageHeld && String(file).endsWith('.partial')) {
      stageHeld = false;
      fs.writeFileSync(workerData.preparingFile, JSON.stringify({ messageId: workerData.messageId }), { mode: 0o600 });
      waitForFile(workerData.releaseStageFile);
    }
    return realOpenSync.call(fs, file, ...args);
  };
  try {
    const manifest = state.prepareNativeReplyFile({
      provider: workerData.provider,
      messageId: workerData.messageId,
      nativeId: workerData.nativeId,
      generation: 1,
      stateDir: workerData.stateDir,
      sourcePath: workerData.sourcePath,
      caption: workerData.caption
    });
    parentPort.postMessage({ kind: 'admitted', manifest });
    waitForFile(workerData.recordFile);
    const recorded = state.recordNativeReply({
      provider: workerData.provider,
      messageId: workerData.messageId,
      nativeId: workerData.nativeId,
      generation: 1,
      text: workerData.caption,
      fileManifest: manifest
    });
    parentPort.postMessage({ kind: 'recorded', state: recorded.message.state });
  } catch (error) {
    parentPort.postMessage({ kind: 'error', error: String(error?.stack || error) });
    process.exitCode = 1;
  } finally {
    state.close();
  }
}

function concurrentPreparationChild(workerProgram) {
  const { Worker } = require('node:worker_threads');
  const worker = new Worker(workerProgram, {
    eval: true,
    workerData: {
      snapshot: process.env.SNAPSHOT_ROOT,
      dbPath: process.env.DB_PATH,
      stateDir: process.env.STATE_DIR,
      sourcePath: process.env.SOURCE_PATH,
      preparingFile: process.env.PREPARING_FILE,
      releaseStageFile: process.env.RELEASE_STAGE_FILE,
      recordFile: process.env.RECORD_FILE,
      provider: process.env.PROVIDER,
      nativeId: process.env.NATIVE_ID,
      messageId: process.env.MESSAGE_ID,
      caption: process.env.CAPTION,
      deadlineMs: Number(process.env.CHILD_DEADLINE_MS || 8000)
    }
  });
  const deadline = setTimeout(() => {
    console.error('child self-deadline exceeded');
    process.exit(124);
  }, Number(process.env.CHILD_DEADLINE_MS || 8000));
  worker.on('message', message => process.stdout.write(JSON.stringify(message) + '\n'));
  worker.on('error', error => {
    clearTimeout(deadline);
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
  worker.on('exit', code => {
    clearTimeout(deadline);
    if (code !== 0) process.exitCode = code;
  });
}

function concurrentPreparationChildProgram() {
  const workerProgram = `(${concurrentPreparationWorker.toString()})()`;
  return `(${concurrentPreparationChild.toString()})(${JSON.stringify(workerProgram)})`;
}

function concurrentWithTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function concurrentWaitForFile(file, timeoutMs, label) {
  const started = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - started >= timeoutMs) throw new Error(`${label} exceeded ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function concurrentChildMessages(child) {
  const lines = readline.createInterface({ input: child.stdout });
  const messages = [];
  const waiters = [];
  let stderr = '';
  const fail = error => {
    while (waiters.length) waiters.shift().reject(error);
  };
  lines.on('line', line => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line);
      messages.push(message);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (message.kind === waiter.kind) {
          waiters.splice(index, 1);
          waiter.resolve(message);
        }
      }
    } catch (error) { fail(error); }
  });
  child.stdout.on('error', fail);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  return {
    stderr: () => stderr,
    waitFor(kind, timeoutMs) {
      const existing = messages.find(message => message.kind === kind);
      if (existing) return Promise.resolve(existing);
      return concurrentWithTimeout(new Promise((resolve, reject) => waiters.push({ kind, resolve, reject })), timeoutMs, `child ${kind}`);
    }
  };
}

function concurrentWaitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return concurrentWithTimeout(new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))), timeoutMs, 'child exit');
}

test('concurrent PREPARING native file wakes existing Gateway with exact attachment', { timeout: CONCURRENT_PARENT_DEADLINE_MS }, async t => {
  for (const provider of ['codex', 'claude']) await t.test(provider, async t2 => {
    const f = fixture(t2, provider);
    const id = `native-file-concurrent-preparing-${provider}`;
    const source = path.join(f.dir, 'answer.bin');
    const bytes = Buffer.from([0, 4, 8, 255]);
    const caption = `concurrent caption ${provider}`;
    const preparingFile = path.join(f.dir, 'preparing.json');
    const releaseStageFile = path.join(f.dir, 'release-stage');
    const recordFile = path.join(f.dir, 'record-reply');
    fs.writeFileSync(source, bytes);
    submitted(f, id);
    const reactions = [];
    const finalPosts = [];
    const channel = {
      id: 'channel',
      messages: { fetch: async targetId => ({ react: async reaction => { assert.equal(targetId, id); reactions.push(reaction); } }) },
      send: async payload => {
        if (!String(payload.content || '').startsWith('Receipt:')) finalPosts.push(payload);
        return { id: `final-${provider}` };
      }
    };
    const client = new EventEmitter();
    client.user = { id: 'bot' };
    client.login = async token => { assert.equal(token, 'fixture'); return token; };
    client.channels = { fetch: async channelId => { assert.equal(channelId, 'channel'); return channel; } };
    client.destroy = async () => {};
    let observations = 0;
    let observationStarted;
    const observation = new Promise(resolve => { observationStarted = resolve; });
    const gateway = new DiscordGateway({ state: f.state, client, providers: {
      [provider]: { observe: async () => { observations += 1; observationStarted(); return { text: 'observer text' }; } }
    } });
    gateway.registerApplicationCommand = async () => {};
    gateway.recoverTransport = async () => { gateway.ready = true; return { ready: true, state: 'ready' }; };
    gateway.schedulePendingHandoffRecoveryPoll = () => {};
    let child = null;
    try {
      await gateway.start(path.join(f.dir, 'discord.env'));
      await gateway.acknowledgments.drain();
      child = spawn(process.execPath, ['-e', concurrentPreparationChildProgram()], {
        env: {
          ...process.env,
          SNAPSHOT_ROOT: process.env.SNAPSHOT_ROOT || path.resolve(__dirname, '..'),
          DB_PATH: path.join(f.dir, 'surface.sqlite'),
          STATE_DIR: f.dir,
          SOURCE_PATH: source,
          PREPARING_FILE: preparingFile,
          RELEASE_STAGE_FILE: releaseStageFile,
          RECORD_FILE: recordFile,
          PROVIDER: provider,
          NATIVE_ID: f.nativeId,
          MESSAGE_ID: id,
          CAPTION: caption,
          CHILD_DEADLINE_MS: String(CONCURRENT_CHILD_DEADLINE_MS)
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const childState = concurrentChildMessages(child);
      await concurrentWaitForFile(preparingFile, CONCURRENT_PARENT_CASE_TIMEOUT_MS, 'child PREPARING signal').catch(error => {
        throw new Error(`${error.message}; stderr=${childState.stderr()}`);
      });
      await gateway.acknowledgments.drain();
      await concurrentWithTimeout(observation, CONCURRENT_PARENT_CASE_TIMEOUT_MS, 'submitted observation');
      assert.equal(observations, 1);
      assert.equal(reactions.length, 1);
      assert.deepEqual(reactions, ['👀']);
      assert.equal(f.state.getMessage(id).state, MESSAGE_STATES.SUBMITTED);
      assert.equal(f.state.nativeReplyFilePreparation(id).phase, 'preparing');

      fs.writeFileSync(releaseStageFile, 'release\n', { mode: 0o600 });
      const admitted = await childState.waitFor('admitted', CONCURRENT_PARENT_CASE_TIMEOUT_MS);
      assert.equal(admitted.manifest.filename, 'answer.bin');
      fs.writeFileSync(recordFile, 'record\n', { mode: 0o600 });
      await childState.waitFor('recorded', CONCURRENT_PARENT_CASE_TIMEOUT_MS);
      const exit = await concurrentWaitForExit(child, CONCURRENT_PARENT_CASE_TIMEOUT_MS);
      assert.equal(exit.code, 0, childState.stderr());
      for (let attempt = 0; attempt < 3 && finalPosts.length === 0; attempt += 1) {
        await gateway.acknowledgments.drain();
        await new Promise(resolve => setImmediate(resolve));
      }
      await waitForCondition(() => finalPosts.length === 1, CONCURRENT_PARENT_CASE_TIMEOUT_MS);
      assert.equal(finalPosts.length, 1);
      assert.equal(reactions.length, 1);
      assert.equal(finalPosts[0].content, caption);
      assert.equal(finalPosts[0].files.length, 1);
      assert.deepEqual(finalPosts[0].files[0].attachment, bytes);
      assert.equal(finalPosts[0].files[0].name, 'answer.bin');
      assert.equal(f.state.getMessage(id).state, MESSAGE_STATES.REPLIED);
      const manifest = f.state.nativeReplyFilePreparation(id);
      assert.equal(manifest.phase, 'admitted');
      assert.equal(f.state.releaseNativeReplyFilePreparation(id, manifest.preparationId).phase, 'released');
      assert.equal(f.state.activeFilePreparationCount(), 0);
      assert.equal(fs.existsSync(manifest.stagedPath), false);
    } finally {
      try {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = concurrentWaitForExit(child, CONCURRENT_PARENT_CASE_TIMEOUT_MS);
          child.kill('SIGKILL');
          await exited;
        }
      } finally {
        await gateway.stop();
      }
    }
  });
});
