'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const ts = require('typescript');
const { facadeOwnerInventory } = require('./helpers/facade-owner-inventory.cjs');
const {
  GATEWAY_PATH, OWNER_PATH, METHOD_HASHES, DEPENDENCY_NAMES,
  sourceFile, methodOf, hasExactFacade, classStateInventory, exactOwnerContract, withFakeTimers,
  schedulerReceiver, ownerFromText, EXPECTED_SCHEDULER_CALLSITES,
  schedulerCallsiteInventory, assertSchedulerCallsiteInventory
} = require('./helpers/handoff-scheduler-owner.cjs');

test('handoff scheduler owner preserves exact bodies, dependencies, facade shape and inventory', () => {
  assert.equal(exactOwnerContract(), true);
  const gateway = fs.readFileSync(GATEWAY_PATH, 'utf8');
  const owner = fs.readFileSync(OWNER_PATH, 'utf8');
  const ownerSource = sourceFile(OWNER_PATH, owner);
  const ownerFactory = ownerSource.statements.find(statement => ts.isFunctionDeclaration(statement) &&
    statement.name?.text === 'createHandoffSchedulerHandlers');
  assert.ok(ownerFactory);
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
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
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
  assert.deepEqual(classStateInventory(constructorDestructure), [], 'constructor state initialization lost its owner exception');
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
    ['privateGlobalThisTimerOwner', 'privateGlobalThisTimerOwner() { globalThis.setTimeout(() => {}, 1); }'],
    ['privateGlobalTimerOwner', 'privateGlobalTimerOwner() { global.clearTimeout(1); }'],
    ['privateGlobalThisBracketTimerOwner', "privateGlobalThisBracketTimerOwner() { globalThis['setTimeout'](() => {}, 1); }"],
    ['privateGlobalBracketTimerOwner', "privateGlobalBracketTimerOwner() { global['clearTimeout'](1); }"]
  ]) {
    const inventory = classStateInventory(withMember(member));
    assert.ok(inventory.includes(`${name}: timer API`), `${name}: qualified global timer escaped inventory`);
  }
  for (const [name, member] of [
    ['privateNestedFunctionThisReader', 'privateNestedFunctionThisReader() { function inspect() { return this.deferredHandoffRecoveryChannels; } return inspect.call({}); }'],
    ['privateNestedClassThisReader', 'privateNestedClassThisReader() { class Inspect { read() { return this.pendingHandoffRecoveryPollTimer; } } return Inspect; }'],
    ['privateShadowedGlobalThisTimer', 'privateShadowedGlobalThisTimer(globalThis) { globalThis.setTimeout(() => {}, 1); }'],
    ['privateShadowedGlobalTimer', 'privateShadowedGlobalTimer(global) { global.clearTimeout(1); }'],
    ['privateShadowedBracketGlobalTimer', "privateShadowedBracketGlobalTimer(global) { global['clearTimeout'](1); }"],
    ['privateDynamicBracketTimerName', 'privateDynamicBracketTimerName(timerName) { globalThis[timerName](() => {}, 1); }']
  ]) {
    assert.deepEqual(classStateInventory(withMember(member)), [], `${name}: unrelated scope was treated as Gateway ownership`);
  }
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

test('public scheduler facades preserve receiver, extra arguments, synchronous return and thrown identity', () => {
  const sentinel = Object.freeze({ scheduler: 'return' });
  const rejection = new Error('scheduler throw sentinel');
  const calls = [];
  const results = { throws: false, value: sentinel };
  const handlers = Object.fromEntries(Object.keys(METHOD_HASHES).map(methodName => [methodName, function(...args) {
    calls.push({ methodName, receiver: this, args });
    if (results.throws) throw rejection;
    return results.value;
  }]));
  const savedOwner = require.cache[OWNER_PATH];
  const savedGateway = require.cache[GATEWAY_PATH];
  try {
    let factoryCalls = 0;
    let captured = null;
    require.cache[OWNER_PATH] = {
      id: OWNER_PATH, filename: OWNER_PATH, loaded: true,
      exports: { createHandoffSchedulerHandlers(dependencies) {
        factoryCalls += 1;
        captured = dependencies;
        return handlers;
      } }
    };
    delete require.cache[GATEWAY_PATH];
    const { DiscordGateway } = require(GATEWAY_PATH);
    assert.equal(factoryCalls, 1);
    assert.deepEqual(Object.keys(captured).sort(), DEPENDENCY_NAMES.slice().sort());
    assert.equal(captured.READINESS, require('../src/state').READINESS);
    assert.equal(captured.DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS, 100);
    assert.equal(captured.DEFERRED_HANDOFF_RECOVERY_MAX_DELAY_MS, 5000);
    assert.equal(captured.PENDING_HANDOFF_RECOVERY_POLL_MS, 100);
    for (const [methodName, arity] of [['scheduleDeferredHandoffRecovery', 1], ['schedulePendingHandoffRecoveryPoll', 0]]) {
      const method = DiscordGateway.prototype[methodName];
      assert.equal(method.length, arity);
      const receiver = Object.freeze({ marker: methodName });
      const argumentRows = [
        [Object.freeze({ first: methodName }), undefined, 42],
        [Object.freeze({ first: methodName }), Object.freeze({ second: methodName }), Object.freeze({ extra: methodName })]
      ];
      for (const args of argumentRows) {
      calls.length = 0;
      results.throws = false;
      const returned = method.apply(receiver, args);
      assert.equal(returned, sentinel);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].receiver, receiver);
      assert.equal(calls[0].methodName, methodName);
      assert.equal(calls[0].args.length, args.length);
      args.forEach((argument, index) => assert.equal(calls[0].args[index], argument));
      calls.length = 0;
      results.throws = true;
      assert.throws(() => method.apply(receiver, args), error => error === rejection);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].receiver, receiver);
      assert.equal(calls[0].methodName, methodName);
      assert.equal(calls[0].args.length, args.length);
      args.forEach((argument, index) => assert.equal(calls[0].args[index], argument));
      }
    }
  } finally {
    if (savedOwner) require.cache[OWNER_PATH] = savedOwner;
    else delete require.cache[OWNER_PATH];
    if (savedGateway) require.cache[GATEWAY_PATH] = savedGateway;
    else delete require.cache[GATEWAY_PATH];
  }
});

test('real strict owner keeps defaults in one place and reads option getters once', () => {
  const { createHandoffSchedulerHandlers } = require(OWNER_PATH);
  const handlers = createHandoffSchedulerHandlers({
    READINESS: { PENDING: 'pending', RECOVERING: 'recovering', READY: 'ready' },
    DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS: 100,
    DEFERRED_HANDOFF_RECOVERY_MAX_DELAY_MS: 500,
    PENDING_HANDOFF_RECOVERY_POLL_MS: 1000
  });
  for (const handler of Object.values(handlers)) {
    assert.throws(() => handler.call(undefined), TypeError);
    assert.throws(() => handler.call(null), TypeError);
  }
  withFakeTimers(timers => {
    const { DiscordGateway } = require(GATEWAY_PATH);
    const receiver = schedulerReceiver(DiscordGateway);
    let reads = 0;
    const options = Object.defineProperty({}, 'pendingGeneration', {
      enumerable: true,
      get() { reads += 1; return true; }
    });
    DiscordGateway.prototype.scheduleDeferredHandoffRecovery.call(receiver, 'getter-channel', options);
    assert.equal(reads, 1);
    assert.deepEqual([...receiver.deferredHandoffRecoveryChannels], []);
    assert.deepEqual([...receiver.pendingHandoffRecoveryChannels], ['getter-channel']);
    assert.equal(timers.length, 1);
  });
});

test('deferred scheduler replaces earlier timers, ignores stale callbacks and requeues separate sets through the facade', () => {
  withFakeTimers(timers => {
    const { DiscordGateway } = require(GATEWAY_PATH);
    const receiver = schedulerReceiver(DiscordGateway);
    const calls = [];
    const schedule = receiver.scheduleDeferredHandoffRecovery;
    receiver.scheduleDeferredHandoffRecovery = function(...args) {
      calls.push(args);
      return schedule.apply(this, args);
    };
    receiver.scheduleDeferredHandoffRecovery('ordinary-a');
    const stale = receiver.deferredHandoffRecoveryTimer;
    receiver.deferredHandoffRecoveryDelayMs = 1;
    receiver.scheduleDeferredHandoffRecovery('pending-b', { pendingGeneration: true });
    const current = receiver.deferredHandoffRecoveryTimer;
    assert.notEqual(current, stale);
    assert.equal(stale.cleared, true);
    stale.callback();
    assert.equal(receiver.deferredHandoffRecoveryTimer, current);
    assert.deepEqual([...receiver.deferredHandoffRecoveryChannels], ['ordinary-a']);
    assert.deepEqual([...receiver.pendingHandoffRecoveryChannels], ['pending-b']);
    receiver.transportReady = false;
    current.callback();
    assert.deepEqual(calls.map(args => args[0]), ['ordinary-a', 'pending-b', 'ordinary-a', 'pending-b']);
    assert.equal(calls[2][1].pendingGeneration, false);
    assert.deepEqual(calls[3][1], { pendingGeneration: true });
    assert.deepEqual([...receiver.deferredHandoffRecoveryChannels], ['ordinary-a']);
    assert.deepEqual([...receiver.pendingHandoffRecoveryChannels], ['pending-b']);
    assert.equal(timers.length, 3);
  });
});

test('busy recovery and pending poll re-enter through public scheduling methods', async () => {
  await withFakeTimers(async timers => {
    const { DiscordGateway } = require(GATEWAY_PATH);
    const receiver = schedulerReceiver(DiscordGateway);
    receiver.recoveryPromise = Promise.resolve();
    const deferredCalls = [];
    const scheduleDeferred = receiver.scheduleDeferredHandoffRecovery;
    receiver.scheduleDeferredHandoffRecovery = function(...args) {
      deferredCalls.push(args);
      return scheduleDeferred.apply(this, args);
    };
    receiver.scheduleDeferredHandoffRecovery('busy-ordinary');
    receiver.scheduleDeferredHandoffRecovery('busy-pending', { pendingGeneration: true });
    timers[0].callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(deferredCalls.slice(2).map(args => args[0]), [
      'busy-ordinary', 'busy-pending', 'busy-ordinary', 'busy-pending'
    ]);
    assert.equal(deferredCalls[3][1].pendingGeneration, true);
    assert.equal(deferredCalls[5][1].pendingGeneration, true);

    const pollReceiver = schedulerReceiver(DiscordGateway);
    pollReceiver.state.listPendingOrdinaryHandoffChannels = () => ['listed-pending'];
    pollReceiver.state.listBindings = () => [
      { active: true, readiness: 'pending', channelId: 'binding-pending' },
      { active: false, readiness: 'pending', channelId: 'inactive' }
    ];
    pollReceiver.state.isOrdinaryBinding = binding => binding.channelId === 'binding-pending';
    const polled = [];
    const pendingSchedule = pollReceiver.scheduleDeferredHandoffRecovery;
    pollReceiver.scheduleDeferredHandoffRecovery = function(...args) {
      polled.push(args);
      return pendingSchedule.apply(this, args);
    };
    const pollSchedule = pollReceiver.schedulePendingHandoffRecoveryPoll;
    let recursivePolls = 0;
    pollReceiver.schedulePendingHandoffRecoveryPoll = function(...args) {
      recursivePolls += 1;
      return pollSchedule.apply(this, args);
    };
    pollReceiver.schedulePendingHandoffRecoveryPoll();
    timers.at(-1).callback();
    assert.deepEqual(polled.map(args => args[0]), ['listed-pending', 'binding-pending']);
    assert.ok(polled.every(args => args[1].pendingGeneration === true));
    assert.equal(recursivePolls, 2);
    assert.ok(pollReceiver.pendingHandoffRecoveryPollTimer);
  });
});

test('recursive dispatch controls reject owner-local calls that bypass public overrides', async () => {
  const originalOwner = fs.readFileSync(OWNER_PATH, 'utf8');
  const deferredCall = 'this.scheduleDeferredHandoffRecovery(deferredChannelId, { pendingGeneration });';
  const pollCall = 'this.schedulePendingHandoffRecoveryPoll();';
  assert.equal(originalOwner.split(deferredCall).length - 1, 1);
  assert.equal(originalOwner.split(pollCall).length - 1, 1);
  for (const [kind, bypassOwner] of [
    ['deferred', originalOwner.replace(deferredCall, 'scheduleDeferredHandoffRecovery.call(this, deferredChannelId, { pendingGeneration });')],
    ['poll', originalOwner.replace(pollCall, 'schedulePendingHandoffRecoveryPoll.call(this);')]
  ]) {
  const { createHandoffSchedulerHandlers } = ownerFromText(bypassOwner);
  const handlers = createHandoffSchedulerHandlers({
    READINESS: { PENDING: 'pending', RECOVERING: 'recovering', READY: 'ready' },
    DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS: 100,
    DEFERRED_HANDOFF_RECOVERY_MAX_DELAY_MS: 500,
    PENDING_HANDOFF_RECOVERY_POLL_MS: 1000
  });
  const { DiscordGateway } = require(GATEWAY_PATH);
  await withFakeTimers(async timers => {
    const deferredReceiver = schedulerReceiver(DiscordGateway);
    deferredReceiver.transportReady = false;
    let deferredFacadeCalls = 0;
    deferredReceiver.scheduleDeferredHandoffRecovery = function(...args) {
      deferredFacadeCalls += 1;
      return handlers.scheduleDeferredHandoffRecovery.apply(this, args);
    };
    deferredReceiver.scheduleDeferredHandoffRecovery('ordinary');
    timers[0].callback();
    if (kind === 'deferred') {
      assert.equal(deferredFacadeCalls, 1);
      assert.throws(() => assert.ok(deferredFacadeCalls > 1), assert.AssertionError);
    } else assert.ok(deferredFacadeCalls > 1);

    const pollReceiver = schedulerReceiver(DiscordGateway);
    let pollFacadeCalls = 0;
    pollReceiver.schedulePendingHandoffRecoveryPoll = function(...args) {
      pollFacadeCalls += 1;
      return handlers.schedulePendingHandoffRecoveryPoll.apply(this, args);
    };
    pollReceiver.schedulePendingHandoffRecoveryPoll();
    timers.at(-1).callback();
    if (kind === 'poll') {
      assert.equal(pollFacadeCalls, 1);
      assert.throws(() => assert.ok(pollFacadeCalls > 1), assert.AssertionError);
    } else assert.ok(pollFacadeCalls > 1);
  });
  }
});

test('lifecycle stop cancels scheduler timers and clears both custody sets', async t => {
  const { fixture, DiscordGateway } = require('./ordinary-codex-fixture');
  const stateFixture = fixture(t);
  const gateway = new DiscordGateway({
    state: stateFixture.state,
    client: { user: { id: 'bot' }, on() {}, off() {}, async destroy() {} },
    providers: {},
    fetchHistory: async () => []
  });
  gateway.started = true;
  await withFakeTimers(async timers => {
    gateway.scheduleDeferredHandoffRecovery('ordinary-stop');
    gateway.scheduleDeferredHandoffRecovery('pending-stop', { pendingGeneration: true });
    gateway.schedulePendingHandoffRecoveryPoll();
    const deferredTimer = gateway.deferredHandoffRecoveryTimer;
    const pollTimer = gateway.pendingHandoffRecoveryPollTimer;
    assert.equal(timers.length, 2);
    await gateway.stop();
    assert.equal(deferredTimer.cleared, true);
    assert.equal(pollTimer.cleared, true);
    assert.equal(gateway.deferredHandoffRecoveryTimer, null);
    assert.equal(gateway.deferredHandoffRecoveryTimerDeadline, null);
    assert.equal(gateway.pendingHandoffRecoveryPollTimer, null);
    assert.deepEqual([...gateway.deferredHandoffRecoveryChannels], []);
    assert.deepEqual([...gateway.pendingHandoffRecoveryChannels], []);
  });
});

test('isolated forwarding counter-controls reject identity, result, throw and arity regressions', () => {
  const original = fs.readFileSync(GATEWAY_PATH, 'utf8');
  const forwarding = 'return handoffSchedulerHandlers.scheduleDeferredHandoffRecovery.apply(this, arguments);';
  const sentinel = Object.freeze({ result: 'sentinel' });
  const failure = new Error('identity');
  const receiver = Object.freeze({ receiver: true });
  const args = [Object.freeze({ first: true }), Object.freeze({ second: true }), Object.freeze({ extra: true })];
  let captured;
  let shouldThrow = false;
  const saved = require.cache[OWNER_PATH];
  function compile(text) {
    const loaded = new Module(`${GATEWAY_PATH}.control`, module);
    loaded.filename = GATEWAY_PATH;
    loaded.paths = Module._nodeModulePaths(path.dirname(GATEWAY_PATH));
    loaded._compile(text, GATEWAY_PATH);
    return loaded.exports.DiscordGateway.prototype.scheduleDeferredHandoffRecovery;
  }
  try {
    require.cache[OWNER_PATH] = { id: OWNER_PATH, filename: OWNER_PATH, loaded: true, exports: {
      createHandoffSchedulerHandlers() {
        return { scheduleDeferredHandoffRecovery(...values) {
          captured = { receiver: this, args: values };
          if (shouldThrow) throw failure;
          return sentinel;
        } };
      }
    } };
    function verify(text, axis) {
      const method = compile(text);
      shouldThrow = axis === 'throw';
      if (shouldThrow) {
        assert.throws(() => method.apply(receiver, args), error => error === failure);
        return;
      }
      const result = method.apply(receiver, args);
      if (axis === 'receiver') assert.equal(captured.receiver, receiver);
      if (axis.startsWith('arguments')) args.forEach((argument, index) => assert.equal(captured.args[index], argument));
      if (axis === 'return') assert.equal(result, sentinel);
      if (axis === 'arity') assert.equal(method.length, 1);
    }
    for (const [axis, replacement] of [
      ['receiver', 'return handoffSchedulerHandlers.scheduleDeferredHandoffRecovery.apply({ ...this }, arguments);'],
      ['arguments-first', 'return handoffSchedulerHandlers.scheduleDeferredHandoffRecovery.apply(this, [{ ...arguments[0] }, arguments[1], arguments[2]]);'],
      ['arguments-second', 'return handoffSchedulerHandlers.scheduleDeferredHandoffRecovery.apply(this, [arguments[0], { ...arguments[1] }, arguments[2]]);'],
      ['arguments-extra', 'return handoffSchedulerHandlers.scheduleDeferredHandoffRecovery.apply(this, [arguments[0], arguments[1], { ...arguments[2] }]);'],
      ['return', 'handoffSchedulerHandlers.scheduleDeferredHandoffRecovery.apply(this, arguments);'],
      ['throw', 'try { return handoffSchedulerHandlers.scheduleDeferredHandoffRecovery.apply(this, arguments); } catch (error) { throw new Error(error.message); }']
    ]) {
      verify(original, axis);
      const mutant = original.replace(forwarding, replacement);
      assert.notEqual(mutant, original);
      assert.throws(() => verify(mutant, axis), assert.AssertionError, axis);
    }
    verify(original, 'arity');
    const arityMutant = original.replace('scheduleDeferredHandoffRecovery(channelId)', 'scheduleDeferredHandoffRecovery(channelId, options)');
    assert.notEqual(arityMutant, original);
    assert.throws(() => verify(arityMutant, 'arity'), assert.AssertionError);
  } finally {
    if (saved) require.cache[OWNER_PATH] = saved;
    else delete require.cache[OWNER_PATH];
  }
  function verifyDefaults(text) {
    withFakeTimers(() => {
      const method = compile(text);
      let reads = 0;
      const options = Object.defineProperty({}, 'pendingGeneration', { get() { reads++; return false; } });
      method.call(schedulerReceiver(require(GATEWAY_PATH).DiscordGateway), 'channel', options);
      assert.equal(reads, 1);
    });
  }
  verifyDefaults(original);
  const doubleDefault = original.replace('scheduleDeferredHandoffRecovery(channelId)', 'scheduleDeferredHandoffRecovery(channelId, { pendingGeneration = false } = {})');
  assert.notEqual(doubleDefault, original);
  assert.throws(() => verifyDefaults(doubleDefault), assert.AssertionError);
  const ownerText = fs.readFileSync(OWNER_PATH, 'utf8');
  function verifyStrict(text) {
    const { createHandoffSchedulerHandlers } = ownerFromText(text);
    const handlers = createHandoffSchedulerHandlers({ READINESS: {}, DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS: 100, DEFERRED_HANDOFF_RECOVERY_MAX_DELAY_MS: 5000, PENDING_HANDOFF_RECOVERY_POLL_MS: 100 });
    assert.throws(() => handlers.scheduleDeferredHandoffRecovery.call(undefined), TypeError);
  }
  verifyStrict(ownerText);
  const nonStrict = ownerText.replace("'use strict';", '');
  assert.notEqual(nonStrict, ownerText);
  assert.throws(() => verifyStrict(nonStrict), assert.AssertionError);
});
