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

test('reference analysis resolves constant computed ESM namespace members', () => {
  const esm = source(String.raw`import * as plan from './town-hall-plan';
    const key = 'isTownHallRoom';
    plan[key]({});`);
  assert.equal(countIdentifierReferences(esm, 'isTownHallRoom'), 1);
});

test('reference analysis resolves constant computed CommonJS namespace members', () => {
  const commonJs = source(String.raw`const plan = require('./town-hall-plan');
    const key = 'isTownHallRoom';
    plan[key]({});`);
  assert.equal(countIdentifierReferences(commonJs, 'isTownHallRoom'), 1);
});

test('reference analysis honors a computed key parameter shadow', () => {
  const shadowedParameter = source(String.raw`import * as plan from './town-hall-plan';
    const key = 'isTownHallRoom';
    function check(key) { return plan[key]({}); }`);
  assert.equal(countIdentifierReferences(shadowedParameter, 'isTownHallRoom'), 0);
});

test('reference analysis honors a computed key local shadow', () => {
  const shadowedLocal = source(String.raw`const plan = require('./town-hall-plan');
    const key = 'isTownHallRoom';
    function check() { const key = 'unrelated'; return plan[key]({}); }`);
  assert.equal(countIdentifierReferences(shadowedLocal, 'isTownHallRoom'), 0);
});

test('reference analysis resolves the built town-hall facade to its source owner', () => {
  const distFacade = source(String.raw`const plan = require('../../dist/peer/town-hall-plan.js');
    plan.isTownHallRoom({});`);
  assert.equal(countIdentifierReferences(distFacade, 'isTownHallRoom'), 1);

  const unrelatedDistFacade = source(String.raw`const plan = require('../../dist/peer/voice-room.js');
    plan.isTownHallRoom({});`);
  assert.equal(countIdentifierReferences(unrelatedDistFacade, 'isTownHallRoom'), 0);
});

test('reference analysis follows TypeScript export-equals barrels', () => {
  const barrel = ts.createSourceFile(
    'peer/town-hall-plan-barrel.cts',
    String.raw`import plan = require('./town-hall-plan');
      export = plan;`,
    ts.ScriptTarget.Latest,
    true,
  );
  const consumer = source(String.raw`import plan = require('./town-hall-plan-barrel');
    plan.isTownHallRoom(room);`);
  assert.equal(countIdentifierReferences(consumer, 'isTownHallRoom', [barrel]), 1);

  const unrelatedBarrel = ts.createSourceFile(
    'peer/unrelated-plan-barrel.cts',
    String.raw`import plan = require('./voice-room');
      export = plan;`,
    ts.ScriptTarget.Latest,
    true,
  );
  const unrelatedConsumer = source(String.raw`import plan = require('./unrelated-plan-barrel');
    plan.isTownHallRoom(room);`);
  assert.equal(countIdentifierReferences(unrelatedConsumer, 'isTownHallRoom', [unrelatedBarrel]), 0);
});

test('reference analysis counts direct awaited dynamic namespace members', () => {
  const directImport = source(String.raw`async function check(room) {
    return (await import('./town-hall-plan.js')).isTownHallRoom(room);
  }`);
  assert.equal(countIdentifierReferences(directImport, 'isTownHallRoom'), 1);

  const unrelatedImport = source(String.raw`async function check(room) {
    return (await import('./voice-room.js')).isTownHallRoom(room);
  }`);
  assert.equal(countIdentifierReferences(unrelatedImport, 'isTownHallRoom'), 0);
});

test('reference analysis follows object and local-import re-export barrels', () => {
  const plan = ts.createSourceFile(
    'peer/town-hall-plan.ts',
    'export function isTownHallRoom(room) { return room; }',
    ts.ScriptTarget.Latest,
    true,
  );
  const objectBarrel = ts.createSourceFile(
    'peer/object-barrel.cjs',
    String.raw`module.exports = {
      isTownHallRoom: require('./town-hall-plan').isTownHallRoom,
    };`,
    ts.ScriptTarget.Latest,
    true,
  );
  const objectConsumer = source(String.raw`import { isTownHallRoom } from './object-barrel';
    isTownHallRoom(room);`);
  assert.equal(countIdentifierReferences(objectConsumer, 'isTownHallRoom', [plan, objectBarrel]), 1);

  const localEsmBarrel = ts.createSourceFile(
    'peer/local-esm-barrel.ts',
    String.raw`import { isTownHallRoom } from './town-hall-plan';
      export { isTownHallRoom };`,
    ts.ScriptTarget.Latest,
    true,
  );
  const localEsmConsumer = source(String.raw`import { isTownHallRoom } from './local-esm-barrel';
    isTownHallRoom(room);`);
  assert.equal(countIdentifierReferences(localEsmConsumer, 'isTownHallRoom', [plan, localEsmBarrel]), 1);

  const directCommonJsBarrel = ts.createSourceFile(
    'peer/direct-commonjs-barrel.cjs',
    String.raw`module.exports = require('./town-hall-plan');`,
    ts.ScriptTarget.Latest,
    true,
  );
  const directEsmBarrel = ts.createSourceFile(
    'peer/direct-esm-barrel.ts',
    String.raw`export { isTownHallRoom } from './town-hall-plan';`,
    ts.ScriptTarget.Latest,
    true,
  );
  const directCommonJsConsumer = source(String.raw`import { isTownHallRoom } from './direct-commonjs-barrel';
    isTownHallRoom(room);`);
  const directEsmConsumer = source(String.raw`import { isTownHallRoom } from './direct-esm-barrel';
    isTownHallRoom(room);`);
  assert.equal(countIdentifierReferences(
    directCommonJsConsumer,
    'isTownHallRoom',
    [plan, directCommonJsBarrel],
  ), 1);
  assert.equal(countIdentifierReferences(
    directEsmConsumer,
    'isTownHallRoom',
    [plan, directEsmBarrel],
  ), 1);

  const voice = ts.createSourceFile(
    'peer/voice-room.ts',
    'export function isTownHallRoom(room) { return room; }',
    ts.ScriptTarget.Latest,
    true,
  );
  const unrelatedBarrel = ts.createSourceFile(
    'peer/unrelated-object-barrel.cjs',
    String.raw`module.exports = {
      isTownHallRoom: require('./voice-room').isTownHallRoom,
    };`,
    ts.ScriptTarget.Latest,
    true,
  );
  const unrelatedConsumer = source(String.raw`import { isTownHallRoom } from './unrelated-object-barrel';
    isTownHallRoom(room);`);
  assert.equal(countIdentifierReferences(
    unrelatedConsumer,
    'isTownHallRoom',
    [voice, unrelatedBarrel],
  ), 0);

  const parameterShadow = source(String.raw`import { isTownHallRoom } from './local-esm-barrel';
    function shadow(isTownHallRoom) { return isTownHallRoom(room); }`);
  assert.equal(countIdentifierReferences(parameterShadow, 'isTownHallRoom', [plan, localEsmBarrel]), 0);
});

test('switch case bindings do not hide imported guard calls after the switch', () => {
  const switchCase = source(String.raw`import { isTownHallRoom } from './town-hall-plan';
    switch (kind) {
      case 'local':
        let isTownHallRoom = room => room;
        isTownHallRoom(room);
        break;
    }
    isTownHallRoom(room);`);
  assert.equal(countIdentifierReferences(switchCase, 'isTownHallRoom'), 1);

  const bracedShadow = source(String.raw`import { isTownHallRoom } from './town-hall-plan';
    if (kind) {
      let isTownHallRoom = room => room;
      isTownHallRoom(room);
    }
    isTownHallRoom(room);`);
  assert.equal(countIdentifierReferences(bracedShadow, 'isTownHallRoom'), 1);
});

test('reference analysis follows default guard re-exports without matching other defaults', () => {
  const plan = ts.createSourceFile(
    'peer/town-hall-plan.ts',
    'export function isTownHallRoom(room) { return room; } export function parseRoom(room) { return room; }',
    ts.ScriptTarget.Latest,
    true,
  );
  const guardBarrel = ts.createSourceFile(
    'peer/default-guard-barrel.ts',
    "export { isTownHallRoom as default } from './town-hall-plan';",
    ts.ScriptTarget.Latest,
    true,
  );
  const unrelatedBarrel = ts.createSourceFile(
    'peer/default-unrelated-barrel.ts',
    "export { parseRoom as default } from './town-hall-plan';",
    ts.ScriptTarget.Latest,
    true,
  );
  const guardConsumer = ts.createSourceFile(
    'peer/default-guard-consumer.ts',
    "import isTownHallRoom from './default-guard-barrel'; isTownHallRoom(room);",
    ts.ScriptTarget.Latest,
    true,
  );
  const unrelatedConsumer = ts.createSourceFile(
    'peer/default-unrelated-consumer.ts',
    "import parseRoom from './default-unrelated-barrel'; parseRoom(room);",
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(guardConsumer, 'isTownHallRoom', [plan, guardBarrel]), 1);
  assert.equal(countIdentifierReferences(unrelatedConsumer, 'isTownHallRoom', [plan, unrelatedBarrel]), 0);
});

test('reference analysis ignores labels and jump targets', () => {
  const labels = source(String.raw`import { isTownHallRoom } from './town-hall-plan';
    isTownHallRoom: while (true) {
      break isTownHallRoom;
      continue isTownHallRoom;
    }`);
  assert.equal(countIdentifierReferences(labels, 'isTownHallRoom'), 0);

  const realImport = source(String.raw`import { isTownHallRoom } from './town-hall-plan';
    isTownHallRoom(room);`);
  assert.equal(countIdentifierReferences(realImport, 'isTownHallRoom'), 1);
});

test('reference analysis ignores locally bound CommonJS loaders', () => {
  const parameterLoader = source(String.raw`function load(require) {
    const { isTownHallRoom } = require('./town-hall-plan');
    return isTownHallRoom(room);
  }`);
  assert.equal(countIdentifierReferences(parameterLoader, 'isTownHallRoom'), 0);

  const localLoader = source(String.raw`const require = loader;
    const { isTownHallRoom } = require('./town-hall-plan');
    isTownHallRoom(room);`);
  assert.equal(countIdentifierReferences(localLoader, 'isTownHallRoom'), 0);

  const realLoader = source(String.raw`const { isTownHallRoom } = require('./town-hall-plan');
    isTownHallRoom(room);`);
  assert.equal(countIdentifierReferences(realLoader, 'isTownHallRoom'), 1);
});
