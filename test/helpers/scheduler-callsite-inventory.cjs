'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { unwrapTransparentExpression } = require('./handoff-scheduler-owner-expressions.cjs');

const SOURCE_ROOT = path.resolve(__dirname, '..', '..', 'src');
const SCHEDULER_METHODS = new Set([
  'scheduleDeferredHandoffRecovery',
  'schedulePendingHandoffRecoveryPoll'
]);

function schedulerAccessName(node) {
  const access = unwrapTransparentExpression(node);
  if (ts.isPropertyAccessExpression(access) && SCHEDULER_METHODS.has(access.name.text)) {
    return access.name.text;
  }
  if (ts.isElementAccessExpression(access) && access.argumentExpression) {
    const key = unwrapTransparentExpression(access.argumentExpression);
    if (ts.isStringLiteralLike(key) && SCHEDULER_METHODS.has(key.text)) return key.text;
  }
  return null;
}

function schedulerLiteralKeyName(key) {
  if (ts.isIdentifier(key) && SCHEDULER_METHODS.has(key.text)) return key.text;
  if (ts.isStringLiteralLike(key) && SCHEDULER_METHODS.has(key.text)) return key.text;
  if (ts.isComputedPropertyName(key)) {
    const expression = unwrapTransparentExpression(key.expression);
    if (ts.isStringLiteralLike(expression) && SCHEDULER_METHODS.has(expression.text)) {
      return expression.text;
    }
  }
  return null;
}

function schedulerBindingName(node) {
  if (!ts.isBindingElement(node) || node.dotDotDotToken || !ts.isObjectBindingPattern(node.parent)) return null;
  return schedulerLiteralKeyName(node.propertyName ?? node.name);
}

function isDestructuringAssignmentObject(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isParenthesizedExpression(parent)) {
      current = parent;
      continue;
    }
    if (ts.isPropertyAssignment(parent) && parent.initializer === current &&
      ts.isObjectLiteralExpression(parent.parent)) {
      current = parent.parent;
      continue;
    }
    if (ts.isArrayLiteralExpression(parent)) {
      current = parent;
      continue;
    }
    if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === current) return true;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      unwrapTransparentExpression(parent.left) === unwrapTransparentExpression(current)) return true;
    return false;
  }
  return false;
}

function schedulerAssignmentName(node) {
  if (ts.isPropertyAssignment(node)) return schedulerLiteralKeyName(node.name);
  if (ts.isShorthandPropertyAssignment(node)) return schedulerLiteralKeyName(node.name);
  return null;
}

function enclosingSchedulerOwner(node, source) {
  let current = node.parent;
  let fallback = null;
  function contains(root, target) {
    for (let currentNode = target; currentNode; currentNode = currentNode.parent) {
      if (currentNode === root) return true;
      if (ts.isSourceFile(currentNode)) break;
    }
    return false;
  }
  while (current && !ts.isSourceFile(current)) {
    if (ts.isMethodDeclaration(current) || ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) {
      const className = ts.isClassDeclaration(current.parent) || ts.isClassExpression(current.parent)
        ? current.parent.name?.text
        : null;
      const memberName = ts.isConstructorDeclaration(current) ? 'constructor' : current.name?.getText(source);
      return className ? `${className}.${memberName}` : memberName || '<anonymous method>';
    }
    if (ts.isPropertyDeclaration(current)) {
      const className = ts.isClassDeclaration(current.parent) || ts.isClassExpression(current.parent)
        ? current.parent.name?.text
        : null;
      const memberName = current.name?.getText(source);
      fallback ||= className ? `${className}.${memberName}` : memberName || '<anonymous property>';
    }
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      contains(current.right, node)) {
      const left = unwrapTransparentExpression(current.left);
      if (ts.isPropertyAccessExpression(left)) fallback ||= left.name.text;
    }
    if (ts.isVariableDeclaration(current)) fallback ||= current.name.getText(source);
    if (ts.isPropertyAssignment(current)) fallback ||= current.name.getText(source);
    if (ts.isSourceFile(current)) break;
    current = current.parent;
  }
  return fallback || '<module>';
}

function schedulerCallsiteInventory(sourceRoot = SOURCE_ROOT) {
  const extensions = new Set(['.js', '.ts', '.cjs', '.mjs']);
  const files = [];

  function collect(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(filePath);
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) files.push(filePath);
    }
  }

  collect(sourceRoot);
  const inventory = [];
  for (const filePath of files) {
    const text = fs.readFileSync(filePath, 'utf8');
    const scriptKind = path.extname(filePath).toLowerCase() === '.ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
    assert.deepEqual(source.parseDiagnostics, [], `${filePath}: parse diagnostics`);
    function visit(node) {
      const isObjectBindingElement = ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent);
      const isObjectAssignmentElement = (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        ts.isObjectLiteralExpression(node.parent) && isDestructuringAssignmentObject(node.parent);
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ||
        isObjectBindingElement || isObjectAssignmentElement) {
        let scheduler;
        if (isObjectBindingElement) scheduler = schedulerBindingName(node);
        else if (isObjectAssignmentElement) scheduler = schedulerAssignmentName(node);
        else scheduler = schedulerAccessName(node);
        if (scheduler) {
          inventory.push({
            file: path.relative(sourceRoot, filePath).split(path.sep).join('/'),
            owner: enclosingSchedulerOwner(node, source),
            scheduler
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  return inventory.sort((left, right) => {
    for (const key of ['file', 'owner', 'scheduler']) {
      if (left[key] < right[key]) return -1;
      if (left[key] > right[key]) return 1;
    }
    return 0;
  });
}

const EXPECTED_SCHEDULER_CALLSITES = [
  { file: 'discord.js', owner: 'DiscordGateway.constructor', scheduler: 'scheduleDeferredHandoffRecovery' },
  { file: 'discord.js', owner: 'DiscordGateway.constructor', scheduler: 'scheduleDeferredHandoffRecovery' },
  { file: 'discord.js', owner: 'DiscordGateway.recoverInbound', scheduler: 'scheduleDeferredHandoffRecovery' },
  { file: 'discord.js', owner: 'DiscordGateway.scheduleDeferredHandoffRecovery', scheduler: 'scheduleDeferredHandoffRecovery' },
  { file: 'discord.js', owner: 'DiscordGateway.schedulePendingHandoffRecoveryPoll', scheduler: 'schedulePendingHandoffRecoveryPoll' },
  { file: 'discord/handoff-scheduler.js', owner: 'scheduleDeferredHandoffRecovery', scheduler: 'scheduleDeferredHandoffRecovery' },
  { file: 'discord/handoff-scheduler.js', owner: 'schedulePendingHandoffRecoveryPoll', scheduler: 'scheduleDeferredHandoffRecovery' },
  { file: 'discord/handoff-scheduler.js', owner: 'schedulePendingHandoffRecoveryPoll', scheduler: 'schedulePendingHandoffRecoveryPoll' },
  { file: 'discord/lifecycle.js', owner: 'start', scheduler: 'schedulePendingHandoffRecoveryPoll' }
];

function assertSchedulerCallsiteInventory(sourceRoot = SOURCE_ROOT, expected = EXPECTED_SCHEDULER_CALLSITES) {
  const actual = schedulerCallsiteInventory(sourceRoot);
  assert.deepEqual(actual, expected, 'public scheduler callsite inventory changed');
  return actual;
}

module.exports = {
  EXPECTED_SCHEDULER_CALLSITES,
  schedulerCallsiteInventory,
  assertSchedulerCallsiteInventory
};
