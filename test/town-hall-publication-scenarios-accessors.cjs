'use strict';

const { confirmCaseFailures, makeEvidence, recordCaseFailures, seedInFlight } = require('./town-hall-publication-scenarios-accessor-custody.cjs');
const { fixture, parsedPublicationRows } = require('./town-hall-publication-scenarios-fixtures.cjs');
const assert = require('node:assert/strict');
const test = require('node:test');

test('outcome detail rejects accessor fields before reads', t => {
  const f = fixture(t);
  const control = seedInFlight(f.state, 'rec-control');
  const sent = f.state.recordTownHallPublicationOutcome(control.journalKey, control.attemptId, 'sent', { messageId: '123' });
  assert.equal(sent.status, 'sent');
  assert.equal(sent.messageId, '123');
  assert.deepEqual(f.state.getTownHallPublication(control.journalKey), sent);
  const outcomeRows = parsedPublicationRows(f.state, control.journalKey)
    .filter(row => row.detail.event === 'outcome');
  assert.equal(outcomeRows.length, 1);
  assert.equal(outcomeRows[0].detail.messageId, '123');

  const failures = [];
  for (const field of ['messageId']) {
    for (const variant of ['throwing', 'changing', 'inherited']) {
      failures.push(...recordCaseFailures(f.state, field, variant));
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
});

test('confirmation evidence rejects accessor fields before reads', t => {
  const f = fixture(t);
  const control = seedInFlight(f.state, 'conf-control');
  f.state.recordTownHallPublicationOutcome(control.journalKey, control.attemptId, 'unknown');
  const controlEvidence = makeEvidence(control.nonce);
  const confirmed = f.state.confirmTownHallPublication(control.journalKey, control.attemptId, controlEvidence);
  assert.equal(confirmed.status, 'sent');
  assert.equal(confirmed.messageId, '123');
  assert.deepEqual(f.state.getTownHallPublication(control.journalKey), confirmed);
  const confirmedRows = parsedPublicationRows(f.state, control.journalKey)
    .filter(row => row.detail.event === 'confirmed');
  assert.equal(confirmedRows.length, 1);
  assert.equal(confirmedRows[0].detail.messageId, '123');

  const failures = [];
  for (const field of Object.keys(controlEvidence)) {
    for (const variant of ['throwing', 'changing', 'inherited']) {
      failures.push(...confirmCaseFailures(f.state, field, variant));
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
});
