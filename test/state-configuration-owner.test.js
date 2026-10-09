const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SurfaceState, BindingError } = require(path.join(process.cwd(), 'src/state'));
const CONFIG = Object.freeze({ operatorId: 'operator', guildId: 'guild', secretFile: '/tmp/disposable-secret' });
function withState(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-configuration-owner-'));
  let state;
  try {
    state = new SurfaceState(path.join(dir, 'surface.sqlite'));
    return run(state);
  } finally {
    try { state?.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
}
function configuredReceipts(state) {
  return state.db.prepare("SELECT count(*) AS n FROM receipts WHERE kind='configured'").get().n;
}
test('configuration preserves required values and partial updates', () => {
  withState(state => {
    assert.deepEqual(state.setConfig({ ...CONFIG, codexCategoryId: 'codex' }), { ...CONFIG, codexCategoryId: 'codex' });
    assert.deepEqual(state.setConfig({ claudeCategoryId: 'claude' }), { ...CONFIG, codexCategoryId: 'codex', claudeCategoryId: 'claude' });
    assert.deepEqual(state.requireConfig(), { ...CONFIG, codexCategoryId: 'codex', claudeCategoryId: 'claude' });
    assert.equal(configuredReceipts(state), 2);
  });
});
test('configuration validates before any transaction write', () => {
  withState(state => {
    let transactions = 0;
    const original = state.transaction;
    state.transaction = function () { transactions++; return original.apply(this, arguments); };
    assert.throws(() => state.setConfig({ operatorId: 'operator' }), BindingError);
    assert.throws(() => state.setConfig({ ...CONFIG, guildId: '' }), TypeError);
    assert.equal(transactions, 0);
    assert.deepEqual(state.getConfig(), {});
    assert.equal(configuredReceipts(state), 0);
    assert.throws(() => state.requireConfig(), BindingError);
  });
});
test('configuration rolls back persisted values when receipt fails', () => {
  withState(state => {
    state.setConfig(CONFIG);
    const failure = new Error('receipt failure');
    state.receipt = () => { throw failure; };
    assert.throws(() => state.setConfig({ guildId: 'changed' }), error => error === failure);
    assert.deepEqual(state.getConfig(), CONFIG);
    assert.equal(configuredReceipts(state), 1);
  });
});
test('configuration reads unknown persisted keys without writing them', () => {
  withState(state => {
    state.setConfig(CONFIG);
    state.db.prepare('INSERT INTO config(key,value) VALUES(?,?)').run('futureKey', 'preserved');
    assert.equal(state.getConfig().futureKey, 'preserved');
    assert.equal(state.setConfig({ futureKey: 'overwritten', ignoredKey: 'input' }).futureKey, 'preserved');
    assert.equal(state.getConfig().futureKey, 'preserved');
    assert.equal(state.getConfig().ignoredKey, undefined);
  });
});
test('configuration facade preserves borrowed receiver and errors', () => {
  const rows = [{ key: 'operatorId', value: 'operator' }];
  const receiver = { db: { prepare(sql) { assert.equal(sql, 'SELECT key, value FROM config'); return { all: () => rows }; } } };
  assert.deepEqual(SurfaceState.prototype.getConfig.call(receiver), { operatorId: 'operator' });
  const failure = new Error('read failure');
  assert.throws(() => SurfaceState.prototype.getConfig.call({ db: { prepare() { throw failure; } } }), error => error === failure);
  const writes = [];
  const borrowed = {
    getConfig() { assert.equal(this, borrowed); return CONFIG; },
    db: { prepare() { return { run: (...args) => writes.push(args) }; } },
    transaction(run) { assert.equal(this, borrowed); return run(); },
    receipt(messageId, kind, detail) { assert.equal(this, borrowed); assert.equal(messageId, null); assert.equal(kind, 'configured'); assert.deepEqual(detail, { guildId: 'updated', operatorId: 'operator' }); }
  };
  assert.deepEqual(SurfaceState.prototype.setConfig.call(borrowed, { guildId: 'updated' }), { ...CONFIG, guildId: 'updated' });
  assert.deepEqual(writes, [['operatorId', 'operator'], ['guildId', 'updated'], ['secretFile', '/tmp/disposable-secret']]);
});
test('configuration factory preserves strict receivers', () => {
  const { createConfigurationHandlers } = require(path.join(process.cwd(), 'src/state/configuration'));
  const handlers = createConfigurationHandlers({ assertText() {}, BindingError });
  assert.throws(() => handlers.getConfig.call(null), TypeError);
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'getConfig');
  try {
    Object.defineProperty(globalThis, 'getConfig', { configurable: true, value: () => ({ ...CONFIG }) });
    assert.throws(() => handlers.requireConfig.call(undefined), TypeError);
  } finally {
    if (prior) Object.defineProperty(globalThis, 'getConfig', prior);
    else delete globalThis.getConfig;
  }
  assert.throws(() => handlers.setConfig.call(null, CONFIG), TypeError);
  const receiver = { getConfig: () => ({}) };
  assert.throws(() => handlers.requireConfig.call(receiver), BindingError);
});
