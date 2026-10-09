'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { findDeadlineGapOffenders, readSourceInventory } = require('./intake-recovery-analysis.cjs');

test('deadline policy inventory requires the complete gap member value', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-gap-member.js',
      source: 'if (deadlineReached) return READINESS.GAP;'
    },
    {
      relative: 'discord/deadline-gap-member-length.js',
      source: 'if (deadlineReached) return READINESS.GAP.length;'
    },
    {
      relative: 'discord/deadline-gap-member-uppercase.js',
      source: 'if (deadlineReached) return READINESS.GAP.toUpperCase();'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-gap-member.js:1']);
});

test('deadline policy inventory waits for local gap outcomes to escape', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-local-gap-overwritten.js',
      source: 'if (deadlineReached) { let result = READINESS.GAP; result = READINESS.UNAVAILABLE; return result; }'
    },
    {
      relative: 'discord/deadline-local-gap-unused.js',
      source: 'if (deadlineReached) { const result = READINESS.GAP; }'
    },
    {
      relative: 'discord/deadline-local-gap-returned.js',
      source: 'if (deadlineReached) { const result = READINESS.GAP; return result; }'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-local-gap-returned.js:1']);
});

test('deadline policy inventory maps local boundary state arguments', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/thread-enrollment.ts',
    source: [
      'function boundary(state, detail, source) { persist(state, detail, source); }',
      'if (deadlineReached) boundary(THREAD_STATES.GAP, detail, source);'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['discord/thread-enrollment.ts:2']);
});

test('deadline policy inventory recognizes optional boundary writer calls', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/optional-boundary-writer.js',
    source: 'if (deadlineReached) this.recordBoundary?.(binding, null, READINESS.GAP, detail);'
  }]);
  assert.deepEqual(offenders, ['discord/optional-boundary-writer.js:1']);
});

test('deadline policy inventory unwraps awaited gap outcomes', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/deadline-awaited-gap.js',
    source: 'if (deadlineReached) return await Promise.resolve(READINESS.GAP);'
  }]);
  assert.deepEqual(offenders, ['discord/deadline-awaited-gap.js:1']);
});

test('deadline policy inventory reads only effective identity-wrapper arguments', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-promise-resolve-ignored-gap.js',
      source: 'if (deadlineReached) return Promise.resolve(READINESS.UNAVAILABLE, READINESS.GAP);'
    },
    {
      relative: 'discord/deadline-object-freeze-ignored-gap.js',
      source: 'if (deadlineReached) return Object.freeze({ readiness: READINESS.UNAVAILABLE }, READINESS.GAP);'
    }
  ]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory recognizes optional-chain gap constants', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-optional-chain-gap.js',
      source: "const READINESS = { GAP: 'gap', UNAVAILABLE: 'unavailable' }; if (deadlineReached) return READINESS?.GAP;"
    },
    {
      relative: 'discord/deadline-optional-chain-unavailable.js',
      source: "const READINESS = { GAP: 'gap', UNAVAILABLE: 'unavailable' }; if (deadlineReached) return READINESS?.UNAVAILABLE;"
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-optional-chain-gap.js:1']);
});

test('deadline policy inventory resolves statically indexed outcome arrays', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-inline-indexed-array-gap.js',
      source: 'if (deadlineReached) return [READINESS.UNAVAILABLE, READINESS.GAP][1];'
    },
    {
      relative: 'discord/deadline-inline-indexed-array-unavailable.js',
      source: 'if (deadlineReached) return [READINESS.GAP, READINESS.UNAVAILABLE][1];'
    },
    {
      relative: 'discord/deadline-indexed-array-gap.js',
      source: 'const outcomes = [READINESS.UNAVAILABLE, READINESS.GAP]; if (deadlineReached) return outcomes[1];'
    },
    {
      relative: 'discord/deadline-indexed-array-unavailable.js',
      source: 'const outcomes = [READINESS.GAP, READINESS.UNAVAILABLE]; if (deadlineReached) return outcomes[1];'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/deadline-inline-indexed-array-gap.js:1',
    'discord/deadline-indexed-array-gap.js:1'
  ]);
});

test('deadline policy inventory recognizes static computed outcome keys', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/deadline-computed-outcome-key.js',
    source: "if (deadlineReached) return { ['state']: READINESS.GAP };"
  }]);
  assert.deepEqual(offenders, ['discord/deadline-computed-outcome-key.js:1']);
});

test('deadline policy inventory resolves named object spreads in outcomes', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/deadline-named-object-spread.js',
    source: [
      'const gap = { state: READINESS.GAP };',
      'const safe = { state: READINESS.UNAVAILABLE };',
      'if (deadlineReached) return { ...gap };',
      'if (deadlineReached) return { state: READINESS.GAP, ...safe };',
      'if (deadlineReached) return { ...gap, state: READINESS.UNAVAILABLE };',
      'if (deadlineReached) return { ...safe, state: READINESS.GAP };'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, [
    'discord/deadline-named-object-spread.js:3',
    'discord/deadline-named-object-spread.js:6'
  ]);
});

test('deadline policy inventory recognizes boundary writers invoked through call', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/deadline-call-boundary-writer.js',
    source: 'if (deadlineReached) state.markIntakeBoundary.call(state, id, READINESS.GAP, detail);'
  }]);
  assert.deepEqual(offenders, ['discord/deadline-call-boundary-writer.js:1']);
});

test('deadline policy inventory resolves named arrays passed to boundary writer apply', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-apply-named-array-gap.js',
      source: [
        'const args = [id, READINESS.GAP, detail];',
        'if (deadlineReached) state.markIntakeBoundary.apply(state, args);'
      ].join('\n')
    },
    {
      relative: 'discord/deadline-apply-named-array-safe.js',
      source: [
        'const args = [id, READINESS.UNAVAILABLE, detail];',
        'if (deadlineReached) state.markIntakeBoundary.apply(state, args);'
      ].join('\n')
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-apply-named-array-gap.js:2']);
});

test('deadline policy inventory resolves pre-bound and partially applied boundary writers', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-bound-writer-gap.js',
      source: [
        'const persist = state.markIntakeBoundary.bind(state, id, READINESS.GAP, detail);',
        'if (deadlineReached) persist();'
      ].join('\n')
    },
    {
      relative: 'discord/deadline-partially-bound-writer-gap.js',
      source: [
        'const persist = state.markIntakeBoundary.bind(state, id);',
        'if (deadlineReached) persist(READINESS.GAP, detail);'
      ].join('\n')
    },
    {
      relative: 'discord/deadline-bound-writer-safe.js',
      source: [
        'const persist = state.markIntakeBoundary.bind(state, id, READINESS.UNAVAILABLE, detail);',
        'if (deadlineReached) persist();'
      ].join('\n')
    },
    {
      relative: 'discord/deadline-partially-bound-writer-safe.js',
      source: [
        'const persist = state.markIntakeBoundary.bind(state, id);',
        'if (deadlineReached) persist(READINESS.UNAVAILABLE, READINESS.GAP);'
      ].join('\n')
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/deadline-bound-writer-gap.js:2',
    'discord/deadline-partially-bound-writer-gap.js:2'
  ]);
});

test('deadline policy inventory resolves parenthesized object-member outcomes', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-parenthesized-object-gap.js',
      source: 'if (deadlineReached) return ({ state: READINESS.GAP }).state;'
    },
    {
      relative: 'discord/deadline-parenthesized-object-safe.js',
      source: 'if (deadlineReached) return ({ state: READINESS.UNAVAILABLE }).state;'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-parenthesized-object-gap.js:1']);
});

test('deadline policy inventory recognizes boundary writers invoked through apply', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/deadline-apply-boundary-writer.js',
    source: 'if (deadlineReached) state.markIntakeBoundary.apply(state, [id, READINESS.GAP, detail]);'
  }]);
  assert.deepEqual(offenders, ['discord/deadline-apply-boundary-writer.js:1']);
});

test('deadline policy inventory inspects braceless immediately invoked functions', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-braceless-iife.js',
      source: 'if (deadlineReached) (() => recordBoundary(binding, null, READINESS.GAP, detail))();'
    },
    {
      relative: 'discord/deadline-braceless-iife-safe.js',
      source: 'if (deadlineReached) (() => recordBoundary(binding, null, READINESS.UNAVAILABLE, detail))();'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-braceless-iife.js:1']);
});

test('deadline policy inventory recognizes computed boundary writers', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-computed-writer.js',
      source: "if (deadlineReached) state['markIntakeBoundary'](id, READINESS.GAP, detail);"
    },
    {
      relative: 'discord/deadline-template-writer.js',
      source: 'if (deadlineReached) state[`markIntakeBoundary`](id, READINESS.GAP, detail);'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/deadline-computed-writer.js:1',
    'discord/deadline-template-writer.js:1'
  ]);
});

test('deadline policy inventory recognizes parenthesized operands in both comparison directions', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-parenthesized-direct-gap.js',
      source: 'if (Date.now() >= (deadline)) return READINESS.GAP;'
    },
    {
      relative: 'discord/deadline-parenthesized-reverse-gap.js',
      source: 'if ((deadline) <= Date.now()) return READINESS.GAP;'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/deadline-parenthesized-direct-gap.js:1',
    'discord/deadline-parenthesized-reverse-gap.js:1'
  ]);
});

test('deadline policy inventory ignores non-mutating boundary-shaped calls', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/readiness-predicate.js',
    source: 'if (deadlineReached) { assertReadiness(binding, READINESS.GAP); return READINESS.UNAVAILABLE; }'
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory ignores passive deadline metadata and types', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-metadata.js',
      source: 'const x = { deadlineReached: false, state: READINESS.GAP };'
    },
    {
      relative: 'discord/deadline-metadata.ts',
      source: "type RecoveryMeta = { deadlineReached: boolean; state: 'gap' };"
    }
  ]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory ignores gap constants used as predicate inputs', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/readiness-predicate.js',
    source: 'if (deadlineReached) return allowed.includes(READINESS.GAP);'
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory ignores gap returns declared in class methods', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-class-method.js',
    source: [
      'if (deadlineReached) {',
      '  class Policy {',
      '    constructor() { return READINESS.GAP; }',
      '    fallback() { return READINESS.GAP; }',
      '  }',
      '  return READINESS.UNAVAILABLE;',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory catches object-shaped gap decisions', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/inbound-recovery.js',
    source: "if (Date.now() >= deadline) return { ready: false, state: 'gap', detail: 'history unavailable' };"
  }]);
  assert.deepEqual(offenders, ['discord/inbound-recovery.js:1']);
});

test('deadline policy inventory inspects statically analyzable object spreads', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-spread-gap.js',
      source: 'if (deadlineReached) return { ...{ state: READINESS.GAP } };'
    },
    {
      relative: 'discord/deadline-spread-ready.js',
      source: 'if (deadlineReached) return { ...{ state: READINESS.READY } };'
    },
    {
      relative: 'discord/deadline-spread-gap-overridden.js',
      source: 'if (deadlineReached) return { ...{ state: READINESS.GAP }, state: READINESS.UNAVAILABLE };'
    },
    {
      relative: 'discord/deadline-spread-gap-overrides.js',
      source: 'if (deadlineReached) return { ...{ state: READINESS.UNAVAILABLE }, state: READINESS.GAP };'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/deadline-spread-gap.js:1',
    'discord/deadline-spread-gap-overrides.js:1'
  ]);
});

test('deadline policy inventory follows deadline throws into local catch handlers', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/deadline-caught-gap.js',
    source: 'function readiness(deadlineReached) { try { if (deadlineReached) throw new Error("expired"); } catch { return READINESS.GAP; } }'
  }]);
  assert.deepEqual(offenders, ['discord/deadline-caught-gap.js:1']);
});

test('deadline policy inventory follows deadline returns into finally handlers', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/deadline-finally-gap.js',
    source: 'function readiness(deadlineReached) { try { if (deadlineReached) return; } finally { state.markIntakeBoundary(id, READINESS.GAP, detail); } }'
  }]);
  assert.deepEqual(offenders, ['discord/deadline-finally-gap.js:1']);
});

test('deadline policy inventory inspects Object.assign outcome mutations', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-object-assign-outcome.js',
      source: 'if (deadlineReached) { Object.assign(result, { state: READINESS.GAP }); return result; }'
    },
    {
      relative: 'discord/deadline-object-assign-overridden-gap.js',
      source: 'if (deadlineReached) { Object.assign(result, { state: READINESS.GAP }, { state: READINESS.UNAVAILABLE }); return result; }'
    },
    {
      relative: 'discord/deadline-object-assign-later-gap.js',
      source: 'if (deadlineReached) { Object.assign(result, { state: READINESS.UNAVAILABLE }, { state: READINESS.GAP }); return result; }'
    },
    {
      relative: 'discord/deadline-object-assign-unrelated-later-source.js',
      source: 'if (deadlineReached) { Object.assign(result, { state: READINESS.GAP }, { detail: "expired" }); return result; }'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/deadline-object-assign-outcome.js:1',
    'discord/deadline-object-assign-later-gap.js:1',
    'discord/deadline-object-assign-unrelated-later-source.js:1'
  ]);
});

test('deadline policy inventory recognizes computed gap constants', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/computed-return.js',
      source: "if (deadlineReached) return READINESS['GAP'];"
    },
    {
      relative: 'discord/computed-template-return.js',
      source: 'if (deadlineReached) return THREAD_STATES[`GAP`];'
    },
    {
      relative: 'discord/computed-object-return.js',
      source: "if (deadlineReached) return { state: READINESS['GAP'] };"
    },
    {
      relative: 'discord/computed-writer.js',
      source: "if (deadlineReached) state.markIntakeBoundary(id, READINESS['GAP'], detail);"
    },
    {
      relative: 'discord/computed-template-writer.js',
      source: 'if (deadlineReached) state.markIntakeBoundary(id, THREAD_STATES[`GAP`], detail);'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/computed-return.js:1',
    'discord/computed-template-return.js:1',
    'discord/computed-object-return.js:1',
    'discord/computed-writer.js:1',
    'discord/computed-template-writer.js:1'
  ]);
});

test('deadline policy inventory scans complete outcomes and ignores unrelated gaps', () => {
  const entries = [
    {
      relative: 'discord/multiline-owner.js',
      source: [
        'if (deadlineReached) {',
        '  return {',
        '    ready: false,',
        "    detail: 'expired',",
        "    state: 'gap'",
        '  };',
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/multiline-assignment.js',
      source: [
        'const state = deadlineReached',
        '  ? READINESS.GAP',
        '  : READINESS.READY;'
      ].join('\n')
    },
    {
      relative: 'discord/member-assignment.js',
      source: 'if (deadlineReached) result.state = READINESS.GAP;'
    },
    {
      relative: 'discord/computed-member-assignment.js',
      source: "if (deadlineReached) { result['state'] = READINESS.GAP; return result; }"
    },
    {
      relative: 'discord/computed-template-member-assignment.js',
      source: 'if (deadlineReached) { result[`state`] = READINESS.GAP; return result; }'
    },
    {
      relative: 'discord/braced-member-assignment.js',
      source: [
        'if (deadlineReached) {',
        '  result.state = READINESS.GAP;',
        '  return result;',
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/parenthesized-return.js',
      source: 'if (deadlineReached) return (READINESS.GAP);'
    },
    {
      relative: 'discord/wrapped-return.js',
      source: 'if (deadlineReached) return Promise.resolve(READINESS.GAP);'
    },
    {
      relative: 'discord/parenthesized-object-return.js',
      source: "if (deadlineReached) return ({ state: 'gap' });"
    },
    {
      relative: 'discord/unavailable-owner.js',
      source: [
        'if (deadlineReached) {',
        "  return { ready: false, state: 'unavailable' };",
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/reversed-timestamp-deadline.js',
      source: 'if (deadline <= Date.now()) return READINESS.GAP;'
    },
    {
      relative: 'discord/reversed-strict-timestamp-deadline.js',
      source: 'if (deadline < Date.now()) return READINESS.GAP;'
    },
    {
      relative: 'discord/strict-timestamp-deadline.js',
      source: 'if (Date.now() > deadline) return READINESS.GAP;'
    },
    {
      relative: 'discord/retry-owner.js',
      source: [
        'if (deadlineReached) {',
        "  return { ready: false, state: 'retry' };",
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/unrelated-gap.js',
      source: [
        'if (deadlineReached) {',
        "  return { ready: false, state: 'retry' };",
        '}',
        "const history = { state: 'gap' };"
      ].join('\n')
    },
    {
      relative: 'discord/nested-gap.js',
      source: [
        'if (deadlineReached) {',
        '  if (shouldRetry) {',
        "    return { state: 'gap' };",
        '  }',
        "  return { state: 'retry' };",
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/nested-object-gap.js',
      source: [
        'if (deadlineReached) {',
        "  return { detail: { state: 'gap' } };",
        '}'
      ].join('\n')
    }
  ];
  assert.deepEqual(findDeadlineGapOffenders(entries), [
    'discord/multiline-owner.js:1',
    'discord/multiline-assignment.js:1',
    'discord/member-assignment.js:1',
    'discord/computed-member-assignment.js:1',
    'discord/computed-template-member-assignment.js:1',
    'discord/braced-member-assignment.js:1',
    'discord/parenthesized-return.js:1',
    'discord/wrapped-return.js:1',
    'discord/parenthesized-object-return.js:1',
    'discord/reversed-timestamp-deadline.js:1',
    'discord/reversed-strict-timestamp-deadline.js:1',
    'discord/strict-timestamp-deadline.js:1',
    'discord/nested-gap.js:1'
  ]);
});

test('deadline policy inventory binds lexical and persistence controls to the deadline branch', () => {
  const entries = [
    {
      relative: 'discord/braceless-gap.js',
      source: [
        'if (deadlineReached) return READINESS.GAP;',
        'function later() { return READINESS.UNAVAILABLE; }'
      ].join('\n')
    },
    {
      relative: 'discord/braceless-safe.js',
      source: [
        'if (deadlineReached) return READINESS.UNAVAILABLE;',
        'function later() { return READINESS.GAP; }'
      ].join('\n')
    },
    {
      relative: 'discord/braceless-safe-asi.js',
      source: [
        'if (deadlineReached) return READINESS.UNAVAILABLE',
        'function later() { return READINESS.GAP; }'
      ].join('\n')
    },
    {
      relative: 'discord/comment-brace.js',
      source: [
        'if (deadlineReached) { // }',
        "  return 'gap';",
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/comment-decoy.js',
      source: [
        "if (deadlineReached) return READINESS.UNAVAILABLE; // state: 'gap'",
        'const regex = /return gap/;'
      ].join('\n')
    },
    {
      relative: 'discord/regex-brace.js',
      source: [
        'if (deadlineReached) {',
        '  const regex = /}/;',
        '  return READINESS.GAP;',
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/template-return.js',
      source: 'if (deadlineReached) return `gap`;'
    },
    {
      relative: 'discord/template-property.js',
      source: 'if (deadlineReached) return { state: `gap` };'
    },
    {
      relative: 'discord/template-decoy.js',
      source: 'if (deadlineReached) return { detail: `state: gap` };'
    },
    {
      relative: 'discord/persistence-gap.js',
      source: 'if (deadlineReached) state.markIntakeBoundary(id, READINESS.GAP, detail);'
    },
    {
      relative: 'discord/thread-boundary-gap.js',
      source: 'if (deadlineReached) state.markThreadBoundary(id, THREAD_STATES.GAP, detail);'
    },
    {
      relative: 'discord/owned-boundary-gap.js',
      source: 'if (deadlineReached) state.recordBoundary(binding, null, READINESS.GAP, detail);'
    },
    {
      relative: 'discord/owned-boundary-owned-gap.js',
      source: 'if (deadlineReached) state.recordOwnedBoundary(binding, null, READINESS.GAP, detail);'
    },
    {
      relative: 'discord/persistence-safe.js',
      source: "if (deadlineReached) state.markIntakeBoundary(id, READINESS.UNAVAILABLE, 'gap');"
    }
  ];
  assert.deepEqual(findDeadlineGapOffenders(entries), [
    'discord/braceless-gap.js:1',
    'discord/comment-brace.js:1',
    'discord/regex-brace.js:1',
    'discord/template-return.js:1',
    'discord/template-property.js:1',
    'discord/persistence-gap.js:1',
    'discord/thread-boundary-gap.js:1',
    'discord/owned-boundary-gap.js:1',
    'discord/owned-boundary-owned-gap.js:1'
  ]);
});

test('deadline policy inventory catches new owners while allowing unavailable classifiers and ordinary deadlines', () => {
  const entries = [
    {
      relative: 'discord/new-owner.js',
      source: "const state = deadlineReached ? READINESS.GAP : READINESS.READY;"
    },
    {
      relative: 'discord/decoy-classifier.js',
      source: "function recoveryDeadlineClassifier(deadlineReached) { return deadlineReached ? READINESS.GAP : READINESS.READY; }"
    },
    {
      relative: 'discord/adjacent-classifier-call.js',
      source: "if (deadlineReached) { classifyRecoveryFailure(error); return READINESS.GAP; }"
    },
    {
      relative: 'discord/new-timestamp-owner.js',
      source: "if (Date.now() >= deadline) return READINESS.GAP;"
    },
    {
      relative: 'discord/new-string-timestamp-owner.js',
      source: "if (Date.now() >= deadline) return 'gap';"
    },
    {
      relative: 'discord/recovery-fetch.ts',
      source: "function classifyRecoveryFailure(deadlineReached) { return deadlineReached ? READINESS.UNAVAILABLE : READINESS.READY; }"
    },
    {
      relative: 'discord/ordinary-deadline.js',
      source: "if (deadlineReached) return RETRY;"
    },
    {
      relative: 'discord/ordinary-timestamp.js',
      source: "if (Date.now() >= deadline) return RETRY;"
    }
  ];
  assert.deepEqual(findDeadlineGapOffenders(entries), [
    'discord/new-owner.js:1',
    'discord/decoy-classifier.js:1',
    'discord/adjacent-classifier-call.js:1',
    'discord/new-timestamp-owner.js:1',
    'discord/new-string-timestamp-owner.js:1'
  ]);
});

test('deadline policy inventory inspects boundary writers in returned expressions', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/returned-boundary-writer.js',
    source: 'if (deadlineReached) return recordBoundary(binding, null, READINESS.GAP, detail);'
  }]);
  assert.deepEqual(offenders, ['discord/returned-boundary-writer.js:1']);
});

test('deadline policy inventory ignores unrelated enum GAP values', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/layout-gap.js',
    source: 'if (deadlineReached) return LAYOUT.GAP;'
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory expands static spread boundary writer arguments', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-spread-writer-gap.js',
      source: 'if (deadlineReached) state.markIntakeBoundary(...[id, READINESS.GAP, detail]);'
    },
    {
      relative: 'discord/deadline-spread-writer-safe.js',
      source: 'if (deadlineReached) state.markIntakeBoundary(...[id, READINESS.UNAVAILABLE, detail]);'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-spread-writer-gap.js:1']);
});

test('deadline policy inventory recognizes logical assignment outcome writes', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-nullish-assignment-gap.js',
      source: 'if (deadlineReached) { const result = {}; result.state ??= READINESS.GAP; return result; }'
    },
    {
      relative: 'discord/deadline-falsy-assignment-gap.js',
      source: 'if (deadlineReached) { const result = {}; result.state ||= READINESS.GAP; return result; }'
    },
    {
      relative: 'discord/deadline-nullish-assignment-safe.js',
      source: 'if (deadlineReached) { const result = {}; result.state ??= READINESS.UNAVAILABLE; return result; }'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/deadline-nullish-assignment-gap.js:1',
    'discord/deadline-falsy-assignment-gap.js:1'
  ]);
});

test('deadline policy inventory stops return statements at a line terminator', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-return-asi.js',
      source: 'if (deadlineReached) return\nREADINESS.GAP;'
    },
    {
      relative: 'discord/deadline-return-same-line.js',
      source: 'if (deadlineReached) return READINESS.GAP;'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-return-same-line.js:1']);
});

test('deadline policy inventory follows evaluated expiry outcomes', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: "mutation.js", source }]);
  assert.deepEqual(offendersFor("if (deadlineReached) setTimeout(() => READINESS.GAP, 0);"), []);
  assert.deepEqual(offendersFor("if (deadlineReached) return void READINESS.GAP;"), []);
  assert.deepEqual(offendersFor("if (deadlineReached) return typeof READINESS.GAP;"), []);
  assert.deepEqual(offendersFor("if (deadlineReached) return void READINESS.GAP, READINESS.GAP;"), ["mutation.js:1"]);
  assert.deepEqual(offendersFor("if (deadlineReached) cleanup(); if (!deadlineReached) return READINESS.GAP;"), []);
  assert.deepEqual(offendersFor("if (deadlineReached) setTimeout(() => { state.markIntakeBoundary(id, READINESS.GAP, detail); }, 0);"), ["mutation.js:1"]);
});

test('deadline policy inventory treats returned assignments as outcomes', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: 'mutation.js', source }]);
  assert.deepEqual(offendersFor('let next; if (deadlineReached) return next = READINESS.GAP;'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('let next; if (deadlineReached) return next = READINESS.READY;'), []);
  assert.deepEqual(offendersFor('let next; if (deadlineReached) next = READINESS.GAP;'), []);
});

test('deadline policy inventory expands named arrays in boundary writer calls', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: 'mutation.js', source }]);
  assert.deepEqual(offendersFor('const args = [id, READINESS.GAP, detail]; if (deadlineReached) state.markIntakeBoundary(...args);'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('const args = [id, READINESS.READY, detail]; if (deadlineReached) state.markIntakeBoundary(...args);'), []);
  assert.deepEqual(offendersFor('const args = [id, READINESS.GAP, detail]; args[1] = READINESS.READY; if (deadlineReached) state.markIntakeBoundary(...args);'), []);
});

test('deadline policy inventory resolves local return values passed to persistence writers', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: 'mutation.js', source }]);
  assert.deepEqual(offendersFor('const Promise={race:values=>values[0]};if(deadlineReached) state.markIntakeBoundary(id,Promise.race([READINESS.GAP]),detail);'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('const Promise={race:values=>values[0]};if(deadlineReached) state.markIntakeBoundary(id,Promise.race([READINESS.READY]),detail);'), []);
  assert.deepEqual(offendersFor('const Promise={async race(values){return values[0];}};if(deadlineReached) state.markIntakeBoundary(id,Promise.race([READINESS.GAP]),detail);'), []);
});

test('deadline policy inventory applies last-write and spread order to destructured outcomes', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: 'mutation.js', source }]);
  assert.deepEqual(offendersFor('function outcome({value}){return value;}if(deadlineReached)return outcome({value:READINESS.READY,value:READINESS.GAP});'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('function outcome({value}){return value;}if(deadlineReached)return outcome({value:READINESS.GAP,value:READINESS.READY});'), []);
  assert.deepEqual(offendersFor('function outcome({value}){return value;}if(deadlineReached)return outcome({value:READINESS.READY,...{value:READINESS.GAP}});'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('function outcome({value}){return value;}if(deadlineReached)return outcome({...{value:READINESS.GAP},value:READINESS.READY});'), []);
});

test('deadline policy inventory expands static spreads through calls and apply', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: 'mutation.js', source }]);
  assert.deepEqual(offendersFor('function outcome(value){return value;}if(deadlineReached)return outcome(...[READINESS.GAP]);'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('function outcome(value){return value;}if(deadlineReached)return outcome.apply(null,[...[],READINESS.GAP]);'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('const args=[READINESS.GAP];function outcome(value){return value;}if(deadlineReached)return outcome.apply(null,args);'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('function outcome([,value]){return value;}if(deadlineReached)return outcome(...[...[READINESS.READY,READINESS.READY],READINESS.GAP]);'), []);
  assert.deepEqual(offendersFor('function outcome(value){return value;}if(deadlineReached)return outcome(...[READINESS.READY]);'), []);
});

test('deadline policy inventory applies nested and positional defaults for undefined values', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: 'mutation.js', source }]);
  assert.deepEqual(offendersFor('function outcome({value=READINESS.GAP}){return value;}if(deadlineReached)return outcome({});'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('function outcome({value=READINESS.GAP}){return value;}if(deadlineReached)return outcome({value:READINESS.READY});'), []);
  assert.deepEqual(offendersFor('function outcome([value=READINESS.GAP]){return value;}if(deadlineReached)return outcome([]);'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('function outcome(value=READINESS.GAP){return value;}if(deadlineReached)return outcome(undefined);'), ['mutation.js:1']);
});
