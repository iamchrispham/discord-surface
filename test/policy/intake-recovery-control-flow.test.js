'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { findDeadlineGapOffenders, readSourceInventory } = require('./intake-recovery-analysis.cjs');

test('deadline policy inventory selects statically determined conditional outcome arms', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-conditional-gap-unreachable.js',
      source: 'if (deadlineReached) return true ? READINESS.UNAVAILABLE : READINESS.GAP;'
    },
    {
      relative: 'discord/deadline-conditional-gap-selected.js',
      source: 'if (deadlineReached) return false ? READINESS.UNAVAILABLE : READINESS.GAP;'
    },
    {
      relative: 'discord/deadline-conditional-gap-reachable.js',
      source: 'if (deadlineReached) return shouldWait ? READINESS.UNAVAILABLE : READINESS.GAP;'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/deadline-conditional-gap-selected.js:1',
    'discord/deadline-conditional-gap-reachable.js:1'
  ]);
});

test('deadline policy inventory stops after unconditional abrupt completion', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-gap-after-return.js',
      source: 'if (deadlineReached) { return READINESS.UNAVAILABLE; return READINESS.GAP; }'
    },
    {
      relative: 'discord/deadline-gap-after-throw.js',
      source: 'if (deadlineReached) { throw new Error(); return READINESS.GAP; }'
    },
    {
      relative: 'discord/deadline-gap-on-reachable-alternate.js',
      source: 'if (deadlineReached) { if (shouldWait) return READINESS.UNAVAILABLE; return READINESS.GAP; }'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-gap-on-reachable-alternate.js:1']);
});

test('deadline policy inventory respects abrupt finally overrides of gap returns', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-finally-return-unavailable.js',
      source: 'function readiness(deadlineReached) { if (!deadlineReached) return READINESS.READY; try { return READINESS.GAP; } finally { return READINESS.UNAVAILABLE; } }'
    },
    {
      relative: 'discord/deadline-finally-throw.js',
      source: 'function readiness(deadlineReached) { if (!deadlineReached) return READINESS.READY; try { return READINESS.GAP; } finally { throw new Error(); } }'
    },
    {
      relative: 'discord/deadline-finally-conditional-return.js',
      source: 'function readiness(deadlineReached) { if (!deadlineReached) return READINESS.READY; try { return READINESS.GAP; } finally { if (preserve) return READINESS.UNAVAILABLE; } }'
    },
    {
      relative: 'discord/deadline-finally-gap.js',
      source: 'function readiness(deadlineReached) { if (!deadlineReached) return READINESS.READY; try { return READINESS.UNAVAILABLE; } finally { return READINESS.GAP; } }'
    },
    {
      relative: 'discord/deadline-finally-writer.js',
      source: 'function readiness(deadlineReached) { if (!deadlineReached) return READINESS.READY; try { return READINESS.GAP; } finally { state.markIntakeBoundary(id, READINESS.GAP, detail); return READINESS.UNAVAILABLE; } }'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/deadline-finally-conditional-return.js:1',
    'discord/deadline-finally-gap.js:1',
    'discord/deadline-finally-writer.js:1'
  ]);
});

test('deadline policy inventory scans fall-through after negated guards', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/deadline-negated-fallthrough.js',
    source: 'function readiness(deadlineReached) { if (!deadlineReached) return READINESS.READY; audit(); return READINESS.GAP; }'
  }]);
  assert.deepEqual(offenders, ['discord/deadline-negated-fallthrough.js:1']);
});

test('deadline policy inventory inspects deadline-controlled loops', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-while-gap.js',
      source: 'while (deadlineReached) return READINESS.GAP;'
    },
    {
      relative: 'discord/deadline-for-gap.js',
      source: 'for (let attempt = 0; deadlineReached; attempt += 1) return READINESS.GAP;'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/deadline-while-gap.js:1',
    'discord/deadline-for-gap.js:1'
  ]);
});

test('deadline policy inventory follows switch fall-through after nonempty arms', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/switch-fallthrough-gap.js',
    source: [
      'switch (kind) {',
      '  case CODEX_VALIDATION_KINDS.DEADLINE:',
      '    audit();',
      '  case RETRY:',
      '    return READINESS.GAP;',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['discord/switch-fallthrough-gap.js:2']);
});

test('deadline policy inventory follows selected switch breaks after the switch', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/switch-break-gap.js',
      source: [
        'switch (deadlineReached) {',
        '  case true: break;',
        '  case false: return READINESS.READY;',
        '}',
        'return READINESS.GAP;'
      ].join('\n')
    },
    {
      relative: 'discord/switch-break-ready.js',
      source: [
        'switch (deadlineReached) {',
        '  case true: break;',
        '  case false: return READINESS.READY;',
        '}',
        'return READINESS.READY;'
      ].join('\n')
    }
  ]);
  assert.deepEqual(offenders, ['discord/switch-break-gap.js:1']);
});

test('deadline policy inventory follows expiry after negated no-else guards', () => {
  const entries = [
    {
      relative: 'discord/negated-guard-fallthrough.js',
      source: 'if (!deadlineReached) return READINESS.READY; return READINESS.GAP;'
    },
    {
      relative: 'discord/false-guard-fallthrough.js',
      source: 'if (deadlineReached === false) return READINESS.READY; return READINESS.GAP;'
    },
    {
      relative: 'discord/inequality-guard-fallthrough.js',
      source: 'if (deadlineReached !== DEADLINE) return READINESS.READY; return READINESS.GAP;'
    },
    {
      relative: 'discord/negated-guard-ready-fallthrough.js',
      source: 'if (!deadlineReached) return READINESS.READY; return READINESS.READY;'
    }
  ];
  assert.deepEqual(findDeadlineGapOffenders(entries), [
    'discord/negated-guard-fallthrough.js:1',
    'discord/false-guard-fallthrough.js:1',
    'discord/inequality-guard-fallthrough.js:1'
  ]);
});

test('deadline policy inventory honors abrupt completion in braced switch arms', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/braced-switch-break.js',
      source: [
        'switch (kind) {',
        '  case DEADLINE: { audit(); break; }',
        '  case RETRY: return READINESS.GAP;',
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/conditional-braced-switch-break.js',
      source: [
        'switch (kind) {',
        '  case DEADLINE: { if (shouldExit) break; }',
        '  case RETRY: return READINESS.GAP;',
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/nested-conditional-switch-break.js',
      source: [
        'switch (kind) {',
        '  case DEADLINE: { if (shouldExit) { break; } }',
        '  case RETRY: return READINESS.GAP;',
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/nested-function-switch-break.js',
      source: [
        'switch (kind) {',
        '  case DEADLINE: function audit() { break; }',
        '  case RETRY: return READINESS.GAP;',
        '}'
      ].join('\n')
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/conditional-braced-switch-break.js:2',
    'discord/nested-conditional-switch-break.js:2',
    'discord/nested-function-switch-break.js:2'
  ]);
});

test('deadline policy inventory inspects short-circuit expiry branches', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/and-gap-return.js',
      source: 'function outcome() { return deadlineReached && READINESS.GAP; }'
    },
    {
      relative: 'discord/or-negated-gap-return.js',
      source: 'function outcome() { return !deadlineReached || READINESS.GAP; }'
    },
    {
      relative: 'discord/and-boundary-writer.js',
      source: 'function outcome() { deadlineReached && state.markIntakeBoundary(id, READINESS.GAP, detail); }'
    },
    {
      relative: 'discord/or-negated-boundary-writer.js',
      source: 'function outcome() { !deadlineReached || state.markIntakeBoundary(id, READINESS.GAP, detail); }'
    },
    {
      relative: 'discord/and-negated-gap-control.js',
      source: 'function outcome() { !deadlineReached && READINESS.GAP; }'
    },
    {
      relative: 'discord/or-gap-control.js',
      source: 'function outcome() { deadlineReached || READINESS.GAP; }'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/and-gap-return.js:1',
    'discord/or-negated-gap-return.js:1',
    'discord/and-boundary-writer.js:1',
    'discord/or-negated-boundary-writer.js:1'
  ]);
});

test('deadline policy inventory selects default switch arms when expiry has no explicit case', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-default-switch-gap.js',
      source: 'switch (deadlineReached) { case false: return READINESS.READY; default: return READINESS.GAP; }'
    },
    {
      relative: 'discord/deadline-default-switch-safe.js',
      source: 'switch (deadlineReached) { case false: return READINESS.READY; default: return READINESS.UNAVAILABLE; }'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-default-switch-gap.js:1']);
});

test('deadline policy inventory inspects object outcomes in conditional expressions', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-conditional-object-gap.js',
      source: 'if (deadlineReached) return retryable ? { state: READINESS.PENDING } : { state: READINESS.GAP };'
    },
    {
      relative: 'discord/deadline-conditional-object-safe.js',
      source: 'if (deadlineReached) return retryable ? { state: READINESS.PENDING } : { state: READINESS.UNAVAILABLE };'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-conditional-object-gap.js:1']);
});

test('deadline policy inventory follows negated guard fall-through across blocks and try finally', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-negated-intervening-block-gap.js',
      source: 'function readiness(deadlineReached) { if (!deadlineReached) return READINESS.READY; { audit(); } return READINESS.GAP; }'
    },
    {
      relative: 'discord/deadline-negated-inner-block-gap.js',
      source: 'function readiness(deadlineReached) { { if (!deadlineReached) return READINESS.READY; } return READINESS.GAP; }'
    },
    {
      relative: 'discord/deadline-negated-try-finally-gap.js',
      source: 'function readiness(deadlineReached) { try { if (!deadlineReached) return READINESS.READY; } finally { audit(); } return READINESS.GAP; }'
    },
    {
      relative: 'discord/deadline-negated-intervening-block-safe.js',
      source: 'function readiness(deadlineReached) { if (!deadlineReached) return READINESS.READY; { audit(); } return READINESS.UNAVAILABLE; }'
    },
    {
      relative: 'discord/deadline-negated-inner-block-safe.js',
      source: 'function readiness(deadlineReached) { { if (!deadlineReached) return READINESS.READY; } return READINESS.UNAVAILABLE; }'
    },
    {
      relative: 'discord/deadline-negated-try-finally-safe.js',
      source: 'function readiness(deadlineReached) { try { if (!deadlineReached) return READINESS.READY; } finally { audit(); } return READINESS.UNAVAILABLE; }'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/deadline-negated-intervening-block-gap.js:1',
    'discord/deadline-negated-inner-block-gap.js:1',
    'discord/deadline-negated-try-finally-gap.js:1'
  ]);
});
