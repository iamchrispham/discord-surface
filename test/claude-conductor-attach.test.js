const assert = require('node:assert/strict');
const test = require('node:test');
const { attachOrdinaryListener } = require('../src/cli');

const identity = Object.freeze({
  channelId: 'channel', guildId: 'guild', provider: 'claude',
  nativeId: 'owner', generation: 3, workspace: '/workspace', endpoint: '/listener.sock'
});

function fixture(changes = {}) {
  let wakes = 0;
  const binding = { ...identity, active: true, conductorId: 'conductor', ...changes };
  const state = {
    getBinding: channel => channel === identity.channelId ? binding : null,
    isOrdinaryBinding: () => false,
    getIntakeWatermark() { throw new Error('conductor attach must not read ordinary readiness'); },
    setBindingReadiness() { throw new Error('conductor attach must not mutate readiness'); }
  };
  return {
    args: { state, paths: {}, startupBinding: null, identity, label: 'Claude Monitor',
      requestRecovery: () => { wakes += 1; return { requested: true }; },
      stderr: { write() {} } },
    wakes: () => wakes
  };
}

test('conductor attach wakes once without ordinary readiness changes', () => {
  for (const label of ['Claude channel', 'Claude Monitor']) {
    const f = fixture();
    assert.deepEqual(attachOrdinaryListener({ ...f.args, label }), { requested: true });
    assert.equal(f.wakes(), 1);
  }
});

test('conductor attach refuses changed identity before waking', () => {
  for (const change of [
    { active: false }, { nativeId: 'successor' }, { generation: 4 },
    { provider: 'codex' }, { endpoint: '/other.sock' }, { workspace: '/other' }, { guildId: 'other' }
  ]) {
    const f = fixture(change);
    assert.throws(() => attachOrdinaryListener(f.args), /binding changed during startup/);
    assert.equal(f.wakes(), 0);
  }
});

test('missing Gateway is reported without promoting conductor readiness', () => {
  const f = fixture();
  const output = [];
  const result = attachOrdinaryListener({ ...f.args,
    requestRecovery: () => ({ requested: false, reason: 'gateway-not-running' }),
    stderr: { write: text => output.push(text) }
  });
  assert.equal(result.requested, false);
  assert.match(output.join(''), /gateway-not-running/);
});

test('unsupported wake refuses attach without revoking conductor readiness', () => {
  const f = fixture();
  assert.throws(() => attachOrdinaryListener({ ...f.args,
    requestRecovery: () => ({ requested: false, reason: 'gateway-wake-unsupported' })
  }), /gateway-wake-unsupported/);
});
