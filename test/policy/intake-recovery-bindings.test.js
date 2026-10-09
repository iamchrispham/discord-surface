'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { findDeadlineGapOffenders, readSourceInventory } = require('./intake-recovery-analysis.cjs');

test('deadline policy inventory resolves enum namespace aliases without accepting shadowed objects', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/readiness-namespace-alias-gap.js',
      source: 'const states = READINESS; if (deadlineReached) return states.GAP;'
    },
    {
      relative: 'discord/thread-states-namespace-alias-gap.js',
      source: 'const states = THREAD_STATES; if (deadlineReached) return states.GAP;'
    },
    {
      relative: 'discord/readiness-namespace-alias-unavailable.js',
      source: 'const states = READINESS; if (deadlineReached) return states.UNAVAILABLE;'
    },
    {
      relative: 'discord/ordinary-namespace-gap.js',
      source: "const states = { GAP: 'ready' }; if (deadlineReached) return states.GAP;"
    },
    {
      relative: 'discord/shadowed-namespace-gap.js',
      source: 'const states = READINESS; function decide(states) { if (deadlineReached) return states.GAP; }'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/readiness-namespace-alias-gap.js:1',
    'discord/thread-states-namespace-alias-gap.js:1'
  ]);
});

test('deadline policy inventory scopes object methods before resolving deadline aliases', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/deadline-object-method-shadow.js',
    source: 'function readiness(deadlineReached) { const expired = deadlineReached; if (!deadlineReached) return READINESS.READY; return { classify(expired) { if (expired) return READINESS.GAP; } }; }'
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory recognizes renamed destructured boundary writers', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-destructured-boundary-writer.js',
      source: 'const { markIntakeBoundary: mark } = state; if (deadlineReached) mark.call(state, id, READINESS.GAP, detail);'
    },
    {
      relative: 'discord/deadline-destructured-boundary-writer-safe.js',
      source: 'const { markIntakeBoundary: mark } = state; if (deadlineReached) mark.call(state, id, READINESS.UNAVAILABLE, detail);'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-destructured-boundary-writer.js:1']);
});

test('deadline policy inventory honors alias polarity when inspecting loop paths', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-negated-loop-expiry-gap.js',
      source: 'async function readiness(deadlineReached) { const within = !deadlineReached; while (within) await poll(); return READINESS.GAP; }'
    },
    {
      relative: 'discord/deadline-negated-loop-body-gap.js',
      source: 'function readiness(deadlineReached) { const within = !deadlineReached; while (within) return READINESS.GAP; return READINESS.UNAVAILABLE; }'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-negated-loop-expiry-gap.js:1']);
});

test('deadline policy inventory honors alias polarity when selecting ternary paths', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-negated-ternary-expiry-gap.js',
      source: 'function readiness(deadlineReached) { const within = !deadlineReached; return within ? READINESS.READY : READINESS.GAP; }'
    },
    {
      relative: 'discord/deadline-negated-ternary-expiry-ready.js',
      source: 'function readiness(deadlineReached) { const within = !deadlineReached; return within ? READINESS.GAP : READINESS.READY; }'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-negated-ternary-expiry-gap.js:1']);
});

test('deadline policy inventory follows remaining-budget aliases', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/deadline-remaining-gap.js',
    source: 'function readiness(deadline) { const remaining = deadline - Date.now(); if (remaining <= 0) return READINESS.GAP; }'
  }]);
  assert.deepEqual(offenders, ['discord/deadline-remaining-gap.js:1']);
});

test('deadline policy inventory follows aliases assigned after declaration', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/deadline-alias-mutation.js',
    source: [
      'function readiness(deadline) {',
      '  let expired = false;',
      '  expired = Date.now() >= deadline;',
      '  if (expired) return READINESS.GAP;',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['discord/deadline-alias-mutation.js:4']);
});

test('deadline policy inventory resolves typed deadline aliases', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/deadline-typed-alias.ts',
    source: [
      'const expired: boolean = deadlineReached;',
      'if (expired) return READINESS.GAP;'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['discord/deadline-typed-alias.ts:2']);
});

test('deadline policy inventory follows chained deadline aliases', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/deadline-alias-chain.js',
    source: [
      'function readiness() {',
      '  const expired = deadlineReached;',
      '  const timedOut = expired;',
      '  if (timedOut) return READINESS.GAP;',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['discord/deadline-alias-chain.js:4']);
});

test('deadline policy inventory propagates negation through chained aliases', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-double-negated-alias.js',
      source: 'const within = !deadlineReached; const expired = !within; if (expired) return READINESS.GAP;'
    },
    {
      relative: 'discord/deadline-negated-alias-safe.js',
      source: 'const within = !deadlineReached; const expired = !within; if (!expired) return READINESS.GAP;'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-double-negated-alias.js:1']);
});

test('deadline policy inventory counts all negations in direct aliases', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-even-negated-alias.js',
      source: 'const expired = !!deadlineReached; if (expired) return READINESS.GAP;'
    },
    {
      relative: 'discord/deadline-odd-negated-alias.js',
      source: 'const active = !deadlineReached; if (active) return READINESS.GAP;'
    },
    {
      relative: 'discord/deadline-triple-negated-alias.js',
      source: 'const active = !!!deadlineReached; if (active) return READINESS.GAP;'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-even-negated-alias.js:1']);
});

test('deadline policy inventory preserves boolean-comparison alias polarity', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-boolean-comparison-expiry-gap.js',
      source: 'const within = deadlineReached === false; if (!within) return READINESS.GAP;'
    },
    {
      relative: 'discord/deadline-boolean-comparison-before-expiry-gap.js',
      source: 'const within = deadlineReached === false; if (within) return READINESS.GAP;'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-boolean-comparison-expiry-gap.js:1']);
});

test('deadline policy inventory resolves destructured enum values', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-gap-destructured-enum.js',
    source: 'const { GAP: nextState } = READINESS; if (deadlineReached) return nextState;'
  }]);
  assert.deepEqual(offenders, ['deadline-gap-destructured-enum.js:1']);
});

test('deadline policy inventory tracks branch-local destructured gap aliases', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/deadline-branch-destructured-gap.js',
    source: 'if (deadlineReached) { const { GAP: state } = READINESS; return { state }; }'
  }]);
  assert.deepEqual(offenders, ['discord/deadline-branch-destructured-gap.js:1']);
});

test('deadline policy inventory registers destructured local shadow bindings', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/destructured-shadow.js',
    source: [
      'function readiness(flags) {',
      '  const expired = deadlineReached;',
      '  {',
      '    const { expired } = flags;',
      '    if (expired) return READINESS.GAP;',
      '  }',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline aliases remain shadowed by hoisted var declarations', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/hoisted-var-shadow.js',
    source: [
      'const expired = deadlineReached;',
      'function nested() {',
      '  if (expired) return READINESS.GAP;',
      '  var expired = false;',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline aliases remain shadowed by simple and destructured catch bindings', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'deadline-alias-catch-shadow.js',
      source: 'const expired = deadlineReached; try {} catch (expired) { if (expired) return READINESS.GAP; }'
    },
    {
      relative: 'deadline-alias-catch-destructured-shadow.js',
      source: 'const expired = deadlineReached; try {} catch ({ expired }) { if (expired) return READINESS.GAP; }'
    }
  ]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory follows inequality polarity', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'strict-inequality.js',
      source: 'if (kind !== CODEX_VALIDATION_KINDS.DEADLINE) return READINESS.READY; else return READINESS.GAP;'
    },
    {
      relative: 'loose-inequality.js',
      source: 'if (kind != CODEX_VALIDATION_KINDS.DEADLINE) return READINESS.READY; else return READINESS.GAP;'
    }
  ]);
  assert.deepEqual(offenders, ['strict-inequality.js:1', 'loose-inequality.js:1']);
});

test('deadline policy inventory follows explicit boolean deadline polarity', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'explicit-false-gap.js',
      source: 'if (deadlineReached === false) return READINESS.READY; else return READINESS.GAP;'
    },
    {
      relative: 'explicit-false-consequent-gap.js',
      source: 'if (deadlineReached === false) return READINESS.GAP; else return READINESS.READY;'
    },
    {
      relative: 'explicit-true-gap.js',
      source: 'if (deadlineReached !== true) return READINESS.READY; else return READINESS.GAP;'
    },
    {
      relative: 'explicit-true-consequent-gap.js',
      source: 'if (deadlineReached !== true) return READINESS.GAP; else return READINESS.READY;'
    }
  ]);
  assert.deepEqual(offenders, ['explicit-false-gap.js:1', 'explicit-true-gap.js:1']);
});

test('deadline aliases remain scoped to their lexical declaration', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-alias-scope.js',
    source: [
      'function first() {',
      '  const expired = Date.now() >= deadline;',
      '  if (expired) return READINESS.GAP;',
      '}',
      'function second(expired) {',
      '  if (expired) return READINESS.GAP;',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['deadline-alias-scope.js:3']);
});

test('deadline policy inventory follows gap aliases declared before the branch', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-gap-alias.js',
    source: [
      'const nextState = READINESS.GAP;',
      'if (deadlineReached) return nextState;'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['deadline-gap-alias.js:2']);
});

test('deadline policy inventory follows gap aliases reassigned before the branch', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-gap-alias-reassignment.js',
    source: [
      'function readiness() {',
      '  let next = READINESS.READY;',
      '  next = READINESS.GAP;',
      '  if (deadlineReached) return next;',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['deadline-gap-alias-reassignment.js:4']);
});

test('deadline policy inventory resolves the declarator containing the trigger', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-multi-declarator.js',
    source: [
      'function readiness() {',
      '  const ignored = false, expired = deadlineReached;',
      '  if (expired) return READINESS.GAP;',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['deadline-multi-declarator.js:3']);
});

test('deadline policy inventory respects nested alias shadowing', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-alias-shadow.js',
    source: [
      'function outer() {',
      '  const expired = Date.now() >= deadline;',
      '  function inner(expired) {',
      '    if (expired) return READINESS.GAP;',
      '  }',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline aliases remain visible across blocks when declared with var', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'deadline-var-alias.js',
      source: [
        'function recover() {',
        '  {',
        '    var expired = deadlineReached;',
        '  }',
        '  if (expired) return READINESS.GAP;',
        '}'
      ].join('\n')
    },
    {
      relative: 'deadline-var-alias-through-outcome.js',
      source: [
        'function recover() {',
        '  {',
        '    var expired = deadlineReached;',
        '    var nextState = READINESS.GAP;',
        '  }',
        '  if (expired) return nextState;',
        '}'
      ].join('\n')
    }
  ]);
  assert.deepEqual(offenders, [
    'deadline-var-alias.js:5',
    'deadline-var-alias-through-outcome.js:6'
  ]);
});

test('deadline aliases remain shadowed by destructured parameter bindings', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-alias-destructured-parameter.js',
    source: [
      'const expired = deadlineReached;',
      'function nested({ expired } = createDefaults()) {',
      '  if (expired) return READINESS.GAP;',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline aliases remain shadowed by concise arrow parameters', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-alias-concise-arrow.js',
    source: [
      'const expired = Date.now() >= deadline;',
      'const choose = expired => expired ? READINESS.GAP : READINESS.READY;'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory follows aliases and selected control arms', () => {
  const entries = [
    {
      relative: 'discord/parenthesized-object-property.js',
      source: 'if (deadlineReached) return { state: (READINESS.GAP) };'
    },
    {
      relative: 'discord/concise-arrow-gap.js',
      source: 'const decide = deadlineReached => deadlineReached ? READINESS.GAP : READINESS.READY;'
    },
    {
      relative: 'discord/aliased-classifier-gap.js',
      source: 'const nextState = deadlineReached ? READINESS.GAP : READINESS.READY;'
    },
    {
      relative: 'discord/aliased-writer-gap.js',
      source: 'if (deadlineReached) { const nextState = READINESS.GAP; recordBoundary(binding, null, nextState, detail); }'
    },
    {
      relative: 'discord/negated-deadline-gap.js',
      source: 'if (!deadlineReached) return READINESS.READY; else return READINESS.GAP;'
    },
    {
      relative: 'discord/aliased-deadline-gap.js',
      source: 'const expired = Date.now() >= deadline; if (expired) return READINESS.GAP;'
    },
    {
      relative: 'discord/comparison-gap-negative.js',
      source: 'if (deadlineReached) return current === READINESS.GAP ? READINESS.UNAVAILABLE : READINESS.PENDING;'
    },
    {
      relative: 'discord/non-deadline-else-negative.js',
      source: 'if (deadlineReached) return READINESS.UNAVAILABLE; else return READINESS.GAP;'
    },
    {
      relative: 'discord/switch-arm-negative.js',
      source: 'switch (kind) { case DEADLINE: return READINESS.UNAVAILABLE; default: return READINESS.GAP; }'
    },
    {
      relative: 'discord/normal-ternary-negative.js',
      source: 'function decide() { return Date.now() >= deadline ? READINESS.UNAVAILABLE : READINESS.GAP; }'
    },
    {
      relative: 'discord/parameter-ternary-negative.js',
      source: 'function decide(deadlineReached) { return deadlineReached ? READINESS.UNAVAILABLE : READINESS.GAP; }'
    }
  ];
  assert.deepEqual(findDeadlineGapOffenders(entries), [
    'discord/parenthesized-object-property.js:1',
    'discord/concise-arrow-gap.js:1',
    'discord/aliased-classifier-gap.js:1',
    'discord/aliased-writer-gap.js:1',
    'discord/negated-deadline-gap.js:1',
    'discord/aliased-deadline-gap.js:1'
  ]);
});

test('gap aliases do not cross a shadowing parameter binding', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/parameter-shadowed-gap-alias.js',
    source: 'let next = READINESS.GAP; function audit(next) { if (deadlineReached) return next; }'
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory applies alias polarity to short-circuit decisions', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-negated-alias-or-gap.js',
      source: 'function readiness(deadlineReached) { const within = !deadlineReached; within || state.markIntakeBoundary(id, READINESS.GAP, detail); }'
    },
    {
      relative: 'discord/deadline-negated-alias-and-safe.js',
      source: 'function readiness(deadlineReached) { const within = !deadlineReached; within && state.markIntakeBoundary(id, READINESS.GAP, detail); }'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-negated-alias-or-gap.js:1']);
});

test('deadline policy inventory resolves named patches, destructured triggers, and identity wrappers', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: "mutation.js", source }]);
  assert.deepEqual(offendersFor("const patch = { state: READINESS.GAP }; if (deadlineReached) return Object.assign(result, patch);"), ["mutation.js:1"]);
  assert.deepEqual(offendersFor("const { deadlineReached: expired } = status; if (expired) return READINESS.GAP;"), ["mutation.js:1"]);
  assert.deepEqual(offendersFor("if (deadlineReached) return Object.freeze({ state: READINESS.GAP });"), ["mutation.js:1"]);
});

test('deadline policy inventory resolves indexed array destructuring aliases', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: 'mutation.js', source }]);
  assert.deepEqual(offendersFor('const [, result] = [READINESS.READY, READINESS.GAP]; if (deadlineReached) return result;'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('const [, result] = [READINESS.GAP, READINESS.READY]; if (deadlineReached) return result;'), []);
});

test('deadline policy inventory recognizes unshadowed primitive String outcomes', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: 'mutation.js', source }]);
  assert.deepEqual(offendersFor('if (deadlineReached) return String(READINESS.GAP);'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('if (deadlineReached) return String(READINESS.READY);'), []);
  assert.deepEqual(offendersFor('function outcome(String) { if (deadlineReached) return String(READINESS.GAP); } if (deadlineReached) return outcome(value => READINESS.READY);'), []);
  assert.deepEqual(offendersFor('const String = value => READINESS.READY; if (deadlineReached) return String(READINESS.GAP);'), []);
  assert.deepEqual(offendersFor('if (deadlineReached) return new String(READINESS.GAP);'), []);
});
