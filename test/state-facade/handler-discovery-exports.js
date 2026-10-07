const ts = require('typescript');

const { propertyName } = require('./handler-discovery-bindings');

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
  let exportsAliasValid = true;
  const isModuleExports = node => ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === 'module' && node.name.text === 'exports';
  const isExportsAlias = node => ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) && node.expression.text === 'exports';
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
  const isTopLevelExpression = node => {
    let current = node;
    while (current.parent && current.parent !== source) {
      current = current.parent;
      if ((ts.isBlock(current) && !ts.isTryStatement(current.parent)) || ts.isFunctionLike(current) ||
          ts.isIfStatement(current) || ts.isSwitchStatement(current) ||
          ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current) ||
          ts.isWhileStatement(current) || ts.isDoStatement(current) || ts.isCatchClause(current) ||
          ts.isConditionalExpression(current)) return false;
    }
    return current.parent === source;
  };
  const visit = node => {
    if (node !== source && ts.isFunctionLike(node)) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isTopLevelExpression(node)) {
      if (isNamedExport(node.left) && (!isExportsAlias(node.left) || exportsAliasValid)) result = node.right;
      if (isModuleExports(node.left)) {
        exportsAliasValid = false;
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
        ts.isStringLiteral(node.arguments[1]) && node.arguments[1].text === factoryName &&
        isTopLevelExpression(node)) {
      result = getterExpression(node.arguments[2]);
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

module.exports = { calledFactory, directRequire, exportedFactoryExpression, reexportedModulePaths };
