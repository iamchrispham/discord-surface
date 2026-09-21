const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { MESSAGE_STATES } = require('../src/state');
const { CodexProvider } = require('../src/native');
const { DiscordGateway } = require('../src/discord');
const { ACK, acknowledgmentCommand, createAcknowledgmentDelivery, isAcknowledgmentPending, recordNativeAcknowledgment, watchAcknowledgments } = require('../src/acknowledgment');
const { CODEX_ID, SUCCESSOR_ID, fixture, waitForCondition } = require('./surface-fixtures');

test('simulated: native pickup ACK is explicit, idempotent, and included in the Codex prompt', async () => {
  const { dir, state } = fixture();
  const sessionRoot = path.join(dir, 'sessions');
  fs.mkdirSync(sessionRoot);
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'ack-prompt', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'ack me' });
  state.claimDispatch('ack-prompt');
  const message = state.getMessage('ack-prompt');
  const command = acknowledgmentCommand(message, state.dbPath);
  let codexArgs;
  const provider = new CodexProvider({ root: sessionRoot, acknowledgmentFor: item => acknowledgmentCommand(item, state.dbPath), run: async (_command, args) => {
    codexArgs = args;
    return { status: 'submitted' };
  } });
  const dispatched = await provider.dispatch(message);
  assert.equal(dispatched.status, 'submitted');
  const prompt = codexArgs[codexArgs.indexOf('--message') + 1];
  assert.match(prompt, /At pickup, acknowledge this exact message/);
  assert.match(prompt, new RegExp(command.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')));
  assert.deepEqual(recordNativeAcknowledgment(state, {
    provider: 'codex', messageId: message.id, nativeId: CODEX_ID, generation: 1
  }), { recorded: true, duplicate: false, messageId: message.id });
  assert.deepEqual(recordNativeAcknowledgment(state, {
    provider: 'codex', messageId: message.id, nativeId: CODEX_ID, generation: 1
  }), { recorded: false, duplicate: true, messageId: message.id });
  const acknowledgments = state.listReceipts().filter(row => row.discord_id === message.id && row.kind === ACK.RECEIVED);
  assert.equal(acknowledgments.length, 1);
  assert.equal(JSON.parse(acknowledgments[0].detail).source, 'explicit-native-ack');
  state.close();
});

test('simulated: acknowledgment delivery checks one message eligibility instead of rescanning history', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  for (let index = 0; index < 40; index += 1) {
    const id = `ack-history-${index}`;
    state.acceptDiscordMessage({ id, guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: id });
    state.claimDispatch(id);
    recordNativeAcknowledgment(state, { provider: 'codex', messageId: id, nativeId: CODEX_ID, generation: 1 });
    state.receipt(id, ACK.OUTCOME, { outcome: 'sent' });
  }
  const target = 'ack-target';
  state.acceptDiscordMessage({ id: target, guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: target });
  state.claimDispatch(target);
  recordNativeAcknowledgment(state, { provider: 'codex', messageId: target, nativeId: CODEX_ID, generation: 1 });

  const queries = [];
  const prepare = state.db.prepare.bind(state.db);
  state.db.prepare = sql => {
    queries.push(String(sql));
    return prepare(sql);
  };
  const reactions = [];
  const deliver = createAcknowledgmentDelivery({ state, send: async (message, reaction) => reactions.push([message.id, reaction]) });
  assert.equal(isAcknowledgmentPending(state, target), true);
  const beforeDelivery = queries.length;
  await deliver(target);
  assert.match(queries[beforeDelivery], /r\.discord_id=\?/);
  assert.doesNotMatch(queries[beforeDelivery], /SELECT done\.discord_id/);
  assert.deepEqual(reactions, [[target, '👀']]);
  assert.equal(isAcknowledgmentPending(state, target), false);
  state.close();
});

test('simulated: ACK reaction refuses a generation handoff after channel fetch', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'ack-generation-race', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('ack-generation-race');
  recordNativeAcknowledgment(state, { provider: 'codex', messageId: 'ack-generation-race', nativeId: CODEX_ID, generation: 1 });
  state.db.prepare('UPDATE messages SET state=? WHERE discord_id=?').run(MESSAGE_STATES.REPLIED, 'ack-generation-race');
  let fetchStarted;
  const started = new Promise(resolve => { fetchStarted = resolve; });
  let releaseFetch;
  const fetchGate = new Promise(resolve => { releaseFetch = resolve; });
  let reacted = false;
  const channel = { messages: { fetch: async () => ({ react: async () => { reacted = true; } }) } };
  const client = {
    on() {},
    off() {},
    channels: { fetch: async () => { fetchStarted(); await fetchGate; return channel; } },
    async destroy() {}
  };
  const gateway = new DiscordGateway({ state, client });
  const delivery = gateway.deliverAcknowledgment('ack-generation-race');
  await started;
  state.rebind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: SUCCESSOR_ID, workspace: dir });
  releaseFetch();
  await delivery;
  assert.equal(reacted, false);
  const outcomes = state.listReceipts().filter(row => row.discord_id === 'ack-generation-race' && row.kind === ACK.OUTCOME);
  assert.equal(JSON.parse(outcomes.at(-1).detail).outcome, 'stale');
  await gateway.stop();
  state.close();
});

test('simulated: ACK reaction refuses a generation handoff after message fetch', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'ack-message-fetch-race', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('ack-message-fetch-race');
  recordNativeAcknowledgment(state, { provider: 'codex', messageId: 'ack-message-fetch-race', nativeId: CODEX_ID, generation: 1 });
  state.db.prepare('UPDATE messages SET state=? WHERE discord_id=?').run(MESSAGE_STATES.REPLIED, 'ack-message-fetch-race');
  let fetchStarted;
  const started = new Promise(resolve => { fetchStarted = resolve; });
  let releaseFetch;
  const fetchGate = new Promise(resolve => { releaseFetch = resolve; });
  let reacted = false;
  const channel = {
    messages: {
      fetch: async () => {
        fetchStarted();
        await fetchGate;
        return { react: async () => { reacted = true; } };
      }
    }
  };
  const gateway = new DiscordGateway({
    state,
    client: { on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} }
  });
  const delivery = gateway.deliverAcknowledgment('ack-message-fetch-race');
  await fetchStarted;
  state.rebind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: SUCCESSOR_ID, workspace: dir });
  releaseFetch();
  await delivery;
  assert.equal(reacted, false);
  const outcomes = state.listReceipts().filter(row => row.discord_id === 'ack-message-fetch-race' && row.kind === ACK.OUTCOME);
  assert.equal(JSON.parse(outcomes.at(-1).detail).outcome, 'stale');
  await gateway.stop();
  state.close();
});

test('simulated: unknown ACK reaction reaches a terminal outcome after bounded retries', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'ack-retry-bound', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('ack-retry-bound');
  recordNativeAcknowledgment(state, { provider: 'codex', messageId: 'ack-retry-bound', nativeId: CODEX_ID, generation: 1 });
  const realNow = Date.now;
  let clock = 0;
  Date.now = () => clock;
  try {
    const deliver = createAcknowledgmentDelivery({ state, send: async () => {
      const error = new Error('persistent network');
      error.status = 503;
      throw error;
    } });
    const outcomes = [];
    for (let index = 0; index < 8; index += 1) {
      await deliver('ack-retry-bound');
      const rows = state.listReceipts().filter(row => row.discord_id === 'ack-retry-bound' && row.kind === ACK.OUTCOME);
      outcomes.push(JSON.parse(rows.at(-1).detail));
      if (Number.isFinite(outcomes.at(-1).retryAt)) clock = outcomes.at(-1).retryAt;
    }
    assert.equal(outcomes.length, 8);
    assert.equal(outcomes.at(-1).attempt, 8);
    assert.equal(outcomes.at(-1).terminal, true);
    assert.equal('retryAt' in outcomes.at(-1), false);
    assert.equal(isAcknowledgmentPending(state, 'ack-retry-bound', clock), false);
  } finally {
    Date.now = realNow;
    state.close();
  }
});

test('simulated: ACK rate limits use Discord retry-after timing', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'ack-rate-limit', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('ack-rate-limit');
  recordNativeAcknowledgment(state, { provider: 'codex', messageId: 'ack-rate-limit', nativeId: CODEX_ID, generation: 1 });
  try {
    const before = Date.now();
    const deliver = createAcknowledgmentDelivery({ state, send: async () => {
      throw Object.assign(new Error('Discord rate limit'), { status: 429, retryAfterMs: 45000 });
    } });
    await deliver('ack-rate-limit');
    const outcome = JSON.parse(state.listReceipts().filter(row => row.discord_id === 'ack-rate-limit' && row.kind === ACK.OUTCOME).at(-1).detail);
    assert.ok(outcome.retryAt >= before + 45000);
    assert.ok(outcome.retryAt <= Date.now() + 45000);
  } finally {
    state.close();
  }
});

test('simulated: ACK watcher backs off repeated errors and resets after a healthy event', async () => {
  const { db, state } = fixture();
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const timers = [];
  const retryDelays = [];
  const callbacks = [];
  const watchers = [];
  let arms = 0;
  let watcher;
  global.setTimeout = (fn, delay = 0) => {
    const timer = { fn, delay, active: true };
    timers.push(timer);
    if (delay < 50) retryDelays.push(delay);
    return timer;
  };
  global.clearTimeout = timer => {
    if (timer) timer.active = false;
  };
  function fire(delay) {
    const timer = timers.find(item => item.active && item.delay === delay);
    assert.ok(timer, `missing retry timer at ${delay}ms`);
    timer.active = false;
    timer.fn();
  }
  try {
    watcher = watchAcknowledgments({
      state,
      send: async () => {},
      rearmMs: 10,
      watchFactory: (_directory, callback) => {
        const next = new EventEmitter();
        next.close = () => {};
        arms += 1;
        callbacks.push(callback);
        watchers.push(next);
        if (arms <= 3) queueMicrotask(() => next.emit('error', new Error('watch failed')));
        return next;
      }
    });
    await Promise.resolve();
    assert.deepEqual(retryDelays, [10]);
    fire(10);
    await Promise.resolve();
    assert.deepEqual(retryDelays, [10, 20]);
    fire(20);
    await Promise.resolve();
    assert.deepEqual(retryDelays, [10, 20, 40]);
    fire(40);
    await Promise.resolve();
    callbacks[3]('change', path.basename(db));
    watchers[3].emit('error', new Error('watch failed again'));
    assert.deepEqual(retryDelays, [10, 20, 40, 10]);
  } finally {
    await watcher?.stop();
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    state.close();
  }
});

test('simulated: ACK watcher cleanup survives stop and state close before deferred resume settles', () => {
  const root = path.resolve(__dirname, '..');
  const statePath = path.join(root, 'src/state.js');
  const acknowledgmentPath = path.join(root, 'src/acknowledgment.js');
  const childDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-ack-stop-'));
  const script = `
const path = require('node:path');
const { SurfaceState } = require(${JSON.stringify(statePath)});
const { recordNativeAcknowledgment, watchAcknowledgments } = require(${JSON.stringify(acknowledgmentPath)});

(async () => {
  const dir = process.env.ACK_STOP_CLOSE_DIR;
  const db = path.join(dir, 'surface.sqlite');
  let state;
  try {
    state = new SurfaceState(db);
    state.setConfig({ operatorId: 'operator-1', guildId: 'guild-1', secretFile: path.join(dir, 'discord.secret') });
    state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: '9caa5d21-2169-429d-918b-5f08651b5dbd', workspace: dir });
    state.acceptDiscordMessage({ id: 'ack-stop-close', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
    state.claimDispatch('ack-stop-close');
    recordNativeAcknowledgment(state, { provider: 'codex', messageId: 'ack-stop-close', nativeId: '9caa5d21-2169-429d-918b-5f08651b5dbd', generation: 1 });
    let startCallback;
    const callbackStarted = new Promise(resolve => { startCallback = resolve; });
    let releaseCallback;
    const callbackGate = new Promise(resolve => { releaseCallback = resolve; });
    const watcher = watchAcknowledgments({
      state,
      send: async () => {},
      deliver: async () => {},
      onAcknowledged: async () => {
        startCallback();
        await callbackGate;
      },
      watchFactory: () => ({ on() {}, close() {} })
    });
    const drain = watcher.drain();
    await callbackStarted;
    await drain;
    await watcher.stop();
    state.close();
    releaseCallback();
    await new Promise(resolve => setImmediate(resolve));
    process.stdout.write('clean deferred cleanup\\n');
  } finally {
    state?.close();
  }
})().catch(error => {
  process.stderr.write(String(error.stack || error) + '\\n');
  process.exitCode = 1;
});
`;
  try {
    const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', script], {
      cwd: root,
      env: { ...process.env, ACK_STOP_CLOSE_DIR: childDir },
      encoding: 'utf8',
      timeout: 15000
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /clean deferred cleanup/);
  } finally {
    fs.rmSync(childDir, { recursive: true, force: true });
  }
});

test('simulated: ACK watcher uses receipt watermark after its baseline scan', async () => {
  const { dir, db, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const reactions = [];
  const callbacks = [];
  const watcher = watchAcknowledgments({
    state,
    send: async (_message, reaction) => reactions.push(reaction),
    watchFactory: (_directory, callback) => {
      callbacks.push(callback);
      return { on() {}, close() {} };
    }
  });
  await watcher.drain();
  await new Promise(resolve => setTimeout(resolve, 70));
  const queries = [];
  const prepare = state.db.prepare.bind(state.db);
  state.db.prepare = sql => {
    queries.push(String(sql));
    return prepare(sql);
  };
  state.acceptDiscordMessage({ id: 'ack-watcher-incremental', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('ack-watcher-incremental');
  recordNativeAcknowledgment(state, { provider: 'codex', messageId: 'ack-watcher-incremental', nativeId: CODEX_ID, generation: 1 });
  callbacks[0]('change', path.basename(db));
  await waitForCondition(() => reactions.length === 1, 1000);
  assert.equal(queries.some(sql => sql.includes('SELECT done.discord_id')), false);
  assert.equal(queries.some(sql => sql.includes('WHERE id>?')), true);
  await watcher.stop();
  state.close();
});

test('simulated: ACK watcher quiesces past unrelated receipts and delivers a later ACK', async () => {
  const { dir, db, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const reactions = [];
  const callbacks = [];
  const watcher = watchAcknowledgments({
    state,
    send: async (message, reaction) => reactions.push([message.id, reaction]),
    watchFactory: (_directory, callback) => {
      callbacks.push(callback);
      return { on() {}, close() {} };
    }
  });
  try {
    await watcher.drain();
    await new Promise(resolve => setTimeout(resolve, 70));
    const queries = [];
    const prepare = state.db.prepare.bind(state.db);
    state.db.prepare = sql => {
      queries.push(String(sql));
      return prepare(sql);
    };
    state.receipt(null, 'unrelated-test', { value: 1 });
    await watcher.drain();
    const afterUnrelated = queries.filter(sql => sql.includes('WHERE id>?')).length;
    await new Promise(resolve => setTimeout(resolve, 260));
    assert.equal(queries.filter(sql => sql.includes('WHERE id>?')).length, afterUnrelated);
    state.acceptDiscordMessage({ id: 'ack-after-idle', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
    state.claimDispatch('ack-after-idle');
    recordNativeAcknowledgment(state, { provider: 'codex', messageId: 'ack-after-idle', nativeId: CODEX_ID, generation: 1 });
    callbacks[0]('change', path.basename(db));
    await waitForCondition(() => reactions.length === 1, 1000);
    assert.deepEqual(reactions, [['ack-after-idle', '👀']]);
  } finally {
    await watcher.stop();
    state.close();
  }
});

test('simulated: ACK watcher keeps a concurrent receipt append after its snapshot', async () => {
  const { dir, db, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const callbacks = [];
  const reactions = [];
  let sendStarted;
  const started = new Promise(resolve => { sendStarted = resolve; });
  let releaseSend;
  const sendGate = new Promise(resolve => { releaseSend = resolve; });
  const watcher = watchAcknowledgments({
    state,
    send: async (message, reaction) => {
      reactions.push([message.id, reaction]);
      if (message.id === 'ack-concurrent-first') {
        sendStarted();
        await sendGate;
      }
    },
    watchFactory: (_directory, callback) => {
      callbacks.push(callback);
      return { on() {}, close() {} };
    }
  });
  try {
    await watcher.drain();
    await new Promise(resolve => setTimeout(resolve, 70));
    function recordAck(id) {
      state.acceptDiscordMessage({ id, guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: id });
      state.claimDispatch(id);
      recordNativeAcknowledgment(state, { provider: 'codex', messageId: id, nativeId: CODEX_ID, generation: 1 });
    }
    recordAck('ack-concurrent-first');
    callbacks[0]('change', path.basename(db));
    const firstDrain = watcher.drain();
    await started;
    recordAck('ack-concurrent-second');
    callbacks[0]('change', path.basename(db));
    watcher.drain();
    releaseSend();
    await firstDrain;
    await waitForCondition(() => reactions.length === 2, 1000);
    assert.deepEqual(reactions, [['ack-concurrent-first', '👀'], ['ack-concurrent-second', '👀']]);
  } finally {
    releaseSend();
    await watcher.stop();
    state.close();
  }
});
