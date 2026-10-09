'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runFixture, runFilesFixture, inventoryProcessOwnerSites, SRC_ROOT } =
  require('./public-inventory-fixtures.cjs');

test("forwarded callback APIs retain process probes", () => {
  runFixture("function newProbe(pid) { setImmediate(process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function newProbe(pid) { process.nextTick(process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function newProbe() { setTimeout(process.kill, 10, 1234, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("function newProbe() { setInterval(process.kill, 10, 1234, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const schedule = setImmediate; function newProbe(pid) { schedule(process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("let schedule; schedule = setImmediate; function newProbe(pid) { schedule(process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const { setImmediate } = require('node:timers'); function newProbe(pid) { setImmediate(process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const { setImmediate: schedule } = require('timers'); function newProbe(pid) { schedule(process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const timers = require('node:timers'); function newProbe(pid) { timers.setImmediate(process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const timers = require('timers'); function newProbe(pid) { timers['setImmediate'](process.kill, pid, 0); }", ["private-alias.js\u0000newProbe"], ["unclassified process probe private-alias.js:newProbe"]);
  runFixture("const setImmediate = () => {}; const schedule = setImmediate; function newProbe(pid) { schedule(process.kill, pid, 0); }", [], []);
  runFixture("import { setImmediate } from './transport.js'; function newProbe() { setImmediate(process.kill, 1234, 0); }", [], [], 'private-alias.ts');
});
