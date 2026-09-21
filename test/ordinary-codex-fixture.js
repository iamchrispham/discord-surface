const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ORDINARY_BINDING_DECISIONS, createOrdinaryCodexRequestFromEnvironment, ordinaryBindingDecision, resolveExistingChannel, resolveInvocationIdentity } = require('../src/ordinary-codex');
const { createBindingWakeController, GATEWAY_CAPABILITIES, handoffInternal, ordinaryBind, requestGatewayRecovery, unbind } = require('../src/cli');
const { DiscordGateway } = require('../src/discord');
const { CodexProvider, readCodexSessionIdentityAsync, sessionRoot, validateCodexSessionIdentity, validateCodexSessionIdentityAsync } = require('../src/native');
const { SurfaceState, PROVIDERS, READINESS, StaleGenerationError } = require('../src/state');
const { ORDINARY_RECEIPT_KINDS } = require('../src/ordinary/constants');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { runDirectPost } = require('../src/direct-post');
const { staticConductorMarker } = require('../src/topic');
const { ordinaryBind: ordinaryBindModule, reconcileProofUnavailableIntake } = require('../src/ordinary-bind');
const facade = require('../src/ordinary-codex');
const emitted = require('../dist/ordinary-codex');
const ordinaryConstantsFacade = require('../src/ordinary/constants');
const ordinaryConstantsEmitted = require('../dist/ordinary/constants');

const CODEX = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const CODEX_V7 = '01a0701c-5714-7671-a455-db7d67f9fa78';
const OTHER = '79e3da8e-94b4-4aff-8f88-b45b3a451dd1';
const ORDINARY_NATIVE_PROOF_UNAVAILABLE_PREFIX = 'Codex transcript proof unavailable before event write:';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-codex-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  const identity = { sessionId: CODEX, threadId: CODEX };
  t.after(() => {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, identity, state };
}

function ordinary(fixtureState, channelId = 'ordinary-channel', nativeId = CODEX) {
  return fixtureState.state.bindOrdinary({
    channelId, guildId: 'guild', provider: PROVIDERS.CODEX, nativeId, workspace: fixtureState.dir
  }, { sessionId: nativeId, threadId: nativeId });
}

function transcript(t, workspace, id = CODEX, overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-transcript-'));
  const root = path.join(home, 'sessions');
  fs.mkdirSync(root);
  const file = path.join(root, `${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: {
    session_id: id, id, cwd: workspace, ...overrides
  } })}\n`);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { root, file };
}

function controlRootEnumeration(t, root, tailNames) {
  const originalOpendir = fs.promises.opendir;
  const orders = [];
  t.mock.method(fs.promises, 'opendir', async (target, ...args) => {
    const handle = await originalOpendir(target, ...args);
    if (path.resolve(String(target)) !== path.resolve(root)) return handle;
    const entries = [];
    try {
      for (;;) {
        const entry = await handle.read();
        if (!entry) break;
        entries.push(entry);
      }
    } finally {
      try { await handle.close(); } catch {}
    }
    const tail = new Set(tailNames);
    const ordered = entries.filter(entry => !tail.has(entry.name)).concat(entries.filter(entry => tail.has(entry.name)));
    orders.push(ordered.map(entry => entry.name));
    let index = 0;
    return {
      read: async () => ordered[index++] || null,
      close: async () => {}
    };
  });
  return orders;
}

module.exports = {
  test,
  assert,
  spawnSync,
  EventEmitter,
  Module,
  fs,
  os,
  path,
  ORDINARY_BINDING_DECISIONS,
  createOrdinaryCodexRequestFromEnvironment,
  ordinaryBindingDecision,
  resolveExistingChannel,
  resolveInvocationIdentity,
  createBindingWakeController,
  GATEWAY_CAPABILITIES,
  handoffInternal,
  ordinaryBind,
  requestGatewayRecovery,
  unbind,
  DiscordGateway,
  CodexProvider,
  readCodexSessionIdentityAsync,
  sessionRoot,
  validateCodexSessionIdentity,
  validateCodexSessionIdentityAsync,
  SurfaceState,
  PROVIDERS,
  READINESS,
  StaleGenerationError,
  ORDINARY_RECEIPT_KINDS,
  THREAD_STATES,
  runDirectPost,
  staticConductorMarker,
  ordinaryBindModule,
  reconcileProofUnavailableIntake,
  facade,
  emitted,
  ordinaryConstantsFacade,
  ordinaryConstantsEmitted,
  CODEX,
  CODEX_V7,
  OTHER,
  ORDINARY_NATIVE_PROOF_UNAVAILABLE_PREFIX,
  fixture,
  ordinary,
  transcript,
  controlRootEnumeration
};
