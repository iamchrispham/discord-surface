const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const readline = require('node:readline');
const test = require('node:test');
const { SurfaceState, MESSAGE_STATES } = require('../src/state');
const { DiscordGateway, createSurfaceConsumer } = require('../src/discord');
const { recordNativeAcknowledgment, watchAcknowledgments } = require('../src/acknowledgment.js');

const NATIVE = {
  codex: '9caa5d21-2169-429d-918b-5f08651b5dbd',
  claude: '79e3da8e-94b4-4aff-8f88-b45b3a451dd1'
};

function fixture(t, provider = 'codex') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-reply-file-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  fs.writeFileSync(path.join(dir, 'discord.env'), 'DISCORD_TOKEN=fixture\n', { mode: 0o600 });
  state.bind({ channelId: 'channel', guildId: 'guild', provider, nativeId: NATIVE[provider], workspace: dir,
    endpoint: provider === 'claude' ? '/tmp/claude.sock' : undefined, conductorId: 'conductor', repoKey: 'repo:fixture' });
  const binding = state.getBinding('channel');
  state.setBindingReadiness('channel', 'ready', 'fixture ready', binding);
  t.after(() => { try { state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, state, provider, nativeId: NATIVE[provider] };
}

function submitted(f, id, dispatchState = MESSAGE_STATES.SUBMITTED) {
  f.state.acceptDiscordMessage({ id, guildId: 'guild', channelId: 'channel', authorId: 'operator', isBot: false, content: 'question' });
  f.state.claimDispatch(id);
  if (dispatchState === MESSAGE_STATES.UNCERTAIN) f.state.markUncertain(id, new Error('dispatch interrupted'));
  else if (dispatchState === MESSAGE_STATES.SUBMITTED) f.state.markSubmitted(id);
}

function waitForCondition(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('condition was not met before timeout'));
      setImmediate(check);
    };
    check();
  });
}

function directPreparationSeed(f, index) {
  const preparationId = `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`;
  const owner = f.state.directPostOwnerIdentity(process.pid);
  return {
    preparationId,
    requestId: `direct-capacity-${index}`,
    custodyRoot: f.dir,
    sourcePath: path.join(f.dir, `${preparationId}.bin`),
    stagedPath: path.join(f.dir, '.direct-post-files', `${preparationId}.bin`),
    filename: `${preparationId}.bin`,
    size: 0,
    caption: 'held direct file',
    captionHash: `caption-hash-${index}`,
    channelId: 'channel',
    guildId: 'guild',
    provider: f.provider,
    nativeId: f.nativeId,
    generation: 1,
    operatorId: 'operator',
    inReplyTo: null,
    ownerPid: owner.ownerPid,
    ownerStartTime: owner.ownerStartTime,
    ownerCommand: owner.ownerCommand
  };
}

module.exports = {
  assert,
  fs,
  os,
  path,
  spawn,
  spawnSync,
  EventEmitter,
  readline,
  test,
  SurfaceState,
  MESSAGE_STATES,
  DiscordGateway,
  createSurfaceConsumer,
  recordNativeAcknowledgment,
  watchAcknowledgments,
  NATIVE,
  fixture,
  submitted,
  waitForCondition,
  directPreparationSeed
};
