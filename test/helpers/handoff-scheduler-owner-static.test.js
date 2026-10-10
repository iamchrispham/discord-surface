'use strict';


const assert = require('node:assert/strict');

const fs = require('node:fs');

const os = require('node:os');

const path = require('node:path');

const test = require('node:test');

const Module = require('node:module');

const ts = require('typescript');

const { facadeOwnerInventory } = require('./facade-owner-inventory.cjs');

const {
  GATEWAY_PATH, OWNER_PATH, METHOD_HASHES, DEPENDENCY_NAMES,
  sourceFile, methodOf, hasExactFacade, classStateInventory, exactOwnerContract, withFakeTimers,
  schedulerReceiver, ownerFromText, EXPECTED_SCHEDULER_CALLSITES,
  schedulerCallsiteInventory, assertSchedulerCallsiteInventory
} = require('./handoff-scheduler-owner.cjs');


test('handoff scheduler owner preserves exact bodies, dependencies, facade shape and inventory', () => {
  assert.equal(exactOwnerContract(), true);
  const gateway = fs.readFileSync(GATEWAY_PATH, 'utf8');
  const owner = fs.readFileSync(OWNER_PATH, 'utf8');
  const ownerSource = sourceFile(OWNER_PATH, owner);
  const ownerFactory = ownerSource.statements.find(statement => ts.isFunctionDeclaration(statement) &&
    statement.name?.text === 'createHandoffSchedulerHandlers');
  assert.ok(ownerFactory);
  const deferredHandler = ownerFactory.body.statements.find(statement => ts.isFunctionDeclaration(statement) &&
    statement.name?.text === 'scheduleDeferredHandoffRecovery');
  assert.ok(deferredHandler);
  const channelParameter = deferredHandler.parameters[0].getText(ownerSource);
  assert.equal(exactOwnerContract({ ownerText: owner.replace(channelParameter, `${channelParameter} = 'fallback'`) }), false,
    'channel default changed missing and undefined behavior');
  assert.equal(exactOwnerContract({ ownerText: owner.replace(channelParameter, `...${channelParameter}`) }), false,
    'channel rest parameter changed the extracted handler contract');
  const dependencyElements = ownerFactory.parameters[0].name.elements;
  const firstDependency = dependencyElements[0];
  const lastDependency = dependencyElements[dependencyElements.length - 1];
  const firstDependencyName = firstDependency.name.getText(ownerSource);
  const lastDependencyName = lastDependency.name.getText(ownerSource);
  assert.equal(exactOwnerContract({ ownerText: owner.replace(firstDependency.getText(ownerSource),
    `unexpectedDependency: ${firstDependencyName}`) }), false,
  'factory dependency alias changed the injected property name');
  assert.equal(exactOwnerContract({ ownerText: owner.replace(firstDependency.getText(ownerSource),
    `${firstDependencyName} = undefined`) }), false,
  'factory dependency default changed the injected contract');
  assert.equal(exactOwnerContract({ ownerText: owner.replace(lastDependency.getText(ownerSource),
    `...${lastDependencyName}`) }), false,
  'factory dependency rest binding changed the injected contract');
  const factoryParameter = ownerFactory.parameters[0];
  assert.equal(exactOwnerContract({ ownerText: owner.replace(factoryParameter.getText(ownerSource),
    `${factoryParameter.name.getText(ownerSource)} = {}`) }), false,
  'factory parameter default changed the injected contract');
  const pendingOptionPattern = '{ pendingGeneration = false }';
  assert.equal(owner.includes(pendingOptionPattern), true);
  assert.equal(exactOwnerContract({ ownerText: owner.replace(pendingOptionPattern,
    '{ otherName: pendingGeneration = false }') }), false,
  'pending-generation property alias changed the option contract');
  const asCrlf = text => text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
  assert.equal(exactOwnerContract({ gatewayText: asCrlf(gateway), ownerText: asCrlf(owner) }), true,
    'CRLF source changed the normalized owner contract');
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(path.resolve(__dirname, '..'), '..', 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.test.split('test/gateway-handoff-scheduler-owner.test.js').length - 1, 1);
  for (const [methodName, access] of [
    ['scheduleDeferredHandoffRecovery', 'handoffSchedulerHandlers.scheduleDeferredHandoffRecovery'],
    ['schedulePendingHandoffRecoveryPoll', 'handoffSchedulerHandlers.schedulePendingHandoffRecoveryPoll']
  ]) {
    assert.equal(hasExactFacade(gateway, methodName), true);
    const needle = `${access}.apply(this, arguments)`;
    assert.equal(gateway.includes(needle), true);
    assert.equal(hasExactFacade(gateway.replace(needle,
      `handoffSchedulerHandlers?.${methodName}.apply(this, arguments)`), methodName), false,
    `${methodName}: optional-chain facade mutant accepted`);
    assert.equal(exactOwnerContract({ gatewayText: gateway.replace(needle, 'null') }), false,
      `${methodName}: altered supplied Gateway facade accepted`);
    assert.equal(hasExactFacade(gateway.replace(needle,
      `handoffSchedulerHandlers["${methodName}"].apply(this, arguments)`), methodName), false,
    `${methodName}: constant-bracket facade mutant accepted`);
    assert.equal(hasExactFacade(gateway.replace(needle,
      `(handoffSchedulerHandlers.${methodName}).apply(this, arguments)`), methodName), true,
    `${methodName}: transparent grouping refused`);
  }
  const inventoryMutant = gateway.replace(
    '  scheduleDeferredHandoffRecovery(channelId) {',
    '  privateHandoffSchedulerTick() { this.pendingHandoffRecoveryPollTimer = setTimeout(() => {}, 1); }\n\n  scheduleDeferredHandoffRecovery(channelId) {'
  );
  assert.notDeepEqual(classStateInventory(inventoryMutant), [], 'new class-local timer owner escaped inventory');
  const destructuredStateMembers = [
    ['deferred shorthand', 'privateDeferredStateReader() { const { deferredHandoffRecoveryChannels } = this; return deferredHandoffRecoveryChannels; }'],
    ['deferred alias', 'privateDeferredStateAliasReader() { const { deferredHandoffRecoveryChannels: channels } = this; return channels; }'],
    ['computed literal scheduler field', "privateComputedLiteralStateReader() { const { ['deferredHandoffRecoveryChannels']: channels } = this; return channels; }"],
    ['parenthesized this initializer', 'privateParenthesizedStateReader() { const { deferredHandoffRecoveryChannels } = (this); return deferredHandoffRecoveryChannels; }'],
    ['dynamic computed state binding', 'privateDynamicComputedStateReader(field) { const { [field]: channels } = this; return channels; }'],
    ['pending shorthand', 'privatePendingStateReader() { const { pendingHandoffRecoveryPollTimer } = this; return pendingHandoffRecoveryPollTimer; }'],
    ['direct state property', 'privateDirectStateReader() { return this.deferredHandoffRecoveryChannels; }']
  ];
  for (const [label, member] of destructuredStateMembers) {
    const memberName = member.slice(0, member.indexOf('('));
    const source = gateway.replace(
      '  scheduleDeferredHandoffRecovery(channelId) {',
      `  ${member}\n\n  scheduleDeferredHandoffRecovery(channelId) {`
    );
    assert.notEqual(source, gateway);
    assert.deepEqual(classStateInventory(source), [memberName], `${label}: new class member escaped state ownership inventory`);
  }
  for (const [label, member] of [
    ['deferred assignment alias', 'privateDeferredAssignmentStateAliasReader() { let channels; ({ deferredHandoffRecoveryChannels: channels } = this); return channels; }'],
    ['pending assignment alias', 'privatePendingAssignmentStateAliasReader() { let timer; ({ pendingHandoffRecoveryPollTimer: timer } = this); return timer; }'],
    ['computed literal scheduler assignment', "privateComputedLiteralAssignmentReader() { let channels; ({ ['deferredHandoffRecoveryChannels']: channels } = this); return channels; }"],
    ['dynamic computed assignment alias', 'privateDynamicComputedAssignmentReader(field) { let channels; ({ [field]: channels } = this); return channels; }'],
    ['parameter default alias', 'privateDeferredParameterStateAliasReader({ deferredHandoffRecoveryChannels: channels } = this) { return channels; }'],
    ['literal scheduler element key', "privateLiteralStateReader() { return this['deferredHandoffRecoveryChannels']; }"]
  ]) {
    const memberName = member.slice(0, member.indexOf('('));
    const source = gateway.replace(
      '  scheduleDeferredHandoffRecovery(channelId) {',
      `  ${member}\n\n  scheduleDeferredHandoffRecovery(channelId) {`
    );
    assert.notEqual(source, gateway);
    assert.deepEqual(classStateInventory(source), [memberName], `${label}: new class member escaped state ownership inventory`);
  }
  for (const [label, member] of [
    ['ordinary this field', 'privateOrdinaryStateReader() { const { gatewayName } = this; return gatewayName; }'],
    ['other-object scheduler field', 'privateOtherObjectStateReader(other) { const { deferredHandoffRecoveryChannels } = other; return deferredHandoffRecoveryChannels; }'],
    ['dynamic other-object scheduler field', 'privateOtherObjectDynamicStateReader(other, field) { const { [field]: channels } = other; return channels; }'],
    ['numeric computed binding key', 'privateNumericComputedStateReader() { const { [0]: first } = this; return first; }'],
    ['numeric computed assignment key', 'privateNumericComputedAssignmentReader() { let first; ({ [0]: first } = this); return first; }'],
    ['other-source parameter', 'privateOtherSourceParameterReader({ deferredHandoffRecoveryChannels: channels } = other) { return channels; }'],
    ['ordinary literal element key', "privateOrdinaryElementReader() { return this['client']; }"],
    ['timer property read', 'privateTimerPropertyReader(options) { return options.setTimeout; }'],
    ['shadowed timer parameter call', 'privateShadowedTimerCall(setTimeout) { setTimeout(() => {}, 1); }'],
    ['shadowed timer local call', 'privateShadowedTimerLocalCall() { const setTimeout = () => {}; setTimeout(() => {}, 1); }']
  ]) {
    const source = gateway.replace(
      '  scheduleDeferredHandoffRecovery(channelId) {',
      `  ${member}\n\n  scheduleDeferredHandoffRecovery(channelId) {`
    );
    assert.notEqual(source, gateway);
    assert.deepEqual(classStateInventory(source), [], `${label}: unrelated read was treated as Gateway scheduler state`);
  }
  const dynamicElementKey = gateway.replace(
    '  scheduleDeferredHandoffRecovery(channelId) {',
    '  privateDynamicElementReader(field) { return this[field]; }\n\n  scheduleDeferredHandoffRecovery(channelId) {'
  );
  assert.notEqual(dynamicElementKey, gateway);
  assert.deepEqual(classStateInventory(dynamicElementKey), ['privateDynamicElementReader'],
    'dynamic element access stopped conservatively protecting scheduler state');
  const constructorDestructure = gateway.replace(
    '    this.deferredHandoffRecoveryTimer = null;',
    '    const { deferredHandoffRecoveryTimer } = this;\n    let timer; ({ deferredHandoffRecoveryTimer: timer } = this);\n    this.deferredHandoffRecoveryTimer = null;'
  );
  assert.notEqual(constructorDestructure, gateway);
  assert.deepEqual(classStateInventory(constructorDestructure), ['constructor'],
    'constructor scheduler state reads were hidden by the initializer exception');
  for (const mutation of [
    'this.deferredHandoffRecoveryChannels.add(channelId);',
    'this.deferredHandoffRecoveryChannels.clear();'
  ]) {
    const constructorMutation = gateway.replace(
      '    this.deferredHandoffRecoveryTimer = null;',
      [
        '    this.deferredHandoffRecoveryTimer = null;',
        `    ${mutation}`
      ].join('\n')
    );
    assert.notEqual(constructorMutation, gateway);
    assert.ok(classStateInventory(constructorMutation).includes('constructor'),
      `constructor scheduler mutation escaped inventory: ${mutation}`);
  }
  const extraOwnerSite = gateway.replace(
    '  scheduleDeferredHandoffRecovery(channelId) {',
    '  privateHandoffSchedulerTick() { return handoffSchedulerHandlers.scheduleDeferredHandoffRecovery.apply(this, arguments); }\n\n  scheduleDeferredHandoffRecovery(channelId) {'
  );
  assert.notDeepEqual(classStateInventory(extraOwnerSite), [], 'new class-local owner call escaped inventory');
  for (const member of ["extraScheduler = (...args) => handoffSchedulerHandlers?.scheduleDeferredHandoffRecovery.apply(this, args);", "extraScheduler(options = handoffSchedulerHandlers.scheduleDeferredHandoffRecovery) {}", "get extraScheduler() { return handoffSchedulerHandlers.scheduleDeferredHandoffRecovery; }", "set extraScheduler(value) { handoffSchedulerHandlers.scheduleDeferredHandoffRecovery.call(this, value); }", "extraTimer = setTimeout(() => {}, 1);", "extraTimer(options = setTimeout(() => {}, 1)) {}", "extraTimer({ tick = setTimeout(() => {}, 1) } = {}) {}", "extraTimer({ nested: { tick = setTimeout(() => {}, 1) } = {} } = {}) {}", "extraState({ value = this.pendingHandoffRecoveryPollTimer } = {}) {}", "extraState({ nested: { value = this.pendingHandoffRecoveryPollTimer } = {} } = {}) {}"]) {
    const extra = gateway.replace('  scheduleDeferredHandoffRecovery(channelId) {', `  ${member}\n\n  scheduleDeferredHandoffRecovery(channelId) {`);
    assert.notEqual(extra, gateway);
    assert.notDeepEqual(classStateInventory(extra), []);
  }
  const constructorConsumer = gateway.replace('    this.deferredHandoffRecoveryTimer = null;', '    handoffSchedulerHandlers.scheduleDeferredHandoffRecovery.call(this);\n    this.deferredHandoffRecoveryTimer = null;');
  assert.notEqual(constructorConsumer, gateway);
  assert.notDeepEqual(classStateInventory(constructorConsumer), []);
  const sharedConfig = { ownerName: 'handoffSchedulerHandlers', factoryName: 'createHandoffSchedulerHandlers', facadeNames: Object.keys(METHOD_HASHES) };
  for (const name of sharedConfig.facadeNames) {
    const needle = `handoffSchedulerHandlers.${name}.apply(this, arguments)`;
    const grouped = gateway.replace(needle, `((handoffSchedulerHandlers).${name})['apply']((this), (arguments))`);
    assert.notEqual(grouped, gateway);
    assert.deepEqual(facadeOwnerInventory(ts, sourceFile(GATEWAY_PATH, grouped), sharedConfig), []);
    const conditional = gateway.replace(`return ${needle};`, `const dispatch = () => ${needle}; if (this?.extraCheckpoint) dispatch(); return dispatch();`);
    assert.notEqual(conditional, gateway);
    assert.notDeepEqual(facadeOwnerInventory(ts, sourceFile(GATEWAY_PATH, conditional), sharedConfig), []);
  }
  assert.deepEqual(classStateInventory(gateway), []);
  assert.equal(methodOf(sourceFile(GATEWAY_PATH, gateway), 'scheduleDeferredHandoffRecovery').parameters.length, 1);
  assert.equal(methodOf(sourceFile(GATEWAY_PATH, gateway), 'schedulePendingHandoffRecoveryPoll').parameters.length, 0);
});


test('Gateway scheduler ownership handles grouped receivers, qualified timers and dynamic this scopes', () => {
  const gateway = fs.readFileSync(GATEWAY_PATH, 'utf8');
  const withMember = member => {
    const source = gateway.replace(
      '  scheduleDeferredHandoffRecovery(channelId) {',
      `  ${member}\n\n  scheduleDeferredHandoffRecovery(channelId) {`
    );
    assert.notEqual(source, gateway);
    return source;
  };
  for (const [name, member] of [
    ['privateParenthesizedPropertyReader', 'privateParenthesizedPropertyReader() { return (this).deferredHandoffRecoveryChannels; }'],
    ['privateParenthesizedElementReader', "privateParenthesizedElementReader() { return (this)['pendingHandoffRecoveryPollTimer']; }"],
    ['privateArrowStateReader', 'privateArrowStateReader() { return (() => this.deferredHandoffRecoveryChannels)(); }']
  ]) {
    assert.deepEqual(classStateInventory(withMember(member)), [name], `${name}: scheduler owner escaped inventory`);
  }
  for (const [name, member] of [
    ['privateReceiverAliasPropertyReader', 'privateReceiverAliasPropertyReader() { const gateway = this; return gateway.deferredHandoffRecoveryChannels; }'],
    ['privateReceiverAliasElementReader', "privateReceiverAliasElementReader() { let gateway; gateway = this; return gateway['pendingHandoffRecoveryPollTimer']; }"],
    ['privateReceiverAliasDestructureReader', 'privateReceiverAliasDestructureReader() { const gateway = this; const { deferredHandoffRecoveryChannels: channels } = gateway; return channels; }'],
    ['privateReceiverAliasChainReader', 'privateReceiverAliasChainReader() { const gateway = this; const owner = gateway; return owner.deferredHandoffRecoveryChannels; }']
  ]) {
    assert.deepEqual(classStateInventory(withMember(member)), [name], `${name}: Gateway receiver alias escaped inventory`);
  }
  const conditionalReceiverAlias = withMember(
    'privateConditionalReceiverAlias(other, useOther) { let gateway = this; if (useOther) gateway = other; return gateway.deferredHandoffRecoveryChannels; }'
  );
  assert.deepEqual(classStateInventory(conditionalReceiverAlias), ['privateConditionalReceiverAlias'],
    'conditional receiver reassignment erased a possible Gateway alias');
  const uninvokedGatewayToOther = withMember(
    'privateUninvokedGatewayToOther(other) { let gateway = this; const reset = () => { gateway = other; }; return gateway.deferredHandoffRecoveryChannels; }'
  );
  assert.deepEqual(classStateInventory(uninvokedGatewayToOther), ['privateUninvokedGatewayToOther'],
    'uninvoked callback erased the enclosing Gateway alias');
  const uninvokedOtherToGateway = withMember(
    'privateUninvokedOtherToGateway(other) { let gateway = other; const reset = () => { gateway = this; }; return gateway.deferredHandoffRecoveryChannels; }'
  );
  assert.deepEqual(classStateInventory(uninvokedOtherToGateway), [],
    'uninvoked callback changed the enclosing non-Gateway alias');
  const callbackLocalWrite = withMember(
    'privateCallbackLocalWrite(other) { let gateway = this; const reset = () => { gateway = other; return gateway.deferredHandoffRecoveryChannels; }; return reset; }'
  );
  assert.deepEqual(classStateInventory(callbackLocalWrite), [],
    'callback-local reassignment leaked into its own receiver checks');
  const invokedIifeWrite = withMember(
    'privateInvokedIifeWrite(other) { let gateway = this; (() => { gateway = other; })(); return gateway.deferredHandoffRecoveryChannels; }'
  );
  assert.deepEqual(classStateInventory(invokedIifeWrite), [],
    'immediately invoked function write did not affect the enclosing alias');
  for (const [name, member] of [
    ['privateGlobalThisTimerOwner', 'privateGlobalThisTimerOwner() { globalThis.setTimeout(() => {}, 1); }'],
    ['privateGlobalTimerOwner', 'privateGlobalTimerOwner() { global.clearTimeout(1); }'],
    ['privateGlobalThisBracketTimerOwner', "privateGlobalThisBracketTimerOwner() { globalThis['setTimeout'](() => {}, 1); }"],
    ['privateGlobalBracketTimerOwner', "privateGlobalBracketTimerOwner() { global['clearTimeout'](1); }"]
  ]) {
    const inventory = classStateInventory(withMember(member));
    assert.ok(inventory.includes(`${name}: timer API`), `${name}: qualified global timer escaped inventory`);
  }
  for (const [name, member] of [
    ['privateRequiredTimerNamespace', "privateRequiredTimerNamespace() { const timers = require('node:timers'); timers.setTimeout(() => {}, 1); }"],
    ['privateRequiredTimerAlias', "privateRequiredTimerAlias() { const { setTimeout: schedule } = require('node:timers'); schedule(() => {}, 1); }"],
    ['privateRequiredLegacyTimerNamespace', "privateRequiredLegacyTimerNamespace() { const timers = require('timers'); timers.setTimeout(() => {}, 1); }"],
    ['privateRequiredLegacyTimerAlias', "privateRequiredLegacyTimerAlias() { const { setTimeout: schedule } = require('timers'); schedule(() => {}, 1); }"],
    ['privateImportedTimerNamespace', 'privateImportedTimerNamespace() { timers.setTimeout(() => {}, 1); }'],
    ['privateImportedTimerAlias', 'privateImportedTimerAlias() { schedule(() => {}, 1); }'],
    ['privateImportedLegacyTimerNamespace', 'privateImportedLegacyTimerNamespace() { timers.setTimeout(() => {}, 1); }'],
    ['privateImportedLegacyTimerAlias', 'privateImportedLegacyTimerAlias() { schedule(() => {}, 1); }']
  ]) {
    let prelude = '';
    if (name === 'privateImportedTimerNamespace') prelude = "import * as timers from 'node:timers';\n";
    if (name === 'privateImportedTimerAlias') prelude = "import { setTimeout as schedule } from 'node:timers';\n";
    if (name === 'privateImportedLegacyTimerNamespace') prelude = "import * as timers from 'timers';\n";
    if (name === 'privateImportedLegacyTimerAlias') prelude = "import { setTimeout as schedule } from 'timers';\n";
    const inventory = classStateInventory(`${prelude}${withMember(member)}`);
    assert.ok(inventory.includes(`${name}: timer API`), `${name}: imported Node timer escaped inventory`);
  }
  for (const [name, member] of [
    ['privateNestedFunctionThisReader', 'privateNestedFunctionThisReader() { function inspect() { return this.deferredHandoffRecoveryChannels; } return inspect.call({}); }'],
    ['privateNestedClassThisReader', 'privateNestedClassThisReader() { class Inspect { read() { return this.pendingHandoffRecoveryPollTimer; } } return Inspect; }'],
    ['privateReceiverAliasReassigned', 'privateReceiverAliasReassigned(other) { let gateway = this; gateway = other; return gateway.deferredHandoffRecoveryChannels; }'],
    ['privateReceiverAliasShadowed', 'privateReceiverAliasShadowed(other) { const gateway = this; { const gateway = other; return gateway.deferredHandoffRecoveryChannels; } }'],
    ['privateDynamicThisAliasReader', 'privateDynamicThisAliasReader() { function inspect() { const gateway = this; return gateway.deferredHandoffRecoveryChannels; } return inspect.call({}); }'],
    ['privateShadowedGlobalThisTimer', 'privateShadowedGlobalThisTimer(globalThis) { globalThis.setTimeout(() => {}, 1); }'],
    ['privateShadowedGlobalTimer', 'privateShadowedGlobalTimer(global) { global.clearTimeout(1); }'],
    ['privateShadowedBracketGlobalTimer', "privateShadowedBracketGlobalTimer(global) { global['clearTimeout'](1); }"],
    ['privateDynamicBracketTimerName', 'privateDynamicBracketTimerName(timerName) { globalThis[timerName](() => {}, 1); }']
  ]) {
    assert.deepEqual(classStateInventory(withMember(member)), [], `${name}: unrelated scope was treated as Gateway ownership`);
  }
  for (const [name, member] of [
    ["privateNodeTimersRequireReceiver", "privateNodeTimersRequireReceiver() { require('node:timers').setTimeout(() => {}, 1); }"],
    ["privateLegacyTimersRequireReceiver", "privateLegacyTimersRequireReceiver() { require('timers').setTimeout(() => {}, 1); }"],
    ["privateNodeTimersRequireCallReceiver", "privateNodeTimersRequireCallReceiver() { require('node:timers').setTimeout.call(globalThis, () => {}, 1); }"],
    ["privateLegacyTimersRequireApplyReceiver", "privateLegacyTimersRequireApplyReceiver() { require('timers').setTimeout.apply(globalThis, [() => {}, 1]); }"]
  ]) {
    const inventory = classStateInventory(withMember(member));
    assert.ok(inventory.includes(name + ': timer API'), name + ': direct/imported timer receiver escaped inventory');
  }
  const importedTimerCall = classStateInventory("import { setTimeout as schedule } from 'node:timers';\n" +
    withMember("privateImportedTimerCall() { schedule.call(globalThis, () => {}, 1); }"));
  assert.ok(importedTimerCall.includes('privateImportedTimerCall: timer API'),
    'imported timer .call receiver escaped inventory');
  for (const [name, member] of [
    ['shadowed require', "privateShadowedDirectTimersRequire(require) { require('node:timers').setTimeout(() => {}, 1); }"],
    ['ordinary direct require', "privateOrdinaryDirectTimersRequire() { require('ordinary-timers').setTimeout(() => {}, 1); }"],
    ['ordinary timer apply', "privateOrdinaryTimerApply() { const timers = require('ordinary-timers'); timers.setTimeout.apply(globalThis, [() => {}, 1]); }"]
  ]) {
    assert.deepEqual(classStateInventory(withMember(member)), [],
      name + ': shadowed or ordinary timer receiver was treated as a Node timer');
  }
  assert.deepEqual(classStateInventory(withMember("privateOrdinaryTimerNamespace() { const timers = require('ordinary-timers'); timers.setTimeout(() => {}, 1); }")), [],
    'same-named ordinary timer module was treated as node:timers');
  assert.deepEqual(classStateInventory(`import * as timers from 'node:timers';\n${withMember('privateShadowedImportedTimer(timers) { timers.setTimeout(() => {}, 1); }')}`), [],
    'shadowed namespace timer binding was treated as node:timers');
  assert.deepEqual(classStateInventory(`import { setTimeout as schedule } from 'node:timers';\n${withMember('privateShadowedImportedTimerAlias(schedule) { schedule(() => {}, 1); }')}`), [],
    'shadowed named timer binding was treated as node:timers');
});


test('public scheduler inventory pins source owners and rejects only new scheduler references', () => {
  assert.deepEqual(assertSchedulerCallsiteInventory(), EXPECTED_SCHEDULER_CALLSITES);
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-scheduler-inventory-'));
  const expected = [
    { file: 'assignment.js', owner: 'assignmentAliasSite', scheduler: 'scheduleDeferredHandoffRecovery' },
    { file: 'assignment.js', owner: 'assignmentComputedAliasSite', scheduler: 'scheduleDeferredHandoffRecovery' },
    { file: 'assignment.js', owner: 'assignmentGroupedComputedAliasSite', scheduler: 'scheduleDeferredHandoffRecovery' },
    { file: 'assignment.js', owner: 'assignmentShorthandSite', scheduler: 'scheduleDeferredHandoffRecovery' },
    { file: 'assignment.js', owner: 'assignmentStringAliasSite', scheduler: 'schedulePendingHandoffRecoveryPoll' },
    { file: 'bound.js', owner: 'boundSite', scheduler: 'scheduleDeferredHandoffRecovery' },
    { file: 'bracket.ts', owner: 'bracketSite', scheduler: 'schedulePendingHandoffRecoveryPoll' },
    { file: 'bracket.ts', owner: 'groupedBracketSite', scheduler: 'scheduleDeferredHandoffRecovery' },
    { file: 'capture.js', owner: 'captureSite', scheduler: 'scheduleDeferredHandoffRecovery' },
    { file: 'destructured.js', owner: 'destructuredSite', scheduler: 'scheduleDeferredHandoffRecovery' },
    { file: 'destructured.js', owner: 'shorthandSite', scheduler: 'scheduleDeferredHandoffRecovery' },
    { file: 'dot.js', owner: 'dotSite', scheduler: 'scheduleDeferredHandoffRecovery' },
    { file: 'forwarded.cjs', owner: 'forwardedSite', scheduler: 'schedulePendingHandoffRecoveryPoll' },
    { file: 'grouped.js', owner: 'groupedSite', scheduler: 'scheduleDeferredHandoffRecovery' },
    { file: 'optional.mjs', owner: 'optionalBracketSite', scheduler: 'schedulePendingHandoffRecoveryPoll' },
    { file: 'optional.mjs', owner: 'optionalSite', scheduler: 'scheduleDeferredHandoffRecovery' }
  ];

  try {
    fs.writeFileSync(path.join(sourceRoot, 'assignment.js'),
      'function assignmentAliasSite(gateway) { let schedule; ({ scheduleDeferredHandoffRecovery: schedule } = gateway); return schedule; }\n' +
      "function assignmentComputedAliasSite(gateway) { let schedule; ({ ['scheduleDeferredHandoffRecovery']: schedule } = gateway); return schedule; }\n" +
      "function assignmentGroupedComputedAliasSite(gateway) { let schedule; ({ [('scheduleDeferredHandoffRecovery')]: schedule } = gateway); return schedule; }\n" +
      'function assignmentShorthandSite(gateway) { let scheduleDeferredHandoffRecovery; ({ scheduleDeferredHandoffRecovery } = gateway); return scheduleDeferredHandoffRecovery; }\n' +
      'function assignmentStringAliasSite(gateway) { let schedule; ({ "schedulePendingHandoffRecoveryPoll": schedule } = gateway); return schedule; }\n' +
      'function ordinaryObjectSite(gateway) { return { scheduleDeferredHandoffRecovery: gateway }; }\n' +
      'function unrelatedAssignmentSite(gateway) { let value; ({ unrelated: value } = gateway); return value; }\n' +
      'function restAssignmentSite(gateway) { let scheduleDeferredHandoffRecovery; ({ ...scheduleDeferredHandoffRecovery } = gateway); return scheduleDeferredHandoffRecovery; }\n');
    fs.writeFileSync(path.join(sourceRoot, 'bound.js'),
      'function boundSite(gateway) { return gateway.scheduleDeferredHandoffRecovery.bind(gateway); }\n');
    fs.writeFileSync(path.join(sourceRoot, 'bracket.ts'),
      "function bracketSite(gateway: any) { gateway['schedulePendingHandoffRecoveryPoll'](); }\n" +
      "function groupedBracketSite(gateway: any) { gateway[('scheduleDeferredHandoffRecovery')](); }\n");
    fs.writeFileSync(path.join(sourceRoot, 'capture.js'),
      'function captureSite(gateway) { const schedule = gateway?.scheduleDeferredHandoffRecovery; return schedule; }\n');
    fs.writeFileSync(path.join(sourceRoot, 'destructured.js'),
      'function destructuredSite(gateway) { const { scheduleDeferredHandoffRecovery: schedule } = gateway; return schedule.bind(gateway); }\n' +
      'function shorthandSite(gateway) { const { scheduleDeferredHandoffRecovery } = gateway; return scheduleDeferredHandoffRecovery.bind(gateway); }\n' +
      'function restSite(gateway) { const { ...scheduleDeferredHandoffRecovery } = gateway; return scheduleDeferredHandoffRecovery; }\n');
    const loopHeaderExpected = [
      { file: 'loop-headers.js', owner: 'forInAliasSite', scheduler: 'scheduleDeferredHandoffRecovery' },
      { file: 'loop-headers.js', owner: 'forInLiteralKeySite', scheduler: 'schedulePendingHandoffRecoveryPoll' },
      { file: 'loop-headers.js', owner: 'forOfAliasSite', scheduler: 'scheduleDeferredHandoffRecovery' },
      { file: 'loop-headers.js', owner: 'forOfShorthandSite', scheduler: 'scheduleDeferredHandoffRecovery' },
      { file: 'loop-headers.js', owner: 'nestedForOfSite', scheduler: 'scheduleDeferredHandoffRecovery' },
      { file: 'loop-headers.js', owner: 'pendingPollForOfSite', scheduler: 'schedulePendingHandoffRecoveryPoll' }
    ];
    fs.writeFileSync(path.join(sourceRoot, 'loop-headers.js'),
      'function forOfAliasSite(gateways) { let schedule; for ({ scheduleDeferredHandoffRecovery: schedule } of gateways) schedule(); }\n' +
      'function forInAliasSite(gateways) { let schedule; for ({ scheduleDeferredHandoffRecovery: schedule } in gateways) schedule(); }\n' +
      'function forOfShorthandSite(gateways) { let scheduleDeferredHandoffRecovery; for ({ scheduleDeferredHandoffRecovery } of gateways) scheduleDeferredHandoffRecovery(); }\n' +
      "function forInLiteralKeySite(gateways) { let poll; for ({ ['schedulePendingHandoffRecoveryPoll']: poll } in gateways) poll(); }\n" +
      'function nestedForOfSite(gateways) { let schedule; for (const group of gateways) for ({ scheduleDeferredHandoffRecovery: schedule } of group) schedule(); }\n' +
      'function pendingPollForOfSite(gateways) { let poll; for ({ schedulePendingHandoffRecoveryPoll: poll } of gateways) poll(); }\n' +
      'function ordinaryObjectDataSite() { return { scheduleDeferredHandoffRecovery: () => {} }; }\n' +
      'function unrelatedLoopKeySite(gateways) { let value; for ({ unrelatedKey: value } of gateways) {} }\n');
    const expectedWithLoopHeaders = [...expected, ...loopHeaderExpected].sort((left, right) =>
      left.file < right.file ? -1 : left.file > right.file ? 1 : 0);
    fs.writeFileSync(path.join(sourceRoot, 'dot.js'),
      "function dotSite(gateway) { gateway.scheduleDeferredHandoffRecovery('dot'); }\n");
    fs.writeFileSync(path.join(sourceRoot, 'forwarded.cjs'),
      'function forwardedSite(gateway) { (gateway.schedulePendingHandoffRecoveryPoll).apply(gateway, []); }\n');
    fs.writeFileSync(path.join(sourceRoot, 'grouped.js'),
      "function groupedSite(gateway) { (gateway).scheduleDeferredHandoffRecovery('grouped'); }\n");
    fs.writeFileSync(path.join(sourceRoot, 'optional.mjs'),
      "function optionalBracketSite(gateway) { (gateway)?.['schedulePendingHandoffRecoveryPoll']?.(); }\n" +
      "function optionalSite(gateway) { gateway?.scheduleDeferredHandoffRecovery?.('optional'); }\n");
    assert.deepEqual(schedulerCallsiteInventory(sourceRoot), expectedWithLoopHeaders);
    assert.deepEqual(assertSchedulerCallsiteInventory(sourceRoot, expectedWithLoopHeaders), expectedWithLoopHeaders);

    const newConsumer = path.join(sourceRoot, 'audit-new-consumer.js');
    fs.writeFileSync(newConsumer,
      "exports.auditScheduler = gateway => gateway?.scheduleDeferredHandoffRecovery?.('audit-new-site');\n");
    assert.throws(() => assertSchedulerCallsiteInventory(sourceRoot, expectedWithLoopHeaders),
      error => error.code === 'ERR_ASSERTION' &&
        error.message.includes('public scheduler callsite inventory changed'));
    fs.rmSync(newConsumer);

    const newLoopConsumer = path.join(sourceRoot, 'audit-new-loop-consumer.js');
    fs.writeFileSync(newLoopConsumer,
      'exports.auditScheduler = gateways => { let schedule; for ({ scheduleDeferredHandoffRecovery: schedule } of gateways) schedule(); };\n');
    assert.throws(() => assertSchedulerCallsiteInventory(sourceRoot, expectedWithLoopHeaders),
      error => error.code === 'ERR_ASSERTION' &&
        error.message.includes('public scheduler callsite inventory changed'));
    fs.rmSync(newLoopConsumer);

    fs.writeFileSync(path.join(sourceRoot, 'audit-ordinary.js'), "exports.value = 'unrelated';\n");
    assert.doesNotThrow(() => assertSchedulerCallsiteInventory(sourceRoot, expectedWithLoopHeaders));
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});
test('the complete production scheduler reference inventory stays pinned', () => {
  assertSchedulerCallsiteInventory();
});

test('the public inventory catches a new optional-chain source owner and ignores an unrelated source file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-callsite-inventory-'));
  const sourceRoot = path.join(root, 'src');
  try {
    fs.mkdirSync(sourceRoot);
    fs.writeFileSync(path.join(sourceRoot, 'unrelated.js'),
      "exports.ordinary = gateway => gateway?.send?.('ordinary-site');\n");
    assert.doesNotThrow(() => assertSchedulerCallsiteInventory(sourceRoot, []));

    fs.writeFileSync(path.join(sourceRoot, 'audit-new-consumer.js'),
      "exports.auditScheduler = gateway => gateway?.scheduleDeferredHandoffRecovery?.('audit-new-site');\n");
    const expected = [{
      file: 'audit-new-consumer.js',
      owner: 'auditScheduler',
      scheduler: 'scheduleDeferredHandoffRecovery'
    }];
    assert.throws(() => assertSchedulerCallsiteInventory(sourceRoot, []), /public scheduler callsite inventory changed/);
    assert.deepEqual(assertSchedulerCallsiteInventory(sourceRoot, expected), expected);

    fs.writeFileSync(path.join(sourceRoot, 'wrappers.ts'), [
      'function wrapped(gateway: any) {',
      "  gateway[(('scheduleDeferredHandoffRecovery' as const))]?.('parentheses');",
      "  gateway[('scheduleDeferredHandoffRecovery' as string)]?.('as');",
      "  gateway[<string>'schedulePendingHandoffRecoveryPoll']?.('type assertion');",
      "  gateway[('schedulePendingHandoffRecoveryPoll'!)]?.('non-null');",
      "  gateway[('scheduleDeferredHandoffRecovery' satisfies string)]?.('satisfies');",
      '}'
    ].join('\n') + '\n');
    const wrappers = schedulerCallsiteInventory(sourceRoot).filter(site => site.file === 'wrappers.ts');
    assert.deepEqual(wrappers, [
      { file: 'wrappers.ts', owner: 'wrapped', scheduler: 'scheduleDeferredHandoffRecovery' },
      { file: 'wrappers.ts', owner: 'wrapped', scheduler: 'scheduleDeferredHandoffRecovery' },
      { file: 'wrappers.ts', owner: 'wrapped', scheduler: 'scheduleDeferredHandoffRecovery' },
      { file: 'wrappers.ts', owner: 'wrapped', scheduler: 'schedulePendingHandoffRecoveryPoll' },
      { file: 'wrappers.ts', owner: 'wrapped', scheduler: 'schedulePendingHandoffRecoveryPoll' }
    ]);

    fs.writeFileSync(path.join(sourceRoot, 'computed-import.ts'), [
      "function computed(gateway: any) { const method = 'scheduleDeferredHandoffRecovery'; gateway[method]?.(); }",
      "import { scheduleDeferredHandoffRecovery as schedule } from './scheduler-api.js';",
      "function imported() { schedule('channel'); }",
      "function shadowed(schedule: (channel: string) => void) { schedule('control'); }",
      "export { scheduleDeferredHandoffRecovery as forwarded } from './scheduler-api.js';"
    ].join('\n') + '\n');
    const computedAndImported = schedulerCallsiteInventory(sourceRoot)
      .filter(site => site.file === 'computed-import.ts');
    assert.deepEqual(computedAndImported.map(site => site.scheduler).sort(), [
      'scheduleDeferredHandoffRecovery',
      'scheduleDeferredHandoffRecovery',
      'scheduleDeferredHandoffRecovery'
    ]);
    assert.ok(computedAndImported.some(site => site.owner === 'computed'));
    assert.ok(computedAndImported.some(site => site.owner === 'imported'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the owner guard detects finite timer aliases, reflective writes, and invoked callback state', () => {
  const gateway = fs.readFileSync(GATEWAY_PATH, 'utf8');
  const inventoryFor = member => {
    const source = gateway.replace(
      '  scheduleDeferredHandoffRecovery(channelId) {',
      '  ' + member + '\n\n  scheduleDeferredHandoffRecovery(channelId) {'
    );
    assert.notEqual(source, gateway);
    return classStateInventory(source);
  };
  const timerMembers = [
    ['privateGlobalAliasTimerOwner', 'privateGlobalAliasTimerOwner() { const schedule = setTimeout; schedule(() => {}, 1); }'],
    ['privateGlobalThisAliasTimerOwner', 'privateGlobalThisAliasTimerOwner() { const schedule = globalThis.setTimeout; schedule(() => {}, 1); }'],
    ['privateBoundTimerOwner', 'privateBoundTimerOwner() { setTimeout.bind(globalThis)(() => {}, 1); }'],
    ['privateRequiredBoundTimerOwner', "privateRequiredBoundTimerOwner() { require('node:timers').setTimeout.bind(null)(() => {}, 1); }"],
    ['privateBracketCallTimerOwner', "privateBracketCallTimerOwner() { setTimeout['call'](globalThis, () => {}, 1); }"],
    ['privateBracketApplyTimerOwner', "privateBracketApplyTimerOwner() { require('node:timers').setTimeout['apply'](null, [() => {}, 1]); }"]
  ];
  for (const [name, member] of timerMembers) {
    assert.ok(inventoryFor(member).includes(name + ': timer API'), name + ': facade timer ownership escaped');
  }
  assert.deepEqual(inventoryFor('privateShadowedTimerAliasOwner(setTimeout) { const schedule = setTimeout; schedule(() => {}, 1); }'), []);
  assert.deepEqual(inventoryFor('privateUninvokedBoundTimerOwner() { setTimeout.bind(globalThis); }'), []);

  const timerForwarders = [
    ['privateBoundGlobalTimer', 'setTimeout.bind(globalThis)(() => {}, 1);'],
    ['privateBoundRequireTimer', "require('node:timers').setTimeout.bind(null)(() => {}, 1);"],
    ['privateBracketCallTimer', "setTimeout['call'](globalThis, () => {}, 1);"],
    ['privateBracketApplyRequireTimer', "require('node:timers').setTimeout['apply'](null, [() => {}, 1]);"],
    ['privateConstBoundAlias', 'const schedule = setTimeout.bind(globalThis); schedule(() => {}, 1);'],
    ["privateComputedForwarding", "const method = 'call'; setTimeout[method](globalThis, () => {}, 1);"],
    ['privateReflectApply', 'Reflect.apply(setTimeout, globalThis, [() => {}, 1]);'],
    ['privateCallCall', 'setTimeout.call.call(setTimeout, globalThis, () => {}, 1);'],
    ['privateLetAlias', 'let schedule = setTimeout; schedule(() => {}, 1);'],
    ['privateFiniteApply', 'const args = [() => {}, 1]; setTimeout.apply(globalThis, args);'],
    ['privateTemplateKeyCall', 'setTimeout[`call`](globalThis, () => {}, 1);'],
    ['privateBindThenCall', 'setTimeout.bind(globalThis).call(null, () => {}, 1);'],
    ['privateBracketCallCall', "setTimeout['call']['call'](setTimeout, globalThis, () => {}, 1);"],
    ['privateParenthesizedReflect', '(Reflect).apply(setTimeout, globalThis, [() => {}, 1]);']
  ];
  for (const [name, body] of timerForwarders) {
    assert.ok(inventoryFor(`${name}() { ${body} }`).includes(`${name}: timer API`),
      `${name}: finite timer forwarding escaped`);
  }
  assert.deepEqual(inventoryFor('privateShadowedReflectTimer(Reflect) { Reflect.apply(setTimeout, globalThis, [() => {}, 1]); }'), []);

  assert.deepEqual(inventoryFor('privateReflectiveSchedulerWrite() { Object.assign(this, { deferredHandoffRecoveryDelayMs: 1 }); }'),
    ['privateReflectiveSchedulerWrite']);
  assert.deepEqual(inventoryFor('privateOtherReflectiveWrite(other) { Object.assign(other, { deferredHandoffRecoveryDelayMs: 1 }); }'), []);
  const reflectiveWrites = [
    ['privateDefineProperty', "Object.defineProperty(this, 'deferredHandoffRecoveryDelayMs', { value: 1 });"],
    ['privateReflectSet', "Reflect.set(this, 'deferredHandoffRecoveryChannels', new Set());"],
    ['privateAssignVariableSource', 'const patch = { deferredHandoffRecoveryDelayMs: 1 }; Object.assign(this, patch);'],
    ['privateAssignSpread', 'Object.assign(this, { ...{ deferredHandoffRecoveryDelayMs: 1 } });'],
    ['privateAssignAlias', 'const gateway = this; Object.assign(gateway, { deferredHandoffRecoveryDelayMs: 1 });'],
    ['privateBracketAssign', "Object['assign'](this, { deferredHandoffRecoveryDelayMs: 1 });"],
    ['privateParenthesizedAssign', '((Object)).assign(this, { deferredHandoffRecoveryDelayMs: 1 });'],
    ['privateBracketReflectSet', "Reflect['set'](this, 'deferredHandoffRecoveryChannels', new Set());"],
    ['privateBracketDefineProperty', "Object['defineProperty'](this, 'deferredHandoffRecoveryDelayMs', { value: 1 });"],
    ['privateReflectDefineProperty', "Reflect.defineProperty(this, 'deferredHandoffRecoveryDelayMs', { value: 1 });"],
    ['privateDefineProperties', 'Object.defineProperties(this, { deferredHandoffRecoveryDelayMs: { value: 1 } });'],
    ['privateDefinePropertiesAlias', 'const descriptors = { deferredHandoffRecoveryDelayMs: { value: 1 } }; Object.defineProperties(this, descriptors);'],
    ['privateDefinePropertiesSpread', 'Object.defineProperties(this, { ...{ deferredHandoffRecoveryDelayMs: { value: 1 } } });']
  ];
  for (const [name, body] of reflectiveWrites) {
    assert.deepEqual(inventoryFor(`${name}() { ${body} }`), [name], `${name}: reflective write escaped`);
  }
  assert.deepEqual(inventoryFor("privateShadowedObject(Object) { Object.assign(this, { deferredHandoffRecoveryDelayMs: 1 }); }"), []);
  assert.deepEqual(inventoryFor("privateShadowedReflect(Reflect) { Reflect.set(this, 'deferredHandoffRecoveryDelayMs', 1); }"), []);
  assert.deepEqual(inventoryFor('privateOtherDefineProperties(other) { Object.defineProperties(other, { deferredHandoffRecoveryDelayMs: { value: 1 } }); }'), []);
  assert.deepEqual(inventoryFor('privateInvokedFiniteCallbackWrite(other) { let gateway = other; [0].forEach(() => { gateway = this; }); return gateway.deferredHandoffRecoveryChannels; }'),
    ['privateInvokedFiniteCallbackWrite']);
  const invokedCallbackWrites = [
    ['privateNamedResetCall', 'const reset = () => { gateway = this; }; reset();'],
    ['privateMapOtherToGateway', '[0].map(() => { gateway = this; });'],
    ['privateSomeOtherToGateway', '[0].some(() => { gateway = this; });'],
    ['privateVariableArrayForEach', 'const items = [0]; items.forEach(() => { gateway = this; });'],
    ['privateSetForEach', 'new Set([0]).forEach(() => { gateway = this; });']
  ];
  for (const [name, body] of invokedCallbackWrites) {
    assert.deepEqual(inventoryFor(`${name}(other) { let gateway = other; ${body} return gateway.deferredHandoffRecoveryChannels; }`),
      [name], `${name}: invoked callback write escaped`);
  }
  assert.deepEqual(inventoryFor('privateEmptyForEach(other) { let gateway = other; [].forEach(() => { gateway = this; }); return gateway.deferredHandoffRecoveryChannels; }'), []);
  assert.deepEqual(inventoryFor('privateShadowedSetForEach(Set, other) { let gateway = other; new Set([0]).forEach(() => { gateway = this; }); return gateway.deferredHandoffRecoveryChannels; }'), []);
  assert.deepEqual(inventoryFor('privateUninvokedOtherCallbackWrite(other) { let gateway = other; const reset = () => { gateway = this; }; return gateway.deferredHandoffRecoveryChannels; }'), []);
  assert.deepEqual(inventoryFor('privateClosureReadAfterWrite(other) { let gateway = other; const read = () => gateway.deferredHandoffRecoveryChannels; gateway = this; return read(); }'),
    ['privateClosureReadAfterWrite']);
});
