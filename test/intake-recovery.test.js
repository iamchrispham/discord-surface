const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChannelType } = require('discord.js');
const { SurfaceState } = require('../src/state');
const { DiscordGateway } = require('../src/discord');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-recovery-'));
  const db = path.join(dir, 'surface.sqlite');
  let state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'unused') });
  state.bind({ channelId: '1000', guildId: 'guild', provider: 'codex',
    nativeId: '11111111-1111-1111-1111-111111111111', workspace: dir });
  state.setIntakeBaseline('1000', '100', 'fixture');
  state.markIntakeBoundary('1000', 'ready');
  state.enrollThread({ threadId: '2000', parentChannelId: '1000', guildId: 'guild' }, state.getBinding('1000'));
  state.setThreadBaseline('2000', '100', state.getBinding('1000'));
  state.markThreadBoundary('2000', 'ready');
  let fault = null;
  const calls = [];
  const history = new Map([['1000', []], ['2000', []]]);
  const channels = new Map(['1000', '2000'].map(id => [id, {
    id, guildId: 'guild', type: id === '1000' ? ChannelType.GuildText : ChannelType.PublicThread,
    parentId: id === '2000' ? '1000' : null, isThread: () => id === '2000',
    permissionsFor: () => ({ has: () => true })
  }]));
  const check = (kind, id, after) => {
    calls.push({ kind, id, after });
    if (fault?.kind === kind && fault.id === id && (!fault.after || fault.after === after)) {
      throw Object.assign(new Error('fetch failed'), { status: fault.status });
    }
  };
  const client = { user: { id: 'bot' }, on() {}, off() {}, async destroy() {},
    channels: { async fetch(id) { check('channel', id); return channels.get(id); } }
  };
  const options = { client, fetchHistory: async (channel, options) => {
    check('history', channel.id, options.after);
    return history.get(channel.id).filter(m => !options.after || BigInt(m.id) > BigInt(options.after)).slice(0, options.limit);
  }, recoveryOptions: { pageLimit: 1 }, providers: { codex: {
    async dispatch() { assert.fail('recovery must not dispatch native work'); }
  } } };
  let gateway = new DiscordGateway({ ...options, state });
  t.after(async () => { await gateway.stop(); state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return {
    get state() { return state; }, get gateway() { return gateway; }, calls, history, channels,
    fail(value) { fault = value; },
    async reopen() { await gateway.stop(); state.close(); state = new SurfaceState(db); gateway = new DiscordGateway({ ...options, state }); },
    recover(signal = new AbortController().signal) { return gateway.recoverInbound(signal, 'restart'); },
    boundary(id) { return id === '1000' ? state.getIntakeWatermark(id) : state.getThreadEnrollment(id); },
    cursor(id) { return id === '1000' ? state.getIntakeWatermark(id).recovered_through_id : state.getThreadEnrollment(id).recoveredThroughId; },
    message(id, channelId) { return { id, channelId, guildId: 'guild', content: 'fresh work', author: { id: 'operator', bot: false }, channel: channels.get(channelId) }; }
  };
}

for (const id of ['1000', '2000']) {
  for (const kind of ['channel', 'history']) {
    test(`${id} ${kind} 503 retries after database reopen without resetting coverage`, async t => {
      const f = fixture(t);
      f.fail({ id, kind, status: 503 });
      await f.recover();
      assert.equal(f.boundary(id).state, 'unavailable');
      assert.equal(f.cursor(id), '100');
      await f.reopen();
      f.fail(null); f.calls.length = 0;
      await f.recover();
      assert.equal(f.boundary(id).state, 'ready');
      assert.ok(f.calls.some(c => c.id === id && c.kind === kind));
      assert.equal(f.cursor(id), '100');
    });
  }
  test(`${id} HTTP 403 and unclassified unavailable remain held after reopen`, async t => {
    const f = fixture(t);
    f.fail({ id, kind: 'channel', status: 403 });
    await f.recover();
    await f.reopen(); f.fail(null); f.calls.length = 0;
    await f.recover();
    assert.equal(f.boundary(id).state, 'unavailable');
    assert.equal(f.calls.filter(c => c.id === id).length, 0);
    assert.equal(f.cursor(id), '100');
  });
  test(`${id} partial history survives a later 503 and resumes from durable coverage`, async t => {
    const f = fixture(t);
    f.history.set(id, [f.message('101', id), f.message('102', id)]);
    f.fail({ id, kind: 'history', status: 503, after: '101' });
    await f.recover();
    assert.equal(f.boundary(id).state, 'unavailable');
    assert.equal(f.cursor(id), '101');
    assert.ok(f.state.getMessage('101'));
    assert.equal(f.state.getMessage('102'), null);
    await f.reopen(); f.fail(null); f.calls.length = 0;
    await f.recover();
    assert.equal(f.boundary(id).state, 'ready');
    assert.equal(f.cursor(id), '102');
    assert.ok(f.state.getMessage('102'));
    assert.equal(f.calls.find(c => c.id === id && c.kind === 'history').after, '101');
  });
  test(`${id} explicit gap never retries even with a prior 503 detail`, async t => {
    const f = fixture(t);
    f.fail({ id, kind: 'channel', status: 503 }); await f.recover();
    const detail = f.boundary(id).detail;
    if (id === '1000') f.state.markIntakeBoundary(id, 'gap', detail);
    else f.state.markThreadBoundary(id, 'gap', detail);
    await f.reopen(); f.fail(null); f.calls.length = 0;
    await f.recover();
    assert.equal(f.boundary(id).state, 'gap');
    assert.equal(f.calls.filter(c => c.id === id).length, 0);
  });
}

for (const id of ['1000', '2000']) {
  test(`${id} retry still validates permissions before advancing history`, async t => {
    const f = fixture(t);
    f.fail({ id, kind: 'channel', status: 503 }); await f.recover();
    await f.reopen(); f.fail(null);
    f.channels.get(id).permissionsFor = () => ({ has: () => false });
    await f.recover();
    assert.equal(f.boundary(id).state, 'unavailable');
    assert.equal(f.cursor(id), '100');
    f.channels.get(id).permissionsFor = () => ({ has: () => true });
    f.calls.length = 0;
    await f.recover();
    assert.equal(f.calls.filter(c => c.id === id).length, 0, 'permission failure must not retain the retry marker');
  });
  test(`${id} stopped recovery preserves the retry boundary until a later invocation`, async t => {
    const f = fixture(t);
    f.fail({ id, kind: 'channel', status: 503 }); await f.recover();
    await f.reopen(); f.fail(null); f.calls.length = 0;
    const controller = new AbortController(); controller.abort();
    await f.recover(controller.signal);
    assert.equal(f.boundary(id).state, 'unavailable');
    assert.equal(f.calls.length, 0);
    await f.recover();
    assert.equal(f.boundary(id).state, 'ready');
  });
}
