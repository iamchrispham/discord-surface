const path = require('node:path');

const ts = require('typescript');

const {
  bindingInitializer,
  callableDeclarations,
  declarationForIdentifier,
  mutatedDeclarations,
  propertyName
} = require('./handler-discovery-bindings');

const INVOCATION_STYLES = Object.freeze({ THIS: 'this', STATE: 'state', PURE: 'pure' });

const LEGACY_DUAL_HANDLER_NAMES = new Set([
  'hasOrdinaryPreflight',
  'excludeDirectPost',
  'setIntakeCutoff'
]);

const LEGACY_DUAL_HANDLER_ROOTS = [
  path.resolve(__dirname, '../../src'),
  path.resolve(__dirname, '../../dist')
];

function isLegacyDualHandler(node) {
  const fileName = path.resolve(node.getSourceFile().fileName);
  return LEGACY_DUAL_HANDLER_NAMES.has(node.name?.text) &&
    LEGACY_DUAL_HANDLER_ROOTS.some(root => fileName === root || fileName.startsWith(`${root}${path.sep}`));
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

function callableDescriptor(node) {
  if (!node || !ts.isFunctionLike(node)) return null;
  if (node.asteriskToken || node.modifiers?.length) return null;
  if (ts.isArrowFunction(node) && usesThisExpression(node)) return null;
  const parameters = (node.parameters || []).filter(parameter =>
    !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'));
  if (usesThisExpression(node) && parameters.some(parameter =>
      ts.isIdentifier(parameter.name) && ['state', 'surface'].includes(parameter.name.text)) &&
      !isLegacyDualHandler(node)) return null;
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
  const resolveSpreadExpression = expression => {
    let current = expression;
    while (ts.isParenthesizedExpression(current)) current = current.expression;
    if (ts.isIdentifier(current)) {
      const declaration = resolveBinding(current);
      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return null;
    }
    const resolved = resolveReturnedExpression(current);
    return resolved.size ? resolved : null;
  };
  const collectObject = object => {
    const methods = new Map();
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        const resolved = resolveSpreadExpression(property.expression);
        if (!resolved) return new Map();
        for (const [method, descriptor] of resolved) methods.set(method, descriptor);
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

module.exports = { INVOCATION_STYLES, callableDescriptor, collectFactoryMethods };
