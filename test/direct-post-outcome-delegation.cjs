'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const ts = require('typescript');
const root = '/reference/src';
const owner = path.join(root, 'state/direct-post/contracts.ts');
const expected = {
  'direct-post.ts': { outcomeFor: 1 },
  'state/direct-post.ts': { hasUnresolvedBindingPost: 2, recordDirectPostPreflight: 1, recordDirectPostOutcome: 1 },
  'state/town-hall-publication/journal.ts': { canonicalEvent: 1 },
  'state/town-hall-publication/repository.ts': { recordTownHallPublicationOutcome: 1 }
};
function unwrap(node) {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}
function inventory(files) {
  const sources = new Map(Object.entries(files).map(([file, text]) => {
    const filename = path.join(root, file);
    const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
    assert.equal(source.parseDiagnostics.length, 0, `source inventory refuses parse errors: ${filename}`);
    return [filename, source];
  }));
  const options = { noLib: true, allowJs: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = filename => sources.get(filename);
  host.resolveModuleNames = (names, filename) => names.map(name => {
    const base = path.resolve(path.dirname(filename), name);
    const resolved = [base, ...['.ts', '.js', '.mts', '.cts', '.d.ts'].map(extension => base + extension)].find(candidate => sources.has(candidate));
    if (!resolved) return undefined;
    return { resolvedFileName: resolved, extension: path.extname(resolved), isExternalLibraryImport: false };
  });
  const checker = ts.createProgram([...sources.keys()], options, host).getTypeChecker();
  const result = {};
  for (const [filename, source] of sources) {
    const relative = path.relative(root, filename);
    if (!expected[relative]) continue;
    const counts = {};
    function aliasRoot(symbol, seen = new Set()) {
      if (!symbol || seen.has(symbol)) return symbol;
      const next = new Set([...seen, symbol]);
      for (const declaration of symbol.declarations || []) {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isIdentifier(unwrap(declaration.initializer)))
          return aliasRoot(checker.getSymbolAtLocation(unwrap(declaration.initializer)), next);
      }
      return symbol;
    }
    function written(symbol) {
      if (!symbol) return false;
      let changed = false;
      function visit(node) {
        const assignment = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
        const update = (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator);
        const deletion = ts.isDeleteExpression(node);
        let target = assignment ? node.left : update || deletion ? node.operand || node.expression : undefined;
        if (target) {
          target = unwrap(target);
          if (ts.isIdentifier(target)) changed ||= checker.getSymbolAtLocation(target) === symbol;
          else {
            while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) target = unwrap(target.expression);
            changed ||= ts.isIdentifier(target) && aliasRoot(checker.getSymbolAtLocation(target)) === aliasRoot(symbol);
          }
        }
        ts.forEachChild(node, visit);
      }
      for (const moduleSource of sources.values()) visit(moduleSource);
      return changed;
    }
    function sharedPredicate(raw, seen = new Set()) {
      const expression = unwrap(raw);
      if (!(ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))) return false;
      if (!ts.isIdentifier(expression)) {
        let receiver = unwrap(expression.expression);
        while (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) receiver = unwrap(receiver.expression);
        if (ts.isIdentifier(receiver) && written(checker.getSymbolAtLocation(receiver))) return false;
      }
      const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
      if (!symbol || seen.has(symbol) || written(symbol)) return false;
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      if (written(target)) return false;
      const next = new Set([...seen, symbol, target]);
      for (const declaration of target.declarations || []) {
        if ((ts.isFunctionDeclaration(declaration) || ts.isVariableDeclaration(declaration)) && declaration.name?.getText() === 'isDirectPostOutcome' && declaration.getSourceFile().fileName === owner) return true;
        if (ts.isVariableDeclaration(declaration) && declaration.initializer && sharedPredicate(declaration.initializer, next)) return true;
      }
      return false;
    }
    function functionBoundary(node) {
      while (node && !ts.isFunctionLike(node)) node = node.parent;
      return node;
    }
    function decisionUse(node, seen = new Set()) {
      const boundary = functionBoundary(node);
      let child = node;
      for (let parent = node.parent; parent && !ts.isFunctionLike(parent); child = parent, parent = parent.parent) {
        if (ts.isReturnStatement(parent)) return true;
        if (ts.isIfStatement(parent)) return child === parent.expression;
        if (ts.isVariableDeclaration(parent) && child === parent.initializer && ts.isIdentifier(parent.name)) {
          const symbol = checker.getSymbolAtLocation(parent.name);
          if (!symbol || seen.has(symbol) || written(symbol)) return false;
          const next = new Set([...seen, symbol]);
          let used = false;
          function visit(reference) {
            if (ts.isIdentifier(reference) && reference !== parent.name && checker.getSymbolAtLocation(reference) === symbol
              && functionBoundary(reference) === functionBoundary(node) && decisionUse(reference, next)) used = true;
            ts.forEachChild(reference, visit);
          }
          visit(source);
          return used;
        }
        const transparent = ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isNonNullExpression(parent);
        const negation = ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken;
        const boolean = ts.isBinaryExpression(parent) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind);
        const condition = ts.isConditionalExpression(parent) && child === parent.condition;
        if (!(transparent || negation || boolean || condition)) return false;
      }
      return !!boundary && ts.isArrowFunction(boundary) && unwrap(boundary.body) === child;
    }
    function moduleFunction(node) {
      return !!node && ts.isFunctionDeclaration(node) && ts.isSourceFile(node.parent);
    }
    function consumerName(node) {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (!ts.isFunctionLike(parent)) continue;
        let wrapper = parent;
        while (wrapper.parent && unwrap(wrapper.parent) === wrapper) wrapper = wrapper.parent;
        const call = wrapper.parent;
        if (call && ts.isCallExpression(call) && decisionUse(call)) {
          const immediate = unwrap(call.expression) === parent;
          const transaction = ts.isPropertyAccessExpression(call.expression)
            && call.expression.name.text === 'transaction' && call.arguments[0] === wrapper;
          if (immediate || transaction) continue;
        }
        if (!parent.name || !(ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent))) return undefined;
        if (ts.isFunctionDeclaration(parent) && !moduleFunction(parent)) return undefined;
        if (ts.isMethodDeclaration(parent)) {
          const factory = functionBoundary(parent.parent);
          if (!moduleFunction(factory) || factory.name?.getText(source) !== 'createDirectPostHandlers' || !decisionUse(parent.parent)) return undefined;
        }
        return parent.name.getText(source);
      }
      return undefined;
    }
    function visit(node) {
      if (ts.isCallExpression(node) && sharedPredicate(node.expression) && decisionUse(node)) {
        const name = consumerName(node);
        if (name && Object.values(expected).some(group => Object.hasOwn(group, name))) counts[name] = (counts[name] || 0) + 1;
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    result[relative] = counts;
  }
  return result;
}
module.exports = { inventory };
