'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runFixture, runFilesFixture, inventoryProcessOwnerSites, SRC_ROOT } =
  require('./public-inventory-fixtures.cjs');

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

test("constructor arguments populate function parameters", () => {
  runFixture("function Runner(probe, pid) { probe(pid, 0); } new Runner(process.kill, 1234);", ["private-alias.js\u0000Runner"], ["unclassified process probe private-alias.js:Runner"]);
});
