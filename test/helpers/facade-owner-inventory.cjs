'use strict';

function facadeOwnerInventory(ts, source, { ownerName, factoryName, facadeNames }) {
  const violations = [];
  const sites = [];
  let declarations = 0;
  function unwrap(node) {
    while (node && ts.isParenthesizedExpression(node)) node = node.expression;
    return node;
  }
  function identifier(node, name) {
    node = unwrap(node);
    return node && ts.isIdentifier(node) && node.text === name;
  }
  function singleDispatch(method, name) {
    if (!method.body || method.body.statements.length !== 1) return false;
    const statement = method.body.statements[0];
    if (!ts.isReturnStatement(statement)) return false;
    const call = unwrap(statement.expression);
    if (!call || !ts.isCallExpression(call) || call.questionDotToken || call.arguments.length !== 2 ||
      unwrap(call.arguments[0])?.kind !== ts.SyntaxKind.ThisKeyword || !identifier(call.arguments[1], 'arguments')) return false;
    const apply = unwrap(call.expression);
    const dotApply = apply && ts.isPropertyAccessExpression(apply) && !apply.questionDotToken && apply.name.text === 'apply';
    const bracketApply = apply && ts.isElementAccessExpression(apply) && !apply.questionDotToken &&
      ts.isStringLiteral(unwrap(apply.argumentExpression)) && unwrap(apply.argumentExpression).text === 'apply';
    if (!dotApply && !bracketApply) return false;
    const handler = unwrap(apply.expression);
    return ts.isPropertyAccessExpression(handler) && !handler.questionDotToken &&
      identifier(handler.expression, ownerName) && handler.name.text === name;
  }
  function visit(node) {
    if (ts.isIdentifier(node) && node.text === ownerName) {
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent) && parent.name === node &&
        ts.isVariableDeclarationList(parent.parent) &&
        ts.isVariableStatement(parent.parent.parent) && parent.parent.parent.parent === source &&
        parent.initializer && ts.isCallExpression(parent.initializer) &&
        ts.isIdentifier(parent.initializer.expression) && parent.initializer.expression.text === factoryName) {
        declarations++;
      } else {
        let ancestor = node;
        while (ancestor && !ts.isMethodDeclaration(ancestor) && !ts.isConstructorDeclaration(ancestor) &&
          !ts.isGetAccessorDeclaration(ancestor) && !ts.isSetAccessorDeclaration(ancestor)) ancestor = ancestor.parent;
        const name = ancestor?.name?.getText(source);
        let bodyAncestor = node;
        while (bodyAncestor && bodyAncestor !== ancestor?.body && bodyAncestor !== ancestor) bodyAncestor = bodyAncestor.parent;
        const admitted = ancestor && ts.isMethodDeclaration(ancestor) &&
          ts.isClassDeclaration(ancestor.parent) && ancestor.parent.name?.text === 'DiscordGateway' &&
          facadeNames.includes(name) && bodyAncestor === ancestor.body && singleDispatch(ancestor, name);
        if (admitted) sites.push(name);
        else violations.push(`unsupported ${ownerName} reference at ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (declarations !== 1) violations.push(`expected one ${ownerName} factory declaration`);
  if (sites.slice().sort().join(',') !== facadeNames.slice().sort().join(',')) violations.push(`unexpected ${ownerName} facade sites: ${sites.join(',')}`);
  return violations;
}

module.exports = { facadeOwnerInventory };
