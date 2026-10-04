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

function callPropertyName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression &&
      ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return null;
}

function regexInput(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === current &&
        ['test', 'exec'].includes(callPropertyName(parent)) &&
        ts.isCallExpression(parent.parent)) {
      return parent.parent.arguments[0] || null;
    }
    if (ts.isCallExpression(parent) && parent.arguments[0] === current &&
        ['match', 'search'].includes(callPropertyName(parent.expression))) {
      return parent.expression.expression;
    }
    if (ts.isCallExpression(parent) && parent.arguments[1] === current &&
        ts.isPropertyAccessExpression(parent.expression) &&
        parent.expression.name.text === 'call' &&
        callPropertyName(parent.expression.expression) === 'search') {
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
  const bindings = collectBindings(sourceFile);
  const importBindings = [];
  const collectImportBindings = node => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const scope = sourceFile;
      if (node.importClause.name) {
        importBindings.push({
          declaration: node.importClause.name,
          name: node.importClause.name.text,
          scope,
        });
      }
      if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const element of node.importClause.namedBindings.elements) {
          importBindings.push({ declaration: element.name, name: element.name.text, scope });
        }
      }
    }
    ts.forEachChild(node, collectImportBindings);
  };
  collectImportBindings(sourceFile);
  bindings.push(...importBindings);
  const candidates = bindings.filter(binding => binding.name === name &&
    binding.scope === sourceFile);
  const target = candidates.find(binding => ts.isFunctionDeclaration(binding.declaration) &&
    binding.declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) ||
    candidates[0] || null;
  if (!target) return 0;
  let count = 0;
  const visit = node => {
    if (ts.isIdentifier(node) && node.text === name &&
        node !== target.declaration.name &&
        isSemanticIdentifierReference(node) &&
        resolveBinding(node, bindings) === target.declaration) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

function isSemanticIdentifierReference(node) {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) || ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) && parent.name === node) {
    return false;
  }
  if ((ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) || ts.isModuleDeclaration(parent)) && parent.name === node) {
    return false;
  }
  return true;
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
  if (parent && (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) &&
      parent.initializer === scope && ts.isIdentifier(parent.name)) {
    return parent;
  }
  if (ts.isFunctionDeclaration(scope) && scope.name && ts.isIdentifier(scope.name)) return scope;
  if (scope.name && ts.isIdentifier(scope.name)) return scope;
  return null;
}

function bindingName(binding) {
  if ((ts.isVariableDeclaration(binding) || ts.isFunctionDeclaration(binding) ||
      ts.isFunctionExpression(binding) || ts.isClassDeclaration(binding) ||
      ts.isPropertyAssignment(binding) || ts.isPropertyDeclaration(binding)) &&
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
  const resolvesToTarget = (reference, seen = new Set()) => {
    if (!ts.isIdentifier(reference)) return false;
    const binding = resolveBinding(reference, bindings);
    if (!binding || seen.has(binding)) return false;
    if (binding === target) return true;
    seen.add(binding);
    return ts.isVariableDeclaration(binding) && binding.initializer &&
      resolvesToTarget(binding.initializer, seen);
  };
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name &&
        node.arguments.length === 1 && matches(node.arguments[0]) &&
        resolveBinding(node.expression, bindings) === target) {
      found = true;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        node.arguments.length === 1 && matches(node.arguments[0]) &&
        resolvesToTarget(node.expression)) {
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

function isNeutralRoomPolicy(scope) {
  const owner = functionBinding(scope);
  const ownerName = scope?.name && ts.isIdentifier(scope.name)
    ? scope.name.text
    : owner ? bindingName(owner) : null;
  const fileName = scope?.getSourceFile?.().fileName || scope?.fileName || '';
  return /snowflake/i.test(ownerName || '') || /(?:^|[\\/])snowflake\.[cm]?[tj]s$/.test(fileName);
}

function roomFieldSubject(node, sourceFile, bindings) {
  const subject = regexInput(node);
  if (!subject) return false;
  const scope = enclosingFunction(node) || sourceFile;
  if (isNeutralRoomPolicy(scope)) return false;
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

function hasAsciiDigitPattern(pattern) {
  if (/\\[dD]/.test(pattern)) return true;
  const classes = pattern.match(/\[(?:\^)?([^\]]*)\]/g) || [];
  return classes.some(characterClass => {
    const body = characterClass.replace(/^\[\^?/, '').replace(/\]$/, '');
    return /[0-9]-[0-9]/.test(body) || /[0-9]{2,}/.test(body);
  });
}

function legacyRoomDigitPolicies(records) {
  const sites = {};
  for (const { file, text } of records) {
    const ast = createSourceFile(file, text);
    const bindings = collectBindings(ast);
    const visit = node => {
      let pattern = null;
      if (ts.isRegularExpressionLiteral(node)) pattern = node.text;
      else if ((ts.isNewExpression(node) || ts.isCallExpression(node)) &&
          ts.isIdentifier(node.expression) && node.expression.text === 'RegExp' &&
          node.arguments?.length && ts.isStringLiteralLike(node.arguments[0])) {
        pattern = node.arguments[0].text;
      }
      const roomPolicy = pattern !== null && hasAsciiDigitPattern(pattern) &&
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
    starExports: [],
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
      if (ts.isExportDeclaration(statement)) {
        const specifier = statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            const imported = element.propertyName?.text || element.name.text;
            info.exports.set(element.name.text, specifier
              ? { kind: 'reexport', specifier, imported }
              : imported);
          }
        } else if (!statement.exportClause && specifier) {
          info.starExports.push(specifier);
        }
      }
      if (ts.isExportAssignment(statement)) {
        if (ts.isFunctionExpression(statement.expression) || ts.isArrowFunction(statement.expression)) {
          indexCommonJsFunction('default', statement.expression);
        } else if (!statement.isExportEquals && ts.isObjectLiteralExpression(statement.expression)) {
          for (const property of statement.expression.properties) {
            if (ts.isMethodDeclaration(property) &&
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
        } else if (ts.isIdentifier(statement.expression)) {
          info.exports.set('default', statement.expression.text);
        }
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
    for (const specifier of info.starExports) {
      const target = resolveModule(info, specifier);
      const resolved = target ? resolveExportedFunction(target, name, seen) : null;
      if (resolved) return resolved;
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

  const resolveFunction = (info, node, seen = new Set()) => {
    const expression = unwrapPolicyExpression(node);
    if (!expression) return null;
    if (ts.isIdentifier(expression)) {
      const binding = findBinding(info, expression.text, expression);
      if (binding?.kind === 'value' && binding.source && !seen.has(binding)) {
        seen.add(binding);
        const aliased = resolveFunction(info, binding.source, seen);
        if (aliased) return aliased;
      }
      if ((binding?.kind === 'field' || binding?.kind === 'parameter-field') &&
          binding.source && binding.key && ts.isIdentifier(binding.source)) {
        const aliased = (info.objectMethods.get(binding.source.text + '.' + binding.key) || [])[0];
        if (aliased) return aliased;
      }
      const overloadScope = binding && ts.isFunctionDeclaration(binding.declaration)
        ? nearestLexicalScope(binding.declaration)
        : null;
      const candidates = info.functionDefs.filter(candidate => candidate.name === expression.text &&
        isAncestor(nearestLexicalScope(candidate.node), expression) &&
        (!binding || candidate.node === binding.declaration || candidate.node === binding.source ||
          (overloadScope && nearestLexicalScope(candidate.node) === overloadScope)));
      candidates.sort((left, right) =>
        Number(Boolean(right.node.body)) - Number(Boolean(left.node.body)) ||
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
    if ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
        ts.isIdentifier(expression.expression)) {
      const property = policyPropertyKey(expression);
      if (!property) return null;
      const key = expression.expression.text + '.' + property;
      const ownerBinding = findBinding(info, expression.expression.text, expression.expression);
      const localMethods = info.objectMethods.get(key) || [];
      const localMethod = localMethods
        .filter(method => !ownerBinding || method.ownerDeclaration === ownerBinding.declaration)
        .sort((left, right) =>
          scopeDepth(nearestLexicalScope(right.node)) - scopeDepth(nearestLexicalScope(left.node)))[0];
      if (localMethod) return localMethod;
      const imported = info.imports.get(expression.expression.text);
      if (imported?.namespace || imported?.commonJs || imported?.imported === 'default') {
        const target = resolveModule(info, imported.specifier);
        return target ? resolveExportedFunction(target, property) : null;
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
    const seenDeclarations = new Set();
    const collectDeclarationInputs = currentDeclaration => {
      if (seenDeclarations.has(currentDeclaration)) return;
      seenDeclarations.add(currentDeclaration);
      const name = currentDeclaration.name.text;
      const visit = current => {
        if (ts.isIdentifier(current) && current.text === name && current !== currentDeclaration.name &&
            findBinding(info, name, current)?.declaration === currentDeclaration) {
          const parent = current.parent;
          if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
              parent.expression === current &&
              ['test', 'exec'].includes(callPropertyName(parent)) && ts.isCallExpression(parent.parent)) {
            if (parent.parent.arguments[0]) inputs.push(parent.parent.arguments[0]);
          } else if (ts.isCallExpression(parent) && parent.arguments[0] === current &&
              ['match', 'search'].includes(callPropertyName(parent.expression))) {
            inputs.push(parent.expression.expression);
          } else if (ts.isCallExpression(parent) && parent.arguments[1] === current &&
              ts.isPropertyAccessExpression(parent.expression) &&
              parent.expression.name.text === 'call' &&
              callPropertyName(parent.expression.expression) === 'search' &&
              parent.arguments[0]) {
            inputs.push(parent.arguments[0]);
          } else if (ts.isVariableDeclaration(parent) && parent.initializer === current &&
              ts.isIdentifier(parent.name) &&
              findBinding(info, parent.name.text, parent.name)?.declaration === parent) {
            collectDeclarationInputs(parent);
          }
        }
        ts.forEachChild(current, visit);
      };
      visit(info.ast);
    };
    collectDeclarationInputs(declaration);
    return inputs;
  };

  const importedRegexInputs = (info, localName, imported) => {
    const inputs = [];
    const visit = node => {
      if (ts.isIdentifier(node) && node.text === localName) {
        const binding = findBinding(info, localName, node);
        const requireBinding = binding?.source && ts.isCallExpression(binding.source) &&
          ts.isIdentifier(binding.source.expression) && binding.source.expression.text === 'require';
        const importedBinding = !binding || imported.commonJs || requireBinding;
        if (importedBinding) {
          const parent = node.parent;
          if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
              parent.expression === node &&
              ['test', 'exec'].includes(callPropertyName(parent)) && ts.isCallExpression(parent.parent)) {
            if (parent.parent.arguments[0]) inputs.push(parent.parent.arguments[0]);
          } else if (ts.isCallExpression(parent) && parent.arguments[0] === node &&
              ['match', 'search'].includes(callPropertyName(parent.expression))) {
            inputs.push(parent.expression.expression);
          } else if (ts.isCallExpression(parent) && parent.arguments[1] === node &&
              ts.isPropertyAccessExpression(parent.expression) &&
              parent.expression.name.text === 'call' &&
              callPropertyName(parent.expression.expression) === 'search' &&
              parent.arguments[0]) {
            inputs.push(parent.arguments[0]);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(info.ast);
    return inputs;
  };

  const resolveRegexExport = (info, name, seen = new Set()) => {
    const marker = `${info.file}\u0000${name}`;
    if (seen.has(marker)) return null;
    seen.add(marker);
    const exported = info.exports.get(name);
    if (exported && typeof exported === 'object') {
      if (exported.kind === 'reexport') {
        const target = resolveModule(info, exported.specifier);
        return target ? resolveRegexExport(target, exported.imported, seen) : null;
      }
      return null;
    }
    for (const specifier of info.starExports) {
      const target = resolveModule(info, specifier);
      const resolved = target ? resolveRegexExport(target, name, seen) : null;
      if (resolved) return resolved;
    }
    const localName = typeof exported === 'string' ? exported : name;
    let result = null;
    const visit = node => {
      if (result || !ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) ||
          node.name.text !== localName || !node.initializer) {
        ts.forEachChild(node, visit);
        return;
      }
      const initializer = node.initializer;
      if (ts.isRegularExpressionLiteral(initializer)) {
        result = { info, name, declaration: node, pattern: initializer.text };
      } else if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) &&
          initializer.expression.text === 'RegExp' && initializer.arguments.length &&
          ts.isStringLiteralLike(initializer.arguments[0])) {
        result = { info, name, declaration: node, pattern: initializer.arguments[0].text };
      }
      ts.forEachChild(node, visit);
    };
    visit(info.ast);
    return result;
  };

  const sites = legacyRoomDigitPolicies(records);
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
      if (pattern !== null && hasAsciiDigitPattern(pattern)) {
        const legacyPolicy = isTownHallRoomOwner(node, info.ast, legacyBindings) ||
          roomFieldSubject(node, info.ast, legacyBindings) ||
          isSplitRoomDigitPolicy(node, info.ast, pattern, legacyBindings);
        const roomScope = enclosingFunction(node) || info.ast;
        const roomContext = isTownHallContext(roomScope, info.ast, legacyBindings);
        const isRoomInput = input => !isNeutralRoomPolicy(roomScope) &&
          (expressionIsRoomField(input, info) || (roomContext && isRoomField(input)));
        if (!legacyPolicy && regexInputs(node, info).some(isRoomInput)) {
          sites[info.file] = (sites[info.file] || 0) + 1;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(info.ast);
  }
  const countedRegexExports = new Set();
  for (const consumer of infos) {
    for (const [localName, imported] of consumer.imports) {
      if (imported.namespace) continue;
      const target = resolveModule(consumer, imported.specifier);
      const resolved = target && resolveRegexExport(target, imported.imported);
      if (!resolved || !hasAsciiDigitPattern(resolved.pattern)) continue;
      const inputs = importedRegexInputs(consumer, localName, imported);
      const roomInput = inputs.some(input => {
        const scope = enclosingFunction(input) || consumer.ast;
        return !isNeutralRoomPolicy(scope) && expressionIsRoomField(input, consumer);
      });
      if (!roomInput) continue;
      const key = `${resolved.info.file}\u0000${resolved.name}`;
      const localInputs = regexInputs(resolved.declaration.initializer, resolved.info);
      if (localInputs.some(input => expressionIsRoomField(input, resolved.info))) {
        countedRegexExports.add(key);
        continue;
      }
      if (!countedRegexExports.has(key)) {
        sites[resolved.info.file] = (sites[resolved.info.file] || 0) + 1;
        countedRegexExports.add(key);
      }
    }
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
  assert.deepEqual(references, { 'peer/town-hall-plan.ts': 1, 'peer/town-hall-room-identity.ts': 2 });
  const referenceFixture = ts.createSourceFile('peer/reference-fixture.ts', String.raw`// isTownHallRoom
  const label = 'isTownHallRoom';
  interface Options { isTownHallRoom: boolean }
  type Alias = { isTownHallRoom: boolean };
  const options = { isTownHallRoom: true };
  const { isTownHallRoom: flag } = options;
  function isTownHallRoom(room) { return room; }
  isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(referenceFixture, 'isTownHallRoom'), 1);
  const shadowedReferenceFixture = ts.createSourceFile('peer/shadowed-reference-fixture.ts', String.raw`function isTownHallRoom(room) { return room; }
  function unrelated() { function isTownHallRoom(room) { return room; } return isTownHallRoom({}); }
  isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(shadowedReferenceFixture, 'isTownHallRoom'), 1);
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
  const exportEqualsHelper = {
    file: 'peer/export-equals-room-helper.cts',
    text: String.raw`function validateGuildId(value) { return /^\d{1,21}$/.test(value); }
    export = validateGuildId;`
  };
  const exportEqualsConsumer = {
    file: 'peer/export-equals-room-consumer.cts',
    text: String.raw`const validateGuildId = require('./export-equals-room-helper');
    function validateRoom(room) { return validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    exportEqualsHelper,
    exportEqualsConsumer,
  ]), {
    ...expectedPolicies,
    'peer/export-equals-room-helper.cts': 1
  });
  const exportEqualsNegativeConsumer = {
    file: 'peer/export-equals-room-negative-consumer.cts',
    text: String.raw`const validateGuildId = require('./export-equals-room-helper');
    function inspectRoom(room) { return validateGuildId(room.name); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    exportEqualsHelper,
    exportEqualsNegativeConsumer,
  ]), expectedPolicies);
  const inlineCommonJsObjectHelper = {
    file: 'peer/inline-commonjs-room-helper.cjs',
    text: String.raw`module.exports = {
      validateGuildId(value) { return /^\d{1,21}$/.test(value); },
      validateChannelId: value => /^\d{1,21}$/.test(value),
    };`
  };
  const inlineCommonJsObjectConsumer = {
    file: 'peer/inline-commonjs-room-consumer.cjs',
    text: String.raw`const { validateGuildId, validateChannelId } = require('./inline-commonjs-room-helper');
    function validateRoom(room) { return validateGuildId(room.guildId) && validateChannelId(room.channelId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    inlineCommonJsObjectHelper,
    inlineCommonJsObjectConsumer,
  ]), {
    ...expectedPolicies,
    'peer/inline-commonjs-room-helper.cjs': 2
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
  const esmDefaultObjectHelper = {
    file: 'peer/esm-default-room-helper.ts',
    text: String.raw`export default {
      validateGuildId(value) { return /^\d{1,21}$/.test(value); },
      validateChannelId: value => /^\d{1,21}$/.test(value),
    };`
  };
  const esmDefaultObjectConsumer = {
    file: 'peer/esm-default-room-consumer.ts',
    text: String.raw`import validators from './esm-default-room-helper';
    function validateRoom(room) {
      return validators.validateGuildId(room.guildId) && validators.validateChannelId(room.channelId);
    }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    esmDefaultObjectHelper,
    esmDefaultObjectConsumer,
  ]), {
    ...expectedPolicies,
    'peer/esm-default-room-helper.ts': 2
  });
  const overloadedValidator = {
    file: 'peer/overloaded-room-validator.ts',
    text: String.raw`function validateGuildId(value: string): boolean;
    function validateGuildId(value: number): boolean;
    function validateGuildId(value: string | number) {
      return /^\d{1,21}$/.test(value);
    }
    function validateRoom(room) { return validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, overloadedValidator]), {
    ...expectedPolicies,
    'peer/overloaded-room-validator.ts': 1
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
  const restrictedAsciiDigits = {
    file: 'peer/future-room.ts',
    text: String.raw`function validateRoom(room) { return /^[1-9]{1,20}$/.test(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, restrictedAsciiDigits]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const unrelatedRestrictedDigits = {
    file: 'peer/snowflake.ts',
    text: String.raw`function inspect(value) { return /^[1-9]+$/.test(value); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, unrelatedRestrictedDigits]), expectedPolicies);
  const neutralSnowflakeRoomValidator = {
    file: 'peer/snowflake.ts',
    text: String.raw`function inspectSnowflake(room) { return /^\d{1,21}$/.test(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, neutralSnowflakeRoomValidator]), expectedPolicies);
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
  const regexAlias = {
    file: 'peer/future-room.ts',
    text: 'function validateRoom(room) { const ROOM_ID = /^\\d{1,21}$/; const VALIDATOR = ROOM_ID; return VALIDATOR.test(room.guildId); }'
  };
  assert.deepEqual(roomDigitPolicies([...records, regexAlias]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const importedRegexHelper = {
    file: 'peer/imported-room-regex.ts',
    text: 'export const ROOM_ID = /^\\d{1,21}$/;'
  };
  const importedRegexConsumer = {
    file: 'peer/imported-room-regex-consumer.ts',
    text: "import { ROOM_ID } from './imported-room-regex'; function validateRoom(room) { return ROOM_ID.test(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedRegexHelper,
    importedRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/imported-room-regex.ts': 1
  });
  const importedRegexNegativeConsumer = {
    file: 'peer/imported-room-regex-negative-consumer.ts',
    text: "import { ROOM_ID } from './imported-room-regex'; function inspectRoom(room) { return ROOM_ID.test(room.name); }"
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedRegexHelper,
    importedRegexNegativeConsumer,
  ]), expectedPolicies);
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
  const wildcardBarrelRoomHelper = {
    file: 'peer/wildcard-barrel-room.ts',
    text: 'export function validateGuildId(value) { return /^\\d{1,21}$/.test(value); }'
  };
  const wildcardBarrelRoom = {
    file: 'peer/wildcard-barrel.ts',
    text: "export * from './wildcard-barrel-room';"
  };
  const wildcardBarrelRoomConsumer = {
    file: 'peer/wildcard-barrel-consumer.ts',
    text: "import { validateGuildId } from './wildcard-barrel'; function validateRoom(room) { return validateGuildId(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    wildcardBarrelRoomHelper,
    wildcardBarrelRoom,
    wildcardBarrelRoomConsumer,
  ]), {
    ...expectedPolicies,
    'peer/wildcard-barrel-room.ts': 1
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
  const aliasedFunctionPropertyValidator = {
    file: 'peer/function-property-alias-validator.ts',
    text: "const validators = { validateGuildId: value => /^\\d{1,21}$/.test(value) }; const validateGuildId = validators.validateGuildId; function validateRoom(room) { return validateGuildId(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([...records, aliasedFunctionPropertyValidator]), {
    ...expectedPolicies,
    'peer/function-property-alias-validator.ts': 1
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
  const prototypeSearchRoomField = {
    file: 'peer/future-room.ts',
    text: 'function validateTownHallRoom(candidate) { const pattern = /^\\d{1,21}$/; return String.prototype.search.call(candidate.guildId, pattern) !== -1; }'
  };
  assert.deepEqual(roomDigitPolicies([...records, prototypeSearchRoomField]), {
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
  const identifierDefaultValidator = {
    file: 'peer/identifier-default-validator.ts',
    text: String.raw`function validateGuildId(value) { return /^\d{1,21}$/.test(value); }
    export default validateGuildId;`
  };
  const identifierDefaultConsumer = {
    file: 'peer/identifier-default-consumer.ts',
    text: String.raw`import validateGuildId from './identifier-default-validator';
    function validateRoom(room) { return validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    identifierDefaultValidator,
    identifierDefaultConsumer,
  ]), {
    ...expectedPolicies,
    'peer/identifier-default-validator.ts': 1
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
  assert.deepEqual(roomDigitPolicies([...records, splitNeutral]), expectedPolicies);
  const neutralSplitValidator = {
    file: 'peer/snowflake.ts',
    text: "function validate(value) { return /^\\d+$/.test(value) && value.length <= 20; } function inspect(room) { return validate(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([...records, neutralSplitValidator]), expectedPolicies);
  const splitAlias = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(room) {
    const value = room.channelId;
    return /^\d+$/.test(value) && value.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, splitAlias]), expectedPolicies);
  const splitCall = { file: 'peer/snowflake.ts', text: String.raw`function isSnowflake(value) {
    return /^\d+$/.test(value) && value.length <= 20;
  }
  function inspect(room) { return isSnowflake(room.guildId); }` };
  assert.deepEqual(roomDigitPolicies([...records, splitCall]), expectedPolicies);
  const splitCallAlias = {
    file: 'peer/snowflake.ts',
    text: "function isSnowflake(value) { return /^\\d+$/.test(value) && value.length <= 20; } function inspect(room) { const check = isSnowflake; return check(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([...records, splitCallAlias]), expectedPolicies);
  const bracketField = { file: 'peer/snowflake.ts', text: String.raw`function inspect(room) {
    return /^\d+$/.test(room['guildId']);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, bracketField]), expectedPolicies);
  const arrowBound = { file: 'peer/snowflake.ts', text: String.raw`const isDigits = value => /^\d+$/.test(value) && value.length <= 20;
  function inspect(room) { return isDigits(room.guildId); }` };
  assert.deepEqual(roomDigitPolicies([...records, arrowBound]), expectedPolicies);
  const anonymousBound = { file: 'peer/snowflake.ts', text: String.raw`const isDigits = function(value) {
    return /^\d+$/.test(value) && value.length <= 20;
  };
  function inspect(room) { return isDigits(room.channelId); }` };
  assert.deepEqual(roomDigitPolicies([...records, anonymousBound]), expectedPolicies);
  const shadowedBound = { file: 'peer/snowflake.ts', text: String.raw`const isDigits = value => /^\d+$/.test(value) && value.length <= 20;
  function inspect(room) { return isDigits(room.guildId); }
  function shadowed(room, isDigits) { return isDigits(room.guildId); }
  function unrelated(user, isDigits) { return isDigits(user.id); }
  function unrelatedHelper(user) {
    const isDigits = value => /^\d+$/.test(value) && value.length <= 20;
    return isDigits(user.id);
  }` };
  assert.deepEqual(roomDigitPolicies([...records, shadowedBound]), expectedPolicies);
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
  assert.deepEqual(roomDigitPolicies([...records, emptySplit]), expectedPolicies);
  const emptyAlias = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(room) {
    const value = room.channelId;
    return /^\d*$/.test(value) && value.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, emptyAlias]), expectedPolicies);
  const emptyCall = { file: 'peer/snowflake.ts', text: String.raw`function isSnowflake(value) {
    return /^\d*$/.test(value) && value.length <= 20;
  }
  function inspect(room) { return isSnowflake(room.channelId); }` };
  assert.deepEqual(roomDigitPolicies([...records, emptyCall]), expectedPolicies);
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
