const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SurfaceState, READINESS, DIRECT_POST_OUTCOMES: stateOutcomes } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');

const CODEX = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const CLAUDE = '79e3da8e-94b4-4aff-8f88-b45b3a451dd1';

function fixture(t, provider = 'codex') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-post-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  fs.writeFileSync(path.join(dir, 'discord.env'), 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  const nativeId = provider === 'claude' ? CLAUDE : CODEX;
  state.bind({ channelId: 'channel', guildId: 'guild', provider, nativeId, workspace: dir,
    endpoint: provider === 'claude' ? '/tmp/claude-channel.sock' : undefined, conductorId: 'conductor', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
  const textFile = path.join(dir, 'milestone.txt');
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, state, nativeId, textFile };
}

function agentFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-direct-post-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: '900', guildId: '100', secretFile: path.join(dir, 'discord.env') });
  fs.writeFileSync(path.join(dir, 'discord.env'), 'DISCORD_TOKEN=fixture\n', { mode: 0o600 });
  state.bind({ channelId: '101', guildId: '100', provider: 'codex', nativeId: CODEX, workspace: dir,
    conductorId: 'conductor', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
  let binding = state.getBinding('101');
  binding = state.setBindingReadiness('101', READINESS.READY, 'agent fixture ready', binding);
  state.enrollThread({ threadId: '103', parentChannelId: '101', guildId: '100', adoptionCutoff: '0'}, binding);
  state.setThreadBaseline('103', '0', binding);
  state.markThreadBoundary('103', THREAD_STATES.READY, 'agent fixture child ready', null, null, binding);
  const textFile = path.join(dir, 'milestone.txt');
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, state, nativeId: CODEX, agentThreadId: '103', textFile };
}

function response(id, status = 200) {
  return { ok: status >= 200 && status < 300, status, body: { cancel() {} }, json: async () => ({ id }) };
}

function fetchRecorder({ responses = [], pending = false } = {}) {
  const calls = [];
  let release;
  const fetchImpl = async (_url, options) => {
    calls.push({ body: JSON.parse(options.body), signal: options.signal });
    if (pending) return new Promise((resolve, reject) => {
      release = () => resolve(response(`direct-${calls.length}`));
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
    return responses[calls.length - 1] || response(`direct-${calls.length}`);
  };
  return { calls, fetchImpl, release: () => release?.() };
}

function multipartRecorder() {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const parts = [];
    for await (const [name, value] of options.body.entries()) {
      parts.push([name, typeof value === 'string' ? value : {
        filename: value.name,
        bytes: Buffer.from(await value.arrayBuffer())
      }]);
    }
    calls.push(parts);
    return response(`file-${calls.length}`);
  };
  return { calls, fetchImpl };
}

function preparationSeed(f, preparationId, overrides = {}) {
  const owner = f.state.directPostOwnerIdentity(process.pid);
  return {
    preparationId,
    requestId: `request-${preparationId}`,
    custodyRoot: f.dir,
    sourcePath: path.join(f.dir, `${preparationId}.bin`),
    stagedPath: path.join(f.dir, '.direct-post-files', `${preparationId}.bin`),
    filename: `${preparationId}.bin`,
    size: 0,
    caption: 'held file',
    captionHash: 'caption-hash',
    channelId: 'channel',
    guildId: 'guild',
    provider: 'codex',
    nativeId: f.nativeId,
    generation: 1,
    operatorId: 'operator',
    inReplyTo: null,
    conductorId: 'conductor',
    repoKey: 'repo:fixture',
    ownerPid: owner?.ownerPid || 999999,
    ownerStartTime: owner?.ownerStartTime || null,
    ownerCommand: owner?.ownerCommand || null,
    ...overrides
  };
}

module.exports = { CODEX, CLAUDE, fixture, agentFixture, response, fetchRecorder, multipartRecorder, preparationSeed };
