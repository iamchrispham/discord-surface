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

function bindingContainsName(binding, name) {
  if (ts.isIdentifier(binding)) return binding.text === name;
  if (ts.isArrayBindingPattern(binding) || ts.isObjectBindingPattern(binding)) {
    return binding.elements.some(element => !ts.isOmittedExpression(element) && bindingContainsName(element.name, name));
  }
  return false;
}

module.exports = { unwrapParentheses, unwrapTransparentExpression, bindingContainsName };
