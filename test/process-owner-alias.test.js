'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inventoryProcessOwnerSites, SRC_ROOT } = require('./process-owner-evidence-scenarios/source-inventory.cjs');

const runFixture = (source, expectedKills, expectedViolations) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-probe-alias-'));
  try {
    fs.writeFileSync(path.join(directory, 'private-alias.js'), source);
    const result = inventoryProcessOwnerSites(directory);
    assert.deepEqual(result.kills, expectedKills);
    assert.deepEqual(result.legacyCalls, []);
    assert.deepEqual(result.violations, expectedViolations);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

test("let function alias", { todo: "issue262 mutable probe alias inventory gap" }, () => {
runFixture("let probe = process.kill; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("var function alias", { todo: "issue262 mutable probe alias inventory gap" }, () => {
runFixture("var probe = process.kill; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("let process object alias", { todo: "issue262 mutable probe alias inventory gap" }, () => {
runFixture("let proc = process; function newProbe(pid) { proc.kill(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("let destructured probe alias", { todo: "issue262 mutable probe alias inventory gap" }, () => {
runFixture("let { kill: probe } = process; function newProbe(pid) { probe(pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("let zero signal alias", { todo: "issue262 mutable probe alias inventory gap" }, () => {
runFixture("let signal = 0; function newProbe(pid) { process.kill(pid, signal); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
});

test("assigned function alias", { todo: "issue262 mutable probe alias inventory gap" }, () => {
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
runFixture("let probe = () => true; function newProbe(pid) { probe(pid, 0); }", [], []);
});

test("declared production probe inventory remains valid", () => {
const result = inventoryProcessOwnerSites(SRC_ROOT);
assert.equal(result.kills.length, 8);
assert.deepEqual(result.legacyCalls, []);
assert.deepEqual(result.violations, []);
});
