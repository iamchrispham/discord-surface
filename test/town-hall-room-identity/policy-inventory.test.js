'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { countIdentifierReferences, commonJsExportAssignment } = require('./policy-reference-analysis');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

const {
  createSourceFile,
  finiteStringValues,
  isRoomField,
  isNamedRoomField,
  callPropertyName,
  regexInput,
  enclosingFunction,
  isLexicalScope,
  nearestLexicalScope,
  nearestVariableScope,
  variableDeclarationScope,
  collectBindings,
  isAncestor,
  scopeDepth,
  resolveBinding,
  functionBinding,
  bindingName,
  hasBoundAlias,
  isRoomKeyLookup,
  isDescriptorRoomLookup,
  hasRoomFieldAlias,
  hasRoomKeyAlias,
  hasDescriptorRoomAlias,
  hasSplitRoomLengthBound,
  hasRoomFieldCall,
  isTownHallName,
  isGenericRoomValidatorName,
  isRoomPolicyFile,
  isTownHallContextName,
  isAnonymousDefaultRoomPolicy,
  hasTownHallDeclarationContext,
  hasTownHallCallsite,
  isTownHallContext,
  hasDestructuredRoomParameter,
  isNeutralRoomPolicy,
  roomFieldSubject,
  isTownHallRoomOwner,
  isSplitRoomDigitPolicy,
  hasAsciiDigitPattern,
  resolveStringValue,
  legacyRoomDigitPolicies,
  unwrapPolicyExpression,
  policyPropertyKey,
  roomDigitPolicies: roomDigitPoliciesBase,
  roomDigitPolicyDefinitions,
} = require('./policy-inventory-analysis');
let roomDigitPolicies = roomDigitPoliciesBase;

test('room policy inventory records only town-hall room validators', () => {
  const src = path.join(PROJECT_ROOT, 'src');
  const references = {};
  const records = [];
  const sourceFiles = [];
  for (const relative of fs.readdirSync(src, { recursive: true })) {
    if (!/\.(?:[cm]?[tj]s)$/.test(relative)) continue;
    const text = fs.readFileSync(path.join(src, relative), 'utf8');
    const file = relative.split(path.sep).join('/');
    records.push({ file, text });
    sourceFiles.push({ file, ast: createSourceFile(file, text) });
  }
  const sourceAsts = sourceFiles.map(source => source.ast);
  for (const { file, ast } of sourceFiles) {
    const count = countIdentifierReferences(ast, 'isTownHallRoom', sourceAsts);
    if (count) references[file] = count;
  }
  assert.deepEqual(references, { 'peer/town-hall-plan.ts': 1, 'peer/town-hall-room-identity.ts': 1 });
  const distFacadeSentinel = ts.createSourceFile(
    'peer/town-hall-audit-dist-consumer.js',
    String.raw`const plan = require('../../dist/peer/town-hall-plan.js'); plan.isTownHallRoom({});`,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(distFacadeSentinel, 'isTownHallRoom'), 1);
  const unrelatedDistFacade = ts.createSourceFile(
    'peer/unrelated-dist-consumer.js',
    String.raw`const plan = require('../../dist/peer/voice-room.js'); plan.isTownHallRoom({});`,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(unrelatedDistFacade, 'isTownHallRoom'), 0);
  const referenceFixture = ts.createSourceFile('peer/reference-fixture.ts', String.raw`// isTownHallRoom
  const label = 'isTownHallRoom';
  interface Options { isTownHallRoom: boolean }
  type Alias = { isTownHallRoom: boolean };
  const options = { isTownHallRoom: true };
  const { isTownHallRoom: flag } = options;
  function isTownHallRoom(room) { return room; }
  isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(referenceFixture, 'isTownHallRoom'), 1);
  const shadowedReferenceFixture = ts.createSourceFile('peer/shadowed-reference-fixture.ts', String.raw`function isTownHallRoom(room) { return room; }
  function unrelated() { function isTownHallRoom(room) { return room; } return isTownHallRoom({}); }
  isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(shadowedReferenceFixture, 'isTownHallRoom'), 1);
  const exportedReferenceFixture = ts.createSourceFile('peer/exported-reference-fixture.ts', String.raw`export function isTownHallRoom(room) { return room; }
  function unrelated() { function isTownHallRoom(room) { return room; } return isTownHallRoom({}); }
  isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(exportedReferenceFixture, 'isTownHallRoom'), 1);
  const importedReferenceFixture = ts.createSourceFile('peer/imported-reference-fixture.ts', String.raw`import { isTownHallRoom } from './town-hall-plan';
  isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(importedReferenceFixture, 'isTownHallRoom'), 1);
  const importedGuardWithNamedFunctionExpressionFixture = createSourceFile(
    'peer/imported-guard-with-named-function-expression-fixture.ts',
    String.raw`import { isTownHallRoom } from './town-hall-plan';
    const helper = function isTownHallRoom() { return isTownHallRoom({}); };
    isTownHallRoom({});`);
  assert.equal(countIdentifierReferences(
    importedGuardWithNamedFunctionExpressionFixture,
    'isTownHallRoom',
  ), 1);
  const aliasedImportedReferenceFixture = ts.createSourceFile('peer/aliased-imported-reference-fixture.ts', String.raw`import { isTownHallRoom as roomGuard } from './town-hall-plan';
  roomGuard({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(aliasedImportedReferenceFixture, 'isTownHallRoom'), 1);
  const unrelatedNamedReferenceFixture = ts.createSourceFile('peer/unrelated-named-reference-fixture.ts', String.raw`import { isTownHallRoom } from './voice-room';
  isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(unrelatedNamedReferenceFixture, 'isTownHallRoom'), 0);
  const unrelatedNamespaceReferenceFixture = ts.createSourceFile('peer/unrelated-namespace-reference-fixture.ts', String.raw`import * as voiceRoom from './voice-room';
  voiceRoom.isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(unrelatedNamespaceReferenceFixture, 'isTownHallRoom'), 0);
  const unrelatedDirectRequireReferenceFixture = ts.createSourceFile('peer/unrelated-direct-require-reference-fixture.cjs', String.raw`require('./voice-room').isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(unrelatedDirectRequireReferenceFixture, 'isTownHallRoom'), 0);
  const commonJsNamedReferenceFixture = ts.createSourceFile('peer/commonjs-named-reference-fixture.cjs', String.raw`const { isTownHallRoom: roomGuard } = require('./town-hall-plan');
  roomGuard({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(commonJsNamedReferenceFixture, 'isTownHallRoom'), 1);
  const commonJsNamespaceReferenceFixture = ts.createSourceFile('peer/commonjs-namespace-reference-fixture.cjs', String.raw`const plan = require('./town-hall-plan');
  plan.isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(commonJsNamespaceReferenceFixture, 'isTownHallRoom'), 1);
  const importEqualsNamespaceReferenceFixture = ts.createSourceFile('peer/import-equals-namespace-reference-fixture.cts', String.raw`import plan = require('./town-hall-plan.cjs');
  plan.isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(importEqualsNamespaceReferenceFixture, 'isTownHallRoom'), 1);
  const destructuredNamespaceReferenceFixture = createSourceFile(
    'peer/destructured-namespace-reference-fixture.ts',
    String.raw`import * as plan from './town-hall-plan';
    const { isTownHallRoom: guard } = plan;
    guard({});`);
  assert.equal(countIdentifierReferences(destructuredNamespaceReferenceFixture, 'isTownHallRoom'), 1);
  const unrelatedDestructuredNamespaceReferenceFixture = createSourceFile(
    'peer/unrelated-destructured-namespace-reference-fixture.ts',
    String.raw`import * as voiceRoom from './voice-room';
    const { isTownHallRoom: guard } = voiceRoom;
    guard({});`);
  assert.equal(countIdentifierReferences(
    unrelatedDestructuredNamespaceReferenceFixture,
    'isTownHallRoom',
  ), 0);
  const runtimeCjsSourceFixture = createSourceFile(
    'peer/town-hall-runtime-source.cts',
    String.raw`export { isTownHallRoom } from './town-hall-plan';`);
  const runtimeCjsConsumerFixture = createSourceFile(
    'peer/town-hall-runtime-consumer.cjs',
    String.raw`const { isTownHallRoom: guard } = require('./town-hall-runtime-source.cjs');
    guard({});`);
  assert.equal(countIdentifierReferences(runtimeCjsConsumerFixture, 'isTownHallRoom', [
    runtimeCjsSourceFixture,
    runtimeCjsConsumerFixture,
  ]), 1);
  const runtimeMjsSourceFixture = createSourceFile(
    'peer/town-hall-runtime-source.mts',
    String.raw`export { isTownHallRoom } from './town-hall-plan';`);
  const runtimeMjsConsumerFixture = createSourceFile(
    'peer/town-hall-runtime-consumer.mjs',
    String.raw`import { isTownHallRoom as guard } from './town-hall-runtime-source.mjs';
    guard({});`);
  assert.equal(countIdentifierReferences(runtimeMjsConsumerFixture, 'isTownHallRoom', [
    runtimeMjsSourceFixture,
    runtimeMjsConsumerFixture,
  ]), 1);
  const unrelatedRuntimeTypeSourceFixture = createSourceFile(
    'peer/unrelated-runtime-source.mts',
    String.raw`export { isTownHallRoom } from './voice-room';`);
  const unrelatedRuntimeTypeConsumerFixture = createSourceFile(
    'peer/unrelated-runtime-consumer.mjs',
    String.raw`import { isTownHallRoom as guard } from './unrelated-runtime-source.mjs';
    guard({});`);
  assert.equal(countIdentifierReferences(unrelatedRuntimeTypeConsumerFixture, 'isTownHallRoom', [
    unrelatedRuntimeTypeSourceFixture,
    unrelatedRuntimeTypeConsumerFixture,
  ]), 0);
  const namespaceExportBarrelFixture = createSourceFile('peer/namespace-export-barrel.ts',
    String.raw`export * as plan from './town-hall-plan.js';`);
  const namespaceExportConsumerFixture = createSourceFile('peer/namespace-export-consumer.ts',
    String.raw`import { plan } from './namespace-export-barrel.js';
    plan.isTownHallRoom({});`);
  assert.equal(countIdentifierReferences(namespaceExportConsumerFixture, 'isTownHallRoom', [
    namespaceExportBarrelFixture,
    namespaceExportConsumerFixture,
  ]), 1);
  const unrelatedNamespaceExportBarrelFixture = createSourceFile(
    'peer/unrelated-namespace-export-barrel.ts',
    String.raw`export * as voiceRoom from './voice-room.js';`);
  const unrelatedNamespaceExportConsumerFixture = createSourceFile(
    'peer/unrelated-namespace-export-consumer.ts',
    String.raw`import { voiceRoom } from './unrelated-namespace-export-barrel.js';
    voiceRoom.isTownHallRoom({});`);
  assert.equal(countIdentifierReferences(
    unrelatedNamespaceExportConsumerFixture,
    'isTownHallRoom',
    [unrelatedNamespaceExportBarrelFixture, unrelatedNamespaceExportConsumerFixture],
  ), 0);
  const dynamicImportReferenceFixture = createSourceFile(
    'peer/dynamic-import-reference-fixture.ts',
    String.raw`async function invoke() {
      const { isTownHallRoom } = await import('./town-hall-plan.js');
      return isTownHallRoom({});
    }`);
  assert.equal(countIdentifierReferences(dynamicImportReferenceFixture, 'isTownHallRoom'), 1);
  const unrelatedDynamicImportReferenceFixture = createSourceFile(
    'peer/unrelated-dynamic-import-reference-fixture.ts',
    String.raw`async function invoke() {
      const { isTownHallRoom } = await import('./voice-room.js');
      return isTownHallRoom({});
    }`);
  assert.equal(countIdentifierReferences(
    unrelatedDynamicImportReferenceFixture,
    'isTownHallRoom',
  ), 0);
  const destructuredShadowReferenceFixture = ts.createSourceFile('peer/destructured-shadow-reference-fixture.ts', String.raw`export function isTownHallRoom(room) { return room; }
  function parameterShadow({ isTownHallRoom }) { return isTownHallRoom({}); }
  function localShadow() {
    const { isTownHallRoom: guard = () => false } = { isTownHallRoom: () => true };
    const { nested: { isTownHallRoom: nestedGuard }, ...rest } = { nested: { isTownHallRoom: () => true } };
    return guard({}) || nestedGuard({}) || rest.isTownHallRoom;
  }
  isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(destructuredShadowReferenceFixture, 'isTownHallRoom'), 1);
  // Synthetic fixtures are independent of production files, so reuse the production baseline.
  const uncachedRoomDigitPolicies = roomDigitPolicies;
  const productionRecordTexts = new Map(records.map(record => [record.file, record.text]));
  const basePolicies = uncachedRoomDigitPolicies(records);
  const policyFixtureCache = new Map();
  roomDigitPolicies = fixtureRecords => {
    const syntheticRecords = fixtureRecords.filter(record => productionRecordTexts.get(record.file) !== record.text);
    if (!syntheticRecords.length) return basePolicies;
    const key = syntheticRecords.map(record => `${record.file}\u0000${record.text}`).join('\u0000');
    if (!policyFixtureCache.has(key)) {
      policyFixtureCache.set(key, uncachedRoomDigitPolicies(syntheticRecords));
    }
    const combined = { ...basePolicies };
    for (const [file, count] of Object.entries(policyFixtureCache.get(key))) {
      combined[file] = (combined[file] || 0) + count;
    }
    return combined;
  };
  const expectedPolicies = { 'peer/town-hall-plan.ts': 2 };
  assert.deepEqual(roomDigitPolicies(records), expectedPolicies);
  const expectedDefinitions = {
    'peer/town-hall-plan.ts': [
      { kind: 'literal', pattern: '^\\d{1,20}$', flags: '' },
      { kind: 'literal', pattern: '^\\d{1,20}$', flags: '' },
    ],
  };
  assert.deepEqual(roomDigitPolicyDefinitions(records), expectedDefinitions);
  const planRecord = records.find(record => record.file === 'peer/town-hall-plan.ts');
  const originalExpression = String.raw`/^\d{1,20}$/`;
  const divergentExpression = String.raw`/^[+\d]{1,20}$/`;
  const changedPlanText = planRecord.text.replace(originalExpression, divergentExpression);
  assert.notEqual(changedPlanText, planRecord.text);
  const changedPolicyRecords = records.map(record => record === planRecord
    ? { ...record, text: changedPlanText }
    : record);
  assert.deepEqual(roomDigitPoliciesBase(changedPolicyRecords), expectedPolicies);
  assert.notDeepEqual(roomDigitPolicyDefinitions(changedPolicyRecords), expectedDefinitions);
  const flaggedExpression = String.raw`/^\d{1,20}$/i`;
  const flaggedPlanText = planRecord.text.replace(originalExpression, flaggedExpression);
  const flaggedPolicyRecords = records.map(record => record === planRecord
    ? { ...record, text: flaggedPlanText }
    : record);
  assert.deepEqual(roomDigitPoliciesBase(flaggedPolicyRecords), expectedPolicies);
  assert.notDeepEqual(roomDigitPolicyDefinitions(flaggedPolicyRecords), expectedDefinitions);
  const commonJsHelper = {
    file: 'peer/commonjs-room-helper.js',
    text: String.raw`function validateGuildId(value) { return /^\d{1,21}$/.test(value); }
    module.exports = validateGuildId;`
  };
  const commonJsConsumer = {
    file: 'peer/commonjs-room-consumer.js',
    text: String.raw`const validateGuildId = require('./commonjs-room-helper');
    function validateRoom(room) { return validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, commonJsHelper, commonJsConsumer]), {
    ...expectedPolicies,
    'peer/commonjs-room-helper.js': 1
  });
  const runtimeCjsRoomHelper = {
    file: 'peer/runtime-cjs-room-helper.cts',
    text: String.raw`function validateGuildId(value) { return /^\d{1,21}$/.test(value); }
    module.exports = validateGuildId;`
  };
  const runtimeCjsRoomConsumer = {
    file: 'peer/runtime-cjs-room-consumer.cts',
    text: String.raw`const validateGuildId = require('./runtime-cjs-room-helper.cjs');
    function validateRoom(room) { return validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, runtimeCjsRoomHelper, runtimeCjsRoomConsumer]), {
    ...expectedPolicies,
    'peer/runtime-cjs-room-helper.cts': 1
  });
  const runtimeMjsRoomHelper = {
    file: 'peer/runtime-mjs-room-helper.mts',
    text: String.raw`export function validateChannelId(value) { return /^\d{1,21}$/.test(value); }`
  };
  const runtimeMjsRoomConsumer = {
    file: 'peer/runtime-mjs-room-consumer.mts',
    text: String.raw`import { validateChannelId } from './runtime-mjs-room-helper.mjs';
    function validateRoom(room) { return validateChannelId(room.channelId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, runtimeMjsRoomHelper, runtimeMjsRoomConsumer]), {
    ...expectedPolicies,
    'peer/runtime-mjs-room-helper.mts': 1
  });
  const cjsRuntimeExtensionPattern = {
    file: 'peer/runtime-extension-pattern.cts',
    text: String.raw`exports.ROOM_ID = /^\d{1,21}$/;`
  };
  const cjsRuntimeExtensionConsumer = {
    file: 'peer/runtime-extension-town-hall-consumer.cjs',
    text: String.raw`const { ROOM_ID } = require('./runtime-extension-pattern.cjs');
    function validateTownHallRoom(room) { return ROOM_ID.test(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    cjsRuntimeExtensionPattern,
    cjsRuntimeExtensionConsumer,
  ]), {
    ...expectedPolicies,
    [cjsRuntimeExtensionPattern.file]: 1,
  });
  const mjsRuntimeExtensionPattern = {
    file: 'peer/runtime-extension-pattern.mts',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;`
  };
  const mjsRuntimeExtensionConsumer = {
    file: 'peer/runtime-extension-town-hall-consumer.mjs',
    text: String.raw`import { ROOM_ID } from './runtime-extension-pattern.mjs';
    function validateTownHallRoom(room) { return ROOM_ID.test(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    mjsRuntimeExtensionPattern,
    mjsRuntimeExtensionConsumer,
  ]), {
    ...expectedPolicies,
    [mjsRuntimeExtensionPattern.file]: 1,
  });
  const runtimeExtensionNegativeHelper = {
    file: 'peer/runtime-extension-negative-helper.cts',
    text: String.raw`function validateGuildId(value) { return /^\d{1,21}$/.test(value); }
    module.exports = validateGuildId;`
  };
  const runtimeExtensionNegativeConsumer = {
    file: 'peer/runtime-extension-negative-consumer.cts',
    text: String.raw`const validateGuildId = require('./runtime-extension-negative-helper.cjs');
    function validateMessage(message) { return validateGuildId(message.id); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    runtimeExtensionNegativeHelper,
    runtimeExtensionNegativeConsumer,
  ]), expectedPolicies);
  const borrowedTestMatcherRoom = {
    file: 'peer/borrowed-test-matcher-room.ts',
    text: String.raw`function validateRoom(room) {
      const pattern = /^\d{1,21}$/;
      return RegExp.prototype.test.call(pattern, room.guildId);
    }`
  };
  const borrowedExecMatcherRoom = {
    file: 'peer/borrowed-exec-matcher-room.ts',
    text: String.raw`function validateRoom(room) {
      const pattern = /^\d{1,21}$/;
      return RegExp.prototype.exec.call(pattern, room.channelId) !== null;
    }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    borrowedTestMatcherRoom,
    borrowedExecMatcherRoom,
  ]), {
    ...expectedPolicies,
    'peer/borrowed-test-matcher-room.ts': 1,
    'peer/borrowed-exec-matcher-room.ts': 1,
  });
  const borrowedMatcherOrdinaryField = {
    file: 'peer/borrowed-matcher-ordinary-field.ts',
    text: String.raw`function validateRoom(room) {
      const pattern = /^\d{1,21}$/;
      return RegExp.prototype.test.call(pattern, room.id);
    }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    borrowedMatcherOrdinaryField,
  ]), expectedPolicies);
  const exportEqualsHelper = {
    file: 'peer/export-equals-room-helper.cts',
    text: String.raw`const validateGuildId = value => /^\d{1,21}$/.test(value);
    export = validateGuildId;`
  };
  const exportEqualsConsumer = {
    file: 'peer/export-equals-room-consumer.cts',
    text: String.raw`const validateGuildId = require('./export-equals-room-helper');
    function validateRoom(room) { return validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    exportEqualsHelper,
    exportEqualsConsumer,
  ]), {
    ...expectedPolicies,
    'peer/export-equals-room-helper.cts': 1
  });
  const exportEqualsNegativeConsumer = {
    file: 'peer/export-equals-room-negative-consumer.cts',
    text: String.raw`const validateGuildId = require('./export-equals-room-helper');
    function inspectRoom(room) { return validateGuildId(room.name); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    exportEqualsHelper,
    exportEqualsNegativeConsumer,
  ]), expectedPolicies);
  const mappedRuntimeCtsHelper = {
    file: 'peer/runtime-extension-room-helper.cts',
    text: String.raw`export default function validateGuildId(value) { return /^\d{1,21}$/.test(value); }`
  };
  const mappedRuntimeCjsConsumer = {
    file: 'peer/runtime-extension-room-consumer.cjs',
    text: String.raw`const validateGuildId = require('./runtime-extension-room-helper.cjs');
    function validateRoom(room) { return validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    mappedRuntimeCtsHelper,
    mappedRuntimeCjsConsumer,
  ]), {
    ...expectedPolicies,
    'peer/runtime-extension-room-helper.cts': 1
  });
  const mappedRuntimeCjsNegativeConsumer = {
    file: 'peer/runtime-extension-room-negative-consumer.cjs',
    text: String.raw`const validateGuildId = require('./runtime-extension-room-helper.cjs');
    function inspectRoom(room) { return validateGuildId(room.name); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    mappedRuntimeCtsHelper,
    mappedRuntimeCjsNegativeConsumer,
  ]), expectedPolicies);
  const extensionMtsGuardHelper = {
    file: 'peer/runtime-extension-mts-helper.mts',
    text: String.raw`export default function validateGuildId(value) { return /^\d{1,21}$/.test(value); }`
  };
  const extensionMjsGuardConsumer = {
    file: 'peer/runtime-extension-mjs-consumer.mjs',
    text: String.raw`import validateGuildId from './runtime-extension-mts-helper.mjs';
    function validateRoom(room) { return validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    extensionMtsGuardHelper,
    extensionMjsGuardConsumer,
  ]), {
    ...expectedPolicies,
    [extensionMtsGuardHelper.file]: 1
  });
  const extensionMjsNegativeConsumer = {
    file: 'peer/runtime-extension-mjs-negative-consumer.mjs',
    text: String.raw`import validateGuildId from './runtime-extension-mts-helper.mjs';
    function inspectRoom(room) { return validateGuildId(room.name); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    extensionMtsGuardHelper,
    extensionMjsNegativeConsumer,
  ]), expectedPolicies);
  const mappedRuntimeJsRoomHelper = {
    file: 'peer/runtime-js-room-helper.ts',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;`,
  };
  const mappedRuntimeJsRoomConsumer = {
    file: 'peer/runtime-js-room-consumer.ts',
    text: String.raw`import { ROOM_ID } from './runtime-js-room-helper.js';
    function validateTownHallRoom(room) { return ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    mappedRuntimeJsRoomHelper,
    mappedRuntimeJsRoomConsumer,
  ]), {
    ...expectedPolicies,
    'peer/runtime-js-room-helper.ts': 1,
  });
  const mappedRuntimeJsVoiceConsumer = {
    file: 'peer/runtime-js-room-voice-consumer.ts',
    text: String.raw`import { ROOM_ID } from './runtime-js-room-helper.js';
    function validateVoiceRoom(room) { return ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    mappedRuntimeJsRoomHelper,
    mappedRuntimeJsVoiceConsumer,
  ]), expectedPolicies);
  const mappedRuntimeMtsHelper = {
    file: 'peer/runtime-extension-room-helper.mts',
    text: String.raw`export function validateChannelId(value) { return /^\d{1,21}$/.test(value); }`
  };
  const mappedRuntimeMjsConsumer = {
    file: 'peer/runtime-extension-room-consumer.mjs',
    text: String.raw`import { validateChannelId } from './runtime-extension-room-helper.mjs';
    function validateRoom(room) { return validateChannelId(room.channelId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    mappedRuntimeMtsHelper,
    mappedRuntimeMjsConsumer,
  ]), {
    ...expectedPolicies,
    'peer/runtime-extension-room-helper.mts': 1
  });
  const mappedRuntimeMjsNegativeConsumer = {
    file: 'peer/runtime-extension-room-negative-consumer.mjs',
    text: String.raw`import { validateChannelId } from './runtime-extension-room-helper.mjs';
    function inspectRoom(room) { return validateChannelId(room.name); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    mappedRuntimeMtsHelper,
    mappedRuntimeMjsNegativeConsumer,
  ]), expectedPolicies);
  const exportEqualsAliasHelper = {
    file: 'peer/export-equals-room-alias-helper.cts',
    text: String.raw`const actual = value => /^\d{1,21}$/.test(value);
    const exported = actual;
    export = exported;`
  };
  const exportEqualsAliasConsumer = {
    file: 'peer/export-equals-room-alias-consumer.cts',
    text: String.raw`const validateGuildId = require('./export-equals-room-alias-helper');
    function validateRoom(room) { return validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    exportEqualsAliasHelper,
    exportEqualsAliasConsumer,
  ]), {
    ...expectedPolicies,
    'peer/export-equals-room-alias-helper.cts': 1
  });
  const inlineCommonJsObjectHelper = {
    file: 'peer/inline-commonjs-room-helper.cjs',
    text: String.raw`module.exports = {
      validateGuildId(value) { return /^\d{1,21}$/.test(value); },
      validateChannelId: function validateChannelId(value) { return /^\d{1,21}$/.test(value); },
    };`
  };
  const inlineCommonJsObjectConsumer = {
    file: 'peer/inline-commonjs-room-consumer.cjs',
    text: String.raw`const { validateGuildId, validateChannelId } = require('./inline-commonjs-room-helper');
    function validateRoom(room) { return validateGuildId(room.guildId) && validateChannelId(room.channelId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    inlineCommonJsObjectHelper,
    inlineCommonJsObjectConsumer,
  ]), {
    ...expectedPolicies,
    'peer/inline-commonjs-room-helper.cjs': 2
  });
  const directCommonJsFunctionHelper = {
    file: 'peer/direct-commonjs-room-helper.js',
    text: String.raw`module.exports = function validateGuildId(value) {
      return /^\d{1,21}$/.test(value);
    }`
  };
  const directCommonJsFunctionConsumer = {
    file: 'peer/direct-commonjs-room-consumer.js',
    text: String.raw`const validateGuildId = require('./direct-commonjs-room-helper');
    function validateRoom(room) { return validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    directCommonJsFunctionHelper,
    directCommonJsFunctionConsumer,
  ]), {
    ...expectedPolicies,
    'peer/direct-commonjs-room-helper.js': 1
  });
  const directCommonJsArrowHelper = {
    file: 'peer/direct-commonjs-arrow-helper.js',
    text: String.raw`module.exports = value => /^\d{1,21}$/.test(value);`
  };
  const directCommonJsArrowConsumer = {
    file: 'peer/direct-commonjs-arrow-consumer.js',
    text: String.raw`const validateGuildId = require('./direct-commonjs-arrow-helper');
    function validateRoom(room) { return validateGuildId(room.channelId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    directCommonJsArrowHelper,
    directCommonJsArrowConsumer,
  ]), {
    ...expectedPolicies,
    'peer/direct-commonjs-arrow-helper.js': 1
  });
  const namedCommonJsHelper = {
    file: 'peer/named-commonjs-room-helper.js',
    text: String.raw`exports.validateGuildId = value => /^\d{1,20}$/.test(value);
    module.exports.validateChannelId = function validateChannelId(value) {
      return /^\d{1,20}$/.test(value);
    }`
  };
  const namedCommonJsConsumer = {
    file: 'peer/named-commonjs-room-consumer.js',
    text: String.raw`const { validateGuildId, validateChannelId } = require('./named-commonjs-room-helper');
    function validateRoom(room) {
      return validateGuildId(room.guildId) && validateChannelId(room.guildId);
    }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    namedCommonJsHelper,
    namedCommonJsConsumer,
  ]), {
    ...expectedPolicies,
    'peer/named-commonjs-room-helper.js': 2
  });
  const reviewBracketedCommonJsHelper = {
    file: 'peer/bracketed-commonjs-room-helper.js',
    text: String.raw`exports['validateGuildId'] = value => /^\d{1,21}$/.test(value);
    module.exports['validateChannelId'] = value => /^\d{1,21}$/.test(value);`
  };
  const reviewBracketedCommonJsConsumer = {
    file: 'peer/bracketed-commonjs-room-consumer.js',
    text: String.raw`const { validateGuildId, validateChannelId } = require('./bracketed-commonjs-room-helper');
    function validateRoom(room) {
      return validateGuildId(room.guildId) && validateChannelId(room.channelId);
    }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    reviewBracketedCommonJsHelper,
    reviewBracketedCommonJsConsumer,
  ]), {
    ...expectedPolicies,
    'peer/bracketed-commonjs-room-helper.js': 2
  });
  const esmDefaultObjectHelper = {
    file: 'peer/esm-default-room-helper.ts',
    text: String.raw`export default {
      validateGuildId(value) { return /^\d{1,21}$/.test(value); },
      validateChannelId: value => /^\d{1,21}$/.test(value),
    };`
  };
  const esmDefaultObjectConsumer = {
    file: 'peer/esm-default-room-consumer.ts',
    text: String.raw`import validators from './esm-default-room-helper';
    function validateRoom(room) {
      return validators.validateGuildId(room.guildId) && validators.validateChannelId(room.channelId);
    }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    esmDefaultObjectHelper,
    esmDefaultObjectConsumer,
  ]), {
    ...expectedPolicies,
    'peer/esm-default-room-helper.ts': 2
  });
  const overloadedValidator = {
    file: 'peer/overloaded-room-validator.ts',
    text: String.raw`function validateGuildId(value: string): boolean;
    function validateGuildId(value: number): boolean;
    function validateGuildId(value: string | number) {
      return /^\d{1,21}$/.test(value);
    }
    function validateRoom(room) { return validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, overloadedValidator]), {
    ...expectedPolicies,
    'peer/overloaded-room-validator.ts': 1
  });
  const inline = { file: 'peer/future-room.ts', text: String.raw`function validateRoom(room) { return /^\d{1,20}$/.test(room.guildId); }` };
  assert.notDeepEqual(roomDigitPolicies([...records, inline]), expectedPolicies);
  const unrelatedGenericRoomValidator = {
    file: 'other/ordinary.ts',
    text: String.raw`function validateRoom(room) { return /^\d{17,20}$/.test(room.guildId); }`
  };
  const unrelatedGenericValueValidator = {
    file: 'other/ordinary-value.ts',
    text: String.raw`function validateRoom(value) { return /^\d{17,20}$/.test(value.id); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    unrelatedGenericRoomValidator,
    unrelatedGenericValueValidator,
  ]), expectedPolicies);
  const genuineTownHallGenericRoomValidator = {
    file: 'other/town-hall-room.ts',
    text: String.raw`function validateRoom(room) { return /^\d{17,20}$/.test(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, genuineTownHallGenericRoomValidator]), {
    ...expectedPolicies,
    'other/town-hall-room.ts': 1
  });
  const constructor = { file: 'peer/future-room.ts', text: String.raw`function validateRoom(room) { return new RegExp('^[0-9]{1,21}$').test(room.guildId); }` };
  assert.notDeepEqual(roomDigitPolicies([...records, constructor]), expectedPolicies);
  const expandedAsciiDigits = {
    file: 'peer/future-room.ts',
    text: String.raw`function validateRoom(room) { return /^[0123456789]{1,21}$/.test(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, expandedAsciiDigits]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const restrictedAsciiDigits = {
    file: 'peer/future-room.ts',
    text: String.raw`function validateRoom(room) { return /^[1-9]{1,20}$/.test(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, restrictedAsciiDigits]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const unrelatedRestrictedDigits = {
    file: 'peer/snowflake.ts',
    text: String.raw`function inspect(value) { return /^[1-9]+$/.test(value); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, unrelatedRestrictedDigits]), expectedPolicies);
  const neutralSnowflakeRoomValidator = {
    file: 'peer/snowflake.ts',
    text: String.raw`function inspectSnowflake(room) { return /^\d{1,21}$/.test(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, neutralSnowflakeRoomValidator]), expectedPolicies);
  const unrelatedRoomValidator = {
    file: 'peer/voice-room.ts',
    text: String.raw`function validateVoiceRoom(room) { return /^\d{1,21}$/.test(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, unrelatedRoomValidator]), expectedPolicies);
  const directCall = { file: 'peer/future-room.ts', text: String.raw`function validateRoom(room) { return RegExp('^[0-9]{1,21}$').test(room.channelId); }` };
  assert.notDeepEqual(roomDigitPolicies([...records, directCall]), expectedPolicies);
  const coercedRoomField = {
    file: 'peer/coerced-town-hall-room.ts',
    text: String.raw`function validateTownHallRoom(room) {
      return /^\d{1,21}$/.test(String(room.guildId));
    }`
  };
  assert.deepEqual(roomDigitPolicies([...records, coercedRoomField]), {
    ...expectedPolicies,
    'peer/coerced-town-hall-room.ts': 1
  });
  const coercedUnrelatedField = {
    file: 'peer/coerced-unrelated-room.ts',
    text: String.raw`function inspectRoom(room) {
      return /^\d{1,21}$/.test(String(room.guildId));
    }`
  };
  assert.deepEqual(roomDigitPolicies([...records, coercedUnrelatedField]), expectedPolicies);
  const destructuredRoomField = {
    file: 'peer/future-room.ts',
    text: 'function validateRoom(room) { const { guildId } = room; return /^\\d{1,21}$/.test(guildId); }'
  };
  assert.deepEqual(roomDigitPolicies([...records, destructuredRoomField]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const destructuredTownHallRoomField = {
    file: 'peer/future-town-hall-room.ts',
    text: String.raw`export function validateTownHallRoom({ guildId }) { return /^\d{1,21}$/.test(guildId); }`
  };
  const renamedDestructuredTownHallRoomField = {
    file: 'peer/future-town-hall-room-renamed.ts',
    text: String.raw`export function validateTownHallRoom({ guildId: id }) { return /^\d{1,21}$/.test(id); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    destructuredTownHallRoomField,
    renamedDestructuredTownHallRoomField,
  ]), {
    ...expectedPolicies,
    'peer/future-town-hall-room.ts': 1,
    'peer/future-town-hall-room-renamed.ts': 1,
  });
  const unrelatedDestructuredRoomField = {
    file: 'peer/voice-room-destructured.ts',
    text: String.raw`export function validateVoiceRoom({ guildId }) { return /^\d{1,21}$/.test(guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, unrelatedDestructuredRoomField]), expectedPolicies);
  const mixedContextRegex = {
    file: 'peer/mixed-context-room-regex.ts',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;
    function validateVoiceRoom(room) { return ROOM_ID.test(room.guildId); }
    function validateRoom(room) { return ROOM_ID.test(room.channelId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, mixedContextRegex]), {
    ...expectedPolicies,
    'peer/mixed-context-room-regex.ts': 1
  });
  const regexConstant = {
    file: 'peer/future-room.ts',
    text: 'function validateRoom(room) { const ROOM_ID = /^\\d{1,21}$/; return ROOM_ID.test(room.guildId); }'
  };
  assert.deepEqual(roomDigitPolicies([...records, regexConstant]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const objectRegexConstant = {
    file: 'peer/local-object-room-regex.ts',
    text: String.raw`function validateRoom(room) {
      const patterns = { ROOM_ID: /^\d{1,21}$/ };
      return patterns.ROOM_ID.test(room.guildId);
    }`
  };
  assert.deepEqual(roomDigitPolicies([...records, objectRegexConstant]), {
    ...expectedPolicies,
    'peer/local-object-room-regex.ts': 1
  });
  const regexAlias = {
    file: 'peer/future-room.ts',
    text: 'function validateRoom(room) { const ROOM_ID = /^\\d{1,21}$/; const VALIDATOR = ROOM_ID; return VALIDATOR.test(room.guildId); }'
  };
  assert.deepEqual(roomDigitPolicies([...records, regexAlias]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const importedRegexHelper = {
    file: 'peer/imported-room-regex.ts',
    text: 'export const ROOM_ID = /^\\d{1,21}$/;'
  };
  const importedRegexConsumer = {
    file: 'peer/imported-room-regex-consumer.ts',
    text: "import { ROOM_ID } from './imported-room-regex'; function validateRoom(room) { return ROOM_ID.test(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedRegexHelper,
    importedRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/imported-room-regex.ts': 1
  });
  const importedRegexNegativeConsumer = {
    file: 'peer/imported-room-regex-negative-consumer.ts',
    text: "import { ROOM_ID } from './imported-room-regex'; function inspectRoom(room) { return ROOM_ID.test(room.name); }"
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedRegexHelper,
    importedRegexNegativeConsumer,
  ]), expectedPolicies);
  const importedConstructorRegexHelper = {
    file: 'peer/imported-constructor-room-regex.ts',
    text: "export const ROOM_ID = new RegExp('^[1-9]{1,20}$');"
  };
  const importedConstructorRegexConsumer = {
    file: 'peer/imported-constructor-room-regex-consumer.ts',
    text: "import { ROOM_ID } from './imported-constructor-room-regex'; function validateRoom(room) { return ROOM_ID.test(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedConstructorRegexHelper,
    importedConstructorRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/imported-constructor-room-regex.ts': 1
  });
  const aliasedRegexHelper = {
    file: 'peer/aliased-room-regex.ts',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;
    export { ROOM_ID as CHANNEL_ID };`
  };
  const aliasedRegexConsumer = {
    file: 'peer/aliased-room-regex-consumer.ts',
    text: String.raw`import { ROOM_ID, CHANNEL_ID } from './aliased-room-regex';
    function validateRoom(room) { return ROOM_ID.test(room.guildId) && CHANNEL_ID.test(room.channelId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    aliasedRegexHelper,
    aliasedRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/aliased-room-regex.ts': 1
  });
  const namespaceRegexHelper = {
    file: 'peer/namespace-room-regex.ts',
    text: "export const ROOM_ID = new RegExp('^[1-9]{1,20}$');"
  };
  const namespaceRegexConsumer = {
    file: 'peer/namespace-room-regex-consumer.ts',
    text: "import * as patterns from './namespace-room-regex'; function validateRoom(room) { return patterns.ROOM_ID.test(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    namespaceRegexHelper,
    namespaceRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/namespace-room-regex.ts': 1
  });
  const namespaceRegexNegativeConsumer = {
    file: 'peer/namespace-room-regex-negative-consumer.ts',
    text: "import * as patterns from './namespace-room-regex'; function validateVoiceRoom(room) { return patterns.ROOM_ID.test(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    namespaceRegexHelper,
    namespaceRegexNegativeConsumer,
  ]), expectedPolicies);
  const defaultObjectRegexHelper = {
    file: 'peer/default-object-room-regex.ts',
    text: String.raw`export default { ROOM_ID: /^\d{1,21}$/ };`,
  };
  const defaultObjectRegexConsumer = {
    file: 'peer/default-object-room-regex-consumer.ts',
    text: "import patterns from './default-object-room-regex'; function validateTownHallRoom(room) { return patterns.ROOM_ID.test(room.guildId); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    defaultObjectRegexHelper,
    defaultObjectRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/default-object-room-regex.ts': 1,
  });
  const defaultObjectRegexNegativeConsumer = {
    file: 'peer/default-object-room-regex-negative-consumer.ts',
    text: "import patterns from './default-object-room-regex'; function inspectRoom(room) { return patterns.ROOM_ID.test(room.name); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    defaultObjectRegexHelper,
    defaultObjectRegexNegativeConsumer,
  ]), expectedPolicies);
  const cjsRuntimeRegexHelper = {
    file: 'peer/cjs-runtime-room-regex.cts',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;`,
  };
  const cjsRuntimeRegexConsumer = {
    file: 'peer/cjs-runtime-room-consumer.cts',
    text: "import { ROOM_ID } from './cjs-runtime-room-regex.cjs'; function validateRoom(room) { return ROOM_ID.test(room.guildId); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    cjsRuntimeRegexHelper,
    cjsRuntimeRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/cjs-runtime-room-regex.cts': 1,
  });
  const cjsRuntimeRegexNegativeConsumer = {
    file: 'peer/cjs-runtime-room-negative-consumer.cts',
    text: "import { ROOM_ID } from './cjs-runtime-room-regex.cjs'; function inspectRoom(room) { return ROOM_ID.test(room.name); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    cjsRuntimeRegexHelper,
    cjsRuntimeRegexNegativeConsumer,
  ]), expectedPolicies);
  const cjsRequireRuntimeRegexHelper = {
    file: 'peer/cjs-require-room-regex.cts',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;`,
  };
  const cjsRequireRuntimeRegexConsumer = {
    file: 'peer/cjs-require-room-consumer.cts',
    text: "const patterns = require('./cjs-require-room-regex.cjs'); function validateTownHallRoom(room) { return patterns.ROOM_ID.test(room.guildId); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    cjsRequireRuntimeRegexHelper,
    cjsRequireRuntimeRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/cjs-require-room-regex.cts': 1,
  });
  const cjsRequireRuntimeRegexNegativeConsumer = {
    file: 'peer/cjs-require-room-negative-consumer.cts',
    text: "const patterns = require('./cjs-require-room-regex.cjs'); function inspectRoom(room) { return patterns.ROOM_ID.test(room.name); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    cjsRequireRuntimeRegexHelper,
    cjsRequireRuntimeRegexNegativeConsumer,
  ]), expectedPolicies);
  const mjsRuntimeRegexHelper = {
    file: 'peer/mjs-runtime-room-regex.mts',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;`,
  };
  const mjsRuntimeRegexConsumer = {
    file: 'peer/mjs-runtime-room-consumer.mts',
    text: "import { ROOM_ID } from './mjs-runtime-room-regex.mjs'; function validateRoom(room) { return ROOM_ID.test(room.guildId); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    mjsRuntimeRegexHelper,
    mjsRuntimeRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/mjs-runtime-room-regex.mts': 1,
  });
  const importEqualsRegexHelper = {
    file: 'peer/import-equals-room-regex.cts',
    text: String.raw`const ROOM_ID = /^\d{1,21}$/; export = ROOM_ID;`,
  };
  const importEqualsRegexConsumer = {
    file: 'peer/import-equals-room-consumer.cts',
    text: "import ROOM_ID = require('./import-equals-room-regex.cjs'); function validateRoom(room) { return ROOM_ID.test(room.guildId); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importEqualsRegexHelper,
    importEqualsRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/import-equals-room-regex.cts': 1,
  });
  const importEqualsRegexNegativeConsumer = {
    file: 'peer/import-equals-room-negative-consumer.cts',
    text: "import ROOM_ID = require('./import-equals-room-regex.cjs'); function inspectRoom(room) { return ROOM_ID.test(room.name); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importEqualsRegexHelper,
    importEqualsRegexNegativeConsumer,
  ]), expectedPolicies);
  const boundRegexStringRoom = {
    file: 'peer/bound-regex-string-room.ts',
    text: String.raw`function validateTownHallRoom(room) {
      const SOURCE = '^\\d{1,21}$';
      const ROOM_ID = new RegExp(SOURCE);
      return ROOM_ID.test(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, boundRegexStringRoom]), {
    ...expectedPolicies,
    'peer/bound-regex-string-room.ts': 1,
  });
  const boundRegexStringNegativeRoom = {
    file: 'peer/bound-regex-string-negative-room.ts',
    text: String.raw`function inspectRoom(room) {
      const SOURCE = '^\\d{1,21}$';
      const ROOM_ID = new RegExp(SOURCE);
      return ROOM_ID.test(room.name);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, boundRegexStringNegativeRoom]), expectedPolicies);
  const importedRegexStringHelper = {
    file: 'peer/imported-room-regex-source.ts',
    text: String.raw`export const ROOM_ID_SOURCE = '^\\d{1,21}$';`,
  };
  const importedRegexStringConsumer = {
    file: 'peer/imported-room-regex-source-consumer.ts',
    text: "import { ROOM_ID_SOURCE } from './imported-room-regex-source'; function validateRoom(room) { return new RegExp(ROOM_ID_SOURCE).test(room.guildId); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedRegexStringHelper,
    importedRegexStringConsumer,
  ]), {
    ...expectedPolicies,
    'peer/imported-room-regex-source-consumer.ts': 1,
  });
  const importedRegexStringNegativeConsumer = {
    file: 'peer/imported-room-regex-source-negative-consumer.ts',
    text: "import { ROOM_ID_SOURCE } from './imported-room-regex-source'; function inspectRoom(room) { return new RegExp(ROOM_ID_SOURCE).test(room.name); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedRegexStringHelper,
    importedRegexStringNegativeConsumer,
  ]), expectedPolicies);
  const importedRegexStringAliasConsumer = {
    file: 'peer/imported-room-regex-source-alias-consumer.ts',
    text: String.raw`import { ROOM_ID_SOURCE } from './imported-room-regex-source';
    const LOCAL_ROOM_ID_SOURCE = ROOM_ID_SOURCE;
    function validateRoom(room) { return new RegExp(LOCAL_ROOM_ID_SOURCE).test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedRegexStringHelper,
    importedRegexStringAliasConsumer,
  ]), {
    ...expectedPolicies,
    [importedRegexStringAliasConsumer.file]: 1,
  });
  const importedRegexStringAliasNegativeConsumer = {
    file: 'peer/imported-room-regex-source-alias-negative-consumer.ts',
    text: String.raw`import { ROOM_ID_SOURCE } from './imported-room-regex-source';
    const LOCAL_ROOM_ID_SOURCE = ROOM_ID_SOURCE;
    function inspectRoom(room) { return new RegExp(LOCAL_ROOM_ID_SOURCE).test(room.name); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedRegexStringHelper,
    importedRegexStringAliasNegativeConsumer,
  ]), expectedPolicies);
  const unicodeDecimalRoom = {
    file: 'peer/unicode-decimal-room.ts',
    text: String.raw`function validateTownHallRoom(room) {
      return /^\p{Decimal_Number}{1,20}$/u.test(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, unicodeDecimalRoom]), {
    ...expectedPolicies,
    'peer/unicode-decimal-room.ts': 1,
  });
  const unicodeDecimalNegativeRoom = {
    file: 'peer/unicode-decimal-negative-room.ts',
    text: String.raw`function inspectRoom(room) {
      return /^\p{Decimal_Number}{1,20}$/u.test(room.name);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, unicodeDecimalNegativeRoom]), expectedPolicies);
  const shadowedRegex = {
    file: 'peer/snowflake.ts',
    text: String.raw`const ROOM_ID = /^\d+$/;
    function validateRoom(room) {
      const ROOM_ID = /^not-a-room$/;
      return ROOM_ID.test(room.guildId);
    }`
  };
  assert.deepEqual(roomDigitPolicies([...records, shadowedRegex]), expectedPolicies);
  const importedRoomHelper = {
    file: 'peer/future-helper.ts',
    text: 'export function validateGuildId(value) { return /^\\d{1,21}$/.test(value); }'
  };
  const importedRoomConsumer = {
    file: 'peer/future-consumer.ts',
    text: "import { validateGuildId } from './future-helper'; function validateRoom(room) { return validateGuildId(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([...records, importedRoomHelper, importedRoomConsumer]), {
    ...expectedPolicies,
    'peer/future-helper.ts': 1
  });
  const barrelRoomHelper = {
    file: 'peer/barrel-room.ts',
    text: 'export function validateGuildId(value) { return /^\\d{1,21}$/.test(value); }'
  };
  const barrelRoom = {
    file: 'peer/barrel.ts',
    text: "export { validateGuildId } from './barrel-room';"
  };
  const barrelRoomConsumer = {
    file: 'peer/barrel-consumer.ts',
    text: "import { validateGuildId } from './barrel'; function validateRoom(room) { return validateGuildId(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    barrelRoomHelper,
    barrelRoom,
    barrelRoomConsumer,
  ]), {
    ...expectedPolicies,
    'peer/barrel-room.ts': 1
  });
  const wildcardBarrelRoomHelper = {
    file: 'peer/wildcard-barrel-room.ts',
    text: 'export function validateGuildId(value) { return /^\\d{1,21}$/.test(value); }'
  };
  const wildcardBarrelRoom = {
    file: 'peer/wildcard-barrel.ts',
    text: "export * from './wildcard-barrel-room';"
  };
  const wildcardBarrelRoomConsumer = {
    file: 'peer/wildcard-barrel-consumer.ts',
    text: "import { validateGuildId } from './wildcard-barrel'; function validateRoom(room) { return validateGuildId(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    wildcardBarrelRoomHelper,
    wildcardBarrelRoom,
    wildcardBarrelRoomConsumer,
  ]), {
    ...expectedPolicies,
    'peer/wildcard-barrel-room.ts': 1
  });
  const objectMethodValidator = {
    file: 'peer/object-method-validator.ts',
    text: String.raw`const validators = {
      validateGuildId(value) { return /^\d{1,21}$/.test(value); }
    };
    function validateRoom(room) { return validators.validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, objectMethodValidator]), {
    ...expectedPolicies,
    'peer/object-method-validator.ts': 1
  });
  const functionPropertyValidator = {
    file: 'peer/function-property-validator.ts',
    text: String.raw`const validators = {
      validateGuildId: value => /^\d{1,21}$/.test(value)
    };
    function validateRoom(room) { return validators.validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, functionPropertyValidator]), {
    ...expectedPolicies,
    'peer/function-property-validator.ts': 1
  });
  const aliasedFunctionPropertyValidator = {
    file: 'peer/function-property-alias-validator.ts',
    text: "const validators = { validateGuildId: value => /^\\d{1,21}$/.test(value) }; const validateGuildId = validators.validateGuildId; function validateRoom(room) { return validateGuildId(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([...records, aliasedFunctionPropertyValidator]), {
    ...expectedPolicies,
    'peer/function-property-alias-validator.ts': 1
  });
  const functionExpressionPropertyValidator = {
    file: 'peer/function-expression-property-validator.ts',
    text: String.raw`const validators = {
      validateChannelId: function (value) { return /^\d{1,21}$/.test(value); }
    };
    function validateRoom(room) { return validators.validateChannelId(room.channelId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, functionExpressionPropertyValidator]), {
    ...expectedPolicies,
    'peer/function-expression-property-validator.ts': 1
  });
  const classValidator = {
    file: 'peer/class-validator.ts',
    text: String.raw`class Validators {
      static validateGuildId(value) { return /^\d{1,21}$/.test(value); }
    }
    function validateRoom(room) { return Validators.validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, classValidator]), {
    ...expectedPolicies,
    'peer/class-validator.ts': 1
  });
  const renamedParameter = { file: 'peer/future-room.ts', text: String.raw`function validateTownHallRoom(candidate) {
    return /^\d{1,21}$/.test(candidate.guildId);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, renamedParameter]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const guardedRoomKeyAlias = { file: 'peer/future-room.ts', text: String.raw`function ownDataProperty(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined;
    return descriptor.value;
  }
  function validateTownHallRoom(candidate) {
    const id = ownDataProperty(candidate, 'guildId');
    return /^\d{1,21}$/.test(id);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, guardedRoomKeyAlias]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const matchRoomField = { file: 'peer/future-room.ts', text: String.raw`function validateTownHallRoom(candidate) {
    return candidate.guildId.match(/^\d{1,21}$/);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, matchRoomField]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const execRoomField = { file: 'peer/future-room.ts', text: String.raw`function validateTownHallRoom(candidate) {
    return /^\d{1,21}$/.exec(candidate.channelId);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, execRoomField]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const searchRoomField = { file: 'peer/future-room.ts', text: String.raw`function validateTownHallRoom(candidate) {
    return candidate.guildId.search(/^\d{1,21}$/) !== -1;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, searchRoomField]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const prototypeSearchRoomField = {
    file: 'peer/future-room.ts',
    text: 'function validateTownHallRoom(candidate) { const pattern = /^\\d{1,21}$/; return String.prototype.search.call(candidate.guildId, pattern) !== -1; }'
  };
  assert.deepEqual(roomDigitPolicies([...records, prototypeSearchRoomField]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const anonymousDefaultValidator = {
    file: 'peer/anonymous-default-validator.ts',
    text: String.raw`export default function (value) { return /^\d{1,21}$/.test(value); }`
  };
  const anonymousDefaultConsumer = {
    file: 'peer/anonymous-default-consumer.ts',
    text: String.raw`import validateGuildId from './anonymous-default-validator';
    function validateRoom(room) { return validateGuildId(room.channelId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    anonymousDefaultValidator,
    anonymousDefaultConsumer,
  ]), {
    ...expectedPolicies,
    'peer/anonymous-default-validator.ts': 1
  });
  const defaultExpressionValidator = {
    file: 'peer/default-expression-validator.ts',
    text: String.raw`export default (value) => /^\d{1,21}$/.test(value);`
  };
  const defaultExpressionConsumer = {
    file: 'peer/default-expression-consumer.ts',
    text: String.raw`import validateGuildId from './default-expression-validator';
    function validateRoom(room) { return validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    defaultExpressionValidator,
    defaultExpressionConsumer,
  ]), {
    ...expectedPolicies,
    'peer/default-expression-validator.ts': 1
  });
  const identifierDefaultValidator = {
    file: 'peer/identifier-default-validator.ts',
    text: String.raw`function validateGuildId(value) { return /^\d{1,21}$/.test(value); }
    export default validateGuildId;`
  };
  const identifierDefaultConsumer = {
    file: 'peer/identifier-default-consumer.ts',
    text: String.raw`import validateGuildId from './identifier-default-validator';
    function validateRoom(room) { return validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    identifierDefaultValidator,
    identifierDefaultConsumer,
  ]), {
    ...expectedPolicies,
    'peer/identifier-default-validator.ts': 1
  });
  const moduleSpecificValidator = {
    file: 'peer/module-specific-room-validator.cts',
    text: String.raw`export function validateGuildId(value) { return /^\d{1,21}$/.test(value); }`
  };
  const moduleSpecificConsumer = {
    file: 'peer/module-specific-room-consumer.cjs',
    text: String.raw`const { validateGuildId } = require('./module-specific-room-validator');
    function validateRoom(room) { return validateGuildId(room.channelId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    moduleSpecificValidator,
    moduleSpecificConsumer,
  ]), {
    ...expectedPolicies,
    'peer/module-specific-room-validator.cts': 1
  });
  const unrelatedMatch = { file: 'peer/snowflake.ts', text: String.raw`function inspect(candidate) {
    return candidate.guildId.match(/^\d{1,21}$/);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, unrelatedMatch]), expectedPolicies);
  const unrelatedExec = { file: 'peer/snowflake.ts', text: String.raw`function inspect(candidate) {
    return /^\d{1,21}$/.exec(candidate.channelId);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, unrelatedExec]), expectedPolicies);
  const unrelatedSearch = { file: 'peer/snowflake.ts', text: String.raw`function inspect(candidate) {
    return candidate.guildId.search(/^\d{1,21}$/) !== -1;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, unrelatedSearch]), expectedPolicies);
  const unrelatedBounded = { file: 'peer/snowflake.ts', text: String.raw`function boundedId(value) { return /^\d{1,20}$/.test(value); }
    function validateUser(user) { return boundedId(user.id); }` };
  assert.deepEqual(roomDigitPolicies([...records, unrelatedBounded]), expectedPolicies);
  const unrelatedOwnerPattern = { file: 'peer/town-hall-plan.ts', text: String.raw`function isTownHallRoom(value) { return /^\d{1,20}$/.test(value); }` };
  assert.deepEqual(roomDigitPolicies([...records, unrelatedOwnerPattern]), expectedPolicies);
  const splitNeutral = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(room) {
    return /^\d+$/.test(room.guildId) && room.guildId.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, splitNeutral]), expectedPolicies);
  const neutralSplitValidator = {
    file: 'peer/snowflake.ts',
    text: "function validate(value) { return /^\\d+$/.test(value) && value.length <= 20; } function inspect(room) { return validate(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([...records, neutralSplitValidator]), expectedPolicies);
  const splitAlias = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(room) {
    const value = room.channelId;
    return /^\d+$/.test(value) && value.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, splitAlias]), expectedPolicies);
  const splitCall = { file: 'peer/snowflake.ts', text: String.raw`function isSnowflake(value) {
    return /^\d+$/.test(value) && value.length <= 20;
  }
  function inspect(room) { return isSnowflake(room.guildId); }` };
  assert.deepEqual(roomDigitPolicies([...records, splitCall]), expectedPolicies);
  const splitCallAlias = {
    file: 'peer/snowflake.ts',
    text: "function isSnowflake(value) { return /^\\d+$/.test(value) && value.length <= 20; } function inspect(room) { const check = isSnowflake; return check(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([...records, splitCallAlias]), expectedPolicies);
  const bracketField = { file: 'peer/snowflake.ts', text: String.raw`function inspect(room) {
    return /^\d+$/.test(room['guildId']);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, bracketField]), expectedPolicies);
  const arrowBound = { file: 'peer/snowflake.ts', text: String.raw`const isDigits = value => /^\d+$/.test(value) && value.length <= 20;
  function inspect(room) { return isDigits(room.guildId); }` };
  assert.deepEqual(roomDigitPolicies([...records, arrowBound]), expectedPolicies);
  const anonymousBound = { file: 'peer/snowflake.ts', text: String.raw`const isDigits = function(value) {
    return /^\d+$/.test(value) && value.length <= 20;
  };
  function inspect(room) { return isDigits(room.channelId); }` };
  assert.deepEqual(roomDigitPolicies([...records, anonymousBound]), expectedPolicies);
  const shadowedBound = { file: 'peer/snowflake.ts', text: String.raw`const isDigits = value => /^\d+$/.test(value) && value.length <= 20;
  function inspect(room) { return isDigits(room.guildId); }
  function shadowed(room, isDigits) { return isDigits(room.guildId); }
  function unrelated(user, isDigits) { return isDigits(user.id); }
  function unrelatedHelper(user) {
    const isDigits = value => /^\d+$/.test(value) && value.length <= 20;
    return isDigits(user.id);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, shadowedBound]), expectedPolicies);
  const emptyInitializer = { file: 'peer/town-hall-plan.ts', text: String.raw`function ownDataProperty(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined;
    return descriptor.value;
  }
  function isTownHallRoom(room) {
    const id = ownDataProperty(room, 'guildId');
    function nested() { let id; return /^\d+$/.test(id); }
    return /^\d+$/.test(id);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, emptyInitializer]), {
    ...expectedPolicies,
    'peer/town-hall-plan.ts': 3
  });
  const assignedAlias = { file: 'peer/town-hall-plan.ts', text: String.raw`function ownDataProperty(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined;
    return descriptor.value;
  }
  function isTownHallRoom(room) {
    let id;
    id = ownDataProperty(room, 'channelId');
    return /^\d+$/.test(id);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, assignedAlias]), {
    ...expectedPolicies,
    'peer/town-hall-plan.ts': 3
  });
  const emptySplit = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(room) {
    return /^\d*$/.test(room.guildId) && room.guildId.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, emptySplit]), expectedPolicies);
  const emptyTownHallSplit = { file: 'peer/private-town-hall-room.ts', text: String.raw`function isPrivateTownHallRoom(room) {
    return /^\d*$/.test(room.guildId) && room.guildId.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, emptyTownHallSplit]), {
    ...expectedPolicies,
    'peer/private-town-hall-room.ts': 1
  });
  const emptyAlias = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(room) {
    const value = room.channelId;
    return /^\d*$/.test(value) && value.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, emptyAlias]), expectedPolicies);
  const emptyCall = { file: 'peer/snowflake.ts', text: String.raw`function isSnowflake(value) {
    return /^\d*$/.test(value) && value.length <= 20;
  }
  function inspect(room) { return isSnowflake(room.channelId); }` };
  assert.deepEqual(roomDigitPolicies([...records, emptyCall]), expectedPolicies);
  const ordinarySplit = { file: 'peer/snowflake.ts', text: String.raw`function validateSnowflake(value) {
    return /^\d+$/.test(value) && value.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, ordinarySplit]), expectedPolicies);
  const ordinaryFieldSplit = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(user) {
    return /^\d+$/.test(user.guildId) && user.guildId.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, ordinaryFieldSplit]), expectedPolicies);
  const ordinaryCall = { file: 'peer/snowflake.ts', text: String.raw`function isSnowflake(value) {
    return /^\d+$/.test(value) && value.length <= 20;
  }
  function inspect(user) { return isSnowflake(user.guildId); }` };
  assert.deepEqual(roomDigitPolicies([...records, ordinaryCall]), expectedPolicies);
  const blockHoistedVarRoomValidator = {
    file: 'peer/block-hoisted-var-room-validator.ts',
    text: String.raw`function validateTownHallRoom(room) {
      { var id = room.guildId; }
      return /^\d{1,21}$/.test(id);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, blockHoistedVarRoomValidator]), {
    ...expectedPolicies,
    'peer/block-hoisted-var-room-validator.ts': 1,
  });
  const blockHoistedVarNegativeControl = {
    file: 'peer/block-hoisted-var-negative-control.ts',
    text: String.raw`function validateTownHallRoom(room) {
      { var id = room.name; }
      return /^\d{1,21}$/.test(id);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, blockHoistedVarNegativeControl]), expectedPolicies);
  const runtimeCtsHelper = {
    file: 'peer/runtime-room-helper.cts',
    text: String.raw`export function validateGuildId(value) { return /^\d{1,21}$/.test(value); }`,
  };
  const runtimeCjsConsumer = {
    file: 'peer/runtime-room-consumer.cjs',
    text: String.raw`const { validateGuildId } = require('./runtime-room-helper.cjs');
    function validateTownHallRoom(room) { return validateGuildId(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    runtimeCtsHelper,
    runtimeCjsConsumer,
  ]), {
    ...expectedPolicies,
    'peer/runtime-room-helper.cts': 1,
  });
  const runtimeMtsHelper = {
    file: 'peer/runtime-mts-helper.mts',
    text: String.raw`export function validateGuildId(value) { return /^\d{1,21}$/.test(value); }`,
  };
  const runtimeMjsConsumer = {
    file: 'peer/runtime-mjs-consumer.mjs',
    text: String.raw`import { validateGuildId } from './runtime-mts-helper.mjs';
    function validateTownHallRoom(room) { return validateGuildId(room.channelId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    runtimeMtsHelper,
    runtimeMjsConsumer,
  ]), {
    ...expectedPolicies,
    'peer/runtime-mts-helper.mts': 1,
  });
  const directCommonJsRegex = {
    file: 'peer/direct-commonjs-regex.cjs',
    text: String.raw`module.exports = /^\d{1,21}$/;`,
  };
  const directCommonJsRegexConsumer = {
    file: 'peer/direct-commonjs-regex-consumer.cjs',
    text: String.raw`const ROOM_ID = require('./direct-commonjs-regex.cjs');
    function validateTownHallRoom(room) { return ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    directCommonJsRegex,
    directCommonJsRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/direct-commonjs-regex.cjs': 1,
  });
  const commonJsNamespaceRegexHelper = {
    file: 'peer/commonjs-namespace-room-patterns.cjs',
    text: String.raw`module.exports = { ROOM_ID: /^\d{1,21}$/ };`,
  };
  const commonJsNamespaceRegexConsumer = {
    file: 'peer/commonjs-namespace-room-consumer.cjs',
    text: String.raw`const patterns = require('./commonjs-namespace-room-patterns.cjs');
    function validateTownHallRoom(room) { return patterns.ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    commonJsNamespaceRegexHelper,
    commonJsNamespaceRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/commonjs-namespace-room-patterns.cjs': 1,
  });
  const commonJsNamespaceVoiceConsumer = {
    file: 'peer/commonjs-namespace-room-voice-consumer.cjs',
    text: String.raw`const patterns = require('./commonjs-namespace-room-patterns.cjs');
    function validateVoiceRoom(room) { return patterns.ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    commonJsNamespaceRegexHelper,
    commonJsNamespaceVoiceConsumer,
  ]), expectedPolicies);
  const nestedCommonJsNamespaceConsumer = {
    file: 'peer/nested-commonjs-namespace-consumer.cjs',
    text: String.raw`function validateTownHallRoom(room) {
      const { ROOM_ID } = require('./commonjs-namespace-room-patterns.cjs');
      return ROOM_ID.test(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    commonJsNamespaceRegexHelper,
    nestedCommonJsNamespaceConsumer,
  ]), {
    ...expectedPolicies,
    [commonJsNamespaceRegexHelper.file]: 1,
  });
  const nestedCommonJsNamespaceVoiceConsumer = {
    file: 'peer/nested-commonjs-namespace-voice-consumer.cjs',
    text: String.raw`function validateVoiceRoom(room) {
      const { ROOM_ID } = require('./commonjs-namespace-room-patterns.cjs');
      return ROOM_ID.test(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    commonJsNamespaceRegexHelper,
    nestedCommonJsNamespaceVoiceConsumer,
  ]), expectedPolicies);
  const commonJsNamespaceShadowConsumer = {
    file: 'peer/commonjs-namespace-room-shadow-consumer.cjs',
    text: String.raw`const patterns = require('./commonjs-namespace-room-patterns.cjs');
    function validateTownHallRoom(room, patterns) { return patterns.ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    commonJsNamespaceRegexHelper,
    commonJsNamespaceShadowConsumer,
  ]), expectedPolicies);
  const directCommonJsMemberHelper = {
    file: 'peer/direct-commonjs-member.cjs',
    text: String.raw`module.exports = { validateGuildId(value) {
      return /^\d{1,21}$/.test(value);
    } };`,
  };
  const directCommonJsMemberConsumer = {
    file: 'peer/direct-commonjs-member-consumer.cjs',
    text: String.raw`function validateTownHallRoom(room) {
      return require('./direct-commonjs-member.cjs').validateGuildId(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    directCommonJsMemberHelper,
    directCommonJsMemberConsumer,
  ]), {
    ...expectedPolicies,
    'peer/direct-commonjs-member.cjs': 1,
  });
  const instanceValidator = {
    file: 'peer/instance-validator.ts',
    text: String.raw`class Validators {
      validateGuildId(value) { return /^\d{1,21}$/.test(value); }
    }
    function validateTownHallRoom(room) {
      return new Validators().validateGuildId(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, instanceValidator]), {
    ...expectedPolicies,
    'peer/instance-validator.ts': 1,
  });
  const typedRegexValidator = {
    file: 'peer/typed-regex-validator.ts',
    text: String.raw`function validateTownHallRoom(room) {
      const first = /^\d{1,21}$/ satisfies RegExp;
      const second = /^\d{1,21}$/ as RegExp;
      return first.test(room.guildId) && second.test(room.channelId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, typedRegexValidator]), {
    ...expectedPolicies,
    'peer/typed-regex-validator.ts': 2,
  });
  const ordinaryGenericRoom = {
    file: 'peer/ordinary.ts',
    text: String.raw`function validateRoom(room) {
      return /^\d{1,20}$/.test(room.guildId);
    }`,
  };
  const voiceGenericRoom = {
    file: 'other/voice-room.ts',
    text: String.raw`function validateRoom(room) {
      return /^\d{1,20}$/.test(room.guildId);
    }`,
  };
  const snowflakeTownHallRoom = {
    file: 'peer/snowflake.ts',
    text: String.raw`function validateTownHallRoom(room) {
      return /^\d{1,20}$/.test(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    ordinaryGenericRoom,
    voiceGenericRoom,
    snowflakeTownHallRoom,
  ]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1,
  });
  const reviewInlineCommonJsObject = {
    file: 'peer/inline-commonjs-object.cjs',
    text: String.raw`module.exports = {
      validateGuildId(value) { return /^\d{1,21}$/.test(value); },
      validateChannelId: value => /^\d{1,21}$/.test(value),
    };`,
  };
  const reviewInlineCommonJsObjectConsumer = {
    file: 'peer/inline-commonjs-object-consumer.cjs',
    text: String.raw`const { validateGuildId, validateChannelId } =
      require('./inline-commonjs-object.cjs');
    function validateTownHallRoom(room) {
      return validateGuildId(room.guildId) && validateChannelId(room.channelId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    reviewInlineCommonJsObject,
    reviewInlineCommonJsObjectConsumer,
  ]), {
    ...expectedPolicies,
    'peer/inline-commonjs-object.cjs': 2,
  });
  const bracketedCommonJsHelper = {
    file: 'peer/bracketed-commonjs-helper.cjs',
    text: String.raw`exports['validateGuildId'] = value => /^\d{1,21}$/.test(value);`,
  };
  const bracketedCommonJsConsumer = {
    file: 'peer/bracketed-commonjs-consumer.cjs',
    text: String.raw`const { validateGuildId } = require('./bracketed-commonjs-helper.cjs');
    function validateTownHallRoom(room) { return validateGuildId(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    bracketedCommonJsHelper,
    bracketedCommonJsConsumer,
  ]), {
    ...expectedPolicies,
    'peer/bracketed-commonjs-helper.cjs': 1,
  });
  const reviewExportEqualsHelper = {
    file: 'peer/export-equals-helper.cts',
    text: String.raw`function validateGuildId(value) { return /^\d{1,21}$/.test(value); }
    export = validateGuildId;`,
  };
  const reviewExportEqualsConsumer = {
    file: 'peer/export-equals-consumer.cjs',
    text: String.raw`const validateGuildId = require('./export-equals-helper.cjs');
    function validateTownHallRoom(room) { return validateGuildId(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    reviewExportEqualsHelper,
    reviewExportEqualsConsumer,
  ]), {
    ...expectedPolicies,
    'peer/export-equals-helper.cts': 1,
  });
  const importedRegexShadowConsumer = {
    file: 'peer/imported-regex-shadow-consumer.ts',
    text: String.raw`import { ROOM_ID } from './imported-room-regex';
    function validateTownHallRoom(ROOM_ID, room) { return ROOM_ID.test(room.guildId); }`,
  };
  const importedRegexAliasConsumer = {
    file: 'peer/imported-regex-alias-consumer.ts',
    text: String.raw`import { ROOM_ID } from './imported-room-regex';
    const VALIDATOR = ROOM_ID;
    function validateTownHallRoom(room) { return VALIDATOR.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedRegexHelper,
    importedRegexAliasConsumer,
  ]), {
    ...expectedPolicies,
    [importedRegexHelper.file]: 1,
  });
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedRegexHelper,
    importedRegexShadowConsumer,
  ]), expectedPolicies);
  const namespaceShadowReferenceFixture = ts.createSourceFile(
    'peer/namespace-shadow-reference-fixture.ts',
    String.raw`import * as plan from './town-hall-plan';
    function shadow(plan) { return plan.isTownHallRoom({}); }
    plan.isTownHallRoom({});`,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(namespaceShadowReferenceFixture, 'isTownHallRoom'), 1);
  const runtimeCjsVoiceConsumer = {
    file: 'peer/runtime-cjs-voice-consumer.cjs',
    text: String.raw`const { validateGuildId } = require('./runtime-room-helper.cjs');
    function validateVoiceRoom(room) { return validateGuildId(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    runtimeCtsHelper,
    runtimeCjsVoiceConsumer,
  ]), expectedPolicies);
  const runtimeMjsVoiceConsumer = {
    file: 'peer/runtime-mjs-voice-consumer.mjs',
    text: String.raw`import { validateGuildId } from './runtime-mts-helper.mjs';
    function validateVoiceRoom(room) { return validateGuildId(room.channelId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    runtimeMtsHelper,
    runtimeMjsVoiceConsumer,
  ]), expectedPolicies);
  const staticClassRoomPatterns = {
    file: 'peer/static-class-room-patterns.ts',
    text: String.raw`class TownHallPatterns {
      static ROOM_ID = /^\d{1,21}$/;
    }
    function validateTownHallRoom(room) { return TownHallPatterns.ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, staticClassRoomPatterns]), {
    ...expectedPolicies,
    [staticClassRoomPatterns.file]: 1,
  });
  const staticClassOrdinaryInput = {
    file: 'peer/static-class-ordinary-input.ts',
    text: String.raw`class Patterns { static ROOM_ID = /^\d{1,21}$/; }
    function inspectRoom(room) { return Patterns.ROOM_ID.test(room.name); }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, staticClassOrdinaryInput]), expectedPolicies);
  const nestedRoomParameter = {
    file: 'peer/nested-room-parameter.ts',
    text: String.raw`function validateTownHallRoom({ room: { guildId } }) {
      return /^\d{1,21}$/.test(guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, nestedRoomParameter]), {
    ...expectedPolicies,
    [nestedRoomParameter.file]: 1,
  });
  const nestedOrdinaryParameter = {
    file: 'peer/nested-ordinary-parameter.ts',
    text: String.raw`function inspectRoom({ user: { guildId } }) {
      return /^\d{1,21}$/.test(guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, nestedOrdinaryParameter]), expectedPolicies);
  const computedRoomKeys = {
    file: 'peer/computed-room-keys.ts',
    text: String.raw`const ROOM_KEYS = ['guildId', 'channelId'] as const;
    function validateTownHallRoom(room) {
      for (const key of ROOM_KEYS) if (!/^\d{1,21}$/.test(room[key])) return false;
      return true;
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, computedRoomKeys]), {
    ...expectedPolicies,
    [computedRoomKeys.file]: 1,
  });
  const computedOrdinaryKey = {
    file: 'peer/computed-ordinary-key.ts',
    text: String.raw`function inspectRoom(room) {
      for (const key of ['name']) if (!/^\d{1,21}$/.test(room[key])) return false;
      return true;
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, computedOrdinaryKey]), expectedPolicies);
  const conditionalRoomFields = {
    file: 'peer/conditional-room-fields.ts',
    text: String.raw`function validateTownHallRoom(room, useGuild) {
      return /^\d{1,21}$/.test(useGuild ? room.guildId : room.channelId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, conditionalRoomFields]), {
    ...expectedPolicies,
    [conditionalRoomFields.file]: 1,
  });
  const conditionalMixedRoomFields = {
    file: 'peer/conditional-mixed-room-fields.ts',
    text: String.raw`function validateTownHallRoom(room, useGuild) {
      return /^\d{1,21}$/.test(useGuild ? room.guildId : room.name);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, conditionalMixedRoomFields]), expectedPolicies);
  const callbackRoomKeys = {
    file: 'peer/callback-room-keys.ts',
    text: String.raw`function validateTownHallRoom(room) {
      return ['guildId', 'channelId'].every(key => /^\d{1,21}$/.test(room[key]));
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, callbackRoomKeys]), {
    ...expectedPolicies,
    [callbackRoomKeys.file]: 1,
  });
  const callbackOrdinaryKeys = {
    file: 'peer/callback-ordinary-keys.ts',
    text: String.raw`function inspectRoom(room) {
      return ['name', 'topic'].every(key => /^\d{1,21}$/.test(room[key]));
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, callbackOrdinaryKeys]), expectedPolicies);
  const commonJsBarrelHelper = {
    file: 'peer/commonjs-barrel-room-helper.cts',
    text: String.raw`export function validateGuildId(value) { return /^\d{1,20}$/.test(value); }`,
  };
  const commonJsBarrel = {
    file: 'peer/commonjs-barrel.cjs',
    text: String.raw`module.exports = require('./commonjs-barrel-room-helper.cjs');`,
  };
  const commonJsBarrelConsumer = {
    file: 'peer/commonjs-barrel-consumer.cjs',
    text: String.raw`const { validateGuildId } = require('./commonjs-barrel.cjs');
    function validateTownHallRoom(room) { return validateGuildId(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    commonJsBarrelHelper,
    commonJsBarrel,
    commonJsBarrelConsumer,
  ]), {
    ...expectedPolicies,
    [commonJsBarrelHelper.file]: 1,
  });
  const commonJsBarrelVoiceConsumer = {
    file: 'peer/commonjs-barrel-voice-consumer.cjs',
    text: String.raw`const { validateGuildId } = require('./commonjs-barrel.cjs');
    function validateVoiceRoom(room) { return validateGuildId(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    commonJsBarrelHelper,
    commonJsBarrel,
    commonJsBarrelVoiceConsumer,
  ]), expectedPolicies);
  const namedCommonJsPatternHelper = {
    file: 'peer/named-commonjs-patterns.cts',
    text: String.raw`exports.ROOM_ID = /^\d{1,21}$/;`,
  };
  const namedCommonJsPatternBarrel = {
    file: 'peer/named-commonjs-patterns-barrel.cjs',
    text: String.raw`exports.ROOM_ID = require('./named-commonjs-patterns.cjs').ROOM_ID;`,
  };
  const namedCommonJsPatternConsumer = {
    file: 'peer/named-commonjs-pattern-consumer.cjs',
    text: String.raw`const { ROOM_ID } = require('./named-commonjs-patterns-barrel.cjs');
    function validateTownHallRoom(room) { return ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    namedCommonJsPatternHelper,
    namedCommonJsPatternBarrel,
    namedCommonJsPatternConsumer,
  ]), {
    ...expectedPolicies,
    [namedCommonJsPatternHelper.file]: 1,
  });
  const namedCommonJsVoicePatternHelper = {
    file: 'peer/commonjs-voice-patterns.cts',
    text: String.raw`exports.ROOM_ID = /^\d{1,21}$/;`,
  };
  const namedCommonJsVoicePatternBarrel = {
    file: 'peer/commonjs-voice-patterns-barrel.cjs',
    text: String.raw`module.exports.ROOM_ID = require('./commonjs-voice-patterns.cjs').ROOM_ID;`,
  };
  const namedCommonJsVoicePatternConsumer = {
    file: 'peer/commonjs-voice-pattern-voice-room.cjs',
    text: String.raw`const { ROOM_ID } = require('./commonjs-voice-patterns-barrel.cjs');
    function inspectVoiceRoom(room) { return ROOM_ID.test(room.name); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    namedCommonJsVoicePatternHelper,
    namedCommonJsVoicePatternBarrel,
    namedCommonJsVoicePatternConsumer,
  ]), expectedPolicies);
  const callHelperRoom = {
    file: 'peer/call-helper-room.ts',
    text: String.raw`function validateGuildId(value) { return /^\d{1,21}$/.test(value); }
    function validateTownHallRoom(room) { return validateGuildId.call(null, room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, callHelperRoom]), {
    ...expectedPolicies,
    [callHelperRoom.file]: 1,
  });
  const callHelperVoice = {
    file: 'peer/call-helper-voice.ts',
    text: String.raw`function validateGuildId(value) { return /^\d{1,21}$/.test(value); }
    function validateVoiceRoom(room) { return validateGuildId.call(null, room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, callHelperVoice]), expectedPolicies);
  const matcherHelperRoom = {
    file: 'peer/matcher-helper-room.ts',
    text: String.raw`function matches(value, pattern) { return pattern.test(value); }
    function validateTownHallRoom(room) { return matches(room.guildId, /^\d{1,21}$/); }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, matcherHelperRoom]), {
    ...expectedPolicies,
    [matcherHelperRoom.file]: 1,
  });
  const matcherHelperOrdinaryField = {
    file: 'peer/matcher-helper-ordinary-field.ts',
    text: String.raw`function matches(value, pattern) { return pattern.test(value); }
    function validateTownHallRoom(room) { return matches(room.name, /^\d{1,21}$/); }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, matcherHelperOrdinaryField]), expectedPolicies);
  const defaultObjectShadowConsumer = {
    file: 'peer/default-object-room-regex-shadow-consumer.ts',
    text: "import patterns from './default-object-room-regex'; function inspectRoom(patterns, room) { return patterns.ROOM_ID.test(room.guildId); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    defaultObjectRegexHelper,
    defaultObjectShadowConsumer,
  ]), expectedPolicies);
  const importedRegexStringShadowConsumer = {
    file: 'peer/imported-room-regex-source-shadow-consumer.ts',
    text: "import { ROOM_ID_SOURCE } from './imported-room-regex-source'; function inspectRoom(ROOM_ID_SOURCE, room) { return new RegExp(ROOM_ID_SOURCE).test(room.guildId); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedRegexStringHelper,
    importedRegexStringShadowConsumer,
  ]), expectedPolicies);
  const hoistedVarReferenceFixture = ts.createSourceFile(
    'peer/hoisted-var-reference-fixture.ts',
    String.raw`export function isTownHallRoom(room) { return room; }
    function localGuard(room) { return room; }
    function check(value) { { var isTownHallRoom = localGuard; } return isTownHallRoom(value); }
    isTownHallRoom({});`,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(hoistedVarReferenceFixture, 'isTownHallRoom'), 1);
  const nestedCommonJsReferenceFixture = ts.createSourceFile(
    'peer/nested-commonjs-reference-fixture.cjs',
    String.raw`function check(value) {
      const { isTownHallRoom: roomGuard } = require('./town-hall-plan');
      return roomGuard(value);
    }`,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(nestedCommonJsReferenceFixture, 'isTownHallRoom'), 1);
  const nestedCommonJsShadowFixture = ts.createSourceFile(
    'peer/nested-commonjs-shadow-fixture.cjs',
    String.raw`const plan = require('./town-hall-plan');
    function check(plan) { return plan.isTownHallRoom({}); }`,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(nestedCommonJsShadowFixture, 'isTownHallRoom'), 0);
  const importEqualsShadowReferenceFixture = ts.createSourceFile(
    'peer/import-equals-shadow-reference-fixture.cts',
    String.raw`import plan = require('./town-hall-plan.cjs');
    function shadow(plan) { return plan.isTownHallRoom({}); }
    plan.isTownHallRoom({});`,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(importEqualsShadowReferenceFixture, 'isTownHallRoom'), 1);
  const commonJsTownHallBarrelFixture = ts.createSourceFile(
    'peer/town-hall-plan-barrel.cjs',
    String.raw`module.exports = require('./town-hall-plan');`,
    ts.ScriptTarget.Latest,
    true,
  );
  const commonJsTownHallBarrelConsumerFixture = ts.createSourceFile(
    'peer/commonjs-town-hall-barrel-consumer.cjs',
    String.raw`const { isTownHallRoom: roomGuard } = require('./town-hall-plan-barrel.cjs');
    function check(room) { return roomGuard(room); }`,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(
    commonJsTownHallBarrelConsumerFixture,
    'isTownHallRoom',
    [commonJsTownHallBarrelFixture],
  ), 1);
  const namedCommonJsTownHallBarrelFixture = createSourceFile(
    'peer/named-town-hall-plan-barrel.cjs',
    String.raw`exports.isTownHallRoom = require('./town-hall-plan').isTownHallRoom;`);
  const namedCommonJsTownHallBarrelConsumerFixture = createSourceFile(
    'peer/named-commonjs-town-hall-barrel-consumer.cjs',
    String.raw`const { isTownHallRoom: roomGuard } = require('./named-town-hall-plan-barrel.cjs');
    roomGuard({});`);
  assert.equal(countIdentifierReferences(namedCommonJsTownHallBarrelConsumerFixture, 'isTownHallRoom', [
    namedCommonJsTownHallBarrelFixture,
    namedCommonJsTownHallBarrelConsumerFixture,
  ]), 1);
  const unrelatedNamedCommonJsBarrelFixture = createSourceFile(
    'peer/unrelated-named-town-hall-plan-barrel.cjs',
    String.raw`module.exports.isTownHallRoom = require('./voice-room').isTownHallRoom;`);
  const unrelatedNamedCommonJsBarrelConsumerFixture = createSourceFile(
    'peer/unrelated-named-commonjs-barrel-consumer.cjs',
    String.raw`const { isTownHallRoom: roomGuard } = require('./unrelated-named-town-hall-plan-barrel.cjs');
    roomGuard({});`);
  assert.equal(countIdentifierReferences(
    unrelatedNamedCommonJsBarrelConsumerFixture,
    'isTownHallRoom',
    [unrelatedNamedCommonJsBarrelFixture, unrelatedNamedCommonJsBarrelConsumerFixture],
  ), 0);
  const shadowedNamedCommonJsBarrelFixture = createSourceFile(
    'peer/shadowed-named-commonjs-barrel.cjs',
    String.raw`const module = {};
    module.exports.isTownHallRoom = require('./town-hall-plan').isTownHallRoom;
    const exports = {};
    exports.isTownHallRoom = require('./town-hall-plan').isTownHallRoom;`);
  const shadowedNamedCommonJsBarrelConsumerFixture = createSourceFile(
    'peer/shadowed-named-commonjs-barrel-consumer.cjs',
    String.raw`const { isTownHallRoom: roomGuard } = require('./shadowed-named-commonjs-barrel.cjs');
    roomGuard({});`);
  assert.equal(countIdentifierReferences(
    shadowedNamedCommonJsBarrelConsumerFixture,
    'isTownHallRoom',
    [shadowedNamedCommonJsBarrelFixture, shadowedNamedCommonJsBarrelConsumerFixture],
  ), 0);
  const unrelatedCommonJsBarrelFixture = ts.createSourceFile(
    'peer/unrelated-town-hall-plan-barrel.cjs',
    String.raw`module.exports = require('./voice-room');`,
    ts.ScriptTarget.Latest,
    true,
  );
  const unrelatedCommonJsBarrelConsumerFixture = ts.createSourceFile(
    'peer/unrelated-commonjs-barrel-consumer.cjs',
    String.raw`const { isTownHallRoom: roomGuard } = require('./unrelated-town-hall-plan-barrel.cjs');
    function check(room) { return roomGuard(room); }`,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(
    unrelatedCommonJsBarrelConsumerFixture,
    'isTownHallRoom',
    [unrelatedCommonJsBarrelFixture],
  ), 0);
  const esmNamedTownHallBarrelFixture = ts.createSourceFile(
    'peer/town-hall-plan-named-barrel.ts',
    "export { isTownHallRoom } from './town-hall-plan';",
    ts.ScriptTarget.Latest,
    true,
  );
  const esmNamedTownHallBarrelConsumerFixture = ts.createSourceFile(
    'peer/esm-named-town-hall-barrel-consumer.ts',
    "import { isTownHallRoom as roomGuard } from './town-hall-plan-named-barrel'; roomGuard({});",
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(
    esmNamedTownHallBarrelConsumerFixture,
    'isTownHallRoom',
    [esmNamedTownHallBarrelFixture],
  ), 1);
  const esmStarTownHallBarrelFixture = ts.createSourceFile(
    'peer/town-hall-plan-star-barrel.ts',
    "export * from './town-hall-plan';",
    ts.ScriptTarget.Latest,
    true,
  );
  const esmStarTownHallBarrelConsumerFixture = ts.createSourceFile(
    'peer/esm-star-town-hall-barrel-consumer.ts',
    "import { isTownHallRoom as roomGuard } from './town-hall-plan-star-barrel'; roomGuard({});",
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(
    esmStarTownHallBarrelConsumerFixture,
    'isTownHallRoom',
    [esmStarTownHallBarrelFixture],
  ), 1);
  const typeOnlyGuardReferenceFixture = ts.createSourceFile(
    'peer/type-only-guard-reference-fixture.ts',
    "import type { isTownHallRoom } from './town-hall-plan'; type Guard = typeof isTownHallRoom;",
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(typeOnlyGuardReferenceFixture, 'isTownHallRoom'), 0);
  const typeQueryGuardReferenceFixture = ts.createSourceFile(
    'peer/type-query-guard-reference-fixture.ts',
    "import { isTownHallRoom } from './town-hall-plan'; type Guard = typeof isTownHallRoom;",
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(typeQueryGuardReferenceFixture, 'isTownHallRoom'), 0);
  const copied = records.map(record => record.file === 'peer/town-hall-room-identity.ts'
    ? { ...record, text: record.text + inline.text } : record);
  assert.notDeepEqual(roomDigitPolicies(copied), expectedPolicies);
  const anonymousDefaultRoomFunction = {
    file: 'peer/town-hall-anonymous-function-validator.ts',
    text: 'export default function (room) { return /^\\d{1,20}$/.test(room.guildId); }',
  };
  assert.deepEqual(roomDigitPolicies([...records, anonymousDefaultRoomFunction]), {
    ...expectedPolicies,
    [anonymousDefaultRoomFunction.file]: 1,
  });
  const anonymousDefaultRoomArrow = {
    file: 'peer/town-hall-anonymous-arrow-validator.ts',
    text: 'export default room => /^\\d{1,20}$/.test(room.guildId);',
  };
  assert.deepEqual(roomDigitPolicies([...records, anonymousDefaultRoomArrow]), {
    ...expectedPolicies,
    [anonymousDefaultRoomArrow.file]: 1,
  });
  const ordinaryDefaultRoomFunction = {
    file: 'peer/ordinary-anonymous-function-validator.ts',
    text: 'export default function (room) { return /^\\d{1,20}$/.test(room.guildId); }',
  };
  const ordinaryDefaultRoomArrow = {
    file: 'peer/ordinary-anonymous-arrow-validator.ts',
    text: 'export default room => /^\\d{1,20}$/.test(room.guildId);',
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    ordinaryDefaultRoomFunction,
    ordinaryDefaultRoomArrow,
  ]), expectedPolicies);
});
