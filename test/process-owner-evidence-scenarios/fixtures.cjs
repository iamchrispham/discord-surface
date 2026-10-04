'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SurfaceState, BindingError, StateCorruptError, discordNonce } = require('../../src/state');
const { fixture } = require('../direct-post-fixture');
const { createTownHallPublicationHandlers } = require('../../dist/state/town-hall-publication/index.js');

const FAKE_PID = 424242;
const PUBLICATION_PREFIX = 'town-hall-publication/v1:';

function probeError(code) {
  return Object.assign(new Error(`fixture probe ${code}`), { code });
}

function probeDeps({ probeErrorThrown = null, probeReturns = true, capture = () => ({ ownerStartTime: 'actual', ownerCommand: 'actual' }), captureThrows = false } = {}) {
  const calls = { probe: 0, capture: 0 };
  return {
    calls,
    deps: {
      probePid() {
        calls.probe += 1;
        if (probeErrorThrown) throw probeErrorThrown;
        return probeReturns;
      },
      captureIdentity() {
        calls.capture += 1;
        if (captureThrows) throw new Error('fixture capture failure');
        return capture();
      }
    }
  };
}

function mockProcessKill(code) {
  const calls = [];
  const original = process.kill;
  process.kill = (pid, signal) => {
    calls.push([pid, signal]);
    if (code) throw probeError(code);
    return true;
  };
  return { calls, restore: () => { process.kill = original; } };
}

function receiptIds(state) {
  return state.listReceipts().map(row => row.id);
}

function receiptsOfKind(state, kind) {
  return state.listReceipts().filter(row => row.kind === kind);
}

// Fixture helper for scenarios that create and close several states inside one
// top-level test; cleanup is explicit in each finally block.
function headlessFixture() {
  return fixture({ after() {} });
}

const TOWN_HALL_RECORDED = { ownerPid: process.pid, ownerStartTime: 'recorded-start', ownerCommand: 'recorded-command' };
const TOWN_HALL_SOURCE_NATIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOWN_HALL_NATIVE = '11111111-1111-4111-8111-aabbccddeeff';

function townHallAddress(channelId, nativeId) {
  return { guildId: '100', channelId, provider: 'codex', nativeId, generation: 1 };
}

function townHallPlan(broadcastId) {
  return {
    broadcastId,
    townHall: { guildId: '100', channelId: '900' },
    source: townHallAddress('200', TOWN_HALL_SOURCE_NATIVE),
    recipients: [townHallAddress('300', TOWN_HALL_NATIVE)],
    text: 'hello'
  };
}

function townHallFixture(t, broadcastId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-evidence-town-hall-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => {
    try { state.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  state.directPostOwnerIdentity = () => TOWN_HALL_RECORDED;
  const created = state.createTownHallBroadcast(townHallPlan(broadcastId));
  const journalKey = created.broadcast.journalKey;
  const reserved = state.reserveTownHallPublication(journalKey);
  return { state, journalKey, attemptId: reserved.publication.attemptId };
}

function townHallHandlers(probePid) {
  return createTownHallPublicationHandlers({ BindingError, StateCorruptError, discordNonce, probePid });
}

function publicationRows(state, journalKey) {
  return state.listReceipts().filter(row => row.kind === PUBLICATION_PREFIX + journalKey);
}

module.exports = {
  probeError,
  probeDeps,
  mockProcessKill,
  receiptIds,
  receiptsOfKind,
  headlessFixture,
  townHallAddress,
  townHallPlan,
  townHallFixture,
  townHallHandlers,
  publicationRows,
  FAKE_PID,
  PUBLICATION_PREFIX,
  TOWN_HALL_RECORDED,
  TOWN_HALL_SOURCE_NATIVE,
  TOWN_HALL_NATIVE
};
