const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/intake-recovery-fixture');

async function settleRecovery(operation) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('recovery caller did not settle')), 2000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const entrypoint of ['result', 'startup', 'reconnect']) {
  for (const scenario of ['ready', 'latest-baseline', 'empty-baseline']) {
    test(`${entrypoint} includes recovery after ${scenario} CAS loss`, { timeout: 6000 }, async t => {
      const f = fixture(t);
      const baseline = scenario !== 'ready';
      if (baseline) {
        f.state.db.prepare('DELETE FROM intake_watermarks WHERE channel_id=?').run('1000');
        f.state.markIntakeBoundary('1000', 'pending', 'first baseline');
      }
      let injected = false;
      const accept = id => {
        const binding = f.state.getBinding('1000');
        const message = { ...f.message(id, '1000'), authorId: 'operator', isBot: false, attachments: [] };
        assert.equal(f.state.acceptDiscordMessage(message, { expectedBinding: binding, ready: false }).accepted, true);
      };
      const inject = () => {
        injected = true;
        accept('101');
        f.history.set('1000', [f.message('101', '1000')]);
      };
      if (baseline) {
        const original = f.state.setIntakeBaseline.bind(f.state);
        f.state.setIntakeBaseline = (...args) => {
          if (!injected && args[0] === '1000') inject();
          return original(...args);
        };
        if (scenario === 'empty-baseline') accept('100');
        else f.history.set('1000', [f.message('100', '1000')]);
      } else {
        const original = f.state.markIntakeBoundary.bind(f.state);
        f.state.markIntakeBoundary = (...args) => {
          if (!injected && args[0] === '1000' && args[1] === 'ready') inject();
          return original(...args);
        };
      }
      if (entrypoint === 'startup') {
        await settleRecovery(f.gateway.start(f.secret));
        assert.equal(f.gateway.started, true);
      } else {
        if (entrypoint === 'reconnect') f.enableDelivery();
        const operation = entrypoint === 'reconnect'
          ? f.gateway.beginReconnectRecovery('probe')
          : f.gateway.recoverTransport('startup');
        const result = await settleRecovery(operation);
        assert.equal(result.ready, true, 'caller must receive completed recovery');
      }
      assert.ok(injected);
      assert.equal(f.boundary('1000').state, 'ready');
      assert.equal(f.state.getBinding('1000').readiness, 'ready');
      if (entrypoint === 'reconnect') {
        await f.gateway.consumer.waitForNativeWork();
        assert.equal(f.state.getMessage('101').state, 'replied');
        assert.equal(f.dispatched.filter(message => message.id === '101').length, 1);
      } else {
        assert.equal(f.state.getMessage('101').state, 'accepted');
        assert.equal(f.dispatched.length, 0);
      }
    });
  }
}
