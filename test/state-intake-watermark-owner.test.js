'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const STATE_PATH = path.resolve(__dirname, '..', 'src', 'state.js');
const INTAKE_PATH = path.resolve(__dirname, '..', 'src', 'state', 'intake.js');

// Loads a fresh State facade whose intake factory returns recording handlers,
// then restores both cache entries so later suites see the real modules.
function withFixtureIntakeOwner(names, run) {
  const savedState = require.cache[STATE_PATH];
  const savedIntake = require.cache[INTAKE_PATH];
  const savedIntakeExports = savedIntake?.exports;
  const realIntake = require(INTAKE_PATH);
  const calls = [];
  const handlers = Object.fromEntries(names.map(name => [name, (...args) => {
    calls.push({ name, args });
    return { returnedBy: name };
  }]));
  try {
    require.cache[INTAKE_PATH].exports = { ...realIntake, createIntakeHandlers: () => handlers };
    delete require.cache[STATE_PATH];
    const { SurfaceState } = require(STATE_PATH);
    run(SurfaceState.prototype, calls);
  } finally {
    delete require.cache[STATE_PATH];
    if (savedState) require.cache[STATE_PATH] = savedState;
    if (savedIntake) {
      savedIntake.exports = savedIntakeExports;
      require.cache[INTAKE_PATH] = savedIntake;
    } else delete require.cache[INTAKE_PATH];
  }
}

function assertForwarded(name, args) {
  const receiver = { sentinel: name };
  const extra = args.map((_, index) => ({ argument: index }));
  withFixtureIntakeOwner([name], (proto, calls) => {
    const result = proto[name].call(receiver, ...extra);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, name);
    assert.equal(calls[0].args[0], receiver);
    assert.equal(calls[0].args.length, extra.length + 1);
    extra.forEach((value, index) => assert.equal(calls[0].args[index + 1], value));
    assert.deepEqual(result, { returnedBy: name });
  });
}

test('upsertIntakeWatermark', () => {
  assertForwarded('upsertIntakeWatermark', ['event', 'ready', 'coverageId']);
});

test('getIntakeWatermark', () => {
  assertForwarded('getIntakeWatermark', ['channelId']);
});

test('setIntakeBaseline', () => {
  assertForwarded('setIntakeBaseline', ['channelId', 'lastSeenId', 'detail', 'expectedBinding', 'expectedBoundary', 'expectedReadiness']);
});

test('restores preloaded intake exports after fixture cleanup', () => {
  const savedState = require.cache[STATE_PATH];
  const savedIntake = require.cache[INTAKE_PATH];
  const originalExports = require(INTAKE_PATH);
  const preloadedIntake = require.cache[INTAKE_PATH];
  try {
    assert.throws(
      () => withFixtureIntakeOwner(['getIntakeWatermark'], () => {
        throw new Error('fixture callback failed');
      }),
      /fixture callback failed/
    );
    assert.equal(require.cache[STATE_PATH], savedState);
    assert.equal(require.cache[INTAKE_PATH], preloadedIntake);
    assert.equal(require.cache[INTAKE_PATH].exports, originalExports);
  } finally {
    if (savedState) require.cache[STATE_PATH] = savedState;
    else delete require.cache[STATE_PATH];
    if (savedIntake) require.cache[INTAKE_PATH] = savedIntake;
    else delete require.cache[INTAKE_PATH];
  }
});
