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

test("nested destructuring assignments preserve probe paths", () => {
  runFixture(
    "let probe; ({ x: { probe } } = { x: { probe: process.kill } }); probe(123, 0);",
    ["private-alias.js\u0000null"],
    ["unclassified process probe private-alias.js:null"]
  );
});

test("object-valued callable returns preserve probe properties", () => {
  runFixture(
    "function make() { return { probe: process.kill }; } function check(pid) { make().probe(pid, 0); } check(1);",
    ["private-alias.js\u0000check"],
    ["unclassified process probe private-alias.js:check"]
  );
});

test("Reflect.apply refuses probe arguments passed to callable helpers", () => {
  runFixture(
    "function invoke(probe, pid) { probe(pid, 0); } function check(pid) { Reflect.apply(invoke, null, [process.kill, pid]); } check(1);",
    [],
    ["unsupported process probe private-alias.js:check"]
  );
});

test("borrowed finite-array callback methods resolve probes", () => {
  for (const invocation of [
    "Array.prototype.map.call([pid], process.kill);",
    "Array.prototype.map.apply([pid], [process.kill]);"
  ]) {
    runFixture(
      `function check(pid) { ${invocation} } check(1);`,
      ["private-alias.js\u0000check"],
      ["unclassified process probe private-alias.js:check"]
    );
  }
});

test("borrowed reducer methods resolve callback signal positions", () => {
  for (const invocation of [
    "Array.prototype.reduce.call([pid, 0], process.kill);",
    "Array.prototype.reduceRight.call([0, pid], process.kill);",
    "Array.prototype.reduce.apply([pid, 0], [process.kill]);"
  ]) {
    runFixture(
      `function check(pid) { ${invocation} } check(1);`,
      ["private-alias.js\u0000check"],
      ["unclassified process probe private-alias.js:check"]
    );
  }
});

test("native Promise.then refuses destructive process-kill callbacks", () => {
  runFixture("Promise.resolve(pid).then(process.kill);", [], ["unsupported process probe private-alias.js:null"]);
  runFixture("function check(Promise) { Promise.resolve(pid).then(process.kill); }", [], []);
});

test("forwarded timer callbacks with default signals remain refused", () => {
  for (const invocation of [
    "setTimeout(process.kill, 1, pid);",
    "setTimeout(process.kill, 1, pid, undefined);"
  ]) {
    runFixture(
      `function check(pid) { ${invocation} } check(1);`,
      [],
      ["unsupported process probe private-alias.js:check"]
    );
  }
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

test("object-rest bindings retain only copied probe properties", () => {
  runFixture(
    "const { ...api } = { probe: process.kill }; api.probe(1, 0);",
    ["private-alias.js\u0000null"],
    ["unclassified process probe private-alias.js:null"]
  );
  runFixture("const { probe: ignored, ...api } = { probe: process.kill }; api.probe(1, 0);", [], []);
});
