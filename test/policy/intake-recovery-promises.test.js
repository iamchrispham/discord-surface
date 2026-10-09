'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { findDeadlineGapOffenders, readSourceInventory } = require('./intake-recovery-analysis.cjs');

test('deadline policy inventory inspects braced callbacks in returned promises', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-returned-promise-gap.js',
      source: 'if (deadlineReached) return Promise.resolve().then(() => { return READINESS.GAP; });'
    },
    {
      relative: 'discord/deadline-returned-promise-ready.js',
      source: 'if (deadlineReached) return Promise.resolve().then(() => { return READINESS.READY; });'
    },
    {
      relative: 'discord/deadline-promise-gap-overridden.js',
      source: 'if (deadlineReached) return Promise.resolve().then(() => READINESS.GAP).then(() => READINESS.UNAVAILABLE);'
    },
    {
      relative: 'discord/deadline-promise-gap-preserved.js',
      source: 'if (deadlineReached) return Promise.resolve().then(() => READINESS.GAP).then(value => value);'
    },
    {
      relative: 'discord/deadline-promise-gap-write-preserved.js',
      source: 'if (deadlineReached) return Promise.resolve().then(() => { state.markIntakeBoundary(id, READINESS.GAP, detail); return READINESS.UNAVAILABLE; }).then(() => READINESS.UNAVAILABLE);'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/deadline-returned-promise-gap.js:1',
    'discord/deadline-promise-gap-preserved.js:1',
    'discord/deadline-promise-gap-write-preserved.js:1'
  ]);
});

test('deadline policy inventory detects eager forEach writes but ignores callback returns', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/deadline-eager-foreach.js',
    source: [
      'if (deadlineReached) [id].forEach(id => state.markIntakeBoundary(id, READINESS.GAP, detail));',
      'if (deadlineReached) [id].forEach(id => READINESS.GAP);',
      'if (deadlineReached) [id].forEach(id => state.markIntakeBoundary(id, READINESS.UNAVAILABLE, detail));'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['discord/deadline-eager-foreach.js:1']);
});

test('deadline policy inventory inspects secondary promise continuation callbacks', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/deadline-rejected-promise-gap.js',
    source: 'if (deadlineReached) return Promise.reject().then(undefined, () => state.markIntakeBoundary(id, READINESS.GAP, detail));'
  }]);
  assert.deepEqual(offenders, ['discord/deadline-rejected-promise-gap.js:1']);
});

test('deadline policy inventory inspects persistent writes in finally callbacks', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-finally-boundary-writer.js',
      source: 'if (deadlineReached) return Promise.resolve().finally(() => state.markIntakeBoundary(id, READINESS.GAP, detail));'
    },
    {
      relative: 'discord/deadline-finally-boundary-writer-safe.js',
      source: 'if (deadlineReached) return Promise.resolve().finally(() => state.markIntakeBoundary(id, READINESS.UNAVAILABLE, detail));'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-finally-boundary-writer.js:1']);
});

test('deadline policy inventory inspects synchronous Promise executor writes', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-promise-executor-boundary-writer.js',
      source: 'if (deadlineReached) return new Promise(resolve => { state.markIntakeBoundary(id, READINESS.GAP, detail); resolve(); });'
    },
    {
      relative: 'discord/deadline-promise-executor-boundary-writer-safe.js',
      source: 'if (deadlineReached) return new Promise(resolve => { state.markIntakeBoundary(id, READINESS.UNAVAILABLE, detail); resolve(); });'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-promise-executor-boundary-writer.js:1']);
});

test('deadline policy inventory tracks Promise executor fulfillment outcomes', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-promise-resolver-gap.js',
      source: 'if (deadlineReached) return new Promise(resolve => resolve(READINESS.GAP));'
    },
    {
      relative: 'discord/deadline-promise-executor-return.js',
      source: 'if (deadlineReached) return new Promise(resolve => { return READINESS.GAP; });'
    },
    {
      relative: 'discord/deadline-promise-resolver-unavailable.js',
      source: 'if (deadlineReached) return new Promise(resolve => resolve(READINESS.UNAVAILABLE));'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-promise-resolver-gap.js:1']);
});

test('deadline policy inventory preserves fulfilled values through Promise.finally', () => {
  const entries = [
    {
      relative: 'discord/finally-empty.js',
      source: 'if (deadlineReached) return Promise.resolve(READINESS.GAP).finally(() => {});'
    },
    {
      relative: 'discord/finally-expression-return.js',
      source: 'if (deadlineReached) return Promise.resolve(READINESS.GAP).finally(() => READINESS.UNAVAILABLE);'
    },
    {
      relative: 'discord/finally-block-return.js',
      source: 'if (deadlineReached) return Promise.resolve(READINESS.GAP).finally(() => { return READINESS.UNAVAILABLE; });'
    },
    {
      relative: 'discord/finally-throw.js',
      source: 'if (deadlineReached) return Promise.resolve(READINESS.GAP).finally(() => { throw new Error(); });'
    },
    {
      relative: 'discord/finally-rejected-promise.js',
      source: 'if (deadlineReached) return Promise.resolve(READINESS.GAP).finally(() => Promise.reject(new Error()));'
    },
    {
      relative: 'discord/finally-return-gap-does-not-replace.js',
      source: 'if (deadlineReached) return Promise.resolve(READINESS.UNAVAILABLE).finally(() => READINESS.GAP);'
    },
    {
      relative: 'discord/then-outcome-control.js',
      source: 'if (deadlineReached) return Promise.resolve().then(() => READINESS.GAP);'
    }
  ];

  assert.deepEqual(findDeadlineGapOffenders(entries), [
    'discord/finally-empty.js:1',
    'discord/finally-expression-return.js:1',
    'discord/finally-block-return.js:1',
    'discord/then-outcome-control.js:1'
  ]);
});

test('deadline policy inventory inspects concise scheduled callback outcomes', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-scheduled-concise-gap.js',
      source: 'if (deadlineReached) return Promise.resolve().then(() => READINESS.GAP);'
    },
    {
      relative: 'discord/deadline-scheduled-concise-safe.js',
      source: 'if (deadlineReached) return Promise.resolve().then(() => READINESS.UNAVAILABLE);'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-scheduled-concise-gap.js:1']);
});

test('deadline policy inventory inspects writes in eager array callbacks', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: 'mutation.js', source }]);
  const methods = ['map', 'some', 'every', 'filter', 'find'];
  const gapWrites = methods.map(method =>
    `if (deadlineReached) [id].${method}(id => state.markIntakeBoundary(id, READINESS.GAP, detail));`
  );
  const safeWrites = methods.map(method =>
    `if (deadlineReached) [id].${method}(id => state.markIntakeBoundary(id, READINESS.READY, detail));`
  );
  const discardedGapResults = methods.map(method =>
    `if (deadlineReached) [id].${method}(() => READINESS.GAP);`
  );

  assert.deepEqual(gapWrites.map(source => offendersFor(source).length), methods.map(() => 1));
  assert.deepEqual(safeWrites.map(source => offendersFor(source).length), methods.map(() => 0));
  assert.deepEqual(discardedGapResults.map(source => offendersFor(source).length), methods.map(() => 0));
});

test('deadline policy inventory respects Promise lexical bindings', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-shadowed-promise-resolve.js',
      source: 'const Promise = { resolve: () => READINESS.UNAVAILABLE }; if (deadlineReached) return Promise.resolve(READINESS.GAP);'
    },
    {
      relative: 'discord/deadline-shadowed-promise-race.js',
      source: 'const Promise = { race: () => READINESS.UNAVAILABLE }; if (deadlineReached) return Promise.race([READINESS.GAP]);'
    },
    {
      relative: 'discord/deadline-shadowed-promise-then.js',
      source: 'const Promise = { resolve: () => ({ then: () => READINESS.UNAVAILABLE }) }; if (deadlineReached) return Promise.resolve().then(() => READINESS.GAP);'
    },
    {
      relative: 'discord/deadline-shadowed-promise-reject.js',
      source: 'const Promise = { reject: () => ({ then: () => READINESS.UNAVAILABLE }) }; if (deadlineReached) return Promise.reject().then(undefined, () => READINESS.GAP);'
    },
    {
      relative: 'discord/deadline-shadowed-promise-constructor.js',
      source: 'const Promise = function (executor) { executor(() => {}); }; if (deadlineReached) return new Promise(resolve => resolve(READINESS.GAP));'
    }
  ]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory distinguishes returned promises from persisted promise values', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-persisted-gap.js',
      source: 'if (deadlineReached) state.markIntakeBoundary(id, READINESS.GAP, detail);'
    },
    {
      relative: 'discord/deadline-persisted-resolved-promise.js',
      source: 'if (deadlineReached) state.markIntakeBoundary(id, Promise.resolve(READINESS.GAP), detail);'
    },
    {
      relative: 'discord/deadline-persisted-race-promise.js',
      source: 'if (deadlineReached) state.markIntakeBoundary(id, Promise.race([READINESS.GAP]), detail);'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-persisted-gap.js:1']);
});

test('deadline policy inventory inspects named callbacks passed to eager APIs', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-eager-named-callback-gap.js',
      source: 'const write = () => state.markIntakeBoundary(id, READINESS.GAP, detail); if (deadlineReached) [id].forEach(write);'
    },
    {
      relative: 'discord/deadline-eager-named-callback-safe.js',
      source: 'const write = () => state.markIntakeBoundary(id, READINESS.UNAVAILABLE, detail); if (deadlineReached) [id].forEach(write);'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-eager-named-callback-gap.js:1']);
});

test('deadline policy inventory separates native Promise races from local methods', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-native-race-returned.js',
      source: 'if (deadlineReached) return Promise.race([READINESS.GAP]);'
    },
    {
      relative: 'discord/deadline-native-race-discarded.js',
      source: 'if (deadlineReached) Promise.race([READINESS.GAP]);'
    },
    {
      relative: 'discord/deadline-native-race-persisted.js',
      source: 'if (deadlineReached) state.markIntakeBoundary(id, Promise.race([READINESS.GAP]), detail);'
    },
    {
      relative: 'discord/deadline-local-race-returned.js',
      source: 'const Promise = { race: values => values[0] }; if (deadlineReached) return Promise.race([READINESS.GAP]);'
    },
    {
      relative: 'discord/deadline-local-race-first-safe.js',
      source: 'const Promise = { race: values => values[0] }; if (deadlineReached) return Promise.race([READINESS.READY, READINESS.GAP]);'
    },
    {
      relative: 'discord/deadline-local-race-non-gap.js',
      source: 'const Promise = { race: () => READINESS.UNAVAILABLE }; if (deadlineReached) return Promise.race([READINESS.GAP]);'
    },
    {
      relative: 'discord/deadline-local-race-discarded.js',
      source: 'const Promise = { race: values => values[0] }; if (deadlineReached) Promise.race([READINESS.GAP]);'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/deadline-native-race-returned.js:1',
    'discord/deadline-local-race-returned.js:1'
  ]);
});

test('deadline policy inventory recognizes optional process nextTick callbacks', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: 'mutation.js', source }]);
  assert.deepEqual(offendersFor('if(deadlineReached)process?.nextTick(()=>state.markIntakeBoundary(id,READINESS.GAP,detail));'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('if(deadlineReached)process.nextTick(()=>state.markIntakeBoundary(id,READINESS.UNAVAILABLE,detail));'), []);
  assert.deepEqual(offendersFor('const process={nextTick:()=>{}};if(deadlineReached)process?.nextTick(()=>state.markIntakeBoundary(id,READINESS.GAP,detail));'), []);
});
