'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function createSourceFile(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    ts.getScriptKindFromFileName(file));
}

function isRoomField(node) {
  if (!node) return false;
  let object;
  let key;
  if (ts.isPropertyAccessExpression(node)) {
    object = node.expression;
    key = node.name.text;
  } else if (ts.isElementAccessExpression(node) && node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression)) {
    object = node.expression;
    key = node.argumentExpression.text;
  } else {
    return false;
  }
  return ['guildId', 'channelId'].includes(key) && ts.isIdentifier(object);
}

function isNamedRoomField(node) {
  if (!isRoomField(node)) return false;
  const object = node.expression;
  return /^(?:room|townHall|townHallRoom)$/i.test(object.text);
}

function regexInput(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name.text === 'test' && parent.expression === current &&
        ts.isCallExpression(parent.parent)) {
      return parent.parent.arguments[0] || null;
    }
    if (ts.isCallExpression(parent) && parent.arguments[0] === current &&
        ts.isPropertyAccessExpression(parent.expression) &&
        ['match', 'search'].includes(parent.expression.name.text)) {
      return parent.expression.expression;
    }
    if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) &&
        parent.expression.name.text === 'exec' && parent.expression === current) {
      return parent.arguments[0] || null;
    }
    current = parent;
  }
  return null;
}

function enclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return null;
}

function isLexicalScope(node) {
  return Boolean(node) && (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) ||
    ts.isFunctionLike(node) || ts.isCatchClause(node) || ts.isForStatement(node) ||
    ts.isForInStatement(node) || ts.isForOfStatement(node));
}

function nearestLexicalScope(node) {
  let current = node.parent;
  while (current && !isLexicalScope(current)) current = current.parent;
  return current;
}

function collectBindings(sourceFile) {
  const bindings = [];
  const visit = node => {
    let declaration = null;
    let name = null;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declaration = node;
      name = node.name.text;
    } else if (ts.isFunctionDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      declaration = node;
      name = node.name.text;
    } else if (ts.isFunctionExpression(node) && node.name && ts.isIdentifier(node.name)) {
      declaration = node;
      name = node.name.text;
    } else if (ts.isClassDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      declaration = node;
      name = node.name.text;
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      declaration = node;
      name = node.name.text;
    }
    if (declaration) bindings.push({ declaration, name, scope: nearestLexicalScope(declaration) });
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

function countIdentifierReferences(sourceFile, name) {
  let count = 0;
  const visit = node => {
    if (ts.isIdentifier(node) && node.text === name) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
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

function functionBinding(scope) {
  if (!scope) return null;
  const parent = scope.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === scope &&
      ts.isIdentifier(parent.name)) {
    return parent;
  }
  if (ts.isFunctionDeclaration(scope) && scope.name && ts.isIdentifier(scope.name)) return scope;
  if (scope.name && ts.isIdentifier(scope.name)) return scope;
  return null;
}

function bindingName(binding) {
  if ((ts.isVariableDeclaration(binding) || ts.isFunctionDeclaration(binding) ||
      ts.isFunctionExpression(binding) || ts.isClassDeclaration(binding)) &&
      binding.name && ts.isIdentifier(binding.name)) {
    return binding.name.text;
  }
  return null;
}

function hasBoundAlias(scope, subject, sourceFile, bindings, matches) {
  if (!ts.isIdentifier(subject)) return false;
  const subjectBinding = resolveBinding(subject, bindings);
  if (!subjectBinding) return false;
  if (ts.isVariableDeclaration(subjectBinding) && matches(subjectBinding.initializer)) return true;
  let found = false;
  const visit = node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) && node.left.text === subject.text &&
        resolveBinding(node.left, bindings) === subjectBinding && matches(node.right)) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope || sourceFile);
  return found;
}

function isRoomKeyLookup(node) {
  return Boolean(node && ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === 'ownDataProperty' && node.arguments.length === 2 &&
    ts.isStringLiteralLike(node.arguments[1]) && ['guildId', 'channelId'].includes(node.arguments[1].text));
}

function hasRoomFieldAlias(scope, subject, sourceFile, bindings) {
  return hasBoundAlias(scope, subject, sourceFile, bindings, isNamedRoomField);
}

function hasRoomKeyAlias(scope, subject, sourceFile, bindings) {
  return hasBoundAlias(scope, subject, sourceFile, bindings, isRoomKeyLookup);
}

function hasSplitRoomLengthBound(scope, subject, sourceFile) {
  const subjectText = subject.getText(sourceFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\W)${subjectText}\\s*\\.\\s*length\\s*(?:<=\\s*20|<\\s*21)(?:\\W|$)`).test(
    (scope || sourceFile).getText(sourceFile)
  );
}

function hasRoomFieldCall(scope, sourceFile, bindings, matches = isNamedRoomField) {
  const target = functionBinding(scope);
  const name = target ? bindingName(target) : null;
  if (!name) return false;
  let found = false;
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name &&
        node.arguments.length === 1 && matches(node.arguments[0]) &&
        resolveBinding(node.expression, bindings) === target) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function isTownHallName(name) {
  return typeof name === 'string' && /town.?hall/i.test(name);
}

function hasTownHallDeclarationContext(scope, sourceFile) {
  let current = scope;
  while (current) {
    const binding = ts.isFunctionLike(current) ? functionBinding(current) : null;
    if (binding && isTownHallName(bindingName(binding))) return true;
    if (current.name && ts.isIdentifier(current.name) && isTownHallName(current.name.text)) return true;
    current = current.parent;
  }
  const functionScope = enclosingFunction(scope) || (ts.isFunctionLike(scope) ? scope : null);
  return Boolean(functionScope?.parameters?.some(parameter => parameter.type &&
    isTownHallName(parameter.type.getText(sourceFile))));
}

function hasTownHallCallsite(scope, sourceFile, bindings) {
  const target = functionBinding(scope);
  if (!target) return false;
  let found = false;
  const visit = node => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        resolveBinding(node.expression, bindings) === target) {
      const caller = enclosingFunction(node);
      const callerBinding = caller && functionBinding(caller);
      if (callerBinding && isTownHallName(bindingName(callerBinding))) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function isTownHallContext(scope, sourceFile, bindings) {
  return hasTownHallDeclarationContext(scope, sourceFile) ||
    hasTownHallCallsite(scope, sourceFile, bindings);
}

function roomFieldSubject(node, sourceFile, bindings) {
  const subject = regexInput(node);
  if (!subject) return false;
  const scope = enclosingFunction(node) || sourceFile;
  const townHallContext = isTownHallContext(scope, sourceFile, bindings);
  return isNamedRoomField(subject) ||
    hasRoomFieldAlias(scope, subject, sourceFile, bindings) ||
    (townHallContext && (isRoomField(subject) ||
      hasBoundAlias(scope, subject, sourceFile, bindings, isRoomField) ||
      hasRoomKeyAlias(scope, subject, sourceFile, bindings) ||
      hasRoomFieldCall(scope, sourceFile, bindings, isRoomField))) ||
    hasRoomFieldCall(scope, sourceFile, bindings);
}

function isTownHallRoomOwner(node, sourceFile, bindings) {
  const scope = enclosingFunction(node);
  const owner = scope && functionBinding(scope);
  if (!owner || bindingName(owner) !== 'isTownHallRoom') return false;
  const subject = regexInput(node);
  return Boolean(subject && hasRoomKeyAlias(scope, subject, sourceFile, bindings));
}

function isSplitRoomDigitPolicy(node, sourceFile, pattern, bindings) {
  if (!/(?:\\[dD]|\[0-9\])(?:\+|\*|\{1,\})/.test(pattern)) return false;
  const subject = regexInput(node);
  if (!subject) return false;
  const scope = enclosingFunction(node) || sourceFile;
  return roomFieldSubject(node, sourceFile, bindings) && hasSplitRoomLengthBound(scope, subject, sourceFile);
}

function legacyRoomDigitPolicies(records) {
  const sites = {};
  for (const { file, text } of records) {
    const ast = createSourceFile(file, text);
    const bindings = collectBindings(ast);
    const numeric = /\\[dD]|\[(?:\^)?(?:0-9|0123456789)\]/;
    const visit = node => {
      let pattern = null;
      if (ts.isRegularExpressionLiteral(node)) pattern = node.text;
      else if ((ts.isNewExpression(node) || ts.isCallExpression(node)) &&
          ts.isIdentifier(node.expression) && node.expression.text === 'RegExp' &&
          node.arguments?.length && ts.isStringLiteralLike(node.arguments[0])) {
        pattern = node.arguments[0].text;
      }
      const roomPolicy = pattern !== null && numeric.test(pattern) &&
        (isTownHallRoomOwner(node, ast, bindings) || roomFieldSubject(node, ast, bindings) ||
          isSplitRoomDigitPolicy(node, ast, pattern, bindings));
      if (roomPolicy) {
        sites[file] = (sites[file] || 0) + 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return sites;
}

function unwrapPolicyExpression(node) {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current))) {
    current = current.expression;
  }
  return current;
}

function policyPropertyKey(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return null;
}

function roomDigitPolicies(records) {
  const infos = records.map(({ file, text }) => ({
    file,
    ast: createSourceFile(file, text),
    bindings: [],
    functions: new Map(),
    functionDefs: [],
    objectMethods: new Map(),
    imports: new Map(),
    exports: new Map(),
  }));
  const byFile = new Map(infos.map(info => [info.file, info]));

  const addPatternBindings = (pattern, source, info, extra) => {
    if (ts.isIdentifier(pattern)) {
      info.bindings.push({ name: pattern.text, kind: 'value', source, ...extra });
      return;
    }
    if (ts.isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        if (!ts.isBindingElement(element)) continue;
        const keyNode = element.propertyName || element.name;
        if (ts.isIdentifier(element.name) && (ts.isIdentifier(keyNode) || ts.isStringLiteralLike(keyNode))) {
          info.bindings.push({
            name: element.name.text,
            kind: extra.kind === 'parameter' ? 'parameter-field' : 'field',
            key: keyNode.text,
            source,
            ...extra,
          });
        } else {
          addPatternBindings(element.name, source, info, extra);
        }
      }
    }
  };

  for (const info of infos) {
    const visit = node => {
      if (ts.isVariableDeclaration(node)) {
        const scope = nearestLexicalScope(node);
        addPatternBindings(node.name, node.initializer || null, info, {
          declaration: node,
          scope,
        });
        if (ts.isIdentifier(node.name) && node.initializer &&
            (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer))) {
          const fn = {
            info,
            node: node.initializer,
            name: node.name.text,
            calls: [],
          };
          info.functions.set(node.name.text, fn);
          info.functionDefs.push(fn);
        }
      } else if (ts.isFunctionDeclaration(node)) {
        const name = node.name?.text ||
          (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : null);
        if (name) {
          const fn = {
            info,
            node,
            name,
            calls: [],
          };
          info.functions.set(name, fn);
          info.functionDefs.push(fn);
        }
      } else if ((ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) && node.name &&
          (ts.isObjectLiteralExpression(node.parent) || ts.isClassDeclaration(node.parent))) {
        const owner = node.parent.parent;
        const property = node.name.text;
        let key = null;
        let ownerDeclaration = null;
        if (ts.isObjectLiteralExpression(node.parent) && ts.isVariableDeclaration(owner) &&
            ts.isIdentifier(owner.name) &&
            (ts.isMethodDeclaration(node) || ts.isFunctionExpression(node.initializer) ||
              ts.isArrowFunction(node.initializer))) {
          key = `${owner.name.text}.${property}`;
          ownerDeclaration = owner;
        } else if (ts.isClassDeclaration(node.parent) && node.parent.name &&
            ts.isMethodDeclaration(node) &&
            node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)) {
          key = `${node.parent.name.text}.${property}`;
          ownerDeclaration = node.parent;
        }
        if (key) {
          const fn = {
            info,
            node: ts.isPropertyAssignment(node) ? node.initializer : node,
            name: key,
            ownerDeclaration,
            calls: [],
          };
          const methods = info.objectMethods.get(key) || [];
          methods.push(fn);
          info.objectMethods.set(key, methods);
          info.functionDefs.push(fn);
        }
      } else if (ts.isParameter(node)) {
        const fn = enclosingFunction(node);
        addPatternBindings(node.name, null, info, {
          kind: 'parameter',
          function: fn,
          ownerInfo: info,
          index: fn ? fn.parameters.indexOf(node) : -1,
          declaration: node,
          scope: fn,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(info.ast);

    const importVisit = node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (node.importClause?.name) {
          info.imports.set(node.importClause.name.text, { specifier, imported: 'default' });
        }
        if (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          for (const element of node.importClause.namedBindings.elements) {
            info.imports.set(element.name.text, {
              specifier,
              imported: element.propertyName?.text || element.name.text,
            });
          }
        }
        if (node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) {
          info.imports.set(node.importClause.namedBindings.name.text, { specifier, namespace: true });
        }
      }
      ts.forEachChild(node, importVisit);
    };
    importVisit(info.ast);

    const commonJsImport = node => {
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          const initializer = declaration.initializer;
          let specifier;
          let imported;
          if (
            initializer &&
            ts.isCallExpression(initializer) &&
            ts.isIdentifier(initializer.expression) &&
            initializer.expression.text === 'require' &&
            initializer.arguments.length === 1 &&
            ts.isStringLiteralLike(initializer.arguments[0])
          ) {
            specifier = initializer.arguments[0].text;
            imported = 'default';
          } else if (
            initializer &&
            ts.isPropertyAccessExpression(initializer) &&
            ts.isCallExpression(initializer.expression) &&
            ts.isIdentifier(initializer.expression.expression) &&
            initializer.expression.expression.text === 'require' &&
            initializer.expression.arguments.length === 1 &&
            ts.isStringLiteralLike(initializer.expression.arguments[0])
          ) {
            specifier = initializer.expression.arguments[0].text;
            imported = initializer.name.text;
          }
          if (!specifier) continue;
          if (ts.isIdentifier(declaration.name)) {
            info.imports.set(declaration.name.text, { specifier, imported, commonJs: true });
          } else if (ts.isObjectBindingPattern(declaration.name)) {
            for (const element of declaration.name.elements) {
              if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
              const propertyName = element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text;
              info.imports.set(element.name.text, { specifier, imported: propertyName, commonJs: true });
            }
          }
        }
      }
      ts.forEachChild(node, commonJsImport);
    };
    commonJsImport(info.ast);

    const commonJsExportTarget = expression => {
      if (!ts.isPropertyAccessExpression(expression)) return null;
      if (ts.isIdentifier(expression.expression) && expression.expression.text === 'exports') {
        return expression.name.text;
      }
      if (
        ts.isPropertyAccessExpression(expression.expression) &&
        ts.isIdentifier(expression.expression.expression) &&
        expression.expression.expression.text === 'module' &&
        expression.expression.name.text === 'exports'
      ) {
        return expression.name.text;
      }
      if (
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === 'module' &&
        expression.name.text === 'exports'
      ) {
        return 'default';
      }
      return null;
    };
    const indexCommonJsFunction = (exportName, node) => {
      const fn = {
        info,
        node,
        name: node.name?.text || exportName,
        calls: [],
      };
      info.exports.set(exportName, fn);
      info.functionDefs.push(fn);
    };
    const commonJsExportVisit = node => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const target = commonJsExportTarget(node.left);
        if (target && ts.isIdentifier(node.right)) {
          info.exports.set(target, node.right.text);
        } else if (target === 'default' && ts.isObjectLiteralExpression(node.right)) {
          for (const property of node.right.properties) {
            if (ts.isShorthandPropertyAssignment(property)) {
              info.exports.set(property.name.text, property.name.text);
            } else if (ts.isMethodDeclaration(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) {
              indexCommonJsFunction(property.name.text, property);
            } else if (ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
                ts.isIdentifier(property.initializer)) {
              info.exports.set(property.name.text, property.initializer.text);
            } else if (ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
                (ts.isFunctionExpression(property.initializer) || ts.isArrowFunction(property.initializer))) {
              indexCommonJsFunction(property.name.text, property.initializer);
            }
          }
        } else if (target &&
            (ts.isFunctionExpression(node.right) || ts.isArrowFunction(node.right))) {
          indexCommonJsFunction(target, node.right);
        }
      }
      ts.forEachChild(node, commonJsExportVisit);
    };
    commonJsExportVisit(info.ast);

    for (const statement of info.ast.statements) {
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const imported = element.propertyName?.text || element.name.text;
          const specifier = statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
            ? statement.moduleSpecifier.text
            : null;
          info.exports.set(element.name.text, specifier
            ? { kind: 'reexport', specifier, imported }
            : imported);
        }
      }
      if (ts.isExportAssignment(statement) &&
          (ts.isFunctionExpression(statement.expression) || ts.isArrowFunction(statement.expression))) {
        indexCommonJsFunction('default', statement.expression);
      }
      if (ts.isFunctionDeclaration(statement) &&
          statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        const exportedName = statement.name?.text || 'default';
        info.exports.set(exportedName, exportedName);
        if (statement.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
          info.exports.set('default', exportedName);
        }
      }
      if (ts.isVariableStatement(statement) &&
          statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) info.exports.set(declaration.name.text, declaration.name.text);
        }
      }
    }
  }

  const resolveModule = (info, specifier) => {
    if (!specifier || !specifier.startsWith('.')) return null;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(info.file), specifier));
    for (const candidate of [
      base,
      base + '.ts',
      base + '.js',
      base + '.cts',
      base + '.mts',
      base + '.cjs',
      base + '.mjs',
      base + '/index.ts',
      base + '/index.js',
      base + '/index.cts',
      base + '/index.mts',
      base + '/index.cjs',
      base + '/index.mjs',
    ]) {
      if (byFile.has(candidate)) return byFile.get(candidate);
    }
    return null;
  };
  const resolveExportedFunction = (info, name, seen = new Set()) => {
    const marker = `${info.file}\u0000${name}`;
    if (seen.has(marker)) return null;
    seen.add(marker);
    const exported = info.exports.get(name);
    if (exported && typeof exported === 'object') {
      if (exported.node) return exported;
      if (exported.kind === 'reexport') {
        const target = resolveModule(info, exported.specifier);
        return target ? resolveExportedFunction(target, exported.imported, seen) : null;
      }
    }
    const localName = typeof exported === 'string' ? exported : name;
    return info.functions.get(localName) || null;
  };
  const resolveImported = (info, name) => {
    const imported = info.imports.get(name);
    if (!imported || imported.namespace) return null;
    const target = resolveModule(info, imported.specifier);
    if (!target) return null;
    return resolveExportedFunction(target, imported.imported);
  };
  for (const info of infos) {
    for (const [name, imported] of info.imports) {
      if (!imported.namespace) {
        const fn = resolveImported(info, name);
        if (fn) info.functions.set(name, fn);
      }
    }
  }

  const resolveFunction = (info, node) => {
    const expression = unwrapPolicyExpression(node);
    if (!expression) return null;
    if (ts.isIdentifier(expression)) {
      const binding = findBinding(info, expression.text, expression);
      const candidates = info.functionDefs.filter(candidate => candidate.name === expression.text &&
        isAncestor(nearestLexicalScope(candidate.node), expression) &&
        (!binding || candidate.node === binding.declaration || candidate.node === binding.source));
      candidates.sort((left, right) =>
        scopeDepth(nearestLexicalScope(right.node)) - scopeDepth(nearestLexicalScope(left.node)));
      if (candidates[0]) return candidates[0];
      if (binding) {
        const local = info.functions.get(expression.text);
        if (local && (local.node === binding.declaration || local.node === binding.source ||
            info.imports.has(expression.text))) {
          return local;
        }
        return null;
      }
      return info.functions.get(expression.text) || resolveImported(info, expression.text);
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const key = `${expression.expression.text}.${expression.name.text}`;
      const ownerBinding = findBinding(info, expression.expression.text, expression.expression);
      const localMethods = info.objectMethods.get(key) || [];
      const localMethod = localMethods
        .filter(method => !ownerBinding || method.ownerDeclaration === ownerBinding.declaration)
        .sort((left, right) =>
          scopeDepth(nearestLexicalScope(right.node)) - scopeDepth(nearestLexicalScope(left.node)))[0];
      if (localMethod) return localMethod;
      const imported = info.imports.get(expression.expression.text);
      if (imported?.namespace || imported?.commonJs) {
        const target = resolveModule(info, imported.specifier);
        return target ? resolveExportedFunction(target, expression.name.text) : null;
      }
    }
    return null;
  };
  for (const info of infos) {
    const visit = node => {
      if (ts.isCallExpression(node)) {
        const fn = resolveFunction(info, node.expression);
        if (fn) fn.calls.push({ info, args: node.arguments });
      }
      ts.forEachChild(node, visit);
    };
    visit(info.ast);
  }

  function findBinding(info, name, node) {
    const bindings = info.bindings.filter(binding => binding.name === name &&
      (!binding.scope || isAncestor(binding.scope, node) || binding.scope === node));
    bindings.sort((left, right) => scopeDepth(right.scope) - scopeDepth(left.scope));
    return bindings[0] || null;
  }
  const bindingCalls = (binding, fallbackInfo) => {
    if (!binding.function) return [];
    const ownerInfo = binding.ownerInfo || fallbackInfo;
    const functionInfo = ownerInfo.functionDefs.find(candidate => candidate.node === binding.function);
    return functionInfo?.calls || [];
  };
  const objectIsRoom = (node, info, seen = new Set()) => {
    const expression = unwrapPolicyExpression(node);
    if (!expression) return false;
    if (ts.isIdentifier(expression)) {
      if (/^(?:room|townHall|townHallRoom)$/i.test(expression.text)) return true;
      const binding = findBinding(info, expression.text, expression);
      if (!binding || seen.has(binding)) return false;
      seen.add(binding);
      if (binding.kind === 'value' && binding.source) return objectIsRoom(binding.source, info, seen);
      if (binding.kind === 'parameter') {
        return bindingCalls(binding, info).some(call => call.args[binding.index] &&
          objectIsRoom(call.args[binding.index], call.info, new Set(seen)));
      }
    }
    return false;
  };
  const expressionIsRoomField = (node, info, seen = new Set()) => {
    const expression = unwrapPolicyExpression(node);
    if (!expression) return false;
    const key = policyPropertyKey(expression);
    if (key && ['guildId', 'channelId'].includes(key)) {
      const object = expression.expression;
      if (objectIsRoom(object, info, new Set(seen))) return true;
    }
    if (!ts.isIdentifier(expression)) return false;
    const binding = findBinding(info, expression.text, expression);
    if (!binding || seen.has(binding)) return false;
    seen.add(binding);
    if (binding.kind === 'value' && binding.source) {
      return expressionIsRoomField(binding.source, info, seen);
    }
    if ((binding.kind === 'field' || binding.kind === 'parameter-field') &&
        ['guildId', 'channelId'].includes(binding.key)) {
      if (binding.kind === 'field') return objectIsRoom(binding.source, info, new Set(seen));
      return bindingCalls(binding, info).some(call => call.args[binding.index] &&
        objectIsRoom(call.args[binding.index], call.info, new Set(seen)));
    }
    if (binding.kind === 'parameter') {
      return bindingCalls(binding, info).some(call => call.args[binding.index] &&
        expressionIsRoomField(call.args[binding.index], call.info, new Set(seen)));
    }
    return false;
  };
  const regexInputs = (node, info) => {
    const inputs = [];
    const direct = regexInput(node);
    if (direct) inputs.push(direct);
    const declaration = node.parent && ts.isVariableDeclaration(node.parent) &&
      node.parent.initializer === node && ts.isIdentifier(node.parent.name) ? node.parent : null;
    if (!declaration) return inputs;
    const name = declaration.name.text;
    const visit = current => {
      if (ts.isIdentifier(current) && current.text === name && current !== declaration.name &&
          findBinding(info, name, current)?.declaration === declaration) {
        const parent = current.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === current &&
            (parent.name.text === 'test' || parent.name.text === 'exec') && ts.isCallExpression(parent.parent)) {
          if (parent.parent.arguments[0]) inputs.push(parent.parent.arguments[0]);
        } else if (ts.isCallExpression(parent) && parent.arguments[0] === current &&
            ts.isPropertyAccessExpression(parent.expression) &&
            ['match', 'search'].includes(parent.expression.name.text)) {
          inputs.push(parent.expression.expression);
        }
      }
      ts.forEachChild(current, visit);
    };
    visit(info.ast);
    return inputs;
  };

  const sites = legacyRoomDigitPolicies(records);
  const numeric = /\\[dD]|\\[(?:\\^)?(?:0-9|0123456789)\\]/;
  for (const info of infos) {
    const legacyBindings = collectBindings(info.ast);
    const visit = node => {
      let pattern = null;
      if (ts.isRegularExpressionLiteral(node)) pattern = node.text;
      else if ((ts.isNewExpression(node) || ts.isCallExpression(node)) &&
          ts.isIdentifier(node.expression) && node.expression.text === 'RegExp' &&
          node.arguments?.length && ts.isStringLiteralLike(node.arguments[0])) {
        pattern = node.arguments[0].text;
      }
      if (pattern !== null && numeric.test(pattern)) {
        const legacyPolicy = isTownHallRoomOwner(node, info.ast, legacyBindings) ||
          roomFieldSubject(node, info.ast, legacyBindings) ||
          isSplitRoomDigitPolicy(node, info.ast, pattern, legacyBindings);
        if (!legacyPolicy && regexInputs(node, info).some(input => expressionIsRoomField(input, info))) {
          sites[info.file] = (sites[info.file] || 0) + 1;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(info.ast);
  }
  return sites;
}

test('room policy inventory records only town-hall room validators', () => {
  const src = path.join(PROJECT_ROOT, 'src');
  const references = {};
  const records = [];
  for (const relative of fs.readdirSync(src, { recursive: true })) {
    if (!/\.(?:[cm]?[tj]s)$/.test(relative)) continue;
    const text = fs.readFileSync(path.join(src, relative), 'utf8');
    records.push({ file: relative.split(path.sep).join('/'), text });
    const ast = createSourceFile(relative, text);
    const count = countIdentifierReferences(ast, 'isTownHallRoom');
    if (count) references[relative.split(path.sep).join('/')] = count;
  }
  assert.deepEqual(references, { 'peer/town-hall-plan.ts': 2, 'peer/town-hall-room-identity.ts': 2 });
  const referenceFixture = ts.createSourceFile('peer/reference-fixture.ts', String.raw`// isTownHallRoom
  const label = 'isTownHallRoom';
  function isTownHallRoom(room) { return room; }
  isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(referenceFixture, 'isTownHallRoom'), 2);
  // Synthetic fixtures are independent of production files, so reuse the production baseline.
  const uncachedRoomDigitPolicies = roomDigitPolicies;
  const productionRecordTexts = new Map(records.map(record => [record.file, record.text]));
  const basePolicies = uncachedRoomDigitPolicies(records);
  const policyFixtureCache = new Map();
  roomDigitPolicies = fixtureRecords => {
    const syntheticRecords = fixtureRecords.filter(record => productionRecordTexts.get(record.file) !== record.text);
    if (!syntheticRecords.length) return basePolicies;
    const key = syntheticRecords.map(record => `${record.file}\u0000${record.text}`).join('\u0000');
    if (!policyFixtureCache.has(key)) {
      policyFixtureCache.set(key, uncachedRoomDigitPolicies(syntheticRecords));
    }
    const combined = { ...basePolicies };
    for (const [file, count] of Object.entries(policyFixtureCache.get(key))) {
      combined[file] = (combined[file] || 0) + count;
    }
    return combined;
  };
  const expectedPolicies = { 'peer/town-hall-plan.ts': 2 };
  assert.deepEqual(roomDigitPolicies(records), expectedPolicies);
  const commonJsHelper = {
    file: 'peer/commonjs-room-helper.js',
    text: String.raw`function validateGuildId(value) { return /^\d{1,21}$/.test(value); }
    module.exports = validateGuildId;`
  };
  const commonJsConsumer = {
    file: 'peer/commonjs-room-consumer.js',
    text: String.raw`const validateGuildId = require('./commonjs-room-helper');
    function validateRoom(room) { return validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, commonJsHelper, commonJsConsumer]), {
    ...expectedPolicies,
    'peer/commonjs-room-helper.js': 1
  });
  const directCommonJsFunctionHelper = {
    file: 'peer/direct-commonjs-room-helper.js',
    text: String.raw`module.exports = function validateGuildId(value) {
      return /^\d{1,21}$/.test(value);
    }`
  };
  const directCommonJsFunctionConsumer = {
    file: 'peer/direct-commonjs-room-consumer.js',
    text: String.raw`const validateGuildId = require('./direct-commonjs-room-helper');
    function validateRoom(room) { return validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    directCommonJsFunctionHelper,
    directCommonJsFunctionConsumer,
  ]), {
    ...expectedPolicies,
    'peer/direct-commonjs-room-helper.js': 1
  });
  const directCommonJsArrowHelper = {
    file: 'peer/direct-commonjs-arrow-helper.js',
    text: String.raw`module.exports = value => /^\d{1,21}$/.test(value);`
  };
  const directCommonJsArrowConsumer = {
    file: 'peer/direct-commonjs-arrow-consumer.js',
    text: String.raw`const validateGuildId = require('./direct-commonjs-arrow-helper');
    function validateRoom(room) { return validateGuildId(room.channelId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    directCommonJsArrowHelper,
    directCommonJsArrowConsumer,
  ]), {
    ...expectedPolicies,
    'peer/direct-commonjs-arrow-helper.js': 1
  });
  const namedCommonJsHelper = {
    file: 'peer/named-commonjs-room-helper.js',
    text: String.raw`exports.validateGuildId = value => /^\d{1,20}$/.test(value);
    module.exports.validateChannelId = function validateChannelId(value) {
      return /^\d{1,20}$/.test(value);
    }`
  };
  const namedCommonJsConsumer = {
    file: 'peer/named-commonjs-room-consumer.js',
    text: String.raw`const { validateGuildId, validateChannelId } = require('./named-commonjs-room-helper');
    function validateRoom(room) {
      return validateGuildId(room.guildId) && validateChannelId(room.guildId);
    }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    namedCommonJsHelper,
    namedCommonJsConsumer,
  ]), {
    ...expectedPolicies,
    'peer/named-commonjs-room-helper.js': 2
  });
  const inline = { file: 'peer/future-room.ts', text: String.raw`function validateRoom(room) { return /^\d{1,20}$/.test(room.guildId); }` };
  assert.notDeepEqual(roomDigitPolicies([...records, inline]), expectedPolicies);
  const constructor = { file: 'peer/future-room.ts', text: String.raw`function validateRoom(room) { return new RegExp('^[0-9]{1,21}$').test(room.guildId); }` };
  assert.notDeepEqual(roomDigitPolicies([...records, constructor]), expectedPolicies);
  const expandedAsciiDigits = {
    file: 'peer/future-room.ts',
    text: String.raw`function validateRoom(room) { return /^[0123456789]{1,21}$/.test(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, expandedAsciiDigits]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const directCall = { file: 'peer/future-room.ts', text: String.raw`function validateRoom(room) { return RegExp('^[0-9]{1,21}$').test(room.channelId); }` };
  assert.notDeepEqual(roomDigitPolicies([...records, directCall]), expectedPolicies);
  const destructuredRoomField = {
    file: 'peer/future-room.ts',
    text: 'function validateRoom(room) { const { guildId } = room; return /^\\d{1,21}$/.test(guildId); }'
  };
  assert.deepEqual(roomDigitPolicies([...records, destructuredRoomField]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const regexConstant = {
    file: 'peer/future-room.ts',
    text: 'function validateRoom(room) { const ROOM_ID = /^\\d{1,21}$/; return ROOM_ID.test(room.guildId); }'
  };
  assert.deepEqual(roomDigitPolicies([...records, regexConstant]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const shadowedRegex = {
    file: 'peer/snowflake.ts',
    text: String.raw`const ROOM_ID = /^\d+$/;
    function validateRoom(room) {
      const ROOM_ID = /^not-a-room$/;
      return ROOM_ID.test(room.guildId);
    }`
  };
  assert.deepEqual(roomDigitPolicies([...records, shadowedRegex]), expectedPolicies);
  const importedRoomHelper = {
    file: 'peer/future-helper.ts',
    text: 'export function validateGuildId(value) { return /^\\d{1,21}$/.test(value); }'
  };
  const importedRoomConsumer = {
    file: 'peer/future-consumer.ts',
    text: "import { validateGuildId } from './future-helper'; function validateRoom(room) { return validateGuildId(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([...records, importedRoomHelper, importedRoomConsumer]), {
    ...expectedPolicies,
    'peer/future-helper.ts': 1
  });
  const barrelRoomHelper = {
    file: 'peer/barrel-room.ts',
    text: 'export function validateGuildId(value) { return /^\\d{1,21}$/.test(value); }'
  };
  const barrelRoom = {
    file: 'peer/barrel.ts',
    text: "export { validateGuildId } from './barrel-room';"
  };
  const barrelRoomConsumer = {
    file: 'peer/barrel-consumer.ts',
    text: "import { validateGuildId } from './barrel'; function validateRoom(room) { return validateGuildId(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    barrelRoomHelper,
    barrelRoom,
    barrelRoomConsumer,
  ]), {
    ...expectedPolicies,
    'peer/barrel-room.ts': 1
  });
  const objectMethodValidator = {
    file: 'peer/object-method-validator.ts',
    text: String.raw`const validators = {
      validateGuildId(value) { return /^\d{1,21}$/.test(value); }
    };
    function validateRoom(room) { return validators.validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, objectMethodValidator]), {
    ...expectedPolicies,
    'peer/object-method-validator.ts': 1
  });
  const functionPropertyValidator = {
    file: 'peer/function-property-validator.ts',
    text: String.raw`const validators = {
      validateGuildId: value => /^\d{1,21}$/.test(value)
    };
    function validateRoom(room) { return validators.validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, functionPropertyValidator]), {
    ...expectedPolicies,
    'peer/function-property-validator.ts': 1
  });
  const functionExpressionPropertyValidator = {
    file: 'peer/function-expression-property-validator.ts',
    text: String.raw`const validators = {
      validateChannelId: function (value) { return /^\d{1,21}$/.test(value); }
    };
    function validateRoom(room) { return validators.validateChannelId(room.channelId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, functionExpressionPropertyValidator]), {
    ...expectedPolicies,
    'peer/function-expression-property-validator.ts': 1
  });
  const classValidator = {
    file: 'peer/class-validator.ts',
    text: String.raw`class Validators {
      static validateGuildId(value) { return /^\d{1,21}$/.test(value); }
    }
    function validateRoom(room) { return Validators.validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, classValidator]), {
    ...expectedPolicies,
    'peer/class-validator.ts': 1
  });
  const renamedParameter = { file: 'peer/future-room.ts', text: String.raw`function validateTownHallRoom(candidate) {
    return /^\d{1,21}$/.test(candidate.guildId);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, renamedParameter]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const guardedRoomKeyAlias = { file: 'peer/future-room.ts', text: String.raw`function validateTownHallRoom(candidate) {
    const id = ownDataProperty(candidate, 'guildId');
    return /^\d{1,21}$/.test(id);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, guardedRoomKeyAlias]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const matchRoomField = { file: 'peer/future-room.ts', text: String.raw`function validateTownHallRoom(candidate) {
    return candidate.guildId.match(/^\d{1,21}$/);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, matchRoomField]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const execRoomField = { file: 'peer/future-room.ts', text: String.raw`function validateTownHallRoom(candidate) {
    return /^\d{1,21}$/.exec(candidate.channelId);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, execRoomField]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const searchRoomField = { file: 'peer/future-room.ts', text: String.raw`function validateTownHallRoom(candidate) {
    return candidate.guildId.search(/^\d{1,21}$/) !== -1;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, searchRoomField]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const anonymousDefaultValidator = {
    file: 'peer/anonymous-default-validator.ts',
    text: String.raw`export default function (value) { return /^\d{1,21}$/.test(value); }`
  };
  const anonymousDefaultConsumer = {
    file: 'peer/anonymous-default-consumer.ts',
    text: String.raw`import validateGuildId from './anonymous-default-validator';
    function validateRoom(room) { return validateGuildId(room.channelId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    anonymousDefaultValidator,
    anonymousDefaultConsumer,
  ]), {
    ...expectedPolicies,
    'peer/anonymous-default-validator.ts': 1
  });
  const defaultExpressionValidator = {
    file: 'peer/default-expression-validator.ts',
    text: String.raw`export default (value) => /^\d{1,21}$/.test(value);`
  };
  const defaultExpressionConsumer = {
    file: 'peer/default-expression-consumer.ts',
    text: String.raw`import validateGuildId from './default-expression-validator';
    function validateRoom(room) { return validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    defaultExpressionValidator,
    defaultExpressionConsumer,
  ]), {
    ...expectedPolicies,
    'peer/default-expression-validator.ts': 1
  });
  const moduleSpecificValidator = {
    file: 'peer/module-specific-room-validator.cts',
    text: String.raw`export function validateGuildId(value) { return /^\d{1,21}$/.test(value); }`
  };
  const moduleSpecificConsumer = {
    file: 'peer/module-specific-room-consumer.cjs',
    text: String.raw`const { validateGuildId } = require('./module-specific-room-validator');
    function validateRoom(room) { return validateGuildId(room.channelId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    moduleSpecificValidator,
    moduleSpecificConsumer,
  ]), {
    ...expectedPolicies,
    'peer/module-specific-room-validator.cts': 1
  });
  const unrelatedMatch = { file: 'peer/snowflake.ts', text: String.raw`function inspect(candidate) {
    return candidate.guildId.match(/^\d{1,21}$/);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, unrelatedMatch]), expectedPolicies);
  const unrelatedExec = { file: 'peer/snowflake.ts', text: String.raw`function inspect(candidate) {
    return /^\d{1,21}$/.exec(candidate.channelId);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, unrelatedExec]), expectedPolicies);
  const unrelatedSearch = { file: 'peer/snowflake.ts', text: String.raw`function inspect(candidate) {
    return candidate.guildId.search(/^\d{1,21}$/) !== -1;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, unrelatedSearch]), expectedPolicies);
  const unrelatedBounded = { file: 'peer/snowflake.ts', text: String.raw`function validateId(value) { return /^\d{1,20}$/.test(value); }` };
  assert.deepEqual(roomDigitPolicies([...records, unrelatedBounded]), expectedPolicies);
  const unrelatedOwnerPattern = { file: 'peer/town-hall-plan.ts', text: String.raw`function isTownHallRoom(value) { return /^\d{1,20}$/.test(value); }` };
  assert.deepEqual(roomDigitPolicies([...records, unrelatedOwnerPattern]), expectedPolicies);
  const splitNeutral = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(room) {
    return /^\d+$/.test(room.guildId) && room.guildId.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, splitNeutral]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1
  });
  const splitAlias = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(room) {
    const value = room.channelId;
    return /^\d+$/.test(value) && value.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, splitAlias]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1
  });
  const splitCall = { file: 'peer/snowflake.ts', text: String.raw`function isSnowflake(value) {
    return /^\d+$/.test(value) && value.length <= 20;
  }
  function inspect(room) { return isSnowflake(room.guildId); }` };
  assert.deepEqual(roomDigitPolicies([...records, splitCall]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1
  });
  const bracketField = { file: 'peer/snowflake.ts', text: String.raw`function inspect(room) {
    return /^\d+$/.test(room['guildId']);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, bracketField]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1
  });
  const arrowBound = { file: 'peer/snowflake.ts', text: String.raw`const isDigits = value => /^\d+$/.test(value) && value.length <= 20;
  function inspect(room) { return isDigits(room.guildId); }` };
  assert.deepEqual(roomDigitPolicies([...records, arrowBound]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1
  });
  const anonymousBound = { file: 'peer/snowflake.ts', text: String.raw`const isDigits = function(value) {
    return /^\d+$/.test(value) && value.length <= 20;
  };
  function inspect(room) { return isDigits(room.channelId); }` };
  assert.deepEqual(roomDigitPolicies([...records, anonymousBound]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1
  });
  const shadowedBound = { file: 'peer/snowflake.ts', text: String.raw`const isDigits = value => /^\d+$/.test(value) && value.length <= 20;
  function inspect(room) { return isDigits(room.guildId); }
  function shadowed(room, isDigits) { return isDigits(room.guildId); }
  function unrelated(user, isDigits) { return isDigits(user.id); }
  function unrelatedHelper(user) {
    const isDigits = value => /^\d+$/.test(value) && value.length <= 20;
    return isDigits(user.id);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, shadowedBound]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1
  });
  const emptyInitializer = { file: 'peer/town-hall-plan.ts', text: String.raw`function isTownHallRoom(room) {
    const id = ownDataProperty(room, 'guildId');
    function nested() { let id; return /^\d+$/.test(id); }
    return /^\d+$/.test(id);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, emptyInitializer]), {
    ...expectedPolicies,
    'peer/town-hall-plan.ts': 3
  });
  const assignedAlias = { file: 'peer/town-hall-plan.ts', text: String.raw`function isTownHallRoom(room) {
    let id;
    id = ownDataProperty(room, 'channelId');
    return /^\d+$/.test(id);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, assignedAlias]), {
    ...expectedPolicies,
    'peer/town-hall-plan.ts': 3
  });
  const emptySplit = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(room) {
    return /^\d*$/.test(room.guildId) && room.guildId.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, emptySplit]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1
  });
  const emptyAlias = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(room) {
    const value = room.channelId;
    return /^\d*$/.test(value) && value.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, emptyAlias]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1
  });
  const emptyCall = { file: 'peer/snowflake.ts', text: String.raw`function isSnowflake(value) {
    return /^\d*$/.test(value) && value.length <= 20;
  }
  function inspect(room) { return isSnowflake(room.channelId); }` };
  assert.deepEqual(roomDigitPolicies([...records, emptyCall]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1
  });
  const ordinarySplit = { file: 'peer/snowflake.ts', text: String.raw`function validateSnowflake(value) {
    return /^\d+$/.test(value) && value.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, ordinarySplit]), expectedPolicies);
  const ordinaryFieldSplit = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(user) {
    return /^\d+$/.test(user.guildId) && user.guildId.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, ordinaryFieldSplit]), expectedPolicies);
  const ordinaryCall = { file: 'peer/snowflake.ts', text: String.raw`function isSnowflake(value) {
    return /^\d+$/.test(value) && value.length <= 20;
  }
  function inspect(user) { return isSnowflake(user.guildId); }` };
  assert.deepEqual(roomDigitPolicies([...records, ordinaryCall]), expectedPolicies);
  const copied = records.map(record => record.file === 'peer/town-hall-room-identity.ts'
    ? { ...record, text: record.text + inline.text } : record);
  assert.notDeepEqual(roomDigitPolicies(copied), expectedPolicies);
});
