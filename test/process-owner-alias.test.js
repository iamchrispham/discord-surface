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

test("array binding probes retain indexed process origins", () => {
  runFixture("const [probe] = [process.kill]; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function invoke([probe], pid) { probe(pid, 0); } invoke([process.kill], 1);", ["private-alias.js\u0000invoke"], ["unclassified process probe private-alias.js:invoke"]);
  runFixture("let probe; [probe] = [process.kill]; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("constructor arguments populate function parameters", () => {
  runFixture("function Runner(probe, pid) { probe(pid, 0); } new Runner(process.kill, 1234);", ["private-alias.js\u0000Runner"], ["unclassified process probe private-alias.js:Runner"]);
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

test("forwarded callback APIs retain process probes", () => {
  runFixture("function newProbe(pid) { setImmediate(process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid) { process.nextTick(process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function newProbe() { setTimeout(process.kill, 10, 1234, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function newProbe() { setInterval(process.kill, 10, 1234, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
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

test("ordinary nested Reflect target stays ordinary", () => {
  runFixture("function newProbe(pid) { Reflect.apply(Reflect.apply, Reflect, [process.kill, null, [pid, 0]]); }", [], []);
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

test("Reflect ordinary control", () => {
  runFixture("const ordinary=()=>true;function newProbe(pid){Reflect.apply(ordinary,null,[pid,0]);}", [], []);
});

test("Reflect lexical shadow control", () => {
  runFixture("const Reflect={apply(){}};function newProbe(pid){Reflect.apply(process.kill,null,[pid,0]);}", [], []);
});

test("legacy owner identity survives invocation methods", () => {
  const expectedLegacy = ["private-alias.js\u0000newProbe"];
  const expectedViolation = ["legacy directPostOwnerAlive callsite private-alias.js:newProbe"];
  runFixture("const state = { directPostOwnerAlive }; function newProbe(pid, identity) { state.directPostOwnerAlive.call(state, pid, identity); }", [], expectedViolation, 'private-alias.js', expectedLegacy);
  runFixture("const state = { directPostOwnerAlive }; function newProbe(pid, identity) { state.directPostOwnerAlive.apply(state, [pid, identity]); }", [], expectedViolation, 'private-alias.js', expectedLegacy);
  runFixture("const state = { directPostOwnerAlive }; function newProbe(pid, identity) { state.directPostOwnerAlive.bind(state)(pid, identity); }", [], expectedViolation, 'private-alias.js', expectedLegacy);
});
