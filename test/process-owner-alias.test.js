'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runFixture, runFilesFixture, inventoryFiles, inventoryProcessOwnerSites, SRC_ROOT } =
  require('./process-owner-evidence-scenarios/public-inventory-fixtures.cjs');

test("let function alias", () => {
runFixture("let probe = process.kill; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("var function alias", () => {
runFixture("var probe = process.kill; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("let process object alias", () => {
runFixture("let proc = process; function newProbe(pid) { proc.kill(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("assigned function alias", () => {
runFixture("let probe; probe = process.kill; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("direct PID probe is inventoried", () => {
runFixture("function newProbe(pid) { process.kill(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("const aliases preserve probe identity", () => {
runFixture("const probe = process.kill; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
runFixture("const proc = process; function newProbe(pid) { proc.kill(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
runFixture("const {kill: probe} = process; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("finite concatenated property names preserve probe identity", () => {
  runFixture("function newProbe(pid) { process['ki' + 'll'](pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid) { process['ki' + 'lls'](pid, 0); }", [], []);
});

test("Object.assign resolves bounded aliased sources in order", () => {
  runFixture("const source = {probe: process.kill}; const api = {}; Object.assign(api, source); function newProbe(pid) { api.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const source = {probe: process.kill}; const api = {}; Object.assign(api, source, {probe: () => true}); function newProbe(pid) { api.probe(pid, 0); }", [], []);
});

test("Object.create preserves bounded prototype probe properties", () => {
  runFixture("const api = Object.create({probe: process.kill}); function newProbe(pid) { api.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const api = Object.create({probe: () => true}); function newProbe(pid) { api.probe(pid, 0); }", [], []);
});

test("known custom forEach methods are not treated as array callbacks", () => {
  runFixture("const registry = {forEach(callback) { return true; }}; function newProbe(pid) { registry.forEach(process.kill); }", [], []);
});

test("array callbacks classify every invoked index", () => {
  runFixture("function newProbe(pid) { [, pid].forEach(process.kill); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid) { [pid].forEach(process.kill); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid) { Array.prototype.forEach.call([, pid], process.kill); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid) { Array.from([, pid], process.kill); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe", "unsupported process probe private-alias.js:newProbe"]);
});

test("local process shadow is not a probe", () => {
runFixture("const process = { kill() {} }; function newProbe(pid) { process.kill(pid, 0); }", [], []);
});

test("mutable alias chains carry a potential probe", () => {
runFixture("let first = process.kill; let second = first; function newProbe(pid) { second(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
runFixture("let proc = process; let target = proc; function newProbe(pid) { target.kill(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("native Promise result aliases retain callback probe identity", () => {
runFixture("function newProbe(pid) { const pending = Promise.resolve(pid); pending.then(process.kill); }", [], ["unsupported process probe private-alias.js:newProbe"]);
runFixture("function newProbe(pid) { let pending; pending = Promise.resolve(pid); const alias = pending; alias.then(process.kill); }", [], ["unsupported process probe private-alias.js:newProbe"]);
runFixture("function newProbe(pid) { const Promise = {resolve: value => ({then: callback => callback(value)})}; const pending = Promise.resolve(pid); pending.then(process.kill); }", [], []);
runFixture("function newProbe(pid) { const pending = new Promise(resolve => resolve(pid)); const alias = pending; alias.then(process.kill); }", [], ["unsupported process probe private-alias.js:newProbe"]);
runFixture("function newProbe(pid) { class Promise { constructor(executor) {} } const pending = new Promise(resolve => resolve(pid)); pending.then(process.kill); }", [], []);
});

test("defineProperty getter returns preserve finite probe identity", () => {
  runFixture("const api = {}; Object.defineProperty(api, 'probe', {get() { return process.kill; }}); function newProbe(pid) { api.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const api = {}; Object.defineProperty(api, 'probe', {get() { return () => true; }}); function newProbe(pid) { api.probe(pid, 0); }", [], []);
  runFixture("const api = {}; Object.defineProperty(api, 'probe', {value: function probe() { return true; }}); function newProbe(pid) { api.probe(pid, 0); }", [], []);
});

test("Reflect.get aliases preserve only builtin probe identity", () => {
  runFixture("const get = Reflect.get; const probe = get(process, 'kill'); function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const get = Reflect.get; const probe = get({ready: true}, 'ready'); function newProbe(pid) { probe(pid, 0); }", [], []);
  runFixture("const Reflect = {get(target, key) { return target[key]; }}; const get = Reflect.get; const probe = get({ready: true}, 'ready'); function newProbe(pid) { probe(pid, 0); }", [], []);
});

test("global timer callbacks preserve native forwarding and respect shadows", () => {
  runFixture("function newProbe(pid) { globalThis.setImmediate(process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid) { global.setImmediate(process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const globalThis = {setImmediate(callback) {}}; function newProbe(pid) { globalThis.setImmediate(process.kill, pid, 0); }", [], []);
});

test("writes through imported objects attach probes to the exported identity", () => {
  const importedProbe = inventoryFiles({
    "producer.mjs": "export const api = {};",
    "writer.mjs": "import {api} from './producer.mjs'; api.probe = process.kill;",
    "consumer.mjs": "import {api} from './producer.mjs'; function newProbe(pid) { api.probe(pid, 0); }"
  });
  assert.equal(importedProbe.kills.length, 1);
  assert.deepEqual(importedProbe.violations, ["unclassified process probe consumer.mjs:newProbe"]);

  const ordinaryWrite = inventoryFiles({
    "producer.mjs": "export const api = {};",
    "writer.mjs": "import {api} from './producer.mjs'; api.probe = () => true;",
    "consumer.mjs": "import {api} from './producer.mjs'; function newProbe(pid) { api.probe(pid, 0); }"
  });
  assert.deepEqual(ordinaryWrite.kills, []);
  assert.deepEqual(ordinaryWrite.violations, []);

  const namespaceWrite = inventoryFiles({
    "producer.mjs": "export const api = {};",
    "writer.mjs": "import * as ns from './producer.mjs'; ns.api.probe = process.kill;",
    "consumer.mjs": "import {api} from './producer.mjs'; function newProbe(pid) { api.probe(pid, 0); }"
  });
  assert.equal(namespaceWrite.kills.length, 1);
  assert.deepEqual(namespaceWrite.violations, ["unclassified process probe consumer.mjs:newProbe"]);
});

test("nested exported binding patterns preserve property and array slots", () => {
  for (const producer of [
    "export const [, [probe]] = [, [process.kill]];",
    "export const {api: {probe}} = {api: {probe: process.kill}};"
  ]) {
    const result = inventoryFiles({
      "consumer.mjs": "import {probe} from './producer.mjs'; function newProbe(pid) { probe(pid, 0); }",
      "producer.mjs": producer
    });
    assert.equal(result.kills.length, 1);
    assert.deepEqual(result.violations, ["unclassified process probe consumer.mjs:newProbe"]);
  }
});

test("module export branches use finite truthiness", () => {
  const result = inventoryFiles({
    "consumer.cjs": "const api = require('./producer.cjs'); function newProbe(pid) { api.probe(pid, 0); }",
    "producer.cjs": "const enabled = 0; if (enabled) exports.probe = process.kill; else exports.probe = () => true;"
  });
  assert.deepEqual(result.kills, []);
  assert.deepEqual(result.violations, []);
});

test("Object.assign ignores block-scoped Object aliases", () => {
  const result = inventoryFiles({
    "consumer.cjs": "const api = require('./producer.cjs'); function newProbe(pid) { api.probe(pid, 0); }",
    "producer.cjs": "{ const Object = {assign() {}}; Object.assign(module.exports, {probe: process.kill}); } exports.probe = () => true;"
  });
  assert.deepEqual(result.kills, []);
  assert.deepEqual(result.violations, []);
});

test("exported object spreads honor later property definitions", () => {
  for (const producer of [
    "const defaults = {probe: process.kill}; export const api = {...defaults, probe: () => true};",
    "const safe = {probe: () => true}; export const api = {probe: process.kill, ...safe};",
    "const defaults = {probe: process.kill}; const safe = {probe: undefined}; export const api = {probe: process.kill, ...safe};"
  ]) {
    const result = inventoryFiles({
      "consumer.mjs": "import {api} from './producer.mjs'; function newProbe(pid) { api.probe(pid, 0); }",
      "producer.mjs": producer
    });
    assert.deepEqual(result.kills, [], producer);
    assert.deepEqual(result.violations, [], producer);
  }
});

test("imported classes resolve finite computed property names", () => {
  const result = inventoryFiles({
    "consumer.mjs": "import {Api} from './producer.mjs'; function newProbe(pid) { new Api().probe(pid, 0); }",
    "producer.mjs": "const key = 'probe'; export class Api { [key] = process.kill; }"
  });
  assert.equal(result.kills.length, 1);
  assert.deepEqual(result.violations, ["unclassified process probe consumer.mjs:newProbe"]);
});

test("imported callable returns include bound arguments", () => {
  const result = inventoryFiles({
    "consumer.mjs": "import {identity} from './producer.mjs'; const getProbe = identity.bind(null, process.kill); const probe = getProbe(); function newProbe(pid) { probe(pid, 0); }",
    "producer.mjs": "export function identity(value) { return value; }"
  });
  assert.equal(result.kills.length, 1);
  assert.deepEqual(result.violations, ["unclassified process probe consumer.mjs:newProbe"]);
});

test("logical AND excludes statically unreachable probes and keeps unknowns", () => {
runFixture("const probe = false && process.kill || (() => true); function newProbe(pid) { probe(pid, 0); }", [], []);
runFixture("const probe = true && process.kill; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
runFixture("const probe = condition && process.kill; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("finite dynamic import aliases preserve local module probes", () => {
  for (const specifier of ["'./producer.mjs'", "`./producer.mjs`"]) {
    const result = inventoryFiles({
      "consumer.mjs": `const spec = ${specifier}; const api = await import(spec); function newProbe(pid) { api.probe(pid, 0); }`,
      "producer.mjs": "export const probe = process.kill;"
    });
    assert.equal(result.kills.length, 1);
    assert.deepEqual(result.violations, ["unclassified process probe consumer.mjs:newProbe"]);
  }

  const unresolved = inventoryFiles({
    "consumer.mjs": "const spec = chooseModule(); const api = await import(spec); function newProbe(pid) { api.probe(pid, 0); }"
  });
  assert.deepEqual(unresolved.kills, []);
  assert.deepEqual(unresolved.violations, []);
});

test("static-block probe inventory remains correct through a wrapped call", () => {
  const probe = inventoryFiles({
    "private-alias.js": "class Api { static { this.probe = process.kill; } } function wrapped(pid) { Api.probe(pid, 0); }"
  });
  assert.equal(probe.kills.length, 1);
  assert.deepEqual(probe.violations, ["unclassified process probe private-alias.js:wrapped"]);

  const ordinary = inventoryFiles({
    "private-alias.js": "class Api { static { this.probe = () => true; } } function wrapped(pid) { Api.probe(pid, 0); }"
  });
  assert.deepEqual(ordinary.kills, []);
  assert.deepEqual(ordinary.violations, []);
});

test("same-name lexical shadow of an alias is not a probe", () => {
runFixture("let probe = process.kill; function newProbe(pid) { let probe = () => true; probe(pid, 0); }", [], []);
runFixture("let process = { kill() {} }; function newProbe(pid) { process.kill(pid, 0); }", [], []);
});

test("ordinary mutable function reassignment without process.kill stays ordinary", () => {
runFixture("let probe = () => true; probe = () => false; function newProbe(pid) { probe(pid, 0); }", [], []);
runFixture("let probe = process.kill; probe = () => true; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("cyclic aliases terminate without crash", () => {
runFixture("let a = b; let b = a; function newProbe(pid) { b(pid, 0); }", [], []);
});

test("cycle with a probe-valued assignment still yields the kill and violation", () => {
runFixture("let a = b; let b = a; a = process.kill; function newProbe(pid) { b(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("uninitialized never-assigned alias is empty and not classified by name", () => {
runFixture("let probe; function newProbe(pid) { probe(pid, 0); }", [], []);
runFixture("let process; function newProbe(pid) { process.kill(pid, 0); }", [], []);
});

test("probe alias reassigned an unknown value retains a potential probe", () => {
runFixture("let probe = process.kill; probe = makeUnknown(); function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("detected-but-unsupported probe source still counts as a kill", () => {
runFixture("const probe = process.kill; function newProbe(pid) { probe.call(null, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
runFixture("function newProbe(pid) { process.kill.apply(null, [pid, 0]); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
runFixture("const probe = process.kill.bind(null); function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("static element key resolves process kill", () => {
runFixture("const key = 'kill'; function newProbe(pid) { process[key](pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("static element assignment retains process kill", () => {
  runFixture("const state = {}; state['probe'] = process.kill; function newProbe(pid) { state['probe'](pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const key = 'probe'; const state = {}; state[key] = process.kill; function newProbe(pid) { state[key](pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("let key; key = 'probe'; const state = {}; state[key] = process.kill; function newProbe(pid) { state[key](pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("let key; key = 'probe'; const state = {}; state[key] = process.kill; function newProbe(pid) { state.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("comma aliases resolve their final operand", () => {
  runFixture("const probe = (sideEffect(), process.kill); function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("finite reducer callbacks preserve process probe inventory", () => {
  const reduced = inventoryFiles({
    "private-alias.js": "function newProbe(pid) { [pid, 0].reduce(process.kill); }"
  });
  assert.equal(reduced.kills.length, 1);

  const reversed = inventoryFiles({
    "private-alias.js": "function newProbe(pid) { [0, pid].reduceRight(process.kill); }"
  });
  assert.equal(reversed.kills.length, 1);

  const noCallback = inventoryFiles({
    "private-alias.js": "function newProbe(pid) { [pid].reduce(process.kill); }"
  });
  assert.deepEqual(noCallback.kills, []);
});

test("computed timer method aliases preserve forwarded probe inventory", () => {
  const result = inventoryFiles({
    "private-alias.js": "const timers = require('node:timers'); const method = 'setImmediate'; function newProbe(pid) { timers[method](process.kill, pid, 0); }"
  });
  assert.equal(result.kills.length, 1);
});

test("super constructor arguments bind to base probe parameters", () => {
  const result = inventoryFiles({
    "private-alias.js": "class Base { constructor(probe, pid) { probe(pid, 0); } } class Child extends Base { constructor() { super(process.kill, 1); } } new Child();"
  });
  assert.equal(result.kills.length, 1);
});

test("TypeScript parameter properties retain defaults and constructor arguments", () => {
  const withDefault = inventoryFiles({
    "private-alias.ts": "class Check { constructor(private probe = process.kill) {} run(pid: number) { this.probe(pid, 0); } }"
  });
  assert.equal(withDefault.kills.length, 1);

  const withArgument = inventoryFiles({
    "private-alias.ts": "class Check { constructor(private probe: any) {} run(pid: number) { this.probe(pid, 0); } } new Check(process.kill);"
  });
  assert.equal(withArgument.kills.length, 1);
});

test("declared production probe inventory remains valid", () => {
const result = inventoryProcessOwnerSites(SRC_ROOT);
assert.equal(result.kills.length, 8);
assert.deepEqual(result.legacyCalls, []);
assert.deepEqual(result.violations, []);
});

test("bound call invocation refuses", () => {
  runFixture("const invoke = process.kill.call.bind(process.kill); function newProbe(pid) { invoke(null, pid, 0); }", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("logical member assignment probe alias", () => {
  runFixture("const obj = { probe: undefined }; obj.probe ??= process.kill; function newProbe(pid) { obj.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const obj = { probe: undefined }; obj.probe ||= process.kill; function newProbe(pid) { obj.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("known member values prune unreachable logical assignment probes", () => {
  runFixture("const api = { probe: () => true }; api.probe ||= process.kill; function newProbe(pid) { api.probe(pid, 0); }", [], []);
  runFixture("const api = getApi(); api.probe ||= process.kill; function newProbe(pid) { api.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const process = { kill() {} }; const api = { probe: () => true }; api.probe ||= process.kill; function newProbe(pid) { api.probe(pid, 0); }", [], []);
});

test("array rest bindings retain indexed process probe provenance", () => {
  runFixture("const [...probes] = [process.kill]; function newProbe(pid) { probes[0](pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const [skip, ...probes] = [0, process.kill]; function newProbe(pid) { probes[0](pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const [...probes] = [() => true]; function newProbe(pid) { probes[0](pid, 0); }", [], []);
  runFixture("const source = getProbes(); const [...probes] = source; function newProbe(pid) { probes[0](pid, 0); }", [], []);
});

test("immediately invoked callable returns retain process probe provenance", () => {
  runFixture("const probe = (() => process.kill)(); function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const probe = (() => () => true)(); function newProbe(pid) { probe(pid, 0); }", [], []);
  runFixture("const process = { kill() {} }; const probe = (() => process.kill)(); function newProbe(pid) { probe(pid, 0); }", [], []);
});

test("finite CommonJS specifier values retain local module provenance", () => {
  const aliasedSpecifier = inventoryFiles({
    "private-alias.js": "const spec = './producer'; const api = require(spec); function newProbe(pid) { api.probe(pid, 0); }",
    "producer.cjs": "exports.probe = process.kill;"
  });
  assert.deepEqual(aliasedSpecifier.kills, ["private-alias.js\u0000newProbe"]);
  assert.deepEqual(aliasedSpecifier.violations, ["unclassified process probe private-alias.js:newProbe"]);

  const templateSpecifier = inventoryFiles({
    "private-alias.js": "const spec = `./producer`; const api = require(spec); function newProbe(pid) { api.probe(pid, 0); }",
    "producer.cjs": "exports.probe = process.kill;"
  });
  assert.deepEqual(templateSpecifier.kills, ["private-alias.js\u0000newProbe"]);
  assert.deepEqual(templateSpecifier.violations, ["unclassified process probe private-alias.js:newProbe"]);

  runFixture("const spec = getProducerPath(); const api = require(spec); function newProbe(pid) { api.probe(pid, 0); }", [], []);
});

test("native Promise rejection handlers are inventoried", () => {
  runFixture("function newProbe(pid) { Promise.resolve(Promise.reject(pid)).then(undefined, process.kill); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid) { Promise.resolve(Promise.reject(pid)).then(undefined, reason => reason); }", [], []);
  runFixture("function newProbe(pid) { Promise.reject(pid).catch(process.kill); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid) { const Promise = {reject: value => ({catch: callback => true})}; Promise.reject(pid).catch(process.kill); }", [], []);
});

test("static template eval source is parsed without evaluating it", () => {
  runFixture("function newProbe(pid) { eval(`process.kill(pid, 0)`); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid) { eval(`const value = 1`); }", [], []);
  runFixture("function newProbe(pid, source) { eval(`process.kill(${source}, 0)`); }", [], []);
});

test("native Promise catch handlers are inventoried", () => {
  runFixture("function newProbe(pid) { Promise.resolve(Promise.reject(pid)).catch(process.kill); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid) { Promise.resolve(Promise.reject(pid)).catch(reason => reason); }", [], []);
});

test("native Promise identity survives supported method chains", () => {
  runFixture("function newProbe(pid) { Promise.resolve(pid).then(value => value).then(process.kill); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid) { const Promise = {resolve: value => ({then: callback => callback(value)})}; Promise.resolve(pid).then(value => value).then(process.kill); }", [], []);
  runFixture("function newProbe(pid) { const custom = {then(callback) { return true; }}; custom.then(process.kill); }", [], []);
});

test("Object.defineProperties descriptors preserve probe aliases", () => {
  runFixture("const api = {}; Object.defineProperties(api, { probe: { value: process.kill } }); function newProbe(pid) { api.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const api = {}; Object.defineProperties(api, { probe: { value: () => true } }); function newProbe(pid) { api.probe(pid, 0); }", [], []);
  runFixture("const api = {}; Object.defineProperty(api, 'probe', { get() { return process.kill; } }); function newProbe(pid) { api.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const api = {}; Object.defineProperties(api, { probe: { get() { return process.kill; } } }); function newProbe(pid) { api.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("timer namespace imports forward callbacks", () => {
  runFixture("import * as timers from 'node:timers'; function newProbe(pid) { timers.setImmediate(process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("import * as timers from 'node:timers'; function newProbe(pid) { timers.setImmediate(() => true, pid, 0); }", [], []);
});

test("getter return traversal includes conditional branches", () => {
  runFixture("const api = { get probe() { if (flag) return process.kill; return () => true; } }; function newProbe(pid) { api.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const api = { get probe() { if (flag) return () => true; return () => false; } }; function newProbe(pid) { api.probe(pid, 0); }", [], []);
});

test("constructor callable and object returns preserve probe aliases", () => {
  runFixture("function Factory() { return process.kill; } const probe = new Factory(); function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function Factory() { return { probe: process.kill }; } const api = new Factory(); function newProbe(pid) { api.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function Factory() { return 1; } const probe = new Factory(); function newProbe(pid) { probe(pid, 0); }", [], []);
  runFixture("function Factory() { return true ? (() => true) : process.kill; } const probe = new Factory(); function newProbe(pid) { probe(pid, 0); }", [], []);
  runFixture("function Factory() { return condition ? (() => true) : process.kill; } const probe = new Factory(); function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);

  const importedCallable = inventoryFiles({
    "private-alias.js": "import { Factory } from './factory'; const probe = new Factory(); function newProbe(pid) { probe(pid, 0); }",
    "factory.js": "export function Factory() { return process.kill; }"
  });
  assert.deepEqual(importedCallable.kills, ["private-alias.js\u0000newProbe"]);
  assert.deepEqual(importedCallable.violations, ["unclassified process probe private-alias.js:newProbe"]);

  const importedObject = inventoryFiles({
    "private-alias.js": "import { Factory } from './factory'; const api = new Factory(); function newProbe(pid) { api.probe(pid, 0); }",
    "factory.js": "export function Factory() { return { probe: process.kill }; }"
  });
  assert.deepEqual(importedObject.kills, ["private-alias.js\u0000newProbe"]);
  assert.deepEqual(importedObject.violations, ["unclassified process probe private-alias.js:newProbe"]);

  const importedOrdinary = inventoryFiles({
    "private-alias.js": "import { Factory } from './factory'; const probe = new Factory(); function newProbe(pid) { probe(pid, 0); }",
    "factory.js": "export function Factory() { return () => true; }"
  });
  assert.deepEqual(importedOrdinary.kills, []);
  assert.deepEqual(importedOrdinary.violations, []);
});
