'use strict';

const ts = require('typescript');

function isScope(node) {
  return Boolean(node) && (ts.isSourceFile(node) || ts.isBlock(node) || ts.isCaseBlock(node) ||
    ts.isModuleBlock(node) ||
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
      addPattern(node.name, node, node);
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

function resolveConstantString(expression, bindings, seen = new Set()) {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (!ts.isIdentifier(expression)) return null;
  const binding = resolveBinding(expression, bindings);
  if (!binding || seen.has(binding) || !ts.isVariableDeclaration(binding) ||
      !ts.isVariableDeclarationList(binding.parent) ||
      !(binding.parent.flags & ts.NodeFlags.Const) || !binding.initializer) return null;
  seen.add(binding);
  return resolveConstantString(binding.initializer, bindings, seen);
}

function isTypePosition(node) {
  let current = node.parent;
  while (current) {
    if (ts.isTypeNode(current)) return true;
    current = current.parent;
  }
  return false;
}

function isSemanticIdentifierReference(node) {
  const parent = node.parent;
  if (!parent) return true;
  if (isTypePosition(node)) return false;
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) {
    return false;
  }
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

function sourcePath(sourceFile, sourceRoot, nodePath) {
  return nodePath.isAbsolute(sourceFile.fileName)
    ? sourceFile.fileName
    : nodePath.resolve(sourceRoot, sourceFile.fileName);
}

function resolveSourceFile(sourceFile, specifier, sourceFiles) {
  const nodePath = require('node:path');
  const sourceRoot = nodePath.resolve(__dirname, '../../src');
  const importerPath = sourcePath(sourceFile, sourceRoot, nodePath);
  const modulePath = nodePath.resolve(nodePath.dirname(importerPath), specifier);
  const extension = nodePath.extname(modulePath);
  const extensionlessPath = extension
    ? modulePath.slice(0, -extension.length)
    : modulePath;
  const sourceExtension = {
    '.js': '.ts',
    '.cjs': '.cts',
    '.mjs': '.mts',
  }[extension];
  const candidates = [modulePath];
  if (sourceExtension) candidates.push(extensionlessPath + sourceExtension);
  for (const candidateExtension of ['.ts', '.cts', '.mts', '.js', '.cjs', '.mjs']) {
    candidates.push(extensionlessPath + candidateExtension);
  }
  for (const candidateExtension of ['.ts', '.cts', '.mts', '.js', '.cjs', '.mjs']) {
    candidates.push(nodePath.join(extensionlessPath, `index${candidateExtension}`));
  }
  const sourcesByPath = new Map(sourceFiles.map(source => [
    sourcePath(source, sourceRoot, nodePath),
    source,
  ]));
  return candidates.map(candidate => sourcesByPath.get(candidate)).find(Boolean) || null;
}

function commonJsPropertyKey(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression &&
      ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return null;
}

function commonJsExportTarget(expression) {
  const property = commonJsPropertyKey(expression);
  if (property === null) return null;
  if (ts.isIdentifier(expression.expression) && expression.expression.text === 'exports') {
    return property;
  }
  const object = expression.expression;
  if ((ts.isPropertyAccessExpression(object) || ts.isElementAccessExpression(object)) &&
      ts.isIdentifier(object.expression) && object.expression.text === 'module' &&
      commonJsPropertyKey(object) === 'exports') {
    return property;
  }
  if (ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'module' && property === 'exports') {
    return 'default';
  }
  return null;
}

function commonJsExportIdentifier(expression) {
  let current = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current : null;
}

function commonJsRequireReexport(expression) {
  let requireCall = expression;
  let importedName = 'default';
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    importedName = commonJsPropertyKey(expression);
    requireCall = expression.expression;
    if (importedName === null) return null;
  }
  if (!ts.isCallExpression(requireCall) || !ts.isIdentifier(requireCall.expression) ||
      requireCall.expression.text !== 'require' || requireCall.arguments.length !== 1 ||
      !ts.isStringLiteralLike(requireCall.arguments[0])) {
    return null;
  }
  return {
    specifier: requireCall.arguments[0].text,
    importedName,
    requireIdentifier: requireCall.expression,
  };
}

function commonJsExportAssignment(node) {
  if (!ts.isBinaryExpression(node) ||
      node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
  const target = commonJsExportTarget(node.left);
  if (target === null) return null;
  return {
    target,
    exportIdentifier: commonJsExportIdentifier(node.left),
    right: node.right,
    reExport: commonJsRequireReexport(node.right),
  };
}

function commonJsObjectReexport(expression, exportedName) {
  if (!ts.isObjectLiteralExpression(expression)) return null;
  const property = expression.properties.find(candidate => {
    if (!ts.isPropertyAssignment(candidate)) return false;
    const key = candidate.name;
    return (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === exportedName;
  });
  return property ? commonJsRequireReexport(property.initializer) : null;
}

function localImportReexport(sourceFile, localName) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause ||
        statement.importClause.isTypeOnly || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue;
    }
    const clause = statement.importClause;
    if (clause.name?.text === localName) {
      return { specifier: statement.moduleSpecifier.text, importedName: 'default' };
    }
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === localName) {
      return { specifier: statement.moduleSpecifier.text, namespace: true };
    }
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const element = bindings.elements.find(candidate =>
      !candidate.isTypeOnly && candidate.name.text === localName);
    if (element) {
      return {
        specifier: statement.moduleSpecifier.text,
        importedName: element.propertyName?.text || element.name.text,
      };
    }
  }
  return null;
}

function reExportBindings(sourceFile, exportedName) {
  const bindings = collectBindings(sourceFile);
  for (const statement of sourceFile.statements) {
    if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly) {
      bindings.push({ declaration: statement, name: statement.name.text, scope: sourceFile });
    }
  }
  const reExports = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals && ts.isIdentifier(statement.expression)) {
        const declaration = resolveBinding(statement.expression, bindings);
        if (declaration && ts.isImportEqualsDeclaration(declaration) &&
            !declaration.isTypeOnly && ts.isExternalModuleReference(declaration.moduleReference)) {
          const moduleExpression = declaration.moduleReference.expression;
          if (ts.isStringLiteralLike(moduleExpression)) {
            reExports.push({ specifier: moduleExpression.text, namespace: true });
          }
        }
      }
      continue;
    }
    if (ts.isExpressionStatement(statement)) {
      const assignment = commonJsExportAssignment(statement.expression);
      if (assignment?.exportIdentifier &&
          !resolveBinding(assignment.exportIdentifier, bindings)) {
        let reExport = assignment.reExport;
        let importedName = assignment.target === 'default'
          ? exportedName
          : reExport?.importedName;
        if (!reExport && assignment.target === 'default') {
          reExport = commonJsObjectReexport(assignment.right, exportedName);
          importedName = reExport?.importedName;
        }
        if (reExport && !resolveBinding(reExport.requireIdentifier, bindings) &&
            ((assignment.target === 'default' &&
              (assignment.reExport?.importedName === 'default' ||
                !assignment.reExport)) || assignment.target === exportedName)) {
          reExports.push({ specifier: reExport.specifier, importedName });
        }
      }
      continue;
    }
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    if (!statement.moduleSpecifier) {
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
      const element = statement.exportClause.elements.find(candidate =>
        !candidate.isTypeOnly && candidate.name.text === exportedName);
      if (!element) continue;
      const localName = element.propertyName?.text || element.name.text;
      const localImport = localImportReexport(sourceFile, localName);
      if (localImport) reExports.push(localImport);
      continue;
    }
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    if (!statement.exportClause) {
      reExports.push({ specifier: statement.moduleSpecifier.text, importedName: exportedName });
      continue;
    }
    if (ts.isNamespaceExport(statement.exportClause)) {
      if (statement.exportClause.name.text === exportedName) {
        reExports.push({ specifier: statement.moduleSpecifier.text, namespace: true });
      }
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) continue;
    const element = statement.exportClause.elements.find(candidate =>
      !candidate.isTypeOnly && candidate.name.text === exportedName);
    if (element) {
      reExports.push({
        specifier: statement.moduleSpecifier.text,
        importedName: element.propertyName?.text || element.name.text,
      });
    }
  }
  return reExports;
}

function isTownHallNamespaceModule(sourceFile, specifier, exportedName, sourceFiles, seen = new Set()) {
  const barrel = resolveSourceFile(sourceFile, specifier, sourceFiles);
  if (!barrel) return false;
  const sourceRoot = require('node:path').resolve(__dirname, '../../src');
  const barrelPath = sourcePath(barrel, sourceRoot, require('node:path'));
  const marker = `${barrelPath}\u0000${exportedName}`;
  if (seen.has(marker)) return false;
  seen.add(marker);
  return reExportBindings(barrel, exportedName).some(reExport => {
    if (reExport.namespace) {
      return isTownHallPlanModule(barrel, reExport.specifier, 'isTownHallRoom', sourceFiles);
    }
    return isTownHallNamespaceModule(
      barrel,
      reExport.specifier,
      reExport.importedName,
      sourceFiles,
      seen,
    );
  });
}

function isTownHallPlanModule(sourceFile, specifier, exportedName, sourceFiles = [], seen = new Set()) {
  if (typeof specifier !== 'string' || !specifier.startsWith('.')) return false;
  const nodePath = require('node:path');
  const sourceRoot = nodePath.resolve(__dirname, '../../src');
  const sourceFilePath = sourcePath(sourceFile, sourceRoot, nodePath);
  const modulePath = nodePath.resolve(nodePath.dirname(sourceFilePath), specifier);
  const extension = nodePath.extname(modulePath);
  if (extension && !['.ts', '.cts', '.mts', '.js', '.cjs', '.mjs'].includes(extension)) {
    return false;
  }
  const sourceModule = extension ? modulePath.slice(0, -extension.length) : modulePath;
  const planSource = nodePath.resolve(sourceRoot, 'peer/town-hall-plan');
  const planFacade = nodePath.resolve(sourceRoot, '../dist/peer/town-hall-plan');
  if (sourceModule === planSource || sourceModule === planFacade) return true;
  if (!sourceFiles.length) return false;
  const barrel = resolveSourceFile(sourceFile, specifier, sourceFiles);
  if (!barrel) return false;
  const barrelPath = sourcePath(barrel, sourceRoot, nodePath);
  const marker = barrelPath + '\u0000' + exportedName;
  if (seen.has(marker)) return false;
  seen.add(marker);
  return reExportBindings(barrel, exportedName).some(reExport =>
    isTownHallPlanModule(
      barrel,
      reExport.specifier,
      reExport.importedName,
      sourceFiles,
      seen,
    ));
}

function isTownHallGuardExport(sourceFile, specifier, exportedName, sourceFiles, seen = new Set()) {
  if (exportedName === 'isTownHallRoom' &&
      isTownHallPlanModule(sourceFile, specifier, exportedName, sourceFiles)) return true;
  const barrel = resolveSourceFile(sourceFile, specifier, sourceFiles);
  if (!barrel) return false;
  const nodePath = require('node:path');
  const sourceRoot = nodePath.resolve(__dirname, '../../src');
  const barrelPath = sourcePath(barrel, sourceRoot, nodePath);
  const marker = barrelPath + '\u0000' + exportedName;
  if (seen.has(marker)) return false;
  seen.add(marker);
  return reExportBindings(barrel, exportedName).some(reExport =>
    !reExport.namespace && isTownHallGuardExport(
      barrel,
      reExport.specifier,
      reExport.importedName,
      sourceFiles,
      seen,
    ));
}

function countIdentifierReferences(sourceFile, name, sourceFiles = []) {
  const bindings = collectBindings(sourceFile);
  const imports = [];
  const visitImports = node => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const specifier = ts.isStringLiteralLike(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : null;
      if (!node.importClause.isTypeOnly && node.importClause.name) {
        imports.push({ declaration: node.importClause.name, name: node.importClause.name.text,
          scope: sourceFile, importedName: 'default', specifier });
      }
      const named = node.importClause.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (node.importClause.isTypeOnly || element.isTypeOnly) continue;
          imports.push({ declaration: element.name, name: element.name.text, scope: sourceFile,
            importedName: element.propertyName?.text || element.name.text, specifier });
        }
      }
      if (!node.importClause.isTypeOnly && named && ts.isNamespaceImport(named)) {
        imports.push({ declaration: named.name, name: named.name.text, scope: sourceFile,
          namespace: true, specifier });
      }
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference)) {
      const moduleExpression = node.moduleReference.expression;
      imports.push({ declaration: node.name, name: node.name.text, scope: sourceFile,
        namespace: true,
        specifier: ts.isStringLiteralLike(moduleExpression) ? moduleExpression.text : null });
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = ts.isAwaitExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      const isRequireCall = ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) && initializer.expression.text === 'require' &&
        !resolveBinding(initializer.expression, bindings);
      const isDynamicImport = ts.isCallExpression(initializer) &&
        initializer.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (!isRequireCall && !isDynamicImport) {
        ts.forEachChild(node, visitImports);
        return;
      }
      if (initializer.arguments.length !== 1 ||
          !ts.isStringLiteralLike(initializer.arguments[0])) {
        ts.forEachChild(node, visitImports);
        return;
      }
      const specifier = initializer.arguments[0].text;
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
      ts.forEachChild(node, visitImports);
      return;
    }
    ts.forEachChild(node, visitImports);
  };
  visitImports(sourceFile);
  bindings.push(...imports);
  const candidates = bindings.filter(binding => binding.name === name && binding.scope === sourceFile);
  const importedNames = new Set(imports.map(binding => binding.name));
  const localCandidates = candidates.filter(binding =>
    !importedNames.has(binding.name) && !ts.isBindingElement(binding.declaration));
  const importedTarget = imports.find(binding => !binding.namespace &&
    isTownHallGuardExport(sourceFile, binding.specifier, binding.importedName, sourceFiles));
  const target = localCandidates.find(binding => ts.isFunctionDeclaration(binding.declaration) &&
    binding.declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) ||
    localCandidates[0] || importedTarget || null;
  const namespaces = imports.filter(binding => binding.namespace
    ? isTownHallPlanModule(sourceFile, binding.specifier, name, sourceFiles)
    : binding.importedName !== name && isTownHallNamespaceModule(
      sourceFile,
      binding.specifier,
      binding.importedName,
      sourceFiles,
    ));
  const namespaceAliases = [];
  const collectNamespaceAliases = node => {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) &&
        node.initializer && ts.isIdentifier(node.initializer) &&
        namespaces.some(binding =>
          resolveBinding(node.initializer, bindings) === binding.declaration)) {
      for (const element of node.name.elements) {
        const property = element.propertyName || element.name;
        const propertyName = ts.isIdentifier(property) || ts.isStringLiteralLike(property)
          ? property.text
          : null;
        if (propertyName !== name || !ts.isIdentifier(element.name)) continue;
        const alias = bindings.find(binding => binding.declaration === element);
        if (alias) namespaceAliases.push(alias);
      }
    }
    ts.forEachChild(node, collectNamespaceAliases);
  };
  collectNamespaceAliases(sourceFile);
  let count = 0;
  const visit = node => {
    if (ts.isIdentifier(node) && isSemanticIdentifierReference(node)) {
      const targetReference = target && node.text === target.name &&
        node !== target.declaration.name &&
        resolveBinding(node, bindings) === target.declaration;
      const namespaceAliasReference = namespaceAliases.some(alias =>
        node !== alias.declaration.name && resolveBinding(node, bindings) === alias.declaration);
      if (targetReference || namespaceAliasReference) count += 1;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      let property = null;
      if (ts.isPropertyAccessExpression(node)) property = node.name.text;
      else if (node.argumentExpression) property = resolveConstantString(node.argumentExpression, bindings);
      const receiver = node.expression;
      let importedNamespace = receiver;
      while (ts.isParenthesizedExpression(importedNamespace) ||
          ts.isAwaitExpression(importedNamespace)) {
        importedNamespace = importedNamespace.expression;
      }
      const directRequire = ts.isCallExpression(receiver) &&
        ts.isIdentifier(receiver.expression) && receiver.expression.text === 'require' &&
        receiver.arguments.length === 1 && ts.isStringLiteralLike(receiver.arguments[0]) &&
        isTownHallPlanModule(sourceFile, receiver.arguments[0].text, property, sourceFiles) &&
        !resolveBinding(receiver.expression, bindings);
      const directImport = ts.isCallExpression(importedNamespace) &&
        importedNamespace.expression.kind === ts.SyntaxKind.ImportKeyword &&
        importedNamespace.arguments.length === 1 &&
        ts.isStringLiteralLike(importedNamespace.arguments[0]) &&
        isTownHallPlanModule(sourceFile, importedNamespace.arguments[0].text, property, sourceFiles);
      const namespaceMember = ts.isIdentifier(receiver) &&
        namespaces.some(binding => resolveBinding(receiver, bindings) === binding.declaration);
      if (property === name && (namespaceMember || directRequire || directImport)) {
        count += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

module.exports = { isScope, countIdentifierReferences, commonJsExportAssignment };
