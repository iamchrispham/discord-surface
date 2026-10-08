'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { countIdentifierReferences } = require('./policy-reference-analysis');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function createSourceFile(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    ts.getScriptKindFromFileName(file));
}

function finiteStringValues(expression, bindings, seen = new Set()) {
  const value = unwrapPolicyExpression(expression);
  if (!value) return null;
  if (ts.isStringLiteralLike(value)) return [value.text];
  if (ts.isArrayLiteralExpression(value)) {
    const values = value.elements.map(element =>
      ts.isStringLiteralLike(element) ? element.text : null);
    return values.every(item => item !== null) ? values : null;
  }
  if (!ts.isIdentifier(value)) return null;
  const declaration = resolveBinding(value, bindings);
  if (!declaration || seen.has(declaration)) return null;
  seen.add(declaration);
  if (ts.isParameter(declaration)) {
    const callback = declaration.parent;
    const everyCall = callback.parent;
    if (callback.parameters[0] !== declaration ||
        !ts.isCallExpression(everyCall) || everyCall.arguments[0] !== callback ||
        !ts.isPropertyAccessExpression(everyCall.expression) ||
        everyCall.expression.name.text !== 'every') {
      return null;
    }
    return finiteStringValues(everyCall.expression.expression, bindings, seen);
  }
  if (!ts.isVariableDeclaration(declaration)) return null;
  if (declaration.initializer) {
    const declarationList = declaration.parent;
    if (ts.isVariableDeclarationList(declarationList) &&
        !(declarationList.flags & ts.NodeFlags.Const)) return null;
    return finiteStringValues(declaration.initializer, bindings, seen);
  }
  const declarationList = declaration.parent;
  const loop = declarationList && ts.isVariableDeclarationList(declarationList)
    ? declarationList.parent
    : null;
  if (loop && ts.isForOfStatement(loop) && loop.initializer === declarationList &&
      (declarationList.flags & ts.NodeFlags.Const)) {
    return finiteStringValues(loop.expression, bindings, seen);
  }
  return null;
}

function isRoomField(node, bindings = null) {
  if (!node) return false;
  let object;
  let keys;
  if (ts.isPropertyAccessExpression(node)) {
    object = node.expression;
    keys = [node.name.text];
  } else if (ts.isElementAccessExpression(node) && node.argumentExpression &&
      (ts.isStringLiteralLike(node.argumentExpression) || ts.isIdentifier(node.argumentExpression))) {
    object = node.expression;
    keys = finiteStringValues(node.argumentExpression,
      bindings || collectBindings(node.getSourceFile()));
  } else {
    return false;
  }
  return Boolean(keys?.some(key => ['guildId', 'channelId'].includes(key)) &&
    ts.isIdentifier(object));
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

function nearestVariableScope(node) {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent;
  return current;
}

function variableDeclarationScope(node) {
  const declarationList = node.parent;
  if (ts.isVariableDeclarationList(declarationList) &&
      !(declarationList.flags & ts.NodeFlags.BlockScoped)) {
    return nearestVariableScope(node);
  }
  return nearestLexicalScope(node);
}

function collectBindings(sourceFile) {
  const bindings = [];
  const addPatternBindings = (pattern, declaration, scope) => {
    if (ts.isIdentifier(pattern)) {
      bindings.push({ declaration, name: pattern.text, scope });
      return;
    }
    if (!ts.isObjectBindingPattern(pattern) && !ts.isArrayBindingPattern(pattern)) return;
    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element)) continue;
      addPatternBindings(element.name, element, scope);
    }
  };
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
    if (declaration) {
      const scope = ts.isVariableDeclaration(declaration)
        ? variableDeclarationScope(declaration)
        : nearestLexicalScope(declaration);
      bindings.push({ declaration, name, scope });
    }
    if (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name)) {
      addPatternBindings(node.name, node, variableDeclarationScope(node));
    } else if (ts.isParameter(node) && !ts.isIdentifier(node.name)) {
      addPatternBindings(node.name, node, nearestLexicalScope(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
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
  if (ts.isVariableDeclaration(subjectBinding) &&
      matches(unwrapPolicyExpression(subjectBinding.initializer))) return true;
  let found = false;
  const visit = node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) && node.left.text === subject.text &&
        resolveBinding(node.left, bindings) === subjectBinding &&
        matches(unwrapPolicyExpression(node.right))) {
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

function isDescriptorRoomLookup(node) {
  return Boolean(node && ts.isCallExpression(node) && node.arguments.length === 2 &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Object' &&
    node.expression.name.text === 'getOwnPropertyDescriptor' &&
    ts.isStringLiteralLike(node.arguments[1]) && ['guildId', 'channelId'].includes(node.arguments[1].text));
}

function hasRoomFieldAlias(scope, subject, sourceFile, bindings) {
  return hasBoundAlias(scope, subject, sourceFile, bindings, isNamedRoomField);
}

function hasRoomKeyAlias(scope, subject, sourceFile, bindings) {
  return hasBoundAlias(scope, subject, sourceFile, bindings, isRoomKeyLookup);
}

function hasDescriptorRoomAlias(scope, subject, sourceFile, bindings) {
  if (!ts.isIdentifier(subject)) return false;
  const valueBinding = resolveBinding(subject, bindings);
  if (!valueBinding || !ts.isVariableDeclaration(valueBinding) ||
      !valueBinding.initializer || !ts.isPropertyAccessExpression(valueBinding.initializer) ||
      valueBinding.initializer.name.text !== 'value' ||
      !ts.isIdentifier(valueBinding.initializer.expression)) return false;
  const descriptorBinding = resolveBinding(valueBinding.initializer.expression, bindings);
  return Boolean(descriptorBinding && ts.isVariableDeclaration(descriptorBinding) &&
    isDescriptorRoomLookup(unwrapPolicyExpression(descriptorBinding.initializer)));
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

function isGenericRoomValidatorName(name) {
  return name === 'validateRoom';
}

function isRoomPolicyFile(sourceFile) {
  const fileName = sourceFile?.fileName || '';
  return /(?:room|town.?hall)/i.test(fileName) || /(?:^|[\\/])peer(?:[\\/]|$)/i.test(fileName);
}

function isTownHallContextName(name, sourceFile) {
  const fileName = sourceFile?.fileName || '';
  const neutralFile = /(?:ordinary|voice|snowflake)/i.test(fileName);
  return isTownHallName(name) ||
    (isGenericRoomValidatorName(name) && !neutralFile && isRoomPolicyFile(sourceFile));
}

function hasTownHallDeclarationContext(scope, sourceFile) {
  let current = scope;
  while (current) {
    const binding = ts.isFunctionLike(current) ? functionBinding(current) : null;
    if (binding && isTownHallContextName(bindingName(binding), sourceFile)) return true;
    if (current.name && ts.isIdentifier(current.name) &&
        isTownHallContextName(current.name.text, sourceFile)) return true;
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
      if (callerBinding && isTownHallContextName(bindingName(callerBinding), sourceFile)) found = true;
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

function hasDestructuredRoomParameter(subject, scope) {
  if (!ts.isIdentifier(subject) || !ts.isFunctionLike(scope)) return false;
  return scope.parameters.some(parameter => {
    if (!ts.isObjectBindingPattern(parameter.name)) return false;
    const containsRoomField = (pattern, roomContext, root = false) => pattern.elements.some(element => {
      if (!ts.isBindingElement(element)) return false;
      const key = element.propertyName || element.name;
      const keyText = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : null;
      if (ts.isIdentifier(element.name) && element.name.text === subject.text &&
          (root || roomContext) && ['guildId', 'channelId'].includes(keyText)) return true;
      if (!ts.isObjectBindingPattern(element.name)) return false;
      const nestedRoomContext = roomContext ||
        /^(?:room|townHall|townHallRoom)$/i.test(keyText || '');
      return nestedRoomContext && containsRoomField(element.name, nestedRoomContext);
    });
    return containsRoomField(parameter.name, false, true);
  });
}

function isNeutralRoomPolicy(scope) {
  const owner = functionBinding(scope);
  const ownerName = scope?.name && ts.isIdentifier(scope.name)
    ? scope.name.text
    : owner ? bindingName(owner) : null;
  return /snowflake/i.test(ownerName || '');
}

function roomFieldSubject(node, sourceFile, bindings) {
  const subject = regexInput(node);
  if (!subject) return false;
  const scope = enclosingFunction(node) || sourceFile;
  if (isNeutralRoomPolicy(scope)) return false;
  const townHallContext = isTownHallContext(scope, sourceFile, bindings);
  if (!townHallContext) return false;
  return isNamedRoomField(subject) ||
    hasRoomFieldAlias(scope, subject, sourceFile, bindings) ||
    isRoomField(subject, bindings) ||
    hasDestructuredRoomParameter(subject, scope) ||
    hasBoundAlias(scope, subject, sourceFile, bindings, isRoomField) ||
    hasRoomKeyAlias(scope, subject, sourceFile, bindings) ||
    hasRoomFieldCall(scope, sourceFile, bindings, isRoomField) ||
    hasRoomFieldCall(scope, sourceFile, bindings);
}

function isTownHallRoomOwner(node, sourceFile, bindings) {
  const scope = enclosingFunction(node);
  const owner = scope && functionBinding(scope);
  if (!owner || bindingName(owner) !== 'isTownHallRoom') return false;
  const subject = regexInput(node);
  return Boolean(subject && (hasRoomKeyAlias(scope, subject, sourceFile, bindings) ||
    hasDescriptorRoomAlias(scope, subject, sourceFile, bindings)));
}

function isSplitRoomDigitPolicy(node, sourceFile, pattern, bindings) {
  if (!hasAsciiDigitPattern(pattern) ||
      !/(?:\\[dD]|\[[^\]]+\])(?:\+|\*|\{\d+(?:,\d*)?\})/.test(pattern)) return false;
  const subject = regexInput(node);
  if (!subject) return false;
  const scope = enclosingFunction(node) || sourceFile;
  return roomFieldSubject(node, sourceFile, bindings) && hasSplitRoomLengthBound(scope, subject, sourceFile);
}

function hasAsciiDigitPattern(pattern) {
  if (/\\[dD]/.test(pattern)) return true;
  if (/\\p\{(?:Decimal_Number|Nd)\}/.test(pattern)) return true;
  const classes = pattern.match(/\[(?:\^)?([^\]]*)\]/g) || [];
  return classes.some(characterClass => {
    const body = characterClass.replace(/^\[\^?/, '').replace(/\]$/, '');
    return /[0-9]-[0-9]/.test(body) || /[0-9]{2,}/.test(body);
  });
}

function resolveStringValue(expression, bindings, seen = new Set(), resolveImport = null) {
  const value = unwrapPolicyExpression(expression);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (!ts.isIdentifier(value)) return null;
  const binding = resolveBinding(value, bindings);
  if (!binding) return resolveImport ? resolveImport(value, seen) : null;
  if (seen.has(binding)) return null;
  if (!binding.initializer) return null;
  seen.add(binding);
  return resolveStringValue(binding.initializer, bindings, seen, resolveImport);
}

function legacyRoomDigitPolicies(records, resolveImport = null) {
  const sites = {};
  for (const { file, text } of records) {
    const ast = createSourceFile(file, text);
    const bindings = collectBindings(ast);
    const visit = node => {
      let pattern = null;
      if (ts.isRegularExpressionLiteral(node)) pattern = node.text;
      else if ((ts.isNewExpression(node) || ts.isCallExpression(node)) &&
          ts.isIdentifier(node.expression) && node.expression.text === 'RegExp' &&
          node.arguments?.length) {
        pattern = resolveStringValue(node.arguments[0], bindings, new Set(),
          resolveImport ? (identifier, seen) => resolveImport(file, identifier, seen) : null);
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
      ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) ||
      (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(current)))) {
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
        const scope = variableDeclarationScope(node);
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
        let instance = false;
        if (ts.isObjectLiteralExpression(node.parent) && ts.isVariableDeclaration(owner) &&
            ts.isIdentifier(owner.name) &&
            (ts.isMethodDeclaration(node) || ts.isFunctionExpression(node.initializer) ||
              ts.isArrowFunction(node.initializer))) {
          key = `${owner.name.text}.${property}`;
          ownerDeclaration = owner;
        } else if (ts.isClassDeclaration(node.parent) && node.parent.name &&
            ts.isMethodDeclaration(node)) {
          key = `${node.parent.name.text}.${property}`;
          ownerDeclaration = node.parent;
          instance = !node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword);
        }
        if (key) {
          const fn = {
            info,
            node: ts.isPropertyAssignment(node) ? node.initializer : node,
            name: key,
            ownerDeclaration,
            instance,
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
          info.bindings.push({
            name: node.importClause.name.text,
            kind: 'import',
            declaration: node.importClause.name,
            scope: info.ast,
            specifier,
            imported: 'default',
          });
        }
        if (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          for (const element of node.importClause.namedBindings.elements) {
            info.imports.set(element.name.text, {
              specifier,
              imported: element.propertyName?.text || element.name.text,
            });
            info.bindings.push({
              name: element.name.text,
              kind: 'import',
              declaration: element.name,
              scope: info.ast,
              specifier,
              imported: element.propertyName?.text || element.name.text,
            });
          }
        }
        if (node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) {
          const name = node.importClause.namedBindings.name.text;
          info.imports.set(name, { specifier, namespace: true });
          info.bindings.push({
            name,
            kind: 'namespace-import',
            declaration: node.importClause.namedBindings.name,
            scope: info.ast,
            specifier,
          });
        }
      }
      ts.forEachChild(node, importVisit);
    };
    importVisit(info.ast);

    const commonJsImport = node => {
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteralLike(node.moduleReference.expression)
      ) {
        const name = node.name.text;
        const specifier = node.moduleReference.expression.text;
        info.imports.set(name, { specifier, imported: 'default', commonJs: true });
        info.bindings.push({
          name,
          kind: 'commonjs-import',
          declaration: node.name,
          scope: variableDeclarationScope(node),
          specifier,
          imported: 'default',
        });
      }
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
            info.bindings.push({
              name: declaration.name.text,
              kind: 'commonjs-import',
              declaration: declaration.name,
              scope: variableDeclarationScope(declaration),
              source: initializer,
              specifier,
              imported,
            });
          } else if (ts.isObjectBindingPattern(declaration.name)) {
            for (const element of declaration.name.elements) {
              if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
              const propertyName = element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text;
              info.imports.set(element.name.text, { specifier, imported: propertyName, commonJs: true });
              info.bindings.push({
                name: element.name.text,
                kind: 'commonjs-import',
                declaration: element.name,
                scope: variableDeclarationScope(declaration),
                source: initializer,
                specifier,
                imported: propertyName,
              });
            }
          }
        }
      }
      ts.forEachChild(node, commonJsImport);
    };
    commonJsImport(info.ast);

    const commonJsPropertyKey = expression => {
      if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
      if (ts.isElementAccessExpression(expression) && expression.argumentExpression &&
          ts.isStringLiteralLike(expression.argumentExpression)) {
        return expression.argumentExpression.text;
      }
      return null;
    };
    const commonJsExportTarget = expression => {
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
    const regexBindings = collectBindings(info.ast);
    const regexExpression = expression => {
      const value = unwrapPolicyExpression(expression);
      if (ts.isRegularExpressionLiteral(value)) return { node: value, pattern: value.text };
      if ((ts.isNewExpression(value) || ts.isCallExpression(value)) &&
          ts.isIdentifier(value.expression) && value.expression.text === 'RegExp' &&
          value.arguments?.length) {
        const pattern = resolveStringValue(value.arguments[0], regexBindings);
        if (pattern !== null) return { node: value, pattern };
      }
      return null;
    };
    const indexCommonJsRegex = (exportName, expression) => {
      const regex = regexExpression(expression);
      if (regex) info.exports.set(exportName, { kind: 'regex', ...regex });
    };
    const commonJsExportVisit = node => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const target = commonJsExportTarget(node.left);
        if (target && ts.isIdentifier(node.right)) {
          info.exports.set(target, node.right.text);
        } else if (target && regexExpression(node.right)) {
          indexCommonJsRegex(target, node.right);
        } else if (target === 'default' && ts.isCallExpression(node.right) &&
            ts.isIdentifier(node.right.expression) && node.right.expression.text === 'require' &&
            node.right.arguments.length === 1 && ts.isStringLiteralLike(node.right.arguments[0])) {
          const specifier = node.right.arguments[0].text;
          info.exports.set('default', { kind: 'reexport', specifier, imported: 'default' });
          if (!info.starExports.includes(specifier)) info.starExports.push(specifier);
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
            } else if (ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
                regexExpression(property.initializer)) {
              indexCommonJsRegex(property.name.text, property.initializer);
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
        } else if (regexExpression(statement.expression)) {
          indexCommonJsRegex('default', statement.expression);
        } else if (statement.isExportEquals && ts.isIdentifier(statement.expression)) {
          info.exports.set('default', statement.expression.text);
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
            } else if (ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
                regexExpression(property.initializer)) {
              indexCommonJsRegex(property.name.text, property.initializer);
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
    const sourceCandidates = [];
    const extension = path.posix.extname(base);
    const sourceExtension = {
      '.js': '.ts',
      '.cjs': '.cts',
      '.mjs': '.mts',
    }[extension];
    sourceCandidates.push(
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
    );
    if (sourceExtension) {
      sourceCandidates.unshift(base.slice(0, -extension.length) + sourceExtension);
    }
    for (const candidate of sourceCandidates) {
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
    const local = info.functions.get(localName);
    if (local) return local;
    const alias = info.bindings.find(binding => binding.name === localName &&
      binding.kind === 'value' && binding.source && ts.isIdentifier(binding.source));
    return alias ? resolveExportedFunction(info, alias.source.text, seen) : null;
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
        (ts.isIdentifier(expression.expression) || ts.isNewExpression(expression.expression) ||
          (ts.isCallExpression(expression.expression) && ts.isIdentifier(expression.expression.expression)))) {
      const property = policyPropertyKey(expression);
      if (!property) return null;
      let receiverName = null;
      let receiverBinding = null;
      let receiverClass = null;
      if (ts.isIdentifier(expression.expression)) {
        receiverName = expression.expression.text;
        receiverBinding = findBinding(info, receiverName, expression.expression);
        if (receiverBinding?.source && ts.isNewExpression(receiverBinding.source) &&
            ts.isIdentifier(receiverBinding.source.expression)) {
          receiverClass = receiverBinding.source.expression.text;
        }
      } else if (ts.isNewExpression(expression.expression) &&
          ts.isIdentifier(expression.expression.expression)) {
        receiverClass = expression.expression.expression.text;
      }
      if (receiverClass) {
        const localMethods = info.objectMethods.get(`${receiverClass}.${property}`) || [];
        const localMethod = localMethods
          .filter(method => method.instance &&
            (!receiverBinding || method.ownerDeclaration === receiverBinding.declaration ||
              method.ownerDeclaration?.name?.text === receiverClass))
          .sort((left, right) =>
            scopeDepth(nearestLexicalScope(right.node)) - scopeDepth(nearestLexicalScope(left.node)))[0];
        if (localMethod) return localMethod;
      }
      if (receiverName) {
        const key = receiverName + '.' + property;
        const localMethods = info.objectMethods.get(key) || [];
        const localMethod = localMethods
          .filter(method => !method.instance &&
            (!receiverBinding || method.ownerDeclaration === receiverBinding.declaration))
          .sort((left, right) =>
            scopeDepth(nearestLexicalScope(right.node)) - scopeDepth(nearestLexicalScope(left.node)))[0];
        if (localMethod) return localMethod;
        const imported = info.imports.get(receiverName);
        const importBinding = receiverBinding?.kind;
        if (imported && (!receiverBinding || importBinding === 'namespace-import' ||
            importBinding === 'commonjs-import' || imported.imported === 'default')) {
          const target = resolveModule(info, imported.specifier);
          return target ? resolveExportedFunction(target, property) : null;
        }
      }
      if (ts.isCallExpression(expression.expression) &&
          ts.isIdentifier(expression.expression.expression) &&
          expression.expression.expression.text === 'require' &&
          expression.expression.arguments.length === 1 &&
          ts.isStringLiteralLike(expression.expression.arguments[0])) {
        const target = resolveModule(info, expression.expression.arguments[0].text);
        return target ? resolveExportedFunction(target, property) : null;
      }
    }
    return null;
  };
  for (const info of infos) {
    const visit = node => {
      if (ts.isCallExpression(node)) {
        const callMethod = ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'call';
        const callReceiver = callMethod ? resolveFunction(info, node.expression.expression) : null;
        const fn = callReceiver || resolveFunction(info, node.expression);
        const args = callReceiver ? node.arguments.slice(1) : node.arguments;
        if (fn) fn.calls.push({ info, args, node });
      }
      ts.forEachChild(node, visit);
    };
    visit(info.ast);
  }

  function findBinding(info, name, node) {
    const bindings = info.bindings.filter(binding => binding.name === name &&
      (!binding.scope || isAncestor(binding.scope, node) || binding.scope === node));
    const priority = binding => ['import', 'namespace-import', 'commonjs-import'].includes(binding.kind) ? 1 : 0;
    bindings.sort((left, right) =>
      scopeDepth(right.scope) - scopeDepth(left.scope) || priority(right) - priority(left));
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
    if (ts.isConditionalExpression(expression)) {
      return expressionIsRoomField(expression.whenTrue, info, new Set(seen)) &&
        expressionIsRoomField(expression.whenFalse, info, new Set(seen));
    }
    if (ts.isCallExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        ['String', 'Number', 'BigInt'].includes(expression.expression.text) &&
        expression.arguments.length === 1) {
      return expressionIsRoomField(expression.arguments[0], info, seen);
    }
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
  const hasContextualParameterCall = (binding) => {
    if (!binding || binding.kind !== 'parameter') return false;
    return bindingCalls(binding, binding.ownerInfo).some(call => {
      const caller = call.node && enclosingFunction(call.node);
      const callerBinding = caller && functionBinding(caller);
      const callerName = callerBinding ? bindingName(callerBinding) : null;
      return isTownHallContextName(callerName, call.info.ast) &&
        call.args[binding.index] && expressionIsRoomField(call.args[binding.index], call.info);
    });
  };
  const regexInputs = (node, info) => {
    const inputs = [];
    const direct = regexInput(node);
    if (direct) inputs.push(direct);
    const collectMatcherInputs = reference => {
      let current = reference;
      while (current.parent) {
        const parent = current.parent;
        if (ts.isCallExpression(parent)) {
          const argumentIndex = parent.arguments.findIndex(argument =>
            argument === reference || isAncestor(argument, reference));
          if (argumentIndex !== -1) {
            const matcher = resolveFunction(info, parent.expression);
            if (!matcher || matcher.info !== info) {
              current = parent;
              continue;
            }
            const parameter = matcher.node.parameters[argumentIndex];
            if (!parameter || !ts.isIdentifier(parameter.name) || !matcher.node.body) return;
            const binding = findBinding(matcher.info, parameter.name.text, parameter.name);
            if (!binding || binding.kind !== 'parameter') return;
            const visitMatcher = candidate => {
              if (ts.isIdentifier(candidate) && candidate.text === parameter.name.text &&
                  findBinding(matcher.info, candidate.text, candidate) === binding) {
                const input = regexInput(candidate);
                if (input) inputs.push(input);
              }
              ts.forEachChild(candidate, visitMatcher);
            };
            visitMatcher(matcher.node.body);
            return;
          }
        }
        current = parent;
      }
    };
    collectMatcherInputs(node);
    let propertyAssignment = node.parent;
    while (propertyAssignment &&
        (ts.isParenthesizedExpression(propertyAssignment) || ts.isAsExpression(propertyAssignment) ||
          ts.isTypeAssertionExpression(propertyAssignment) || ts.isNonNullExpression(propertyAssignment) ||
          (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(propertyAssignment)))) {
      propertyAssignment = propertyAssignment.parent;
    }
    propertyAssignment = propertyAssignment && ts.isPropertyAssignment(propertyAssignment) &&
      isAncestor(propertyAssignment.initializer, node) ? propertyAssignment : null;
    const objectLiteral = propertyAssignment?.parent && ts.isObjectLiteralExpression(propertyAssignment.parent)
      ? propertyAssignment.parent
      : null;
    const objectDeclaration = objectLiteral?.parent && ts.isVariableDeclaration(objectLiteral.parent) &&
      objectLiteral.parent.initializer === objectLiteral && ts.isIdentifier(objectLiteral.parent.name)
      ? objectLiteral.parent
      : null;
    if (propertyAssignment && objectDeclaration &&
        (ts.isIdentifier(propertyAssignment.name) || ts.isStringLiteralLike(propertyAssignment.name))) {
      const ownerName = objectDeclaration.name.text;
      const propertyName = propertyAssignment.name.text;
      const visitObject = current => {
        if (ts.isIdentifier(current) && current.text === ownerName && current !== objectDeclaration.name &&
            findBinding(info, ownerName, current)?.declaration === objectDeclaration) {
          const member = current.parent;
          if ((ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) &&
              member.expression === current && policyPropertyKey(member) === propertyName) {
            const input = regexInput(member);
            if (input) inputs.push(input);
          }
        }
        ts.forEachChild(current, visitObject);
      };
      visitObject(info.ast);
    }
    let classProperty = node.parent;
    while (classProperty &&
        (ts.isParenthesizedExpression(classProperty) || ts.isAsExpression(classProperty) ||
          ts.isTypeAssertionExpression(classProperty) || ts.isNonNullExpression(classProperty) ||
          (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(classProperty)))) {
      classProperty = classProperty.parent;
    }
    classProperty = classProperty && ts.isPropertyDeclaration(classProperty) &&
      isAncestor(classProperty.initializer, node) ? classProperty : null;
    const classDeclaration = classProperty?.parent && ts.isClassDeclaration(classProperty.parent)
      ? classProperty.parent
      : null;
    if (classProperty && classDeclaration?.name && ts.isIdentifier(classDeclaration.name) &&
        classProperty.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) &&
        (ts.isIdentifier(classProperty.name) || ts.isStringLiteralLike(classProperty.name))) {
      const ownerName = classDeclaration.name.text;
      const propertyName = classProperty.name.text;
      const classBindings = collectBindings(info.ast);
      const visitClass = current => {
        if (ts.isIdentifier(current) && current.text === ownerName && current !== classDeclaration.name &&
            resolveBinding(current, classBindings) === classDeclaration) {
          const member = current.parent;
          if ((ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) &&
              member.expression === current && policyPropertyKey(member) === propertyName) {
            const input = regexInput(member);
            if (input) inputs.push(input);
          }
        }
        ts.forEachChild(current, visitClass);
      };
      visitClass(info.ast);
    }
    let declaration = node.parent;
    while (declaration && !ts.isVariableDeclaration(declaration) && declaration.parent) {
      declaration = declaration.parent;
    }
    declaration = declaration && ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) && isAncestor(declaration.initializer, node) ? declaration : null;
    if (!declaration) return inputs;
    const seenDeclarations = new Set();
    const collectDeclarationInputs = currentDeclaration => {
      if (seenDeclarations.has(currentDeclaration)) return;
      seenDeclarations.add(currentDeclaration);
      const name = currentDeclaration.name.text;
      const visit = current => {
        if (ts.isIdentifier(current) && current.text === name && current !== currentDeclaration.name &&
            findBinding(info, name, current)?.declaration === currentDeclaration) {
          collectMatcherInputs(current);
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
    const seenDeclarations = new Set();
    function collectReferenceInputs(reference) {
      const parent = reference.parent;
      if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
          parent.expression === reference &&
          ['test', 'exec'].includes(callPropertyName(parent)) && ts.isCallExpression(parent.parent)) {
        if (parent.parent.arguments[0]) inputs.push(parent.parent.arguments[0]);
      } else if (ts.isCallExpression(parent) && parent.arguments[0] === reference &&
          ['match', 'search'].includes(callPropertyName(parent.expression))) {
        inputs.push(parent.expression.expression);
      } else if (ts.isCallExpression(parent) && parent.arguments[1] === reference &&
          ts.isPropertyAccessExpression(parent.expression) &&
          parent.expression.name.text === 'call' &&
          callPropertyName(parent.expression.expression) === 'search' && parent.arguments[0]) {
        inputs.push(parent.arguments[0]);
      } else if (ts.isVariableDeclaration(parent) && parent.initializer === reference &&
          ts.isIdentifier(parent.name) &&
          findBinding(info, parent.name.text, parent)?.declaration === parent) {
        collectDeclarationInputs(parent);
      }
    }
    function collectDeclarationInputs(declaration) {
      if (seenDeclarations.has(declaration)) return;
      seenDeclarations.add(declaration);
      const name = declaration.name.text;
      const visitDeclaration = node => {
        if (ts.isIdentifier(node) && node.text === name && node !== declaration.name &&
            findBinding(info, name, node)?.declaration === declaration) {
          collectReferenceInputs(node);
        }
        ts.forEachChild(node, visitDeclaration);
      };
      visitDeclaration(info.ast);
    }
    const visit = node => {
      if (ts.isIdentifier(node) && node.text === localName) {
        const binding = findBinding(info, localName, node);
        const importedBinding = binding &&
          (binding.kind === 'import' || binding.kind === 'commonjs-import') &&
          binding.imported === imported.imported && binding.specifier === imported.specifier;
        if (importedBinding) {
          collectReferenceInputs(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(info.ast);
    return inputs;
  };

  const namespaceRegexInputs = (info, namespaceName) => {
    const inputs = [];
    const visit = node => {
      if (ts.isIdentifier(node) && node.text === namespaceName) {
        const binding = findBinding(info, namespaceName, node);
        const isDefaultImport = binding?.kind === 'import' && binding.imported === 'default';
        const isCommonJsNamespace = binding?.kind === 'commonjs-import' &&
          binding.imported === 'default';
        if (!binding || (binding.kind !== 'namespace-import' && !isDefaultImport && !isCommonJsNamespace)) {
          ts.forEachChild(node, visit);
          return;
        }
        const member = node.parent;
        if ((ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) &&
            member.expression === node) {
          const importedName = policyPropertyKey(member);
          const input = importedName && regexInput(member);
          if (input) inputs.push({ importedName, input });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(info.ast);
    return inputs;
  };

  const resolveRegexValue = (info, expression, name, seen = new Set()) => {
    const value = unwrapPolicyExpression(expression);
    if (!value) return null;
    if (ts.isRegularExpressionLiteral(value)) {
      let declaration = value.parent;
      while (declaration && !ts.isVariableDeclaration(declaration) && declaration.parent) {
        declaration = declaration.parent;
      }
      return { info, name, declaration: declaration || value, pattern: value.text };
    }
    if ((ts.isNewExpression(value) || ts.isCallExpression(value)) &&
        ts.isIdentifier(value.expression) && value.expression.text === 'RegExp' &&
        value.arguments?.length && ts.isStringLiteralLike(value.arguments[0])) {
      let declaration = value.parent;
      while (declaration && !ts.isVariableDeclaration(declaration) && declaration.parent) {
        declaration = declaration.parent;
      }
      return { info, name, declaration: declaration || value, pattern: value.arguments[0].text };
    }
    if (ts.isIdentifier(value)) {
      const binding = findBinding(info, value.text, value);
      if (binding?.declaration && ts.isVariableDeclaration(binding.declaration) &&
          binding.declaration.initializer && !seen.has(binding.declaration)) {
        seen.add(binding.declaration);
        return resolveRegexValue(info, binding.declaration.initializer, name, seen);
      }
      return null;
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const property = policyPropertyKey(value);
      const owner = value.expression;
      if (!property || !ts.isIdentifier(owner)) return null;
      const ownerBinding = findBinding(info, owner.text, owner);
      const initializer = ownerBinding?.declaration?.initializer;
      const object = unwrapPolicyExpression(initializer);
      if (!object || !ts.isObjectLiteralExpression(object)) return null;
      const propertyNode = object.properties.find(candidate => {
        if (!ts.isPropertyAssignment(candidate) && !ts.isMethodDeclaration(candidate)) return false;
        const key = candidate.name;
        return (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === property;
      });
      if (!propertyNode || !ts.isPropertyAssignment(propertyNode)) return null;
      return resolveRegexValue(info, propertyNode.initializer, name, seen);
    }
    return null;
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
      if (exported.kind === 'regex') return { ...exported, info, name };
      return null;
    }
    for (const specifier of info.starExports) {
      const target = resolveModule(info, specifier);
      const resolved = target ? resolveRegexExport(target, name, seen) : null;
      if (resolved) return resolved;
    }
    const localName = typeof exported === 'string' ? exported : name;
    const binding = findBinding(info, localName, info.ast);
    if (binding?.declaration && ts.isVariableDeclaration(binding.declaration) &&
        binding.declaration.initializer) {
      return resolveRegexValue(info, binding.declaration.initializer, name);
    }
    let result = null;
    const visit = node => {
      if (result || !ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) ||
          node.name.text !== localName || !node.initializer) {
        ts.forEachChild(node, visit);
        return;
      }
      result = resolveRegexValue(info, node.initializer, name);
      ts.forEachChild(node, visit);
    };
    visit(info.ast);
    return result;
  };

  function resolveStringExport(info, name, seen = new Set()) {
    const marker = `${info.file}\u0000${name}`;
    if (seen.has(marker)) return null;
    seen.add(marker);
    const exported = info.exports.get(name);
    if (exported && typeof exported === 'object') {
      if (exported.kind === 'reexport') {
        const target = resolveModule(info, exported.specifier);
        return target ? resolveStringExport(target, exported.imported, seen) : null;
      }
      return null;
    }
    const localName = typeof exported === 'string' ? exported : name;
    let declaration = findBinding(info, localName, info.ast)?.declaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
      declaration = null;
      const visit = node => {
        if (declaration || !ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) ||
            node.name.text !== localName || !node.initializer) {
          ts.forEachChild(node, visit);
          return;
        }
        declaration = node;
      };
      visit(info.ast);
    }
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return null;
    return resolveStringValue(declaration.initializer, collectBindings(info.ast), seen,
      (identifier, nestedSeen) => resolveImportedString(info, identifier, nestedSeen));
  }

  function resolveImportedString(info, identifier, seen) {
    const imported = info.imports.get(identifier.text);
    if (!imported || imported.namespace || !imported.specifier || !imported.imported) return null;
    const target = resolveModule(info, imported.specifier);
    return target ? resolveStringExport(target, imported.imported, seen) : null;
  }

  const sites = legacyRoomDigitPolicies(records, (file, identifier, seen) => {
    const info = byFile.get(file);
    return info ? resolveImportedString(info, identifier, seen) : null;
  });
  for (const info of infos) {
    const legacyBindings = collectBindings(info.ast);
    const visit = node => {
      let pattern = null;
      if (ts.isRegularExpressionLiteral(node)) pattern = node.text;
      else if ((ts.isNewExpression(node) || ts.isCallExpression(node)) &&
          ts.isIdentifier(node.expression) && node.expression.text === 'RegExp' &&
          node.arguments?.length) {
        pattern = resolveStringValue(node.arguments[0], legacyBindings, new Set(),
          (identifier, seen) => resolveImportedString(info, identifier, seen));
      }
      if (pattern !== null && hasAsciiDigitPattern(pattern)) {
        const legacyPolicy = isTownHallRoomOwner(node, info.ast, legacyBindings) ||
          roomFieldSubject(node, info.ast, legacyBindings) ||
          isSplitRoomDigitPolicy(node, info.ast, pattern, legacyBindings);
        const isRoomInput = input => {
          const inputScope = enclosingFunction(input) || info.ast;
          const roomContext = isTownHallContext(inputScope, info.ast, legacyBindings);
          if (isNeutralRoomPolicy(inputScope)) return false;
          if (roomContext && (expressionIsRoomField(input, info) || isRoomField(input, legacyBindings))) return true;
          const binding = ts.isIdentifier(input) && findBinding(info, input.text, input);
          return Boolean(!roomContext && hasContextualParameterCall(binding));
        };
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
    const consumerBindings = collectBindings(consumer.ast);
    for (const [localName, imported] of consumer.imports) {
      const defaultImport = imported.imported === 'default';
      const references = imported.namespace
        ? namespaceRegexInputs(consumer, localName)
        : defaultImport
          ? [
            ...importedRegexInputs(consumer, localName, imported)
              .map(input => ({ importedName: imported.imported, input })),
            ...namespaceRegexInputs(consumer, localName),
          ]
          : importedRegexInputs(consumer, localName, imported)
            .map(input => ({ importedName: imported.imported, input }));
      for (const { importedName, input } of references) {
        const target = resolveModule(consumer, imported.specifier);
        const resolved = target && resolveRegexExport(target, importedName);
        if (!resolved || !hasAsciiDigitPattern(resolved.pattern)) continue;
        const scope = enclosingFunction(input) || consumer.ast;
        const binding = ts.isIdentifier(input) && findBinding(consumer, input.text, input);
        const roomContext = isTownHallContext(scope, consumer.ast, consumerBindings) ||
          hasContextualParameterCall(binding);
        if (isNeutralRoomPolicy(scope) || !roomContext || !expressionIsRoomField(input, consumer)) continue;
        const key = `${resolved.info.file}\u0000${resolved.declaration?.pos ?? resolved.pattern}`;
        const localInputs = resolved.declaration && ts.isVariableDeclaration(resolved.declaration)
          ? regexInputs(resolved.declaration.initializer, resolved.info)
          : [];
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
  }
  return sites;
}

test('room policy inventory records only town-hall room validators', () => {
  const src = path.join(PROJECT_ROOT, 'src');
  const references = {};
  const records = [];
  const sourceFiles = [];
  for (const relative of fs.readdirSync(src, { recursive: true })) {
    if (!/\.(?:[cm]?[tj]s)$/.test(relative)) continue;
    const text = fs.readFileSync(path.join(src, relative), 'utf8');
    const file = relative.split(path.sep).join('/');
    records.push({ file, text });
    sourceFiles.push({ file, ast: createSourceFile(file, text) });
  }
  const sourceAsts = sourceFiles.map(source => source.ast);
  for (const { file, ast } of sourceFiles) {
    const count = countIdentifierReferences(ast, 'isTownHallRoom', sourceAsts);
    if (count) references[file] = count;
  }
  assert.deepEqual(references, { 'peer/town-hall-plan.ts': 1, 'peer/town-hall-room-identity.ts': 1 });
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
  const exportedReferenceFixture = ts.createSourceFile('peer/exported-reference-fixture.ts', String.raw`export function isTownHallRoom(room) { return room; }
  function unrelated() { function isTownHallRoom(room) { return room; } return isTownHallRoom({}); }
  isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(exportedReferenceFixture, 'isTownHallRoom'), 1);
  const importedReferenceFixture = ts.createSourceFile('peer/imported-reference-fixture.ts', String.raw`import { isTownHallRoom } from './town-hall-plan';
  isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(importedReferenceFixture, 'isTownHallRoom'), 1);
  const aliasedImportedReferenceFixture = ts.createSourceFile('peer/aliased-imported-reference-fixture.ts', String.raw`import { isTownHallRoom as roomGuard } from './town-hall-plan';
  roomGuard({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(aliasedImportedReferenceFixture, 'isTownHallRoom'), 1);
  const unrelatedNamedReferenceFixture = ts.createSourceFile('peer/unrelated-named-reference-fixture.ts', String.raw`import { isTownHallRoom } from './voice-room';
  isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(unrelatedNamedReferenceFixture, 'isTownHallRoom'), 0);
  const unrelatedNamespaceReferenceFixture = ts.createSourceFile('peer/unrelated-namespace-reference-fixture.ts', String.raw`import * as voiceRoom from './voice-room';
  voiceRoom.isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(unrelatedNamespaceReferenceFixture, 'isTownHallRoom'), 0);
  const unrelatedDirectRequireReferenceFixture = ts.createSourceFile('peer/unrelated-direct-require-reference-fixture.cjs', String.raw`require('./voice-room').isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(unrelatedDirectRequireReferenceFixture, 'isTownHallRoom'), 0);
  const commonJsNamedReferenceFixture = ts.createSourceFile('peer/commonjs-named-reference-fixture.cjs', String.raw`const { isTownHallRoom: roomGuard } = require('./town-hall-plan');
  roomGuard({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(commonJsNamedReferenceFixture, 'isTownHallRoom'), 1);
  const commonJsNamespaceReferenceFixture = ts.createSourceFile('peer/commonjs-namespace-reference-fixture.cjs', String.raw`const plan = require('./town-hall-plan');
  plan.isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(commonJsNamespaceReferenceFixture, 'isTownHallRoom'), 1);
  const importEqualsNamespaceReferenceFixture = ts.createSourceFile('peer/import-equals-namespace-reference-fixture.cts', String.raw`import plan = require('./town-hall-plan.cjs');
  plan.isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(importEqualsNamespaceReferenceFixture, 'isTownHallRoom'), 1);
  const destructuredShadowReferenceFixture = ts.createSourceFile('peer/destructured-shadow-reference-fixture.ts', String.raw`export function isTownHallRoom(room) { return room; }
  function parameterShadow({ isTownHallRoom }) { return isTownHallRoom({}); }
  function localShadow() {
    const { isTownHallRoom: guard = () => false } = { isTownHallRoom: () => true };
    const { nested: { isTownHallRoom: nestedGuard }, ...rest } = { nested: { isTownHallRoom: () => true } };
    return guard({}) || nestedGuard({}) || rest.isTownHallRoom;
  }
  isTownHallRoom({});`, ts.ScriptTarget.Latest, true);
  assert.equal(countIdentifierReferences(destructuredShadowReferenceFixture, 'isTownHallRoom'), 1);
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
    text: String.raw`const validateGuildId = value => /^\d{1,21}$/.test(value);
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
  const mappedRuntimeCtsHelper = {
    file: 'peer/runtime-extension-room-helper.cts',
    text: String.raw`export default function validateGuildId(value) { return /^\d{1,21}$/.test(value); }`
  };
  const mappedRuntimeCjsConsumer = {
    file: 'peer/runtime-extension-room-consumer.cjs',
    text: String.raw`const validateGuildId = require('./runtime-extension-room-helper.cjs');
    function validateRoom(room) { return validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    mappedRuntimeCtsHelper,
    mappedRuntimeCjsConsumer,
  ]), {
    ...expectedPolicies,
    'peer/runtime-extension-room-helper.cts': 1
  });
  const mappedRuntimeCjsNegativeConsumer = {
    file: 'peer/runtime-extension-room-negative-consumer.cjs',
    text: String.raw`const validateGuildId = require('./runtime-extension-room-helper.cjs');
    function inspectRoom(room) { return validateGuildId(room.name); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    mappedRuntimeCtsHelper,
    mappedRuntimeCjsNegativeConsumer,
  ]), expectedPolicies);
  const extensionMtsGuardHelper = {
    file: 'peer/runtime-extension-mts-helper.mts',
    text: String.raw`export default function validateGuildId(value) { return /^\d{1,21}$/.test(value); }`
  };
  const extensionMjsGuardConsumer = {
    file: 'peer/runtime-extension-mjs-consumer.mjs',
    text: String.raw`import validateGuildId from './runtime-extension-mts-helper.mjs';
    function validateRoom(room) { return validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    extensionMtsGuardHelper,
    extensionMjsGuardConsumer,
  ]), {
    ...expectedPolicies,
    [extensionMtsGuardHelper.file]: 1
  });
  const extensionMjsNegativeConsumer = {
    file: 'peer/runtime-extension-mjs-negative-consumer.mjs',
    text: String.raw`import validateGuildId from './runtime-extension-mts-helper.mjs';
    function inspectRoom(room) { return validateGuildId(room.name); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    extensionMtsGuardHelper,
    extensionMjsNegativeConsumer,
  ]), expectedPolicies);
  const mappedRuntimeJsRoomHelper = {
    file: 'peer/runtime-js-room-helper.ts',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;`,
  };
  const mappedRuntimeJsRoomConsumer = {
    file: 'peer/runtime-js-room-consumer.ts',
    text: String.raw`import { ROOM_ID } from './runtime-js-room-helper.js';
    function validateTownHallRoom(room) { return ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    mappedRuntimeJsRoomHelper,
    mappedRuntimeJsRoomConsumer,
  ]), {
    ...expectedPolicies,
    'peer/runtime-js-room-helper.ts': 1,
  });
  const mappedRuntimeJsVoiceConsumer = {
    file: 'peer/runtime-js-room-voice-consumer.ts',
    text: String.raw`import { ROOM_ID } from './runtime-js-room-helper.js';
    function validateVoiceRoom(room) { return ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    mappedRuntimeJsRoomHelper,
    mappedRuntimeJsVoiceConsumer,
  ]), expectedPolicies);
  const mappedRuntimeMtsHelper = {
    file: 'peer/runtime-extension-room-helper.mts',
    text: String.raw`export function validateChannelId(value) { return /^\d{1,21}$/.test(value); }`
  };
  const mappedRuntimeMjsConsumer = {
    file: 'peer/runtime-extension-room-consumer.mjs',
    text: String.raw`import { validateChannelId } from './runtime-extension-room-helper.mjs';
    function validateRoom(room) { return validateChannelId(room.channelId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    mappedRuntimeMtsHelper,
    mappedRuntimeMjsConsumer,
  ]), {
    ...expectedPolicies,
    'peer/runtime-extension-room-helper.mts': 1
  });
  const mappedRuntimeMjsNegativeConsumer = {
    file: 'peer/runtime-extension-room-negative-consumer.mjs',
    text: String.raw`import { validateChannelId } from './runtime-extension-room-helper.mjs';
    function inspectRoom(room) { return validateChannelId(room.name); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    mappedRuntimeMtsHelper,
    mappedRuntimeMjsNegativeConsumer,
  ]), expectedPolicies);
  const exportEqualsAliasHelper = {
    file: 'peer/export-equals-room-alias-helper.cts',
    text: String.raw`const actual = value => /^\d{1,21}$/.test(value);
    const exported = actual;
    export = exported;`
  };
  const exportEqualsAliasConsumer = {
    file: 'peer/export-equals-room-alias-consumer.cts',
    text: String.raw`const validateGuildId = require('./export-equals-room-alias-helper');
    function validateRoom(room) { return validateGuildId(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    exportEqualsAliasHelper,
    exportEqualsAliasConsumer,
  ]), {
    ...expectedPolicies,
    'peer/export-equals-room-alias-helper.cts': 1
  });
  const inlineCommonJsObjectHelper = {
    file: 'peer/inline-commonjs-room-helper.cjs',
    text: String.raw`module.exports = {
      validateGuildId(value) { return /^\d{1,21}$/.test(value); },
      validateChannelId: function validateChannelId(value) { return /^\d{1,21}$/.test(value); },
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
  const reviewBracketedCommonJsHelper = {
    file: 'peer/bracketed-commonjs-room-helper.js',
    text: String.raw`exports['validateGuildId'] = value => /^\d{1,21}$/.test(value);
    module.exports['validateChannelId'] = value => /^\d{1,21}$/.test(value);`
  };
  const reviewBracketedCommonJsConsumer = {
    file: 'peer/bracketed-commonjs-room-consumer.js',
    text: String.raw`const { validateGuildId, validateChannelId } = require('./bracketed-commonjs-room-helper');
    function validateRoom(room) {
      return validateGuildId(room.guildId) && validateChannelId(room.channelId);
    }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    reviewBracketedCommonJsHelper,
    reviewBracketedCommonJsConsumer,
  ]), {
    ...expectedPolicies,
    'peer/bracketed-commonjs-room-helper.js': 2
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
  const unrelatedGenericRoomValidator = {
    file: 'other/ordinary.ts',
    text: String.raw`function validateRoom(room) { return /^\d{17,20}$/.test(room.guildId); }`
  };
  const unrelatedGenericValueValidator = {
    file: 'other/ordinary-value.ts',
    text: String.raw`function validateRoom(value) { return /^\d{17,20}$/.test(value.id); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    unrelatedGenericRoomValidator,
    unrelatedGenericValueValidator,
  ]), expectedPolicies);
  const genuineTownHallGenericRoomValidator = {
    file: 'other/town-hall-room.ts',
    text: String.raw`function validateRoom(room) { return /^\d{17,20}$/.test(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, genuineTownHallGenericRoomValidator]), {
    ...expectedPolicies,
    'other/town-hall-room.ts': 1
  });
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
  const unrelatedRoomValidator = {
    file: 'peer/voice-room.ts',
    text: String.raw`function validateVoiceRoom(room) { return /^\d{1,21}$/.test(room.guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, unrelatedRoomValidator]), expectedPolicies);
  const directCall = { file: 'peer/future-room.ts', text: String.raw`function validateRoom(room) { return RegExp('^[0-9]{1,21}$').test(room.channelId); }` };
  assert.notDeepEqual(roomDigitPolicies([...records, directCall]), expectedPolicies);
  const coercedRoomField = {
    file: 'peer/coerced-town-hall-room.ts',
    text: String.raw`function validateTownHallRoom(room) {
      return /^\d{1,21}$/.test(String(room.guildId));
    }`
  };
  assert.deepEqual(roomDigitPolicies([...records, coercedRoomField]), {
    ...expectedPolicies,
    'peer/coerced-town-hall-room.ts': 1
  });
  const coercedUnrelatedField = {
    file: 'peer/coerced-unrelated-room.ts',
    text: String.raw`function inspectRoom(room) {
      return /^\d{1,21}$/.test(String(room.guildId));
    }`
  };
  assert.deepEqual(roomDigitPolicies([...records, coercedUnrelatedField]), expectedPolicies);
  const destructuredRoomField = {
    file: 'peer/future-room.ts',
    text: 'function validateRoom(room) { const { guildId } = room; return /^\\d{1,21}$/.test(guildId); }'
  };
  assert.deepEqual(roomDigitPolicies([...records, destructuredRoomField]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const destructuredTownHallRoomField = {
    file: 'peer/future-town-hall-room.ts',
    text: String.raw`export function validateTownHallRoom({ guildId }) { return /^\d{1,21}$/.test(guildId); }`
  };
  const renamedDestructuredTownHallRoomField = {
    file: 'peer/future-town-hall-room-renamed.ts',
    text: String.raw`export function validateTownHallRoom({ guildId: id }) { return /^\d{1,21}$/.test(id); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    destructuredTownHallRoomField,
    renamedDestructuredTownHallRoomField,
  ]), {
    ...expectedPolicies,
    'peer/future-town-hall-room.ts': 1,
    'peer/future-town-hall-room-renamed.ts': 1,
  });
  const unrelatedDestructuredRoomField = {
    file: 'peer/voice-room-destructured.ts',
    text: String.raw`export function validateVoiceRoom({ guildId }) { return /^\d{1,21}$/.test(guildId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, unrelatedDestructuredRoomField]), expectedPolicies);
  const mixedContextRegex = {
    file: 'peer/mixed-context-room-regex.ts',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;
    function validateVoiceRoom(room) { return ROOM_ID.test(room.guildId); }
    function validateRoom(room) { return ROOM_ID.test(room.channelId); }`
  };
  assert.deepEqual(roomDigitPolicies([...records, mixedContextRegex]), {
    ...expectedPolicies,
    'peer/mixed-context-room-regex.ts': 1
  });
  const regexConstant = {
    file: 'peer/future-room.ts',
    text: 'function validateRoom(room) { const ROOM_ID = /^\\d{1,21}$/; return ROOM_ID.test(room.guildId); }'
  };
  assert.deepEqual(roomDigitPolicies([...records, regexConstant]), {
    ...expectedPolicies,
    'peer/future-room.ts': 1
  });
  const objectRegexConstant = {
    file: 'peer/local-object-room-regex.ts',
    text: String.raw`function validateRoom(room) {
      const patterns = { ROOM_ID: /^\d{1,21}$/ };
      return patterns.ROOM_ID.test(room.guildId);
    }`
  };
  assert.deepEqual(roomDigitPolicies([...records, objectRegexConstant]), {
    ...expectedPolicies,
    'peer/local-object-room-regex.ts': 1
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
  const importedConstructorRegexHelper = {
    file: 'peer/imported-constructor-room-regex.ts',
    text: "export const ROOM_ID = new RegExp('^[1-9]{1,20}$');"
  };
  const importedConstructorRegexConsumer = {
    file: 'peer/imported-constructor-room-regex-consumer.ts',
    text: "import { ROOM_ID } from './imported-constructor-room-regex'; function validateRoom(room) { return ROOM_ID.test(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedConstructorRegexHelper,
    importedConstructorRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/imported-constructor-room-regex.ts': 1
  });
  const aliasedRegexHelper = {
    file: 'peer/aliased-room-regex.ts',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;
    export { ROOM_ID as CHANNEL_ID };`
  };
  const aliasedRegexConsumer = {
    file: 'peer/aliased-room-regex-consumer.ts',
    text: String.raw`import { ROOM_ID, CHANNEL_ID } from './aliased-room-regex';
    function validateRoom(room) { return ROOM_ID.test(room.guildId) && CHANNEL_ID.test(room.channelId); }`
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    aliasedRegexHelper,
    aliasedRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/aliased-room-regex.ts': 1
  });
  const namespaceRegexHelper = {
    file: 'peer/namespace-room-regex.ts',
    text: "export const ROOM_ID = new RegExp('^[1-9]{1,20}$');"
  };
  const namespaceRegexConsumer = {
    file: 'peer/namespace-room-regex-consumer.ts',
    text: "import * as patterns from './namespace-room-regex'; function validateRoom(room) { return patterns.ROOM_ID.test(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    namespaceRegexHelper,
    namespaceRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/namespace-room-regex.ts': 1
  });
  const namespaceRegexNegativeConsumer = {
    file: 'peer/namespace-room-regex-negative-consumer.ts',
    text: "import * as patterns from './namespace-room-regex'; function validateVoiceRoom(room) { return patterns.ROOM_ID.test(room.guildId); }"
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    namespaceRegexHelper,
    namespaceRegexNegativeConsumer,
  ]), expectedPolicies);
  const defaultObjectRegexHelper = {
    file: 'peer/default-object-room-regex.ts',
    text: String.raw`export default { ROOM_ID: /^\d{1,21}$/ };`,
  };
  const defaultObjectRegexConsumer = {
    file: 'peer/default-object-room-regex-consumer.ts',
    text: "import patterns from './default-object-room-regex'; function validateTownHallRoom(room) { return patterns.ROOM_ID.test(room.guildId); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    defaultObjectRegexHelper,
    defaultObjectRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/default-object-room-regex.ts': 1,
  });
  const defaultObjectRegexNegativeConsumer = {
    file: 'peer/default-object-room-regex-negative-consumer.ts',
    text: "import patterns from './default-object-room-regex'; function inspectRoom(room) { return patterns.ROOM_ID.test(room.name); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    defaultObjectRegexHelper,
    defaultObjectRegexNegativeConsumer,
  ]), expectedPolicies);
  const cjsRuntimeRegexHelper = {
    file: 'peer/cjs-runtime-room-regex.cts',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;`,
  };
  const cjsRuntimeRegexConsumer = {
    file: 'peer/cjs-runtime-room-consumer.cts',
    text: "import { ROOM_ID } from './cjs-runtime-room-regex.cjs'; function validateRoom(room) { return ROOM_ID.test(room.guildId); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    cjsRuntimeRegexHelper,
    cjsRuntimeRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/cjs-runtime-room-regex.cts': 1,
  });
  const cjsRuntimeRegexNegativeConsumer = {
    file: 'peer/cjs-runtime-room-negative-consumer.cts',
    text: "import { ROOM_ID } from './cjs-runtime-room-regex.cjs'; function inspectRoom(room) { return ROOM_ID.test(room.name); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    cjsRuntimeRegexHelper,
    cjsRuntimeRegexNegativeConsumer,
  ]), expectedPolicies);
  const cjsRequireRuntimeRegexHelper = {
    file: 'peer/cjs-require-room-regex.cts',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;`,
  };
  const cjsRequireRuntimeRegexConsumer = {
    file: 'peer/cjs-require-room-consumer.cts',
    text: "const patterns = require('./cjs-require-room-regex.cjs'); function validateTownHallRoom(room) { return patterns.ROOM_ID.test(room.guildId); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    cjsRequireRuntimeRegexHelper,
    cjsRequireRuntimeRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/cjs-require-room-regex.cts': 1,
  });
  const cjsRequireRuntimeRegexNegativeConsumer = {
    file: 'peer/cjs-require-room-negative-consumer.cts',
    text: "const patterns = require('./cjs-require-room-regex.cjs'); function inspectRoom(room) { return patterns.ROOM_ID.test(room.name); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    cjsRequireRuntimeRegexHelper,
    cjsRequireRuntimeRegexNegativeConsumer,
  ]), expectedPolicies);
  const mjsRuntimeRegexHelper = {
    file: 'peer/mjs-runtime-room-regex.mts',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;`,
  };
  const mjsRuntimeRegexConsumer = {
    file: 'peer/mjs-runtime-room-consumer.mts',
    text: "import { ROOM_ID } from './mjs-runtime-room-regex.mjs'; function validateRoom(room) { return ROOM_ID.test(room.guildId); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    mjsRuntimeRegexHelper,
    mjsRuntimeRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/mjs-runtime-room-regex.mts': 1,
  });
  const importEqualsRegexHelper = {
    file: 'peer/import-equals-room-regex.cts',
    text: String.raw`const ROOM_ID = /^\d{1,21}$/; export = ROOM_ID;`,
  };
  const importEqualsRegexConsumer = {
    file: 'peer/import-equals-room-consumer.cts',
    text: "import ROOM_ID = require('./import-equals-room-regex.cjs'); function validateRoom(room) { return ROOM_ID.test(room.guildId); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importEqualsRegexHelper,
    importEqualsRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/import-equals-room-regex.cts': 1,
  });
  const importEqualsRegexNegativeConsumer = {
    file: 'peer/import-equals-room-negative-consumer.cts',
    text: "import ROOM_ID = require('./import-equals-room-regex.cjs'); function inspectRoom(room) { return ROOM_ID.test(room.name); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importEqualsRegexHelper,
    importEqualsRegexNegativeConsumer,
  ]), expectedPolicies);
  const boundRegexStringRoom = {
    file: 'peer/bound-regex-string-room.ts',
    text: String.raw`function validateTownHallRoom(room) {
      const SOURCE = '^\\d{1,21}$';
      const ROOM_ID = new RegExp(SOURCE);
      return ROOM_ID.test(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, boundRegexStringRoom]), {
    ...expectedPolicies,
    'peer/bound-regex-string-room.ts': 1,
  });
  const boundRegexStringNegativeRoom = {
    file: 'peer/bound-regex-string-negative-room.ts',
    text: String.raw`function inspectRoom(room) {
      const SOURCE = '^\\d{1,21}$';
      const ROOM_ID = new RegExp(SOURCE);
      return ROOM_ID.test(room.name);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, boundRegexStringNegativeRoom]), expectedPolicies);
  const importedRegexStringHelper = {
    file: 'peer/imported-room-regex-source.ts',
    text: String.raw`export const ROOM_ID_SOURCE = '^\\d{1,21}$';`,
  };
  const importedRegexStringConsumer = {
    file: 'peer/imported-room-regex-source-consumer.ts',
    text: "import { ROOM_ID_SOURCE } from './imported-room-regex-source'; function validateRoom(room) { return new RegExp(ROOM_ID_SOURCE).test(room.guildId); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedRegexStringHelper,
    importedRegexStringConsumer,
  ]), {
    ...expectedPolicies,
    'peer/imported-room-regex-source-consumer.ts': 1,
  });
  const importedRegexStringNegativeConsumer = {
    file: 'peer/imported-room-regex-source-negative-consumer.ts',
    text: "import { ROOM_ID_SOURCE } from './imported-room-regex-source'; function inspectRoom(room) { return new RegExp(ROOM_ID_SOURCE).test(room.name); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedRegexStringHelper,
    importedRegexStringNegativeConsumer,
  ]), expectedPolicies);
  const importedRegexStringAliasConsumer = {
    file: 'peer/imported-room-regex-source-alias-consumer.ts',
    text: String.raw`import { ROOM_ID_SOURCE } from './imported-room-regex-source';
    const LOCAL_ROOM_ID_SOURCE = ROOM_ID_SOURCE;
    function validateRoom(room) { return new RegExp(LOCAL_ROOM_ID_SOURCE).test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedRegexStringHelper,
    importedRegexStringAliasConsumer,
  ]), {
    ...expectedPolicies,
    [importedRegexStringAliasConsumer.file]: 1,
  });
  const importedRegexStringAliasNegativeConsumer = {
    file: 'peer/imported-room-regex-source-alias-negative-consumer.ts',
    text: String.raw`import { ROOM_ID_SOURCE } from './imported-room-regex-source';
    const LOCAL_ROOM_ID_SOURCE = ROOM_ID_SOURCE;
    function inspectRoom(room) { return new RegExp(LOCAL_ROOM_ID_SOURCE).test(room.name); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedRegexStringHelper,
    importedRegexStringAliasNegativeConsumer,
  ]), expectedPolicies);
  const unicodeDecimalRoom = {
    file: 'peer/unicode-decimal-room.ts',
    text: String.raw`function validateTownHallRoom(room) {
      return /^\p{Decimal_Number}{1,20}$/u.test(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, unicodeDecimalRoom]), {
    ...expectedPolicies,
    'peer/unicode-decimal-room.ts': 1,
  });
  const unicodeDecimalNegativeRoom = {
    file: 'peer/unicode-decimal-negative-room.ts',
    text: String.raw`function inspectRoom(room) {
      return /^\p{Decimal_Number}{1,20}$/u.test(room.name);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, unicodeDecimalNegativeRoom]), expectedPolicies);
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
  const blockHoistedVarRoomValidator = {
    file: 'peer/block-hoisted-var-room-validator.ts',
    text: String.raw`function validateTownHallRoom(room) {
      { var id = room.guildId; }
      return /^\d{1,21}$/.test(id);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, blockHoistedVarRoomValidator]), {
    ...expectedPolicies,
    'peer/block-hoisted-var-room-validator.ts': 1,
  });
  const blockHoistedVarNegativeControl = {
    file: 'peer/block-hoisted-var-negative-control.ts',
    text: String.raw`function validateTownHallRoom(room) {
      { var id = room.name; }
      return /^\d{1,21}$/.test(id);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, blockHoistedVarNegativeControl]), expectedPolicies);
  const runtimeCtsHelper = {
    file: 'peer/runtime-room-helper.cts',
    text: String.raw`export function validateGuildId(value) { return /^\d{1,21}$/.test(value); }`,
  };
  const runtimeCjsConsumer = {
    file: 'peer/runtime-room-consumer.cjs',
    text: String.raw`const { validateGuildId } = require('./runtime-room-helper.cjs');
    function validateTownHallRoom(room) { return validateGuildId(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    runtimeCtsHelper,
    runtimeCjsConsumer,
  ]), {
    ...expectedPolicies,
    'peer/runtime-room-helper.cts': 1,
  });
  const runtimeMtsHelper = {
    file: 'peer/runtime-mts-helper.mts',
    text: String.raw`export function validateGuildId(value) { return /^\d{1,21}$/.test(value); }`,
  };
  const runtimeMjsConsumer = {
    file: 'peer/runtime-mjs-consumer.mjs',
    text: String.raw`import { validateGuildId } from './runtime-mts-helper.mjs';
    function validateTownHallRoom(room) { return validateGuildId(room.channelId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    runtimeMtsHelper,
    runtimeMjsConsumer,
  ]), {
    ...expectedPolicies,
    'peer/runtime-mts-helper.mts': 1,
  });
  const directCommonJsRegex = {
    file: 'peer/direct-commonjs-regex.cjs',
    text: String.raw`module.exports = /^\d{1,21}$/;`,
  };
  const directCommonJsRegexConsumer = {
    file: 'peer/direct-commonjs-regex-consumer.cjs',
    text: String.raw`const ROOM_ID = require('./direct-commonjs-regex.cjs');
    function validateTownHallRoom(room) { return ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    directCommonJsRegex,
    directCommonJsRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/direct-commonjs-regex.cjs': 1,
  });
  const commonJsNamespaceRegexHelper = {
    file: 'peer/commonjs-namespace-room-patterns.cjs',
    text: String.raw`module.exports = { ROOM_ID: /^\d{1,21}$/ };`,
  };
  const commonJsNamespaceRegexConsumer = {
    file: 'peer/commonjs-namespace-room-consumer.cjs',
    text: String.raw`const patterns = require('./commonjs-namespace-room-patterns.cjs');
    function validateTownHallRoom(room) { return patterns.ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    commonJsNamespaceRegexHelper,
    commonJsNamespaceRegexConsumer,
  ]), {
    ...expectedPolicies,
    'peer/commonjs-namespace-room-patterns.cjs': 1,
  });
  const commonJsNamespaceVoiceConsumer = {
    file: 'peer/commonjs-namespace-room-voice-consumer.cjs',
    text: String.raw`const patterns = require('./commonjs-namespace-room-patterns.cjs');
    function validateVoiceRoom(room) { return patterns.ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    commonJsNamespaceRegexHelper,
    commonJsNamespaceVoiceConsumer,
  ]), expectedPolicies);
  const nestedCommonJsNamespaceConsumer = {
    file: 'peer/nested-commonjs-namespace-consumer.cjs',
    text: String.raw`function validateTownHallRoom(room) {
      const { ROOM_ID } = require('./commonjs-namespace-room-patterns.cjs');
      return ROOM_ID.test(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    commonJsNamespaceRegexHelper,
    nestedCommonJsNamespaceConsumer,
  ]), {
    ...expectedPolicies,
    [commonJsNamespaceRegexHelper.file]: 1,
  });
  const nestedCommonJsNamespaceVoiceConsumer = {
    file: 'peer/nested-commonjs-namespace-voice-consumer.cjs',
    text: String.raw`function validateVoiceRoom(room) {
      const { ROOM_ID } = require('./commonjs-namespace-room-patterns.cjs');
      return ROOM_ID.test(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    commonJsNamespaceRegexHelper,
    nestedCommonJsNamespaceVoiceConsumer,
  ]), expectedPolicies);
  const commonJsNamespaceShadowConsumer = {
    file: 'peer/commonjs-namespace-room-shadow-consumer.cjs',
    text: String.raw`const patterns = require('./commonjs-namespace-room-patterns.cjs');
    function validateTownHallRoom(room, patterns) { return patterns.ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    commonJsNamespaceRegexHelper,
    commonJsNamespaceShadowConsumer,
  ]), expectedPolicies);
  const directCommonJsMemberHelper = {
    file: 'peer/direct-commonjs-member.cjs',
    text: String.raw`module.exports = { validateGuildId(value) {
      return /^\d{1,21}$/.test(value);
    } };`,
  };
  const directCommonJsMemberConsumer = {
    file: 'peer/direct-commonjs-member-consumer.cjs',
    text: String.raw`function validateTownHallRoom(room) {
      return require('./direct-commonjs-member.cjs').validateGuildId(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    directCommonJsMemberHelper,
    directCommonJsMemberConsumer,
  ]), {
    ...expectedPolicies,
    'peer/direct-commonjs-member.cjs': 1,
  });
  const instanceValidator = {
    file: 'peer/instance-validator.ts',
    text: String.raw`class Validators {
      validateGuildId(value) { return /^\d{1,21}$/.test(value); }
    }
    function validateTownHallRoom(room) {
      return new Validators().validateGuildId(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, instanceValidator]), {
    ...expectedPolicies,
    'peer/instance-validator.ts': 1,
  });
  const typedRegexValidator = {
    file: 'peer/typed-regex-validator.ts',
    text: String.raw`function validateTownHallRoom(room) {
      const first = /^\d{1,21}$/ satisfies RegExp;
      const second = /^\d{1,21}$/ as RegExp;
      return first.test(room.guildId) && second.test(room.channelId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, typedRegexValidator]), {
    ...expectedPolicies,
    'peer/typed-regex-validator.ts': 2,
  });
  const ordinaryGenericRoom = {
    file: 'peer/ordinary.ts',
    text: String.raw`function validateRoom(room) {
      return /^\d{1,20}$/.test(room.guildId);
    }`,
  };
  const voiceGenericRoom = {
    file: 'other/voice-room.ts',
    text: String.raw`function validateRoom(room) {
      return /^\d{1,20}$/.test(room.guildId);
    }`,
  };
  const snowflakeTownHallRoom = {
    file: 'peer/snowflake.ts',
    text: String.raw`function validateTownHallRoom(room) {
      return /^\d{1,20}$/.test(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    ordinaryGenericRoom,
    voiceGenericRoom,
    snowflakeTownHallRoom,
  ]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1,
  });
  const reviewInlineCommonJsObject = {
    file: 'peer/inline-commonjs-object.cjs',
    text: String.raw`module.exports = {
      validateGuildId(value) { return /^\d{1,21}$/.test(value); },
      validateChannelId: value => /^\d{1,21}$/.test(value),
    };`,
  };
  const reviewInlineCommonJsObjectConsumer = {
    file: 'peer/inline-commonjs-object-consumer.cjs',
    text: String.raw`const { validateGuildId, validateChannelId } =
      require('./inline-commonjs-object.cjs');
    function validateTownHallRoom(room) {
      return validateGuildId(room.guildId) && validateChannelId(room.channelId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    reviewInlineCommonJsObject,
    reviewInlineCommonJsObjectConsumer,
  ]), {
    ...expectedPolicies,
    'peer/inline-commonjs-object.cjs': 2,
  });
  const bracketedCommonJsHelper = {
    file: 'peer/bracketed-commonjs-helper.cjs',
    text: String.raw`exports['validateGuildId'] = value => /^\d{1,21}$/.test(value);`,
  };
  const bracketedCommonJsConsumer = {
    file: 'peer/bracketed-commonjs-consumer.cjs',
    text: String.raw`const { validateGuildId } = require('./bracketed-commonjs-helper.cjs');
    function validateTownHallRoom(room) { return validateGuildId(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    bracketedCommonJsHelper,
    bracketedCommonJsConsumer,
  ]), {
    ...expectedPolicies,
    'peer/bracketed-commonjs-helper.cjs': 1,
  });
  const reviewExportEqualsHelper = {
    file: 'peer/export-equals-helper.cts',
    text: String.raw`function validateGuildId(value) { return /^\d{1,21}$/.test(value); }
    export = validateGuildId;`,
  };
  const reviewExportEqualsConsumer = {
    file: 'peer/export-equals-consumer.cjs',
    text: String.raw`const validateGuildId = require('./export-equals-helper.cjs');
    function validateTownHallRoom(room) { return validateGuildId(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    reviewExportEqualsHelper,
    reviewExportEqualsConsumer,
  ]), {
    ...expectedPolicies,
    'peer/export-equals-helper.cts': 1,
  });
  const importedRegexShadowConsumer = {
    file: 'peer/imported-regex-shadow-consumer.ts',
    text: String.raw`import { ROOM_ID } from './imported-room-regex';
    function validateTownHallRoom(ROOM_ID, room) { return ROOM_ID.test(room.guildId); }`,
  };
  const importedRegexAliasConsumer = {
    file: 'peer/imported-regex-alias-consumer.ts',
    text: String.raw`import { ROOM_ID } from './imported-room-regex';
    const VALIDATOR = ROOM_ID;
    function validateTownHallRoom(room) { return VALIDATOR.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedRegexHelper,
    importedRegexAliasConsumer,
  ]), {
    ...expectedPolicies,
    [importedRegexHelper.file]: 1,
  });
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedRegexHelper,
    importedRegexShadowConsumer,
  ]), expectedPolicies);
  const namespaceShadowReferenceFixture = ts.createSourceFile(
    'peer/namespace-shadow-reference-fixture.ts',
    String.raw`import * as plan from './town-hall-plan';
    function shadow(plan) { return plan.isTownHallRoom({}); }
    plan.isTownHallRoom({});`,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(namespaceShadowReferenceFixture, 'isTownHallRoom'), 1);
  const runtimeCjsVoiceConsumer = {
    file: 'peer/runtime-cjs-voice-consumer.cjs',
    text: String.raw`const { validateGuildId } = require('./runtime-room-helper.cjs');
    function validateVoiceRoom(room) { return validateGuildId(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    runtimeCtsHelper,
    runtimeCjsVoiceConsumer,
  ]), expectedPolicies);
  const runtimeMjsVoiceConsumer = {
    file: 'peer/runtime-mjs-voice-consumer.mjs',
    text: String.raw`import { validateGuildId } from './runtime-mts-helper.mjs';
    function validateVoiceRoom(room) { return validateGuildId(room.channelId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    runtimeMtsHelper,
    runtimeMjsVoiceConsumer,
  ]), expectedPolicies);
  const staticClassRoomPatterns = {
    file: 'peer/static-class-room-patterns.ts',
    text: String.raw`class TownHallPatterns {
      static ROOM_ID = /^\d{1,21}$/;
    }
    function validateTownHallRoom(room) { return TownHallPatterns.ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, staticClassRoomPatterns]), {
    ...expectedPolicies,
    [staticClassRoomPatterns.file]: 1,
  });
  const staticClassOrdinaryInput = {
    file: 'peer/static-class-ordinary-input.ts',
    text: String.raw`class Patterns { static ROOM_ID = /^\d{1,21}$/; }
    function inspectRoom(room) { return Patterns.ROOM_ID.test(room.name); }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, staticClassOrdinaryInput]), expectedPolicies);
  const nestedRoomParameter = {
    file: 'peer/nested-room-parameter.ts',
    text: String.raw`function validateTownHallRoom({ room: { guildId } }) {
      return /^\d{1,21}$/.test(guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, nestedRoomParameter]), {
    ...expectedPolicies,
    [nestedRoomParameter.file]: 1,
  });
  const nestedOrdinaryParameter = {
    file: 'peer/nested-ordinary-parameter.ts',
    text: String.raw`function inspectRoom({ user: { guildId } }) {
      return /^\d{1,21}$/.test(guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, nestedOrdinaryParameter]), expectedPolicies);
  const computedRoomKeys = {
    file: 'peer/computed-room-keys.ts',
    text: String.raw`const ROOM_KEYS = ['guildId', 'channelId'] as const;
    function validateTownHallRoom(room) {
      for (const key of ROOM_KEYS) if (!/^\d{1,21}$/.test(room[key])) return false;
      return true;
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, computedRoomKeys]), {
    ...expectedPolicies,
    [computedRoomKeys.file]: 1,
  });
  const computedOrdinaryKey = {
    file: 'peer/computed-ordinary-key.ts',
    text: String.raw`function inspectRoom(room) {
      for (const key of ['name']) if (!/^\d{1,21}$/.test(room[key])) return false;
      return true;
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, computedOrdinaryKey]), expectedPolicies);
  const conditionalRoomFields = {
    file: 'peer/conditional-room-fields.ts',
    text: String.raw`function validateTownHallRoom(room, useGuild) {
      return /^\d{1,21}$/.test(useGuild ? room.guildId : room.channelId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, conditionalRoomFields]), {
    ...expectedPolicies,
    [conditionalRoomFields.file]: 1,
  });
  const conditionalMixedRoomFields = {
    file: 'peer/conditional-mixed-room-fields.ts',
    text: String.raw`function validateTownHallRoom(room, useGuild) {
      return /^\d{1,21}$/.test(useGuild ? room.guildId : room.name);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, conditionalMixedRoomFields]), expectedPolicies);
  const callbackRoomKeys = {
    file: 'peer/callback-room-keys.ts',
    text: String.raw`function validateTownHallRoom(room) {
      return ['guildId', 'channelId'].every(key => /^\d{1,21}$/.test(room[key]));
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, callbackRoomKeys]), {
    ...expectedPolicies,
    [callbackRoomKeys.file]: 1,
  });
  const callbackOrdinaryKeys = {
    file: 'peer/callback-ordinary-keys.ts',
    text: String.raw`function inspectRoom(room) {
      return ['name', 'topic'].every(key => /^\d{1,21}$/.test(room[key]));
    }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, callbackOrdinaryKeys]), expectedPolicies);
  const commonJsBarrelHelper = {
    file: 'peer/commonjs-barrel-room-helper.cts',
    text: String.raw`export function validateGuildId(value) { return /^\d{1,20}$/.test(value); }`,
  };
  const commonJsBarrel = {
    file: 'peer/commonjs-barrel.cjs',
    text: String.raw`module.exports = require('./commonjs-barrel-room-helper.cjs');`,
  };
  const commonJsBarrelConsumer = {
    file: 'peer/commonjs-barrel-consumer.cjs',
    text: String.raw`const { validateGuildId } = require('./commonjs-barrel.cjs');
    function validateTownHallRoom(room) { return validateGuildId(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    commonJsBarrelHelper,
    commonJsBarrel,
    commonJsBarrelConsumer,
  ]), {
    ...expectedPolicies,
    [commonJsBarrelHelper.file]: 1,
  });
  const commonJsBarrelVoiceConsumer = {
    file: 'peer/commonjs-barrel-voice-consumer.cjs',
    text: String.raw`const { validateGuildId } = require('./commonjs-barrel.cjs');
    function validateVoiceRoom(room) { return validateGuildId(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    commonJsBarrelHelper,
    commonJsBarrel,
    commonJsBarrelVoiceConsumer,
  ]), expectedPolicies);
  const callHelperRoom = {
    file: 'peer/call-helper-room.ts',
    text: String.raw`function validateGuildId(value) { return /^\d{1,21}$/.test(value); }
    function validateTownHallRoom(room) { return validateGuildId.call(null, room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, callHelperRoom]), {
    ...expectedPolicies,
    [callHelperRoom.file]: 1,
  });
  const callHelperVoice = {
    file: 'peer/call-helper-voice.ts',
    text: String.raw`function validateGuildId(value) { return /^\d{1,21}$/.test(value); }
    function validateVoiceRoom(room) { return validateGuildId.call(null, room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, callHelperVoice]), expectedPolicies);
  const matcherHelperRoom = {
    file: 'peer/matcher-helper-room.ts',
    text: String.raw`function matches(value, pattern) { return pattern.test(value); }
    function validateTownHallRoom(room) { return matches(room.guildId, /^\d{1,21}$/); }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, matcherHelperRoom]), {
    ...expectedPolicies,
    [matcherHelperRoom.file]: 1,
  });
  const matcherHelperOrdinaryField = {
    file: 'peer/matcher-helper-ordinary-field.ts',
    text: String.raw`function matches(value, pattern) { return pattern.test(value); }
    function validateTownHallRoom(room) { return matches(room.name, /^\d{1,21}$/); }`,
  };
  assert.deepEqual(roomDigitPolicies([...records, matcherHelperOrdinaryField]), expectedPolicies);
  const defaultObjectShadowConsumer = {
    file: 'peer/default-object-room-regex-shadow-consumer.ts',
    text: "import patterns from './default-object-room-regex'; function inspectRoom(patterns, room) { return patterns.ROOM_ID.test(room.guildId); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    defaultObjectRegexHelper,
    defaultObjectShadowConsumer,
  ]), expectedPolicies);
  const importedRegexStringShadowConsumer = {
    file: 'peer/imported-room-regex-source-shadow-consumer.ts',
    text: "import { ROOM_ID_SOURCE } from './imported-room-regex-source'; function inspectRoom(ROOM_ID_SOURCE, room) { return new RegExp(ROOM_ID_SOURCE).test(room.guildId); }",
  };
  assert.deepEqual(roomDigitPolicies([
    ...records,
    importedRegexStringHelper,
    importedRegexStringShadowConsumer,
  ]), expectedPolicies);
  const hoistedVarReferenceFixture = ts.createSourceFile(
    'peer/hoisted-var-reference-fixture.ts',
    String.raw`export function isTownHallRoom(room) { return room; }
    function localGuard(room) { return room; }
    function check(value) { { var isTownHallRoom = localGuard; } return isTownHallRoom(value); }
    isTownHallRoom({});`,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(hoistedVarReferenceFixture, 'isTownHallRoom'), 1);
  const nestedCommonJsReferenceFixture = ts.createSourceFile(
    'peer/nested-commonjs-reference-fixture.cjs',
    String.raw`function check(value) {
      const { isTownHallRoom: roomGuard } = require('./town-hall-plan');
      return roomGuard(value);
    }`,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(nestedCommonJsReferenceFixture, 'isTownHallRoom'), 1);
  const nestedCommonJsShadowFixture = ts.createSourceFile(
    'peer/nested-commonjs-shadow-fixture.cjs',
    String.raw`const plan = require('./town-hall-plan');
    function check(plan) { return plan.isTownHallRoom({}); }`,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(nestedCommonJsShadowFixture, 'isTownHallRoom'), 0);
  const importEqualsShadowReferenceFixture = ts.createSourceFile(
    'peer/import-equals-shadow-reference-fixture.cts',
    String.raw`import plan = require('./town-hall-plan.cjs');
    function shadow(plan) { return plan.isTownHallRoom({}); }
    plan.isTownHallRoom({});`,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(importEqualsShadowReferenceFixture, 'isTownHallRoom'), 1);
  const commonJsTownHallBarrelFixture = ts.createSourceFile(
    'peer/town-hall-plan-barrel.cjs',
    String.raw`module.exports = require('./town-hall-plan');`,
    ts.ScriptTarget.Latest,
    true,
  );
  const commonJsTownHallBarrelConsumerFixture = ts.createSourceFile(
    'peer/commonjs-town-hall-barrel-consumer.cjs',
    String.raw`const { isTownHallRoom: roomGuard } = require('./town-hall-plan-barrel.cjs');
    function check(room) { return roomGuard(room); }`,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(
    commonJsTownHallBarrelConsumerFixture,
    'isTownHallRoom',
    [commonJsTownHallBarrelFixture],
  ), 1);
  const unrelatedCommonJsBarrelFixture = ts.createSourceFile(
    'peer/unrelated-town-hall-plan-barrel.cjs',
    String.raw`module.exports = require('./voice-room');`,
    ts.ScriptTarget.Latest,
    true,
  );
  const unrelatedCommonJsBarrelConsumerFixture = ts.createSourceFile(
    'peer/unrelated-commonjs-barrel-consumer.cjs',
    String.raw`const { isTownHallRoom: roomGuard } = require('./unrelated-town-hall-plan-barrel.cjs');
    function check(room) { return roomGuard(room); }`,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(countIdentifierReferences(
    unrelatedCommonJsBarrelConsumerFixture,
    'isTownHallRoom',
    [unrelatedCommonJsBarrelFixture],
  ), 0);
  const copied = records.map(record => record.file === 'peer/town-hall-room-identity.ts'
    ? { ...record, text: record.text + inline.text } : record);
  assert.notDeepEqual(roomDigitPolicies(copied), expectedPolicies);
});
