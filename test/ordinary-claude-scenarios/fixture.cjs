const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SurfaceState } = require('../../src/state');

const CLAUDE = '79e3da8e-94b4-4aff-8f88-b45b3a451dd1';
const OTHER = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const CLI_PATH = path.resolve(__dirname, '../../src/cli.js');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error('timed out waiting for ordinary Claude condition');
}

function transcript(t, workspace, nativeId = CLAUDE, cwd = workspace) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-claude-transcript-'));
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'custom-title', sessionId: nativeId }),
    JSON.stringify({ type: 'attachment', sessionId: nativeId, cwd, entrypoint: 'cli', version: '1.0.0', attachment: { hookEvent: 'SessionStart' } })
  ].join('\n') + '\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file };
}

function fixture(t, { bind = true, endpoint = null, preflight = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-claude-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  const socketPath = endpoint || path.join(dir, 'claude.sock');
  const session = transcript(t, dir);
  let binding = null;
  if (bind) {
    binding = state.bindOrdinaryClaude({ channelId: 'claude-channel', guildId: 'guild', provider: 'claude', nativeId: CLAUDE, workspace: dir, endpoint: socketPath },
      { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' });
    if (preflight) state.recordOrdinaryPreflight(binding, {
      file: session.file, sessionId: CLAUDE, threadId: CLAUDE, workspace: dir, endpoint: socketPath, harness: 'claude-code'
    });
  }
  t.after(() => {
    try { state.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, db, state, socketPath, session, binding };
}

function fakeClient(channel) {
  return class FakeClient {
    constructor() {
      this.guilds = { fetch: async () => ({ channels: {
        fetch: async selection => selection ? channel : new Map([[channel.id, channel]])
      } }) };
    }
    async login() {}
    async destroy() {}
  };
}

module.exports = { CLAUDE, OTHER, CLI_PATH, fakeClient, fixture, sleep, transcript, waitFor };
