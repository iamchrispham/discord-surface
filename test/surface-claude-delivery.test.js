const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { postUnixJson } = require('../src/native');
const { SurfaceState, MESSAGE_STATES } = require('../src/state');
const { ACK } = require('../src/acknowledgment');
const { ClaudeChannel } = require('../src/claude-channel');
const requireInstalled = require;
const { NotificationSchema } = requireInstalled('@modelcontextprotocol/sdk/types.js');
const { z } = requireInstalled('zod');
const { CLAUDE_ID, CLI_PATH, fixture, attachmentMetadata, waitForFile, waitForProcessGone, collectStdoutJson } = require('./surface-fixtures');

test('simulated: Claude channel forwards only the bound generation and closes its socket', async () => {
  const { dir, state } = fixture();
  const socket = path.join(dir, 'claude.sock');
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
  state.acceptDiscordMessage({ id: 'claude-event', guildId: 'guild-1', channelId: 'channel-claude', authorId: 'operator-1', isBot: false, content: 'reply' });
  state.claimDispatch('claude-event');
  state.markSubmitted('claude-event');
  const events = [];
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async event => events.push(event) } });
  await channel.start();
  const response = await postUnixJson(socket, { nativeId: CLAUDE_ID, messageId: 'claude-event', generation: 1, content: 'reply' });
  assert.equal(response.statusCode, 202);
  const notification = events[0];
  NotificationSchema.parse(notification);
  z.object({
    method: z.literal('notifications/claude/channel'),
    params: z.object({
      content: z.string(),
      meta: z.record(z.string().regex(/^[A-Za-z0-9_]+$/), z.string())
    })
  }).parse(notification);
  assert.equal(notification.params.meta.messageId, 'claude-event');
  assert.equal(notification.params.meta.generation, '1');
  await channel.stop();
  assert.equal(fs.existsSync(socket), false);
  state.close();
});

test('simulated: Claude channel validates and forwards attachment-only events', async () => {
  const { dir, state } = fixture();
  const socketDir = fs.mkdtempSync('/tmp/dsa-');
  fs.chmodSync(socketDir, 0o700);
  const socket = path.join(socketDir, 'channel.sock');
  const attachment = attachmentMetadata();
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
  state.acceptDiscordMessage({ id: 'claude-attachment', guildId: 'guild-1', channelId: 'channel-claude', authorId: 'operator-1', isBot: false, content: '', attachments: [attachment] });
  state.claimDispatch('claude-attachment');
  state.markSubmitted('claude-attachment');
  const events = [];
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async event => events.push(event) } });
  await channel.start();
  const response = await postUnixJson(socket, {
    nativeId: CLAUDE_ID, messageId: 'claude-attachment', generation: 1, content: '',
    attachments: [attachment]
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(events[0].params.attachments, [attachment]);
  const rejected = await postUnixJson(socket, {
    nativeId: CLAUDE_ID, messageId: 'claude-attachment', generation: 1, content: '',
    attachments: [attachmentMetadata({ url: 'javascript:alert(1)' })]
  });
  assert.equal(rejected.statusCode, 400);
  assert.equal(events.length, 1);
  await channel.stop();
  state.close();
});

test('simulated: Claude Monitor child emits one event and CLI reply records exact custody', async () => {
  const { dir, db, state } = fixture('monitor-custom.sqlite');
  const socketDir = fs.mkdtempSync('/tmp/dsm-');
  fs.chmodSync(socketDir, 0o700);
  const socket = path.join(socketDir, 'monitor.sock');
  const messageId = 'claude-monitor-event';
  const content = `raw monitor content ✓\n${'keep exact ✓ '.repeat(300)}`;
  const attachments = [attachmentMetadata({ filename: 'monitor.png', size: 777 })];
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
  state.acceptDiscordMessage({ id: messageId, guildId: 'guild-1', channelId: 'channel-claude', authorId: 'operator-1', isBot: false, content, attachments });
  state.claimDispatch(messageId);
  state.markSubmitted(messageId);
  state.close();

  const child = spawn(process.execPath, [CLI_PATH, 'claude-monitor', '--state-dir', dir, '--db', db, '--native-id', CLAUDE_ID, '--socket', socket], {
    cwd: path.dirname(CLI_PATH),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const stdout = collectStdoutJson(child);
  let foreignReplyFile;
  try {
    await waitForFile(socket);
    child.stdin.end();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.doesNotThrow(() => process.kill(child.pid, 0));

    const response = await postUnixJson(socket, {
      nativeId: CLAUDE_ID, messageId, generation: 1, content: 'tampered transport content',
      attachments: [attachmentMetadata({ url: 'https://attacker.invalid/tampered.txt', filename: 'tampered.txt' })]
    });
    assert.equal(response.statusCode, 202);
    await stdout.waitForCount(1);
    const pointer = stdout.events[0];
    assert.equal(pointer.type, 'discord-surface/claude-monitor');
    assert.ok(pointer.payloadPath);
    assert.ok(JSON.stringify(pointer).length < 500);
    assert.deepEqual(pointer.meta, { messageId, nativeId: CLAUDE_ID, generation: '1' });
    assert.match(pointer.instructions, /Read the payload/);
    assert.equal(path.dirname(path.dirname(pointer.payloadPath)), path.resolve(dir));
    assert.equal(fs.statSync(path.dirname(pointer.payloadPath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(pointer.payloadPath).mode & 0o777, 0o600);
    assert.ok(fs.statSync(pointer.payloadPath).size > 500);
    const event = JSON.parse(fs.readFileSync(pointer.payloadPath, 'utf8'));
    assert.equal(event.type, 'discord-surface/claude-monitor');
    assert.equal(event.content, content);
    assert.deepEqual(event.attachments, attachments);
    assert.deepEqual(event.meta, { messageId, nativeId: CLAUDE_ID, generation: '1' });
    assert.equal(event.reply.messageId, messageId);
    assert.equal(event.reply.nativeId, CLAUDE_ID);
    assert.equal(event.reply.generation, 1);
    assert.deepEqual(event.reply.command.slice(2, 4), ['claude-reply', '--state-dir']);
    const dbIndex = event.reply.command.indexOf('--db');
    assert.equal(event.reply.command[dbIndex + 1], db);
    assert.equal(event.acknowledgment.command[0], process.execPath);
    assert.equal(event.acknowledgment.command[2], 'native-ack');
    const ackDbIndex = event.acknowledgment.command.indexOf('--db');
    assert.equal(event.acknowledgment.command[ackDbIndex + 1], db);
    const acknowledged = spawnSync(event.acknowledgment.command[0], event.acknowledgment.command.slice(1), { encoding: 'utf8' });
    assert.equal(acknowledged.status, 0, acknowledged.stderr);
    const afterAck = new SurfaceState(db);
    assert.equal(afterAck.getMessage(messageId).state, MESSAGE_STATES.SUBMITTED);
    assert.equal(afterAck.listReceipts().filter(row => row.discord_id === messageId && row.kind === ACK.RECEIVED).length, 1);
    afterAck.close();
    assert.equal(fs.existsSync(event.reply.textFile), false);
    fs.mkdirSync(path.dirname(event.reply.textFile), { recursive: true, mode: 0o700 });
    foreignReplyFile = path.join(path.dirname(event.reply.textFile), 'foreign-conductor.txt');
    fs.writeFileSync(foreignReplyFile, 'keep this file');

    const wrongGenerationFile = path.join(dir, 'wrong-generation.txt');
    fs.writeFileSync(wrongGenerationFile, 'wrong generation');
    const wrongGeneration = spawnSync(process.execPath, [
      CLI_PATH, 'claude-reply', '--state-dir', dir, '--db', db, '--message-id', messageId,
      '--native-id', CLAUDE_ID, '--generation', '2', '--text-file', wrongGenerationFile
    ], { encoding: 'utf8' });
    assert.notEqual(wrongGeneration.status, 0);
    assert.match(wrongGeneration.stderr, /native reply is stale/);

    const duplicate = await postUnixJson(socket, { nativeId: CLAUDE_ID, messageId, generation: 1, content: 'tampered duplicate content' });
    assert.equal(duplicate.statusCode, 202);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(stdout.events.length, 1);
    assert.equal(fs.existsSync(event.reply.textFile), false);

    fs.writeFileSync(event.reply.textFile, 'exact Claude answer ✓');
    const reply = spawnSync(process.execPath, event.reply.command.slice(1), { encoding: 'utf8' });
    assert.equal(reply.status, 0, reply.stderr);
    assert.deepEqual(JSON.parse(reply.stdout), { messageId, recorded: true, duplicate: false, state: 'reply_ready' });

    const checked = new SurfaceState(db);
    assert.equal(checked.getMessage(messageId).state, MESSAGE_STATES.REPLY_READY);
    assert.equal(checked.getMessage(messageId).replyText, 'exact Claude answer ✓');
    checked.close();

    const concurrent = spawnSync(process.execPath, [CLI_PATH, 'claude-monitor', '--state-dir', dir, '--db', db, '--native-id', CLAUDE_ID, '--socket', socket], { encoding: 'utf8' });
    assert.notEqual(concurrent.status, 0);
    assert.match(concurrent.stderr, /socket already exists/);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await waitForProcessGone(child.pid);
    assert.equal(fs.existsSync(socket), false);
    if (stdout.events[0]?.payloadPath) {
      assert.equal(fs.existsSync(stdout.events[0].payloadPath), true);
      assert.equal(JSON.parse(fs.readFileSync(stdout.events[0].payloadPath, 'utf8')).content, content);
    }
    if (foreignReplyFile) assert.equal(fs.readFileSync(foreignReplyFile, 'utf8'), 'keep this file');
    try { fs.rmSync(socketDir, { recursive: true, force: true }); } catch {}
  }
});

test('simulated: Claude dispatch rechecks authorization after intake', async () => {
  const { dir, state } = fixture();
  const socketDir = fs.mkdtempSync(path.join('/tmp', 'discord-surface-auth-'));
  fs.chmodSync(socketDir, 0o700);
  const socket = path.join(socketDir, 'channel.sock');
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
  state.acceptDiscordMessage({ id: 'claude-revoked', guildId: 'guild-1', channelId: 'channel-claude', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('claude-revoked');
  state.setConfig({ operatorId: 'operator-revoked', guildId: 'guild-1', secretFile: path.join(dir, 'discord.secret') });
  const events = [];
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async event => events.push(event) } });
  await channel.start();
  const response = await postUnixJson(socket, { nativeId: CLAUDE_ID, messageId: 'claude-revoked', generation: 1, content: 'x' });
  assert.equal(response.statusCode, 409);
  assert.equal(events.length, 0);
  assert.ok(state.listReceipts().some(receipt => receipt.kind === 'native-dispatch-rejected-auth'));
  await channel.stop();
  state.close();
});

test('simulated: Claude transport close stops its HTTP and socket resources', async () => {
  const { dir, state } = fixture();
  const socketDir = fs.mkdtempSync(path.join('/tmp', 'discord-surface-close-'));
  fs.chmodSync(socketDir, 0o700);
  const socket = path.join(socketDir, 'channel.sock');
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
  const mcp = { notification: async () => {}, close: async () => {} };
  let databaseClosed = false;
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp, onTransportClose: () => { databaseClosed = true; state.close(); } });
  await channel.start();
  mcp.onclose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(channel.started, false);
  assert.equal(fs.existsSync(socket), false);
  assert.equal(databaseClosed, true);
});

test('simulated: Claude start failure closes MCP and stop retries a close failure', async () => {
  const { dir, state } = fixture();
  const socketDir = fs.mkdtempSync(path.join('/tmp', 'discord-surface-start-'));
  fs.chmodSync(socketDir, 0o700);
  const socket = path.join(socketDir, 'channel.sock');
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
  let closes = 0;
  const failedMcp = { connect: async () => { throw new Error('connect failed'); }, transportFactory: () => ({}), close: async () => { closes += 1; } };
  const failed = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: failedMcp });
  await assert.rejects(() => failed.start(), /connect failed/);
  assert.equal(closes, 1);
  assert.equal(fs.existsSync(socket), false);

  const retrySocket = path.join(socketDir, 'retry.sock');
  state.rebind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: retrySocket });
  let retryCloses = 0;
  const retryMcp = { close: async () => { retryCloses += 1; if (retryCloses === 1) throw new Error('close failed'); } };
  const retry = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: retrySocket, mcp: retryMcp });
  await retry.start();
  await assert.rejects(() => retry.stop(), error => error instanceof AggregateError && error.errors.some(item => /close failed/.test(item.message)));
  await retry.stop();
  assert.equal(retryCloses, 2);
  assert.equal(fs.existsSync(retrySocket), false);
  state.close();
});
