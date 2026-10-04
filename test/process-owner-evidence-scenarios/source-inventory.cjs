'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const SRC_ROOT = path.join(__dirname, '..', '..', 'src');

const PRESERVED_PROBES = new Map([
  ['state/intake.js\u0000processAlive', 'independent EPERM-hold sibling probe, deferred from this class fix'],
  ['claude/socket-ownership/lock-owner.ts\u0000isSocketLockOwnerAlive', 'socket lock-owner liveness, distinct lock domain'],
  ['cli/gateway-process.js\u0000gatewayProcessStatus', 'gateway runtime supervision'],
  ['cli/gateway-process.js\u0000waitForExit', 'gateway runtime exit wait'],
  ['cli/runtime-lifecycle.js\u0000stop', 'runtime shutdown'],
  ['cli/runtime-custody.js\u0000acquireHeldLock', 'generated lock guardian, distinct existing supervision domain'],
  ['state.js\u0000probePid', 'injected probe dependency feeding the typed process-owner classifier']
]);

function sourceFiles(root) {
  const found = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|ts)$/.test(entry.name)) found.push(full);
    }
  };
  walk(root);
  return found;
}

function enclosingOwner(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText();
    if (ts.isPropertyAssignment(current) && current.name &&
      (ts.isFunctionExpression(current.initializer) || ts.isArrowFunction(current.initializer))) {
      return current.name.getText();
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer &&
      (ts.isFunctionExpression(current.initializer) || ts.isArrowFunction(current.initializer))) {
      return current.name.text;
    }
    if (ts.isClassDeclaration(current)) return null;
    current = current.parent;
  }
  return null;
}

function parseOwnerSites(fileName, text, generatedOwner = null) {
  const kind = fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const virtualPath = path.resolve(fileName);
  const options = { noLib: true, noResolve: true, allowJs: true };
  const sourceFile = ts.createSourceFile(virtualPath, text, ts.ScriptTarget.Latest, true, kind);
  const host = ts.createCompilerHost(options);
  host.getSourceFile = name => path.resolve(name) === virtualPath ? sourceFile : undefined;
  const program = ts.createProgram([virtualPath], options, host);
  const checker = program.getTypeChecker();
  const kills = [];
  const legacyCalls = [];

  function staticValue(node, seen = new Set()) {
    if (!node || seen.has(node)) return null;
    seen = new Set(seen).add(node);
    if (ts.isParenthesizedExpression(node)) return staticValue(node.expression, seen);
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = ts.isPropertyAccessExpression(node) ? node.name.text : staticValue(node.argumentExpression, seen);
      if (name === 'directPostOwnerAlive') return 'legacy-owner';
      if (name === 'kill' && staticValue(node.expression, seen) === 'process-object') return 'pid-probe';
      return null;
    }
    if (!ts.isIdentifier(node)) return null;
    const symbol = checker.getSymbolAtLocation(node);
    const declaration = symbol && symbol.valueDeclaration;
    if (!declaration) return node.text === 'process' ? 'process-object'
      : node.text === 'directPostOwnerAlive' ? 'legacy-owner' : null;
    if (ts.isVariableDeclaration(declaration) &&
        (declaration.parent.flags & ts.NodeFlags.Const)) {
      return staticValue(declaration.initializer, seen);
    }
    if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
      const variable = declaration.parent.parent;
      if (!ts.isVariableDeclaration(variable) || !(variable.parent.flags & ts.NodeFlags.Const)) return null;
      const name = declaration.propertyName ? declaration.propertyName.getText(sourceFile) : declaration.name.getText(sourceFile);
      if (name === 'directPostOwnerAlive') return 'legacy-owner';
      if (name === 'kill' && staticValue(variable.initializer, seen) === 'process-object') return 'pid-probe';
    }
    return null;
  }

  const visit = node => {
    if (ts.isCallExpression(node)) {
      const callee = staticValue(node.expression);
      const owner = generatedOwner || enclosingOwner(node);
      if (callee === 'pid-probe' && node.arguments.length >= 2 && staticValue(node.arguments[1]) === 0) {
        kills.push({ file: fileName, owner });
      }
      if (callee === 'legacy-owner') legacyCalls.push({ file: fileName, owner });
    }
    if (!generatedOwner && ts.isStringLiteral(node) && node.text.includes('process.kill')) {
      const nested = parseOwnerSites(fileName, node.text, enclosingOwner(node));
      kills.push(...nested.kills);
      legacyCalls.push(...nested.legacyCalls);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { kills, legacyCalls };
}

function inventoryProcessOwnerSites(root) {
  const kills = [];
  const legacyCalls = [];
  const violations = [];
  for (const full of sourceFiles(root)) {
    const relative = path.relative(root, full).split(path.sep).join('/');
    const parsed = parseOwnerSites(relative, fs.readFileSync(full, 'utf8'));
    for (const site of parsed.kills) {
      const key = `${site.file}\u0000${site.owner}`;
      kills.push(key);
      if (!PRESERVED_PROBES.has(key)) violations.push(`unclassified process probe ${site.file}:${site.owner}`);
    }
    for (const site of parsed.legacyCalls) {
      legacyCalls.push(`${site.file}\u0000${site.owner}`);
      violations.push(`legacy directPostOwnerAlive callsite ${site.file}:${site.owner}`);
    }
  }
  return { kills, legacyCalls, violations };
}

module.exports = {
  SRC_ROOT,
  PRESERVED_PROBES,
  sourceFiles,
  enclosingOwner,
  parseOwnerSites,
  inventoryProcessOwnerSites
};
