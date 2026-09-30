'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SurfaceState, READINESS } = require('../src/state');
const { createBindingWakeController } = require('../src/cli');

const NATIVE_ID = '79e3da8e-94b4-4aff-8f88-b45b3a451dd1';
const OTHER_NATIVE_ID = '44444444-4444-4444-8444-444444444444';
const FIRST_INSTANCE = '11111111-1111-4111-8111-111111111111';
const SECOND_INSTANCE = '22222222-2222-4222-8222-222222222222';
const THIRD_INSTANCE = '33333333-3333-4333-8333-333333333333';

test('a newly verified Claude listener re-offers an unacknowledged submitted row once', async t => {
  const dir = fs.mkdtempSync('/tmp/claude-reoffer-');
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  state.setConfig({ operatorId: '900', guildId: '100', secretFile: path.join(dir, 'secret') });
  const endpoint = path.join(dir, 'listener.sock');
  state.bind({
    channelId: '101', guildId: '100', provider: 'claude', nativeId: NATIVE_ID,
    workspace: dir, endpoint
  }, { intakeCutoff: '100' });
  const bound = state.getBinding('101');
  const accepted = state.acceptDiscordMessage({
    id: '102', guildId: '100', channelId: '101', authorId: '900', isBot: false,
    attachments: [], content: 'Please handle this request.'
  });
  assert.equal(accepted.accepted, true);
  assert.equal(state.claimDispatch('102').claimed, true);
  assert.equal(state.markSubmitted('102').state, 'submitted');
  state.setBindingReadiness('101', READINESS.PENDING, 'listener pending', bound);
  const route = state.currentMessageBinding(state.getMessage('102'));
  assert.equal(route.current, true);
  assert.equal(route.ready, false);

  const posts = [];
  let instance = FIRST_INSTANCE;
  const gateway = {
    state,
    providers: { claude: { async dispatch(message) {
      posts.push(message.id);
      return { status: 'submitted' };
    } } },
    pauseLiveDispatch() {},
    async recoverTransport() { return { ready: true, state: 'ready' }; },
    async reconcilePending() {}
  };
  const wake = createBindingWakeController({
    getGateway: () => gateway,
    isReady: () => true,
    isTransportReady: () => true,
    isStopping: () => false,
    probeClaudeChannel: async (socketPath, expected) => {
      assert.equal(socketPath, endpoint);
      assert.equal(expected.nativeId, NATIVE_ID);
      assert.equal(expected.generation, bound.generation);
      return { listenerInstanceId: instance, ...expected };
    }
  });
  const trigger = async () => { wake.request(); await wake.wait(); };

  await trigger();
  assert.deepEqual(posts, [], 'a not-ready route defers the listener instance');

  state.setBindingReadiness('101', READINESS.READY, 'listener ready', state.getBinding('101'));
  await trigger();
  assert.deepEqual(posts, ['102']);
  assert.equal(state.getMessage('102').state, 'submitted');

  await trigger();
  assert.deepEqual(posts, ['102'], 'a repeated wake of one listener is inert');

  instance = SECOND_INSTANCE;
  await trigger();
  assert.deepEqual(posts, ['102', '102'], 'a replacement listener gets one re-offer');
  assert.equal(state.getMessage('102').state, 'submitted');

  const { recordNativeAcknowledgment } = require('../src/acknowledgment');
  assert.equal(recordNativeAcknowledgment(state, {
    provider: 'claude', messageId: '102', nativeId: NATIVE_ID, generation: bound.generation
  }).recorded, true);
  const latePickupDuplicate = recordNativeAcknowledgment(state, {
    provider: 'claude', messageId: '102', nativeId: NATIVE_ID, generation: bound.generation
  });
  assert.equal(latePickupDuplicate.recorded, false);
  assert.equal(latePickupDuplicate.duplicate, true);
  assert.equal(state.getMessage('102').state, 'submitted');
  instance = THIRD_INSTANCE;
  await trigger();
  assert.deepEqual(posts, ['102', '102'], 'a native ACK excludes later re-offers');
});

test('a re-offer skips submitted rows whose owner or generation is no longer current', async t => {
  const dir = fs.mkdtempSync('/tmp/claude-reoffer-wrong-owner-');
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  state.setConfig({ operatorId: '900', guildId: '100', secretFile: path.join(dir, 'secret') });
  const endpoint = path.join(dir, 'listener.sock');
  const bound = state.bind({
    channelId: '101', guildId: '100', provider: 'claude', nativeId: NATIVE_ID,
    workspace: dir, endpoint
  }, { intakeCutoff: '100' });
  state.setBindingReadiness('101', READINESS.READY, 'listener ready', bound);
  const submit = id => {
    state.acceptDiscordMessage({
      id, guildId: '100', channelId: '101', authorId: '900', isBot: false,
      attachments: [], content: 'Please handle this request.'
    });
    state.claimDispatch(id);
    state.markSubmitted(id);
  };
  submit('103');
  state.transition('103', 'submitted', 'replied', 'fixture-drain');
  state.unbind('101', { expectedBinding: bound });
  const rebound = state.rebind({
    channelId: '101', guildId: '100', provider: 'claude', nativeId: OTHER_NATIVE_ID,
    workspace: dir, endpoint
  }, { intakeCutoff: '100' });
  state.setBindingReadiness('101', READINESS.READY, 'listener ready', state.getBinding('101'));
  state.transition('103', 'replied', 'submitted', 'fixture-stale');
  submit('102');
  assert.equal(state.currentMessageBinding(state.getMessage('103')).current, false);
  assert.equal(state.currentMessageBinding(state.getMessage('102')).current, true);

  const posts = [];
  const gateway = {
    state,
    providers: { claude: { async dispatch(message) {
      posts.push(message.id);
      return { status: 'submitted' };
    } } },
    pauseLiveDispatch() {},
    async recoverTransport() { return { ready: true, state: 'ready' }; },
    async reconcilePending() {}
  };
  const wake = createBindingWakeController({
    getGateway: () => gateway,
    isReady: () => true,
    isTransportReady: () => true,
    isStopping: () => false,
    probeClaudeChannel: async (socketPath, expected) => {
      assert.equal(socketPath, endpoint);
      assert.equal(expected.nativeId, OTHER_NATIVE_ID);
      assert.equal(expected.generation, rebound.generation);
      return { listenerInstanceId: FIRST_INSTANCE, ...expected };
    }
  });
  const trigger = async () => { wake.request(); await wake.wait(); };

  await trigger();
  assert.deepEqual(posts, ['102']);
  assert.equal(state.getMessage('103').state, 'submitted');
});

test('a re-offer requires a verified listener identity', async t => {
  const dir = fs.mkdtempSync('/tmp/claude-reoffer-probe-');
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  state.setConfig({ operatorId: '900', guildId: '100', secretFile: path.join(dir, 'secret') });
  const endpoint = path.join(dir, 'listener.sock');
  const bound = state.bind({
    channelId: '101', guildId: '100', provider: 'claude', nativeId: NATIVE_ID,
    workspace: dir, endpoint
  }, { intakeCutoff: '100' });
  state.setBindingReadiness('101', READINESS.READY, 'listener ready', bound);
  state.acceptDiscordMessage({
    id: '102', guildId: '100', channelId: '101', authorId: '900', isBot: false,
    attachments: [], content: 'Please handle this request.'
  });
  state.claimDispatch('102');
  state.markSubmitted('102');

  const posts = [];
  let probe = async (socketPath, expected) => ({ ...expected });
  const gateway = {
    state,
    providers: { claude: { async dispatch(message) {
      posts.push(message.id);
      return { status: 'submitted' };
    } } },
    pauseLiveDispatch() {},
    async recoverTransport() { return { ready: true, state: 'ready' }; },
    async reconcilePending() {}
  };
  const wake = createBindingWakeController({
    getGateway: () => gateway,
    isReady: () => true,
    isTransportReady: () => true,
    isStopping: () => false,
    probeClaudeChannel: (socketPath, expected) => probe(socketPath, expected)
  });
  const trigger = async () => { wake.request(); await wake.wait(); };

  await trigger();
  assert.deepEqual(posts, []);

  probe = async () => { throw new Error('identity probe failed'); };
  await trigger();
  assert.deepEqual(posts, []);

  probe = async (socketPath, expected) => {
    assert.equal(socketPath, endpoint);
    assert.equal(expected.nativeId, NATIVE_ID);
    assert.equal(expected.generation, bound.generation);
    return { listenerInstanceId: FIRST_INSTANCE, ...expected };
  };
  await trigger();
  assert.deepEqual(posts, ['102']);
});

test('an uncertain dispatch is not repeated by the same listener but may be retried by a replacement', async t => {
  const dir = fs.mkdtempSync('/tmp/claude-reoffer-uncertain-');
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  state.setConfig({ operatorId: '900', guildId: '100', secretFile: path.join(dir, 'secret') });
  const endpoint = path.join(dir, 'listener.sock');
  const bound = state.bind({
    channelId: '101', guildId: '100', provider: 'claude', nativeId: NATIVE_ID,
    workspace: dir, endpoint
  }, { intakeCutoff: '100' });
  state.setBindingReadiness('101', READINESS.READY, 'listener ready', bound);
  state.acceptDiscordMessage({
    id: '102', guildId: '100', channelId: '101', authorId: '900', isBot: false,
    attachments: [], content: 'Please handle this request.'
  });
  state.claimDispatch('102');
  state.markSubmitted('102');

  const posts = [];
  let instance = FIRST_INSTANCE;
  const gateway = {
    state,
    providers: { claude: { async dispatch(message) {
      posts.push(message.id);
      return { status: 'uncertain' };
    } } },
    pauseLiveDispatch() {},
    async recoverTransport() { return { ready: true, state: 'ready' }; },
    async reconcilePending() {}
  };
  const wake = createBindingWakeController({
    getGateway: () => gateway,
    isReady: () => true,
    isTransportReady: () => true,
    isStopping: () => false,
    probeClaudeChannel: async (socketPath, expected) => {
      assert.equal(socketPath, endpoint);
      assert.equal(expected.nativeId, NATIVE_ID);
      assert.equal(expected.generation, bound.generation);
      return { listenerInstanceId: instance, ...expected };
    }
  });
  const trigger = async () => { wake.request(); await wake.wait(); };

  await trigger();
  assert.deepEqual(posts, ['102']);
  assert.equal(state.getMessage('102').state, 'submitted');

  await trigger();
  assert.deepEqual(posts, ['102'], 'an uncertain dispatch is not repeated by the same listener');

  instance = SECOND_INSTANCE;
  await trigger();
  assert.deepEqual(posts, ['102', '102'], 'a replacement listener may retry an uncertain dispatch');
});

test('a stop during a multi-row re-offer pass posts no further rows', async t => {
  const dir = fs.mkdtempSync('/tmp/claude-reoffer-stop-');
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  state.setConfig({ operatorId: '900', guildId: '100', secretFile: path.join(dir, 'secret') });
  const endpoint = path.join(dir, 'listener.sock');
  const bound = state.bind({
    channelId: '101', guildId: '100', provider: 'claude', nativeId: NATIVE_ID,
    workspace: dir, endpoint
  }, { intakeCutoff: '100' });
  state.setBindingReadiness('101', READINESS.READY, 'listener ready', bound);
  for (const id of ['102', '103']) {
    state.acceptDiscordMessage({
      id, guildId: '100', channelId: '101', authorId: '900', isBot: false,
      attachments: [], content: 'Please handle this request.'
    });
    state.claimDispatch(id);
    state.markSubmitted(id);
  }

  const posts = [];
  let stopping = false;
  const gateway = {
    state,
    providers: { claude: { async dispatch(message) {
      posts.push(message.id);
      stopping = true;
      return { status: 'submitted' };
    } } },
    pauseLiveDispatch() {},
    async recoverTransport() { return { ready: true, state: 'ready' }; },
    async reconcilePending() {}
  };
  const wake = createBindingWakeController({
    getGateway: () => gateway,
    isReady: () => true,
    isTransportReady: () => true,
    isStopping: () => stopping,
    probeClaudeChannel: async (socketPath, expected) => {
      assert.equal(socketPath, endpoint);
      assert.equal(expected.nativeId, NATIVE_ID);
      assert.equal(expected.generation, bound.generation);
      return { listenerInstanceId: FIRST_INSTANCE, ...expected };
    }
  });
  const trigger = async () => { wake.request(); await wake.wait(); };

  await trigger();
  assert.deepEqual(posts, ['102']);
  assert.equal(state.getMessage('102').state, 'submitted');
  assert.equal(state.getMessage('103').state, 'submitted');
});
