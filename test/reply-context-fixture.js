'use strict';

// Reply-context behavior: normalization/persistence/hydration (T3) plus the
// bounded optional Discord lookup (T2), driven only through public entrypoints
// with disposable SQLite files and simulated Gateway/REST objects.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SurfaceState } = require('../src/state');
const { messageRequest, codexPrompt, claudeEvent } = require('../src/native');
const { createSurfaceConsumer } = require('../src/discord');
const { createMonitorMcp } = require('../src/claude-monitor');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { WATCHER_NOTICE_PREFIX, createWatcherNotice } = require('../src/watcher-notice');
const { encodeAgentMessage, KINDS } = require('../src/agent-message');
const { Routes } = require('discord.js');

const CODEX_ID = '22222222-2222-2222-2222-222222222222';
const CLAUDE_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_TOKEN = 'isolated-reply-context-credential';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-context-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: '900', guildId: '100', secretFile: path.join(dir, 'secret') });
  state.bind({ channelId: '101', guildId: '100', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '50' });
  return { dir, db, state };
}

function cleanup(state, dir) {
  try { state.close(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}

function providers() {
  return {
    codex: { async dispatch() { return { status: 'submitted' }; }, async observe() { return { text: 'ok' }; } },
    claude: { async dispatch() { return { status: 'submitted' }; }, async observe() { return { text: 'ok' }; } }
  };
}

function consumerFor(state, overrides = {}) {
  return createSurfaceConsumer({
    state,
    providers: providers(),
    sendReply: async () => ({ id: 'reply' }),
    ...overrides
  });
}

function gm({ id = '1000', channelId = '101', guildId = '100', authorId = '900', bot = false, content = 'hello',
  reference = null, cacheGet = null, restGet = null } = {}) {
  return {
    id,
    guildId,
    channelId,
    content,
    author: { id: authorId, bot },
    attachments: [],
    reference,
    channel: { messages: { cache: { get: cacheGet || (() => undefined) } } },
    client: { rest: { get: restGet || (async () => { throw new Error('unexpected REST'); }) } }
  };
}

function cacheEntry(id, overrides = {}) {
  return { id, channelId: '101', guildId: '100', content: 'cached text', author: { id: '900', bot: false }, ...overrides };
}

function validRaw(messageId, overrides = {}) {
  return { id: messageId, channel_id: '101', guild_id: '100', content: 'quoted text', author: { id: '900', bot: false }, ...overrides };
}

function validContext(messageId, overrides = {}) {
  return { messageId, channelId: '101', guildId: '100', excerpt: 'quoted text', isBotAuthor: false, ...overrides };
}

// createSurfaceConsumer.handleMessage returns the processed result while
// intakeMessage returns the intake result; both carry the persisted message.
function assertAccepted(result, state) {
  assert.ok(result, 'intake returned no result');
  if (result.accepted !== undefined) assert.equal(result.accepted, true);
  assert.ok(result.message && result.message.id, 'intake result did not carry a message');
  assert.ok(state.getMessage(result.message.id), 'accepted message was not persisted');
  return result.message;
}

async function waitFor(predicate, ms = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), 'condition did not become true before timeout');
}

async function withTimeout(promise, ms, label = 'operation timed out') {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));


module.exports = { CODEX_ID, CLAUDE_ID, AGENT_TOKEN, fixture, cleanup, providers, consumerFor, gm, cacheEntry, validRaw, validContext, assertAccepted, waitFor, withTimeout, tick };
