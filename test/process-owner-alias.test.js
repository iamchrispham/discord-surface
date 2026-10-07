'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inventoryProcessOwnerSites, SRC_ROOT } = require('./process-owner-evidence-scenarios/source-inventory.cjs');

const runFixture = (source, expectedKills, expectedViolations, fileName = 'private-alias.js', expectedLegacyCalls = []) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-probe-alias-'));
  try {
    fs.writeFileSync(path.join(directory, fileName), source);
    const result = inventoryProcessOwnerSites(directory);
    assert.deepEqual(result.kills, expectedKills);
    assert.deepEqual(result.legacyCalls, expectedLegacyCalls);
    assert.deepEqual(result.violations, expectedViolations);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

const runFilesFixture = (files, expectedKills, expectedViolations, expectedLegacyCalls = []) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-probe-modules-'));
  try {
    for (const [fileName, source] of Object.entries(files)) {
      const fullPath = path.join(directory, fileName);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, source);
    }
    const result = inventoryProcessOwnerSites(directory);
    assert.deepEqual(result.kills, expectedKills);
    assert.deepEqual(result.legacyCalls, expectedLegacyCalls);
    assert.deepEqual(result.violations, expectedViolations);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

test("let function alias", () => {
runFixture("let probe = process.kill; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("var function alias", () => {
runFixture("var probe = process.kill; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("let process object alias", () => {
runFixture("let proc = process; function newProbe(pid) { proc.kill(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("let destructured probe alias", () => {
runFixture("let { kill: probe } = process; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("let zero signal alias", () => {
runFixture("let signal = 0; function newProbe(pid) { process.kill(pid, signal); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
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

test("local process shadow is not a probe", () => {
runFixture("const process = { kill() {} }; function newProbe(pid) { process.kill(pid, 0); }", [], []);
});

test("nonzero signal and ordinary mutable function are not probes", () => {
runFixture("function newProbe(pid) { process.kill(pid, 9); }", [], []);
runFixture("function newProbe(pid) { process.kill(pid, `SIGTERM`); }", [], []);
runFixture("let probe = () => true; function newProbe(pid) { probe(pid, 0); }", [], []);
});

test("mutable alias chains carry a potential probe", () => {
runFixture("let first = process.kill; let second = first; function newProbe(pid) { second(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
runFixture("let proc = process; let target = proc; function newProbe(pid) { target.kill(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("same-name lexical shadow of an alias is not a probe", () => {
runFixture("let probe = process.kill; function newProbe(pid) { let probe = () => true; probe(pid, 0); }", [], []);
runFixture("let process = { kill() {} }; function newProbe(pid) { process.kill(pid, 0); }", [], []);
});

test("mutable nonzero-only signal stays ordinary", () => {
runFixture("let signal = 9; function newProbe(pid) { process.kill(pid, signal); }", [], []);
runFixture("let signal = 9; signal = 10; function newProbe(pid) { process.kill(pid, signal); }", [], []);
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

test("zero signal alias retains a possible zero across reassignment", () => {
  runFixture("let signal = 0; signal = makeUnknown(); function newProbe(pid) { process.kill(pid, signal); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe", "unsupported process probe private-alias.js:newProbe"]);
  runFixture("let signal = 0; signal = 9; function newProbe(pid) { process.kill(pid, signal); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
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

test("declared production probe inventory remains valid", () => {
const result = inventoryProcessOwnerSites(SRC_ROOT);
assert.equal(result.kills.length, 8);
assert.deepEqual(result.legacyCalls, []);
assert.deepEqual(result.violations, []);
});

test("default probe function", () => {
  runFixture("function newProbe(pid, probe = process.kill) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("default process object", () => {
  runFixture("function newProbe(pid, proc = process) { proc.kill(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("default zero signal", () => {
  runFixture("function newProbe(pid, signal = 0) { process.kill(pid, signal); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("default destructured probe", () => {
  runFixture("function newProbe(pid, { kill: probe } = process) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("call arguments populate destructured parameters", () => {
  runFixture("function invoke({ kill: probe }, pid) { probe(pid, 0); } invoke(process, 1);", ["private-alias.js\u0000invoke"], ["unclassified process probe private-alias.js:invoke"]);
});

test("callable aliases retain function parameters", () => {
  runFixture("function invoke(probe, pid) { probe(pid, 0); } const run = invoke; run(process.kill, 1);", ["private-alias.js\u0000invoke"], ["unclassified process probe private-alias.js:invoke"]);
});

test("direct function and arrow expressions receive probe arguments", () => {
  runFixture("(function invoke(probe, pid) { probe(pid, 0); })(process.kill, 1);", ["private-alias.js\u0000invoke"], ["unclassified process probe private-alias.js:invoke"]);
  runFixture("((probe, pid) => { probe(pid, 0); })(process.kill, 1);", ["private-alias.js\u0000null"], ["unclassified process probe private-alias.js:null"]);
});

test("chained assignments retain the right-hand probe", () => {
  runFixture("let probe; let next; probe = next = process.kill; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("object property probes retain their literal origin", () => {
  runFixture("const deps = { kill: process.kill }; function newProbe(pid) { deps.kill(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("receiver parameter writes retain the concrete object identity", () => {
  runFixture("function install(receiver) { receiver.probe = process.kill; } const state = {}; install(state); function newProbe(pid) { state.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function install(receiver) { receiver.probe = () => true; } const state = {}; install(state); function newProbe(pid) { state.probe(pid, 0); }", [], []);
  runFixture("function install(receiver) { receiver.probe = process.kill; } const state = {}; install(state); function ordinary(pid) { state.probe(pid); }", [], []);
});

test("distinct class instances do not share member probe writes", () => {
  runFixture("class C { probe() {} } const a = new C(); const b = new C(); a.probe = process.kill; function check(pid) { b.probe(pid, 0); }", [], []);
});

test("class-field callables retain parameters and returned probe aliases", () => {
  runFixture("class Helpers { invoke = (probe, pid) => probe(pid, 0); } const helpers = new Helpers(); helpers.invoke(process.kill, 1);", ["private-alias.js\u0000invoke"], ["unclassified process probe private-alias.js:invoke"]);
  runFixture("class Helpers { invoke = (probe, pid) => probe(pid, 9); } const helpers = new Helpers(); helpers.invoke(process.kill, 1);", [], []);
  runFixture("class Helpers { invoke = (probe, pid) => probe(pid); } const helpers = new Helpers(); helpers.invoke(process.kill, 1);", [], []);
  runFixture("class Helpers { getProbe = () => process.kill; } const helpers = new Helpers(); function newProbe(pid) { helpers.getProbe()(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("class Helpers { identity = value => value; } const helpers = new Helpers(); const probe = helpers.identity(process.kill); function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("prototype writes apply to constructed class and function instances", () => {
  runFixture("class Runner {} Runner.prototype.probe = process.kill; function newProbe(pid) { new Runner().probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function Runner() {} Runner.prototype.probe = process.kill; function newProbe(pid) { new Runner().probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("class Runner {} Runner.prototype.probe = process.kill; const runner = new Runner(); function newProbe(pid) { runner.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function Runner() {} Runner.prototype.probe = process.kill; const runner = new Runner(); function newProbe(pid) { runner.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("object and class getters retain returned probe origins", () => {
  runFixture("const deps = { get probe() { return process.kill; } }; function newProbe(pid) { deps.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("class Helpers { get probe() { return process.kill; } } const deps = new Helpers(); function newProbe(pid) { deps.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const deps = { get probe() { return () => true; } }; function newProbe(pid) { deps.probe(pid, 0); }", [], []);
});

test("CommonJS process origins retain module and destructured probes", () => {
  runFixture("const processModule = require('node:process'); function newProbe(pid) { processModule.kill(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const { kill: probe } = require('node:process'); function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("ES module process origins retain namespace and named probes", () => {
  runFixture("import * as proc from 'node:process'; function newProbe(pid) { proc.kill(pid, 0); }", ["private-alias.ts\u0000newProbe"], ["unclassified process probe private-alias.ts:newProbe"], 'private-alias.ts');
  runFixture("import { kill as probe } from 'node:process'; function newProbe(pid) { probe(pid, 0); }", ["private-alias.ts\u0000newProbe"], ["unclassified process probe private-alias.ts:newProbe"], 'private-alias.ts');
  runFixture("import proc from 'node:process'; function newProbe(pid) { proc.kill(pid, 0); }", ["private-alias.ts\u0000newProbe"], ["unclassified process probe private-alias.ts:newProbe"], 'private-alias.ts');
  runFixture("import proc from 'process'; function newProbe(pid) { proc.kill(pid, 0); }", ["private-alias.ts\u0000newProbe"], ["unclassified process probe private-alias.ts:newProbe"], 'private-alias.ts');
});

test("TypeScript import-equals process origins retain process objects", () => {
  runFixture("import proc = require('node:process'); function newProbe(pid) { proc.kill(pid, 0); }", ["private-alias.ts\u0000newProbe"], ["unclassified process probe private-alias.ts:newProbe"], 'private-alias.ts');
  runFixture("import proc = require('process'); function newProbe(pid) { proc.kill(pid, 0); }", ["private-alias.ts\u0000newProbe"], ["unclassified process probe private-alias.ts:newProbe"], 'private-alias.ts');
});

test("array binding probes retain indexed process origins", () => {
  runFixture("const [probe] = [process.kill]; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function invoke([probe], pid) { probe(pid, 0); } invoke([process.kill], 1);", ["private-alias.js\u0000invoke"], ["unclassified process probe private-alias.js:invoke"]);
  runFixture("let probe; [probe] = [process.kill]; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("constructor arguments populate function parameters", () => {
  runFixture("function Runner(probe, pid) { probe(pid, 0); } new Runner(process.kill, 1234);", ["private-alias.js\u0000Runner"], ["unclassified process probe private-alias.js:Runner"]);
});

test("rest parameter elements retain argument provenance", () => {
  runFixture("function invoke(...args) { args[0](123, args[1]); } invoke(process.kill, 0);", ["private-alias.js\u0000invoke"], ["unclassified process probe private-alias.js:invoke"]);
});

test("finite spread aliases retain argument provenance", () => {
  runFixture(
    "function invoke(probe, pid) { probe(pid, 0); } const args = [process.kill, 1]; invoke(...args);",
    ["private-alias.js\u0000invoke"],
    ["unclassified process probe private-alias.js:invoke"]
  );
});

test("local module exports retain probe provenance across files", () => {
  runFilesFixture({
    'probe.js': "module.exports = { probe: process.kill };",
    'use.js': "const { probe } = require('./probe'); function newProbe(pid) { probe(pid, 0); }"
  }, ["use.js\u0000newProbe"], ["unclassified process probe use.js:newProbe"]);
  runFilesFixture({
    'probe.ts': "export const probe = process.kill;",
    'use.ts': "import { probe } from './probe'; function newProbe(pid) { probe(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'probe.ts': "export function getProbe() { return process.kill; }",
    'use.ts': "import { getProbe } from './probe'; function newProbe(pid) { getProbe()(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'probe.ts': "function getProbe() { return process.kill; } export { getProbe };",
    'use.ts': "import { getProbe } from './probe'; function newProbe(pid) { getProbe()(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'probe.ts': "export const identity = value => value;",
    'use.ts': "import { identity } from './probe'; function newProbe(pid) { identity(process.kill)(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'probe.ts': "export const probe = process.kill;",
    'ordinary.ts': "export const probe = () => true;",
    'barrel.ts': "export * from './probe'; export { probe } from './ordinary';",
    'use.ts': "import { probe } from './barrel'; function ordinary(pid) { probe(pid, 0); }"
  }, [], []);
  runFilesFixture({
    'probe.ts': "export const probe = process.kill;",
    'barrel.ts': "import { probe } from './probe'; export { probe };",
    'use.ts': "import { probe } from './barrel'; function newProbe(pid) { probe(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'probe.ts': "const probe = process.kill; export default probe;",
    'barrel.ts': "import probe from './probe'; export { probe };",
    'use.ts': "import { probe } from './barrel'; function newProbe(pid) { probe(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'probe.js': "const api = module.exports; api.probe = process.kill;",
    'use.js': "const { probe } = require('./probe'); function newProbe(pid) { probe(pid, 0); }"
  }, ["use.js\u0000newProbe"], ["unclassified process probe use.js:newProbe"]);
  runFilesFixture({
    'probe.ts': "export class Helpers { static probe = process.kill; }",
    'use.ts': "import { Helpers } from './probe'; function newProbe(pid) { Helpers.probe(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'probe.ts': "export class Helpers { probe = process.kill; }",
    'use.ts': "import { Helpers } from './probe'; const helpers = new Helpers(); function newProbe(pid) { helpers.probe(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'producer.js': "const api = { probe: process.kill }; module.exports = api;",
    'use.js': "const producer = require('./producer'); producer.probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    'producer.js': "const api = { probe: process.kill }; module.exports = api;",
    'use.js': "const { probe } = require('./producer'); probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    'probe.js': "export const probe = process.kill;",
    'producer.js': "export * as helpers from './probe.js';",
    'use.js': "import { helpers } from './producer.js'; helpers.probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    'producer.js': "export const identity = (value = process.kill) => value;",
    'use.js': "import { identity } from './producer.js'; identity()(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    'producer.js': "function ordinary() {} module.exports = { probe: ordinary }; exports = {}; exports.probe = process.kill;",
    'use.js': "const producer = require('./producer'); producer.probe(1, 0);"
  }, [], []);
  runFilesFixture({
    'producer.js': "const ordinary = () => true; let probe = ordinary; export default probe; probe = process.kill;",
    'use.js': "import probe from './producer.js'; probe(1, 0);"
  }, [], []);
  runFilesFixture({
    'producer.js': "const ordinary = () => true; let probe = ordinary; export { probe as default }; probe = process.kill;",
    'use.js': "import probe from './producer.js'; probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    'probe.ts': "const probe = process.kill; export = probe;",
    'use.ts': "import probe = require('./probe'); function newProbe(pid) { probe(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'producer.ts': "export function getProbe() { const process = { kill() {} }; return process.kill; }",
    'use.ts': "import { getProbe } from './producer'; function newProbe(pid) { getProbe()(pid, 0); }"
  }, [], []);
  runFilesFixture({
    'producer.ts': "const ordinary = () => true; export let probe = ordinary; { probe = process.kill; }",
    'use.ts': "import { probe } from './producer'; function newProbe(pid) { probe(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'producer.ts': "const ordinary = () => true; export const probe = Math.random() > 0.5 ? process.kill : ordinary;",
    'use.ts': "import { probe } from './producer'; function newProbe(pid) { probe(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'probe.cjs': "module.exports = process.kill;",
    'use.js': "const probe = require('./probe.cjs'); function newProbe(pid) { probe(pid, 0); }"
  }, ["use.js\u0000newProbe"], ["unclassified process probe use.js:newProbe"]);
  runFilesFixture({
    'producer.js': "export const getProbe = (value = process.kill) => value;",
    'use.js': "import { getProbe } from './producer.js'; getProbe(undefined)(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    'producer.js': "export function getProbe() { let probe; probe = process.kill; return probe; }",
    'use.js': "import { getProbe } from './producer.js'; getProbe()(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    'producer.js': "export class Runner { constructor(probe, pid) { probe(pid, 0); } }",
    'use.js': "import { Runner } from './producer.js'; new Runner(process.kill, 1);"
  }, [], ["unsupported process probe use.js:null"]);
  runFilesFixture({
    'probe/package.json': JSON.stringify({ main: 'owner.js' }),
    'probe/owner.js': "module.exports = process.kill;",
    'use.js': "const probe = require('./probe'); probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    'producer.js': "export const ownerAlive = ({ directPostOwnerAlive() {} }).directPostOwnerAlive;",
    'use.js': "import { ownerAlive } from './producer.js'; ownerAlive();"
  }, [], ["legacy directPostOwnerAlive callsite use.js:null"], ["use.js\u0000null"]);
});

test("destructuring defaults do not override present ordinary values", () => {
  runFixture("const ordinary = () => true; const { probe = process.kill } = { probe: ordinary }; function newProbe(pid) { probe(pid, 0); }", [], []);
  runFixture("function ordinary() {} const { probe = process.kill } = { probe: ordinary }; function newProbe(pid) { probe(pid, 0); }", [], []);
  runFixture("const ordinary = () => true; const [probe = process.kill] = [ordinary]; function newProbe(pid) { probe(pid, 0); }", [], []);
  runFixture("function ordinary() {} const [probe = process.kill] = [ordinary]; function newProbe(pid) { probe(pid, 0); }", [], []);
});

test("destructured probe invocation methods remain unsupported", () => {
  runFixture("const { call: invoke } = process.kill; function newProbe(pid) { invoke(process.kill, null, pid, 0); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("const { apply: invoke } = process.kill; function newProbe(pid) { invoke(process.kill, null, [pid, 0]); }", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("TypeScript-only wrappers retain probe identity", () => {
  const expectedKill = ["private-alias.ts\u0000newProbe"];
  const expectedViolation = ["unclassified process probe private-alias.ts:newProbe"];
  runFixture("const probe = process.kill as typeof process.kill; function newProbe(pid) { probe(pid, 0); }", expectedKill, expectedViolation, 'private-alias.ts');
  runFixture("const probe = process.kill satisfies typeof process.kill; function newProbe(pid) { probe(pid, 0); }", expectedKill, expectedViolation, 'private-alias.ts');
  runFixture("const probe = (process.kill)!; function newProbe(pid) { probe(pid, 0); }", expectedKill, expectedViolation, 'private-alias.ts');
  runFixture("const probe = <typeof process.kill>process.kill; function newProbe(pid) { probe(pid, 0); }", expectedKill, expectedViolation, 'private-alias.ts');
});

test("named default process imports retain process-object identity", () => {
  runFixture(
    "import { default as proc } from 'node:process'; function newProbe(pid) { proc.kill(pid, 0); }",
    ["private-alias.ts\u0000newProbe"],
    ["unclassified process probe private-alias.ts:newProbe"],
    'private-alias.ts'
  );
});

test("forwarded callback APIs retain process probes", () => {
  runFixture("function newProbe(pid) { setImmediate(process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid) { process.nextTick(process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function newProbe() { setTimeout(process.kill, 10, 1234, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function newProbe() { setInterval(process.kill, 10, 1234, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const schedule = setImmediate; function newProbe(pid) { schedule(process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("let schedule; schedule = setImmediate; function newProbe(pid) { schedule(process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const { setImmediate } = require('node:timers'); function newProbe(pid) { setImmediate(process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const { setImmediate: schedule } = require('timers'); function newProbe(pid) { schedule(process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const timers = require('node:timers'); function newProbe(pid) { timers.setImmediate(process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const timers = require('timers'); function newProbe(pid) { timers['setImmediate'](process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const setImmediate = () => {}; const schedule = setImmediate; function newProbe(pid) { schedule(process.kill, pid, 0); }", [], []);
  runFixture("import { setImmediate } from './transport.js'; function newProbe() { setImmediate(process.kill, 1234, 0); }", [], [], 'private-alias.ts');
});

test("nonliteral apply list refuses", () => {
  runFixture("function newProbe(pid) { const args = [pid, 0]; process.kill.apply(null, args); }", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("arguments apply refuses", () => {
  runFixture("function newProbe(pid, signal = 0) { process.kill.apply(null, arguments); }", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("destructuring assignment probe", () => {
  runFixture("let probe; ({ kill: probe } = process); function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("logical assignment probe alias", () => {
  runFixture("let probe; probe ??= process.kill; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("let probe; probe ||= process.kill; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("let probe = () => true; probe ||= process.kill; function newProbe(pid) { probe(pid, 0); }", [], []);
  runFixture("let probe = () => true; probe ??= process.kill; function newProbe(pid) { probe(pid, 0); }", [], []);
});

test("bounded Object.assign probe alias", () => {
  runFixture("const deps = {}; Object.assign(deps, { probe: process.kill }); function newProbe(pid) { deps.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const Object = { assign() {} }; const deps = {}; Object.assign(deps, { probe: process.kill }); function ordinary(pid) { deps.probe(pid, 0); }", [], []);
});

test("ordinary default function stays empty", () => {
  runFixture("function newProbe(pid, probe = () => true) { probe(pid, 0); }", [], []);
});

test("nonzero default signal stays empty", () => {
  runFixture("function newProbe(pid, signal = 9) { process.kill(pid, signal); }", [], []);
});

test("bound apply invocation refuses", () => {
  runFixture("const invoke = process.kill.apply.bind(process.kill); function newProbe(pid) { invoke(null, [pid, 0]); }", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("bound call invocation refuses", () => {
  runFixture("const invoke = process.kill.call.bind(process.kill); function newProbe(pid) { invoke(null, pid, 0); }", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("partially bound process kill refuses", () => {
  runFixture("function newProbe(pid) { const probe = process.kill.bind(null, pid); probe(0); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid) { const probe = process.kill.bind(null, pid); probe.call(null, 0); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid) { const probe = process.kill.bind(null, pid); probe.apply(null, [0]); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid) { const probe = process.kill.bind(null, pid); const next = probe.bind(null); next(0); }", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("destructured literal zero signal", () => {
  runFixture("const { signal } = { signal: 0 }; function newProbe(pid) { process.kill(pid, signal); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("destructured aliased literal zero signal", () => {
  runFixture("const values = { signal: 0 }; const { signal } = values; function newProbe(pid) { process.kill(pid, signal); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("absent apply list refuses", () => {
  runFixture("function newProbe(pid) { process.kill.apply(null); }", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("ordinary bound apply stays empty", () => {
  runFixture("const ordinary = () => true; const invoke = ordinary.apply.bind(ordinary); function newProbe(pid) { invoke(null, [pid, 0]); }", [], []);
});

test("destructured nonzero signal stays empty", () => {
  runFixture("const { signal } = { signal: 9 }; function newProbe(pid) { process.kill(pid, signal); }", [], []);
});

test("explicit nonzero apply signal stays empty", () => {
  runFixture("function newProbe(pid) { process.kill.apply(null, [pid, 9]); }", [], []);
});

test("unresolved call signal refuses", () => {
  runFixture("function newProbe(pid, signal) { process.kill.call(null, pid, signal); }", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("shorthand object alias zero", () => {
  runFixture("const signal=0;const values={signal};const {signal:s}=values;function newProbe(pid){process.kill(pid,s);}", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("direct shorthand origin zero", () => {
  runFixture("const signal=0;const {signal:s}={signal};function newProbe(pid){process.kill(pid,s);}", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("shorthand nonzero control", () => {
  runFixture("const signal=9;const values={signal};const {signal:s}=values;function newProbe(pid){process.kill(pid,s);}", [], []);
});

test("shorthand ordinary lexical control", () => {
  runFixture("const signal=0;function newProbe(pid){const signal=9;const {signal:s}={signal};process.kill(pid,s);}", [], []);
});

test("apply alias through call refuses", () => {
  runFixture("const invoke=process.kill.apply;function newProbe(pid){invoke.call(process.kill,null,[pid,0]);}", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("call alias through apply refuses", () => {
  runFixture("const invoke=process.kill.call;function newProbe(pid){invoke.apply(process.kill,[null,pid,0]);}", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("Reflect direct probe refuses", () => {
  runFixture("function newProbe(pid){Reflect.apply(process.kill,null,[pid,0]);}", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("Reflect probe alias refuses", () => {
  runFixture("const probe=process.kill;function newProbe(pid){Reflect.apply(probe,null,[pid,0]);}", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("Reflect callable origin survives finite wrappers", () => {
  runFixture("const invoke = Reflect.apply.bind(Reflect); function newProbe(pid) { invoke(process.kill, null, [pid, 0]); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("const invoke = Reflect.apply.call(Reflect); function newProbe(pid) { invoke(process.kill, null, [pid, 0]); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("const invoke = Reflect.apply.apply(Reflect, [Reflect]); function newProbe(pid) { invoke(process.kill, null, [pid, 0]); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("const { apply } = Reflect; function newProbe(pid) { apply(process.kill, null, [pid, 0]); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("const invoke = Reflect.apply.bind(Reflect, process.kill); function newProbe(pid) { invoke(null, [pid, 0]); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("const invoke = Reflect.apply.call; function newProbe(pid) { invoke(Reflect, process.kill, null, [pid, 0]); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("const invoke = Reflect.apply.apply; function newProbe(pid) { invoke(Reflect, [process.kill, null, [pid, 0]]); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("let invoke; ({ apply: invoke } = Reflect); function newProbe(pid) { invoke(process.kill, null, [pid, 0]); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("const invoke = Reflect.apply['bind'](Reflect); function newProbe(pid) { invoke(process.kill, null, [pid, 0]); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("const invoke = Reflect.apply['call'](Reflect); function newProbe(pid) { invoke(process.kill, null, [pid, 0]); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("const invoke = Reflect.apply['apply'](Reflect, [Reflect]); function newProbe(pid) { invoke(process.kill, null, [pid, 0]); }", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("nested Reflect target refuses", () => {
  runFixture("function newProbe(pid) { Reflect.apply(Reflect.apply, Reflect, [process.kill, null, [pid, 0]]); }", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("member calls and mutable properties retain finite probe facts", () => {
  runFixture("const helpers = { invoke(probe, pid) { probe(pid, 0); } }; helpers.invoke(process.kill, 1);", ["private-alias.js\u0000invoke"], ["unclassified process probe private-alias.js:invoke"]);
  runFixture("class Helpers { invoke(probe, pid) { probe(pid, 0); } } const helpers = new Helpers(); helpers.invoke(process.kill, 1);", ["private-alias.js\u0000invoke"], ["unclassified process probe private-alias.js:invoke"]);
  runFixture("const state = {}; const alias = state; alias.probe = process.kill; function newProbe(pid) { state.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const options = {}; options.signal = 9; function newProbe(pid) { process.kill(pid, options.signal); }", [], []);
  runFixture("const options = {}; options.signal = 'SIGTERM'; function newProbe(pid) { process.kill(pid, options.signal); }", [], []);
});

test("fallback and omitted signals stay ordinary", () => {
  runFixture("function newProbe(pid, signal) { process.kill(pid, signal || 'SIGTERM'); }", [], []);
  runFixture("function newProbe(pid) { process.kill(pid, 0 || 'SIGTERM'); }", [], []);
  runFixture("let signal = 0; signal = 9; function newProbe(pid) { process.kill(pid, signal || 'SIGTERM'); }", [], []);
  runFixture("function newProbe(pid) { process.kill(pid); }", [], []);
  runFixture("function newProbe(pid) { process.kill.call(null, pid); }", [], []);
  runFixture("function newProbe(pid) { process.kill.apply(null, [pid]); }", [], []);
  runFixture("function newProbe(pid) { process.kill.apply(null, [pid, undefined]); }", [], []);
  runFixture("function newProbe(pid) { process.kill(...[pid]); }", [], []);
  runFixture("const terminate = process.kill; function newProbe(pid) { terminate(pid); }", [], []);
});

test("unresolved direct signal refuses", () => {
  runFixture("function newProbe(pid, signal) { process.kill(pid, signal); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid, signal) { process.kill(pid, signal ?? 9); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid, signal) { process.kill(pid, signal && 9); }", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("logical member assignment probe alias", () => {
  runFixture("const obj = { probe: undefined }; obj.probe ??= process.kill; function newProbe(pid) { obj.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const obj = { probe: undefined }; obj.probe ||= process.kill; function newProbe(pid) { obj.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("object spreads retain statically resolvable probe properties", () => {
  runFixture("const base = { probe: process.kill }; const deps = { ...base }; function newProbe(pid) { deps.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const deps = { ...{ probe: process.kill } }; function newProbe(pid) { deps.probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const base = { probe: () => true }; const deps = { ...base }; function newProbe(pid) { deps.probe(pid, 0); }", [], []);
});

test("Reflect ordinary control", () => {
  runFixture("const ordinary=()=>true;function newProbe(pid){Reflect.apply(ordinary,null,[pid,0]);}", [], []);
});

test("Reflect lexical shadow control", () => {
  runFixture("const Reflect={apply(){}};function newProbe(pid){Reflect.apply(process.kill,null,[pid,0]);}", [], []);
});

test("finite resolver closes indirect probe gaps", () => {
  runFixture(
    "function newProbe(pid) { process.kill(...[pid, 0]); }",
    ["private-alias.js\u0000newProbe"],
    ["unclassified process probe private-alias.js:newProbe"]
  );
  runFixture(
    "function newProbe(pid) { const args = [pid, 0]; process.kill(...args); }",
    ["private-alias.js\u0000newProbe"],
    ["unclassified process probe private-alias.js:newProbe"]
  );
  runFixture(
    "function invoke(probe, pid) { probe(pid, 0); } let run; run = invoke; run(process.kill, 1);",
    ["private-alias.js\u0000invoke"],
    ["unclassified process probe private-alias.js:invoke"]
  );
  runFixture("function Runner(probe) {} new Runner;", [], []);
  runFixture("function newProbe(pid) { process.kill(pid, undefined); }", [], []);
  runFixture(
    "function identity(value) { return value; } const probe = identity(process.kill); function newProbe(pid) { probe(pid, 0); }",
    ["private-alias.js\u0000newProbe"],
    ["unclassified process probe private-alias.js:newProbe"]
  );
  runFixture(
    "const { tools: { kill: probe } } = { tools: process }; function newProbe(pid) { probe(pid, 0); }",
    ["private-alias.js\u0000newProbe"],
    ["unclassified process probe private-alias.js:newProbe"]
  );
  runFixture(
    "class Worker { probe = process.kill; check(pid) { this.probe(pid, 0); } } new Worker().check(1);",
    ["private-alias.js\u0000check"],
    ["unclassified process probe private-alias.js:check"]
  );
  runFixture(
    "const deps = [process.kill]; function newProbe(pid) { deps[0](pid, 0); }",
    ["private-alias.js\u0000newProbe"],
    ["unclassified process probe private-alias.js:newProbe"]
  );
  runFixture(
    "function newProbe(pid) { globalThis.process.kill(pid, 0); } function otherProbe(pid) { global.process.kill(pid, 0); }",
    ["private-alias.js\u0000newProbe", "private-alias.js\u0000otherProbe"],
    ["unclassified process probe private-alias.js:newProbe", "unclassified process probe private-alias.js:otherProbe"]
  );
  runFixture(
    "declare const process: { kill(pid: number, signal: number): boolean }; function newProbe(pid: number) { process.kill(pid, 0); }",
    ["private-alias.ts\u0000newProbe"],
    ["unclassified process probe private-alias.ts:newProbe"],
    'private-alias.ts'
  );
});

test("forwarding and property uncertainty stay conservative", () => {
  runFixture(
    "import { setImmediate } from 'node:timers'; function newProbe() { setImmediate(process.kill, 1234, 0); }",
    ["private-alias.ts\u0000newProbe"],
    ["unclassified process probe private-alias.ts:newProbe"],
    'private-alias.ts'
  );
  runFixture(
    "import { setImmediate as schedule } from 'timers'; function newProbe() { schedule(process.kill, 1234, 0); }",
    ["private-alias.ts\u0000newProbe"],
    ["unclassified process probe private-alias.ts:newProbe"],
    'private-alias.ts'
  );
  runFixture(
    "const options = { signal: runtimeSignal() }; function newProbe(pid) { process.kill(pid, options.signal); } newProbe(1); options.signal = 9;",
    [],
    ["unsupported process probe private-alias.js:newProbe"]
  );
  runFixture(
    "const state = {}; const alias = state; const next = alias; next.probe = process.kill; function newProbe(pid) { state.probe(pid, 0); }",
    ["private-alias.js\u0000newProbe"],
    ["unclassified process probe private-alias.js:newProbe"]
  );
  runFixture(
    "class Helpers {} Helpers.probe = process.kill; function newProbe(pid) { Helpers.probe(pid, 0); }",
    ["private-alias.js\u0000newProbe"],
    ["unclassified process probe private-alias.js:newProbe"]
  );
  runFixture(
    "function invoke(probe, pid) { probe(pid, 0); } const api = { invoke }; api.invoke(process.kill, 1);",
    ["private-alias.js\u0000invoke"],
    ["unclassified process probe private-alias.js:invoke"]
  );
  runFixture(
    "function newProbe(pid, signal) { process.kill(pid, signal || 0); }",
    ["private-alias.js\u0000newProbe"],
    ["unclassified process probe private-alias.js:newProbe"]
  );
});

test("review regressions retain finite probe provenance", () => {
  runFixture(
    "function invoke(probe, pid) { probe(pid, 0); } invoke.call(null, process.kill, 1);",
    ["private-alias.js\u0000invoke"],
    ["unclassified process probe private-alias.js:invoke"]
  );
  runFixture(
    "function invoke(probe, pid) { probe(pid, 0); } invoke.apply(null, [process.kill, 1]);",
    ["private-alias.js\u0000invoke"],
    ["unclassified process probe private-alias.js:invoke"]
  );
  runFixture(
    "function invoke(probe, pid) { probe(pid, 0); } const run = invoke.bind(null); run.call(null, process.kill, 1);",
    ["private-alias.js\u0000invoke"],
    ["unclassified process probe private-alias.js:invoke"]
  );
  runFixture(
    "let probe; ({ kill: probe = () => true } = process); probe(1, 0);",
    ["private-alias.js\u0000null"],
    ["unclassified process probe private-alias.js:null"]
  );
  runFixture(
    "let probe; ([probe = () => true] = [process.kill]); probe(1, 0);",
    ["private-alias.js\u0000null"],
    ["unclassified process probe private-alias.js:null"]
  );
  runFixture(
    "function check(pid) { for (const probe of [process.kill]) probe(pid, 0); }",
    ["private-alias.js\u0000check"],
    ["unclassified process probe private-alias.js:check"]
  );
  runFixture(
    "let probe; function check(pid) { for (probe of [process.kill]) probe(pid, 0); }",
    ["private-alias.js\u0000check"],
    ["unclassified process probe private-alias.js:check"]
  );
  runFixture(
    "const key = 'kill'; const { [key]: probe } = process; probe(1, 0);",
    ["private-alias.js\u0000null"],
    ["unclassified process probe private-alias.js:null"]
  );
  runFixture(
    "async function check(pid) { const probe = await process.kill; probe(pid, 0); }",
    ["private-alias.js\u0000check"],
    ["unclassified process probe private-alias.js:check"]
  );
  runFixture(
    "class Runner { constructor(probe, pid) { probe(pid, 0); } } new Runner(process.kill, 1);",
    ["private-alias.js\u0000null"],
    ["unclassified process probe private-alias.js:null"]
  );
  runFixture(
    "const helpers = { call(probe, pid) { probe(pid, 0); } }; helpers.call(process.kill, 1);",
    ["private-alias.js\u0000call"],
    ["unclassified process probe private-alias.js:call"]
  );
  runFixture(
    "const helpers = { apply(probe, pid) { probe(pid, 0); } }; helpers.apply(process.kill, 1);",
    ["private-alias.js\u0000apply"],
    ["unclassified process probe private-alias.js:apply"]
  );
  runFixture(
    "const helpers = { bind(probe, pid) { probe(pid, 0); } }; helpers.bind(process.kill, 1);",
    ["private-alias.js\u0000bind"],
    ["unclassified process probe private-alias.js:bind"]
  );
  runFixture(
    "function check(pid) { [process.kill].forEach(probe => probe(pid, 0)); }",
    ["private-alias.js\u0000check"],
    ["unclassified process probe private-alias.js:check"]
  );
});

test("local module exports retain live and built-in origins", () => {
  runFilesFixture({
    "probe.js": "export let probe = () => true; probe = process.kill;",
    "use.js": "import { probe } from './probe.js'; probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    "probe.js": "module.exports = process.kill;",
    "use.js": "const probe = require('./probe'); probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    "probe.js": "const process = { kill() {} }; export const probe = process.kill;",
    "use.js": "import { probe } from './probe.js'; probe(1, 0);"
  }, [], []);
  runFilesFixture({
    "probe.js": "export const probe = process.kill;",
    "barrel.js": "export * from './probe.js';",
    "use.js": "import { probe } from './barrel.js'; probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    "probe.js": "import proc from 'node:process'; export const probe = proc.kill;",
    "use.js": "import { probe } from './probe.js'; probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    "probe.ts": "export const probe = process.kill;",
    "use.ts": "import { probe } from './probe.js'; probe(1, 0);"
  }, ["use.ts\u0000null"], ["unclassified process probe use.ts:null"]);
  runFilesFixture({
    "probe.js": "export const getProbe = () => process.kill;",
    "use.js": "import { getProbe } from './probe.js'; getProbe()(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    "probe.js": "exports = module.exports = process.kill;",
    "use.js": "const probe = require('./probe'); probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    "probe.js": "const require = () => ({ kill() {} }); export const probe = require('node:process').kill;",
    "use.js": "import { probe } from './probe.js'; probe(1, 0);"
  }, [], []);
});

test("legacy owner identity survives invocation methods", () => {
  const expectedLegacy = ["private-alias.js\u0000newProbe"];
  const expectedViolation = ["legacy directPostOwnerAlive callsite private-alias.js:newProbe"];
  runFixture("const state = { directPostOwnerAlive }; function newProbe(pid, identity) { state.directPostOwnerAlive.call(state, pid, identity); }", [], expectedViolation, 'private-alias.js', expectedLegacy);
  runFixture("const state = { directPostOwnerAlive }; function newProbe(pid, identity) { state.directPostOwnerAlive.apply(state, [pid, identity]); }", [], expectedViolation, 'private-alias.js', expectedLegacy);
  runFixture("const state = { directPostOwnerAlive }; function newProbe(pid, identity) { state.directPostOwnerAlive.bind(state)(pid, identity); }", [], expectedViolation, 'private-alias.js', expectedLegacy);
});
