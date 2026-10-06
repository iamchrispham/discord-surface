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
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === factoryName) return statement;
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === factoryName &&
          declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
        return declaration.initializer;
      }
    }
  }
  return null;
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
  if (hasStateParameter && !usesThis) {
    return INVOCATION_STYLES.STATE;
  }
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

function callableDeclarations(source, factory) {
  const declarations = [];
  const add = (name, declaration) => {
    if (name) declarations.push({ name, declaration, scope: scopeNode(declaration.parent) });
  };
  const visitSource = node => {
    if (ts.isFunctionDeclaration(node)) {
      add(node.name?.text, node);
      return;
    }
    if (ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      add(node.name.text, node);
    }
    ts.forEachChild(node, visitSource);
  };
  visitSource(source);
  const visitFactory = node => {
    if (node !== factory && ts.isFunctionLike(node)) {
      if (ts.isFunctionDeclaration(node)) add(node.name?.text, node);
      return;
    }
    if (ts.isFunctionDeclaration(node)) add(node.name?.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      add(node.name.text, node);
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
    const identifier = rootIdentifier(expression);
    const declaration = declarationForIdentifier(declarations, identifier, source);
    if (declaration) mutated.add(declaration);
  };
  const visit = node => {
    if (node !== factory && ts.isFunctionLike(node)) return;
    if (ts.isBinaryExpression(node) && assignmentOperators.has(node.operatorToken.kind)) mark(node.left);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
      mark(node.operand);
    }
    if (ts.isDeleteExpression(node)) mark(node.expression);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'assign' && node.arguments.length) {
      mark(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(factory);
  return mutated;
}

function callableDescriptor(node) {
  if (!node || !ts.isFunctionLike(node)) return null;
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
      if (resolving.has(declaration)) return null;
      resolving.add(declaration);
      const resolved = ts.isVariableDeclaration(declaration)
        ? resolveValue(declaration.initializer)
        : callableDescriptor(declaration);
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
        const resolved = resolveExpression(declaration.initializer);
        const local = resolved.get(expression.name.text);
        if (local) return local;
        const initializer = declaration.initializer;
        const isRequire = initializer && ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression) && initializer.expression.text === 'require';
        if (!isRequire) return null;
      }
      const imported = resolveImportedValue(receiver.text, expression.name.text);
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
        candidate.parameterCount === descriptor.parameterCount;
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
    const local = factoryDeclaration(source, methodName);
    if (local) return callableDescriptor(local);
    const bindings = requireBindings(source);
    const exported = exportedFactoryExpression(source, methodName);
    const exportedName = exported && ts.isIdentifier(exported) ? exported.text : null;
    const receiverBinding = exported && ts.isPropertyAccessExpression(exported) && ts.isIdentifier(exported.expression)
      ? bindings.get(exported.expression.text)
      : null;
    const binding = bindings.get(exportedName || methodName) || receiverBinding;
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
  const bindings = new Map();
  const visit = node => {
    if (node !== source && ts.isFunctionLike(node)) return;
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!declaration.initializer || !ts.isCallExpression(declaration.initializer) ||
            !ts.isIdentifier(declaration.initializer.expression) || declaration.initializer.expression.text !== 'require' ||
            declaration.initializer.arguments.length !== 1 || !ts.isStringLiteral(declaration.initializer.arguments[0])) continue;
        const modulePath = declaration.initializer.arguments[0].text;
        if (ts.isIdentifier(declaration.name)) {
          bindings.set(declaration.name.text, { modulePath, exportName: null });
          continue;
        }
        if (!ts.isObjectBindingPattern(declaration.name)) continue;
        for (const element of declaration.name.elements) {
          if (!ts.isBindingElement(element)) continue;
          const imported = propertyName(element.propertyName || element.name);
          const local = ts.isIdentifier(element.name) ? element.name.text : null;
          if (imported && local) bindings.set(local, { modulePath, exportName: imported });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
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
  if (ts.isIdentifier(target)) return { name: target.text, receiver: null };
  if (ts.isPropertyAccessExpression(target)) return { name: target.name.text, receiver: target.expression };
  return null;
}

function directRequire(receiver) {
  if (!receiver || !ts.isCallExpression(receiver) || !ts.isIdentifier(receiver.expression) || receiver.expression.text !== 'require' ||
      receiver.arguments.length !== 1 || !ts.isStringLiteral(receiver.arguments[0])) return null;
  return receiver.arguments[0].text;
}

function exportedFactoryExpression(source, factoryName) {
  let result = null;
  const isModuleExports = node => ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === 'module' && node.name.text === 'exports';
  const isNamedExport = node => ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === 'exports' && node.name.text === factoryName;
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
        if (ts.isObjectLiteralExpression(node.right)) {
          for (const property of node.right.properties) {
            if (propertyName(property.name) !== factoryName) continue;
            result = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
          }
        }
        else {
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

function reexportedModulePath(source) {
  let result = null;
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === '__exportStar') {
      result = directRequire(node.arguments[0]) || result;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function factoryMethodsFromSource(source, sourcePath, factoryName, seen) {
  const key = `${sourcePath}:${factoryName}`;
  if (seen.has(key)) return new Map();
  seen.add(key);
  const factory = factoryDeclaration(source, factoryName);
  if (!factory) return null;
  const bindings = requireBindings(source);
  const resolveExpression = expression => {
    const called = calledFactory(expression);
    if (!called) return new Map();
    const local = factoryMethodsFromSource(source, sourcePath, called.name, new Set(seen));
    if (local?.size) return local;
    const binding = called.receiver
      ? (ts.isIdentifier(called.receiver) ? bindings.get(called.receiver.text) : null)
      : bindings.get(called.name);
    const modulePath = directRequire(called.receiver) || binding?.modulePath;
    if (!modulePath) return new Map();
    const importedPath = resolveModulePath(modulePath, sourcePath);
    if (!importedPath) return new Map();
    const importedName = called.receiver && ts.isPropertyAccessExpression(called.receiver)
      ? called.name
      : binding?.exportName || called.name;
    return moduleFactoryMethods(importedPath, importedName, new Set(seen));
  };
  const resolveImportedValue = (receiverName, methodName) => {
    const binding = bindings.get(receiverName);
    if (!binding) return null;
    const importedPath = resolveModulePath(binding.modulePath, sourcePath);
    return importedPath ? moduleCallableDescriptor(importedPath, methodName) : null;
  };
  return collectFactoryMethods(factory, source, resolveExpression, resolveImportedValue);
}

function moduleFactoryMethods(filePath, factoryName, seen) {
  try {
    const importedText = fs.readFileSync(filePath, 'utf8');
    const importedSource = ts.createSourceFile(filePath, importedText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const local = factoryMethodsFromSource(importedSource, filePath, factoryName, seen);
    if (local?.size) return local;
    const bindings = requireBindings(importedSource);
    const exported = exportedFactoryExpression(importedSource, factoryName);
    const exportedName = exported && ts.isIdentifier(exported) ? exported.text : null;
    const receiverBinding = exported && ts.isPropertyAccessExpression(exported) && ts.isIdentifier(exported.expression)
      ? bindings.get(exported.expression.text)
      : null;
    const binding = bindings.get(exportedName || factoryName) || receiverBinding;
    const exportedReceiver = exported && ts.isPropertyAccessExpression(exported) ? exported.expression : null;
    const modulePath = binding?.modulePath || directRequire(exportedReceiver) || directRequire(exported) || reexportedModulePath(importedSource);
    if (!modulePath) return new Map();
    const importedPath = resolveModulePath(modulePath, filePath);
    if (!importedPath) return new Map();
    const importedName = exported && ts.isPropertyAccessExpression(exported)
      ? exported.name.text
      : binding?.exportName || factoryName;
    return moduleFactoryMethods(importedPath, importedName, seen);
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
      if (node.expression) expressions.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return expressions;
}

function factoryResolvesToCompanion(source, sourcePath, factoryName, seen = new Set()) {
  const key = `${sourcePath}:${factoryName}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const bindings = requireBindings(source);
  const factory = factoryDeclaration(source, factoryName);
  if (!factory) {
    const binding = bindings.get(factoryName);
    if (binding?.modulePath && resolveModulePath(binding.modulePath, sourcePath)) return true;
    const exported = exportedFactoryExpression(source, factoryName);
    const exportedReceiver = exported && ts.isPropertyAccessExpression(exported) ? exported.expression : null;
    const modulePath = directRequire(exportedReceiver) || directRequire(exported) || reexportedModulePath(source);
    return !!(modulePath && resolveModulePath(modulePath, sourcePath));
  }
  const expressions = returnedExpressions(factory);
  if (!expressions.length) return false;
  return expressions.every(expression => {
    const called = calledFactory(expression, true);
    if (!called) return false;
    const binding = called.receiver && ts.isIdentifier(called.receiver)
      ? bindings.get(called.receiver.text)
      : bindings.get(called.name);
    const modulePath = directRequire(called.receiver) || binding?.modulePath;
    if (modulePath && resolveModulePath(modulePath, sourcePath)) return true;
    return factoryDeclaration(source, called.name) &&
      factoryResolvesToCompanion(source, sourcePath, called.name, new Set(seen));
  });
}

function factoryMethods(source, factoryName) {
  const methods = factoryMethodsFromSource(source, stateSourcePath, factoryName, new Set());
  return methods?.size ? methods : null;
}

function importedFactoryMethods(source, factoryName) {
  if (!factoryResolvesToCompanion(source, stateSourcePath, factoryName)) return null;
  return factoryMethods(source, factoryName) || moduleFactoryMethods(stateSourcePath, factoryName, new Set());
}

function discoverFactory(source, factoryName) {
  const methods = importedFactoryMethods(source, factoryName);
  return { methods: methods || new Map(), approved: methods !== null };
}

module.exports = { INVOCATION_STYLES, discoverFactory };
