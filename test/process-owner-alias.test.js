'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runFixture, runFilesFixture, inventoryProcessOwnerSites, SRC_ROOT } =
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

test("local process shadow is not a probe", () => {
runFixture("const process = { kill() {} }; function newProbe(pid) { process.kill(pid, 0); }", [], []);
});

test("mutable alias chains carry a potential probe", () => {
runFixture("let first = process.kill; let second = first; function newProbe(pid) { second(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
runFixture("let proc = process; let target = proc; function newProbe(pid) { target.kill(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
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
