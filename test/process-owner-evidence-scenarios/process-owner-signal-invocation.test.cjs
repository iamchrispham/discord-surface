'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runFixture, runFilesFixture, inventoryProcessOwnerSites, SRC_ROOT } =
  require('./public-inventory-fixtures.cjs');

test("let zero signal alias", () => {
runFixture("let signal = 0; function newProbe(pid) { process.kill(pid, signal); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("nonzero signal and ordinary mutable function are not probes", () => {
runFixture("function newProbe(pid) { process.kill(pid, 9); }", [], []);
runFixture("function newProbe(pid) { process.kill(pid, `SIGTERM`); }", [], []);
runFixture("let probe = () => true; function newProbe(pid) { probe(pid, 0); }", [], []);
});

test("mutable nonzero-only signal stays ordinary", () => {
runFixture("let signal = 9; function newProbe(pid) { process.kill(pid, signal); }", [], []);
runFixture("let signal = 9; signal = 10; function newProbe(pid) { process.kill(pid, signal); }", [], []);
});

test("zero signal alias retains a possible zero across reassignment", () => {
  runFixture("let signal = 0; signal = makeUnknown(); function newProbe(pid) { process.kill(pid, signal); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe", "unsupported process probe private-alias.js:newProbe"]);
  runFixture("let signal = 0; signal = 9; function newProbe(pid) { process.kill(pid, signal); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("default zero signal", () => {
  runFixture("function newProbe(pid, signal = 0) { process.kill(pid, signal); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("nonliteral apply list refuses", () => {
  runFixture("function newProbe(pid) { const args = [pid, 0]; process.kill.apply(null, args); }", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("arguments apply refuses", () => {
  runFixture("function newProbe(pid, signal = 0) { process.kill.apply(null, arguments); }", [], ["unsupported process probe private-alias.js:newProbe"]);
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

test("nonzero default signal stays empty", () => {
  runFixture("function newProbe(pid, signal = 9) { process.kill(pid, signal); }", [], []);
});

test("bound apply invocation refuses", () => {
  runFixture("const invoke = process.kill.apply.bind(process.kill); function newProbe(pid) { invoke(null, [pid, 0]); }", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("partially bound process kill refuses", () => {
  runFixture("function newProbe(pid) { const probe = process.kill.bind(null, pid); probe(0); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid) { const probe = process.kill.bind(null, pid); probe.call(null, 0); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid) { const probe = process.kill.bind(null, pid); probe.apply(null, [0]); }", [], ["unsupported process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid) { const probe = process.kill.bind(null, pid); const next = probe.bind(null); next(0); }", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("absent apply list refuses", () => {
  runFixture("function newProbe(pid) { process.kill.apply(null); }", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("ordinary bound apply stays empty", () => {
  runFixture("const ordinary = () => true; const invoke = ordinary.apply.bind(ordinary); function newProbe(pid) { invoke(null, [pid, 0]); }", [], []);
});

test("explicit nonzero apply signal stays empty", () => {
  runFixture("function newProbe(pid) { process.kill.apply(null, [pid, 9]); }", [], []);
});

test("unresolved call signal refuses", () => {
  runFixture("function newProbe(pid, signal) { process.kill.call(null, pid, signal); }", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("apply alias through call refuses", () => {
  runFixture("const invoke=process.kill.apply;function newProbe(pid){invoke.call(process.kill,null,[pid,0]);}", [], ["unsupported process probe private-alias.js:newProbe"]);
});

test("call alias through apply refuses", () => {
  runFixture("const invoke=process.kill.call;function newProbe(pid){invoke.apply(process.kill,[null,pid,0]);}", [], ["unsupported process probe private-alias.js:newProbe"]);
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

test("legacy owner identity survives invocation methods", () => {
  const expectedLegacy = ["private-alias.js\u0000newProbe"];
  const expectedViolation = ["legacy directPostOwnerAlive callsite private-alias.js:newProbe"];
  runFixture("const state = { directPostOwnerAlive }; function newProbe(pid, identity) { state.directPostOwnerAlive.call(state, pid, identity); }", [], expectedViolation, 'private-alias.js', expectedLegacy);
  runFixture("const state = { directPostOwnerAlive }; function newProbe(pid, identity) { state.directPostOwnerAlive.apply(state, [pid, identity]); }", [], expectedViolation, 'private-alias.js', expectedLegacy);
  runFixture("const state = { directPostOwnerAlive }; function newProbe(pid, identity) { state.directPostOwnerAlive.bind(state)(pid, identity); }", [], expectedViolation, 'private-alias.js', expectedLegacy);
});
