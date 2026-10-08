'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runFixture, runFilesFixture, inventoryProcessOwnerSites, SRC_ROOT } =
  require('./public-inventory-fixtures.cjs');

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

test("for-of targets resolve finite array aliases and spreads", () => {
  runFixture(
    "const probes = [process.kill]; function check(pid) { for (const probe of probes) probe(pid, 0); }",
    ["private-alias.js\u0000check"],
    ["unclassified process probe private-alias.js:check"]
  );
  runFixture(
    "const probes = [process.kill]; const candidates = [...probes]; function check(pid) { for (const probe of candidates) probe(pid, 0); }",
    ["private-alias.js\u0000check"],
    ["unclassified process probe private-alias.js:check"]
  );
});

test("nullish fallbacks exclude unreachable probe operands", () => {
  runFixture(
    "const ordinary = () => true; const probe = ordinary ?? process.kill; probe(1, 0);",
    [],
    []
  );
  runFixture(
    "const ordinary = undefined; const probe = ordinary ?? process.kill; probe(1, 0);",
    ["private-alias.js\u0000null"],
    ["unclassified process probe private-alias.js:null"]
  );
});

test("computed properties retain every finite key candidate", () => {
  runFixture(
    "const key = flag ? 'other' : 'probe'; const api = { [key]: process.kill }; function check(pid) { api.probe(pid, 0); }",
    ["private-alias.js\u0000check"],
    ["unclassified process probe private-alias.js:check"]
  );
});

test("extracted method aliases retain their callable parameters", () => {
  runFixture(
    "const api = { invoke(probe, pid) { probe(pid, 0); } }; const run = api.invoke; run(process.kill, 1);",
    ["private-alias.js\u0000invoke"],
    ["unclassified process probe private-alias.js:invoke"]
  );
});

test("parameter defaults apply only when arguments are omitted or undefined", () => {
  runFixture(
    "function invoke(probe = process.kill, pid) { probe(pid, 0); } invoke(() => true, 1);",
    [],
    []
  );
  runFixture(
    "function invoke(probe = process.kill, pid) { probe(pid, 0); } invoke(undefined, 1);",
    ["private-alias.js\u0000invoke"],
    ["unclassified process probe private-alias.js:invoke"]
  );
  runFixture(
    "function invoke(probe = process.kill, pid) { probe(pid, 0); } invoke();",
    ["private-alias.js\u0000invoke"],
    ["unclassified process probe private-alias.js:invoke"]
  );
});
