'use strict';

const { unwrapParentheses } = require('./handoff-scheduler-owner-expressions.cjs');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { facadeOwnerInventory } = require('./facade-owner-inventory.cjs');

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
  if (!isIdentifier(deferred.parameters[0].name, 'channelId') || deferred.parameters[0].initializer ||
    deferred.parameters[0].dotDotDotToken ||
    !ts.isObjectBindingPattern(deferred.parameters[1].name) ||
    deferred.parameters[1].name.elements.length !== 1 ||
    deferred.parameters[1].initializer?.kind !== ts.SyntaxKind.ObjectLiteralExpression ||
    deferred.parameters[1].initializer.properties.length !== 0) return false;
  const option = deferred.parameters[1].name.elements[0];
  if (!ts.isBindingElement(option) || !isIdentifier(option.name, 'pendingGeneration') ||
    (option.propertyName && option.propertyName.text !== 'pendingGeneration') ||
    option.initializer?.kind !== ts.SyntaxKind.FalseKeyword) return false;
  for (const methodName of gatewayMethods) {
    const declaration = declarations.find(candidate => candidate.name.text === methodName);
    if (declaration.modifiers?.length || declaration.asteriskToken) return false;
    const hash = crypto.createHash('sha256').update(declaration.body.getText(ownerSource)).digest('hex');
    if (hash !== METHOD_HASHES[methodName]) return false;
    if (!hasExactFacade(gatewayText, methodName)) return false;
    if (!methodOf(gatewaySource, methodName)) return false;
  }
  return ownerText.startsWith("'use strict';\n");
}

module.exports = {
  GATEWAY_PATH, OWNER_PATH, FACTORY_NAME, METHOD_HASHES, DEPENDENCY_NAMES,
  sourceFile, methodOf, hasExactFacade, exactOwnerContract
};
