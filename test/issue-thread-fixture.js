const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChannelType, GatewayIntentBits } = require('discord.js');
const { SurfaceState, MESSAGE_STATES, READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { DiscordGateway, waitForRecoveryOperation } = require('../src/discord');
const { enrollPublicThread, recoverThread, AdoptionRefusalError, ADOPTION_REFUSAL_DETAILS } = require('../src/discord/thread-enrollment');
const { GATEWAY_CAPABILITIES, gatewayProcessStatus, main, pathsFor, threadEnroll } = require('../src/cli');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const { startReconciliationLookup } = require('../dist/discord/reconciliation-lookups');

const NATIVE = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const SUCCESSOR = 'f8296579-092b-4503-bf98-1f3c2b6d4913';

function fixture(t, gatewayRecoveryOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-issue-thread-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'unused.secret') });
  state.bind({ channelId: '1000', guildId: 'guild', provider: 'codex', nativeId: NATIVE, workspace: dir }, { intakeCutoff: '0' });
  const sends = [], reactions = [], dispatched = [], fetched = [];
  const histories = new Map([['1000', []], ['2000', []]]);
  const channels = new Map();
  const makeChannel = (id, type) => ({
    id, guildId: 'guild', type, ...(type === ChannelType.PublicThread ? { parentId: '1000', locked: false, archived: false } : {}),
    isThread: () => type === ChannelType.PublicThread,
    permissionsFor: () => ({ has: () => true }),
    async send(options) { sends.push({ channelId: id, ...options }); return { id: `sent-${sends.length}` }; },
    messages: { async fetch(options) {
      if (typeof options === 'string') return { react: async reaction => reactions.push({ channelId: id, messageId: options, reaction }) };
      const history = histories.get(id);
      if (options.limit === 1 && !options.after) return history.slice(-1);
      return history.filter(message => !options.after || BigInt(message.id) > BigInt(options.after)).slice(0, options.limit);
    } }
  });
  const parent = makeChannel('1000', ChannelType.GuildText);
  const child = makeChannel('2000', ChannelType.PublicThread);
  channels.set(parent.id, parent); channels.set(child.id, child);
  const client = { user: { id: 'bot' }, on() {}, off() {}, async destroy() {},
    channels: { async fetch(id) { fetched.push(id); return channels.get(id) || null; } }
  };
  const gateway = new DiscordGateway({ state, client, providers: { codex: {
    async dispatch(message) {
      dispatched.push(message);
      recordNativeAcknowledgment(state, { provider: 'codex', messageId: message.id, nativeId: message.nativeId, generation: message.generation });
      return { status: 'submitted' };
    },
    async observe() { return { text: 'thread answer' }; }
  } }, recoveryOptions: { ordinaryNativePreflight: async () => true, ...gatewayRecoveryOptions } });
  t.after(async () => { await gateway.stop(); state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const message = (id, channel = child) => ({ id, guildId: 'guild', channelId: channel.id, content: 'thread question', author: { id: 'operator', bot: false }, channel });
  function ready(baseline = null) {
    // The child's committed cutoff is exactly the adopted history bound; null means a
    // prospective-empty thread and commits the explicit "0" boundary.
    state.enrollThread({ threadId: child.id, parentChannelId: parent.id, guildId: 'guild', adoptionCutoff: baseline ?? '0' }, state.getBinding(parent.id));
    state.setThreadBaseline(child.id, baseline, state.getBinding(parent.id));
    state.markThreadBoundary(child.id, THREAD_STATES.READY, 'fixture adoption', null, null, state.getBinding(parent.id));
    gateway.ready = true;
  }
  return { dir, state, parent, child, channels, client, gateway, histories, sends, reactions, dispatched, fetched, message, ready, makeChannel };
}

module.exports = { fixture, NATIVE, SUCCESSOR };
