const ts = require('typescript');

function propertyName(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
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
  let selected = null;
  let unresolved = false;
  for (const property of value.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = unwrapExpression(property.expression);
      if (!spread || !ts.isObjectLiteralExpression(spread)) {
        selected = null;
        unresolved = true;
        continue;
      }
      const spreadValue = objectPropertyValue(spread, key);
      if (spreadValue === undefined) {
        selected = null;
        unresolved = true;
      } else if (spreadValue !== null) {
        selected = spreadValue;
        unresolved = false;
      }
      continue;
    }
    const propertyKey = objectPropertyKey(property);
    if (propertyKey === null) {
      if (property.name && ts.isComputedPropertyName(property.name)) {
        selected = null;
        unresolved = true;
      }
      continue;
    }
    if (propertyKey !== key) continue;
    if (ts.isBindingElement(property)) selected = property.initializer || property.name;
    else if (ts.isShorthandPropertyAssignment(property)) selected = property.name;
    else if (ts.isPropertyAssignment(property)) selected = property.initializer;
    unresolved = false;
  }
  return unresolved ? undefined : selected;
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
      const selected = value === undefined ? undefined : value || current.initializer;
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
    if (ts.isClassDeclaration(node)) {
      add(node.name?.text, node);
      return;
    }
    if (ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name)) add(node.name.text, node);
      else for (const identifier of bindingIdentifiers(node.name)) add(identifier.text, identifier);
    }
    ts.forEachChild(node, visitSource);
  };
  visitSource(source);
  const visitFactory = node => {
    if (!node) return;
    if (node === factory && ts.isFunctionLike(node)) {
      for (const parameter of node.parameters || []) {
        for (const identifier of bindingIdentifiers(parameter.name)) add(identifier.text, identifier);
      }
    }
    if (node !== factory && ts.isFunctionLike(node)) {
      if (ts.isFunctionDeclaration(node)) add(node.name?.text, node);
      return;
    }
    if (ts.isFunctionDeclaration(node)) add(node.name?.text, node);
    if (ts.isClassDeclaration(node)) add(node.name?.text, node);
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name)) add(node.name.text, node);
      else for (const identifier of bindingIdentifiers(node.name)) add(identifier.text, identifier);
    }
    ts.forEachChild(node, visitFactory);
  };
  visitFactory(factory);
  return declarations;
}

function scopedDeclarations(source, declarations) {
  const result = [...declarations];
  const bindingDeclaration = declaration => {
    if (!ts.isIdentifier(declaration)) return declaration;
    let current = declaration.parent;
    while (current) {
      if (ts.isVariableDeclaration(current) && bindingIdentifiers(current.name).includes(declaration)) return current;
      current = current.parent;
    }
    return declaration;
  };
  const known = new Set(result.map(item => bindingDeclaration(item.declaration)));
  const add = (name, declaration) => {
    const binding = bindingDeclaration(declaration);
    if (!name || known.has(binding)) return;
    known.add(binding);
    result.push({ name, declaration, scope: declarationScope(declaration) });
  };
  const visit = node => {
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters || []) {
        for (const identifier of bindingIdentifiers(parameter.name)) add(identifier.text, identifier);
      }
    }
    if (ts.isFunctionDeclaration(node)) add(node.name?.text, node);
    if (ts.isClassDeclaration(node)) add(node.name?.text, node);
    if (ts.isVariableDeclaration(node)) {
      for (const identifier of bindingIdentifiers(node.name)) add(identifier.text, identifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
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
    const scopedDeclarations = declarations.filter(item => item.scope === scope && item.name === identifier.text);
    const candidates = scopedDeclarations.filter(item =>
      (ts.isFunctionDeclaration(item.declaration) || isVarDeclaration(item.declaration) ||
        item.declaration.getStart(source) <= useStart));
    if (candidates.length) return candidates[candidates.length - 1].declaration;
    if (scopedDeclarations.length) return null;
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

module.exports = {
  arrayElementValue,
  bindingIdentifiers,
  bindingInitializer,
  callableDeclarations,
  declarationForIdentifier,
  declarationScope,
  destructuredBindings,
  isVarDeclaration,
  objectPropertyKey,
  objectPropertyValue,
  propertyName,
  scopedDeclarations,
  rootIdentifier,
  isScopeNode,
  scopeNode,
  targetExpressions,
  unwrapExpression
};
