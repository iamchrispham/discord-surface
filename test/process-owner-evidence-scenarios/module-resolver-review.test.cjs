'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inventoryFiles } = require('./public-inventory-fixtures.cjs');

const probeSite = ['use.js\u0000null'];
const probeViolation = ['unclassified process probe use.js:null'];

const expectProbe = files => {
  const result = inventoryFiles(files);
  assert.deepEqual(result.kills, probeSite);
  assert.deepEqual(result.legacyCalls, []);
  assert.deepEqual(result.violations, probeViolation);
};

const expectOrdinary = files => {
  const result = inventoryFiles(files);
  assert.deepEqual(result.kills, []);
  assert.deepEqual(result.legacyCalls, []);
  assert.deepEqual(result.violations, []);
};

const expectUnsupported = files => {
  const result = inventoryFiles(files);
  assert.deepEqual(result.kills, []);
  assert.deepEqual(result.legacyCalls, []);
  assert.deepEqual(result.violations, ['unsupported process probe use.js:null']);
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

test('object-valued named exports and statically bounded getters preserve properties', () => {
  expectProbe({
    'producer.js': 'export const api = { probe: process.kill };',
    'use.js': "import { api } from './producer.js'; api.probe(1, 0);"
  });
  expectProbe({
    'producer.js': 'module.exports = { get probe() { return process.kill; } };',
    'use.js': "require('./producer.js').probe(1, 0);"
  });
  expectOrdinary({
    'producer.js': 'module.exports = { get probe() { return () => true; } };',
    'use.js': "require('./producer.js').probe(1, 0);"
  });
});

test('finite computed CommonJS export keys resolve identifier values', () => {
  expectProbe({
    'producer.js': "const key = 'probe'; exports[key] = process.kill;",
    'use.js': "require('./producer.js').probe(1, 0);"
  });
  expectOrdinary({
    'producer.js': "const key = 'probe'; exports[key] = () => true;",
    'use.js': "require('./producer.js').probe(1, 0);"
  });
});

test('builtin namespace and wildcard re-exports retain process probes', () => {
  expectProbe({
    'producer.js': "export * from 'node:process';",
    'use.js': "import { kill } from './producer.js'; kill(1, 0);"
  });
  expectProbe({
    'producer.js': "export * as proc from 'node:process';",
    'use.js': "import { proc } from './producer.js'; proc.kill(1, 0);"
  });
});

test('relative dynamic-import namespaces resolve local exports', () => {
  const result = inventoryFiles({
    'producer.js': 'export const probe = process.kill;',
    'use.js': "async function run() { const mod = await import('./producer.js'); mod.probe(1, 0); } run();"
  });
  assert.deepEqual(result.kills, ['use.js\u0000run']);
  assert.deepEqual(result.violations, ['unclassified process probe use.js:run']);
});

test('function-scoped require shadows do not resolve local modules', () => {
  expectOrdinary({
    'producer.js': "module.exports = process.kill;",
    'helper.js': "export function getProbe() { function require() { return () => true; } return require('./producer.js'); }",
    'use.js': "import { getProbe } from './helper.js'; getProbe()(1, 0);"
  });
});

test('executable mjs modules enter the public inventory', () => {
  const result = inventoryFiles({ 'owner.mjs': 'process.kill(1, 0);' });
  assert.deepEqual(result.kills, ['owner.mjs\u0000null']);
  assert.deepEqual(result.violations, ['unclassified process probe owner.mjs:null']);
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
  const identityResult = inventoryFiles({
    'producer.js': 'export const identity = value => value;',
    'use.js': "import { identity } from './producer.js'; function newProbe(pid) { identity(process.kill)(pid, 0); }"
  });
  assert.deepEqual(identityResult.kills, ['use.js\u0000newProbe']);
  assert.deepEqual(identityResult.violations, ['unclassified process probe use.js:newProbe']);
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

test('ordinary destructuring and timer-shaped expressions do not crash inventory', () => {
  for (const source of [
    'for (const clock of clocks) clock.setTimeout(fn, 0);',
    'let clock; function schedule(fn) { clock.setTimeout(fn, 0); }',
    'for (const { setTimeout } of list) setTimeout(fn, 0);',
    'function restore(cached) { for (const [key, loaded] of cached) require.cache[key] = loaded; }'
  ]) expectOrdinary({ 'use.js': source });
  expectOrdinary({
    'producer.js': 'export function getProbe() { let probe = () => true; for (; ready;) { probe = () => false; } return probe; }',
    'use.js': "import { getProbe } from './producer.js'; getProbe()(1, 0);"
  });
});

test('bound probes survive named exports and pre-bound arguments are refused', () => {
  expectProbe({
    'producer.js': 'export const probe = process.kill.bind(process);',
    'use.js': "import { probe } from './producer.js'; probe(1, 0);"
  });
  expectUnsupported({
    'producer.js': 'export const probe = process.kill.bind(process, 1);',
    'use.js': "import { probe } from './producer.js'; probe();"
  });
});

test('Object.assign writes to CommonJS exports retain named probes', () => {
  for (const target of ['exports', 'module.exports']) {
    expectProbe({
      'producer.js': `Object.assign(${target}, { probe: process.kill });`,
      'use.js': "require('./producer.js').probe(1, 0);"
    });
  }
  expectOrdinary({
    'producer.js': 'Object.assign(exports, { probe: () => true });',
    'use.js': "require('./producer.js').probe(1, 0);"
  });
});

test('namespace-import destructuring resolves named probe properties', () => {
  expectProbe({
    'producer.js': 'export const probe = process.kill;',
    'use.js': "import * as api from './producer.js'; const { probe } = api; probe(1, 0);"
  });
  expectOrdinary({
    'producer.js': 'export const probe = () => true;',
    'use.js': "import * as api from './producer.js'; const { probe } = api; probe(1, 0);"
  });
});

test('finite array callbacks classify direct process.kill probes', () => {
  expectProbe({ 'use.js': '[pid].forEach(process.kill);' });
  expectOrdinary({ 'use.js': '[pid].forEach(() => true);' });
  expectOrdinary({ 'use.js': '[, pid].forEach(process.kill);' });
});

test('literal dynamic imports of process retain probe origins', () => {
  for (const specifier of ['node:process', 'process']) {
    expectProbe({
      'use.js': `void (async pid => { (await import('${specifier}')).kill(pid, 0); })(1);`
    });
  }
});

test('variable-held same-file callables return their resolved values', () => {
  expectProbe({ 'use.js': 'const getProbe = () => process.kill; getProbe()(1, 0);' });
  expectProbe({ 'use.js': 'const getProbe = function () { return process.kill; }; getProbe()(1, 0);' });
  expectProbe({
    'use.js': 'const getProbe = (value = process.kill) => value; getProbe(void 1)(1, 0);'
  });
});

test('cross-file defaults apply to undefined forms and destructured defaults', () => {
  const undefinedCalls = [
    ['void 1', ''], ['void \'x\'', ''], ['void f()', 'function f() {}'],
    ['nothing', 'const nothing = undefined;'], ['nothing', 'let nothing;']
  ];
  for (const [argument, declaration] of undefinedCalls) {
    expectProbe({
      'producer.js': 'export function getProbe(value = process.kill) { return value; }',
      'use.js': `import { getProbe } from './producer.js'; ${declaration} getProbe(${argument})(1, 0);`
    });
  }
  expectProbe({
    'producer.js': 'export const getProbe = ({ value = process.kill } = {}) => value;',
    'use.js': "import { getProbe } from './producer.js'; getProbe()(1, 0);"
  });
  expectProbe({
    'producer.js': 'export const getProbe = ({ value = process.kill }) => value;',
    'use.js': "import { getProbe } from './producer.js'; getProbe({})(1, 0);"
  });
  expectOrdinary({
    'producer.js': 'export const getProbe = ({ value = process.kill } = {}) => value;',
    'use.js': "import { getProbe } from './producer.js'; getProbe({ value: () => true })(1, 0);"
  });
});

test('shadowed local writes do not replace the returned or exported callable', () => {
  const shadows = [
    'try {} catch (probe) { probe = process.kill; }',
    'for (let probe of [1]) { probe = process.kill; }',
    '{ function probe() {} probe = process.kill; }',
    '{ class probe {} probe = process.kill; }'
  ];
  for (const shadow of shadows) {
    expectOrdinary({
      'producer.js': `export function getProbe() { let probe = () => true; ${shadow} return probe; }`,
      'use.js': "import { getProbe } from './producer.js'; getProbe()(1, 0);"
    });
  }
  expectOrdinary({
    'producer.js': 'export let probe = () => true; export function install() { let probe = () => false; const f = () => { probe = process.kill; }; f(); }',
    'use.js': "import { install, probe } from './producer.js'; install(); probe(1, 0);"
  });
  expectProbe({
    'producer.js': 'export function getProbe() { let probe = () => true; const set = () => { probe = process.kill; }; set(); return probe; }',
    'use.js': "import { getProbe } from './producer.js'; getProbe()(1, 0);"
  });
  expectOrdinary({
    'producer.js': 'export function getProbe() { let probe = () => true; const set = (probe) => { probe = process.kill; }; set(() => false); return probe; }',
    'use.js': "import { getProbe } from './producer.js'; getProbe()(1, 0);"
  });
  expectOrdinary({
    'producer.js': 'export function getProbe() { let probe = () => true; const set = () => { probe = process.kill; }; return probe; }',
    'use.js': "import { getProbe } from './producer.js'; getProbe()(1, 0);"
  });
});

test('module writes include closure, destructuring, hoisted, and logical assignments', () => {
  const use = "import { install, probe } from './producer.js'; install(); probe(1, 0);";
  for (const producer of [
    'export let probe = () => true; export function install() { const set = () => { probe = process.kill; }; set(); }',
    'export let probe = () => true; export function install() { [probe] = [process.kill]; }',
    'export let probe = () => true; export function install() { ({ probe } = { probe: process.kill }); }',
    'export function probe() { return true; } export function install() { probe = process.kill; }',
    'export let probe = () => true; reset(); probe ||= process.kill; export function reset() { probe = undefined; }'
  ]) expectProbe({ 'producer.js': producer, 'use.js': use });
});

test('dot and dot-dot imports follow local directory index resolution', () => {
  const parentImport = inventoryFiles({
    'index.js': 'module.exports = process.kill;',
    'sub/use.js': "require('..')(1, 0);"
  });
  assert.deepEqual(parentImport.kills, ['sub/use.js\u0000null']);
  assert.deepEqual(parentImport.legacyCalls, []);
  assert.deepEqual(parentImport.violations, ['unclassified process probe sub/use.js:null']);
  expectProbe({
    'index.js': 'module.exports = process.kill;',
    'use.js': "require('.')(1, 0);"
  });
  expectOrdinary({
    'index.js': 'module.exports = () => true;',
    'use.js': "require('.')(1, 0);"
  });
});

test('imported calls receiving probe-bearing arguments are refused', () => {
  const cases = [
    ['export function invoke(probe, pid) { probe.call(null, pid, 0); }', 'invoke(process.kill, 1);'],
    ['export function invoke(probe, pid) { probe.apply(null, [pid, 0]); }', 'invoke(process.kill, 1);'],
    ['export function invoke(probe, pid) { Reflect.apply(probe, null, [pid, 0]); }', 'invoke(process.kill, 1);'],
    ['export function invoke(probe, pid) { const p = probe; p(pid, 0); }', 'invoke(process.kill, 1);'],
    ['function forward(probe, pid) { probe(pid, 0); } export function invoke(probe, pid) { forward(probe, pid); }', 'invoke(process.kill, 1);'],
    ['export function invoke({ probe }, pid) { probe(pid, 0); }', 'invoke({ probe: process.kill }, 1);'],
    ['export function invoke(api, pid) { api.kill(pid, 0); }', 'invoke(process, 1);'],
    ['export function invoke(probe, pid) { setTimeout(probe, 0, pid, 0); }', 'invoke(process.kill, 1);']
  ];
  for (const [producer, call] of cases) {
    expectUnsupported({
      'producer.js': producer,
      'use.js': `import { invoke } from './producer.js'; ${call}`
    });
  }
});

test('arithmetic signal assignments are refused when their result is unresolved', () => {
  expectUnsupported({ 'use.js': 'let signal = 1; signal -= 1; process.kill(pid, signal);' });
});
