'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { unwrapTransparentExpression, bindingContainsName } = require('./handoff-scheduler-owner-expressions.cjs');

const SOURCE_ROOT = path.resolve(__dirname, '..', '..', 'src');
const SCHEDULER_METHODS = new Set([
  'scheduleDeferredHandoffRecovery',
  'schedulePendingHandoffRecoveryPoll'
]);

function constantSchedulerKey(expression, visited = new Set()) {
  expression = unwrapTransparentExpression(expression);
  if (!expression) return null;
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (!ts.isIdentifier(expression) || visited.has(expression.text)) return null;
  visited.add(expression.text);

  const name = expression.text;
  for (let scope = expression.parent; scope; scope = scope.parent) {
    if (ts.isCatchClause(scope) && scope.variableDeclaration && bindingContainsName(scope.variableDeclaration.name, name)) return null;
    if (ts.isFunctionLike(scope) && scope.parameters.some(parameter => bindingContainsName(parameter.name, name))) return null;
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;

    let declaration = null;
    for (const statement of scope.statements || []) {
      if (ts.isVariableStatement(statement)) {
        for (const candidate of statement.declarationList.declarations) {
          if (bindingContainsName(candidate.name, name)) declaration = candidate;
        }
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        statement.name?.text === name) {
        return null;
      } else if (ts.isImportDeclaration(statement) && statement.importClause) {
        const clause = statement.importClause;
        const bindings = clause.namedBindings;
        if (clause.name?.text === name || bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name ||
          bindings && ts.isNamedImports(bindings) && bindings.elements.some(element => element.name.text === name)) return null;
      }
    }
    if (declaration) {
      if (declaration.end >= expression.pos) return null;
      const declarationList = declaration.parent;
      if ((declarationList.flags & ts.NodeFlags.Const) === 0 || !declaration.initializer) return null;
      return constantSchedulerKey(declaration.initializer, visited);
    }
  }
  return null;
}

function schedulerAccessName(node) {
  const access = unwrapTransparentExpression(node);
  if (ts.isPropertyAccessExpression(access) && SCHEDULER_METHODS.has(access.name.text)) {
    return access.name.text;
  }
  if (ts.isElementAccessExpression(access) && access.argumentExpression) {
    const key = constantSchedulerKey(access.argumentExpression);
    if (key && SCHEDULER_METHODS.has(key)) return key;
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

function shadowsImportedScheduler(node, name) {
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (ts.isCatchClause(scope) && scope.variableDeclaration && bindingContainsName(scope.variableDeclaration.name, name)) return true;
    if (ts.isFunctionLike(scope) && scope.parameters.some(parameter => bindingContainsName(parameter.name, name))) return true;
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements || []) {
      if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration =>
        bindingContainsName(declaration.name, name))) return true;
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        statement.name?.text === name) return true;
    }
  }
  return false;
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
    const importedSchedulers = new Map();
    function collectSchedulerImports(node) {
      if (ts.isImportSpecifier(node)) {
        const imported = node.propertyName || node.name;
        if (SCHEDULER_METHODS.has(imported.text)) importedSchedulers.set(node.name.text, imported.text);
      }
      ts.forEachChild(node, collectSchedulerImports);
    }
    collectSchedulerImports(source);
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
      if (ts.isCallExpression(node)) {
        const callee = unwrapTransparentExpression(node.expression);
        if (ts.isIdentifier(callee) && importedSchedulers.has(callee.text) &&
          !shadowsImportedScheduler(callee, callee.text)) {
          inventory.push({
            file: path.relative(sourceRoot, filePath).split(path.sep).join('/'),
            owner: enclosingSchedulerOwner(callee, source),
            scheduler: importedSchedulers.get(callee.text)
          });
        }
      }
      if (ts.isExportSpecifier(node)) {
        const localName = (node.propertyName || node.name).text;
        const scheduler = importedSchedulers.get(localName) ||
          (SCHEDULER_METHODS.has(localName) ? localName : null);
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
