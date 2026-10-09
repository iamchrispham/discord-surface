'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { findDeadlineGapOffenders, readSourceInventory } = require('./intake-recovery-analysis.cjs');

test('deadline policy inventory recognizes only named deadline predicates', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-predicate-gap.js',
      source: 'if (isDeadlineReached()) return READINESS.GAP;'
    },
    {
      relative: 'discord/deadline-predicate-unavailable.js',
      source: 'if (isDeadlineReached()) return READINESS.UNAVAILABLE;'
    },
    {
      relative: 'discord/non-deadline-predicate-gap.js',
      source: 'if (isReady()) return READINESS.GAP;'
    },
    {
      relative: 'discord/unsupported-deadline-predicate-gap.js',
      source: 'if (hasDeadlineElapsed()) return READINESS.GAP;'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-predicate-gap.js:1']);
});

test('deadline policy inventory resolves aliases of deadline timestamps', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-timestamp-alias-gap.js',
      source: 'const expiresAt = deadline; if (Date.now() >= expiresAt) return READINESS.GAP;'
    },
    {
      relative: 'discord/deadline-timestamp-alias-unavailable.js',
      source: 'const expiresAt = deadline; if (Date.now() >= expiresAt) return READINESS.UNAVAILABLE;'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-timestamp-alias-gap.js:1']);
});

test('deadline policy inventory recognizes elapsed-time deadline arithmetic', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-elapsed-direct-gap.js',
      source: 'if (Date.now() - deadline >= 0) return READINESS.GAP;'
    },
    {
      relative: 'discord/deadline-elapsed-alias-gap.js',
      source: 'const elapsed = Date.now() - deadline; if (elapsed >= 0) return READINESS.GAP;'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/deadline-elapsed-direct-gap.js:1',
    'discord/deadline-elapsed-alias-gap.js:1'
  ]);
});

test('deadline policy inventory recognizes computed deadline enum members', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-computed-enum-string.js',
      source: "if (kind === CODEX_VALIDATION_KINDS['DEADLINE']) return READINESS.GAP;"
    },
    {
      relative: 'discord/deadline-computed-enum-template.js',
      source: 'if (kind === CODEX_VALIDATION_KINDS[`DEADLINE`]) return READINESS.GAP;'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/deadline-computed-enum-string.js:1',
    'discord/deadline-computed-enum-template.js:1'
  ]);
});

test('deadline policy inventory recognizes literal deadline predicates but ignores passive strings', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-literal-comparison.js',
      source: "if (kind === 'deadline') return READINESS.GAP;"
    },
    {
      relative: 'discord/deadline-literal-membership.js',
      source: "if (['deadline'].includes(kind)) return READINESS.GAP;"
    },
    {
      relative: 'discord/deadline-literal-metadata.js',
      source: "const note = 'deadline'; return READINESS.GAP;"
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/deadline-literal-comparison.js:1',
    'discord/deadline-literal-membership.js:1'
  ]);
});

test('deadline policy inventory recognizes member-qualified deadline operands', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/member-qualified-deadline.js',
      source: 'if (Date.now() >= options.deadline) return READINESS.GAP;'
    },
    {
      relative: 'discord/reversed-member-qualified-deadline.js',
      source: 'if (options.deadline <= Date.now()) return READINESS.GAP;'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/member-qualified-deadline.js:1',
    'discord/reversed-member-qualified-deadline.js:1'
  ]);
});

test('deadline policy inventory recognizes static deadline templates only', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-static-template.js',
      source: 'if (kind === `deadline`) return READINESS.GAP;'
    },
    {
      relative: 'discord/deadline-passive-template.js',
      source: 'if (kind === `retry`) return READINESS.GAP;'
    },
    {
      relative: 'discord/deadline-dynamic-template.js',
      source: 'if (kind === `deadline-${suffix}`) return READINESS.GAP;'
    }
  ]);
  assert.deepEqual(offenders, ['discord/deadline-static-template.js:1']);
});

test('deadline policy inventory follows aliases of deadline enum values', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: 'mutation.js', source }]);
  assert.deepEqual(offendersFor('const deadlineKind=CODEX_VALIDATION_KINDS.DEADLINE;if(kind===deadlineKind)return READINESS.GAP;'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('const deadlineKind=CODEX_VALIDATION_KINDS.RETRY;if(kind===deadlineKind)return READINESS.GAP;'), []);
  assert.deepEqual(offendersFor('const {DEADLINE:deadlineKind}=CODEX_VALIDATION_KINDS;if(kind===deadlineKind)return READINESS.GAP;'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('const {DEADLINE:deadlineKind}=CODEX_VALIDATION_KINDS;if(kind===deadlineKind)return READINESS.UNAVAILABLE;'), []);
});

test('deadline policy inventory recognizes unshadowed Date object comparisons', () => {
  const offendersFor = source => findDeadlineGapOffenders([{ relative: 'mutation.js', source }]);
  assert.deepEqual(offendersFor('if(new Date()>=deadline)return READINESS.GAP;'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('if(new Date()<deadline)return READINESS.GAP;'), []);
  assert.deepEqual(offendersFor('if(new Date(deadline)<=Date.now())return READINESS.GAP;'), ['mutation.js:1']);
  assert.deepEqual(offendersFor('if(new Date(deadline)<=Date.now())return READINESS.UNAVAILABLE;'), []);
  assert.deepEqual(offendersFor('const Date=FakeDate;if(new Date()>=deadline)return READINESS.GAP;'), []);
});
