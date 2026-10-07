const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const values = ['sent', 'not_sent', 'rejected', 'rate_limited', 'unknown', 'stale'];
function parseSource(filename, text) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  assert.equal(source.parseDiagnostics.length, 0, `source inventory refuses parse errors: ${filename}`);
  return source;
}
function isOutcomeContractPath(value) {
  return /(?:^|[\\/])direct-post[\\/]contracts(?:\.(?:d\.ts|ts|js|cjs|mjs|mts|cts))?$/.test(value);
}
function detect(text, filename = '/fixture/probe.ts') {
  const source = parseSource(filename, text);
  const host = ts.createCompilerHost({ noLib: true, allowJs: true });
  const originalGet = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...args) => name === filename ? source : originalGet(name, ...args);
  const options = { noLib: true, allowJs: true };
  const modules = new Map();
  function collectModules(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      const specifier = node.arguments[0].text;
      const resolved = ts.resolveModuleName(specifier, filename, options, host).resolvedModule;
      if (resolved) modules.set(specifier, resolved.resolvedFileName);
    }
    ts.forEachChild(node, collectModules);
  }
  collectModules(source);
  const program = ts.createProgram([filename, ...modules.values()], options, host);
  const checker = program.getTypeChecker();
  function exportedSymbol(symbol) {
    if (!symbol) return undefined;
    for (const declaration of symbol.declarations || []) {
      if (!ts.isBindingElement(declaration) || !ts.isObjectBindingPattern(declaration.parent)
        || !ts.isVariableDeclaration(declaration.parent.parent) || !declaration.parent.parent.initializer) continue;
      const initializer = unwrap(declaration.parent.parent.initializer);
      if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)
        && initializer.expression.text === 'require' && checker.getSymbolAtLocation(initializer.expression)) return undefined;
    }
    return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  }
  function canonicalDomainSymbol(symbol) {
    const target = exportedSymbol(symbol);
    return (target?.declarations || []).some(declaration => ts.isVariableDeclaration(declaration)
      && ts.isIdentifier(declaration.name) && declaration.name.text === 'DIRECT_POST_OUTCOMES'
      && isOutcomeContractPath(declaration.getSourceFile().fileName));
  }
  function requiredExport(specifier, property) {
    const moduleFile = modules.get(specifier);
    const moduleSource = moduleFile && program.getSourceFile(moduleFile);
    const symbol = moduleSource && checker.getSymbolAtLocation(moduleSource);
    return symbol && checker.getExportsOfModule(symbol).find(exported => exported.name === property);
  }
  function unwrap(n) {
    while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isNonNullExpression(n)) n = n.expression;
    return n;
  }
  function importedDomain(decl) {
    if (!ts.isImportSpecifier(decl) || (decl.propertyName || decl.name).text !== 'DIRECT_POST_OUTCOMES') return false;
    const statement = decl.parent.parent.parent;
    return ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && isOutcomeContractPath(statement.moduleSpecifier.text);
  }
  function namespaceDomain(raw, property, seen = new Set()) {
    const base = unwrap(raw);
    if (ts.isCallExpression(base) && ts.isIdentifier(base.expression) && base.expression.text === 'require') {
      const symbol = checker.getSymbolAtLocation(base.expression);
      const shadowed = (symbol?.declarations || []).some(d => d.getSourceFile() === source);
      if (shadowed || base.arguments.length !== 1 || !ts.isStringLiteral(base.arguments[0])) return false;
      const specifier = base.arguments[0].text;
      const exported = requiredExport(specifier, property);
      return (property === 'DIRECT_POST_OUTCOMES' && isOutcomeContractPath(specifier)) || canonicalDomainSymbol(exported)
        || completeValues(symbolValue(exported, seen));
    }
    if (!ts.isIdentifier(base)) return false;
    const symbol = checker.getSymbolAtLocation(base);
    if (!symbol || seen.has(symbol) || mutated(symbol)) return false;
    const next = new Set([...seen, symbol]);
    return (symbol.declarations || []).some(d => (property === 'DIRECT_POST_OUTCOMES' && ts.isNamespaceImport(d)
      && ts.isImportDeclaration(d.parent.parent)
      && isOutcomeContractPath(d.parent.parent.moduleSpecifier.text))
      || (ts.isVariableDeclaration(d) && d.initializer && namespaceDomain(d.initializer, property, next)));
  }
  function aliasRoot(symbol, seen = new Set()) {
    if (!symbol || seen.has(symbol)) return symbol;
    const next = new Set([...seen, symbol]);
    for (const declaration of symbol.declarations || []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const initializer = unwrap(declaration.initializer);
        if (ts.isIdentifier(initializer)) return aliasRoot(checker.getSymbolAtLocation(initializer), next);
      }
    }
    return symbol;
  }
  function writeTargets(raw) {
    const node = unwrap(raw);
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return [node];
    if (ts.isArrayLiteralExpression(node) || ts.isArrayBindingPattern(node)) return node.elements.flatMap(writeTargets);
    if (ts.isObjectLiteralExpression(node) || ts.isObjectBindingPattern(node)) return node.properties
      ? node.properties.flatMap(writeTargets) : node.elements.flatMap(writeTargets);
    if (ts.isPropertyAssignment(node)) return writeTargets(node.initializer);
    if (ts.isShorthandPropertyAssignment(node)) return writeTargets(node.name);
    if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) return writeTargets(node.expression);
    if (ts.isBindingElement(node)) return writeTargets(node.name);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return writeTargets(node.left);
    return [];
  }
  function scanWrites(scope, visit, excludeNestedFunctions = false) {
    function scan(node) {
      if (excludeNestedFunctions && node !== scope && ts.isFunctionLike(node)) return;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) visit(node, writeTargets(node.left));
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) visit(node, writeTargets(node.operand));
      if (ts.isVariableDeclaration(node) && node.initializer) visit(node, writeTargets(node.name));
      if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
        if (ts.isVariableDeclarationList(node.initializer)) {
          for (const declaration of node.initializer.declarations) visit(declaration, writeTargets(declaration.name));
        } else visit(node, writeTargets(node.initializer));
      }
      ts.forEachChild(node, scan);
    }
    scan(scope);
  }
  function writeSymbol(target) {
    return ts.isShorthandPropertyAssignment(target.parent)
      ? checker.getShorthandAssignmentValueSymbol(target.parent) : checker.getSymbolAtLocation(target);
  }
  function initialBindingDeclaration(symbol) {
    let declaration = symbol?.declarations?.[0];
    if (declaration && ts.isBindingElement(declaration)) {
      while (declaration && !ts.isVariableDeclaration(declaration)) declaration = declaration.parent;
    }
    return declaration;
  }
  function symbolWritten(symbol) {
    let written = false;
    scanWrites(source, (node, targets) => {
      if (node === initialBindingDeclaration(symbol)) return;
      if (targets.some(target => ts.isIdentifier(target) && writeSymbol(target) === symbol)) written = true;
    });
    return written;
  }
  function mutationMethod(raw, seen = new Set()) {
    const node = unwrap(raw);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (!ts.isIdentifier(node)) return undefined;
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol || seen.has(symbol) || symbolWritten(symbol)) return undefined;
    const next = new Set([...seen, symbol]);
    for (const declaration of symbol.declarations || []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) return mutationMethod(declaration.initializer, next);
    }
    return undefined;
  }
  function mutated(symbol) {
    const target = aliasRoot(symbol);
    let changed = false;
    function rootSymbol(raw) {
      let expression = unwrap(raw);
      while (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) expression = unwrap(expression.expression);
      return aliasRoot(checker.getSymbolAtLocation(expression));
    }
    scanWrites(source, (node, targets) => {
      if (node === initialBindingDeclaration(symbol)) return;
      if (targets.some(expression => ts.isIdentifier(expression)
        ? writeSymbol(expression) === symbol : rootSymbol(expression) === target)) changed = true;
    });
    function visit(node) {
      if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
        const access = node.expression;
        const method = ts.isPropertyAccessExpression(access) ? access.name.text : mutationMethod(access.argumentExpression);
        if (['push', 'pop', 'shift', 'unshift', 'splice', 'fill', 'copyWithin', 'sort', 'reverse', 'add', 'delete', 'clear', 'set', 'compile'].includes(method)
          && rootSymbol(access.expression) === target) changed = true;
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    return changed;
  }
  function mutatedReceiver(raw) {
    let receiver = unwrap(raw);
    while (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) receiver = unwrap(receiver.expression);
    return ts.isIdentifier(receiver) && mutated(checker.getSymbolAtLocation(receiver));
  }
  function symbolValue(symbol, seen) {
    if (!symbol || seen.has(symbol) || mutated(symbol)) return undefined;
    const target = exportedSymbol(symbol);
    if (!target || seen.has(target)) return undefined;
    const next = new Set([...seen, symbol, target]);
    for (const declaration of target.declarations || []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer)
        return staticValue(declaration.initializer, next);
    }
    return undefined;
  }
  function staticValue(raw, seen = new Set()) {
    const n = unwrap(raw);
    if (ts.isStringLiteralLike(n)) return n.text;
    if (ts.isIdentifier(n)) {
      return symbolValue(checker.getSymbolAtLocation(n), seen);
    }
    if (ts.isArrayLiteralExpression(n)) {
      const result = [];
      for (const element of n.elements) {
        const value = staticValue(ts.isSpreadElement(element) ? element.expression : element, seen);
        if (ts.isSpreadElement(element)) {
          if (!Array.isArray(value)) return undefined;
          result.push(...value);
        } else result.push(value);
      }
      return result;
    }
    if (ts.isObjectLiteralExpression(n)) {
      const result = Object.create(null);
      for (const property of n.properties) {
        if (!ts.isPropertyAssignment(property)) return undefined;
        const name = ts.isComputedPropertyName(property.name)
          ? staticValue(property.name.expression, seen)
          : property.name.text;
        if (typeof name !== 'string') return undefined;
        result[name] = staticValue(property.initializer, seen);
      }
      return result;
    }
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      if (mutatedReceiver(n.expression)) return undefined;
      const resolved = symbolValue(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(n) ? n.name : n), seen);
      if (resolved !== undefined) return resolved;
      const object = staticValue(n.expression, seen);
      const key = ts.isPropertyAccessExpression(n) ? n.name.text : staticValue(n.argumentExpression, seen);
      if (object && typeof object === 'object' && Object.hasOwn(object, key)) return object[key];
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const base = unwrap(n.expression.expression);
      if (ts.isIdentifier(base) && base.text === 'Object' && !checker.getSymbolAtLocation(base) && n.arguments.length === 1) {
        const value = staticValue(n.arguments[0], seen);
        if (n.expression.name.text === 'freeze') return value;
        if (n.expression.name.text === 'values' && value && typeof value === 'object') return Object.values(value);
      }
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && !checker.getSymbolAtLocation(n.expression) && n.arguments?.length === 1) {
      const value = staticValue(n.arguments[0], seen);
      if (n.expression.text === 'Set') return value;
      if (n.expression.text === 'Map' && Array.isArray(value) && value.every(entry => Array.isArray(entry) && entry.length === 2))
        return value.map(entry => entry[0]);
    }
    return undefined;
  }
  function completeValues(candidate) {
    return Array.isArray(candidate) && candidate.length === values.length
      && values.every(value => candidate.includes(value));
  }
  function fullDomain(raw, seen = new Set()) {
    const n = unwrap(raw);
    if (completeValues(staticValue(n))) return true;
    if (ts.isPropertyAccessExpression(n)) {
      if (mutatedReceiver(n.expression)) return false;
      const property = checker.getSymbolAtLocation(n.name);
      if (canonicalDomainSymbol(property)) return true;
      if (namespaceDomain(n.expression, n.name.text)) return true;
    }
    if (ts.isIdentifier(n)) {
      const symbol = checker.getSymbolAtLocation(n);
      if (!symbol || seen.has(symbol) || mutated(symbol)) return false;
      const next = new Set([...seen, symbol]);
      if (symbol.flags & ts.SymbolFlags.Alias) {
        if (canonicalDomainSymbol(symbol)) return true;
      }
      return (symbol.declarations || []).some(d => importedDomain(d)
        || (ts.isVariableDeclaration(d) && d.initializer && fullDomain(d.initializer, next))
        || (ts.isBindingElement(d) && !d.initializer && ts.isObjectBindingPattern(d.parent)
          && ts.isVariableDeclaration(d.parent.parent) && d.parent.parent.initializer
          && namespaceDomain(unwrap(d.parent.parent.initializer), (d.propertyName || d.name).getText(source))));
    }
    if (ts.isArrayLiteralExpression(n)) {
      const literals = n.elements.map(unwrap);
      return literals.length === values.length && literals.every(ts.isStringLiteralLike)
        && values.every(v => literals.some(x => x.text === v));
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const base = unwrap(n.expression.expression);
      const local = ts.isIdentifier(base) && checker.getSymbolAtLocation(base);
      return base.getText(source) === 'Object' && !local && ['values', 'freeze'].includes(n.expression.name.text)
        && n.arguments.length === 1 && fullDomain(n.arguments[0], seen);
    }
    if (ts.isNewExpression(n) && unwrap(n.expression).getText(source) === 'Set' && !checker.getSymbolAtLocation(unwrap(n.expression))) {
      return n.arguments?.length === 1 && fullDomain(n.arguments[0], seen);
    }
    return false;
  }
  function alternatives(n) {
    n = unwrap(n);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      return [...alternatives(n.left), ...alternatives(n.right)];
    return [n];
  }
  function completeEquality(n) {
    const pairs = alternatives(n).map(item => {
      if (!ts.isBinaryExpression(item) || ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(item.operatorToken.kind)) return null;
      const a = unwrap(item.left), b = unwrap(item.right);
      const left = staticValue(a), right = staticValue(b);
      if (typeof left === 'string' && values.includes(left)) return [b.getText(source), left];
      if (typeof right === 'string' && values.includes(right)) return [a.getText(source), right];
      return null;
    });
    return pairs.length === values.length && pairs.every(Boolean) && pairs.every(p => p[0] === pairs[0][0])
      && values.every(v => pairs.some(p => p[1] === v));
  }
  function dynamicSearch(raw, excludedScope) {
    const expression = unwrap(raw);
    if (!(ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))) return false;
    let base = expression;
    while (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base)) base = unwrap(base.expression);
    let local = false;
    function visit(node) {
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (excludedScope && (symbol?.declarations || []).some(declaration => declaration.pos >= excludedScope.pos && declaration.end <= excludedScope.end)) local = true;
      }
      ts.forEachChild(node, visit);
    }
    visit(expression);
    return !local && staticValue(expression) === undefined;
  }
  function comparesElement(call) {
    const callback = call.arguments[0];
    if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || callback.parameters.length < 1) return false;
    const parameter = callback.parameters[0].name;
    if (!ts.isIdentifier(parameter)) return false;
    let body = callback.body;
    if (ts.isBlock(body)) {
      if (body.statements.length !== 1 || !ts.isReturnStatement(body.statements[0]) || !body.statements[0].expression) return false;
      body = body.statements[0].expression;
    }
    body = unwrap(body);
    if (!ts.isBinaryExpression(body) || ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(body.operatorToken.kind)) return false;
    const symbol = checker.getSymbolAtLocation(parameter);
    return [[body.left, body.right], [body.right, body.left]].some(([element, searched]) => {
      const other = unwrap(searched);
      return checker.getSymbolAtLocation(unwrap(element)) === symbol
        && checker.getSymbolAtLocation(other) !== symbol && dynamicSearch(other, callback);
    });
  }
  function indexMembership(call) {
    if (call.arguments.length !== 1 || !dynamicSearch(call.arguments[0])) return false;
    let expression = call, parent = call.parent;
    while (parent && ts.isParenthesizedExpression(parent)) { expression = parent; parent = parent.parent; }
    if (!parent || !ts.isBinaryExpression(parent)) return false;
    let compared, operator = parent.operatorToken.kind;
    if (parent.left === expression) compared = unwrap(parent.right);
    else if (parent.right === expression) {
      compared = unwrap(parent.left);
      const reversed = new Map([
        [ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken],
        [ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanToken],
        [ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken],
        [ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanEqualsToken]
      ]);
      operator = reversed.get(operator) || operator;
    } else return false;
    const zero = ts.isNumericLiteral(compared) && compared.text === '0';
    const minusOne = ts.isPrefixUnaryExpression(compared) && compared.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(compared.operand) && compared.operand.text === '1';
    return (zero && [ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanToken].includes(operator))
      || (minusOne && [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.GreaterThanToken].includes(operator));
  }
  function regexPattern(raw, seen = new Set()) {
    const n = unwrap(raw);
    if (ts.isRegularExpressionLiteral(n)) return n.text.slice(1, n.text.lastIndexOf('/'));
    if ((ts.isNewExpression(n) || ts.isCallExpression(n)) && ts.isIdentifier(n.expression) && n.expression.text === 'RegExp'
      && !checker.getSymbolAtLocation(n.expression) && n.arguments?.length >= 1) {
      const pattern = staticValue(n.arguments[0]);
      return typeof pattern === 'string' ? pattern : regexPattern(n.arguments[0], seen);
    }
    if (!(ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))) return undefined;
    if (!ts.isIdentifier(n) && mutatedReceiver(n.expression)) return undefined;
    const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(n) ? n.name : n);
    if (!symbol || seen.has(symbol) || mutated(symbol)) return undefined;
    const target = exportedSymbol(symbol);
    if (!target || seen.has(target)) return undefined;
    const next = new Set([...seen, symbol, target]);
    for (const declaration of target.declarations || []) {
      if ((ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) && declaration.initializer)
        return regexPattern(declaration.initializer, next);
    }
    return undefined;
  }
  function regexMembership(call, method) {
    if (!['test', 'exec'].includes(method) || call.arguments.length !== 1 || !dynamicSearch(call.arguments[0])) return false;
    let pattern = regexPattern(call.expression.expression);
    if (typeof pattern !== 'string' || !pattern.startsWith('^') || !pattern.endsWith('$')) return false;
    pattern = pattern.slice(1, -1);
    if (pattern.startsWith('(?:') && pattern.endsWith(')')) pattern = pattern.slice(3, -1);
    else if (pattern.startsWith('(') && pattern.endsWith(')')) pattern = pattern.slice(1, -1);
    const alternatives = pattern.split('|').map(value => value.replace(/^\^/, '').replace(/\$$/, ''));
    return completeValues(alternatives);
  }
  function loopSearch(raw, loop, seen = new Set()) {
    const expression = unwrap(raw);
    if (dynamicSearch(expression, loop)) return true;
    if (!ts.isIdentifier(expression)) return false;
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol || seen.has(symbol) || mutated(symbol)) return false;
    const next = new Set([...seen, symbol]);
    return (symbol.declarations || []).some(declaration => ts.isVariableDeclaration(declaration)
      && declaration.pos >= loop.pos && declaration.end <= loop.end && declaration.initializer
      && loopSearch(declaration.initializer, loop, next));
  }
  function loopResult(assignment, loop) {
    const symbol = checker.getSymbolAtLocation(unwrap(assignment.left));
    let owner = loop.parent;
    while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
    if (!owner || !symbol) return false;
    const writes = [];
    scanWrites(owner, (node, targets) => {
      if (node !== assignment && targets.some(target => ts.isIdentifier(target)
        && writeSymbol(target) === symbol)) writes.push(node);
    }, true);
    function retained(raw, capture, seen = new Set()) {
      const expression = unwrap(raw);
      if (!ts.isIdentifier(expression)) return false;
      const target = checker.getSymbolAtLocation(expression);
      if (!target || seen.has(target)) return false;
      if (target === symbol) return capture >= loop.end && !writes.some(write => write.pos >= loop.pos && write.pos < capture);
      if (mutated(target)) return false;
      const next = new Set([...seen, target]);
      return (target.declarations || []).some(declaration => ts.isVariableDeclaration(declaration)
        && declaration.initializer && declaration.pos < capture && retained(declaration.initializer, declaration.pos, next));
    }
    let returned = false;
    function visit(node) {
      if (node !== owner && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression && retained(node.expression, node.pos)) returned = true;
      ts.forEachChild(node, visit);
    }
    visit(owner);
    return returned;
  }
  function loopMembership(loop) {
    if (!ts.isForOfStatement(loop) || !fullDomain(loop.expression)
      || !ts.isVariableDeclarationList(loop.initializer) || loop.initializer.declarations.length !== 1) return false;
    const declaration = loop.initializer.declarations[0];
    if (!ts.isIdentifier(declaration.name)) return false;
    const symbol = checker.getSymbolAtLocation(declaration.name);
    if (!symbol || mutated(symbol)) return false;
    let matched = false;
    function visit(node) {
      if (ts.isFunctionLike(node)) return;
      if (ts.isIfStatement(node)) {
        const comparison = unwrap(node.expression);
        if (ts.isBinaryExpression(comparison) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(comparison.operatorToken.kind)) {
          const compares = [[comparison.left, comparison.right], [comparison.right, comparison.left]].some(([element, searched]) =>
            checker.getSymbolAtLocation(unwrap(element)) === symbol && loopSearch(searched, loop));
          let decision = false;
          function returnsBoolean(child) {
            if (ts.isFunctionLike(child)) return;
            if (ts.isReturnStatement(child) && child.expression
              && [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(unwrap(child.expression).kind)) decision = true;
            if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.EqualsToken
              && ts.isIdentifier(unwrap(child.left))
              && [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(unwrap(child.right).kind)
              && loopResult(child, loop)) decision = true;
            ts.forEachChild(child, returnsBoolean);
          }
          returnsBoolean(node.thenStatement);
          matched ||= compares && decision;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(loop.statement);
    return matched;
  }
  const findings = [];
  function visit(n) {
    let method;
    if (ts.isCallExpression(n)) {
      if (ts.isPropertyAccessExpression(n.expression)) method = n.expression.name.text;
      else if (ts.isElementAccessExpression(n.expression)) method = staticValue(n.expression.argumentExpression);
    }
    const directMembership = ['includes', 'has'].includes(method) || (method === 'indexOf' && indexMembership(n));
    const callbackMembership = ['some', 'find'].includes(method) && comparesElement(n);
    const membership = (directMembership || callbackMembership) && fullDomain(n.expression.expression);
    const disjunction = ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.BarBarToken
      && !(ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) && completeEquality(n);
    const switchCases = ts.isSwitchStatement(n) && values.every(v => n.caseBlock.clauses.some(c => ts.isCaseClause(c) && staticValue(c.expression) === v));
    const loop = loopMembership(n);
    const regex = ts.isCallExpression(n) && regexMembership(n, method);
    if (membership || disjunction || switchCases || loop || regex) findings.push({ line: source.getLineAndCharacterOfPosition(n.getStart()).line + 1 });
    ts.forEachChild(n, visit);
  }
  visit(source);
  return findings;
}

const { inventory } = require('./direct-post-outcome-delegation.cjs');

function predicateDefinitions(text) {
  const source=parseSource('contracts.ts',text);
  const found=[];
  function visit(n){if((ts.isFunctionDeclaration(n)||ts.isVariableDeclaration(n))&&n.name&&ts.isIdentifier(n.name)&&n.name.text==='isDirectPostOutcome')found.push(n);ts.forEachChild(n,visit);}
  visit(source);return found.length;
}
function declaresFunction(text,name) {
 const source=parseSource('probe.ts',text);
 return source.statements.some(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
}

function collectSourceSnapshots(sourceRoot) {
  const snapshots = {};
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('source inventory rejects symlinks');
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile() && /\.(?:ts|js|cjs|mjs|mts|cts|tsx|jsx)$/.test(entry.name)) {
        snapshots[path.relative(sourceRoot, filename).split(path.sep).join('/')] = fs.readFileSync(filename, 'utf8');
      }
    }
  }
  visit(sourceRoot);
  return snapshots;
}

module.exports={detect,values,inventory,predicateDefinitions,declaresFunction,collectSourceSnapshots};
