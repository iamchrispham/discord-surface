const test = require('node:test');
const assert = require('node:assert/strict');

const { matches, source } = require('./state-facade/owner-test-helpers');

test('accepts the unchanged persistence facade baseline', () => {
  assert.equal(matches(source), true);
});
