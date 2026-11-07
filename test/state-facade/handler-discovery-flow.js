const ts = require('typescript');

function switchCanFallThrough(statement) {
  const clauses = statement.caseBlock.clauses;
  if (!clauses.some(clause => ts.isDefaultClause(clause))) return true;
  const clauseCanFallThrough = index => {
    if (index >= clauses.length) return true;
    const flow = statementFlow({ statements: clauses[index].statements });
    if (flow.breaks.size) return true;
    return flow.normal && clauseCanFallThrough(index + 1);
  };
  return clauses.some((_, index) => clauseCanFallThrough(index));
}

function statementFlow(statement) {
  if (statement?.statements) {
    let normal = true;
    const breaks = new Set();
    for (const child of statement.statements) {
      if (!normal) break;
      const flow = statementFlow(child);
      for (const target of flow.breaks) breaks.add(target);
      normal = flow.normal;
    }
    return { normal, breaks };
  }
  if (ts.isBlock(statement)) return statementFlow({ statements: statement.statements });
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || ts.isContinueStatement(statement)) {
    return { normal: false, breaks: new Set() };
  }
  if (ts.isBreakStatement(statement)) {
    return { normal: false, breaks: new Set([statement.label?.text || null]) };
  }
  if (ts.isIfStatement(statement)) {
    const condition = statement.expression;
    let constantCondition = condition;
    while (constantCondition && ts.isParenthesizedExpression(constantCondition)) constantCondition = constantCondition.expression;
    if (constantCondition.kind === ts.SyntaxKind.FalseKeyword) {
      return statement.elseStatement
        ? statementFlow(statement.elseStatement)
        : { normal: true, breaks: new Set() };
    }
    const thenFlow = statementFlow(statement.thenStatement);
    const elseFlow = statement.elseStatement ? statementFlow(statement.elseStatement) : { normal: true, breaks: new Set() };
    if (constantCondition.kind === ts.SyntaxKind.TrueKeyword) return thenFlow;
    const breaks = new Set([...thenFlow.breaks, ...elseFlow.breaks]);
    return {
      normal: thenFlow.normal || elseFlow.normal,
      breaks
    };
  }
  if (ts.isWhileStatement(statement) || ts.isDoStatement(statement) || ts.isForStatement(statement)) {
    const condition = ts.isForStatement(statement) ? statement.condition : statement.expression;
    let constantCondition = condition;
    while (constantCondition && ts.isParenthesizedExpression(constantCondition)) constantCondition = constantCondition.expression;
    const alwaysTrue = !condition || constantCondition.kind === ts.SyntaxKind.TrueKeyword;
    const alwaysFalse = !!condition && constantCondition.kind === ts.SyntaxKind.FalseKeyword;
    const bodyFlow = statementFlow(statement.statement);
    const breaks = new Set([...bodyFlow.breaks].filter(target => target !== null));
    if (ts.isDoStatement(statement)) {
      return {
        normal: bodyFlow.breaks.has(null) || (!alwaysTrue && bodyFlow.normal),
        breaks
      };
    }
    if (alwaysFalse) return { normal: true, breaks: new Set() };
    return {
      normal: !alwaysTrue || bodyFlow.breaks.has(null),
      breaks
    };
  }
  if (ts.isSwitchStatement(statement)) {
    const breaks = new Set();
    for (const clause of statement.caseBlock.clauses) {
      const flow = statementFlow({ statements: clause.statements });
      for (const target of flow.breaks) if (target !== null) breaks.add(target);
    }
    return { normal: switchCanFallThrough(statement), breaks };
  }
  if (ts.isTryStatement(statement)) {
    const tryFlow = statementFlow(statement.tryBlock);
    const catchFlow = statement.catchClause
      ? statementFlow(statement.catchClause.block)
      : { normal: false, breaks: new Set() };
    const combined = {
      normal: tryFlow.normal || catchFlow.normal,
      breaks: new Set([...tryFlow.breaks, ...catchFlow.breaks])
    };
    if (!statement.finallyBlock) return combined;
    const finallyFlow = statementFlow(statement.finallyBlock);
    if (!finallyFlow.normal) return finallyFlow;
    return {
      normal: combined.normal,
      breaks: new Set([...combined.breaks, ...finallyFlow.breaks])
    };
  }
  if (ts.isLabeledStatement(statement)) {
    const flow = statementFlow(statement.statement);
    if (!flow.breaks.has(statement.label.text)) return flow;
    const breaks = new Set(flow.breaks);
    breaks.delete(statement.label.text);
    return { normal: true, breaks };
  }
  return { normal: true, breaks: new Set() };
}

function statementCanFallThrough(statement) {
  return statementFlow(statement).normal;
}

function reachableReturnExpressions(factory) {
  const returns = [];
  const seenReturns = new Set();
  let supported = true;
  const collectStatements = statements => {
    let reachable = true;
    for (const statement of statements) {
      if (!reachable || !supported) break;
      collect(statement);
      reachable = statementCanFallThrough(statement);
    }
  };
  const collect = node => {
    if (!node || !supported) return;
    if (node !== factory && ts.isFunctionLike(node)) return;
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      collectStatements(node.statements);
      return;
    }
    if (ts.isReturnStatement(node)) {
      if (!seenReturns.has(node)) {
        seenReturns.add(node);
        returns.push(node.expression || null);
      }
      return;
    }
    if (ts.isIfStatement(node)) {
      let condition = node.expression;
      while (ts.isParenthesizedExpression(condition)) condition = condition.expression;
      if (condition.kind === ts.SyntaxKind.FalseKeyword) {
        collect(node.elseStatement);
      }
      else if (condition.kind === ts.SyntaxKind.TrueKeyword) {
        collect(node.thenStatement);
      }
      else {
        collect(node.thenStatement);
        collect(node.elseStatement);
      }
      return;
    }
    if (ts.isSwitchStatement(node)) {
      for (const clause of node.caseBlock.clauses) collectStatements(clause.statements);
      return;
    }
    if (ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isForStatement(node)) {
      const condition = ts.isForStatement(node) ? node.condition : node.expression;
      let constantCondition = condition;
      while (constantCondition && ts.isParenthesizedExpression(constantCondition)) constantCondition = constantCondition.expression;
      if (condition && constantCondition.kind !== ts.SyntaxKind.TrueKeyword &&
          constantCondition.kind !== ts.SyntaxKind.FalseKeyword) {
        supported = false;
        return;
      }
      const alwaysFalse = !!condition && constantCondition.kind === ts.SyntaxKind.FalseKeyword;
      if (ts.isDoStatement(node) || !alwaysFalse) collect(node.statement);
      return;
    }
    ts.forEachChild(node, collect);
  };
  if (factory.body && ts.isBlock(factory.body)) collect(factory.body);
  else if (factory.body) returns.push(factory.body);
  return supported ? returns : null;
}

module.exports = { reachableReturnExpressions, statementCanFallThrough };
