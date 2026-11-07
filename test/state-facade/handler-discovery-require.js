const ts = require('typescript');

const {
  bindingIdentifiers,
  bindingInitializer,
  callableDeclarations,
  declarationForIdentifier,
  declarationScope,
  isScopeNode,
  propertyName,
  scopeNode,
  scopedDeclarations
} = require('./handler-discovery-lexical');

function isCommonJsRequireCall(source, call) {
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'require' ||
      call.arguments.length !== 1 || !ts.isStringLiteral(call.arguments[0])) return false;
  const declarations = [];
  const add = (identifier, declaration, scope = declarationScope(declaration)) => {
    if (ts.isIdentifier(identifier) && identifier.text === 'require') declarations.push({ scope });
  };
  const collect = node => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      for (const identifier of bindingIdentifiers(node.name)) add(identifier, node);
    }
    else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      add(node.name, node);
    }
    else if (ts.isFunctionExpression(node) && node.name) {
      add(node.name, node, node);
    }
    else if (ts.isImportClause(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node) ||
        ts.isImportEqualsDeclaration(node)) {
      add(node.name, node);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
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
  const hasShadow = identifier => {
    const scopes = scopeChain(identifier);
    return declarations.some(binding => scopes.includes(binding.scope));
  };
  if (hasShadow(call.expression)) return false;
  let loaderReassigned = false;
  const markLoaderTarget = target => {
    for (const identifier of bindingIdentifiers(target)) {
      if (identifier.text === 'require' && !hasShadow(identifier)) loaderReassigned = true;
    }
  };
  const isAssignmentOperator = kind => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
  const findLoaderWrites = node => {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      markLoaderTarget(node.left);
    }
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
        !ts.isVariableDeclarationList(node.initializer)) {
      markLoaderTarget(node.initializer);
    }
    if (ts.isDeleteExpression(node)) markLoaderTarget(node.expression);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      markLoaderTarget(node.operand);
    }
    ts.forEachChild(node, findLoaderWrites);
  };
  findLoaderWrites(source);
  return !loaderReassigned;
}

function requireBindings(source, invalidatedDeclarations = new Set()) {
  const bindings = [];
  const addBinding = (name, declaration, modulePath, exportName) => {
    bindings.push({ name, declaration, scope: declarationScope(declaration), modulePath, exportName, reassigned: false });
  };
  const visit = node => {
    if (node !== source && ts.isFunctionLike(node)) return;
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!declaration.initializer || !ts.isCallExpression(declaration.initializer) ||
            !ts.isIdentifier(declaration.initializer.expression) || declaration.initializer.expression.text !== 'require' ||
            !isCommonJsRequireCall(source, declaration.initializer)) continue;
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
  const declarations = scopedDeclarations(source, callableDeclarations(source, null));
  const isStableAlias = declaration => {
    let variable = declaration;
    while (variable && !ts.isVariableDeclaration(variable)) variable = variable.parent;
    const list = variable?.parent;
    return !!(list && ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) &&
      ts.isIdentifier(variable.name) && !invalidatedDeclarations.has(declaration));
  };
  const bindingForDeclaration = (declaration, seen = new Set()) => {
    if (!declaration || seen.has(declaration)) return null;
    seen.add(declaration);
    const direct = bindings.filter(binding => binding.declaration === declaration).at(-1);
    if (direct) return !direct.reassigned && !invalidatedDeclarations.has(direct.declaration) ? direct : null;
    if (!isStableAlias(declaration)) return null;
    let initializer = bindingInitializer(declaration);
    while (initializer && ts.isParenthesizedExpression(initializer)) initializer = initializer.expression;
    if (!initializer || !ts.isIdentifier(initializer)) return null;
    const target = declarationForIdentifier(declarations, initializer, source);
    return bindingForDeclaration(target, seen);
  };
  const resolve = (name, identifier) => {
    if (!identifier || !ts.isIdentifier(identifier)) return null;
    const declaration = declarationForIdentifier(declarations, identifier, source);
    const binding = bindingForDeclaration(declaration);
    return binding && (binding.name === name || declaration !== binding.declaration) ? binding : null;
  };
  const isAssignmentOperator = kind => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
  const markBindingTarget = target => {
    if (ts.isParenthesizedExpression(target)) {
      markBindingTarget(target.expression);
      return;
    }
    if (ts.isIdentifier(target)) {
      const binding = resolve(target.text, target);
      if (binding) binding.reassigned = true;
      return;
    }
    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      markBindingTarget(target.expression);
      return;
    }
    if (ts.isArrayLiteralExpression(target) || ts.isArrayBindingPattern(target)) {
      for (const element of target.elements) {
        if (ts.isOmittedExpression(element)) continue;
        if (ts.isBindingElement(element)) markBindingTarget(element.name);
        else markBindingTarget(ts.isSpreadElement(element) ? element.expression : element);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(target) || ts.isObjectBindingPattern(target)) {
      for (const property of target.properties) {
        if (ts.isShorthandPropertyAssignment(property)) markBindingTarget(property.name);
        else if (ts.isPropertyAssignment(property)) markBindingTarget(property.initializer);
        else if (ts.isBindingElement(property)) markBindingTarget(property.name);
        else if (ts.isSpreadAssignment(property)) markBindingTarget(property.expression);
      }
    }
  };
  const markReassignments = node => {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      markBindingTarget(node.left);
    }
    if (ts.isDeleteExpression(node)) markBindingTarget(node.expression);
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
        !ts.isVariableDeclarationList(node.initializer)) {
      markBindingTarget(node.initializer);
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      markBindingTarget(node.operand);
    }
    ts.forEachChild(node, markReassignments);
  };
  markReassignments(source);
  const containsBinding = (expression, target, seen = new Set()) => {
    if (!expression) return false;
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (ts.isFunctionLike(expression)) return false;
    if (ts.isIdentifier(expression)) {
      const declaration = declarationForIdentifier(declarations, expression, source);
      if (declaration === target) return true;
      if (!declaration || seen.has(declaration)) return false;
      seen.add(declaration);
      const initializer = bindingInitializer(declaration);
      return !!initializer && containsBinding(initializer, target, seen);
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      return containsBinding(expression.expression, target, seen) ||
        (ts.isElementAccessExpression(expression) && containsBinding(expression.argumentExpression, target, seen));
    }
    if (ts.isCallExpression(expression)) {
      return expression.arguments.some(argument => containsBinding(argument, target, seen));
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return expression.elements.some(element => containsBinding(
        ts.isSpreadElement(element) ? element.expression : element, target, seen));
    }
    if (ts.isObjectLiteralExpression(expression)) {
      return expression.properties.some(property => {
        if (ts.isShorthandPropertyAssignment(property)) return containsBinding(property.name, target, seen);
        if (ts.isPropertyAssignment(property)) return containsBinding(property.initializer, target, seen);
        return ts.isSpreadAssignment(property) && containsBinding(property.expression, target, seen);
      });
    }
    return false;
  };
  const findEscapes = node => {
    if (ts.isCallExpression(node)) {
      for (const binding of bindings) {
        if (node.arguments.some(argument => containsBinding(argument, binding.declaration))) {
          binding.reassigned = true;
        }
      }
    }
    let aggregate = ts.isVariableDeclaration(node) ? node.initializer : null;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      aggregate = node.right;
    }
    while (aggregate && ts.isParenthesizedExpression(aggregate)) aggregate = aggregate.expression;
    if (aggregate && (ts.isObjectLiteralExpression(aggregate) || ts.isArrayLiteralExpression(aggregate))) {
      for (const binding of bindings) {
        if (containsBinding(aggregate, binding.declaration)) binding.reassigned = true;
      }
    }
    ts.forEachChild(node, findEscapes);
  };
  findEscapes(source);
  return {
    get(name, identifier = null) {
      if (identifier) {
        const binding = resolve(name, identifier);
        return binding && !binding.reassigned && !invalidatedDeclarations.has(binding.declaration) ? binding : null;
      }
      const valid = binding => !binding.reassigned && !invalidatedDeclarations.has(binding.declaration);
      const topLevel = bindings.filter(binding => binding.name === name && binding.scope === source && valid(binding));
      const anyScope = bindings.filter(binding => binding.name === name && valid(binding));
      return (topLevel.length ? topLevel : anyScope).at(-1) || null;
    }
  };
}

module.exports = { isCommonJsRequireCall, requireBindings };
