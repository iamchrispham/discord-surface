const ts = require('typescript');

function unwrap(expression, unwrapPolicyExpression) {
  return unwrapPolicyExpression ? unwrapPolicyExpression(expression) : expression;
}

function isUndefinedExpression(expression, isBound, unwrapPolicyExpression) {
  const value = unwrap(expression, unwrapPolicyExpression);
  if (!value) return false;
  if (ts.isVoidExpression(value) || ts.isOmittedExpression(value)) return true;
  return ts.isIdentifier(value) && value.text === 'undefined' && !isBound(value);
}

function finiteArgumentList(expression, unwrapPolicyExpression) {
  const value = unwrap(expression, unwrapPolicyExpression);
  if (!value || !ts.isArrayLiteralExpression(value)) return null;
  const result = argumentPrefix(value.elements, unwrapPolicyExpression);
  return result;
}

function argumentPrefix(argumentsList, unwrapPolicyExpression) {
  const args = [];
  for (const argument of argumentsList) {
    if (!ts.isSpreadElement(argument)) {
      args.push(argument);
      continue;
    }
    const expanded = finiteArgumentList(argument.expression, unwrapPolicyExpression);
    if (!expanded) return { args, complete: false };
    args.push(...expanded.args);
    if (!expanded.complete) return { args, complete: false };
  }
  return { args, complete: true };
}

function callPropertyName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression &&
      ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return null;
}

function effectiveCallArguments(call, {
  isBound = () => false,
  isCallableReference = () => false,
  resolveCallable = () => null,
  unwrapPolicyExpression,
} = {}) {
  const expression = call.expression;
  const method = callPropertyName(expression);
  if ((method !== 'call' && method !== 'apply') ||
      !(ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))) {
    const direct = argumentPrefix(call.arguments, unwrapPolicyExpression);
    return { target: expression, args: direct.args, complete: direct.complete, forwarded: false };
  }

  const receiver = expression.expression;
  if (!resolveCallable(receiver) && !isCallableReference(receiver)) {
    const direct = argumentPrefix(call.arguments, unwrapPolicyExpression);
    return { target: expression, args: direct.args, complete: direct.complete, forwarded: false };
  }

  if (method === 'call') {
    const direct = argumentPrefix(call.arguments.slice(1), unwrapPolicyExpression);
    return { target: receiver, args: direct.args, complete: direct.complete, forwarded: true };
  }

  const supplied = call.arguments[1];
  if (!supplied || isUndefinedExpression(supplied, isBound, unwrapPolicyExpression)) {
    return { target: receiver, args: [], complete: true, forwarded: true };
  }
  const expanded = finiteArgumentList(supplied, unwrapPolicyExpression);
  return {
    target: receiver,
    args: expanded?.args || [],
    complete: expanded?.complete || false,
    forwarded: true,
  };
}

function isTypePosition(node) {
  let current = node.parent;
  while (current) {
    if (ts.isTypeNode(current)) return true;
    current = current.parent;
  }
  return false;
}

function isSemanticIdentifierReference(node) {
  const parent = node.parent;
  if (!parent) return true;
  if (isTypePosition(node)) return false;
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isBindingElement(parent) && (parent.propertyName === node || parent.name === node)) return false;
  if ((ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) ||
      ts.isImportClause(parent)) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) && parent.propertyName === node) return false;
  if (ts.isExportSpecifier(parent) && parent.name === node && parent.propertyName) return false;
  if (ts.isNamespaceExport(parent) && parent.name === node) return false;
  if (ts.isEnumMember(parent) && parent.name === node) return false;
  if (ts.isClassExpression(parent) && parent.name === node) return false;
  if (ts.isTypeParameterDeclaration(parent) && parent.name === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) || ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) && parent.name === node) return false;
  if ((ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) || ts.isModuleDeclaration(parent)) && parent.name === node) {
    return false;
  }
  return true;
}

module.exports = {
  effectiveCallArguments,
  finiteArgumentList,
  isSemanticIdentifierReference,
  isUndefinedExpression,
};
