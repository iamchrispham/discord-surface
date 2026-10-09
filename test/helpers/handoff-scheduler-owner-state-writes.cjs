'use strict';

function hasGatewaySchedulerReflectiveWrite(call, {
  ts,
  unwrapParentheses,
  lexicalBinding,
  receiverIsGatewayThis,
  isUnshadowedGlobal,
  schedulerFields,
  tracksGatewayThis
}) {
  if (!ts.isCallExpression(call)) return false;
  const callee = unwrapParentheses(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false;

  function constantString(expression, visited = new Set()) {
    expression = unwrapParentheses(expression);
    if (ts.isStringLiteralLike(expression)) return expression.text;
    if (!ts.isIdentifier(expression)) return null;
    const binding = lexicalBinding(expression);
    if (!binding || visited.has(binding)) return null;
    visited.add(binding);
    const declaration = binding.parent;
    const declarationList = declaration?.parent;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer ||
      !declarationList || !ts.isVariableDeclarationList(declarationList) ||
      (declarationList.flags & ts.NodeFlags.Const) === 0) return null;
    return constantString(declaration.initializer, visited);
  }

  function propertyName(property) {
    if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
    if (!property.name) return null;
    if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ||
      ts.isNumericLiteral(property.name)) return property.name.text;
    if (ts.isComputedPropertyName(property.name)) return constantString(property.name.expression);
    return null;
  }

  function sourceHasSchedulerField(expression, visited = new Set()) {
    expression = unwrapParentheses(expression);
    if (ts.isObjectLiteralExpression(expression)) {
      return expression.properties.some(property => {
        if (ts.isSpreadAssignment(property)) return sourceHasSchedulerField(property.expression, visited);
        const name = propertyName(property);
        return name !== null && schedulerFields.has(name);
      });
    }
    if (!ts.isIdentifier(expression)) return false;
    const binding = lexicalBinding(expression);
    if (!binding || visited.has(binding)) return false;
    visited.add(binding);
    const declaration = binding.parent;
    const declarationList = declaration?.parent;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer ||
      !declarationList || !ts.isVariableDeclarationList(declarationList) ||
      (declarationList.flags & ts.NodeFlags.Const) === 0) return false;
    return sourceHasSchedulerField(declaration.initializer, visited);
  }

  const api = callee.expression.text;
  if (api === 'Object' && isUnshadowedGlobal(callee.expression, 'Object')) {
    if (callee.name.text === 'assign' && call.arguments.length > 1 &&
      receiverIsGatewayThis(call.arguments[0], tracksGatewayThis)) {
      return call.arguments.slice(1).some(source => sourceHasSchedulerField(source));
    }
    if (callee.name.text === 'defineProperty' && call.arguments.length > 2 &&
      receiverIsGatewayThis(call.arguments[0], tracksGatewayThis)) {
      const name = constantString(call.arguments[1]);
      return name !== null && schedulerFields.has(name);
    }
  }
  if (api === 'Reflect' && callee.name.text === 'set' &&
    isUnshadowedGlobal(callee.expression, 'Reflect') && call.arguments.length > 2 &&
    receiverIsGatewayThis(call.arguments[0], tracksGatewayThis)) {
    const name = constantString(call.arguments[1]);
    return name !== null && schedulerFields.has(name);
  }
  return false;
}

module.exports = { hasGatewaySchedulerReflectiveWrite };
