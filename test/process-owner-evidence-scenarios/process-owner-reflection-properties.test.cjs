'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runFixture, runFilesFixture, inventoryProcessOwnerSites, SRC_ROOT } =
  require('./public-inventory-fixtures.cjs');

test("TypeScript-only wrappers retain probe identity", () => {
  const expectedKill = ["private-alias.ts\u0000newProbe"];
  const expectedViolation = ["unclassified process probe private-alias.ts:newProbe"];
  runFixture("const probe = process.kill as typeof process.kill; function newProbe(pid) { probe(pid, 0); }", expectedKill, expectedViolation, 'private-alias.ts');
  runFixture("const probe = process.kill satisfies typeof process.kill; function newProbe(pid) { probe(pid, 0); }", expectedKill, expectedViolation, 'private-alias.ts');
  runFixture("const probe = (process.kill)!; function newProbe(pid) { probe(pid, 0); }", expectedKill, expectedViolation, 'private-alias.ts');
  runFixture("const probe = <typeof process.kill>process.kill; function newProbe(pid) { probe(pid, 0); }", expectedKill, expectedViolation, 'private-alias.ts');
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
