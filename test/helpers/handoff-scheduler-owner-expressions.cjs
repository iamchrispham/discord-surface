'use strict';

const ts = require('typescript');

function unwrapParentheses(node) {
  let current = node;
  while (current && ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function unwrapTransparentExpression(node) {
  let current = node;
  while (current) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) ||
      (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(current))) {
      current = current.expression;
      continue;
    }
    break;
  }
  return current;
}

module.exports = { unwrapParentheses, unwrapTransparentExpression };
