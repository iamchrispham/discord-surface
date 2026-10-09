'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runFixture, runFilesFixture, inventoryProcessOwnerSites, SRC_ROOT } =
  require('./public-inventory-fixtures.cjs');

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

test("TypeScript import-equals process origins retain process objects", () => {
  runFixture("import proc = require('node:process'); function newProbe(pid) { proc.kill(pid, 0); }", ["private-alias.ts\u0000newProbe"], ["unclassified process probe private-alias.ts:newProbe"], 'private-alias.ts');
  runFixture("import proc = require('process'); function newProbe(pid) { proc.kill(pid, 0); }", ["private-alias.ts\u0000newProbe"], ["unclassified process probe private-alias.ts:newProbe"], 'private-alias.ts');
});

test("local module exports retain probe provenance across files", () => {
  runFilesFixture({
    'probe.js': "module.exports = { probe: process.kill };",
    'use.js': "const { probe } = require('./probe'); function newProbe(pid) { probe(pid, 0); }"
  }, ["use.js\u0000newProbe"], ["unclassified process probe use.js:newProbe"]);
  runFilesFixture({
    'probe.ts': "export const probe = process.kill;",
    'use.ts': "import { probe } from './probe'; function newProbe(pid) { probe(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'probe.ts': "export function getProbe() { return process.kill; }",
    'use.ts': "import { getProbe } from './probe'; function newProbe(pid) { getProbe()(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'probe.ts': "function getProbe() { return process.kill; } export { getProbe };",
    'use.ts': "import { getProbe } from './probe'; function newProbe(pid) { getProbe()(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'probe.ts': "export const identity = value => value;",
    'use.ts': "import { identity } from './probe'; function newProbe(pid) { identity(process.kill)(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'probe.ts': "export const probe = process.kill;",
    'ordinary.ts': "export const probe = () => true;",
    'barrel.ts': "export * from './probe'; export { probe } from './ordinary';",
    'use.ts': "import { probe } from './barrel'; function ordinary(pid) { probe(pid, 0); }"
  }, [], []);
  runFilesFixture({
    'probe.ts': "export const probe = process.kill;",
    'barrel.ts': "import { probe } from './probe'; export { probe };",
    'use.ts': "import { probe } from './barrel'; function newProbe(pid) { probe(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'probe.ts': "const probe = process.kill; export default probe;",
    'barrel.ts': "import probe from './probe'; export { probe };",
    'use.ts': "import { probe } from './barrel'; function newProbe(pid) { probe(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'probe.js': "const api = module.exports; api.probe = process.kill;",
    'use.js': "const { probe } = require('./probe'); function newProbe(pid) { probe(pid, 0); }"
  }, ["use.js\u0000newProbe"], ["unclassified process probe use.js:newProbe"]);
  runFilesFixture({
    'probe.ts': "export class Helpers { static probe = process.kill; }",
    'use.ts': "import { Helpers } from './probe'; function newProbe(pid) { Helpers.probe(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'probe.ts': "export class Helpers { probe = process.kill; }",
    'use.ts': "import { Helpers } from './probe'; const helpers = new Helpers(); function newProbe(pid) { helpers.probe(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'producer.js': "const api = { probe: process.kill }; module.exports = api;",
    'use.js': "const producer = require('./producer'); producer.probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    'producer.js': "const api = { probe: process.kill }; module.exports = api;",
    'use.js': "const { probe } = require('./producer'); probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    'probe.js': "export const probe = process.kill;",
    'producer.js': "export * as helpers from './probe.js';",
    'use.js': "import { helpers } from './producer.js'; helpers.probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    'producer.js': "export const identity = (value = process.kill) => value;",
    'use.js': "import { identity } from './producer.js'; identity()(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    'producer.js': "function ordinary() {} module.exports = { probe: ordinary }; exports = {}; exports.probe = process.kill;",
    'use.js': "const producer = require('./producer'); producer.probe(1, 0);"
  }, [], []);
  runFilesFixture({
    'producer.js': "const ordinary = () => true; let probe = ordinary; export default probe; probe = process.kill;",
    'use.js': "import probe from './producer.js'; probe(1, 0);"
  }, [], []);
  runFilesFixture({
    'producer.js': "const ordinary = () => true; let probe = ordinary; export { probe as default }; probe = process.kill;",
    'use.js': "import probe from './producer.js'; probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    'probe.ts': "const probe = process.kill; export = probe;",
    'use.ts': "import probe = require('./probe'); function newProbe(pid) { probe(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'producer.ts': "export function getProbe() { const process = { kill() {} }; return process.kill; }",
    'use.ts': "import { getProbe } from './producer'; function newProbe(pid) { getProbe()(pid, 0); }"
  }, [], []);
  runFilesFixture({
    'producer.ts': "const ordinary = () => true; export let probe = ordinary; { probe = process.kill; }",
    'use.ts': "import { probe } from './producer'; function newProbe(pid) { probe(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'producer.ts': "const ordinary = () => true; export const probe = Math.random() > 0.5 ? process.kill : ordinary;",
    'use.ts': "import { probe } from './producer'; function newProbe(pid) { probe(pid, 0); }"
  }, ["use.ts\u0000newProbe"], ["unclassified process probe use.ts:newProbe"]);
  runFilesFixture({
    'probe.cjs': "module.exports = process.kill;",
    'use.js': "const probe = require('./probe.cjs'); function newProbe(pid) { probe(pid, 0); }"
  }, ["use.js\u0000newProbe"], ["unclassified process probe use.js:newProbe"]);
  runFilesFixture({
    'producer.js': "export const getProbe = (value = process.kill) => value;",
    'use.js': "import { getProbe } from './producer.js'; getProbe(undefined)(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    'producer.js': "export function getProbe() { let probe; probe = process.kill; return probe; }",
    'use.js': "import { getProbe } from './producer.js'; getProbe()(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    'producer.js': "export class Runner { constructor(probe, pid) { probe(pid, 0); } }",
    'use.js': "import { Runner } from './producer.js'; new Runner(process.kill, 1);"
  }, [], ["unsupported process probe use.js:null"]);
  runFilesFixture({
    'probe/package.json': JSON.stringify({ main: 'owner.js' }),
    'probe/owner.js': "module.exports = process.kill;",
    'use.js': "const probe = require('./probe'); probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    'producer.js': "export const ownerAlive = ({ directPostOwnerAlive() {} }).directPostOwnerAlive;",
    'use.js': "import { ownerAlive } from './producer.js'; ownerAlive();"
  }, [], ["legacy directPostOwnerAlive callsite use.js:null"], ["use.js\u0000null"]);
});

test("named default process imports retain process-object identity", () => {
  runFixture(
    "import { default as proc } from 'node:process'; function newProbe(pid) { proc.kill(pid, 0); }",
    ["private-alias.ts\u0000newProbe"],
    ["unclassified process probe private-alias.ts:newProbe"],
    'private-alias.ts'
  );
});

test("local module exports retain live and built-in origins", () => {
  runFilesFixture({
    "probe.js": "export let probe = () => true; probe = process.kill;",
    "use.js": "import { probe } from './probe.js'; probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    "probe.js": "module.exports = process.kill;",
    "use.js": "const probe = require('./probe'); probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    "probe.js": "const process = { kill() {} }; export const probe = process.kill;",
    "use.js": "import { probe } from './probe.js'; probe(1, 0);"
  }, [], []);
  runFilesFixture({
    "probe.js": "export const probe = process.kill;",
    "barrel.js": "export * from './probe.js';",
    "use.js": "import { probe } from './barrel.js'; probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    "probe.js": "import proc from 'node:process'; export const probe = proc.kill;",
    "use.js": "import { probe } from './probe.js'; probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    "probe.ts": "export const probe = process.kill;",
    "use.ts": "import { probe } from './probe.js'; probe(1, 0);"
  }, ["use.ts\u0000null"], ["unclassified process probe use.ts:null"]);
  runFilesFixture({
    "probe.js": "export const getProbe = () => process.kill;",
    "use.js": "import { getProbe } from './probe.js'; getProbe()(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    "probe.js": "exports = module.exports = process.kill;",
    "use.js": "const probe = require('./probe'); probe(1, 0);"
  }, ["use.js\u0000null"], ["unclassified process probe use.js:null"]);
  runFilesFixture({
    "probe.js": "const require = () => ({ kill() {} }); export const probe = require('node:process').kill;",
    "use.js": "import { probe } from './probe.js'; probe(1, 0);"
  }, [], []);
});
