const ts = require('typescript');

const {
  callableDeclarations,
  declarationForIdentifier,
  destructuredBindings,
  isVarDeclaration,
  rootIdentifier,
  targetExpressions,
  unwrapExpression
} = require('./handler-discovery-lexical');

function mutatedDeclarations(factory, declarations, source) {
  const mutated = new Set();
  const aliases = new Map();
  const assignmentOperators = new Set([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.AsteriskAsteriskEqualsToken,
    ts.SyntaxKind.SlashEqualsToken,
    ts.SyntaxKind.PercentEqualsToken,
    ts.SyntaxKind.LessThanLessThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.AmpersandEqualsToken,
    ts.SyntaxKind.BarEqualsToken,
    ts.SyntaxKind.CaretEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken
  ]);
  const mark = expression => {
    for (const target of targetExpressions(expression)) {
      const identifier = rootIdentifier(target);
      const declaration = declarationForIdentifier(declarations, identifier, source);
      if (declaration) mutated.add(declaration);
    }
  };
  const link = (left, right) => {
    const leftDeclaration = declarationForIdentifier(declarations, rootIdentifier(left), source);
    const rightDeclaration = declarationForIdentifier(declarations, rootIdentifier(right), source);
    if (!leftDeclaration || !rightDeclaration || leftDeclaration === rightDeclaration) return;
    if (!aliases.has(leftDeclaration)) aliases.set(leftDeclaration, new Set());
    if (!aliases.has(rightDeclaration)) aliases.set(rightDeclaration, new Set());
    aliases.get(leftDeclaration).add(rightDeclaration);
    aliases.get(rightDeclaration).add(leftDeclaration);
  };
  const linkDestructured = (pattern, initializer) => {
    const pairs = destructuredBindings(pattern, initializer);
    if (pairs.length) {
      for (const [left, right] of pairs) link(left, right);
      return;
    }
    link(pattern, initializer);
  };
  const localHelper = declaration => {
    if (!declaration) return null;
    if (ts.isFunctionDeclaration(declaration)) return declaration;
    if (!ts.isVariableDeclaration(declaration)) return null;
    const value = unwrapExpression(declaration.initializer);
    return value && ts.isFunctionLike(value) ? value : null;
  };
  const helperMutatesParameter = (helper, parameterIndex) => {
    const parameters = helper.parameters || [];
    const lastParameter = parameters[parameters.length - 1];
    const parameter = parameters[parameterIndex] || (lastParameter?.dotDotDotToken ? lastParameter : null);
    if (!parameter) return false;
    if (!ts.isIdentifier(parameter.name)) return true;
    const parameterName = parameter.name.text;
    let mutatedParameter = false;
    const visitHelper = node => {
      if (mutatedParameter) return;
      if (node !== helper && ts.isFunctionLike(node)) return;
      if (ts.isBinaryExpression(node) && assignmentOperators.has(node.operatorToken.kind) &&
          rootIdentifier(node.left)?.text === parameterName) {
        mutatedParameter = true;
        return;
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node) ||
          ts.isDeleteExpression(node)) && rootIdentifier(node.operand || node.expression)?.text === parameterName) {
        mutatedParameter = true;
        return;
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          ['assign', 'defineProperty', 'defineProperties'].includes(node.expression.name.text) &&
          rootIdentifier(node.arguments[0])?.text === parameterName) {
        mutatedParameter = true;
        return;
      }
      if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
          rootIdentifier(node.initializer)?.text === parameterName) {
        mutatedParameter = true;
        return;
      }
      ts.forEachChild(node, visitHelper);
    };
    visitHelper(helper.body || helper);
    return mutatedParameter;
  };
  const varDeclarations = new Map();
  for (const item of declarations) {
    if (!isVarDeclaration(item.declaration)) continue;
    const key = `${item.scope?.pos}:${item.name}`;
    if (!varDeclarations.has(key)) varDeclarations.set(key, []);
    varDeclarations.get(key).push(item.declaration);
  }
  for (const items of varDeclarations.values()) {
    for (const declaration of items.slice(1)) mutated.add(declaration);
  }
  const visit = node => {
    if (node !== factory && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && node.initializer) {
      linkDestructured(node.name, node.initializer);
    }
    if (ts.isBinaryExpression(node) && assignmentOperators.has(node.operatorToken.kind)) mark(node.left);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      linkDestructured(node.left, node.right);
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
      mark(node.operand);
    }
    if (ts.isDeleteExpression(node)) mark(node.expression);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ['assign', 'defineProperty', 'defineProperties'].includes(node.expression.name.text) &&
        node.arguments.length) {
      mark(node.arguments[0]);
    }
    if (ts.isCallExpression(node)) {
      const helper = declarationForIdentifier(declarations, rootIdentifier(node.expression), source);
      const helperFunction = localHelper(helper);
      if (helperFunction) {
        node.arguments.forEach((argument, index) => {
          if (helperMutatesParameter(helperFunction, index)) mark(argument);
        });
      }
    }
    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) mark(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(factory);
  const pending = [...mutated];
  while (pending.length) {
    const declaration = pending.pop();
    for (const alias of aliases.get(declaration) || []) {
      if (mutated.has(alias)) continue;
      mutated.add(alias);
      pending.push(alias);
    }
  }
  return mutated;
}

function mutatedBindingNames(source, names) {
  const declarations = callableDeclarations(source, null);
  const mutated = mutatedDeclarations(source, declarations, source);
  return new Set(declarations
    .filter(item => names.has(item.name) && mutated.has(item.declaration))
    .map(item => item.name));
}

function factoryDeclaration(source, factoryName) {
  const bindings = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === factoryName) {
      bindings.push({ candidate: statement, binding: statement });
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== factoryName) continue;
      const candidate = declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
        ? declaration.initializer
        : null;
      bindings.push({ candidate, binding: declaration });
    }
  }
  if (bindings.length !== 1 || !bindings[0].candidate) return null;
  const [{ candidate, binding }] = bindings;
  const declarations = callableDeclarations(source, null);
  const mutated = mutatedDeclarations(source, declarations, source);
  return mutated.has(binding) ? null : candidate;
}

module.exports = { factoryDeclaration, mutatedBindingNames, mutatedDeclarations };
