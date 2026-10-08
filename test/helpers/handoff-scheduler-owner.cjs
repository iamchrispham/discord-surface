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

  function unwrapParentheses(expression) {
    while (expression && ts.isParenthesizedExpression(expression)) expression = expression.expression;
    return expression;
  }

  function isSchedulerFieldName(name) {
    if (!name) return false;
    if (ts.isComputedPropertyName(name)) {
      const expression = unwrapParentheses(name.expression);
      return (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) &&
        HANDOFF_STATE_FIELDS.has(expression.text);
    }
    return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && HANDOFF_STATE_FIELDS.has(name.text);
  }

  function bindingPatternHasSchedulerField(pattern) {
    return ts.isObjectBindingPattern(pattern) && pattern.elements.some(element =>
      isSchedulerFieldName(element.propertyName || element.name));
  }

  function assignmentPatternHasSchedulerField(pattern) {
    return ts.isObjectLiteralExpression(pattern) && pattern.properties.some(property => {
      if (ts.isPropertyAssignment(property)) return isSchedulerFieldName(property.name);
      return ts.isShorthandPropertyAssignment(property) && HANDOFF_STATE_FIELDS.has(property.name.text);
    });
  }

  function isKnownNonSchedulerElementKey(expression) {
    return ts.isNumericLiteral(expression) || ts.isRegularExpressionLiteral(expression) || [
      ts.SyntaxKind.BigIntLiteral,
      ts.SyntaxKind.TrueKeyword,
      ts.SyntaxKind.FalseKeyword,
      ts.SyntaxKind.NullKeyword
    ].includes(expression.kind);
  }

  const timerApiNames = new Set(['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']);
  function bindingContainsName(bindingName, soughtName) {
    if (ts.isIdentifier(bindingName)) return bindingName.text === soughtName;
    if (ts.isObjectBindingPattern(bindingName) || ts.isArrayBindingPattern(bindingName)) {
      return bindingName.elements.some(element => ts.isBindingElement(element) &&
        bindingContainsName(element.name, soughtName));
    }
    return false;
  }

  function declarationListContainsName(declarations, soughtName, blockScopedOnly = false) {
    if (blockScopedOnly && (declarations.flags & ts.NodeFlags.BlockScoped) === 0) return false;
    return declarations.declarations.some(declaration => bindingContainsName(declaration.name, soughtName));
  }

  function statementsContainName(statements, soughtName, blockScopedOnly = false) {
    return statements.some(statement => {
      if (ts.isVariableStatement(statement)) {
        return declarationListContainsName(statement.declarationList, soughtName, blockScopedOnly);
      }
      if (blockScopedOnly && !ts.isFunctionDeclaration(statement) && !ts.isClassDeclaration(statement)) return false;
      return (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) &&
        statement.name && ts.isIdentifier(statement.name) && statement.name.text === soughtName;
    });
  }

  function functionHasVarBinding(functionNode, soughtName) {
    if (!functionNode.body) return false;
    let found = false;
    function scan(node) {
      if (node !== functionNode.body && (ts.isFunctionLike(node) ||
        ts.isClassDeclaration(node) || ts.isClassExpression(node))) return;
      if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.BlockScoped) === 0 && bindingContainsName(node.name, soughtName)) {
        found = true;
        return;
      }
      ts.forEachChild(node, scan);
    }
    scan(functionNode.body);
    return found;
  }

  function sourceFileContainsName(sourceNode, soughtName) {
    return sourceNode.statements.some(statement => {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (!clause) return false;
        if (clause.name?.text === soughtName) return true;
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) return bindings.name.text === soughtName;
        return Boolean(bindings && ts.isNamedImports(bindings) &&
          bindings.elements.some(element => element.name.text === soughtName));
      }
      if (ts.isImportEqualsDeclaration(statement)) return statement.name.text === soughtName;
      if (ts.isVariableStatement(statement)) {
        return declarationListContainsName(statement.declarationList, soughtName);
      }
      return (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) &&
        statement.name && ts.isIdentifier(statement.name) && statement.name.text === soughtName;
    });
  }

  function scopeDeclaresTimerName(scope, soughtName) {
    if (ts.isFunctionLike(scope)) {
      if (scope.parameters.some(parameter => bindingContainsName(parameter.name, soughtName)) ||
        (ts.isFunctionExpression(scope) && scope.name?.text === soughtName) ||
        functionHasVarBinding(scope, soughtName)) return true;
    }
    if (ts.isBlock(scope) && statementsContainName(scope.statements, soughtName, true)) return true;
    if (ts.isCaseBlock(scope) && scope.clauses.some(clause =>
      statementsContainName(clause.statements, soughtName, true))) return true;
    if (ts.isCatchClause(scope) && scope.variableDeclaration &&
      bindingContainsName(scope.variableDeclaration.name, soughtName)) return true;
    if ((ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
      scope.initializer && ts.isVariableDeclarationList(scope.initializer) &&
      declarationListContainsName(scope.initializer, soughtName)) return true;
    return ts.isSourceFile(scope) && sourceFileContainsName(scope, soughtName);
  }

  function isUnshadowedTimerCall(node) {
    if (!ts.isCallExpression(node)) return false;
    const callee = unwrapParentheses(node.expression);
    if (!ts.isIdentifier(callee) || !timerApiNames.has(callee.text)) return false;
    for (let scope = node.parent; scope; scope = scope.parent) {
      if (scopeDeclaresTimerName(scope, callee.text)) return false;
    }
    return true;
  }

  function visit(node) {
    if (ts.isClassDeclaration(node) && node.name?.text === 'DiscordGateway') {
      for (const member of node.members) {

        const memberName = member.name?.getText(source) || 'unnamed class member';
        let accessesSchedulerState = false;
        function scan(bodyNode) {
          if (ts.isPropertyAccessExpression(bodyNode) && ts.isThis(bodyNode.expression) &&
            HANDOFF_STATE_FIELDS.has(bodyNode.name.text)) accessesSchedulerState = true;
          if (ts.isElementAccessExpression(bodyNode) && ts.isThis(bodyNode.expression)) {
            const key = unwrapParentheses(bodyNode.argumentExpression);
            if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
              if (HANDOFF_STATE_FIELDS.has(key.text)) accessesSchedulerState = true;
            } else if (!isKnownNonSchedulerElementKey(key)) {
              accessesSchedulerState = true;
            }
          }
          if (ts.isVariableDeclaration(bodyNode) && bindingPatternHasSchedulerField(bodyNode.name) &&
            bodyNode.initializer && ts.isThis(unwrapParentheses(bodyNode.initializer))) accessesSchedulerState = true;
          if (ts.isBinaryExpression(bodyNode) && bodyNode.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isThis(unwrapParentheses(bodyNode.right)) &&
            assignmentPatternHasSchedulerField(unwrapParentheses(bodyNode.left))) accessesSchedulerState = true;
          if (isUnshadowedTimerCall(bodyNode) && !timerOwners.includes(memberName)) {
            timerOwners.push(memberName);
          }

          ts.forEachChild(bodyNode, scan);
        }
        if (member.body) scan(member.body);
        if (member.initializer) scan(member.initializer);
        for (const parameter of member.parameters || []) {
          if (parameter.initializer && ts.isThis(unwrapParentheses(parameter.initializer)) &&
            bindingPatternHasSchedulerField(parameter.name)) {
            accessesSchedulerState = true;
          }
          scan(parameter);
        }
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
  if (factoryParameters.length !== 1 || factoryParameters[0].initializer ||
    factoryParameters[0].dotDotDotToken || !ts.isObjectBindingPattern(factoryParameters[0].name)) return false;
  const dependencies = factoryParameters[0].name.elements.map(element => {
    if (!ts.isBindingElement(element) || element.dotDotDotToken || element.initializer ||
      !ts.isIdentifier(element.name)) return null;
    const localName = element.name.text;
    if (!element.propertyName) return localName;
    const propertyName = ts.isComputedPropertyName(element.propertyName)
      ? unwrapParentheses(element.propertyName.expression)
      : element.propertyName;
    const injectedName = ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName)
      ? propertyName.text
      : null;
    return injectedName === localName ? localName : null;
  });
  if (dependencies.some(dependency => dependency === null) ||
    dependencies.slice().sort().join(',') !== DEPENDENCY_NAMES.slice().sort().join(',')) return false;
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
