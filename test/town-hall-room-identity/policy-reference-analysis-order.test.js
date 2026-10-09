const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { countIdentifierReferences } = require('./policy-reference-analysis');

test('namespace aliases declared after a use are counted', () => {
  const source = ts.createSourceFile(
    'peer/namespace-alias-declared-after-use.ts',
    String.raw`import * as plan from './town-hall-plan.js';
    function invoke() { return guard({}); }
    const { isTownHallRoom: guard } = plan;
    invoke();`,
    ts.ScriptTarget.Latest,
    true,
  );

  assert.equal(countIdentifierReferences(source, 'isTownHallRoom'), 1);
});
