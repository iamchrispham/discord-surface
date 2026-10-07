const fs = require('node:fs');

const path = require('node:path');

const ts = require('typescript');

const stateSourcePath = path.resolve(__dirname, '../../src/state.js');

const INVOCATION_STYLES = Object.freeze({ THIS: 'this', STATE: 'state', PURE: 'pure' });

function propertyName(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function factoryDeclaration(source, factoryName) {
  let candidate = null;
  let binding = null;
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === factoryName) {
      candidate = statement;
      binding = statement;
      break;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === factoryName &&
          declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
        candidate = declaration.initializer;
        binding = declaration;
        break;
      }
    }
    if (candidate) break;
  }
  if (!candidate) return null;
  const declarations = callableDeclarations(source, null);
  const mutated = mutatedDeclarations(source, declarations, source);
  return mutated.has(binding) ? null : candidate;
}

function isAsyncFactory(node) {
  return !!node?.asteriskToken || !!node?.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}

function usesThisExpression(node) {
  let usesThis = false;
  const visit = current => {
    if (current !== node && ts.isFunctionLike(current) && !ts.isArrowFunction(current)) return;
    if (current.kind === ts.SyntaxKind.ThisKeyword) usesThis = true;
    ts.forEachChild(current, visit);
  };
  visit(node);
  return usesThis;
}

function invocationStyle(node) {
  const usesThis = usesThisExpression(node);
  const parameters = (node.parameters || []).filter(parameter =>
    !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'));
  const first = parameters[0];
  const hasStateParameter = parameters.some(parameter =>
    ts.isIdentifier(parameter.name) && ['state', 'surface'].includes(parameter.name.text));
  if (first && ts.isIdentifier(first.name) && ['state', 'surface'].includes(first.name.text)) {
    return INVOCATION_STYLES.STATE;
  }
  if (hasStateParameter && !usesThis) return INVOCATION_STYLES.STATE;
  if (usesThis) return INVOCATION_STYLES.THIS;
  return INVOCATION_STYLES.PURE;
}

function isScopeNode(node) {
  return ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionLike(node) ||
    ts.isModuleBlock(node) || ts.isCaseBlock(node) || ts.isCatchClause(node) ||
    ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node);
}

function scopeNode(node) {
  let current = node;
  while (current && !isScopeNode(current)) current = current.parent;
  return current;
}

function variableDeclarationNode(declaration) {
  let current = declaration;
  while (current && !ts.isVariableDeclaration(current)) current = current.parent;
  return current;
}

function isVarDeclaration(declaration) {
  const variable = variableDeclarationNode(declaration);
  const list = variable?.parent;
  if (!list || !ts.isVariableDeclarationList(list)) return false;
  return (list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0;
}

function declarationScope(declaration) {
  if (!isVarDeclaration(declaration)) return scopeNode(declaration.parent);
  let current = declaration.parent;
  while (current && !ts.isSourceFile(current) && !ts.isFunctionLike(current)) current = current.parent;
  return current;
}

function targetExpressions(expression) {
  const targets = [];
  const visit = node => {
    if (!node) return;
    if (ts.isParenthesizedExpression(node)) {
      visit(node.expression);
      return;
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      targets.push(node);
      return;
    }
    if (ts.isBindingElement(node)) {
      visit(node.name);
      return;
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      visit(node.name);
      return;
    }
    if (ts.isPropertyAssignment(node)) {
      visit(node.initializer);
      return;
    }
    if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) {
      visit(node.expression);
      return;
    }
    if (ts.isArrayBindingPattern(node) || ts.isObjectBindingPattern(node) ||
        ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) {
      ts.forEachChild(node, visit);
    }
  };
  visit(expression);
  return targets;
}

function bindingIdentifiers(pattern) {
  return targetExpressions(pattern).filter(ts.isIdentifier);
}

function unwrapExpression(expression) {
  let current = expression;
  while (current && ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function arrayElementValue(expression, index) {
  const value = unwrapExpression(expression);
  return value && ts.isArrayLiteralExpression(value) ? value.elements[index] || null : value;
}

function objectPropertyKey(property) {
  if (ts.isBindingElement(property)) return propertyName(property.propertyName || property.name);
  if (ts.isShorthandPropertyAssignment(property)) return propertyName(property.name);
  if (ts.isPropertyAssignment(property)) return propertyName(property.name);
  return null;
}

function objectPropertyValue(expression, key) {
  const value = unwrapExpression(expression);
  if (!value || !ts.isObjectLiteralExpression(value)) return value;
  for (const property of value.properties) {
    if (objectPropertyKey(property) !== key) continue;
    if (ts.isBindingElement(property)) return property.initializer || property.name;
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
    if (ts.isPropertyAssignment(property)) return property.initializer;
  }
  return null;
}

function destructuredBindings(pattern, initializer) {
  const pairs = [];
  const walk = (target, value) => {
    if (!target) return;
    const current = unwrapExpression(target);
    if (!value && !ts.isBindingElement(current)) return;
    if (ts.isIdentifier(current)) {
      pairs.push([current, value]);
      return;
    }
    if (ts.isBindingElement(current)) {
      const selected = value || current.initializer;
      walk(current.name, selected);
      return;
    }
    if (ts.isArrayBindingPattern(current) || ts.isArrayLiteralExpression(current)) {
      current.elements.forEach((element, index) => {
        if (!element) return;
        const selected = ts.isSpreadElement(element)
          ? value
          : arrayElementValue(value, index);
        walk(element, selected);
      });
      return;
    }
    if (ts.isObjectBindingPattern(current) || ts.isObjectLiteralExpression(current)) {
      const properties = ts.isObjectBindingPattern(current) ? current.elements : current.properties;
      for (const property of properties) {
        const key = objectPropertyKey(property);
        const selected = key === null ? value : objectPropertyValue(value, key);
        if (ts.isSpreadAssignment(property) || ts.isSpreadElement(property)) {
          walk(property.expression, value);
        }
        else if (ts.isBindingElement(property)) walk(property, selected);
        else if (ts.isShorthandPropertyAssignment(property)) walk(property.name, selected);
        else if (ts.isPropertyAssignment(property)) walk(property.initializer, selected);
      }
    }
  };
  walk(pattern, initializer);
  return pairs;
}

function bindingInitializer(identifier) {
  let current = identifier;
  while (current && !ts.isVariableDeclaration(current)) current = current.parent;
  if (!current?.initializer) return null;
  return destructuredBindings(current.name, current.initializer)
    .find(([binding]) => binding === identifier)?.[1] || null;
}

function callableDeclarations(source, factory) {
  const declarations = [];
  const add = (name, declaration) => {
    if (name) declarations.push({ name, declaration, scope: declarationScope(declaration) });
  };
  const visitSource = node => {
    if (ts.isFunctionDeclaration(node)) {
      add(node.name?.text, node);
      return;
    }
    if (ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) add(node.name.text, node);
      else for (const identifier of bindingIdentifiers(node.name)) add(identifier.text, identifier);
    }
    ts.forEachChild(node, visitSource);
  };
  visitSource(source);
  const visitFactory = node => {
    if (!node) return;
    if (node !== factory && ts.isFunctionLike(node)) {
      if (ts.isFunctionDeclaration(node)) add(node.name?.text, node);
      return;
    }
    if (ts.isFunctionDeclaration(node)) add(node.name?.text, node);
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) add(node.name.text, node);
      else for (const identifier of bindingIdentifiers(node.name)) add(identifier.text, identifier);
    }
    ts.forEachChild(node, visitFactory);
  };
  visitFactory(factory);
  return declarations;
}

function declarationForIdentifier(declarations, identifier, source) {
  if (!identifier || !ts.isIdentifier(identifier)) return null;
  const scopes = [];
  let current = scopeNode(identifier);
  while (current) {
    scopes.push(current);
    current = current.parent;
    while (current && !isScopeNode(current)) current = current.parent;
  }
  const useStart = identifier.getStart(source);
  for (const scope of scopes) {
    const candidates = declarations.filter(item => item.scope === scope && item.name === identifier.text &&
      (ts.isFunctionDeclaration(item.declaration) || item.declaration.getStart(source) <= useStart));
    if (candidates.length) return candidates[candidates.length - 1].declaration;
  }
  return null;
}

function rootIdentifier(expression) {
  let current = expression;
  while (current && ts.isParenthesizedExpression(current)) current = current.expression;
  if (current && ts.isIdentifier(current)) return current;
  if (current && (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))) {
    return rootIdentifier(current.expression);
  }
  return null;
}

function mutatedDeclarations(factory, declarations, source) {
  const mutated = new Set();
  const aliases = new Map();
  const assignmentOperators = new Set([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.AsteriskAsteriskEqualsToken,
    ts.SyntaxKind.SlashEqualsToken,
    ts.SyntaxKind.PercentEqualsToken,
    ts.SyntaxKind.LessThanLessThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.AmpersandEqualsToken,
    ts.SyntaxKind.BarEqualsToken,
    ts.SyntaxKind.CaretEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken
  ]);
  const mark = expression => {
    for (const target of targetExpressions(expression)) {
      const identifier = rootIdentifier(target);
      const declaration = declarationForIdentifier(declarations, identifier, source);
      if (declaration) mutated.add(declaration);
    }
  };
  const link = (left, right) => {
    const leftDeclaration = declarationForIdentifier(declarations, rootIdentifier(left), source);
    const rightDeclaration = declarationForIdentifier(declarations, rootIdentifier(right), source);
    if (!leftDeclaration || !rightDeclaration || leftDeclaration === rightDeclaration) return;
    if (!aliases.has(leftDeclaration)) aliases.set(leftDeclaration, new Set());
    if (!aliases.has(rightDeclaration)) aliases.set(rightDeclaration, new Set());
    aliases.get(leftDeclaration).add(rightDeclaration);
    aliases.get(rightDeclaration).add(leftDeclaration);
  };
  const linkDestructured = (pattern, initializer) => {
    const pairs = destructuredBindings(pattern, initializer);
    if (pairs.length) {
      for (const [left, right] of pairs) link(left, right);
      return;
    }
    link(pattern, initializer);
  };
  const varDeclarations = new Map();
  for (const item of declarations) {
    if (!isVarDeclaration(item.declaration)) continue;
    const key = `${item.scope?.pos}:${item.name}`;
    if (!varDeclarations.has(key)) varDeclarations.set(key, []);
    varDeclarations.get(key).push(item.declaration);
  }
  for (const items of varDeclarations.values()) {
    for (const declaration of items.slice(1)) mutated.add(declaration);
  }
  const visit = node => {
    if (node !== factory && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && node.initializer) {
      linkDestructured(node.name, node.initializer);
    }
    if (ts.isBinaryExpression(node) && assignmentOperators.has(node.operatorToken.kind)) mark(node.left);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      linkDestructured(node.left, node.right);
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
      mark(node.operand);
    }
    if (ts.isDeleteExpression(node)) mark(node.expression);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'assign' && node.arguments.length) {
      mark(node.arguments[0]);
    }
    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) mark(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(factory);
  const pending = [...mutated];
  while (pending.length) {
    const declaration = pending.pop();
    for (const alias of aliases.get(declaration) || []) {
      if (mutated.has(alias)) continue;
      mutated.add(alias);
      pending.push(alias);
    }
  }
  return mutated;
}

function mutatedBindingNames(source, names) {
  const declarations = callableDeclarations(source, null);
  const mutated = mutatedDeclarations(source, declarations, source);
  return new Set(declarations
    .filter(item => names.has(item.name) && mutated.has(item.declaration))
    .map(item => item.name));
}

function callableDescriptor(node) {
  if (!node || !ts.isFunctionLike(node)) return null;
  if (ts.isArrowFunction(node) && usesThisExpression(node)) return null;
  const parameters = (node.parameters || []).filter(parameter =>
    !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'));
  const style = invocationStyle(node);
  const stateParameterIndex = style === INVOCATION_STYLES.STATE
    ? parameters.findIndex(parameter => ts.isIdentifier(parameter.name) && ['state', 'surface'].includes(parameter.name.text))
    : -1;
  const postStateParameters = style === INVOCATION_STYLES.STATE
    ? parameters.slice(stateParameterIndex + 1)
    : parameters;
  const requiredArguments = postStateParameters.filter(parameter =>
    !parameter.initializer && !parameter.dotDotDotToken).length;
  return {
    style,
    requiredArguments,
    parameterCount: postStateParameters.length,
    hasRestParameter: postStateParameters.some(parameter => !!parameter.dotDotDotToken),
    stateParameterIndex,
    usesThis: usesThisExpression(node)
  };
}

function collectFactoryMethods(factory, source, resolveExpression = () => new Map(), resolveImportedValue = () => null) {
  const methods = new Map();
  const declarations = callableDeclarations(source, factory);
  const mutated = mutatedDeclarations(factory, declarations, source);
  const resolving = new Set();
  const resolveBinding = identifier => declarationForIdentifier(declarations, identifier, source);
  const resolveValue = expression => {
    if (!expression) return null;
    const direct = callableDescriptor(expression);
    if (direct) return direct;
    if (ts.isIdentifier(expression)) {
      const declaration = resolveBinding(expression);
      if (!declaration) return null;
      if (mutated.has(declaration)) return null;
      if (resolving.has(declaration)) return null;
      resolving.add(declaration);
      let resolved;
      if (ts.isVariableDeclaration(declaration)) resolved = resolveValue(declaration.initializer);
      else if (ts.isIdentifier(declaration)) resolved = resolveValue(bindingInitializer(declaration));
      else resolved = callableDescriptor(declaration);
      resolving.delete(declaration);
      return resolved;
    }
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
        expression.expression.name.text === 'bind') {
      const descriptor = resolveValue(expression.expression.expression);
      if (!descriptor || descriptor.style !== INVOCATION_STYLES.STATE || descriptor.usesThis) return null;
      const boundArguments = Math.max(0, expression.arguments.length - 1);
      if (expression.arguments.slice(1).some(argument => ts.isSpreadElement(argument)) ||
          boundArguments !== descriptor.stateParameterIndex) return null;
      return { ...descriptor, stateParameterIndex: 0 };
    }
    if (!ts.isPropertyAccessExpression(expression)) return null;
    const receiver = expression.expression;
    if (ts.isIdentifier(receiver)) {
      const declaration = resolveBinding(receiver);
      if (declaration && ts.isVariableDeclaration(declaration)) {
        if (mutated.has(declaration)) return null;
        const resolved = resolveExpression(declaration.initializer);
        const local = resolved.get(expression.name.text);
        if (local) return local;
        const initializer = declaration.initializer;
        const isRequire = initializer && ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression) && initializer.expression.text === 'require';
        if (!isRequire) return null;
      }
      const imported = resolveImportedValue(receiver.text, expression.name.text, receiver);
      if (imported) return imported;
    }
    if (ts.isCallExpression(receiver)) {
      const resolved = resolveExpression(receiver);
      return resolved.get(expression.name.text) || null;
    }
    return null;
  };
  const collectObject = object => {
    const methods = new Map();
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        for (const [method, descriptor] of resolveReturnedExpression(property.expression)) methods.set(method, descriptor);
        continue;
      }
      const name = propertyName(property.name);
      if (!name) continue;
      let descriptor = null;
      if (ts.isMethodDeclaration(property)) descriptor = callableDescriptor(property);
      else if (ts.isShorthandPropertyAssignment(property)) descriptor = resolveValue(property.name);
      else if (ts.isPropertyAssignment(property)) descriptor = resolveValue(property.initializer);
      methods.set(name, descriptor);
    }
    return methods;
  };
  const resolveReturnedExpression = (expression, seen = new Set()) => {
    if (!expression) return new Map();
    let current = expression;
    while (ts.isParenthesizedExpression(current)) current = current.expression;
    if (ts.isObjectLiteralExpression(current)) return collectObject(current);
    if (ts.isIdentifier(current)) {
      const declaration = resolveBinding(current);
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
        if (mutated.has(declaration)) return new Map();
        const key = declaration.getStart(source);
        if (seen.has(key)) return new Map();
        const next = new Set(seen);
        next.add(key);
        return resolveReturnedExpression(declaration.initializer, next);
      }
    }
    return resolveExpression(current);
  };
  const body = factory.body;
  const returns = [];
  const collectReturns = node => {
    if (!node) return;
    if (node !== factory && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      returns.push(node.expression || null);
      return;
    }
    ts.forEachChild(node, collectReturns);
  };
  if (body && ts.isBlock(body)) collectReturns(body);
  else if (body) returns.push(body);
  const branchMethods = returns.map(expression => resolveReturnedExpression(expression));
  if (!branchMethods.length) return methods;
  const [first, ...rest] = branchMethods;
  for (const [method, descriptor] of first) {
    if (!descriptor) continue;
    if (rest.every(branch => {
      const candidate = branch.get(method);
      return candidate && candidate.style === descriptor.style &&
        candidate.requiredArguments === descriptor.requiredArguments &&
        candidate.parameterCount === descriptor.parameterCount &&
        candidate.hasRestParameter === descriptor.hasRestParameter &&
        candidate.stateParameterIndex === descriptor.stateParameterIndex;
    })) {
      methods.set(method, descriptor);
    }
  }
  return methods;
}

function moduleCallableDescriptor(filePath, methodName, seen = new Set()) {
  const key = `${filePath}:${methodName}`;
  if (seen.has(key)) return null;
  seen.add(key);
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const exported = exportedFactoryExpression(source, methodName);
    const exportedName = exported && ts.isIdentifier(exported) ? exported.text : null;
    const local = exportedName ? factoryDeclaration(source, exportedName) : null;
    if (local) return callableDescriptor(local);
    if (!exported) return null;
    const bindings = requireBindings(source);
    const receiverBinding = exported && ts.isPropertyAccessExpression(exported) && ts.isIdentifier(exported.expression)
      ? bindings.get(exported.expression.text, exported.expression)
      : null;
    const binding = (exportedName ? bindings.get(exportedName, exported) : null) || receiverBinding || bindings.get(methodName);
    const exportedReceiver = exported && ts.isPropertyAccessExpression(exported) ? exported.expression : null;
    const modulePath = binding?.modulePath || directRequire(exportedReceiver) || directRequire(exported);
    if (!modulePath) return null;
    const importedPath = resolveModulePath(modulePath, filePath);
    if (!importedPath) return null;
    const importedName = exported && ts.isPropertyAccessExpression(exported)
      ? exported.name.text
      : binding?.exportName || methodName;
    return moduleCallableDescriptor(importedPath, importedName, seen);
  }
  catch {
    return null;
  }
}

function requireBindings(source) {
  const bindings = [];
  const addBinding = (name, declaration, modulePath, exportName) => {
    bindings.push({ name, declaration, scope: declarationScope(declaration), modulePath, exportName });
  };
  const visit = node => {
    if (node !== source && ts.isFunctionLike(node)) return;
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!declaration.initializer || !ts.isCallExpression(declaration.initializer) ||
            !ts.isIdentifier(declaration.initializer.expression) || declaration.initializer.expression.text !== 'require' ||
            declaration.initializer.arguments.length !== 1 || !ts.isStringLiteral(declaration.initializer.arguments[0])) continue;
        const modulePath = declaration.initializer.arguments[0].text;
        if (ts.isIdentifier(declaration.name)) {
          addBinding(declaration.name.text, declaration, modulePath, null);
          continue;
        }
        if (!ts.isObjectBindingPattern(declaration.name)) continue;
        for (const element of declaration.name.elements) {
          if (!ts.isBindingElement(element)) continue;
          const imported = propertyName(element.propertyName || element.name);
          const local = ts.isIdentifier(element.name) ? element.name.text : null;
          if (imported && local) addBinding(local, element.name, modulePath, imported);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const scopeChain = identifier => {
    const scopes = [];
    let current = scopeNode(identifier);
    while (current) {
      scopes.push(current);
      current = current.parent;
      while (current && !isScopeNode(current)) current = current.parent;
    }
    return scopes;
  };
  const resolve = (name, identifier) => {
    if (!identifier || !ts.isIdentifier(identifier)) return null;
    const useStart = identifier.getStart(source);
    for (const scope of scopeChain(identifier)) {
      const candidates = bindings.filter(binding => binding.name === name && binding.scope === scope &&
        binding.declaration.getStart(source) <= useStart);
      if (candidates.length) return candidates[candidates.length - 1];
    }
    return null;
  };
  return {
    get(name, identifier = null) {
      if (identifier) return resolve(name, identifier);
      const topLevel = bindings.filter(binding => binding.name === name && binding.scope === source);
      return (topLevel.length ? topLevel : bindings.filter(binding => binding.name === name)).at(-1) || null;
    }
  };
}

function resolveModulePath(modulePath, sourcePath) {
  if (!modulePath?.startsWith('.')) return null;
  try {
    return require.resolve(modulePath, { paths: [path.dirname(sourcePath)] });
  }
  catch {
    return null;
  }
}

function calledFactory(expression, requireCall = false) {
  let candidate = expression;
  while (ts.isParenthesizedExpression(candidate)) candidate = candidate.expression;
  const actualCall = ts.isCallExpression(candidate);
  if (requireCall && !actualCall) return null;
  let target = actualCall ? candidate.expression : candidate;
  while (ts.isParenthesizedExpression(target)) target = target.expression;
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.CommaToken) target = target.right;
  while (ts.isParenthesizedExpression(target)) target = target.expression;
  if (ts.isIdentifier(target)) return { name: target.text, receiver: null, target };
  if (ts.isPropertyAccessExpression(target)) return { name: target.name.text, receiver: target.expression, target };
  return null;
}

function directRequire(receiver) {
  if (!receiver || !ts.isCallExpression(receiver) || !ts.isIdentifier(receiver.expression) || receiver.expression.text !== 'require' ||
      receiver.arguments.length !== 1 || !ts.isStringLiteral(receiver.arguments[0])) return null;
  return receiver.arguments[0].text;
}

function exportedFactoryExpression(source, factoryName, allowDefault = false) {
  let result = null;
  const isModuleExports = node => ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === 'module' && node.name.text === 'exports';
  const isNamedExport = node => ts.isPropertyAccessExpression(node) &&
    ((ts.isIdentifier(node.expression) && node.expression.text === 'exports') || isModuleExports(node.expression)) &&
    node.name.text === factoryName;
  const getterExpression = node => {
    if (!ts.isObjectLiteralExpression(node)) return null;
    for (const property of node.properties) {
      if (propertyName(property.name) !== 'get' || !property.initializer || !ts.isFunctionLike(property.initializer)) continue;
      const body = property.initializer.body;
      if (!body || !ts.isBlock(body)) continue;
      const statement = body.statements.find(item => ts.isReturnStatement(item) && item.expression);
      if (statement) return statement.expression;
    }
    return null;
  };
  const visit = node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (isNamedExport(node.left)) result = node.right;
      if (isModuleExports(node.left)) {
        result = null;
        if (ts.isObjectLiteralExpression(node.right)) {
          for (const property of node.right.properties) {
            if (propertyName(property.name) !== factoryName) continue;
            result = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
          }
        }
        else if (allowDefault || directRequire(node.right)) {
          result = node.right;
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Object' &&
        node.expression.name.text === 'defineProperty' && node.arguments.length >= 3 &&
        ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === 'exports' &&
        ts.isStringLiteral(node.arguments[1]) && node.arguments[1].text === factoryName) {
      result = getterExpression(node.arguments[2]) || result;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function reexportedModulePaths(source) {
  const paths = [];
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === '__exportStar') {
      const modulePath = directRequire(node.arguments[0]);
      if (modulePath) paths.push(modulePath);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return paths;
}

function moduleExportsFactory(filePath, factoryName, seen = new Set()) {
  if (seen.has(filePath)) return false;
  seen.add(filePath);
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (exportedFactoryExpression(source, factoryName)) return true;
    return reexportedModulePaths(source).some(modulePath => {
      const importedPath = resolveModulePath(modulePath, filePath);
      return !!(importedPath && moduleExportsFactory(importedPath, factoryName, new Set(seen)));
    });
  }
  catch {
    return false;
  }
}

function moduleFactoryAllowed(filePath, factoryName, seen = new Set(), allowDefault = false) {
  const key = `${filePath}:${factoryName}`;
  if (seen.has(key)) return false;
  seen.add(key);
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const exported = exportedFactoryExpression(source, factoryName, allowDefault);
    const bindings = requireBindings(source);
    if (!exported) {
      for (const modulePath of reexportedModulePaths(source)) {
        const importedPath = resolveModulePath(modulePath, filePath);
        if (importedPath && moduleExportsFactory(importedPath, factoryName)) {
          return moduleFactoryAllowed(importedPath, factoryName, seen, false);
        }
      }
      return false;
    }
    let candidate = exported;
    while (ts.isParenthesizedExpression(candidate)) candidate = candidate.expression;
    const exportedName = ts.isIdentifier(candidate) ? candidate.text : factoryName;
    const local = factoryDeclaration(source, exportedName);
    const factory = local || (ts.isFunctionLike(candidate) ? candidate : null);
    if (factory) {
      return !isAsyncFactory(factory) &&
        (!factory.body || !ts.isBlock(factory.body) || !statementCanFallThrough(factory.body));
    }
    const receiver = ts.isPropertyAccessExpression(candidate) ? candidate.expression : null;
    let binding = null;
    if (ts.isIdentifier(candidate)) binding = bindings.get(candidate.text, candidate);
    else if (receiver && ts.isIdentifier(receiver)) binding = bindings.get(receiver.text, receiver);
    const modulePath = binding?.modulePath || directRequire(receiver) || directRequire(candidate);
    const importedPath = modulePath && resolveModulePath(modulePath, filePath);
    if (!importedPath) return false;
    const importedName = ts.isPropertyAccessExpression(candidate)
      ? candidate.name.text
      : binding?.exportName || factoryName;
    const importedDefault = !ts.isPropertyAccessExpression(candidate) && !binding?.exportName && allowDefault;
    return moduleFactoryAllowed(importedPath, importedName, seen, importedDefault);
  }
  catch {
    return false;
  }
}

function factoryMethodsFromSource(source, sourcePath, factoryName, seen) {
  const key = `${sourcePath}:${factoryName}`;
  if (seen.has(key)) return new Map();
  seen.add(key);
  const factory = factoryDeclaration(source, factoryName);
  if (!factory) return null;
  if (isAsyncFactory(factory)) return null;
  const bindings = requireBindings(source);
  const resolveExpression = expression => {
    const called = calledFactory(expression);
    if (!called) return new Map();
    const local = factoryMethodsFromSource(source, sourcePath, called.name, new Set(seen));
    if (local?.size) return local;
    const binding = called.receiver
      ? (ts.isIdentifier(called.receiver) ? bindings.get(called.receiver.text, called.receiver) : null)
      : bindings.get(called.name, called.target);
    const modulePath = directRequire(called.receiver) || binding?.modulePath;
    if (!modulePath) return new Map();
    const importedPath = resolveModulePath(modulePath, sourcePath);
    if (!importedPath) return new Map();
    const importedName = called.receiver && ts.isPropertyAccessExpression(called.receiver)
      ? called.name
      : binding?.exportName || called.name;
    const allowDefault = !called.receiver && !binding?.exportName;
    return moduleFactoryMethods(importedPath, importedName, new Set(seen), allowDefault);
  };
  const resolveImportedValue = (receiverName, methodName, receiver) => {
    const binding = bindings.get(receiverName, receiver);
    if (!binding) return null;
    const importedPath = resolveModulePath(binding.modulePath, sourcePath);
    return importedPath ? moduleCallableDescriptor(importedPath, methodName) : null;
  };
  return collectFactoryMethods(factory, source, resolveExpression, resolveImportedValue);
}

function moduleFactoryMethods(filePath, factoryName, seen, allowDefault = false) {
  try {
    if (filePath !== stateSourcePath && !moduleFactoryAllowed(filePath, factoryName, new Set(), allowDefault)) return new Map();
    const importedText = fs.readFileSync(filePath, 'utf8');
    const importedSource = ts.createSourceFile(filePath, importedText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const local = factoryMethodsFromSource(importedSource, filePath, factoryName, seen);
    if (local?.size) return local;
    const bindings = requireBindings(importedSource);
    const exported = exportedFactoryExpression(importedSource, factoryName, allowDefault);
    const exportedName = exported && ts.isIdentifier(exported) ? exported.text : null;
    const receiverBinding = exported && ts.isPropertyAccessExpression(exported) && ts.isIdentifier(exported.expression)
      ? bindings.get(exported.expression.text, exported.expression)
      : null;
    const binding = (exportedName ? bindings.get(exportedName, exported) : null) || receiverBinding || bindings.get(factoryName);
    const exportedReceiver = exported && ts.isPropertyAccessExpression(exported) ? exported.expression : null;
    const modulePath = binding?.modulePath || directRequire(exportedReceiver) || directRequire(exported);
    if (modulePath) {
      const importedPath = resolveModulePath(modulePath, filePath);
      if (!importedPath) return new Map();
      const importedName = exported && ts.isPropertyAccessExpression(exported)
        ? exported.name.text
        : binding?.exportName || factoryName;
      const importedDefault = !exported || !ts.isPropertyAccessExpression(exported)
        ? !binding?.exportName && allowDefault
        : false;
      return moduleFactoryMethods(importedPath, importedName, seen, importedDefault);
    }
    for (const reexportPath of reexportedModulePaths(importedSource)) {
      const reexportedPath = resolveModulePath(reexportPath, filePath);
      if (reexportedPath && moduleExportsFactory(reexportedPath, factoryName)) {
        return moduleFactoryMethods(reexportedPath, factoryName, seen);
      }
    }
    return new Map();
  }
  catch {
    return new Map();
  }
}

function returnedExpressions(factory) {
  const body = factory.body;
  if (!body || !ts.isBlock(body)) return body ? [body] : [];
  const expressions = [];
  const visit = node => {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      expressions.push(node.expression || null);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return expressions;
}

function switchCanFallThrough(statement) {
  const clauses = statement.caseBlock.clauses;
  if (!clauses.some(clause => ts.isDefaultClause(clause))) return true;
  const clauseCanFallThrough = index => {
    if (index >= clauses.length) return true;
    const flow = statementFlow({ statements: clauses[index].statements });
    if (flow.breaks.size) return true;
    return flow.normal && clauseCanFallThrough(index + 1);
  };
  return clauses.some((_, index) => clauseCanFallThrough(index));
}

function statementFlow(statement) {
  if (statement?.statements) {
    let normal = true;
    const breaks = new Set();
    for (const child of statement.statements) {
      if (!normal) break;
      const flow = statementFlow(child);
      for (const target of flow.breaks) breaks.add(target);
      normal = flow.normal;
    }
    return { normal, breaks };
  }
  if (ts.isBlock(statement)) return statementFlow({ statements: statement.statements });
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || ts.isContinueStatement(statement)) {
    return { normal: false, breaks: new Set() };
  }
  if (ts.isBreakStatement(statement)) {
    return { normal: false, breaks: new Set([statement.label?.text || null]) };
  }
  if (ts.isIfStatement(statement)) {
    const thenFlow = statementFlow(statement.thenStatement);
    const elseFlow = statement.elseStatement ? statementFlow(statement.elseStatement) : { normal: true, breaks: new Set() };
    const breaks = new Set([...thenFlow.breaks, ...elseFlow.breaks]);
    return {
      normal: thenFlow.normal || elseFlow.normal,
      breaks
    };
  }
  if (ts.isSwitchStatement(statement)) {
    const breaks = new Set();
    for (const clause of statement.caseBlock.clauses) {
      const flow = statementFlow({ statements: clause.statements });
      for (const target of flow.breaks) if (target !== null) breaks.add(target);
    }
    return { normal: switchCanFallThrough(statement), breaks };
  }
  if (ts.isTryStatement(statement)) {
    const tryFlow = statementFlow(statement.tryBlock);
    const catchFlow = statement.catchClause
      ? statementFlow(statement.catchClause.block)
      : { normal: false, breaks: new Set() };
    const combined = {
      normal: tryFlow.normal || catchFlow.normal,
      breaks: new Set([...tryFlow.breaks, ...catchFlow.breaks])
    };
    if (!statement.finallyBlock) return combined;
    const finallyFlow = statementFlow(statement.finallyBlock);
    return finallyFlow.normal ? combined : finallyFlow;
  }
  if (ts.isLabeledStatement(statement)) {
    const flow = statementFlow(statement.statement);
    if (!flow.breaks.has(statement.label.text)) return flow;
    const breaks = new Set(flow.breaks);
    breaks.delete(statement.label.text);
    return { normal: true, breaks };
  }
  return { normal: true, breaks: new Set() };
}

function statementCanFallThrough(statement) {
  return statementFlow(statement).normal;
}

function factoryResolvesToCompanion(source, sourcePath, factoryName, seen = new Set()) {
  const key = `${sourcePath}:${factoryName}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const bindings = requireBindings(source);
  const factory = factoryDeclaration(source, factoryName);
  if (!factory) {
    const binding = bindings.get(factoryName);
    if (binding?.modulePath) {
      const importedPath = resolveModulePath(binding.modulePath, sourcePath);
      if (importedPath && moduleFactoryAllowed(importedPath, binding.exportName || factoryName, new Set(), !binding.exportName)) return true;
    }
    const exported = exportedFactoryExpression(source, factoryName);
    const exportedReceiver = exported && ts.isPropertyAccessExpression(exported) ? exported.expression : null;
    const importedName = exported && ts.isPropertyAccessExpression(exported)
      ? exported.name.text
      : factoryName;
    const modulePath = directRequire(exportedReceiver) || directRequire(exported);
    if (modulePath) {
      const importedPath = resolveModulePath(modulePath, sourcePath);
      return !!(importedPath && moduleFactoryAllowed(importedPath, importedName, new Set(), false));
    }
    for (const reexportPath of reexportedModulePaths(source)) {
      const importedPath = resolveModulePath(reexportPath, sourcePath);
      if (importedPath && moduleExportsFactory(importedPath, factoryName)) {
        return moduleFactoryAllowed(importedPath, factoryName);
      }
    }
    return false;
  }
  if (isAsyncFactory(factory)) return false;
  if (factory.body && ts.isBlock(factory.body) && statementCanFallThrough(factory.body)) return false;
  const expressions = returnedExpressions(factory);
  if (!expressions.length || expressions.some(expression => !expression)) return false;
  return expressions.every(expression => {
    const called = calledFactory(expression, true);
    if (!called) return false;
    const binding = called.receiver && ts.isIdentifier(called.receiver)
      ? bindings.get(called.receiver.text, called.receiver)
      : bindings.get(called.name, called.target);
    const modulePath = directRequire(called.receiver) || binding?.modulePath;
    if (modulePath) {
      const importedPath = resolveModulePath(modulePath, sourcePath);
      const importedName = called.receiver && ts.isPropertyAccessExpression(called.receiver)
        ? called.name
        : binding?.exportName || called.name;
      const allowDefault = !called.receiver && !binding?.exportName;
      if (importedPath && moduleFactoryAllowed(importedPath, importedName, new Set(), allowDefault)) return true;
    }
    return factoryDeclaration(source, called.name) &&
      factoryResolvesToCompanion(source, sourcePath, called.name, new Set(seen));
  });
}

function factoryMethods(source, factoryName) {
  const sourcePath = path.isAbsolute(source.fileName) ? source.fileName : stateSourcePath;
  const methods = factoryMethodsFromSource(source, sourcePath, factoryName, new Set());
  return methods?.size ? methods : null;
}

function importedFactoryMethods(source, factoryName) {
  const sourcePath = path.isAbsolute(source.fileName) ? source.fileName : stateSourcePath;
  if (!factoryResolvesToCompanion(source, sourcePath, factoryName)) return null;
  const local = factoryMethods(source, factoryName);
  if (local) return local;
  const imported = moduleFactoryMethods(sourcePath, factoryName, new Set());
  return imported.size ? imported : null;
}

function discoverFactory(source, factoryName) {
  const methods = importedFactoryMethods(source, factoryName);
  return { methods: methods || new Map(), approved: methods !== null };
}

module.exports = { INVOCATION_STYLES, discoverFactory, mutatedBindingNames };
