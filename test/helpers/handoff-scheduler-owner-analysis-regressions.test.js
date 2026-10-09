'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {
  GATEWAY_PATH,
  OWNER_PATH,
  classStateInventory,
  exactOwnerContract,
  sourceFile
} = require('./handoff-scheduler-owner.cjs');

const gateway = fs.readFileSync(GATEWAY_PATH, 'utf8');

function inventoryFor(member) {
  const marker = '  scheduleDeferredHandoffRecovery(channelId) {';
  const source = gateway.replace(marker, `  ${member}\n\n${marker}`);
  assert.notEqual(source, gateway, 'Gateway facade insertion point must exist');
  return classStateInventory(source);
}

function assertInventoryReports(name, member) {
  assert.ok(inventoryFor(member).includes(name), `${name}: scheduler ownership escaped inventory`);
}

function assertTimerReported(name, member) {
  assert.ok(inventoryFor(member).includes(`${name}: timer API`), `${name}: timer ownership escaped inventory`);
}

test('invoked callbacks and escaped closures update Gateway receiver analysis', () => {
  const positives = [
    ['privateNamedResetCall', 'privateNamedResetCall(other) { let gateway = other; const reset = () => { gateway = this; }; reset(); return gateway.deferredHandoffRecoveryChannels; }'],
    ['privateMapOtherToGateway', 'privateMapOtherToGateway(other) { let gateway = other; [0].map(() => { gateway = this; }); return gateway.deferredHandoffRecoveryChannels; }'],
    ['privateSomeOtherToGateway', 'privateSomeOtherToGateway(other) { let gateway = other; [0].some(() => { gateway = this; }); return gateway.deferredHandoffRecoveryChannels; }'],
    ['privateVariableArrayForEach', 'privateVariableArrayForEach(other) { let gateway = other; const items = [0]; items.forEach(() => { gateway = this; }); return gateway.deferredHandoffRecoveryChannels; }'],
    ['privateSetForEach', 'privateSetForEach(other) { let gateway = other; new Set([0]).forEach(() => { gateway = this; }); return gateway.deferredHandoffRecoveryChannels; }'],
    ['privateFunctionCallThis', 'privateFunctionCallThis(other) { let gateway = other; (function () { gateway = this; }).call(this); return gateway.deferredHandoffRecoveryChannels; }']
  ];
  for (const [name, member] of positives) assertInventoryReports(name, member);

  assert.deepEqual(inventoryFor('privateEmptyForEach(other) { let gateway = other; [].forEach(() => { gateway = this; }); return gateway.deferredHandoffRecoveryChannels; }'), []);
  assert.deepEqual(inventoryFor('privateUninvokedOtherCallbackWrite(other) { let gateway = other; const reset = () => { gateway = this; }; return gateway.deferredHandoffRecoveryChannels; }'), []);

  const closureReads = [
    ['privateReturnedClosure', 'privateReturnedClosure(other) { let gateway = other; const read = () => gateway.deferredHandoffRecoveryChannels; gateway = this; return read; }'],
    ['privateClosureCall', 'privateClosureCall(other) { let gateway = other; const read = () => gateway.deferredHandoffRecoveryChannels; gateway = this; return read.call(null); }'],
    ['privateClosureForEach', 'privateClosureForEach(other) { let gateway = other; const read = () => gateway.deferredHandoffRecoveryChannels; gateway = this; [0].forEach(read); }'],
    ['privateClosureAlias', 'privateClosureAlias(other) { let gateway = other; const read = () => gateway.deferredHandoffRecoveryChannels; gateway = this; const run = read; return run(); }'],
    ['privateClosureNested', 'privateClosureNested(other) { let gateway = other; const read = () => gateway.deferredHandoffRecoveryChannels; gateway = this; return (() => read())(); }']
  ];
  for (const [name, member] of closureReads) assertInventoryReports(name, member);
  assert.deepEqual(inventoryFor('privateClosureCalledBeforeWrite(other) { let gateway = other; const read = () => gateway.deferredHandoffRecoveryChannels; read(); gateway = this; }'), []);
});

test('timer inventory follows finite forwarding and rejects shadowed or uninvoked timers', () => {
  const positives = [
    ['privateBoundGlobalTimer', 'privateBoundGlobalTimer() { setTimeout.bind(globalThis)(() => {}, 1); }'],
    ['privateBoundRequireTimer', "privateBoundRequireTimer() { require('node:timers').setTimeout.bind(null)(() => {}, 1); }"],
    ['privateBracketCallTimer', "privateBracketCallTimer() { setTimeout['call'](globalThis, () => {}, 1); }"],
    ['privateBracketApplyRequireTimer', "privateBracketApplyRequireTimer() { require('node:timers').setTimeout['apply'](null, [() => {}, 1]); }"],
    ['privateConstBoundAlias', 'privateConstBoundAlias() { const schedule = setTimeout.bind(globalThis); schedule(() => {}, 1); }'],
    ['privateComputedForwarding', "privateComputedForwarding() { const method = 'call'; setTimeout[method](globalThis, () => {}, 1); }"],
    ['privateReflectApply', 'privateReflectApply() { Reflect.apply(setTimeout, globalThis, [() => {}, 1]); }'],
    ['privateCallCall', 'privateCallCall() { setTimeout.call.call(setTimeout, globalThis, () => {}, 1); }'],
    ['privateLetAlias', 'privateLetAlias() { let schedule = setTimeout; schedule(() => {}, 1); }'],
    ['privateFiniteApply', 'privateFiniteApply() { const args = [() => {}, 1]; setTimeout.apply(globalThis, args); }'],
    ['privateTemplateKeyCall', 'privateTemplateKeyCall() { setTimeout[`call`](globalThis, () => {}, 1); }'],
    ['privateBindThenCall', 'privateBindThenCall() { setTimeout.bind(globalThis).call(null, () => {}, 1); }']
  ];
  for (const [name, member] of positives) assertTimerReported(name, member);

  assert.deepEqual(inventoryFor('privateShadowedTimerAliasOwner(setTimeout) { const schedule = setTimeout; schedule(() => {}, 1); }'), []);
  assert.deepEqual(inventoryFor('privateUninvokedBoundTimer() { return setTimeout.bind(globalThis); }'), []);
});

test('reflective writes and aliased Object.assign sources stay in the Gateway inventory', () => {
  const positives = [
    ['privateDefineProperty', "privateDefineProperty() { Object.defineProperty(this, 'deferredHandoffRecoveryDelayMs', { value: 1 }); }"],
    ['privateReflectSet', "privateReflectSet() { Reflect.set(this, 'deferredHandoffRecoveryChannels', new Set()); }"],
    ['privateAssignVariableSource', 'privateAssignVariableSource() { const patch = { deferredHandoffRecoveryDelayMs: 1 }; Object.assign(this, patch); }'],
    ['privateAssignAliasedSource', 'privateAssignAliasedSource() { const update = { deferredHandoffRecoveryDelayMs: 1 }; Object.assign(this, update); }'],
    ['privateAssignSpread', 'privateAssignSpread() { Object.assign(this, { ...{ deferredHandoffRecoveryDelayMs: 1 } }); }'],
    ['privateAssignAlias', 'privateAssignAlias() { const gateway = this; Object.assign(gateway, { deferredHandoffRecoveryDelayMs: 1 }); }']
  ];
  for (const [name, member] of positives) assertInventoryReports(name, member);

  assert.deepEqual(inventoryFor('privateOtherReflectiveWrite(other) { Object.assign(other, { deferredHandoffRecoveryDelayMs: 1 }); }'), []);
  assert.deepEqual(inventoryFor("privateOtherDefineProperty(other) { Object.defineProperty(other, 'deferredHandoffRecoveryDelayMs', { value: 1 }); }"), []);
});

test('facade timer detection reports a timer inserted into an existing method', () => {
  const marker = '  scheduleDeferredHandoffRecovery(channelId) {';
  const changedGateway = gateway.replace(marker, `${marker}\n    setTimeout(() => {}, 1);`);
  assert.notEqual(changedGateway, gateway, 'existing Gateway facade must be present');
  const originalInventory = classStateInventory(gateway);
  const changedInventory = classStateInventory(changedGateway);
  assert.equal(originalInventory.includes('scheduleDeferredHandoffRecovery: timer API'), false);
  assert.equal(changedInventory.includes('scheduleDeferredHandoffRecovery: timer API'), true);
});

test('computed factory dependency keys exercise the owner contract parser', () => {
  const owner = fs.readFileSync(OWNER_PATH, 'utf8');
  const ownerAst = sourceFile(OWNER_PATH, owner);
  const factory = ownerAst.statements.find(statement => statement.name?.text === 'createHandoffSchedulerHandlers');
  assert.ok(factory);
  const dependency = factory.parameters[0].name.elements[0];
  const bindingName = dependency.name.getText(ownerAst);
  const computedDependency = `[(${JSON.stringify(bindingName)})]: ${bindingName}`;
  const changedOwner = owner.replace(dependency.getText(ownerAst), computedDependency);
  assert.notEqual(changedOwner, owner);
  assert.equal(exactOwnerContract({ ownerText: changedOwner }), true);
});

test('duplicate Gateway scheduler facade declarations invalidate the owner contract', () => {
  const ts = require('typescript');
  const gateway = fs.readFileSync(GATEWAY_PATH, 'utf8');
  const gatewayAst = sourceFile(GATEWAY_PATH, gateway);
  const methodName = 'scheduleDeferredHandoffRecovery';
  let method;
  function findFacade(node) {
    if (ts.isMethodDeclaration(node) && node.name?.text === methodName) method = node;
    if (!method) ts.forEachChild(node, findFacade);
  }
  findFacade(gatewayAst);
  assert.ok(method);
  const duplicate = method.getText(gatewayAst);
  const insertion = method.parent.members.end;
  const changedGateway = `${gateway.slice(0, insertion)}\n${duplicate}\n${gateway.slice(insertion)}`;
  assert.equal(exactOwnerContract({ gatewayText: changedGateway }), false);
});
