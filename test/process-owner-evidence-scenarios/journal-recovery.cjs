'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { fixture: boardFixture, seedBoardAttempt, BOARD_OUTCOMES } = require('../board-refresh-fixture');
const { headlessFixture, receiptIds, receiptsOfKind, FAKE_PID } = require('./fixtures.cjs');

// ---------------------------------------------------------------------------
// Test 3: direct-post generic recovery
// ---------------------------------------------------------------------------

test('direct-post recovery settles only typed absence and holds legacy booleans', () => {
  const cases = [
    { label: 'legacy-false', callback: () => false, recovered: 0 },
    { label: 'legacy-true', callback: () => true, recovered: 0 },
    { label: 'typed-absent', callback: () => ({ status: 'absent', reason: 'probe-absent' }), recovered: 1 },
    { label: 'legacy-indeterminate-object', callback: () => ({ status: 'indeterminate', reason: 'probe-error' }), recovered: 0 }
  ];
  for (const scenario of cases) {
    const f = headlessFixture();
    try {
      const attemptId = `orphan-${scenario.label}`;
      f.state.receipt(null, 'direct-post-attempt', {
        journal: 'direct-post-v1',
        requestId: `request-${attemptId}`,
        attemptId,
        ownerPid: FAKE_PID,
        ownerStartTime: 'fixture-start',
        ownerCommand: 'fixture-command',
        status: 'attempted'
      });
      const before = receiptIds(f.state);
      const recovered = f.state.recoverDirectPostReceipts(scenario.callback);
      assert.equal(recovered, scenario.recovered, scenario.label);
      const outcomes = receiptsOfKind(f.state, 'direct-post-outcome')
        .filter(row => JSON.parse(row.detail).attemptId === attemptId);
      if (scenario.recovered === 0) {
        assert.deepEqual(receiptIds(f.state), before, `${scenario.label} must not write a settlement`);
        assert.equal(outcomes.length, 0, `${scenario.label} must not settle`);
      } else {
        assert.equal(outcomes.length, 1, `${scenario.label} must settle exactly once`);
        assert.equal(JSON.parse(outcomes[0].detail).outcome, 'unknown');
        assert.equal(receiptIds(f.state).length, before.length + 1);
      }
    } finally {
      f.state.close();
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// Test 4: board generic recovery
// ---------------------------------------------------------------------------

test('board recovery settles only typed absence and holds legacy booleans', () => {
  const cases = [
    { label: 'legacy-false', callback: () => false, recovered: 0 },
    { label: 'legacy-true', callback: () => true, recovered: 0 },
    { label: 'typed-absent', callback: () => ({ status: 'absent', reason: 'probe-absent' }), recovered: 1 }
  ];
  for (const scenario of cases) {
    const f = boardFixture();
    try {
      const seeded = seedBoardAttempt(f, `owner-evidence-${scenario.label}`);
      const row = f.state.db.prepare(
        "SELECT id, detail FROM receipts WHERE kind='board-refresh-attempt' AND json_extract(detail, '$.attemptId')=?"
      ).get(seeded.attemptId);
      assert.ok(row, 'seeded board attempt must exist');
      f.state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(
        JSON.stringify({ ...JSON.parse(row.detail), ownerPid: FAKE_PID, ownerIdentity: { ownerStartTime: 'fixture-start', ownerCommand: 'fixture-command' } }),
        row.id
      );
      const before = receiptIds(f.state);
      const recovered = f.state.recoverBoardRefreshAttempt(seeded.target, seeded.attemptId, scenario.callback);
      assert.equal(recovered, scenario.recovered, scenario.label);
      const outcomes = receiptsOfKind(f.state, 'board-refresh-outcome')
        .filter(row => JSON.parse(row.detail).attemptId === seeded.attemptId);
      if (scenario.recovered === 0) {
        assert.deepEqual(receiptIds(f.state), before, `${scenario.label} must not settle`);
        assert.equal(outcomes.length, 0);
        assert.equal(f.state.inspectBoardRequest(`owner-evidence-${scenario.label}`, seeded.target).status, BOARD_OUTCOMES.IN_FLIGHT);
      } else {
        assert.equal(outcomes.length, 1);
        assert.equal(JSON.parse(outcomes[0].detail).outcome, BOARD_OUTCOMES.UNKNOWN);
        assert.equal(receiptIds(f.state).length, before.length + 1);
      }
    } finally {
      f.state.close();
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// Test 5: interaction generic recovery
// ---------------------------------------------------------------------------

test('interaction callback recovery settles only typed absence and holds legacy booleans', () => {
  const cases = [
    { label: 'legacy-false', callback: () => false, recovered: 0 },
    { label: 'legacy-true', callback: () => true, recovered: 0 },
    { label: 'typed-absent', callback: () => ({ status: 'absent', reason: 'probe-absent' }), recovered: 1 }
  ];
  for (const scenario of cases) {
    const f = headlessFixture();
    const messageId = `97020${cases.indexOf(scenario)}`;
    try {
      f.state.acceptDiscordMessage({ id: messageId, guildId: 'guild', channelId: 'channel', authorId: 'operator', isBot: false, content: 'question' });
      f.state.receipt(messageId, 'transport-receipt-attempt', {
        transport: 'interaction-callback',
        nonce: `nonce-${scenario.label}`,
        ownerPid: FAKE_PID,
        ownerIdentity: { ownerStartTime: 'fixture-start', ownerCommand: 'fixture-command' },
        status: 'attempted'
      });
      const before = receiptIds(f.state);
      const recovered = f.state.recoverInteractionCallbacksInTransaction(scenario.callback);
      assert.equal(recovered, scenario.recovered, scenario.label);
      const outcomes = f.state.listReceipts().filter(row =>
        row.discord_id === messageId && row.kind === 'transport-receipt-outcome');
      if (scenario.recovered === 0) {
        assert.deepEqual(receiptIds(f.state), before, `${scenario.label} must not settle`);
        assert.equal(outcomes.length, 0);
      } else {
        assert.equal(outcomes.length, 1);
        assert.equal(JSON.parse(outcomes[0].detail).outcome, 'unknown');
        assert.equal(JSON.parse(outcomes[0].detail).terminal, true);
        assert.equal(receiptIds(f.state).length, before.length + 1);
      }
    } finally {
      f.state.close();
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  }
});
