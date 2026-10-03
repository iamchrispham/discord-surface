'use strict';

function createTransportRecoveryWaiter(scope, deadline, makeResult, deadlineGraceMs) {
  let resolveWaiter;
  const waiter = {
    scope,
    deadline,
    parents: new Set(),
    childCount: 0,
    pending: 1,
    ownDone: false,
    ownResult: null,
    lastResult: null,
    settled: false,
    stopped: false,
    timer: null,
    promise: new Promise(resolve => { resolveWaiter = resolve; })
  };
  const armTimer = () => {
    if (!Number.isFinite(waiter.deadline)) return;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.timer = setTimeout(() => waiter.settle({ ready: false, state: 'unavailable' }),
      Math.max(0, waiter.deadline - Date.now()) + deadlineGraceMs);
  };
  waiter.extendDeadline = nextDeadline => {
    if (waiter.settled || !Number.isFinite(nextDeadline) ||
        (Number.isFinite(waiter.deadline) && nextDeadline <= waiter.deadline)) return;
    waiter.deadline = nextDeadline;
    armTimer();
  };
  const notifyParents = result => {
    for (const parent of waiter.parents) parent.childFinished(result);
  };
  waiter.settle = fallback => {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    const result = makeResult(waiter, fallback);
    resolveWaiter(result);
    notifyParents(result);
  };
  waiter.stop = () => {
    if (waiter.settled) return;
    waiter.stopped = true;
    waiter.settled = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    const result = { ready: false, state: 'stopped' };
    resolveWaiter(result);
    notifyParents(result);
  };
  waiter.maybeSettle = () => {
    if (waiter.ownDone && waiter.pending === 0) waiter.settle();
  };
  waiter.childFinished = result => {
    if (waiter.settled) return;
    if (result?.state === 'stopped') {
      waiter.stop();
      return;
    }
    waiter.lastResult = result;
    waiter.pending = Math.max(0, waiter.pending - 1);
    waiter.maybeSettle();
  };
  waiter.completeOwn = result => {
    if (waiter.settled || waiter.ownDone) return;
    waiter.ownDone = true;
    waiter.ownResult = result;
    waiter.lastResult = result;
    if (result?.state === 'stopped') {
      waiter.stop();
      return;
    }
    waiter.pending = Math.max(0, waiter.pending - 1);
    waiter.maybeSettle();
  };
  armTimer();
  return waiter;
}

module.exports = { createTransportRecoveryWaiter };
