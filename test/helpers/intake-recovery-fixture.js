const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChannelType } = require('discord.js');
const { SurfaceState } = require('../../src/state');
const { DiscordGateway } = require('../../src/discord');
const { recordNativeAcknowledgment } = require('../../src/acknowledgment');

function fixture(t, { adoptThread = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-recovery-'));
  const db = path.join(dir, 'surface.sqlite');
  let state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'unused') });
  state.bind({ channelId: '1000', guildId: 'guild', provider: 'codex',
    nativeId: '11111111-1111-1111-1111-111111111111', workspace: dir });
  state.setIntakeBaseline('1000', '100', 'fixture');
  state.markIntakeBoundary('1000', 'ready');
  state.enrollThread({ threadId: '2000', parentChannelId: '1000', guildId: 'guild' }, state.getBinding('1000'));
  if (adoptThread) {
    state.setThreadBaseline('2000', '100', state.getBinding('1000'));
    state.markThreadBoundary('2000', 'ready');
  }
  let fault = null;
  let deliveryAllowed = false;
  const dispatched = [], replies = [];
  const secret = path.join(dir, 'unused');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=disposable-test-token\n', { mode: 0o600 });
  const calls = [];
  const history = new Map([['1000', []], ['2000', []]]);
  const channels = new Map(['1000', '2000'].map(id => [id, {
    id, guildId: 'guild', type: id === '1000' ? ChannelType.GuildText : ChannelType.PublicThread,
    parentId: id === '2000' ? '1000' : null, isThread: () => id === '2000',
    permissionsFor: () => ({ has: () => true }),
    async send(options) { replies.push({ channelId: id, ...options }); return { id: `reply-${replies.length}` }; },
    messages: { async fetch() { return { async react() {} }; } }
  }]));
  const check = (kind, id, after) => {
    calls.push({ kind, id, after });
    if (fault?.kind === kind && fault.id === id && (!fault.after || fault.after === after)) {
      throw Object.assign(new Error('fetch failed'), { status: fault.status });
    }
  };
  const client = { user: { id: 'bot' }, on() {}, off() {}, async login() {}, async destroy() {},
    channels: { async fetch(id) { check('channel', id); return channels.get(id); } }
  };
  const options = { client, fetchHistory: async (channel, options) => {
    check('history', channel.id, options.after);
    return history.get(channel.id).filter(m => !options.after || BigInt(m.id) > BigInt(options.after)).slice(0, options.limit);
  }, recoveryOptions: { pageLimit: 1 }, providers: { codex: {
    async dispatch(message) {
      assert.ok(deliveryAllowed, 'recovery must not dispatch native work');
      dispatched.push(message);
      recordNativeAcknowledgment(state, { provider: 'codex', messageId: message.id, nativeId: message.nativeId, generation: message.generation });
      return { status: 'submitted' };
    },
    async observe() { return { text: 'recovered answer' }; }
  } } };
  let gateway = new DiscordGateway({ ...options, state });
  t.after(async () => { await gateway.stop(); state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return {
    get state() { return state; }, get gateway() { return gateway; }, calls, history, channels, dispatched, replies, secret,
    enableDelivery() { deliveryAllowed = true; },
    fail(value) { fault = value; },
    async reopen() { await gateway.stop(); state.close(); state = new SurfaceState(db); gateway = new DiscordGateway({ ...options, state }); },
    recover(signal = new AbortController().signal) { return gateway.recoverInbound(signal, 'restart'); },
    boundary(id) { return id === '1000' ? state.getIntakeWatermark(id) : state.getThreadEnrollment(id); },
    cursor(id) { return id === '1000' ? state.getIntakeWatermark(id).recovered_through_id : state.getThreadEnrollment(id).recoveredThroughId; },
    message(id, channelId) { return { id, channelId, guildId: 'guild', content: 'fresh work', author: { id: 'operator', bot: false }, channel: channels.get(channelId) }; }
  };
}

module.exports = { fixture };
