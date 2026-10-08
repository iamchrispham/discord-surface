'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runFixture, runFilesFixture, inventoryProcessOwnerSites, SRC_ROOT } =
  require('./public-inventory-fixtures.cjs');

test("default probe function", () => {
  runFixture("function newProbe(pid, probe = process.kill) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("default process object", () => {
  runFixture("function newProbe(pid, proc = process) { proc.kill(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
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

test("ordinary default function stays empty", () => {
  runFixture("function newProbe(pid, probe = () => true) { probe(pid, 0); }", [], []);
});

test("object-valued call arguments preserve property probe origins", () => {
  runFixture(
    "function invoke(opts, pid) { opts.probe(pid, 0); } invoke({ probe: process.kill }, 1);",
    ["private-alias.js\u0000invoke"],
    ["unclassified process probe private-alias.js:invoke"]
  );
});

test("callable arguments remain correlated by invocation", () => {
  runFixture(
    "function ordinary() { return true; } function invoke(probe, signal) { probe(1, signal); } invoke(process.kill, 9); invoke(ordinary, 0);",
    [],
    []
  );
});

test("process nextTick aliases forward callback arguments", () => {
  runFixture(
    "const next = process.nextTick; next(process.kill, 1, 0);",
    ["private-alias.js\u0000null"],
    ["unclassified process probe private-alias.js:null"]
  );
});

test("reverse-search array callbacks forward probe arguments", () => {
  for (const method of ["findLast", "findLastIndex"]) {
    runFixture(
      `[1].${method}(process.kill);`,
      ["private-alias.js\u0000null"],
      ["unclassified process probe private-alias.js:null"]
    );
  }
});

test("for-of object and array destructuring project probe properties", () => {
  runFixture(
    "for (const { probe } of [{ probe: process.kill }]) probe(1, 0);",
    ["private-alias.js\u0000null"],
    ["unclassified process probe private-alias.js:null"]
  );
  runFixture(
    "for (const [probe] of [[process.kill]]) probe(1, 0);",
    ["private-alias.js\u0000null"],
    ["unclassified process probe private-alias.js:null"]
  );
});
