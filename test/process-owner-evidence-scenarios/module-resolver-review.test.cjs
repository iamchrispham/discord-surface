'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inventoryFiles } = require('./public-inventory-fixtures.cjs');

const probeSite = ['use.js\u0000null'];
const probeViolation = ['unclassified process probe use.js:null'];

const expectProbe = files => {
  const result = inventoryFiles(files);
  assert.deepEqual(result.kills, probeSite);
  assert.deepEqual(result.violations, probeViolation);
};

const expectOrdinary = files => {
  const result = inventoryFiles(files);
  assert.deepEqual(result.kills, []);
  assert.deepEqual(result.violations, []);
};

test('cross-file logical exports retain the selected probe and exclude unreachable operands', () => {
  expectProbe({
    'producer.js': 'const ordinary = () => true; export const probe = process.kill || ordinary;',
    'use.js': "import { probe } from './producer.js'; probe(1, 0);"
  });
  expectOrdinary({
    'producer.js': 'const ordinary = () => true; export const probe = ordinary || process.kill;',
    'use.js': "import { probe } from './producer.js'; probe(1, 0);"
  });
  expectProbe({
    'producer.js': 'export const probe = process.kill && process.kill;',
    'use.js': "import { probe } from './producer.js'; probe(1, 0);"
  });
  expectProbe({
    'producer.js': 'export const probe = null ?? process.kill;',
    'use.js': "import { probe } from './producer.js'; probe(1, 0);"
  });
  expectOrdinary({
    'producer.js': 'export const probe = 0 && process.kill;',
    'use.js': "import { probe } from './producer.js'; probe(1, 0);"
  });
});

test('cross-file array destructuring preserves finite exported elements', () => {
  expectProbe({
    'producer.js': 'export const [probe] = [process.kill];',
    'use.js': "import { probe } from './producer.js'; probe(1, 0);"
  });
  expectOrdinary({
    'producer.js': 'export const [probe] = [() => true];',
    'use.js': "import { probe } from './producer.js'; probe(1, 0);"
  });
});

test('CommonJS branch exports retain both syntactic assignment orders', () => {
  for (const source of [
    'if (flag) module.exports = process.kill; else module.exports = () => true;',
    'if (flag) module.exports = () => true; else module.exports = process.kill;'
  ]) {
    expectProbe({ 'producer.js': source, 'use.js': "require('./producer.js')(1, 0);" });
  }
  expectOrdinary({
    'producer.js': 'if (flag) module.exports = () => true; else module.exports = () => false;',
    'use.js': "require('./producer.js')(1, 0);"
  });
});

test('inherited exported class fields retain process-probe provenance', () => {
  expectProbe({
    'producer.js': 'export class Parent { probe = process.kill; } export class Child extends Parent {}',
    'use.js': "import { Child } from './producer.js'; new Child().probe(1, 0);"
  });
  expectOrdinary({
    'producer.js': 'export class Parent { probe = process.kill; } export class Child extends Parent { probe = () => true; }',
    'use.js': "import { Child } from './producer.js'; new Child().probe(1, 0);"
  });
});

test('cross-file bind exports retain probe and unsupported pre-bound identities', () => {
  expectProbe({
    'producer.js': 'export default process.kill.bind(process);',
    'use.js': "import probe from './producer.js'; probe(1, 0);"
  });
  const result = inventoryFiles({
    'producer.js': 'export default process.kill.bind(process, 1);',
    'use.js': "import probe from './producer.js'; probe();"
  });
  assert.deepEqual(result.kills, []);
  assert.deepEqual(result.violations, ['unsupported process probe use.js:null']);
  expectOrdinary({
    'producer.js': 'export default (() => true).bind(null);',
    'use.js': "import probe from './producer.js'; probe(1, 0);"
  });
});

test('direct process re-exports preserve named and default origins', () => {
  expectProbe({
    'producer.js': "export { kill as probe } from 'node:process';",
    'use.js': "import { probe } from './producer.js'; probe(1, 0);"
  });
  expectProbe({
    'producer.js': "export { kill as default } from 'node:process';",
    'use.js': "import probe from './producer.js'; probe(1, 0);"
  });
  expectProbe({
    'producer.js': "export { default } from 'node:process';",
    'use.js': "import process from './producer.js'; process.kill(1, 0);"
  });
  expectOrdinary({
    'producer.js': 'export const probe = () => true;',
    'use.js': "import { probe } from './producer.js'; probe(1, 0);"
  });
});

test('imported callable bodies with probe arguments are conservatively refused', () => {
  const result = inventoryFiles({
    'producer.js': 'export function invoke(probe, pid) { probe(pid, 0); }',
    'use.js': "import { invoke } from './producer.js'; invoke(process.kill, 1);"
  });
  assert.deepEqual(result.kills, []);
  assert.deepEqual(result.violations, ['unsupported process probe use.js:null']);
  expectOrdinary({
    'producer.js': 'export function invoke(probe, pid) { probe(pid, 0); }',
    'use.js': "import { invoke } from './producer.js'; invoke(() => true, 1);"
  });
});

test('callable module writes and logical assignments retain only reachable probe sources', () => {
  expectProbe({
    'producer.js': 'export let probe = () => true; export function install() { probe = process.kill; }',
    'use.js': "import { install, probe } from './producer.js'; install(); probe(1, 0);"
  });
  for (const [initial, operator] of [
    ['', '??='],
    ['', '||='],
    [' = () => true', '&&=']
  ]) {
    expectProbe({
      'producer.js': `export let probe${initial}; probe ${operator} process.kill;`,
      'use.js': "import { probe } from './producer.js'; probe(1, 0);"
    });
  }
  expectOrdinary({
    'producer.js': 'export let probe = () => true; probe ??= () => false;',
    'use.js': "import { probe } from './producer.js'; probe(1, 0);"
  });
  expectOrdinary({
    'producer.js': 'export let probe = () => true; export function install() { let probe = () => false; probe = process.kill; }',
    'use.js': "import { install, probe } from './producer.js'; install(); probe(1, 0);"
  });
});

test('statically bounded defineProperty exports retain probe values', () => {
  expectProbe({
    'producer.js': "Object.defineProperty(exports, 'probe', { value: process.kill });",
    'use.js': "require('./producer.js').probe(1, 0);"
  });
  expectOrdinary({
    'producer.js': "Object.defineProperty(exports, 'probe', { value: () => true });",
    'use.js': "require('./producer.js').probe(1, 0);"
  });
});

test('namespace-import destructuring resolves exported properties', () => {
  expectProbe({
    'producer.js': 'export const probe = process.kill;',
    'use.js': "import * as api from './producer.js'; const { probe } = api; probe(1, 0);"
  });
  expectOrdinary({
    'producer.js': 'export const probe = () => true;',
    'use.js': "import * as api from './producer.js'; const { probe } = api; probe(1, 0);"
  });
});

test('global process object spellings retain cross-file probe origins', () => {
  for (const processObject of ['globalThis.process', 'global.process']) {
    expectProbe({
      'producer.js': `export const probe = ${processObject}.kill;`,
      'use.js': "import { probe } from './producer.js'; probe(1, 0);"
    });
  }
  expectOrdinary({
    'producer.js': 'const globalThis = { process: { kill: () => true } }; export const probe = globalThis.process.kill;',
    'use.js': "import { probe } from './producer.js'; probe(1, 0);"
  });
});

test('void zero selects imported default arguments but explicit ordinary callables win', () => {
  expectProbe({
    'producer.js': 'export const getProbe = (value = process.kill) => value;',
    'use.js': "import { getProbe } from './producer.js'; getProbe(void 0)(1, 0);"
  });
  expectOrdinary({
    'producer.js': 'export const getProbe = (value = process.kill) => value;',
    'use.js': "import { getProbe } from './producer.js'; getProbe(() => true)(1, 0);"
  });
});

test('nested helper blocks retain outer assignments without capturing shadowed locals', () => {
  expectProbe({
    'producer.js': 'export function getProbe() { let probe; if (true) { probe = process.kill; } return probe; }',
    'use.js': "import { getProbe } from './producer.js'; getProbe()(1, 0);"
  });
  expectOrdinary({
    'producer.js': 'export function getProbe() { let probe = () => true; if (true) { let probe = () => false; probe = process.kill; } return probe; }',
    'use.js': "import { getProbe } from './producer.js'; getProbe()(1, 0);"
  });
});

test('package main directories resolve finite index entries', () => {
  expectProbe({
    'probe/package.json': '{"main":"lib"}',
    'probe/lib/index.js': 'module.exports = process.kill;',
    'use.js': "require('./probe')(1, 0);"
  });
  expectOrdinary({
    'probe/package.json': '{"main":"lib"}',
    'probe/lib/index.js': 'module.exports = () => true;',
    'use.js': "require('./probe')(1, 0);"
  });
});
