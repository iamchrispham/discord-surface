'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SurfaceState, READINESS } = require('../src/state');
const { createBindingWakeController } = require('../src/cli');

const NATIVE_ID = '79e3da8e-94b4-4aff-8f88-b45b3a451dd1';
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
  state.setBindingReadiness('101', READINESS.READY, 'listener ready', bound);
  const accepted = state.acceptDiscordMessage({
    id: '102', guildId: '100', channelId: '101', authorId: '900', isBot: false,
    attachments: [], content: 'Please handle this request.'
  });
  assert.equal(accepted.accepted, true);
  assert.equal(state.claimDispatch('102').claimed, true);
  assert.equal(state.markSubmitted('102').state, 'submitted');
  const route = state.currentMessageBinding(state.getMessage('102'));
  assert.equal(route.current, true);
  assert.equal(route.ready, true);

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
  instance = THIRD_INSTANCE;
  await trigger();
  assert.deepEqual(posts, ['102', '102'], 'a native ACK excludes later re-offers');
});
