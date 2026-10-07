'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { countIdentifierReferences } = require('./policy-reference-analysis');

function source(text) {
  return ts.createSourceFile('peer/reference-analysis-fixture.ts', text, ts.ScriptTarget.Latest, true);
}

test('reference analysis follows semantic exported bindings', () => {
  const fixture = source(String.raw`export function isTownHallRoom(room) { return room; }
    const label = 'isTownHallRoom';
    interface Options { isTownHallRoom: boolean }
    function shadow() { function isTownHallRoom(room) { return room; } return isTownHallRoom({}); }
    isTownHallRoom({});`);
  assert.equal(countIdentifierReferences(fixture, 'isTownHallRoom'), 1);
});

test('reference analysis follows aliases and namespace members without shadows', () => {
  const aliased = source(String.raw`import { isTownHallRoom as roomGuard } from './town-hall-plan';
    roomGuard({});`);
  assert.equal(countIdentifierReferences(aliased, 'isTownHallRoom'), 1);

  const namespaced = source(String.raw`import * as plan from './town-hall-plan';
    function shadow(plan) { return plan.isTownHallRoom({}); }
    plan.isTownHallRoom({});`);
  assert.equal(countIdentifierReferences(namespaced, 'isTownHallRoom'), 1);

  const directCommonJs = source(String.raw`function check(room) {
    return require('./town-hall-plan').isTownHallRoom(room);
  }`);
  assert.equal(countIdentifierReferences(directCommonJs, 'isTownHallRoom'), 1);
});
