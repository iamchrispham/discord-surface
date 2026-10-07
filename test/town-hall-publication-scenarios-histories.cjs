'use strict';

const { discordNonce } = require('../src/state');
const { PUBLICATION_PREFIX, assertCorrupt, fixture, input, insertMessagesRow, publicationKeyFor } = require('./town-hall-publication-scenarios-fixtures.cjs');
const { dropExpressionIndexes, insertRawReceipt, restoreExpressionIndexes } = require('./town-hall-publication-scenarios-history.cjs');
const assert = require('node:assert/strict');
const test = require('node:test');

test('malformed execution histories refuse without changing journal or unrelated rows', t => {
  const f = fixture(t);
  const created = f.state.createTownHallBroadcast(input());
  const journalKey = created.broadcast.journalKey;
  const fingerprint = created.broadcast.plan.fingerprint;
  const plan = created.broadcast.plan;
  const publicationKey = publicationKeyFor(journalKey);
  const nonce = discordNonce(publicationKey);
  const kind = PUBLICATION_PREFIX + journalKey;
  const otherKey = 'e'.repeat(64);
  const owner = () => ({ ownerPid: process.pid, ownerStartTime: 'publication-owner-start', ownerCommand: '/usr/bin/node' });
  const common = (event, attemptId, ownerValue = owner()) => ({
    version: 1,
    journalKey,
    fingerprint,
    event,
    attemptId,
    nonce,
    owner: ownerValue
  });
  const reserved = (attemptId, ownerValue) => common('reserved', attemptId, ownerValue);
  const inFlight = (attemptId, ownerValue) => common('in_flight', attemptId, ownerValue);
  const outcome = (attemptId, value, messageId = null, ownerValue) => ({
    ...common('outcome', attemptId, ownerValue),
    outcome: value,
    messageId
  });
  const confirmed = (attemptId, messageId, ownerValue) => ({
    ...common('confirmed', attemptId, ownerValue),
    messageId,
    guildId: plan.townHall.guildId,
    channelId: plan.townHall.channelId
  });
  const A1 = 'attempt-0000-0000-0000-000000000001';
  const A2 = 'attempt-0000-0000-0000-000000000002';

  f.state.receipt(null, 'unrelated-receipt', { note: 'x' });
  f.state.receipt(null, PUBLICATION_PREFIX + otherKey, { version: 1, journalKey: otherKey, fingerprint: 'ignored' });
  insertMessagesRow(f.state, 'publication-metadata-foreign');

  const expressionIndexes = dropExpressionIndexes(f.state);
  try {
    const baselineRows = f.state.listReceipts();

    const scenarios = [
      {
        label: 'raw discord id',
        setup: () => {
          const detail = reserved(A1);
          insertRawReceipt(f.state, kind, detail, 'publication-metadata-foreign');
        }
      },
      { label: 'invalid json', rows: ['{not json'] },
      { label: 'extra key', rows: [{ ...reserved(A1), extra: true }] },
      { label: 'unsupported version', rows: [{ ...reserved(A1), version: 2 }] },
      { label: 'wrong journal key', rows: [{ ...reserved(A1), journalKey: otherKey }] },
      { label: 'wrong fingerprint', rows: [{ ...reserved(A1), fingerprint: '0'.repeat(64) }] },
      { label: 'wrong nonce', rows: [{ ...reserved(A1), nonce: 'ds-' + 'a'.repeat(21) }] },
      { label: 'unknown event', rows: [{ ...reserved(A1), event: 'bogus' }] },
      { label: 'malformed owner', rows: [reserved(A1, { ownerPid: process.pid, ownerStartTime: '', ownerCommand: null })] },
      { label: 'duplicate reservation', rows: [reserved(A1), reserved(A1)] },
      { label: 'outcome before in-flight', rows: [reserved(A1), outcome(A1, 'unknown')] },
      {
        label: 'two outcomes for one attempt',
        rows: [reserved(A1), inFlight(A1), outcome(A1, 'not_sent'), outcome(A1, 'unknown')]
      },
      {
        label: 'confirmation without unknown',
        rows: [reserved(A1), inFlight(A1), outcome(A1, 'sent', 'msg-1'), confirmed(A1, 'msg-1')]
      },
      { label: 'later event uses another attempt', rows: [reserved(A1), inFlight(A2)] }
    ];

    for (const scenario of scenarios) {
      f.state.db.prepare('DELETE FROM receipts WHERE kind=?').run(kind);
      if (scenario.setup) scenario.setup();
      for (const row of scenario.rows || []) insertRawReceipt(f.state, kind, row);
      const corruptRows = f.state.listReceipts();
      const corruptIds = corruptRows.map(row => row.id);
      const unrelatedRows = corruptRows.filter(row => row.kind !== kind);

      assertCorrupt(() => f.state.getTownHallPublication(journalKey), scenario.label);
      assertCorrupt(() => f.state.reserveTownHallPublication(journalKey), `${scenario.label} reserve`);

      const afterRows = f.state.listReceipts();
      assert.deepEqual(afterRows.map(row => row.id), corruptIds, `${scenario.label}: refusal mutated receipts`);
      assert.deepEqual(
        afterRows.filter(row => row.kind !== kind),
        unrelatedRows,
        `${scenario.label}: unrelated rows changed`
      );
      assert.equal(
        f.state.getTownHallBroadcast(journalKey).publication.status,
        'planned',
        `${scenario.label}: journal changed`
      );
    }

    f.state.db.prepare('DELETE FROM receipts WHERE kind=?').run(kind);
    assert.deepEqual(
      f.state.listReceipts().map(row => row.id),
      baselineRows.map(row => row.id),
      'corruption fixtures must not leave publication rows behind'
    );
    assert.equal(f.state.getTownHallPublication(journalKey).status, 'planned');
    assert.equal(f.state.getTownHallBroadcast(journalKey).publication.status, 'planned');

    f.state.db.prepare('UPDATE receipts SET discord_id=NULL WHERE kind=?').run(PUBLICATION_PREFIX + otherKey);
    const foreign = f.state.listReceipts().filter(row => row.kind === PUBLICATION_PREFIX + otherKey);
    assert.equal(foreign.length, 1);
    assert.equal(foreign[0].discord_id, null);
    assert.equal(f.state.getTownHallPublication(journalKey).status, 'planned');
  } finally {
    restoreExpressionIndexes(f.state, expressionIndexes);
  }
});
