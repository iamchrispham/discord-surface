const ts = require('typescript');

const { bindingIdentifiers, propertyName } = require('./handler-discovery-bindings');
const { statementCanFallThrough } = require('./handler-discovery-flow');

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
  let ambiguousExportWrite = false;
  const literalName = expression => expression &&
    (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) || ts.isNumericLiteral(expression))
    ? expression.text
    : null;
  const accessName = node => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node)) return literalName(node.argumentExpression);
    return null;
  };
  const isModuleExports = node => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === 'module' && node.name.text === 'exports') return true;
    return ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === 'module' && accessName(node) === 'exports';
  };
  const exportMember = node => {
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return null;
    const name = accessName(node);
    if (ts.isIdentifier(node.expression) && node.expression.text === 'exports') {
      return { source: 'alias', name };
    }
    if (isModuleExports(node.expression)) return { source: 'module', name };
    return null;
  };
  const exportObject = node => {
    if (ts.isIdentifier(node) && node.text === 'exports') return 'alias';
    if (isModuleExports(node)) return 'module';
    return null;
  };
  const exportWriteTarget = node => {
    const member = exportMember(node);
    if (member) return member;
    const sourceName = exportObject(node);
    return sourceName ? { source: sourceName, name: '*' } : null;
  };
  const isNamedExport = node => exportMember(node)?.name === factoryName;
  const exportWriteKey = node => {
    const target = exportWriteTarget(node);
    if (target?.name === factoryName) return factoryName;
    if (target?.name === '*') return '*';
    return null;
  };
  const exportWrites = node => {
    const writes = new Set();
    const visitWrites = current => {
      if (current !== node && ts.isFunctionLike(current)) return;
      if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const key = exportWriteKey(current.left);
        if (key) writes.add(key);
      }
      ts.forEachChild(current, visitWrites);
    };
    visitWrites(node);
    return writes;
  };
  const hasConflictingTryCatchWrites = node => {
    let conflicting = false;
    const visitTry = current => {
      if (conflicting) return;
      if (current !== node && ts.isFunctionLike(current)) return;
      if (ts.isTryStatement(current) && current.catchClause) {
        const tryWrites = exportWrites(current.tryBlock);
        const catchWrites = exportWrites(current.catchClause.block);
        const tryRewritesFactory = tryWrites.has('*') || tryWrites.has(factoryName);
        const catchRewritesFactory = catchWrites.has('*') || catchWrites.has(factoryName);
        if (tryWrites.size && catchWrites.size && (tryRewritesFactory || catchRewritesFactory)) {
          conflicting = true;
          return;
        }
      }
      ts.forEachChild(current, visitTry);
    };
    visitTry(node);
    return conflicting;
  };
  const getterShadowsFactory = getter => {
    let shadowed = getter.parameters?.some(parameter =>
      bindingIdentifiers(parameter.name).some(identifier => identifier.text === factoryName));
    const visit = current => {
      if (shadowed) return;
      if (current !== getter && ts.isFunctionLike(current)) {
        if (ts.isFunctionDeclaration(current) && current.name?.text === factoryName) shadowed = true;
        return;
      }
      if (ts.isVariableDeclaration(current) || ts.isClassDeclaration(current)) {
        let names = [];
        if (ts.isVariableDeclaration(current)) names = bindingIdentifiers(current.name);
        else if (current.name) names = [current.name];
        if (names.some(identifier => identifier.text === factoryName)) {
          shadowed = true;
          return;
        }
      }
      ts.forEachChild(current, visit);
    };
    visit(getter.body);
    return shadowed;
  };
  const getterExpression = node => {
    if (!ts.isObjectLiteralExpression(node)) return null;
    for (const property of node.properties) {
      if (propertyName(property.name) !== 'get') continue;
      let getter = null;
      if (property.initializer && ts.isFunctionLike(property.initializer)) getter = property.initializer;
      else if (ts.isMethodDeclaration(property)) getter = property;
      if (!getter) continue;
      if (getterShadowsFactory(getter) || getter.asteriskToken ||
          getter.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
        return { rejected: true };
      }
      const body = getter.body;
      if (!body || !ts.isBlock(body)) continue;
      if (statementCanFallThrough(body)) return { rejected: true };
      const returns = [];
      const collectReturns = node => {
        if (!node) return;
        if (node !== body && ts.isFunctionLike(node)) return;
        if (ts.isBlock(node) || ts.isSourceFile(node)) {
          let reachable = true;
          for (const statement of node.statements) {
            if (!reachable) break;
            collectReturns(statement);
            reachable = statementCanFallThrough(statement);
          }
          return;
        }
        if (ts.isReturnStatement(node)) {
          returns.push(node.expression || null);
          return;
        }
        ts.forEachChild(node, collectReturns);
      };
      collectReturns(body);
      if (!returns.length || returns.some(expression => !expression)) return { rejected: true };
      const firstText = returns[0].getText(source);
      if (returns.some(expression => expression.getText(source) !== firstText)) return { rejected: true };
      return { expression: returns[0] };
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
  const objectMayWriteFactory = expression => {
    if (!ts.isObjectLiteralExpression(expression)) return true;
    return expression.properties.some(property => {
      if (ts.isSpreadAssignment(property)) return true;
      const name = propertyName(property.name) ||
        (property.name && ts.isComputedPropertyName(property.name) ? literalName(property.name.expression) : null);
      return name === null || name === factoryName;
    });
  };
  const visit = node => {
    if (node !== source && ts.isFunctionLike(node)) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const target = exportWriteTarget(node.left);
      const aliasValid = target?.source !== 'alias' || exportsAliasValid;
      const affectsFactory = target && (target.name === '*' || target.name === factoryName || target.name === null);
      if (affectsFactory && aliasValid &&
          (!isTopLevelExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken || target.name === null)) {
        ambiguousExportWrite = true;
      }
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isTopLevelExpression(node) && aliasValid) {
        if (isNamedExport(node.left)) result = node.right;
        if (target?.name === '*') {
          exportsAliasValid = false;
          result = null;
          if (ts.isObjectLiteralExpression(node.right)) {
            if (objectMayWriteFactory(node.right) && node.right.properties.some(property =>
                ts.isSpreadAssignment(property) ||
                (property.name && ts.isComputedPropertyName(property.name) &&
                  literalName(property.name.expression) === null))) {
              ambiguousExportWrite = true;
            }
            for (const property of node.right.properties) {
              const computedName = property.name && ts.isComputedPropertyName(property.name)
                ? literalName(property.name.expression)
                : null;
              const name = propertyName(property.name) || computedName;
              if (name !== factoryName) continue;
              if (computedName !== null) ambiguousExportWrite = true;
              result = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
            }
          }
          else if (allowDefault || directRequire(node.right)) {
            result = node.right;
          }
        }
      }
    }
    const mutationExpression = ts.isDeleteExpression(node)
      ? node.expression
      : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
        ? node.operand
        : null;
    if (mutationExpression) {
      const target = exportWriteTarget(mutationExpression);
      const aliasValid = target?.source !== 'alias' || exportsAliasValid;
      if (aliasValid && target?.source &&
          (target.name === '*' || target.name === factoryName || target.name === null)) {
        ambiguousExportWrite = true;
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Object' &&
        ['defineProperty', 'defineProperties', 'assign'].includes(node.expression.name.text)) {
      const isDefineProperty = node.expression.name.text === 'defineProperty';
      const isDefineProperties = node.expression.name.text === 'defineProperties';
      let target = null;
      if (isDefineProperty && node.arguments.length >= 3) {
        target = { source: exportObject(node.arguments[0]), name: literalName(node.arguments[1]) };
      }
      else if (isDefineProperties && node.arguments.length >= 2) {
        target = { source: exportObject(node.arguments[0]), name: '*' };
      }
      else if (!isDefineProperty && node.arguments.length >= 2) {
        target = { source: exportObject(node.arguments[0]), name: factoryName };
      }
      const aliasValid = target?.source !== 'alias' || exportsAliasValid;
      const writesFactory = isDefineProperties
        ? objectMayWriteFactory(node.arguments[1])
        : isDefineProperty || node.arguments.slice(1).some(objectMayWriteFactory);
      if (target?.source && (target.name === '*' || target.name === factoryName || target.name === null) && writesFactory) {
        if (aliasValid && (!isTopLevelExpression(node) || target.name === null || !isDefineProperty)) {
          ambiguousExportWrite = true;
        }
        if (isTopLevelExpression(node) && isDefineProperty && target.name === factoryName) {
          const getter = getterExpression(node.arguments[2]);
          result = getter?.rejected ? null : getter?.expression || null;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  if (hasConflictingTryCatchWrites(source)) return null;
  visit(source);
  if (ambiguousExportWrite) return null;
  return result;
}

function reexportedModulePaths(source) {
  const paths = [];
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression) ||
        !ts.isIdentifier(statement.expression.expression) || statement.expression.expression.text !== '__exportStar') continue;
    const modulePath = directRequire(statement.expression.arguments[0]);
    if (modulePath) paths.push(modulePath);
  }
  return paths;
}

module.exports = { calledFactory, directRequire, exportedFactoryExpression, reexportedModulePaths };
