'use strict';

const Module = require('node:module');
const path = require('node:path');
const { OWNER_PATH } = require('./handoff-scheduler-owner-contracts.cjs');

function withFakeTimers(run) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = { callback: () => callback(...args), delay, cleared: false, unref() { return this; } };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = timer => { if (timer) timer.cleared = true; };
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  };
  try {
    const result = run(timers);
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function schedulerReceiver(DiscordGateway) {
  const receiver = Object.create(DiscordGateway.prototype);
  Object.assign(receiver, {
    stopping: false,
    started: true,
    transportReady: true,
    ready: false,
    lifecycleEpoch: 7,
    deferredHandoffRecoveryTimer: null,
    deferredHandoffRecoveryTimerDeadline: null,
    pendingHandoffRecoveryPollTimer: null,
    deferredHandoffRecoveryChannels: new Set(),
    pendingHandoffRecoveryChannels: new Set(),
    deferredHandoffRecoveryDelayMs: 20,
    recoveryPromise: null,
    state: {
      getBinding: () => null,
      recoverInterruptedOrdinaryHandoffIntake: () => null,
      listPendingOrdinaryHandoffChannels: () => [],
      listBindings: () => [],
      isOrdinaryBinding: () => false
    },
    recoverTransport: async () => ({ ready: false }),
    reconcilePending: async () => {},
    logger: () => {}
  });
  return receiver;
}

function ownerFromText(text) {
  const loaded = new Module(`${OWNER_PATH}.control`, module);
  loaded.filename = OWNER_PATH;
  loaded.paths = Module._nodeModulePaths(path.dirname(OWNER_PATH));
  loaded._compile(text, OWNER_PATH);
  return loaded.exports;
}

module.exports = { withFakeTimers, schedulerReceiver, ownerFromText };
