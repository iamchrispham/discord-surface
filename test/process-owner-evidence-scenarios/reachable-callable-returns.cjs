'use strict';

const collectReachableReturnExpressions = (ts, callable) => {
  if (!callable?.body) return [];
  if (!ts.isBlock(callable.body)) return [callable.body];

  const returns = [];
  const walkSequence = statements => {
    for (const statement of statements) {
      if (!walkStatement(statement)) return false;
    }
    return true;
  };
  const walkStatement = statement => {
    if (ts.isBlock(statement)) return walkSequence(statement.statements);
    if (ts.isReturnStatement(statement)) {
      if (statement.expression) returns.push(statement.expression);
      return false;
    }
    if (ts.isThrowStatement(statement)) return false;
    if (ts.isIfStatement(statement)) {
      const thenCompletes = walkStatement(statement.thenStatement);
      const elseCompletes = statement.elseStatement
        ? walkStatement(statement.elseStatement) : true;
      return thenCompletes || elseCompletes;
    }
    if (ts.isTryStatement(statement)) {
      const mark = returns.length;
      const tryCompletes = walkStatement(statement.tryBlock);
      const catchCompletes = statement.catchClause
        ? walkStatement(statement.catchClause.block) : false;
      const pendingReturns = returns.splice(mark);
      if (!statement.finallyBlock) {
        returns.push(...pendingReturns);
        return tryCompletes || catchCompletes;
      }
      const finallyMark = returns.length;
      const finallyCompletes = walkStatement(statement.finallyBlock);
      const finallyReturns = returns.splice(finallyMark);
      returns.push(...finallyReturns);
      if (finallyCompletes) returns.push(...pendingReturns);
      return finallyCompletes && (tryCompletes || catchCompletes);
    }
    if (ts.isFunctionLike(statement)) return true;
    if (ts.isSwitchStatement(statement)) {
      for (const clause of statement.caseBlock.clauses) walkSequence(clause.statements);
      return true;
    }
    if (ts.isWhileStatement(statement) || ts.isDoStatement(statement) ||
      ts.isForStatement(statement) || ts.isForInStatement(statement) || ts.isForOfStatement(statement)) {
      walkStatement(statement.statement);
      return true;
    }
    if (ts.isLabeledStatement(statement)) {
      walkStatement(statement.statement);
      return true;
    }
    return true;
  };

  walkStatement(callable.body);
  return returns;
};

module.exports = collectReachableReturnExpressions;
