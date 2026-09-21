const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, getEventListeners } = require('node:events');
const { postUnixJson } = require('../src/native');
const { SurfaceState, MESSAGE_STATES } = require('../src/state');
const { CodexProvider, finalText, observeCodexReply, observeSubmitted, readInitialCursor, runCodex } = require('../src/native');
const { createSurfaceConsumer, DiscordGateway } = require('../src/discord');
const { ClaudeChannel } = require('../src/claude-channel');
const { CODEX_ID, CLAUDE_ID, fixture, discordMessage, historyPermissions, providers } = require('./surface-fixtures');

test('simulated: exact native rollout rejection is definitely not submitted', async () => {
  const result = await runCodex(process.execPath, ['-e', "console.error('no rollout found for thread id 9caa5d21-2169-429d-918b-5f08651b5dbd (code -32603)'); process.exit(1)"]);
  assert.equal(result.status, 'not_submitted');
});

test('simulated: Unicode and split JSONL observation keeps a byte cursor and finds only the exact final marker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-jsonl-'));
  const file = path.join(root, `${CODEX_ID}.jsonl`);
  const meta = JSON.stringify({ type: 'session_meta', payload: { session_id: CODEX_ID }, timestamp: new Date().toISOString() });
  const prior = JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { phase: 'final_answer', content: [{ type: 'Text', text: '古い応答' }] } }, timestamp: new Date().toISOString() });
  fs.writeFileSync(file, `${meta}\n${prior}\n`, { mode: 0o600 });
  const cursor = readInitialCursor(CODEX_ID, root);
  const marker = `[[discord-surface:late-unicode]]`;
  const row = JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { phase: 'final_answer', content: [{ type: 'Text', text: `${marker}\n返信🙂` }] } }, timestamp: new Date().toISOString() });
  const observation = observeCodexReply(CODEX_ID, cursor, { marker, root, timeoutMs: 1000, pollMs: 5 });
  const encoded = Buffer.from(`${row}\n`);
  const emojiOffset = encoded.indexOf(Buffer.from('🙂'));
  const splitOffset = emojiOffset + 2;
  setTimeout(() => fs.appendFileSync(file, encoded.subarray(0, splitOffset)), 20);
  setTimeout(() => fs.appendFileSync(file, encoded.subarray(splitOffset)), 40);
  const result = await observation;
  assert.equal(result.text, '返信🙂');
  assert.equal(result.cursor.offset, fs.statSync(file).size);
  assert.equal(finalText(JSON.parse(prior), marker), null);
});

test('simulated: live Codex consumer keeps observing past the bounded recovery window', async () => {
  const { dir, state } = fixture();
  const root = path.join(dir, 'sessions');
  fs.mkdirSync(root, { mode: 0o700 });
  const file = path.join(root, `${CODEX_ID}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { session_id: CODEX_ID }, timestamp: new Date().toISOString() })}\n`, { mode: 0o600 });
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  let dispatches = 0;
  let sends = 0;
  const provider = new CodexProvider({
    root,
    run: async () => { dispatches += 1; return { status: 'submitted' }; }
  });
  const consumer = createSurfaceConsumer({
    state,
    providers: { codex: provider },
    observeOptions: { timeoutMs: 25, pollMs: 5 },
    sendTransportReceipt: async () => ({ id: 'receipt-live' }),
    sendReply: async () => { sends += 1; return { id: 'reply-live' }; }
  });
  const pending = consumer.handleMessage(discordMessage({ id: 'live-long-observation', channelId: 'channel-codex' }));
  await new Promise(resolve => setTimeout(resolve, 70));
  const marker = '[[discord-surface:live-long-observation]]';
  fs.appendFileSync(file, `${JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { phase: 'final_answer', content: [{ type: 'Text', text: `${marker}\nlive answer` }] } }, timestamp: new Date().toISOString() })}\n`);
  const result = await pending;
  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(result.message.replyText, 'live answer');
  assert.equal(dispatches, 1);
  assert.equal(sends, 1);
  assert.equal(state.getMessage('live-long-observation').observerCursor.offset, fs.statSync(file).size);
  state.close();
});

test('simulated: repeated native polls do not accumulate abort listeners', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-observer-'));
  const file = path.join(root, `${CODEX_ID}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { session_id: CODEX_ID }, timestamp: new Date().toISOString() })}\n`, { mode: 0o600 });
  const controller = new AbortController();
  const observation = observeCodexReply(CODEX_ID, readInitialCursor(CODEX_ID, root), {
    marker: '[[discord-surface:never-finished]]',
    root,
    pollMs: 3,
    timeoutMs: 10,
    continueUntilFinal: true,
    signal: controller.signal
  });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(getEventListeners(controller.signal, 'abort').length <= 1);
  controller.abort();
  const result = await observation;
  assert.equal(result.stopped, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('simulated: gateway stop cancels the live native observer without redispatch', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.markIntakeBoundary('channel-codex', 'ready');
  const client = new EventEmitter();
  client.destroy = async () => {};
  let dispatches = 0;
  let observations = 0;
  let stopped = 0;
  const gateway = new DiscordGateway({
    state,
    client,
    providers: {
      codex: {
        async dispatch() { dispatches += 1; return { status: 'submitted' }; },
        async observe(_message, _outcome, { signal }) {
          observations += 1;
          return new Promise(resolve => {
            const onAbort = () => { stopped += 1; resolve({ stopped: true }); };
            signal.addEventListener('abort', onAbort, { once: true });
          });
        }
      }
    }
  });
  gateway.ready = true;
  gateway.started = true;
  client.emit('messageCreate', discordMessage({ id: 'stop-live-observer', channelId: 'channel-codex' }));
  for (let attempt = 0; attempt < 100 && observations === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(observations, 1);
  await gateway.stop();
  assert.equal(stopped, 1);
  assert.equal(dispatches, 1);
  assert.equal(state.getMessage('stop-live-observer').state, MESSAGE_STATES.SUBMITTED);
  state.close();
});

test('simulated: reconnect recovery reuses the live observer without starting a duplicate', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.setIntakeBaseline('channel-codex', '100', 'previous completed recovery');
  state.markIntakeBoundary('channel-codex', 'ready');
  const channel = {
    messages: { fetch: async () => ({ react: async () => {} }) },
    id: 'channel-codex',
    guildId: 'guild-1',
    topic: '',
    permissionsFor: () => historyPermissions(),
    async send() { return { id: 'receipt-reconnect' }; }
  };
  const client = new EventEmitter();
  client.user = { id: 'bot-1' };
  client.channels = { fetch: async () => channel };
  client.destroy = async () => {};
  let observations = 0;
  const gateway = new DiscordGateway({
    state,
    client,
    providers: {
      codex: {
        async dispatch() { return { status: 'submitted' }; },
        async observe(_message, _outcome, { signal }) {
          observations += 1;
          return new Promise(resolve => signal.addEventListener('abort', () => resolve({ stopped: true }), { once: true }));
        }
      }
    },
    fetchHistory: async (_channel, options) => {
      if (options.after === '100') return [{ id: '101', guildId: 'guild-1', channelId: 'channel-codex', author: { id: 'operator-1', bot: false }, content: 'live input' }];
      return [];
    }
  });
  gateway.ready = true;
  gateway.started = true;
  client.emit('messageCreate', discordMessage({ id: '101', channelId: 'channel-codex', sends: [] }));
  for (let attempt = 0; attempt < 100 && observations === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(observations, 1);
  client.emit('shardDisconnect', new Error('socket lost'), 0);
  client.emit('shardReady', 0, new Set());
  await gateway.reconnectPromise;
  assert.equal(observations, 1);
  assert.equal(gateway.ready, true);
  assert.equal(state.getMessage('101').state, MESSAGE_STATES.SUBMITTED);
  await gateway.stop();
  state.close();
});

test('simulated: live native reply is fenced after operator revocation', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  let release;
  let observations = 0;
  let sends = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: {
      codex: {
        async dispatch() { return { status: 'submitted' }; },
        async observe() {
          observations += 1;
          return new Promise(resolve => { release = resolve; });
        }
      }
    },
    sendTransportReceipt: async () => ({ id: 'receipt-fenced' }),
    sendReply: async () => { sends += 1; return { id: 'reply-fenced' }; }
  });
  const pending = consumer.handleMessage(discordMessage({ id: 'revoked-live-reply', channelId: 'channel-codex' }));
  for (let attempt = 0; attempt < 100 && observations === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
  state.setConfig({ operatorId: 'different-operator', guildId: 'guild-1', secretFile: path.join(dir, 'discord.env') });
  release({ text: 'late native reply' });
  const result = await pending;
  assert.equal(result.status, 'stale-reply');
  assert.equal(state.getMessage('revoked-live-reply').state, MESSAGE_STATES.SUBMITTED);
  assert.equal(sends, 0);
  state.close();
});

test('simulated: unmatched Claude IPC custody is rejected and notification failure is uncertain', async () => {
  const { dir, state } = fixture();
  const socketDir = fs.mkdtempSync(path.join('/tmp', 'discord-surface-uncertain-'));
  fs.chmodSync(socketDir, 0o700);
  const socket = path.join(socketDir, 'channel.sock');
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
  state.acceptDiscordMessage({ id: 'claude-safe', guildId: 'guild-1', channelId: 'channel-claude', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('claude-safe');
  state.markSubmitted('claude-safe');
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => { throw new Error('delivery uncertain'); }, close: async () => {} } });
  await channel.start();
  const unknown = await postUnixJson(socket, { nativeId: CLAUDE_ID, messageId: 'unknown-message', generation: 1, content: 'x' });
  assert.equal(unknown.statusCode, 409);
  const uncertain = await postUnixJson(socket, { nativeId: CLAUDE_ID, messageId: 'claude-safe', generation: 1, content: 'x' });
  assert.equal(uncertain.statusCode, 503);
  await channel.stop();
  await channel.stop();
  state.close();
});

test('simulated: persisted Codex cursor resumes a late reply after state restart without redispatch', async () => {
  const fixtureState = fixture();
  const root = path.join(fixtureState.dir, 'sessions');
  fs.mkdirSync(root, { mode: 0o700 });
  const file = path.join(root, `${CODEX_ID}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { session_id: CODEX_ID }, timestamp: new Date().toISOString() })}\n`, { mode: 0o600 });
  fixtureState.state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: fixtureState.dir });
  fixtureState.state.acceptDiscordMessage({ id: 'late-after-restart', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  fixtureState.state.claimDispatch('late-after-restart');
  const cursor = readInitialCursor(CODEX_ID, root);
  fixtureState.state.markSubmitted('late-after-restart', cursor, '[[discord-surface:late-after-restart]]');
  fixtureState.state.close();
  const restarted = new SurfaceState(fixtureState.db);
  const marker = '[[discord-surface:late-after-restart]]';
  fs.appendFileSync(file, `${JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { phase: 'final_answer', content: [{ type: 'Text', text: `${marker}\nlate reply` }] } }, timestamp: new Date().toISOString() })}\n`);
  const provider = new CodexProvider({ root, run: async () => ({ status: 'submitted' }) });
  const result = await observeSubmitted(restarted, restarted.getMessage('late-after-restart'), provider, { timeoutMs: 500, pollMs: 5 });
  assert.equal(result.message.state, MESSAGE_STATES.REPLY_READY);
  assert.equal(result.message.replyText, 'late reply');
  restarted.close();
});
