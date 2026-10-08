'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const { facadeOwnerInventory } = require('./facade-owner-inventory.cjs');
const schedulerCallsiteContract = require('./scheduler-callsite-inventory.cjs');

const GATEWAY_PATH = path.resolve(__dirname, '..', '..', 'src', 'discord.js');
const OWNER_PATH = path.resolve(__dirname, '..', '..', 'src', 'discord', 'handoff-scheduler.js');
const FACTORY_NAME = 'createHandoffSchedulerHandlers';
const METHOD_HASHES = {
  scheduleDeferredHandoffRecovery: 'ddf5089189a81d44be6d278542534ef16a790301c0bd00e01e5c20bfe73c2411',
  schedulePendingHandoffRecoveryPoll: '3d048150591587ab7aac68c03884bc60cbd85923e034df71a38d48cad65305bd'
};
const DEPENDENCY_NAMES = [
  'READINESS',
  'DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS',
  'DEFERRED_HANDOFF_RECOVERY_MAX_DELAY_MS',
  'PENDING_HANDOFF_RECOVERY_POLL_MS'
];
const HANDOFF_STATE_FIELDS = new Set([
  'deferredHandoffRecoveryTimer',
  'deferredHandoffRecoveryTimerDeadline',
  'pendingHandoffRecoveryPollTimer',
  'deferredHandoffRecoveryChannels',
  'pendingHandoffRecoveryChannels',
  'deferredHandoffRecoveryDelayMs'
]);
function sourceFile(fileName, text) {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function readParsed(fileName) {
  const text = fs.readFileSync(fileName, 'utf8');
  const source = sourceFile(fileName, text);
  assert.deepEqual(source.parseDiagnostics, [], `${fileName}: parse diagnostics`);
  return { text, source };
}

function methodOf(source, methodName) {
  let found = null;
  function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === methodName &&
      ts.isClassDeclaration(node.parent) && node.parent.name?.text === 'DiscordGateway') {
      found = node;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function functionOf(source, functionName) {
  let found = null;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) found = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function isIdentifier(node, expected) {
  return ts.isIdentifier(node) && node.text === expected;
}

function hasExactFacade(sourceText, methodName) {
  const source = sourceFile(GATEWAY_PATH, sourceText);
  if (source.parseDiagnostics.length || !methodOf(source, methodName)) return false;
  return facadeOwnerInventory(ts, source, {
    ownerName: 'handoffSchedulerHandlers', factoryName: FACTORY_NAME,
    facadeNames: Object.keys(METHOD_HASHES)
  }).length === 0;
}

function classStateInventory(sourceText) {
  const source = sourceFile(GATEWAY_PATH, sourceText);
  if (source.parseDiagnostics.length) return ['source parse failed'];
  const violations = [];
  const timerOwners = [];

  function visit(node) {
    if (ts.isClassDeclaration(node) && node.name?.text === 'DiscordGateway') {
      for (const member of node.members) {

        const memberName = member.name?.getText(source) || 'unnamed class member';
        let accessesSchedulerState = false;
        function scan(bodyNode) {
          if (ts.isPropertyAccessExpression(bodyNode) && ts.isThis(bodyNode.expression) &&
            HANDOFF_STATE_FIELDS.has(bodyNode.name.text)) accessesSchedulerState = true;
          if (ts.isElementAccessExpression(bodyNode) && ts.isThis(bodyNode.expression)) accessesSchedulerState = true;
          if (ts.isVariableDeclaration(bodyNode) && ts.isObjectBindingPattern(bodyNode.name) &&
            ts.isThis(bodyNode.initializer) && bodyNode.name.elements.some(element => {
              const propertyName = element.propertyName;
              if (propertyName && ts.isComputedPropertyName(propertyName)) {
                const expression = propertyName.expression;
                return (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) &&
                  HANDOFF_STATE_FIELDS.has(expression.text);
              }
              const fieldName = propertyName || element.name;
              return (ts.isIdentifier(fieldName) || ts.isStringLiteral(fieldName)) &&
                HANDOFF_STATE_FIELDS.has(fieldName.text);
            })) accessesSchedulerState = true;
          if (ts.isIdentifier(bodyNode) && ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'].includes(bodyNode.text)) {
            timerOwners.push(memberName);
          }

          ts.forEachChild(bodyNode, scan);
        }
        if (member.body) scan(member.body);
        if (member.initializer) scan(member.initializer);
        for (const parameter of member.parameters || []) scan(parameter);
        if (accessesSchedulerState && !(ts.isConstructorDeclaration(member) ||
          ['scheduleDeferredHandoffRecovery', 'schedulePendingHandoffRecoveryPoll'].includes(memberName))) {
          violations.push(memberName);
        }
        if (timerOwners.includes(memberName)) violations.push(`${memberName}: timer API`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (timerOwners.length !== 0) violations.push(`unexpected timer owners: ${timerOwners.join(',')}`);
  violations.push(...facadeOwnerInventory(ts, source, { ownerName: 'handoffSchedulerHandlers', factoryName: FACTORY_NAME, facadeNames: Object.keys(METHOD_HASHES) }));
  return violations;
}

function exactOwnerContract(sourceOverrides = {}) {
  const gatewaySourceText = sourceOverrides.gatewayText ?? readParsed(GATEWAY_PATH).text;
  const ownerSourceText = sourceOverrides.ownerText ?? readParsed(OWNER_PATH).text;
  const gatewayText = gatewaySourceText.replace(/\r\n?/g, '\n');
  const ownerText = ownerSourceText.replace(/\r\n?/g, '\n');
  const gatewaySource = sourceFile(GATEWAY_PATH, gatewayText);
  const ownerSource = sourceFile(OWNER_PATH, ownerText);
  const gatewayMethods = Object.keys(METHOD_HASHES);
  const topLevel = ownerSource.statements;
  if (topLevel.length !== 3 || !ts.isExpressionStatement(topLevel[0]) ||
    !ts.isStringLiteral(topLevel[0].expression) || topLevel[0].expression.text !== 'use strict' ||
    !ts.isFunctionDeclaration(topLevel[1]) || topLevel[1].name?.text !== FACTORY_NAME ||
    !ts.isExpressionStatement(topLevel[2]) || !ts.isBinaryExpression(topLevel[2].expression) ||
    topLevel[2].expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const exportAssignment = topLevel[2].expression;
  if (!ts.isPropertyAccessExpression(exportAssignment.left) ||
    !isIdentifier(exportAssignment.left.expression, 'module') || exportAssignment.left.name.text !== 'exports' ||
    !ts.isObjectLiteralExpression(exportAssignment.right) || exportAssignment.right.properties.length !== 1 ||
    !ts.isShorthandPropertyAssignment(exportAssignment.right.properties[0]) ||
    exportAssignment.right.properties[0].name.text !== FACTORY_NAME) return false;
  const factory = functionOf(ownerSource, FACTORY_NAME);
  if (!factory?.body) return false;
  const statements = factory.body.statements;
  if (statements.length !== 3 || !ownerText.startsWith("'use strict';\n")) return false;
  const declarations = statements.filter(ts.isFunctionDeclaration);
  if (declarations.length !== 2 || declarations.some(declaration => !declaration.body)) return false;
  if (declarations.map(declaration => declaration.name?.text).sort().join(',') !== gatewayMethods.slice().sort().join(',')) return false;
  const factoryParameters = factory.parameters;
  if (factoryParameters.length !== 1 || !ts.isObjectBindingPattern(factoryParameters[0].name)) return false;
  const dependencies = factoryParameters[0].name.elements.map(element => element.name.getText(ownerSource)).sort();
  if (dependencies.join(',') !== DEPENDENCY_NAMES.slice().sort().join(',')) return false;
  const returned = statements[2];
  if (!ts.isReturnStatement(returned) || !returned.expression || !ts.isObjectLiteralExpression(returned.expression)) return false;
  const returnedNames = returned.expression.properties.map(property =>
    ts.isShorthandPropertyAssignment(property) ? property.name.text : null);
  if (returnedNames.includes(null) || returnedNames.sort().join(',') !== gatewayMethods.slice().sort().join(',')) return false;
  const deferred = declarations.find(declaration => declaration.name.text === 'scheduleDeferredHandoffRecovery');
  const poll = declarations.find(declaration => declaration.name.text === 'schedulePendingHandoffRecoveryPoll');
  if (poll.parameters.length !== 0 || deferred.parameters.length !== 2) return false;
  if (!isIdentifier(deferred.parameters[0].name, 'channelId') ||
    !ts.isObjectBindingPattern(deferred.parameters[1].name) ||
    deferred.parameters[1].name.elements.length !== 1 ||
    deferred.parameters[1].initializer?.kind !== ts.SyntaxKind.ObjectLiteralExpression ||
    deferred.parameters[1].initializer.properties.length !== 0) return false;
  const option = deferred.parameters[1].name.elements[0];
  if (!ts.isBindingElement(option) || !isIdentifier(option.name, 'pendingGeneration') ||
    option.initializer?.kind !== ts.SyntaxKind.FalseKeyword) return false;
  for (const methodName of gatewayMethods) {
    const declaration = declarations.find(candidate => candidate.name.text === methodName);
    if (declaration.modifiers?.length || declaration.asteriskToken) return false;
    const hash = crypto.createHash('sha256').update(declaration.body.getText(ownerSource)).digest('hex');
    if (hash !== METHOD_HASHES[methodName]) return false;
    if (!hasExactFacade(fs.readFileSync(GATEWAY_PATH, 'utf8'), methodName)) return false;
    if (!methodOf(gatewaySource, methodName)) return false;
  }
  return ownerText.startsWith("'use strict';\n");
}

function withFakeTimers(run) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = { callback: () => callback(...args), delay, cleared: false, unref() { return this; } };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = timer => { if (timer) timer.cleared = true; };
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  };
  try {
    const result = run(timers);
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function schedulerReceiver(DiscordGateway) {
  const receiver = Object.create(DiscordGateway.prototype);
  Object.assign(receiver, {
    stopping: false,
    started: true,
    transportReady: true,
    ready: false,
    lifecycleEpoch: 7,
    deferredHandoffRecoveryTimer: null,
    deferredHandoffRecoveryTimerDeadline: null,
    pendingHandoffRecoveryPollTimer: null,
    deferredHandoffRecoveryChannels: new Set(),
    pendingHandoffRecoveryChannels: new Set(),
    deferredHandoffRecoveryDelayMs: 20,
    recoveryPromise: null,
    state: {
      getBinding: () => null,
      recoverInterruptedOrdinaryHandoffIntake: () => null,
      listPendingOrdinaryHandoffChannels: () => [],
      listBindings: () => [],
      isOrdinaryBinding: () => false
    },
    recoverTransport: async () => ({ ready: false }),
    reconcilePending: async () => {},
    logger: () => {}
  });
  return receiver;
}

function ownerFromText(text) {
  const loaded = new Module(`${OWNER_PATH}.control`, module);
  loaded.filename = OWNER_PATH;
  loaded.paths = Module._nodeModulePaths(path.dirname(OWNER_PATH));
  loaded._compile(text, OWNER_PATH);
  return loaded.exports;
}


module.exports = {
  GATEWAY_PATH, OWNER_PATH, METHOD_HASHES, DEPENDENCY_NAMES,
  sourceFile, methodOf, hasExactFacade, classStateInventory, exactOwnerContract,
  withFakeTimers, schedulerReceiver, ownerFromText
};

Object.assign(module.exports, schedulerCallsiteContract);
