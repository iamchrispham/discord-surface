'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const SOURCE_ROOT = path.resolve(__dirname, '..', '..', 'src');
const SCHEDULER_METHODS = new Set([
  'scheduleDeferredHandoffRecovery',
  'schedulePendingHandoffRecoveryPoll'
]);

function unwrapParentheses(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function schedulerAccessName(node) {
  const access = unwrapParentheses(node);
  if (ts.isPropertyAccessExpression(access) && SCHEDULER_METHODS.has(access.name.text)) {
    return access.name.text;
  }
  if (ts.isElementAccessExpression(access) && access.argumentExpression &&
    ts.isStringLiteralLike(access.argumentExpression) && SCHEDULER_METHODS.has(access.argumentExpression.text)) {
    return access.argumentExpression.text;
  }
  return null;
}

function enclosingSchedulerOwner(node, source) {
  let current = node.parent;
  let fallback = null;
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
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const scheduler = schedulerAccessName(node);
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
