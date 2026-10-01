const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('../helpers/intake-recovery-fixture');
const { recoverThread } = require('../../src/discord/thread-enrollment');
const { waitForRecoveryOperation } = require('../../src/discord');
const { settleRecovery } = require('./settle-recovery');

for (const pageLimit of [10, 2]) {
  test(`completed-empty parent retains descending history with page limit ${pageLimit}`, { timeout: 4000 }, async t => {
    const f = fixture(t);
    const binding = f.state.getBinding('1000');
    const nativeId = binding.nativeId;
    const generation = binding.generation;
    f.state.db.prepare(`UPDATE intake_watermarks
      SET state='ready', last_seen_id=NULL, recovered_through_id=NULL, last_accepted_id=NULL, detail=?
      WHERE channel_id=?`).run('restart empty channel baseline', '1000');
    f.gateway.historyPageLimit = pageLimit;
    const messages = ['104', '103', '102', '101'].map(id => f.message(id, '1000'));
    const parentCalls = [];
    const originalFetchHistory = f.gateway.fetchHistory.bind(f.gateway);
    f.gateway.fetchHistory = async (channel, options) => {
      if (channel.id !== '1000') return originalFetchHistory(channel, options);
      parentCalls.push(options);
      const after = options.after ? BigInt(options.after) : null;
      const before = options.before ? BigInt(options.before) : null;
      const filtered = messages.filter(message => {
        const value = BigInt(message.id);
        if (after !== null && value <= after) return false;
        if (before !== null && value >= before) return false;
        return true;
      });
      if (after !== null) return filtered.reverse().slice(0, options.limit).reverse();
      return filtered.slice(0, options.limit);
    };

    let result;
    for (let attempt = 0; attempt < 6; attempt++) {
      result = await settleRecovery(f.recover());
      if (result.ready) break;
    }

    assert.equal(parentCalls.length > 0, true);
    assert.equal(result.ready, true);
    assert.equal(f.boundary('1000').state, 'ready');
    assert.equal(f.cursor('1000'), '104');
    for (const id of ['101', '102', '103', '104']) {
      const stored = f.state.getMessage(id);
      assert.equal(stored.state, 'accepted');
      assert.equal(stored.nativeId, nativeId);
      assert.equal(stored.generation, generation);
    }
    assert.equal(f.state.getBinding('1000').nativeId, nativeId);
    assert.equal(f.state.getBinding('1000').generation, generation);
    assert.equal(f.dispatched.length, 0);
  });
}
for (const pageLimit of [10, 2]) {
  test(`historical completed-empty child retains new history with page limit ${pageLimit}`, { timeout: 4000 }, async t => {
    const f = fixture(t);
    f.state.db.prepare(`UPDATE thread_enrollments
      SET adopted_through_id=NULL, last_seen_id=NULL, recovered_through_id=NULL, last_accepted_id=NULL, gap_from=NULL, gap_to=NULL, detail='Thread history recovered'
      WHERE thread_id=?`).run('2000');
    const preRecovery = f.state.getThreadEnrollment('2000');
    assert.equal(preRecovery.active, true);
    assert.equal(preRecovery.state, 'ready');
    assert.ok(preRecovery.adoptedAt);
    assert.equal(preRecovery.adoptedThroughId, null);
    assert.equal(preRecovery.recoveredThroughId, null);
    assert.equal(preRecovery.lastSeenId, null);
    assert.equal(preRecovery.lastAcceptedId, null);
    const parentBinding = f.state.getBinding('1000');
    const nativeId = parentBinding.nativeId;
    const generation = parentBinding.generation;
    const threadAdoptedAt = preRecovery.adoptedAt;
    const threadAdoptedThroughId = preRecovery.adoptedThroughId;
    f.gateway.historyPageLimit = pageLimit;
    const messages = ['104', '103', '102', '101'].map(id => f.message(id, '2000'));
    const childCalls = [];
    const originalFetchHistory = f.gateway.fetchHistory.bind(f.gateway);
    f.gateway.fetchHistory = async (channel, options) => {
      if (channel.id !== '2000') return originalFetchHistory(channel, options);
      childCalls.push(options);
      const after = options.after ? BigInt(options.after) : null;
      const before = options.before ? BigInt(options.before) : null;
      const filtered = messages.filter(message => {
        const value = BigInt(message.id);
        if (after !== null && value <= after) return false;
        if (before !== null && value >= before) return false;
        return true;
      });
      if (after !== null) return filtered.reverse().slice(0, options.limit).reverse();
      return filtered.slice(0, options.limit);
    };

    let result;
    for (let attempt = 0; attempt < 6; attempt++) {
      result = await settleRecovery(f.recover());
      if (result.ready) break;
    }

    assert.equal(result.ready, true);
    const recovered = f.state.getThreadEnrollment('2000');
    assert.equal(recovered.state, 'ready');
    assert.equal(recovered.recoveredThroughId, '104');
    assert.equal(childCalls.length > 0, true);
    assert.equal(f.state.getBinding('1000').nativeId, nativeId);
    assert.equal(f.state.getBinding('1000').generation, generation);
    assert.equal(f.state.getThreadEnrollment('2000').adoptedAt, threadAdoptedAt);
    assert.equal(f.state.getThreadEnrollment('2000').adoptedThroughId, threadAdoptedThroughId);
    assert.equal(f.dispatched.length, 0);
    for (const id of ['101', '102', '103', '104']) {
      const stored = f.state.getMessage(id);
      assert.ok(stored, `message ${id} missing`);
      assert.equal(stored.state, 'accepted');
      assert.equal(stored.nativeId, nativeId);
      assert.equal(stored.generation, generation);
    }
  });
}
