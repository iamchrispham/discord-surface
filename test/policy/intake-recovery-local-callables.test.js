'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { findDeadlineGapOffenders, readSourceInventory } = require('./intake-recovery-analysis.cjs');

test('deadline policy inventory follows synchronous local helper return values', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-local-helper-gap.js',
      source: 'function gap() { return READINESS.GAP; } if (deadlineReached) return gap();'
    },
    {
      relative: 'discord/deadline-local-helper-unavailable.js',
      source: 'function unavailable() { return READINESS.UNAVAILABLE; } if (deadlineReached) return unavailable();'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-local-helper-gap.js:1']);
});

test('deadline policy inventory binds local helper arguments to parameters', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/deadline-local-helper-arguments.js',
    source: [
      'function outcome(value) { return value; }',
      'function overwritten(value) { value = READINESS.UNAVAILABLE; return value; }',
      'function persist(value) { state.markIntakeBoundary(id, value, detail); }',
      'if (deadlineReached) return outcome(READINESS.GAP);',
      'if (deadlineReached) return outcome(READINESS.UNAVAILABLE);',
      'if (deadlineReached) return overwritten(READINESS.GAP);',
      'if (deadlineReached) return persist(READINESS.GAP);',
      'if (deadlineReached) return persist(READINESS.UNAVAILABLE);'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, [
    'discord/deadline-local-helper-arguments.js:4',
    'discord/deadline-local-helper-arguments.js:7'
  ]);
});

test('deadline policy inventory resolves shorthand outcome properties', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/shorthand-gap-outcome.js',
    source: 'const state = READINESS.GAP; if (deadlineReached) return { state };'
  }]);
  assert.deepEqual(offenders, ['discord/shorthand-gap-outcome.js:1']);
});

test('deadline policy inventory inspects boundary writers in invoked nested functions', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/invoked-boundary-writer.js',
    source: 'if (deadlineReached) { (() => recordBoundary(binding, null, READINESS.GAP, detail))(); }'
  }]);
  assert.deepEqual(offenders, ['discord/invoked-boundary-writer.js:1']);
});

test('deadline policy inventory follows invoked local object methods', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: 'mutation.js', source }]);
  const gapWriter = 'const helper = { write() { state.markIntakeBoundary(id, READINESS.GAP, detail); } }; if (deadlineReached) helper.write();';
  const safeWriter = 'const helper = { write() { state.markIntakeBoundary(id, READINESS.READY, detail); } }; if (deadlineReached) helper.write();';
  const unusedWriter = 'const helper = { write() { state.markIntakeBoundary(id, READINESS.GAP, detail); } }; if (deadlineReached) id;';

  assert.deepEqual(offendersFor(gapWriter), ['mutation.js:1']);
  assert.deepEqual(offendersFor(safeWriter), []);
  assert.deepEqual(offendersFor(unusedWriter), []);
});

test('deadline policy inventory follows local object deadline aliases and overwrites', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: 'mutation.js', source }]);
  assert.deepEqual(offendersFor('const flags = {}; flags.expired = deadlineReached; if (flags.expired) return READINESS.GAP;'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('const flags = {}; flags.expired = !deadlineReached; if (flags.expired) return READINESS.GAP;'), []);
  assert.deepEqual(offendersFor('const flags = {}; flags.expired = deadlineReached; flags.expired = !deadlineReached; if (flags.expired) return READINESS.GAP;'), []);
});

test('deadline policy inventory follows local object method aliases', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-object-method-alias-gap.js',
      source: 'const obj = { write() { state.markIntakeBoundary(id, READINESS.GAP, detail); } }; const alias = obj.write; if (deadlineReached) alias();'
    },
    {
      relative: 'discord/deadline-object-method-alias-safe.js',
      source: 'const obj = { write() { state.markIntakeBoundary(id, READINESS.UNAVAILABLE, detail); } }; const alias = obj.write; if (deadlineReached) alias();'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-object-method-alias-gap.js:1']);
});

test('deadline policy inventory follows local helper binding patterns', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-object-binding-gap.js',
      source: 'function outcome({ state }) { return state; } if (deadlineReached) return outcome({ state: READINESS.GAP });'
    },
    {
      relative: 'discord/deadline-object-binding-safe.js',
      source: 'function outcome({ state }) { return state; } if (deadlineReached) return outcome({ state: READINESS.READY, other: READINESS.GAP });'
    },
    {
      relative: 'discord/deadline-array-binding-gap.js',
      source: 'function outcome([state]) { return state; } if (deadlineReached) return outcome([READINESS.GAP, READINESS.READY]);'
    },
    {
      relative: 'discord/deadline-array-binding-safe.js',
      source: 'function outcome([state]) { return state; } if (deadlineReached) return outcome([READINESS.READY, READINESS.GAP]);'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/deadline-object-binding-gap.js:1',
    'discord/deadline-array-binding-gap.js:1'
  ]);
});

test('deadline policy inventory follows local helpers invoked through call and apply', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-local-call-gap.js',
      source: 'function outcome(state) { return state; } if (deadlineReached) return outcome.call(null, READINESS.GAP);'
    },
    {
      relative: 'discord/deadline-local-call-safe.js',
      source: 'function outcome(state) { return state; } if (deadlineReached) return outcome.call(null, READINESS.READY);'
    },
    {
      relative: 'discord/deadline-local-apply-gap.js',
      source: 'function outcome(state) { return state; } if (deadlineReached) return outcome.apply(null, [READINESS.GAP]);'
    },
    {
      relative: 'discord/deadline-local-apply-safe.js',
      source: 'function outcome(state) { return state; } if (deadlineReached) return outcome.apply(null, [READINESS.READY, READINESS.GAP]);'
    },
    {
      relative: 'discord/deadline-local-apply-hole-safe.js',
      source: 'function outcome(first) { return first; } if (deadlineReached) return outcome.apply(null, [, READINESS.GAP]);'
    },
    {
      relative: 'discord/deadline-local-call-constant-gap.js',
      source: 'function outcome() { return READINESS.GAP; } if (deadlineReached) return outcome.call(null);'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/deadline-local-call-gap.js:1',
    'discord/deadline-local-apply-gap.js:1',
    'discord/deadline-local-call-constant-gap.js:1'
  ]);
});

test('deadline policy inventory waits for returned local outcome properties', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-outcome-property-overwritten.js',
      source: 'if (deadlineReached) { const result = {}; result.state = READINESS.GAP; result.state = READINESS.UNAVAILABLE; return result; }'
    },
    {
      relative: 'discord/deadline-outcome-property-deleted.js',
      source: 'if (deadlineReached) { const result = {}; result.state = READINESS.GAP; delete result.state; return result; }'
    },
    {
      relative: 'discord/deadline-outcome-property-returned.js',
      source: 'if (deadlineReached) { const result = {}; result.state = READINESS.GAP; return result; }'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-outcome-property-returned.js:1']);
});

test('deadline policy inventory resolves shorthand methods with supplied arguments', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: 'mutation.js', source }]);
  assert.deepEqual(offendersFor('const Promise={race(values){return values[0];}};if(deadlineReached) return Promise.race([READINESS.GAP]);'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('const helpers={outcome(value){return value;}};if(deadlineReached) return helpers.outcome(READINESS.READY);'), []);
});

test('deadline policy inventory resolves the selected function-valued method', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: 'mutation.js', source }]);
  assert.deepEqual(offendersFor('const Promise={race:(values,pick=()=>READINESS.UNAVAILABLE)=>values[0]};if(deadlineReached) return Promise.race([READINESS.GAP]);'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('const Promise={race:(values,pick=()=>READINESS.GAP)=>READINESS.UNAVAILABLE};if(deadlineReached) return Promise.race([READINESS.READY]);'), []);
  assert.deepEqual(offendersFor('const Promise={race:false?()=>READINESS.UNAVAILABLE:values=>values[0]};if(deadlineReached) return Promise.race([READINESS.GAP]);'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('const Promise={race:true?()=>READINESS.UNAVAILABLE:values=>values[0]};if(deadlineReached) return Promise.race([READINESS.GAP]);'), []);
});

test('deadline policy inventory follows synchronous local helpers invoked through bind', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: 'mutation.js', source }]);
  assert.deepEqual(offendersFor('function outcome(){return READINESS.GAP;}if(deadlineReached) return outcome.bind(null)();'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('function outcome(){return READINESS.READY;}if(deadlineReached) return outcome.bind(null)();'), []);
});

test('deadline policy inventory scans call and apply statement effects without promoting discarded returns', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: 'mutation.js', source }]);
  assert.deepEqual(offendersFor('function write(){state.markIntakeBoundary(id,READINESS.GAP,detail);}if(deadlineReached) write.call(null);'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('function write(){state.markIntakeBoundary(id,READINESS.GAP,detail);}if(deadlineReached) write.apply(null,[]);'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('function safe(){state.markIntakeBoundary(id,READINESS.UNAVAILABLE,detail);}if(deadlineReached) safe.call(null);'), []);
  assert.deepEqual(offendersFor('const helpers={outcome:function(){return READINESS.GAP;}};if(deadlineReached){helpers.outcome();return READINESS.UNAVAILABLE;}'), []);
});
