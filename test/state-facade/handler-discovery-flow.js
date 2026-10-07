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
    const thenFlow = statementFlow(statement.thenStatement);
    const elseFlow = statement.elseStatement ? statementFlow(statement.elseStatement) : { normal: true, breaks: new Set() };
    const breaks = new Set([...thenFlow.breaks, ...elseFlow.breaks]);
    return {
      normal: thenFlow.normal || elseFlow.normal,
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

module.exports = { statementCanFallThrough };
