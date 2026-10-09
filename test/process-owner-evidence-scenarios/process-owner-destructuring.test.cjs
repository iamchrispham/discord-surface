'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runFixture, runFilesFixture, inventoryProcessOwnerSites, SRC_ROOT } =
  require('./public-inventory-fixtures.cjs');

test("let destructured probe alias", () => {
runFixture("let { kill: probe } = process; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("default destructured probe", () => {
  runFixture("function newProbe(pid, { kill: probe } = process) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("call arguments populate destructured parameters", () => {
  runFixture("function invoke({ kill: probe }, pid) { probe(pid, 0); } invoke(process, 1);", ["private-alias.js\u0000invoke"], ["unclassified process probe private-alias.js:invoke"]);
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

test("array binding probes retain indexed process origins", () => {
  runFixture("const [probe] = [process.kill]; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function invoke([probe], pid) { probe(pid, 0); } invoke([process.kill], 1);", ["private-alias.js\u0000invoke"], ["unclassified process probe private-alias.js:invoke"]);
  runFixture("let probe; [probe] = [process.kill]; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("destructuring assignment probe", () => {
  runFixture("let probe; ({ kill: probe } = process); function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("destructured literal zero signal", () => {
  runFixture("const { signal } = { signal: 0 }; function newProbe(pid) { process.kill(pid, signal); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("destructured aliased literal zero signal", () => {
  runFixture("const values = { signal: 0 }; const { signal } = values; function newProbe(pid) { process.kill(pid, signal); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("destructured nonzero signal stays empty", () => {
  runFixture("const { signal } = { signal: 9 }; function newProbe(pid) { process.kill(pid, signal); }", [], []);
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
