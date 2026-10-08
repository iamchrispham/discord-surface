'use strict';

const ts = require('typescript');

function isScope(node) {
  return Boolean(node) && (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) ||
    ts.isFunctionLike(node) || ts.isCatchClause(node) || ts.isForStatement(node) ||
    ts.isForInStatement(node) || ts.isForOfStatement(node));
}

function nearestScope(node) {
  let current = node.parent;
  while (current && !isScope(current)) current = current.parent;
  return current;
}

function nearestVarScope(node) {
  let current = node.parent;
  while (current && !ts.isSourceFile(current) && !ts.isFunctionLike(current)) {
    current = current.parent;
  }
  return current;
}

function collectBindings(sourceFile) {
  const bindings = [];
  const addPattern = (pattern, declaration, scope) => {
    if (ts.isIdentifier(pattern)) {
      bindings.push({ declaration, name: pattern.text, scope });
      return;
    }
    if (!ts.isObjectBindingPattern(pattern) && !ts.isArrayBindingPattern(pattern)) return;
    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element)) continue;
      addPattern(element.name, element, scope);
    }
  };
  const visit = node => {
    if (ts.isVariableDeclaration(node)) {
      const declarationList = node.parent;
      const scope = ts.isVariableDeclarationList(declarationList) &&
        !(declarationList.flags & ts.NodeFlags.BlockScoped)
        ? nearestVarScope(node)
        : nearestScope(node);
      addPattern(node.name, node, scope);
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      addPattern(node.name, node, nearestScope(node));
    } else if (ts.isFunctionExpression(node) && node.name) {
      addPattern(node.name, node, nearestScope(node));
    } else if (ts.isClassDeclaration(node) && node.name) {
      addPattern(node.name, node, nearestScope(node));
    } else if (ts.isParameter(node)) {
      addPattern(node.name, node, enclosingFunction(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

function enclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return null;
}

function isAncestor(ancestor, node) {
  let current = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function scopeDepth(node) {
  let depth = 0;
  let current = node;
  while (current) {
    depth += 1;
    current = current.parent;
  }
  return depth;
}

function resolveBinding(reference, bindings) {
  if (!ts.isIdentifier(reference)) return null;
  const candidates = bindings.filter(binding => binding.name === reference.text &&
    isAncestor(binding.scope, reference));
  candidates.sort((left, right) => scopeDepth(right.scope) - scopeDepth(left.scope));
  return candidates[0]?.declaration || null;
}

function isSemanticIdentifierReference(node) {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isBindingElement(parent) && (parent.propertyName === node || parent.name === node)) return false;
  if ((ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) ||
      ts.isImportClause(parent)) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) && parent.propertyName === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) || ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) && parent.name === node) return false;
  if ((ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) || ts.isModuleDeclaration(parent)) && parent.name === node) {
    return false;
  }
  return true;
}

function isTownHallPlanModule(sourceFile, specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith('.')) return false;
  const nodePath = require('node:path');
  const sourceRoot = nodePath.resolve(__dirname, '../../src');
  const sourceFilePath = nodePath.isAbsolute(sourceFile.fileName)
    ? sourceFile.fileName
    : nodePath.resolve(sourceRoot, sourceFile.fileName);
  const modulePath = nodePath.resolve(nodePath.dirname(sourceFilePath), specifier);
  const extension = nodePath.extname(modulePath);
  if (extension && !['.ts', '.cts', '.mts', '.js', '.cjs', '.mjs'].includes(extension)) {
    return false;
  }
  const sourceModule = extension ? modulePath.slice(0, -extension.length) : modulePath;
  return sourceModule === nodePath.resolve(sourceRoot, 'peer/town-hall-plan');
}

function countIdentifierReferences(sourceFile, name) {
  const bindings = collectBindings(sourceFile);
  const imports = [];
  const visitImports = node => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const specifier = ts.isStringLiteralLike(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : null;
      if (node.importClause.name) {
        imports.push({ declaration: node.importClause.name, name: node.importClause.name.text,
          scope: sourceFile, importedName: 'default', specifier });
      }
      const named = node.importClause.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          imports.push({ declaration: element.name, name: element.name.text, scope: sourceFile,
            importedName: element.propertyName?.text || element.name.text, specifier });
        }
      }
      if (named && ts.isNamespaceImport(named)) {
        imports.push({ declaration: named.name, name: named.name.text, scope: sourceFile,
          namespace: true, specifier });
      }
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const moduleExpression = node.moduleReference.expression;
      imports.push({ declaration: node.name, name: node.name.text, scope: sourceFile,
        namespace: true,
        specifier: ts.isStringLiteralLike(moduleExpression) ? moduleExpression.text : null });
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'require' &&
        node.initializer.arguments.length === 1 && ts.isStringLiteralLike(node.initializer.arguments[0])) {
      const specifier = node.initializer.arguments[0].text;
      if (ts.isIdentifier(node.name)) {
        const local = bindings.find(binding => binding.name === node.name.text &&
          binding.declaration === node);
        if (local) imports.push({ declaration: local.declaration, name: local.name,
          scope: local.scope, namespace: true, specifier });
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const local = bindings.find(binding => binding.name === element.name.text &&
            isAncestor(node, binding.declaration));
          if (local) imports.push({ declaration: local.declaration, name: local.name,
            scope: local.scope, importedName: element.propertyName?.text || element.name.text,
            specifier });
        }
      }
    }
    ts.forEachChild(node, visitImports);
  };
  visitImports(sourceFile);
  bindings.push(...imports);
  const candidates = bindings.filter(binding => binding.name === name && binding.scope === sourceFile);
  const importedNames = new Set(imports.map(binding => binding.name));
  const localCandidates = candidates.filter(binding => !importedNames.has(binding.name));
  const importedTarget = imports.find(binding => binding.importedName === name &&
    !binding.namespace && isTownHallPlanModule(sourceFile, binding.specifier));
  const target = localCandidates.find(binding => ts.isFunctionDeclaration(binding.declaration) &&
    binding.declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) ||
    localCandidates[0] || importedTarget || null;
  const namespaces = imports.filter(binding => binding.namespace &&
    isTownHallPlanModule(sourceFile, binding.specifier));
  let count = 0;
  const visit = node => {
    if (target && ts.isIdentifier(node) && node.text === target.name &&
        node !== target.declaration.name && isSemanticIdentifierReference(node) &&
        resolveBinding(node, bindings) === target.declaration) {
      count += 1;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const property = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : null;
      const receiver = node.expression;
      const directRequire = ts.isCallExpression(receiver) &&
        ts.isIdentifier(receiver.expression) && receiver.expression.text === 'require' &&
        receiver.arguments.length === 1 && ts.isStringLiteralLike(receiver.arguments[0]) &&
        isTownHallPlanModule(sourceFile, receiver.arguments[0].text) &&
        !resolveBinding(receiver.expression, bindings);
      const namespaceMember = ts.isIdentifier(receiver) &&
        namespaces.some(binding => resolveBinding(receiver, bindings) === binding.declaration);
      if (property === name && (namespaceMember || directRequire)) {
        count += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

module.exports = { countIdentifierReferences };
