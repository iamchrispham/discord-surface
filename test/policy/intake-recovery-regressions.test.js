'use strict';

const assert = require('node:assert/strict');
const { findDeadlineGapOffenders } = require('./intake-recovery-analysis.cjs');

(() => {
  const { test: regressionTest } = require('node:test');
  const regressionAssert = require('node:assert/strict');
  const offendersFor = source => findDeadlineGapOffenders([{ relative: 'mutation.js', source }]);

  regressionTest('deadline policy inventory recognizes binding-readiness writes', () => {
    const source = `if (deadlineReached) state.setBindingReadiness(id, READINESS.GAP, detail);`;
    regressionAssert.equal(offendersFor(source).length, 1);
  });

  regressionTest('deadline policy inventory recognizes membership predicates', () => {
    const source = `if ([STOPPED, CODEX_VALIDATION_KINDS.DEADLINE].includes(kind)) return READINESS.GAP;`;
    regressionAssert.equal(offendersFor(source).length, 1);
  });

  regressionTest('deadline policy inventory preserves negated alias polarity', () => {
    const expiredBranch = `const withinDeadline = !deadlineReached; if (!withinDeadline) return READINESS.GAP;`;
    const activeBranch = `const withinDeadline = !deadlineReached; if (withinDeadline) return READINESS.GAP;`;
    regressionAssert.equal(offendersFor(expiredBranch).length, 1);
    regressionAssert.equal(offendersFor(activeBranch).length, 0);
  });

  regressionTest('deadline policy inventory follows negated loop exits', () => {
    const negatedExit = `while (!deadlineReached) await poll(); return READINESS.GAP;`;
    const negatedBody = `while (!deadlineReached) { return READINESS.GAP; }`;
    const positiveBody = `while (deadlineReached) { return READINESS.GAP; }`;
    regressionAssert.equal(offendersFor(negatedExit).length, 1);
    regressionAssert.equal(offendersFor(negatedBody).length, 0);
    regressionAssert.equal(offendersFor(positiveBody).length, 1);
  });

  regressionTest('deadline policy inventory follows scheduled boundary writers', () => {
    const promiseCallback = `if (deadlineReached) Promise.resolve().then(() => state.markIntakeBoundary(id, READINESS.GAP, detail));`;
    const microtaskCallback = `if (deadlineReached) queueMicrotask(() => state.markIntakeBoundary(id, READINESS.GAP, detail));`;
    const nextTickCallback = `if (deadlineReached) process.nextTick(() => state.markIntakeBoundary(id, READINESS.GAP, detail));`;
    const safeNextTickCallback = `if (deadlineReached) process.nextTick(() => state.markIntakeBoundary(id, READINESS.UNAVAILABLE, detail));`;
    const unscheduledCallback = `const callback = () => state.markIntakeBoundary(id, READINESS.GAP, detail); if (deadlineReached) callback();`;
    const declaredCallback = `function wait() { function writeBoundary() { state.markIntakeBoundary(id, READINESS.GAP, detail); } if (deadlineReached) writeBoundary(); }`;
    regressionAssert.equal(offendersFor(promiseCallback).length, 1);
    regressionAssert.equal(offendersFor(microtaskCallback).length, 1);
    regressionAssert.equal(offendersFor(nextTickCallback).length, 1);
    regressionAssert.equal(offendersFor(safeNextTickCallback).length, 0);
    regressionAssert.equal(offendersFor(unscheduledCallback).length, 1);
    regressionAssert.equal(offendersFor(declaredCallback).length, 1);
  });

  regressionTest('deadline policy inventory inspects rejected promise catch callbacks', () => {
    const rejectedPromiseCallback = `function wait() { if (deadlineReached) return Promise.reject().catch(() => READINESS.GAP); }`;
    regressionAssert.equal(offendersFor(rejectedPromiseCallback).length, 1);
  });

  regressionTest('deadline policy inventory ignores unreachable settled-promise handlers', () => {
    const rejectedFulfillment = `function wait() { if (deadlineReached) return Promise.reject(error).then(() => READINESS.GAP); }`;
    const resolvedRejection = `function wait() { if (deadlineReached) return Promise.resolve(READINESS.READY).catch(() => READINESS.GAP); }`;
    const reachableFulfillment = `function wait() { if (deadlineReached) return Promise.resolve().then(() => READINESS.GAP); }`;
    const rejectedThenRecoveredToGap = 'function wait() { if (deadlineReached) return Promise.resolve().then(() => { throw new Error(); }).catch(() => READINESS.GAP); }';
    const rejectedThenRecoveredSafely = 'function wait() { if (deadlineReached) return Promise.resolve().then(() => { throw new Error(); }).catch(() => READINESS.UNAVAILABLE); }';
    const rejectedThenRecoveredByThen = 'function wait() { if (deadlineReached) return Promise.resolve().then(() => { throw new Error(); }).then(undefined, () => READINESS.GAP); }';
    regressionAssert.equal(offendersFor(rejectedFulfillment).length, 0);
    regressionAssert.equal(offendersFor(resolvedRejection).length, 0);
    regressionAssert.equal(offendersFor(reachableFulfillment).length, 1);
    regressionAssert.equal(offendersFor(rejectedThenRecoveredToGap).length, 1);
    regressionAssert.equal(offendersFor(rejectedThenRecoveredSafely).length, 0);
    regressionAssert.equal(offendersFor(rejectedThenRecoveredByThen).length, 1);
  });

  regressionTest('deadline policy inventory distinguishes TypeScript assertions from comparisons', () => {
    const offenders = findDeadlineGapOffenders([
      {
        relative: 'discord/deadline-angle-asserted-gap.ts',
        source: 'function wait() { if (deadlineReached) return <Readiness>READINESS.GAP; }'
      },
      {
        relative: 'discord/deadline-angle-asserted-safe.ts',
        source: 'function wait() { if (deadlineReached) return <Readiness>READINESS.UNAVAILABLE; }'
      },
      {
        relative: 'discord/deadline-angle-comparison-safe.ts',
        source: 'function wait(readiness) { if (deadlineReached) return readiness > READINESS.GAP ? READINESS.READY : READINESS.UNAVAILABLE; }'
      }
    ]);
    assert.deepEqual(offenders, ['discord/deadline-angle-asserted-gap.ts:1']);
  });

  regressionTest('deadline policy inventory ignores metadata-only gap assignments', () => {
    const bracedMetadata = `if (deadlineReached) { metadata.reason = READINESS.GAP; }`;
    const unbracedMetadata = `if (deadlineReached) metadata.reason = READINESS.GAP;`;
    const actualOutcome = `if (deadlineReached) return READINESS.GAP;`;
    regressionAssert.equal(offendersFor(bracedMetadata).length, 0);
    regressionAssert.equal(offendersFor(unbracedMetadata).length, 0);
    regressionAssert.equal(offendersFor(actualOutcome).length, 1);
  });

  regressionTest('deadline policy inventory tracks gap aliases in local object members', () => {
    const returnedMember = `function wait() { if (deadlineReached) { const box = {}; box.next = READINESS.GAP; return box.next; } }`;
    const persistedMember = `function wait() { if (deadlineReached) { const box = {}; box.next = READINESS.GAP; state.markIntakeBoundary(id, box.next, detail); } }`;
    regressionAssert.equal(offendersFor(returnedMember).length, 1);
    regressionAssert.equal(offendersFor(persistedMember).length, 1);
  });

  regressionTest('deadline policy inventory follows timer-scheduled boundary writers', () => {
    const timeoutCallback = `if (deadlineReached) setTimeout(() => state.markIntakeBoundary(id, READINESS.GAP, detail), 0);`;
    const immediateCallback = `if (deadlineReached) setImmediate(() => state.markIntakeBoundary(id, READINESS.GAP, detail));`;
    regressionAssert.equal(offendersFor(timeoutCallback).length, 1);
    regressionAssert.equal(offendersFor(immediateCallback).length, 1);
  });

  regressionTest('deadline policy inventory distinguishes returned arrows from invoked arrows', () => {
    const returnedArrow = `function wait() { if (deadlineReached) return () => READINESS.GAP; }`;
    const invokedArrow = `function wait() { if (deadlineReached) return (() => READINESS.GAP)(); }`;
    regressionAssert.equal(offendersFor(returnedArrow).length, 0);
    regressionAssert.equal(offendersFor(invokedArrow).length, 1);
  });

  regressionTest('deadline policy inventory follows completing deadline arms', () => {
    const completingArm = `function wait() { if (deadlineReached) { cleanup(); } else { return READINESS.READY; } return READINESS.GAP; }`;
    const abruptArm = `function wait() { if (deadlineReached) { return READINESS.READY; } return READINESS.GAP; }`;
    regressionAssert.equal(offendersFor(completingArm).length, 1);
    regressionAssert.equal(offendersFor(abruptArm).length, 0);
  });

  regressionTest('deadline policy inventory follows loop-targeting deadline breaks', () => {
    const loopBreakExit = `async function wait() { while (true) { if (deadlineReached) break; await poll(); } return READINESS.GAP; }`;
    const switchBreakStaysInsideLoop = `async function wait() { while (true) { if (deadlineReached) { switch (kind) { case 'x': break; } await poll(); } } return READINESS.GAP; }`;
    regressionAssert.equal(offendersFor(loopBreakExit).length, 1);
    regressionAssert.equal(offendersFor(switchBreakStaysInsideLoop).length, 0);
  });

  regressionTest('deadline policy inventory scans every Object.assign source', () => {
    const laterSourceGap = `if (deadlineReached) Object.assign(result, metadata, { state: READINESS.GAP });`;
    regressionAssert.equal(offendersFor(laterSourceGap).length, 1);
  });

  regressionTest('deadline policy inventory recognizes parenthesized ternary predicates', () => {
    const parenthesizedPredicate = `function readiness(deadlineReached) { return (deadlineReached) ? READINESS.GAP : READINESS.READY; }`;
    regressionAssert.equal(offendersFor(parenthesizedPredicate).length, 1);
  });

  regressionTest('deadline policy inventory preserves aliases across conditional writes', () => {
    const conditionalReset = `let expired = deadlineReached; if (reset) expired = false; if (expired) return READINESS.GAP;`;
    const conditionalBlockReset = `let expired = deadlineReached; if (reset) { audit(); expired = false; } if (expired) return READINESS.GAP;`;
    const unconditionalReset = `let expired = deadlineReached; expired = false; if (expired) return READINESS.GAP;`;
    const selectedBranchReset = `let expired = deadlineReached; if (expired) { expired = false; if (expired) return READINESS.GAP; }`;
    const selectedBranchOptionalReset = `let expired = deadlineReached; if (expired) { if (reset) { expired = false; } if (expired) return READINESS.GAP; }`;
    regressionAssert.equal(offendersFor(conditionalReset).length, 1);
    regressionAssert.equal(offendersFor(conditionalBlockReset).length, 1);
    regressionAssert.equal(offendersFor(unconditionalReset).length, 0);
    regressionAssert.equal(offendersFor(selectedBranchReset).length, 0);
    regressionAssert.equal(offendersFor(selectedBranchOptionalReset).length, 1);
  });

  regressionTest('deadline policy inventory ignores deadline names inside control-body regex literals', () => {
    const regexText = `if (enabled) /deadlineReached/.test(status) && state.markIntakeBoundary(id, READINESS.GAP, detail);`;
    regressionAssert.equal(offendersFor(regexText).length, 0);
  });

  regressionTest('deadline policy inventory resolves bound boundary writers', () => {
    const boundWriter = `const persist = state.markIntakeBoundary.bind(state); if (deadlineReached) persist(id, READINESS.GAP, detail);`;
    const nonDeadlineCall = `const persist = state.markIntakeBoundary.bind(state); if (!deadlineReached) persist(id, READINESS.GAP, detail);`;
    regressionAssert.equal(offendersFor(boundWriter).length, 1);
    regressionAssert.equal(offendersFor(nonDeadlineCall).length, 0);
  });

  regressionTest('deadline policy inventory follows bound writers through deadline aliases', () => {
    const boundWriter = 'const expired = deadlineReached; const persist = state.markIntakeBoundary.bind(state); if (expired) persist(id, READINESS.GAP, detail);';
    const nonDeadlineCall = 'const expired = deadlineReached; const persist = state.markIntakeBoundary.bind(state); if (!expired) persist(id, READINESS.GAP, detail);';
    regressionAssert.equal(offendersFor(boundWriter).length, 1);
    regressionAssert.equal(offendersFor(nonDeadlineCall).length, 0);
  });

  regressionTest('deadline policy inventory tokenizes executable template substitutions', () => {
    const templateQuote = String.fromCharCode(96);
    const source = 'if (deadlineReached) ' + templateQuote + String.fromCharCode(36)
      + '{state.markIntakeBoundary(id, READINESS.GAP, detail)}' + templateQuote + ';';
    regressionAssert.equal(offendersFor(source).length, 1);
  });

  regressionTest('deadline policy inventory preserves inequality polarity against false', () => {
    const expiryGap = 'if (deadlineReached !== false) return READINESS.GAP; else return READINESS.READY;';
    const nonExpiryGap = 'if (deadlineReached !== false) return READINESS.READY; else return READINESS.GAP;';
    regressionAssert.equal(offendersFor(expiryGap).length, 1);
    regressionAssert.equal(offendersFor(nonExpiryGap).length, 0);
  });

  regressionTest('deadline policy inventory selects boolean switch arms for direct and aliased triggers', () => {
    const directGap = 'switch (deadlineReached) { case true: return READINESS.GAP; case false: return READINESS.READY; }';
    const directSafe = 'switch (deadlineReached) { case true: return READINESS.READY; case false: return READINESS.GAP; }';
    const aliasedGap = 'const expired = deadlineReached; switch (expired) { case true: return READINESS.GAP; case false: return READINESS.READY; }';
    const aliasedSafe = 'const expired = deadlineReached; switch (expired) { case true: return READINESS.READY; case false: return READINESS.GAP; }';
    regressionAssert.equal(offendersFor(directGap).length, 1);
    regressionAssert.equal(offendersFor(directSafe).length, 0);
    regressionAssert.equal(offendersFor(aliasedGap).length, 1);
    regressionAssert.equal(offendersFor(aliasedSafe).length, 0);
  });

  regressionTest('deadline policy inventory maps handler boundary state arguments', () => {
    const intakeHandler = `if (deadlineReached) intakeHandlers.markIntakeBoundary(store, id, READINESS.GAP, detail);`;
    const threadHandler = `if (deadlineReached) threadEnrollmentHandlers.markThreadBoundary(store, id, READINESS.GAP, detail);`;
    const intakeChannelGap = `if (deadlineReached) intakeHandlers.markIntakeBoundary(store, READINESS.GAP, READINESS.READY, detail);`;
    const threadChannelGap = `if (deadlineReached) threadEnrollmentHandlers.markThreadBoundary(store, READINESS.GAP, READINESS.READY, detail);`;
    regressionAssert.equal(offendersFor(intakeHandler).length, 1);
    regressionAssert.equal(offendersFor(threadHandler).length, 1);
    regressionAssert.equal(offendersFor(intakeChannelGap).length, 0);
    regressionAssert.equal(offendersFor(threadChannelGap).length, 0);
  });

  regressionTest('deadline policy inventory follows logical expression result semantics', () => {
    const gapAndSafe = `if (deadlineReached) return READINESS.GAP && READINESS.UNAVAILABLE;`;
    const safeAndGap = `if (deadlineReached) return READINESS.UNAVAILABLE && READINESS.GAP;`;
    const gapOrSafe = `if (deadlineReached) return READINESS.GAP || READINESS.UNAVAILABLE;`;
    const safeOrGap = `if (deadlineReached) return READINESS.UNAVAILABLE || READINESS.GAP;`;
    const gapNullishSafe = `if (deadlineReached) return READINESS.GAP ?? READINESS.UNAVAILABLE;`;
    const safeNullishGap = `if (deadlineReached) return READINESS.UNAVAILABLE ?? READINESS.GAP;`;
    regressionAssert.equal(offendersFor(gapAndSafe).length, 0);
    regressionAssert.equal(offendersFor(safeAndGap).length, 1);
    regressionAssert.equal(offendersFor(gapOrSafe).length, 1);
    regressionAssert.equal(offendersFor(safeOrGap).length, 0);
    regressionAssert.equal(offendersFor(gapNullishSafe).length, 1);
    regressionAssert.equal(offendersFor(safeNullishGap).length, 0);
  });

  regressionTest('deadline policy inventory recognizes optional computed gap members', () => {
    const readinessGap = `if (deadlineReached) return READINESS?.['GAP'];`;
    const threadGap = `if (deadlineReached) return THREAD_STATES?.['GAP'];`;
    const unavailable = `if (deadlineReached) return READINESS?.['UNAVAILABLE'];`;
    const unrelatedGap = `if (deadlineReached) return LAYOUT?.['GAP'];`;
    regressionAssert.equal(offendersFor(readinessGap).length, 1);
    regressionAssert.equal(offendersFor(threadGap).length, 1);
    regressionAssert.equal(offendersFor(unavailable).length, 0);
    regressionAssert.equal(offendersFor(unrelatedGap).length, 0);
  });

  regressionTest('deadline policy inventory preserves outcomes through empty then handlers', () => {
    const passThrough = `if (deadlineReached) return Promise.resolve(READINESS.GAP).then();`;
    const replacement = `if (deadlineReached) return Promise.resolve(READINESS.GAP).then(() => READINESS.UNAVAILABLE);`;
    regressionAssert.equal(offendersFor(passThrough).length, 1);
    regressionAssert.equal(offendersFor(replacement).length, 0);
  });

  regressionTest('deadline policy inventory follows invoked async declarations only', () => {
    const invokedGap = `async function gap() { return READINESS.GAP; } if (deadlineReached) return gap();`;
    const invokedSafe = `async function ready() { return READINESS.UNAVAILABLE; } if (deadlineReached) return ready();`;
    const uninvoked = `if (deadlineReached) { async function gap() { return READINESS.GAP; } return READINESS.UNAVAILABLE; }`;
    regressionAssert.equal(offendersFor(invokedGap).length, 1);
    regressionAssert.equal(offendersFor(invokedSafe).length, 0);
    regressionAssert.equal(offendersFor(uninvoked).length, 0);
  });

  regressionTest('deadline policy inventory resolves local helper aliases at their use sites', () => {
    const gapWriterAlias = `function write() { state.markIntakeBoundary(id, READINESS.GAP, detail); } const alias = write; if (deadlineReached) alias();`;
    const safeWriterAlias = `function write() { state.markIntakeBoundary(id, READINESS.UNAVAILABLE, detail); } const alias = write; if (deadlineReached) alias();`;
    const reassignedAlias = `function write() { state.markIntakeBoundary(id, READINESS.GAP, detail); } let alias = write; alias = () => state.markIntakeBoundary(id, READINESS.UNAVAILABLE, detail); if (deadlineReached) alias();`;
    const shadowedAlias = `function write() { state.markIntakeBoundary(id, READINESS.GAP, detail); } const alias = write; if (deadlineReached) { const alias = () => state.markIntakeBoundary(id, READINESS.UNAVAILABLE, detail); alias(); }`;
    const gapReturnAlias = `function write() { return READINESS.GAP; } const alias = write; if (deadlineReached) return alias();`;
    regressionAssert.equal(offendersFor(gapWriterAlias).length, 1);
    regressionAssert.equal(offendersFor(safeWriterAlias).length, 0);
    regressionAssert.equal(offendersFor(reassignedAlias).length, 0);
    regressionAssert.equal(offendersFor(shadowedAlias).length, 0);
    regressionAssert.equal(offendersFor(gapReturnAlias).length, 1);
  });

  regressionTest('deadline policy inventory prunes only unreachable loop bodies and updates', () => {
    const whileUnreachable = `if (deadlineReached) { while (false) return READINESS.GAP; return READINESS.UNAVAILABLE; }`;
    const forUnreachable = `if (deadlineReached) { for (; false; state.markIntakeBoundary(id, READINESS.GAP, detail)) return READINESS.GAP; return READINESS.UNAVAILABLE; }`;
    const forInitializerGap = `if (deadlineReached) { for (state.markIntakeBoundary(id, READINESS.GAP, detail); false; poll()) return READINESS.GAP; return READINESS.UNAVAILABLE; }`;
    const doWhileGap = `if (deadlineReached) { do return READINESS.GAP; while (false); }`;
    regressionAssert.equal(offendersFor(whileUnreachable).length, 0);
    regressionAssert.equal(offendersFor(forUnreachable).length, 0);
    regressionAssert.equal(offendersFor(forInitializerGap).length, 1);
    regressionAssert.equal(offendersFor(doWhileGap).length, 1);
  });

  regressionTest('deadline policy inventory classifies singleton Promise.race values by result shape', () => {
    const gapRace = `if (deadlineReached) return Promise.race([READINESS.GAP]);`;
    const unavailableRace = `if (deadlineReached) return Promise.race([READINESS.UNAVAILABLE]);`;
    const discardedRace = `if (deadlineReached) Promise.race([READINESS.GAP]);`;
    const shadowedPromise = `const Promise = { race: values => READINESS.UNAVAILABLE }; if (deadlineReached) return Promise.race([READINESS.GAP]);`;
    const arrayResult = `if (deadlineReached) return Promise.all([READINESS.GAP]);`;
    regressionAssert.equal(offendersFor(gapRace).length, 1);
    regressionAssert.equal(offendersFor(unavailableRace).length, 0);
    regressionAssert.equal(offendersFor(discardedRace).length, 0);
    regressionAssert.equal(offendersFor(shadowedPromise).length, 0);
    regressionAssert.equal(offendersFor(arrayResult).length, 0);
  });

  regressionTest('deadline policy inventory applies defaults only to omitted helper arguments', () => {
    const omittedGap = `function outcome(value = READINESS.GAP) { return value; } if (deadlineReached) return outcome();`;
    const explicitSafe = `function outcome(value = READINESS.GAP) { return value; } if (deadlineReached) return outcome(READINESS.UNAVAILABLE);`;
    const omittedSafe = `function outcome(value = READINESS.UNAVAILABLE) { return value; } if (deadlineReached) return outcome();`;
    regressionAssert.equal(offendersFor(omittedGap).length, 1);
    regressionAssert.equal(offendersFor(explicitSafe).length, 0);
    regressionAssert.equal(offendersFor(omittedSafe).length, 0);
  });

  regressionTest('deadline policy inventory recognizes Set membership triggers', () => {
    const deadline = `if (new Set([CODEX_VALIDATION_KINDS.DEADLINE]).has(kind)) return READINESS.GAP;`;
    const nonDeadline = `if (new Set([CODEX_VALIDATION_KINDS.RETRY]).has(kind)) return READINESS.GAP;`;
    regressionAssert.equal(offendersFor(deadline).length, 1);
    regressionAssert.equal(offendersFor(nonDeadline).length, 0);
  });

  regressionTest('deadline policy inventory follows statically selected logical assignments', () => {
    const orAssigned = `let expired = false; expired ||= deadlineReached; if (expired) return READINESS.GAP;`;
    const andAssigned = `let expired = true; expired &&= deadlineReached; if (expired) return READINESS.GAP;`;
    const nullishAssigned = `let expired = null; expired ??= deadlineReached; if (expired) return READINESS.GAP;`;
    const negatedSafe = `let within = false; within ||= !deadlineReached; if (within) return READINESS.GAP;`;
    const orShortCircuits = `let expired = true; expired ||= deadlineReached; if (expired) return READINESS.GAP;`;
    const andShortCircuits = `let active = false; active &&= deadlineReached; if (!active) return READINESS.GAP;`;
    const nullishShortCircuits = `let ready = 'ready'; ready ??= deadlineReached; if (ready) return READINESS.GAP;`;
    regressionAssert.equal(offendersFor(orAssigned).length, 1);
    regressionAssert.equal(offendersFor(andAssigned).length, 1);
    regressionAssert.equal(offendersFor(nullishAssigned).length, 1);
    regressionAssert.equal(offendersFor(negatedSafe).length, 0);
    regressionAssert.equal(offendersFor(orShortCircuits).length, 0);
    regressionAssert.equal(offendersFor(andShortCircuits).length, 0);
    regressionAssert.equal(offendersFor(nullishShortCircuits).length, 0);
  });
})();
