'use strict';

const { BindingError } = require('../src/state');
const { CONFIRM_REFUSED, RECORD_REFUSED, input, receiptIds } = require('./town-hall-publication-scenarios-fixtures.cjs');
const assert = require('node:assert/strict');

class GetterFixtureError extends Error {}

function defineVariant(object, field, variant, counters) {
  const original = object[field];
  if (variant === 'throwing') {
    Object.defineProperty(object, field, {
      enumerable: true,
      configurable: true,
      get() {
        counters.reads += 1;
        throw new GetterFixtureError('getter read');
      }
    });
    return object;
  }
  if (variant === 'changing') {
    let reads = 0;
    Object.defineProperty(object, field, {
      enumerable: true,
      configurable: true,
      get() {
        counters.reads += 1;
        reads += 1;
        if (reads === 1) return original;
        return {
          [Symbol.toPrimitive]() {
            counters.coercions += 1;
            return '999';
          }
        };
      }
    });
    return object;
  }
  delete object[field];
  const prototype = {};
  Object.defineProperty(prototype, field, {
    enumerable: true,
    get() {
      counters.reads += 1;
      return original;
    }
  });
  Object.setPrototypeOf(object, prototype);
  return object;
}

function seedInFlight(state, broadcastId) {
  const created = state.createTownHallBroadcast(input({ broadcastId }));
  const journalKey = created.broadcast.journalKey;
  const reserved = state.reserveTownHallPublication(journalKey);
  const attemptId = reserved.publication.attemptId;
  state.markTownHallPublicationInFlight(journalKey, attemptId);
  return { journalKey, attemptId, nonce: reserved.publication.nonce };
}

function makeEvidence(nonce) {
  return { messageId: '123', nonce, guildId: '100', channelId: '900' };
}

function observeCall(run) {
  try {
    return run();
  } catch (error) {
    return error;
  }
}

function describeMismatch(outcome, expectedMessage) {
  if (outcome instanceof BindingError && outcome.message === expectedMessage) return null;
  if (outcome instanceof Error) return `got ${outcome.constructor.name}: ${outcome.message}`;
  return 'got a resolved projection';
}

function collect(failures, label, check) {
  try {
    check();
  } catch (error) {
    failures.push(`${label}: ${error?.message ?? error}`);
  }
}

function assertAccessorCustody(failures, label, state, snapshots, counters) {
  if (counters.reads !== 0) failures.push(`${label}: expected 0 getter reads, got ${counters.reads}`);
  if (counters.coercions !== 0) failures.push(`${label}: expected 0 coercions, got ${counters.coercions}`);
  collect(failures, `${label}: receipt ids changed`, () => assert.deepEqual(receiptIds(state), snapshots.ids));
  collect(failures, `${label}: publication projection changed`, () => assert.deepEqual(
    state.getTownHallPublication(snapshots.journalKey), snapshots.publication));
  collect(failures, `${label}: broadcast changed`, () => assert.deepEqual(
    state.getTownHallBroadcast(snapshots.journalKey), snapshots.broadcast));
  collect(failures, `${label}: broadcast list changed`, () => assert.deepEqual(
    state.listTownHallBroadcasts(), snapshots.broadcasts));
}

function recordCaseFailures(state, field, variant) {
  const seeded = seedInFlight(state, `rec-${field}-${variant}`);
  // Capture custody before defining any accessor so the fixture never reads its own getter.
  const snapshots = {
    journalKey: seeded.journalKey,
    ids: receiptIds(state),
    publication: structuredClone(state.getTownHallPublication(seeded.journalKey)),
    broadcast: structuredClone(state.getTownHallBroadcast(seeded.journalKey)),
    broadcasts: structuredClone(state.listTownHallBroadcasts())
  };
  const counters = { reads: 0, coercions: 0 };
  const detail = { messageId: '123' };
  defineVariant(detail, field, variant, counters);
  const outcome = observeCall(() => state.recordTownHallPublicationOutcome(
    seeded.journalKey, seeded.attemptId, 'sent', detail));
  const label = `recordTownHallPublicationOutcome ${field} ${variant}`;
  const failures = [];
  const mismatch = describeMismatch(outcome, RECORD_REFUSED);
  if (mismatch) failures.push(`${label}: expected RECORD_REFUSED, ${mismatch}`);
  assertAccessorCustody(failures, label, state, snapshots, counters);
  return failures;
}

function confirmCaseFailures(state, field, variant) {
  const seeded = seedInFlight(state, `conf-${field}-${variant}`);
  state.recordTownHallPublicationOutcome(seeded.journalKey, seeded.attemptId, 'unknown');
  // Capture custody before defining any accessor so the fixture never reads its own getter.
  const snapshots = {
    journalKey: seeded.journalKey,
    ids: receiptIds(state),
    publication: structuredClone(state.getTownHallPublication(seeded.journalKey)),
    broadcast: structuredClone(state.getTownHallBroadcast(seeded.journalKey)),
    broadcasts: structuredClone(state.listTownHallBroadcasts())
  };
  const counters = { reads: 0, coercions: 0 };
  const evidence = makeEvidence(seeded.nonce);
  defineVariant(evidence, field, variant, counters);
  const outcome = observeCall(() => state.confirmTownHallPublication(
    seeded.journalKey, seeded.attemptId, evidence));
  const label = `confirmTownHallPublication ${field} ${variant}`;
  const failures = [];
  const mismatch = describeMismatch(outcome, CONFIRM_REFUSED);
  if (mismatch) failures.push(`${label}: expected CONFIRM_REFUSED, ${mismatch}`);
  assertAccessorCustody(failures, label, state, snapshots, counters);
  return failures;
}

module.exports = { defineVariant, seedInFlight, makeEvidence, observeCall, describeMismatch, collect, assertAccessorCustody, recordCaseFailures, confirmCaseFailures, GetterFixtureError };
