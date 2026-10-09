'use strict';

function indexFunctionInvocations(member, { ts, unwrapParentheses, lexicalBinding, executionScope }) {
  const byBinding = new Map();
  const byFunction = new Map();
  const functionsByBinding = new Map();
  const aliasesByBinding = new Map();
  const body = member.body || member.initializer;

  function add(map, key, invocation) {
    if (!key) return;
    const invocations = map.get(key) || [];
    if (!invocations.includes(invocation)) invocations.push(invocation);
    map.set(key, invocations);
  }

  function functionBinding(node) {
    if (ts.isFunctionDeclaration(node) && node.name) return lexicalBinding(node.name);
    let expression = node;
    while (expression.parent && ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
    const declaration = expression.parent;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer === expression &&
      ts.isIdentifier(declaration.name)) return lexicalBinding(declaration.name);
    return null;
  }

  function finiteCollection(expression, visited = new Set()) {
    expression = unwrapParentheses(expression);
    if (!expression) return null;
    if (ts.isArrayLiteralExpression(expression)) {
      if (expression.elements.length === 0 || expression.elements.some(ts.isSpreadElement)) return null;
      return 'array';
    }
    if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'Set' && !isShadowedName(expression.expression, 'Set')) {
      const initial = expression.arguments?.[0];
      return finiteCollection(initial, visited) === 'array' ? 'set' : null;
    }
    if (!ts.isIdentifier(expression)) return null;
    const binding = lexicalBinding(expression);
    if (!binding || visited.has(binding)) return null;
    visited.add(binding);
    const declaration = binding.parent;
    const declarationList = declaration?.parent;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer ||
      !declarationList || !ts.isVariableDeclarationList(declarationList) ||
      (declarationList.flags & ts.NodeFlags.Const) === 0) return null;
    return finiteCollection(declaration.initializer, visited);
  }

  function bindsName(binding, name) {
    if (ts.isIdentifier(binding)) return binding.text === name;
    if (ts.isArrayBindingPattern(binding) || ts.isObjectBindingPattern(binding)) {
      return binding.elements.some(element => !ts.isOmittedExpression(element) && bindsName(element.name, name));
    }
    return false;
  }

  function isShadowedName(node, name) {
    for (let scope = node.parent; scope; scope = scope.parent) {
      if (ts.isCatchClause(scope) && bindsName(scope.variableDeclaration.name, name)) return true;
      if (ts.isFunctionLike(scope) && scope.parameters.some(parameter => bindsName(parameter.name, name))) return true;
      if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
      for (const statement of scope.statements || []) {
        if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration =>
          bindsName(declaration.name, name))) return true;
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          statement.name?.text === name) return true;
        if (ts.isImportDeclaration(statement) && statement.importClause) {
          const clause = statement.importClause;
          const bindings = clause.namedBindings;
          if (clause.name?.text === name || bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name ||
            bindings && ts.isNamedImports(bindings) && bindings.elements.some(element => element.name.text === name)) return true;
        }
      }
    }
    return false;
  }

  function functionsForReference(expression) {
    expression = unwrapParentheses(expression);
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      return [expression];
    }
    if (!ts.isIdentifier(expression)) return [];
    const binding = lexicalBinding(expression);
    return binding ? aliasesByBinding.get(binding) || functionsByBinding.get(binding) || [] : [];
  }

  function invocationForFunction(node) {
    let expression = node;
    while (expression.parent && ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
    let parent = expression.parent;
    if (parent && ts.isCallExpression(parent) && parent.expression === expression) return parent;
    if (parent && (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === expression && ['call', 'apply'].includes(propertyName(parent)) &&
      ts.isCallExpression(parent.parent) && parent.parent.expression === parent) return parent.parent;
    return null;
  }

  function propertyName(access) {
    if (ts.isPropertyAccessExpression(access)) return access.name.text;
    if (!ts.isElementAccessExpression(access)) return null;
    const argument = unwrapParentheses(access.argumentExpression);
    if (ts.isStringLiteralLike(argument)) return argument.text;
    if (!ts.isIdentifier(argument)) return null;
    const binding = lexicalBinding(argument);
    const declaration = binding?.parent;
    const initializer = declaration && ts.isVariableDeclaration(declaration) ?
      unwrapParentheses(declaration.initializer) : null;
    return initializer && ts.isStringLiteralLike(initializer) ? initializer.text : null;
  }

  function callbackCall(call) {
    if (!ts.isCallExpression(call)) return null;
    const callee = unwrapParentheses(call.expression);
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return null;
    const method = propertyName(callee);
    if (!['forEach', 'map', 'some'].includes(method)) return null;
    const kind = finiteCollection(callee.expression);
    if (!kind || (kind === 'set' && method !== 'forEach')) return null;
    return call;
  }

  function effectiveInvocation(call) {
    let current = call;
    let scope = executionScope(current);
    const visited = new Set();
    while (scope && scope !== member && !visited.has(scope)) {
      visited.add(scope);
      const direct = invocationForFunction(scope);
      if (direct) {
        current = direct;
        scope = executionScope(current);
        continue;
      }
      const parentCall = callbackCallForFunction(scope);
      if (parentCall) {
        current = parentCall;
        scope = executionScope(current);
        continue;
      }
      return null;
    }
    return scope === member ? current : null;
  }

  function callbackCallForFunction(node) {
    let expression = node;
    while (expression.parent && ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
    let call = expression.parent;
    if (call && ts.isPropertyAccessExpression(call) && call.expression === expression) call = call.parent;
    if (!call || !callbackCall(call)) return null;
    const callback = call.arguments[0];
    return functionsForReference(callback).includes(node) ? call : null;
  }

  const visitFunctions = node => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
      const binding = functionBinding(node);
      if (binding) {
        const functions = functionsByBinding.get(binding) || [];
        functions.push(node);
        functionsByBinding.set(binding, functions);
      }
      const invocation = invocationForFunction(node);
      if (invocation) add(byFunction, node, invocation);
    }
    ts.forEachChild(node, visitFunctions);
  };
  if (body) visitFunctions(body);

  const collectAliases = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      ts.isIdentifier(unwrapParentheses(node.initializer))) {
      const sourceBinding = lexicalBinding(unwrapParentheses(node.initializer));
      const targetBinding = lexicalBinding(node.name);
      if (sourceBinding && targetBinding) {
        const sourceFunctions = aliasesByBinding.get(sourceBinding) || functionsByBinding.get(sourceBinding) || [];
        if (sourceFunctions.length) aliasesByBinding.set(targetBinding, [...sourceFunctions]);
      }
    }
    ts.forEachChild(node, collectAliases);
  };
  if (body) collectAliases(body);

  const visitInvocations = node => {
    if (ts.isCallExpression(node)) {
      const effective = effectiveInvocation(node);
      const callee = unwrapParentheses(node.expression);
      if (effective) {
        if (ts.isIdentifier(callee)) {
          const binding = lexicalBinding(callee);
          for (const fn of binding ? aliasesByBinding.get(binding) || functionsByBinding.get(binding) || [] : []) {
            const targetBinding = functionBinding(fn);
            add(byBinding, targetBinding, effective);
          }
        } else if ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
          ['call', 'apply'].includes(propertyName(callee))) {
          for (const fn of functionsForReference(callee.expression)) {
            add(byBinding, functionBinding(fn), effective);
            add(byFunction, fn, effective);
          }
        }
      }
      const collectionCall = callbackCall(node);
      if (collectionCall) {
        for (const fn of functionsForReference(node.arguments[0])) {
          const callSite = effectiveInvocation(node) || node;
          add(byBinding, functionBinding(fn), callSite);
          add(byFunction, fn, callSite);
        }
      }
    }
    if (ts.isReturnStatement(node) && node.expression && executionScope(node) === member) {
      for (const fn of functionsForReference(node.expression)) {
        let writesCapturedBinding = false;
        function inspectWrites(current) {
          if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(unwrapParentheses(current.left)) && executionScope(current) === fn) {
            const binding = lexicalBinding(unwrapParentheses(current.left));
            const declaration = binding?.parent;
            if (declaration && executionScope(declaration) !== fn) writesCapturedBinding = true;
          }
          ts.forEachChild(current, inspectWrites);
        }
        if (fn.body) inspectWrites(fn.body);
        if (!writesCapturedBinding) {
          add(byBinding, functionBinding(fn), node);
          add(byFunction, fn, node);
        }
      }
    }
    ts.forEachChild(node, visitInvocations);
  };
  if (body) visitInvocations(body);

  return {
    byBinding,
    byFunction,
    callsFor(node, binding) {
      return [...new Set([...(binding ? byBinding.get(binding) || [] : []), ...(byFunction.get(node) || [])])];
    }
  };
}

module.exports = { indexFunctionInvocations };
