'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { createLocalModuleResolver } = require('./local-module-resolver.cjs');

const SRC_ROOT = path.join(__dirname, '..', '..', 'src');

// Static owner-site inventory. Invariant: every statically detected PID
// liveness probe (`process.kill(pid, 0)` in any resolved lexical form) and
// every legacy destructive `directPostOwnerAlive` call must surface through
// lexical binding identity or become a violation. Resolution is checker-symbol
// based, never identifier spelling; any possibly-probe value wins. This reads
// source text only -- fixture snippets are never executed, and an expression
// that cannot be resolved statically is refused rather than guessed at or
// evaluated at runtime.

const PRESERVED_PROBES = new Map([
  ['state/intake.js\u0000processAlive', 'independent EPERM-hold sibling probe, deferred from this class fix'],
  ['claude/socket-ownership/lock-owner.ts\u0000isSocketLockOwnerAlive', 'socket lock-owner liveness, distinct lock domain'],
  ['cli/gateway-process.js\u0000gatewayProcessStatus', 'gateway runtime supervision'],
  ['cli/gateway-process.js\u0000waitForExit', 'gateway runtime exit wait'],
  ['cli/runtime-lifecycle.js\u0000stop', 'runtime shutdown'],
  ['cli/runtime-custody.js\u0000acquireHeldLock', 'generated lock guardian, distinct existing supervision domain'],
  ['state.js\u0000probePid', 'injected probe dependency feeding the typed process-owner classifier']
]);

// Static value vocabulary for the owner-site classifier. A receiver resolves to
// a SET of these atoms because a mutable symbol may hold different values at
// different program points; the classifier treats any possible probe as real.
//   'process-object'         -> the Node process object
//   'pid-probe'              -> a potential process.kill liveness-probe target
//   'legacy-owner'           -> the directPostOwnerAlive destructive check
// Numeric/string literals are also stored as atoms to classify the signal
// argument of a probe invocation.
const PID_PROBE = 'pid-probe';
const PROCESS_OBJECT = 'process-object';
const LEGACY_OWNER = 'legacy-owner';
const GLOBAL_OBJECT = 'global-object';
const UNDEFINED_VALUE = 'undefined-value';
// A process.kill bind with arguments beyond `thisArg` is only partially
// visible at the later call site. Refuse it rather than dropping the bound
// arguments and silently accepting a zero-signal probe.
const BOUND_PROBE = 'bound-process-probe';
const BOUND_REFLECT_APPLY = 'bound-reflect-apply';
// Indirect `.call`/`.apply` of a probe: invoking one is refused, never guessed.
const CALL_METHOD = 'probe-call-method';
const APPLY_METHOD = 'probe-apply-method';
const INVOCATION_METHODS = [CALL_METHOD, APPLY_METHOD];
// Global `Reflect.apply`: invoking it on a probe is refused.
const REFLECT_OBJECT = 'reflect-object';
const REFLECT_APPLY = 'reflect-apply';
const REFLECT_CALL_METHOD = 'reflect-call-method';
const REFLECT_APPLY_METHOD = 'reflect-apply-method';
const FORWARDED_CALLBACK_APIS = new Set(['setImmediate', 'setTimeout', 'setInterval']);

function sourceFiles(root) {
  const found = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|ts|cjs)$/.test(entry.name)) found.push(full);
    }
  };
  walk(root);
  return found;
}

function enclosingOwner(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isFunctionExpression(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText();
    if (ts.isPropertyAssignment(current) && current.name &&
      (ts.isFunctionExpression(current.initializer) || ts.isArrowFunction(current.initializer))) {
      return current.name.getText();
    }
    if (ts.isPropertyDeclaration(current) && current.name && current.initializer &&
      (ts.isFunctionExpression(current.initializer) || ts.isArrowFunction(current.initializer))) {
      return current.name.getText();
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer &&
      (ts.isFunctionExpression(current.initializer) || ts.isArrowFunction(current.initializer))) {
      return current.name.text;
    }
    if (ts.isClassDeclaration(current)) return null;
    current = current.parent;
  }
  return null;
}

function parseOwnerSites(fileName, text, generatedOwner = null, moduleResolver = null, sourcePath = null) {
  const kind = fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const virtualPath = path.resolve(sourcePath || fileName);
  const options = { noLib: true, noResolve: true, allowJs: true };
  const sourceFile = ts.createSourceFile(virtualPath, text, ts.ScriptTarget.Latest, true, kind);
  const host = ts.createCompilerHost(options);
  host.getSourceFile = name => path.resolve(name) === virtualPath ? sourceFile : undefined;
  const program = ts.createProgram([virtualPath], options, host);
  const checker = program.getTypeChecker();
  const kills = [];
  const legacyCalls = [];
  // Per-file parse refusals. Merged into the caller's violation list in
  // occurrence order so a nested generated-source scan keeps its own order.
  const violations = [];

  // Class-first assignment index keyed by the checker symbol of the left-hand
  // side. Covers plain `name = ...` and object-destructuring assignment
  // `({ kill: probe } = process)`, where each target identifier receives the
  // named property of the right-hand side -- not the whole right-hand side, and
  // never the pattern's text. A mutable symbol is resolved over its initializer
  // AND every assignment anywhere in the file, regardless of flow order, so a
  // possible probe cannot be erased by a later ordinary assignment.
  const assignments = new Map();
  const memberAssignments = new Map();
  const pendingMemberAssignments = [];
  const parameterArguments = new Map();
  const recordAssignment = (symbol, value) => {
    if (!symbol) return;
    const existing = assignments.get(symbol);
    if (existing) existing.push(value);
    else assignments.set(symbol, [value]);
  };
  const recordMemberAssignment = (access, value) => {
    pendingMemberAssignments.push({ access, value });
  };
  const hasAtom = (set, atom) => Boolean(set) && set.has(atom);
  const indexMemberAssignmentsForTarget = (target, names, value) => {
    if (!names.length) return;
    const receivers = receiverSymbols(target);
    for (const constructor of prototypeConstructorSymbols(target)) receivers.add(constructor);
    for (const receiver of receivers) {
      let byName = memberAssignments.get(receiver);
      if (!byName) {
        byName = new Map();
        memberAssignments.set(receiver, byName);
      }
      for (const name of names) {
        const existing = byName.get(String(name));
        if (existing) existing.push(value);
        else byName.set(String(name), [value]);
      }
    }
  };
  const indexMemberAssignment = (access, value) => {
    indexMemberAssignmentsForTarget(access.expression, staticPropertyNames(access, true), value);
  };
  const recordParameterArgument = (symbol, value, name = null) => {
    if (!symbol || !value) return;
    const existing = parameterArguments.get(symbol);
    const entry = name ? { source: value, name } : value;
    if (existing) existing.push(entry);
    else parameterArguments.set(symbol, [entry]);
  };
  const recordRestParameterArguments = (symbol, values) => {
    if (!symbol) return;
    const entries = values.filter(Boolean).map((source, index) => ({ source, restIndex: index }));
    if (!entries.length) return;
    const existing = parameterArguments.get(symbol);
    if (existing) existing.push(...entries);
    else parameterArguments.set(symbol, entries);
  };
  const symbolDeclaration = symbol => {
    if (!symbol) return null;
    if (symbol.valueDeclaration) return symbol.valueDeclaration;
    const declarations = symbol.declarations || [];
    return declarations.length === 1 &&
      (ts.isVariableDeclaration(declarations[0]) || ts.isBindingElement(declarations[0]) ||
        ts.isPropertyAssignment(declarations[0]) || ts.isShorthandPropertyAssignment(declarations[0]) ||
        ts.isPropertyDeclaration(declarations[0]))
      ? declarations[0] : null;
  };
  const receiverSymbols = (node, visited = new Set()) => {
    const symbols = new Set();
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol || visited.has(symbol)) return symbols;
    const seen = new Set(visited).add(symbol);
    symbols.add(symbol);
    const declaration = symbolDeclaration(symbol);
    if (declaration && (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) &&
      declaration.initializer) {
      for (const nested of receiverSymbols(declaration.initializer, seen)) symbols.add(nested);
    }
    for (const assigned of assignments.get(symbol) || []) {
      const source = assigned && assigned.source ? assigned.source : assigned;
      if (!source) continue;
      for (const nested of receiverSymbols(source, seen)) symbols.add(nested);
    }
    for (const argument of parameterArguments.get(symbol) || []) {
      const source = argument && argument.source ? argument.source : argument;
      if (!source) continue;
      for (const nested of receiverSymbols(source, seen)) symbols.add(nested);
    }
    return symbols;
  };
  const prototypeConstructorSymbols = node => {
    const target = node && (ts.isParenthesizedExpression(node) ? node.expression : node);
    let constructor = null;
    if (ts.isPropertyAccessExpression(target) && target.name.text === 'prototype') {
      constructor = target.expression;
    } else if (ts.isElementAccessExpression(target) && ts.isStringLiteral(target.argumentExpression) &&
      target.argumentExpression.text === 'prototype') {
      constructor = target.expression;
    }
    const symbol = constructor && checker.getSymbolAtLocation(constructor);
    return symbol ? new Set([symbol]) : new Set();
  };
  const instanceConstructorSymbols = (node, visited = new Set()) => {
    const target = node && (ts.isParenthesizedExpression(node) ? node.expression : node);
    if (!target) return new Set();
    if (ts.isNewExpression(target)) {
      const symbol = checker.getSymbolAtLocation(target.expression);
      return symbol ? new Set([symbol]) : new Set();
    }
    if (!ts.isIdentifier(target)) return new Set();
    const symbol = checker.getSymbolAtLocation(target);
    if (!symbol || visited.has(symbol)) return new Set();
    const seen = new Set(visited).add(symbol);
    const result = new Set();
    const directDeclaration = symbol.valueDeclaration || symbol.declarations?.[0];
    if (directDeclaration && (ts.isFunctionDeclaration(directDeclaration) ||
      ts.isClassDeclaration(directDeclaration))) return new Set([symbol]);
    const declaration = symbolDeclaration(symbol);
    if (declaration && (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) &&
      declaration.initializer) {
      for (const nested of instanceConstructorSymbols(declaration.initializer, seen)) result.add(nested);
    }
    for (const assigned of assignments.get(symbol) || []) {
      const source = assigned && assigned.source ? assigned.source : assigned;
      for (const nested of instanceConstructorSymbols(source, seen)) result.add(nested);
    }
    return result;
  };
  const processImportAtom = symbol => {
    for (const declaration of symbol?.declarations || []) {
      if (ts.isImportEqualsDeclaration(declaration)) {
        const reference = declaration.moduleReference;
        const moduleName = reference && ts.isExternalModuleReference(reference)
          ? reference.expression : null;
        if (ts.isStringLiteral(moduleName) &&
          (moduleName.text === 'node:process' || moduleName.text === 'process')) return PROCESS_OBJECT;
        continue;
      }
      let importDeclaration = declaration;
      while (importDeclaration && !ts.isImportDeclaration(importDeclaration)) {
        importDeclaration = importDeclaration.parent;
      }
      if (!importDeclaration || !ts.isStringLiteral(importDeclaration.moduleSpecifier)) continue;
      if (importDeclaration.moduleSpecifier.text !== 'node:process' &&
        importDeclaration.moduleSpecifier.text !== 'process') continue;
      const importClause = importDeclaration.importClause;
      if (importClause?.name && (declaration === importClause || declaration === importClause.name)) {
        return PROCESS_OBJECT;
      }
      if (ts.isNamespaceImport(declaration)) return PROCESS_OBJECT;
      if (ts.isImportSpecifier(declaration)) {
        const importedName = declaration.propertyName || declaration.name;
        if (importedName.text === 'default') return PROCESS_OBJECT;
        if (importedName.text === 'kill') return PID_PROBE;
      }
    }
    return null;
  };
  const localImportAtoms = symbol => {
    if (!moduleResolver) return new Set();
    const atoms = new Set();
    for (const declaration of symbol?.declarations || []) {
      let importDeclaration = declaration;
      while (importDeclaration && !ts.isImportDeclaration(importDeclaration)) {
        importDeclaration = importDeclaration.parent;
      }
      if (importDeclaration && ts.isStringLiteral(importDeclaration.moduleSpecifier)) {
        const clause = importDeclaration.importClause;
        let name = null;
        if (clause?.name && (declaration === clause || declaration === clause.name)) name = 'default';
        if (ts.isNamespaceImport(declaration)) name = '*';
        if (ts.isImportSpecifier(declaration)) name = (declaration.propertyName || declaration.name).text;
        if (name) {
          for (const atom of moduleResolver.resolveImport(
            virtualPath, importDeclaration.moduleSpecifier.text, name)) atoms.add(atom);
        }
      }
      if (ts.isImportEqualsDeclaration(declaration)) {
        const reference = declaration.moduleReference;
        const moduleName = reference && ts.isExternalModuleReference(reference)
          ? reference.expression : null;
        if (ts.isStringLiteral(moduleName)) {
          for (const atom of moduleResolver.resolveImport(
            virtualPath, moduleName.text, '*', { importEquals: true })) atoms.add(atom);
        }
      }
    }
    return atoms;
  };
  const staticPropertyNames = (access, resolveAliases = true) => {
    if (ts.isPropertyAccessExpression(access)) return [access.name.text];
    if (!ts.isElementAccessExpression(access)) return [];
    if (resolveAliases) return [...accessNames(access)];
    const argument = ts.isParenthesizedExpression(access.argumentExpression)
      ? access.argumentExpression.expression : access.argumentExpression;
    if (ts.isStringLiteral(argument) || ts.isNumericLiteral(argument)) return [argument.text];
    if (ts.isIdentifier(argument)) {
      const values = staticValue(argument);
      if (values.size) return [...values].filter(value => typeof value === 'string' || typeof value === 'number')
        .map(String);
    }
    return [];
  };
  const propertySymbols = (access, resolveAliases = true) => {
    const names = staticPropertyNames(access, resolveAliases);
    if (!names.length) return [checker.getSymbolAtLocation(access)].filter(Boolean);
    if (ts.isPropertyAccessExpression(access)) {
      return [checker.getSymbolAtLocation(access.name)].filter(Boolean);
    }
    const receiverType = checker.getTypeAtLocation(access.expression);
    const symbols = names.map(name => checker.getPropertyOfType(receiverType, String(name))).filter(Boolean);
    return symbols.length ? symbols : [checker.getSymbolAtLocation(access)].filter(Boolean);
  };
  const assignmentTargetIdentifiers = node => {
    const target = ts.isParenthesizedExpression(node) ? node.expression : node;
    if (ts.isIdentifier(target)) return [target];
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return assignmentTargetIdentifiers(target.left);
    }
    if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) {
      const identifiers = [];
      for (const element of target.properties || target.elements) {
        if (ts.isSpreadAssignment(element) || ts.isSpreadElement(element)) continue;
        if (ts.isPropertyAssignment(element)) identifiers.push(...assignmentTargetIdentifiers(element.initializer));
        else identifiers.push(...assignmentTargetIdentifiers(element));
      }
      return identifiers;
    }
    return [];
  };
  const recordIterationTarget = (target, source) => {
    for (const identifier of assignmentTargetIdentifiers(target)) {
      recordAssignment(checker.getSymbolAtLocation(identifier), { source });
    }
  };
  const indexForOfStatement = statement => {
    const iterable = ts.isParenthesizedExpression(statement.expression)
      ? statement.expression.expression : statement.expression;
    if (!ts.isArrayLiteralExpression(iterable)) return;
    const declarations = ts.isVariableDeclarationList(statement.initializer)
      ? statement.initializer.declarations : [statement.initializer];
    for (const declaration of declarations) {
      for (const element of iterable.elements) {
        if (!element || ts.isSpreadElement(element)) continue;
        recordIterationTarget(ts.isVariableDeclarationList(statement.initializer) ? declaration.name : declaration, element);
      }
    }
  };
  const arithmeticAssignmentKinds = new Set([
    ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken,
    ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.LessThanLessThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken
  ]);
  const indexRightHandSide = expression => {
    if (ts.isForOfStatement(expression)) indexForOfStatement(expression);
    if (!expression) return;
    const operator = ts.isBinaryExpression(expression) ? expression.operatorToken.kind : null;
    const arithmeticAssignment = arithmeticAssignmentKinds.has(operator);
    const isAssignment = operator === ts.SyntaxKind.EqualsToken ||
      operator === ts.SyntaxKind.BarBarEqualsToken ||
      operator === ts.SyntaxKind.QuestionQuestionEqualsToken ||
      operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken || arithmeticAssignment;
    if (ts.isBinaryExpression(expression) && isAssignment) {
      const left = ts.isParenthesizedExpression(expression.left) ? expression.left.expression : expression.left;
      const logicalAssignmentSkipsRight = operator === ts.SyntaxKind.BarBarEqualsToken &&
        isDefinitelyTruthy(left) || operator === ts.SyntaxKind.QuestionQuestionEqualsToken &&
        isDefinitelyNonNullish(left) || operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken &&
        isDefinitelyFalsy(left);
      if (logicalAssignmentSkipsRight) {
        indexRightHandSide(expression.left);
        return;
      }
      if (ts.isIdentifier(left)) {
        recordAssignment(checker.getSymbolAtLocation(left), {
          source: arithmeticAssignment ? expression : expression.right
        });
      } else if (ts.isObjectLiteralExpression(left)) {
        for (const property of left.properties) {
          let target = null;
          let name = null;
          if (ts.isPropertyAssignment(property)) {
            name = ts.isIdentifier(property.name) ? property.name.text
              : ts.isStringLiteral(property.name) ? property.name.text
                : ts.isComputedPropertyName(property.name)
                  ? [...staticValue(property.name.expression)].find(value => typeof value === 'string' ||
                    typeof value === 'number')?.toString() || null
                  : null;
            // Resolve the target identifier node directly; its symbol is the
            // lexical place, which is what a call-site identifier resolves to.
            const targets = assignmentTargetIdentifiers(property.initializer);
            target = targets.length ? checker.getSymbolAtLocation(targets[0]) : null;
          } else if (ts.isShorthandPropertyAssignment(property)) {
            name = property.name.text;
            // For shorthand, `getSymbolAtLocation(property.name)` returns the
            // shorthand property symbol, not the assigned variable; the value
            // symbol is the lexical place the call site uses.
            target = checker.getShorthandAssignmentValueSymbol(property);
          }
          if (target) recordAssignment(target, { source: expression.right, name });
        }
      } else if (ts.isArrayLiteralExpression(left) && ts.isArrayLiteralExpression(expression.right)) {
        for (let index = 0; index < left.elements.length; index += 1) {
          const target = left.elements[index];
          const source = expression.right.elements[index];
          if (!source || ts.isSpreadElement(source)) continue;
          for (const identifier of assignmentTargetIdentifiers(target)) {
            recordAssignment(checker.getSymbolAtLocation(identifier), { source });
          }
        }
      } else if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
        if (!receiverSymbols(left.expression).size) {
          for (const propertySymbol of propertySymbols(left, false)) {
            recordAssignment(propertySymbol, { source: expression.right });
          }
        }
        recordMemberAssignment(left, { source: expression.right });
      }
    }
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
      ts.isIdentifier(expression.expression.expression) && expression.expression.expression.text === 'Object' &&
      expression.expression.name.text === 'assign') {
      const objectSymbol = checker.getSymbolAtLocation(expression.expression.expression);
      const shadowed = objectSymbol?.declarations?.some(declaration =>
        declaration.getSourceFile() === sourceFile && !isAmbientDeclaration(declaration));
      if (!shadowed) {
        const target = expression.arguments[0];
        if (target) {
          for (const source of expression.arguments.slice(1)) {
            const object = ts.isParenthesizedExpression(source) ? source.expression : source;
            if (!ts.isObjectLiteralExpression(object)) continue;
            for (const property of object.properties) {
              if (!property.name || (!ts.isPropertyAssignment(property) &&
                !ts.isShorthandPropertyAssignment(property))) continue;
              const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ||
                ts.isNumericLiteral(property.name) ? property.name.text : null;
              if (name === null) continue;
              const value = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
              indexMemberAssignmentsForTarget(target, [name], { source: value });
            }
          }
        }
      }
    }
    ts.forEachChild(expression, indexRightHandSide);
  };
  const bindingPropertyName = binding => {
    if (!ts.isBindingElement(binding)) return null;
    if (binding.propertyName) {
      return ts.isIdentifier(binding.propertyName) || ts.isStringLiteral(binding.propertyName)
        ? binding.propertyName.text
        : ts.isComputedPropertyName(binding.propertyName)
          ? [...staticValue(binding.propertyName.expression)].find(value => typeof value === 'string' ||
            typeof value === 'number')?.toString() || null
          : null;
    }
    return ts.isIdentifier(binding.name) ? binding.name.text : null;
  };
  const indexParameterBinding = (name, argument, parameter, restArguments = null) => {
    if (ts.isIdentifier(name)) {
      if (parameter?.dotDotDotToken) {
        recordRestParameterArguments(checker.getSymbolAtLocation(name), restArguments || []);
      } else if (argument) {
        recordParameterArgument(checker.getSymbolAtLocation(name), argument);
      }
      return;
    }
    if (ts.isArrayBindingPattern(name)) {
      if (!ts.isArrayLiteralExpression(argument)) return;
      for (let index = 0; index < name.elements.length; index += 1) {
        const binding = name.elements[index];
        const source = argument.elements[index];
        if (ts.isBindingElement(binding) && ts.isIdentifier(binding.name) && source && !ts.isSpreadElement(source)) {
          recordParameterArgument(checker.getSymbolAtLocation(binding.name), source);
        }
      }
      return;
    }
    if (!ts.isObjectBindingPattern(name)) return;
    for (const binding of name.elements) {
      if (!ts.isBindingElement(binding) || !ts.isIdentifier(binding.name)) continue;
      const propertyName = bindingPropertyName(binding);
      recordParameterArgument(checker.getSymbolAtLocation(binding.name), argument, propertyName);
    }
  };
  const invocationWrapperName = callee => {
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return null;
    const names = staticPropertyNames(callee, true);
    if (names.length !== 1 || !['call', 'apply', 'bind'].includes(String(names[0]))) return null;
    const member = ts.isPropertyAccessExpression(callee)
      ? checker.getSymbolAtLocation(callee.name) : checker.getSymbolAtLocation(callee);
    const symbols = [member, ...propertySymbols(callee)].filter(Boolean);
    const isUserDeclaration = symbols.some(symbol => (symbol.declarations || []).some(declaration =>
      ts.isMethodDeclaration(declaration) || ts.isPropertyAssignment(declaration) ||
      ts.isPropertyDeclaration(declaration) || ts.isFunctionDeclaration(declaration)));
    return isUserDeclaration ? null : String(names[0]);
  };
  const classConstructorParameters = declaration => {
    if (!declaration || (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration))) return [];
    const constructor = declaration.members.find(member => ts.isConstructorDeclaration(member));
    return constructor?.parameters || [];
  };
  const callableParameters = (callee, visited = new Set()) => {
    if (ts.isParenthesizedExpression(callee)) return callableParameters(callee.expression, visited);
    if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) return callee.parameters;
    if (callee.kind === ts.SyntaxKind.SuperKeyword) {
      let enclosingClass = callee.parent;
      while (enclosingClass && !ts.isClassDeclaration(enclosingClass) && !ts.isClassExpression(enclosingClass)) {
        enclosingClass = enclosingClass.parent;
      }
      const baseType = enclosingClass?.heritageClauses
        ?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
      const baseSymbol = baseType && checker.getSymbolAtLocation(baseType.expression);
      return classConstructorParameters(symbolDeclaration(baseSymbol));
    }
    const wrapper = invocationWrapperName(callee);
    if (wrapper) return callableParameters(callee.expression, visited);
    const symbols = [];
    if (ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ||
      ts.isClassExpression(callee)) {
      const direct = checker.getSymbolAtLocation(callee);
      if (direct) symbols.push(direct);
      if (ts.isPropertyAccessExpression(callee)) {
        const member = checker.getSymbolAtLocation(callee.name);
        if (member) symbols.push(member);
      }
      for (const property of propertySymbols(callee)) symbols.push(property);
    }
    const seenSymbols = new Set();
    const parametersFor = symbol => {
      if (!symbol || visited.has(symbol) || seenSymbols.has(symbol)) return [];
      seenSymbols.add(symbol);
      const symbolSeen = new Set(visited).add(symbol);
      const declaration = symbolDeclaration(symbol);
      if (declaration && (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration) ||
        ts.isArrowFunction(declaration) || ts.isMethodDeclaration(declaration))) {
        return declaration.parameters;
      }
      if (declaration && (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))) {
        return classConstructorParameters(declaration);
      }
      if (declaration && ts.isPropertyAssignment(declaration)) {
        if (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer)) {
          return declaration.initializer.parameters;
        }
        if (ts.isIdentifier(declaration.initializer)) {
          return callableParameters(declaration.initializer, symbolSeen);
        }
      }
      if (declaration && ts.isPropertyDeclaration(declaration)) {
        if (declaration.initializer &&
          (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer))) {
          return declaration.initializer.parameters;
        }
        if (declaration.initializer && ts.isClassExpression(declaration.initializer)) {
          return classConstructorParameters(declaration.initializer);
        }
        if (declaration.initializer && ts.isIdentifier(declaration.initializer)) {
          return callableParameters(declaration.initializer, symbolSeen);
        }
      }
      if (declaration && ts.isShorthandPropertyAssignment(declaration)) {
        const valueSymbol = checker.getShorthandAssignmentValueSymbol(declaration);
        return parametersFor(valueSymbol);
      }
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
        if (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer)) {
          return declaration.initializer.parameters;
        }
        if (ts.isClassExpression(declaration.initializer)) {
          return classConstructorParameters(declaration.initializer);
        }
        if (ts.isIdentifier(declaration.initializer)) {
          return callableParameters(declaration.initializer, symbolSeen);
        }
        if (ts.isCallExpression(declaration.initializer) &&
          invocationWrapperName(declaration.initializer.expression) === 'bind') {
          return callableParameters(declaration.initializer.expression.expression, symbolSeen);
        }
      }
      for (const assigned of assignments.get(symbol) || []) {
        const source = assigned && assigned.source ? assigned.source : assigned;
        const parameters = callableParameters(source, symbolSeen);
        if (parameters.length) return parameters;
      }
      return [];
    };
    for (const symbol of symbols) {
      const parameters = parametersFor(symbol);
      if (parameters.length) return parameters;
    }
    return [];
  };
  const expandCallArguments = argumentsList => {
    if (!argumentsList) return [];
    const expanded = [];
    const expand = elements => {
      for (const argument of elements) {
        if (!ts.isSpreadElement(argument)) {
          expanded.push(argument);
          continue;
        }
        let source = argument.expression;
        while (ts.isParenthesizedExpression(source)) source = source.expression;
        const elements = literalArrayElements(source, new Set(), true);
        if (!elements || !expand(elements)) return false;
      }
      return true;
    };
    return expand(argumentsList) ? expanded : null;
  };
  const literalArrayElements = (expression, visited = new Set(), resolveAliases = false) => {
    if (!expression || visited.has(expression)) return null;
    let source = expression;
    while (ts.isParenthesizedExpression(source)) source = source.expression;
    if (visited.has(source)) return null;
    const seen = new Set(visited).add(source);
    if (ts.isArrayLiteralExpression(source)) {
      return source.elements.some(ts.isSpreadElement) ? null : source.elements;
    }
    if (!resolveAliases || !ts.isIdentifier(source)) return null;
    const symbol = checker.getSymbolAtLocation(source);
    if (!symbol) return null;
    const declaration = symbolDeclaration(symbol);
    if (!declaration) return null;
    const candidates = [];
    if ((ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) && declaration.initializer) {
      candidates.push(declaration.initializer);
    }
    for (const assigned of assignments.get(symbol) || []) {
      if (!assigned.name) candidates.push(assigned.source);
    }
    let resolved = null;
    for (const candidate of candidates) {
      const elements = literalArrayElements(candidate, seen, true);
      if (!elements) return null;
      if (resolved && resolved !== elements) return null;
      resolved = elements;
    }
    return resolved;
  };
  const finiteArrayCallbackMethods = new Set([
    'forEach', 'map', 'filter', 'some', 'every', 'find', 'findIndex', 'flatMap'
  ]);
  const finiteArrayReducerMethods = new Set(['reduce', 'reduceRight']);
  const finiteReducerSignalArguments = (method, elements, argumentsList) => {
    if (!finiteArrayReducerMethods.has(method) || !elements || !argumentsList) return null;
    const hasInitialValue = argumentsList.length > 1;
    if ((!hasInitialValue && elements.length < 2) || (hasInitialValue && elements.length === 0)) return [];
    if (method === 'reduce') return elements.slice(hasInitialValue ? 0 : 1);
    return elements.slice(0, hasInitialValue ? elements.length : elements.length - 1);
  };
  const indexParameterArguments = node => {
    if (ts.isCallExpression(node)) {
      const callbackMethod = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text : null;
      const callbackElements = callbackMethod && finiteArrayCallbackMethods.has(callbackMethod)
        ? literalArrayElements(node.expression.expression) : null;
      const callback = node.arguments && node.arguments[0];
      if (callbackElements && callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const parameter = callback.parameters[0];
        if (parameter && ts.isIdentifier(parameter.name)) {
          for (const element of callbackElements) {
            if (element) indexParameterBinding(parameter.name, element, parameter);
          }
        }
      }
      const wrapper = invocationWrapperName(node.expression);
      if (wrapper) {
        const parameters = callableParameters(node.expression.expression);
        let argumentsList = node.arguments ? [...node.arguments] : [];
        if (wrapper === 'call') argumentsList = argumentsList.slice(1);
        if (wrapper === 'apply') {
          const elements = literalArrayElements(argumentsList[1]);
          argumentsList = elements ? [...elements] : [];
        }
        if (wrapper === 'bind') argumentsList = argumentsList.slice(1);
        for (let index = 0; index < parameters.length; index += 1) {
          const parameter = parameters[index];
          const argument = argumentsList[index];
          if (argument && !ts.isSpreadElement(argument)) {
            indexParameterBinding(parameter.name, argument, parameter);
          }
        }
      } else {
        const parameters = callableParameters(node.expression);
        const argumentsList = expandCallArguments(node.arguments);
        if (argumentsList === null) {
          ts.forEachChild(node, indexParameterArguments);
          return;
        }
        for (let index = 0; index < parameters.length; index += 1) {
          const parameter = parameters[index];
          const argument = argumentsList[index];
          if (parameter.dotDotDotToken) {
            indexParameterBinding(parameter.name, argument, parameter, argumentsList.slice(index));
          } else if (argument && !ts.isSpreadElement(argument)) {
            indexParameterBinding(parameter.name, argument, parameter);
          }
        }
      }
    } else if (ts.isNewExpression(node)) {
      const parameters = callableParameters(node.expression);
      const argumentsList = expandCallArguments(node.arguments);
      if (argumentsList === null) {
        ts.forEachChild(node, indexParameterArguments);
        return;
      }
      for (let index = 0; index < parameters.length; index += 1) {
        const parameter = parameters[index];
        const argument = argumentsList[index];
        if (parameter.dotDotDotToken) {
          indexParameterBinding(parameter.name, argument, parameter, argumentsList.slice(index));
        } else if (argument && !ts.isSpreadElement(argument)) {
          indexParameterBinding(parameter.name, argument, parameter);
        }
      }
    }
    ts.forEachChild(node, indexParameterArguments);
  };
  function accessNames(node, visited) {
    if (ts.isPropertyAccessExpression(node)) return new Set([node.name.text]);
    if (ts.isElementAccessExpression(node)) return staticValue(node.argumentExpression, visited);
    return new Set();
  }

  const isFalsyStaticAtom = atom => atom === 0 || atom === '' || atom === false || atom == null ||
    atom === UNDEFINED_VALUE;

  function isAmbientDeclaration(declaration) {
    let current = declaration;
    while (current && !ts.isSourceFile(current)) {
      if (current.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return true;
      current = current.parent;
    }
    return false;
  }

  function bindingSourceExpression(node) {
    let current = node;
    while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current))) current = current.expression;
    return current;
  }

  function propertyOriginNodes(node, name, visited = new Set()) {
    const source = bindingSourceExpression(node);
    if (!source || visited.has(source)) return [];
    const seen = new Set(visited).add(source);
    if (ts.isObjectLiteralExpression(source)) {
      const values = [];
      for (const property of source.properties) {
        if (!property.name) continue;
        const shorthand = ts.isShorthandPropertyAssignment(property);
        if (!shorthand && !ts.isPropertyAssignment(property)) continue;
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text : null;
        if (key !== name) continue;
        values.push(shorthand ? property.name : property.initializer);
      }
      return values;
    }
    if (!ts.isIdentifier(source)) return [];
    const symbol = checker.getSymbolAtLocation(source);
    const declaration = symbolDeclaration(symbol);
    if (!declaration || visited.has(symbol)) return [];
    const symbolSeen = new Set(seen).add(symbol);
    const values = [];
    if ((ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) && declaration.initializer) {
      values.push(...propertyOriginNodes(declaration.initializer, name, symbolSeen));
    }
    for (const assigned of assignments.get(symbol) || []) {
      if (!assigned.name) values.push(...propertyOriginNodes(assigned.source, name, symbolSeen));
    }
    return values;
  }

  function bindingValueSources(binding, visited = new Set()) {
    if (!ts.isBindingElement(binding) || visited.has(binding)) return [];
    if (ts.isArrayBindingPattern(binding.parent)) return bindingSources(binding, visited);
    if (!ts.isObjectBindingPattern(binding.parent)) return [];
    const name = bindingPropertyName(binding);
    if (!name) return [];
    const sources = bindingSources(binding, visited);
    const values = [];
    for (const source of sources || []) values.push(...propertyOriginNodes(source, name, visited));
    return values;
  }

  // True only for a symbol bound by an object- or array-destructuring pattern
  // (BindingElement), whose possible values are the pattern sources of its
  // enclosing parameter or variable declaration. Returns false for plain
  // variables, which resolve through their own initializer.
  function bindingSources(declaration, visited = new Set()) {
    if (!ts.isBindingElement(declaration) || visited.has(declaration)) return false;
    const seen = new Set(visited).add(declaration);
    const container = declaration.parent.parent;
    if (ts.isBindingElement(container)) return bindingValueSources(container, seen);
    if (ts.isArrayBindingPattern(declaration.parent)) {
      const initializer = ts.isVariableDeclaration(container) || ts.isParameter(container)
        ? container.initializer : null;
      if (!initializer) return false;
      const index = declaration.parent.elements.indexOf(declaration);
      if (index < 0 || !ts.isArrayLiteralExpression(initializer)) return false;
      const element = initializer.elements[index];
      return element && !ts.isSpreadElement(element) ? [element] : false;
    }
    if (!ts.isObjectBindingPattern(declaration.parent)) return false;
    if (ts.isVariableDeclaration(container)) return container.initializer ? [container.initializer] : false;
    if (ts.isParameter(container)) return container.initializer ? [container.initializer] : false;
    return false;
  }

  // Resolve a node to a set of static atoms. `visited` is a per-path set of
  // nodes/symbols; revisiting a node terminates the walk instead of looping, so
  // cyclic aliases resolve to the empty set (no crash, never by name).
  function staticValue(node, visited = new Set()) {
    return resolveSet(node, visited);
  }

  function transparentExpression(node) {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node) || ts.isAwaitExpression(node)) return node.expression;
    return null;
  }

  function arrayElementSources(node, index, visited = new Set()) {
    if (!node || visited.has(node)) return [];
    const seen = new Set(visited).add(node);
    const transparent = transparentExpression(node);
    if (transparent) return arrayElementSources(transparent, index, seen);
    if (ts.isArrayLiteralExpression(node)) {
      const element = node.elements[index];
      return element && !ts.isSpreadElement(element) ? [element] : [];
    }
    if (!ts.isIdentifier(node)) return [];
    const symbol = checker.getSymbolAtLocation(node);
    const declaration = symbolDeclaration(symbol);
    if (!declaration || visited.has(symbol)) return [];
    const symbolSeen = new Set(seen).add(symbol);
    const sources = [];
    for (const argument of parameterArguments.get(symbol) || []) {
      if (argument && argument.restIndex === index && argument.source) sources.push(argument.source);
    }
    if ((ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) && declaration.initializer) {
      sources.push(...arrayElementSources(declaration.initializer, index, symbolSeen));
    }
    for (const assigned of assignments.get(symbol) || []) {
      if (!assigned.name) sources.push(...arrayElementSources(assigned.source, index, symbolSeen));
    }
    return sources;
  }

  function callableReturnExpressions(callee, visited = new Set()) {
    if (ts.isParenthesizedExpression(callee)) return callableReturnExpressions(callee.expression, visited);
    const symbols = [];
    if (ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      const direct = checker.getSymbolAtLocation(callee);
      if (direct) symbols.push(direct);
      if (ts.isPropertyAccessExpression(callee)) {
        const member = checker.getSymbolAtLocation(callee.name);
        if (member) symbols.push(member);
      }
      for (const property of propertySymbols(callee)) symbols.push(property);
    }
    const seenSymbols = new Set();
    const returnsFrom = declaration => {
      if (!declaration) return [];
      if (ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration) ||
        ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) {
        if (!declaration.body) return [];
        if (!ts.isBlock(declaration.body)) return [declaration.body];
        const returns = [];
        const visitBody = node => {
          if (ts.isReturnStatement(node)) {
            if (node.expression) returns.push(node.expression);
            return;
          }
          if (ts.isFunctionLike(node) && node !== declaration) return;
          ts.forEachChild(node, visitBody);
        };
        visitBody(declaration.body);
        return returns;
      }
      if (ts.isPropertyAssignment(declaration) &&
        (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer))) {
        return returnsFrom(declaration.initializer);
      }
      if (ts.isPropertyDeclaration(declaration) && declaration.initializer &&
        (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer))) {
        return returnsFrom(declaration.initializer);
      }
      return [];
    };
    const expressionsFor = symbol => {
      if (!symbol || visited.has(symbol) || seenSymbols.has(symbol)) return [];
      seenSymbols.add(symbol);
      const symbolSeen = new Set(visited).add(symbol);
      const declaration = symbolDeclaration(symbol);
      const expressions = returnsFrom(declaration);
      if (expressions.length) return expressions;
      if (declaration && ts.isShorthandPropertyAssignment(declaration)) {
        const valueSymbol = checker.getShorthandAssignmentValueSymbol(declaration);
        expressions.push(...expressionsFor(valueSymbol));
      }
      if (declaration && ts.isPropertyAssignment(declaration) && ts.isIdentifier(declaration.initializer)) {
        expressions.push(...callableReturnExpressions(declaration.initializer, symbolSeen));
      }
      if (declaration && ts.isPropertyAssignment(declaration) &&
        (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer))) {
        expressions.push(...returnsFrom(declaration.initializer));
      }
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
        if (ts.isIdentifier(declaration.initializer)) {
          expressions.push(...callableReturnExpressions(declaration.initializer, symbolSeen));
        } else if (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer)) {
          expressions.push(...returnsFrom(declaration.initializer));
        }
      }
      for (const assigned of assignments.get(symbol) || []) {
        const source = assigned && assigned.source ? assigned.source : assigned;
        if (source) expressions.push(...callableReturnExpressions(source, symbolSeen));
      }
      return expressions;
    };
    const expressions = [];
    for (const symbol of symbols) expressions.push(...expressionsFor(symbol));
    return expressions;
  }

  function resolveSet(node, visited) {
    const empty = new Set();
    if (!node || visited.has(node)) return empty;
    const seen = new Set(visited).add(node);
    const transparent = transparentExpression(node);
    if (transparent) return resolveSet(transparent, seen);
    if (ts.isNumericLiteral(node)) return new Set([Number(node.text)]);
    if (ts.isStringLiteral(node)) return new Set([node.text]);
    if (ts.isNoSubstitutionTemplateLiteral(node)) return new Set([node.text]);
    // Branching and short-circuit expressions contribute a value union, not an
    // evaluation: any possible probe/zero branch is kept. This stays a bounded
    // structural walk rather than an interpreter.
    if (ts.isConditionalExpression(node)) {
      const union = resolveSet(node.whenTrue, seen);
      for (const atom of resolveSet(node.whenFalse, seen)) union.add(atom);
      return union;
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator === ts.SyntaxKind.EqualsToken) return resolveSet(node.right, seen);
      if (operator === ts.SyntaxKind.CommaToken) return resolveSet(node.right, seen);
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.BarBarEqualsToken ||
        operator === ts.SyntaxKind.QuestionQuestionEqualsToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
        const union = resolveSet(node.left, seen);
        for (const atom of resolveSet(node.right, seen)) union.add(atom);
        return union;
      }
      if (operator === ts.SyntaxKind.BarBarToken) {
        const left = resolveSet(node.left, seen);
        const right = resolveSet(node.right, seen);
        const leftMayBeFalsy = left.size === 0 || [...left].some(isFalsyStaticAtom);
        const leftMayBeTruthy = left.size === 0 || [...left].some(atom => !isFalsyStaticAtom(atom));
        const result = new Set();
        if (leftMayBeTruthy) {
          for (const atom of left) {
            if (!isFalsyStaticAtom(atom)) result.add(atom);
          }
        }
        if (leftMayBeFalsy) {
          for (const atom of right) result.add(atom);
        }
        return result;
      }
      return empty;
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const names = accessNames(node, seen);
      if (!names.size) return empty;
      const receiver = resolveSet(node.expression, seen);
      const result = new Set();
      for (const name of names) {
        if (name === 'process' && hasAtom(receiver, GLOBAL_OBJECT)) result.add(PROCESS_OBJECT);
        for (const atom of receiver) {
          if (moduleResolver?.resolveProperty) {
            for (const resolved of moduleResolver.resolveProperty([atom], String(name), virtualPath, seen)) {
              result.add(resolved);
            }
          } else {
            const modulePath = moduleResolver?.modulePathFromAtom(atom);
            if (!modulePath) continue;
            for (const resolved of moduleResolver.resolveExport(modulePath, String(name), seen)) result.add(resolved);
          }
        }
        if (name === 'directPostOwnerAlive') result.add(LEGACY_OWNER);
        if (hasAtom(receiver, LEGACY_OWNER) &&
          (name === 'bind' || name === 'call' || name === 'apply')) result.add(LEGACY_OWNER);
        if (name === 'kill' && hasAtom(receiver, PROCESS_OBJECT)) result.add(PID_PROBE);
        if (hasAtom(receiver, PID_PROBE)) {
          if (name === 'bind') result.add(PID_PROBE);
          if (name === 'call') result.add(CALL_METHOD);
          if (name === 'apply') result.add(APPLY_METHOD);
        }
        if (hasAtom(receiver, REFLECT_OBJECT) && name === 'apply') result.add(REFLECT_APPLY);
        if (hasAtom(receiver, REFLECT_APPLY)) {
          if (name === 'bind') result.add(REFLECT_APPLY);
          if (name === 'call') result.add(REFLECT_CALL_METHOD);
          if (name === 'apply') result.add(REFLECT_APPLY_METHOD);
        }
        if (hasAtom(receiver, BOUND_PROBE) &&
          (name === 'bind' || name === 'call' || name === 'apply')) result.add(BOUND_PROBE);
        if (hasAtom(receiver, BOUND_REFLECT_APPLY) &&
          (name === 'bind' || name === 'call' || name === 'apply')) result.add(BOUND_REFLECT_APPLY);
        if ((hasAtom(receiver, REFLECT_CALL_METHOD) || hasAtom(receiver, REFLECT_APPLY_METHOD)) &&
          (name === 'bind' || name === 'call' || name === 'apply')) result.add(BOUND_REFLECT_APPLY);
        const methods = INVOCATION_METHODS.filter(atom => hasAtom(receiver, atom));
        if (name === 'bind') {
          for (const method of methods) result.add(method);
        }
        if ((name === 'call' || name === 'apply') && methods.length) result.add(APPLY_METHOD);
      }
      for (const propertySymbol of propertySymbols(node)) {
        const propertyDeclaration = symbolDeclaration(propertySymbol);
        if (propertyDeclaration && ts.isPropertyDeclaration(propertyDeclaration) && propertyDeclaration.initializer) {
          for (const atom of resolveSet(propertyDeclaration.initializer, seen)) result.add(atom);
        }
        if (propertyDeclaration && ts.isParameter(propertyDeclaration)) {
          if (propertyDeclaration.initializer) {
            for (const atom of resolveSet(propertyDeclaration.initializer, seen)) result.add(atom);
          }
          const parameterSymbol = ts.isIdentifier(propertyDeclaration.name)
            ? checker.getSymbolAtLocation(propertyDeclaration.name) : propertySymbol;
          for (const symbol of new Set([propertySymbol, parameterSymbol])) {
            for (const argument of parameterArguments.get(symbol) || []) {
              const source = argument && argument.source ? argument.source : argument;
              if (!source) continue;
              for (const atom of resolveSet(source, seen)) result.add(atom);
            }
          }
        }
        if (propertyDeclaration && ts.isGetAccessorDeclaration(propertyDeclaration)) {
          for (const statement of propertyDeclaration.body?.statements || []) {
            if (!ts.isReturnStatement(statement) || !statement.expression) continue;
            for (const atom of resolveSet(statement.expression, seen)) result.add(atom);
          }
        }
        for (const assigned of assignments.get(propertySymbol) || []) {
          for (const atom of resolveSet(assigned.source, seen)) result.add(atom);
        }
      }
      const receivers = receiverSymbols(node.expression);
      for (const constructor of instanceConstructorSymbols(node.expression)) receivers.add(constructor);
      for (const constructor of prototypeConstructorSymbols(node.expression)) receivers.add(constructor);
      for (const receiverSymbol of receivers) {
        const byName = memberAssignments.get(receiverSymbol);
        if (!byName) continue;
        for (const name of names) {
          for (const assigned of byName.get(String(name)) || []) {
            for (const atom of resolveSet(assigned.source, seen)) result.add(atom);
          }
        }
      }
      for (const name of names) {
        for (const atom of literalProperty(node.expression, String(name), seen)) result.add(atom);
        const index = Number(name);
        if (Number.isInteger(index) && index >= 0) {
          for (const element of arrayElementSources(node.expression, index, seen)) {
            for (const atom of resolveSet(element, seen)) result.add(atom);
          }
        }
      }
      return result;
    }

    if (ts.isNewExpression(node)) {
      const constructors = resolveSet(node.expression, seen);
      return moduleResolver?.resolveNew ? moduleResolver.resolveNew(constructors) : empty;
    }

    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        ts.isStringLiteral(node.arguments[0]) &&
        (node.arguments[0].text === 'node:process' || node.arguments[0].text === 'process')) {
        return new Set([PROCESS_OBJECT]);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require' &&
        !symbolDeclaration(checker.getSymbolAtLocation(node.expression))) {
        const moduleName = node.arguments[0];
        if (moduleName && ts.isStringLiteral(moduleName)) {
          if (moduleName.text === 'node:process' || moduleName.text === 'process') {
            return new Set([PROCESS_OBJECT]);
          }
          if (moduleResolver) return moduleResolver.resolveRequire(virtualPath, moduleName.text);
        }
      }
      // `probe.bind(...)` yields a bound probe; a later invocation of that
      // result is still a potential liveness probe. `.call`/`.apply` are
      // invocations themselves, handled at the call visitor with shifted args.
      const callee = node.expression;
      const names = accessNames(callee, seen);
      if (names.has('bind')) {
        const receiver = resolveSet(callee.expression, seen);
        const result = new Set();
        if (hasAtom(receiver, PID_PROBE)) {
          result.add(node.arguments.length > 1 ? BOUND_PROBE : PID_PROBE);
        }
        if (hasAtom(receiver, BOUND_PROBE)) result.add(BOUND_PROBE);
        for (const method of INVOCATION_METHODS) {
          if (hasAtom(receiver, method)) result.add(method);
        }
        if (hasAtom(receiver, REFLECT_APPLY)) {
          result.add(node.arguments.length > 1 ? BOUND_REFLECT_APPLY : REFLECT_APPLY);
        }
        if (hasAtom(receiver, BOUND_REFLECT_APPLY) || hasAtom(receiver, REFLECT_CALL_METHOD) ||
          hasAtom(receiver, REFLECT_APPLY_METHOD)) result.add(BOUND_REFLECT_APPLY);
        return result;
      }
      if (names.has('call') || names.has('apply')) {
        const receiver = resolveSet(callee.expression, seen);
        if (hasAtom(receiver, REFLECT_APPLY)) return new Set([REFLECT_APPLY]);
        if (hasAtom(receiver, BOUND_REFLECT_APPLY) || hasAtom(receiver, REFLECT_CALL_METHOD) ||
          hasAtom(receiver, REFLECT_APPLY_METHOD)) return new Set([BOUND_REFLECT_APPLY]);
      }
      const result = new Set();
      if (moduleResolver?.resolveCall) {
        for (const atom of moduleResolver.resolveCall(
          resolveSet(callee, seen), expandCallArguments(node.arguments) || [], virtualPath, seen)) {
          result.add(atom);
        }
      }
      for (const expression of callableReturnExpressions(callee, seen)) {
        for (const atom of resolveSet(expression, seen)) result.add(atom);
      }
      return result;
    }

    if (!ts.isIdentifier(node)) return empty;
    // A shorthand property key names the property symbol; the value is the binding.
    const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    const importedAtom = processImportAtom(symbol);
    if (importedAtom) return new Set([importedAtom]);
    const importedAtoms = localImportAtoms(symbol);
    if (importedAtoms.size) return importedAtoms;
    const declaration = symbolDeclaration(symbol);
    if (declaration && isAmbientDeclaration(declaration)) {
      if (node.text === 'process') return new Set([PROCESS_OBJECT]);
      if (node.text === 'globalThis' || node.text === 'global') return new Set([GLOBAL_OBJECT]);
      if (node.text === 'undefined') return new Set([UNDEFINED_VALUE]);
    }
    if (!declaration) {
      if (node.text === 'process') return new Set([PROCESS_OBJECT]);
      if (node.text === 'Reflect') return new Set([REFLECT_OBJECT]);
      if (node.text === 'globalThis' || node.text === 'global') return new Set([GLOBAL_OBJECT]);
      if (node.text === 'undefined') return new Set([UNDEFINED_VALUE]);
      return node.text === 'directPostOwnerAlive' ? new Set([LEGACY_OWNER]) : empty;
    }
    if (visited.has(symbol)) return empty;
    const symbolSeen = new Set(visited).add(symbol);

    const result = new Set();
    const addFrom = valueNode => {
      for (const atom of resolveSet(valueNode, symbolSeen)) result.add(atom);
    };
    const addFromParameterArgument = entry => {
      if (entry && entry.restIndex !== undefined) return;
      if (entry && entry.source) addFromAssignment(entry);
      else addFrom(entry);
    };
    // An assignment record either replaces the whole value (`name = expr`) or
    // destructures a named property off the source (`({ kill: probe } = src)`).
    // The named form resolves the property, never the whole source.
    const addFromAssignment = entry => {
      if (!entry.name) {
        addFrom(entry.source);
        return;
      }
      if (entry.name === 'directPostOwnerAlive') {
        result.add(LEGACY_OWNER);
        return;
      }
      if (entry.name === 'kill' && hasAtom(resolveSet(entry.source, symbolSeen), PROCESS_OBJECT)) {
        result.add(PID_PROBE);
      }
      const sourceSet = resolveSet(entry.source, symbolSeen);
      if (entry.name === 'call' && hasAtom(sourceSet, PID_PROBE)) result.add(CALL_METHOD);
      if (entry.name === 'apply' && hasAtom(sourceSet, PID_PROBE)) result.add(APPLY_METHOD);
      if (entry.name === 'apply' && hasAtom(sourceSet, REFLECT_OBJECT)) result.add(REFLECT_APPLY);
      if (entry.name === 'call' && hasAtom(sourceSet, REFLECT_APPLY)) result.add(REFLECT_CALL_METHOD);
      if (entry.name === 'apply' && hasAtom(sourceSet, REFLECT_APPLY)) result.add(REFLECT_APPLY_METHOD);
      for (const atom of literalProperty(entry.source, entry.name, symbolSeen)) result.add(atom);
    };

    if (ts.isVariableDeclaration(declaration)) {
      addFrom(declaration.initializer);
    } else if (ts.isParameter(declaration)) {
      addFrom(declaration.initializer);
    } else if (ts.isBindingElement(declaration) &&
      (ts.isObjectBindingPattern(declaration.parent) || ts.isArrayBindingPattern(declaration.parent))) {
      addFromBindingElement(declaration, symbolSeen, result);
    } else if (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration) ||
      ts.isArrowFunction(declaration) || ts.isMethodDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
      // Function-shaped declarations are not probes by themselves; their body
      // is visited separately when it contains a call expression.
      return empty;
    } else if (ts.isPropertyDeclaration(declaration)) {
      addFrom(declaration.initializer);
    }

    for (const argument of parameterArguments.get(symbol) || []) addFromParameterArgument(argument);
    for (const assigned of assignments.get(symbol) || []) addFromAssignment(assigned);
    return result;
  }

  // Logical signal expressions keep only branches that can reach the call.
  // A zero on the left of `||` is filtered by its fallback; unresolved
  // branches that can still supply the signal remain refused.
  function mayBeUnresolved(node, visited = new Set()) {
    if (!node || visited.has(node)) return true;
    const seen = new Set(visited).add(node);
    const transparent = transparentExpression(node);
    if (transparent) return mayBeUnresolved(transparent, seen);
    if (ts.isNumericLiteral(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return false;
    if (ts.isConditionalExpression(node)) {
      return mayBeUnresolved(node.whenTrue, seen) || mayBeUnresolved(node.whenFalse, seen);
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator === ts.SyntaxKind.EqualsToken) return mayBeUnresolved(node.right, seen);
      if (operator === ts.SyntaxKind.BarBarToken) {
        const left = staticValue(node.left, seen);
        const leftMayBeFalsy = left.size === 0 || [...left].some(isFalsyStaticAtom);
        if (!leftMayBeFalsy) return false;
        return mayBeUnresolved(node.right, seen);
      }
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.BarBarEqualsToken ||
        operator === ts.SyntaxKind.QuestionQuestionEqualsToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
        return mayBeUnresolved(node.left, seen) || mayBeUnresolved(node.right, seen);
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const names = accessNames(node, seen);
      return !names.size || [...names].some(name => mayBeUnresolvedProperty(node.expression, String(name), seen));
    }
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      const declaration = symbolDeclaration(symbol);
      if (node.text === 'undefined' && (!declaration || isAmbientDeclaration(declaration))) return false;
      if (!declaration || visited.has(symbol)) return true;
      const symbolSeen = new Set(seen).add(symbol);
      const sources = [];
      if (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) {
        if (declaration.initializer) sources.push({ source: declaration.initializer });
      } else if (ts.isBindingElement(declaration) &&
        (ts.isObjectBindingPattern(declaration.parent) || ts.isArrayBindingPattern(declaration.parent))) {
        const name = ts.isObjectBindingPattern(declaration.parent) ? bindingPropertyName(declaration) : null;
        for (const source of bindingSources(declaration) || []) sources.push({ source, name });
        if (declaration.initializer) sources.push({ source: declaration.initializer });
      } else if (ts.isPropertyDeclaration(declaration) && declaration.initializer) {
        sources.push({ source: declaration.initializer });
      }
      for (const argument of parameterArguments.get(symbol) || []) sources.push(
        argument && argument.source ? argument : { source: argument });
      for (const assigned of assignments.get(symbol) || []) sources.push(assigned);
      if (!sources.length) return true;
      return sources.some(entry => entry.name
        ? mayBeUnresolvedProperty(entry.source, entry.name, symbolSeen)
        : mayBeUnresolved(entry.source, symbolSeen));
    }
    return staticValue(node).size === 0;
  }

  function mayBeUnresolvedProperty(node, name, visited) {
    if (!node || !name || visited.has(node)) return true;
    const seen = new Set(visited).add(node);
    const transparent = transparentExpression(node);
    if (transparent) return mayBeUnresolvedProperty(transparent, name, seen);
    if (ts.isObjectLiteralExpression(node)) {
      let found = false;
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          found = true;
          if (mayBeUnresolvedProperty(property.expression, name, seen)) return true;
          continue;
        }
        if (ts.isGetAccessorDeclaration(property)) {
          const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
            ? property.name.text
            : ts.isComputedPropertyName(property.name)
              ? [...staticValue(property.name.expression, seen)].find(value => typeof value === 'string' ||
                typeof value === 'number')?.toString() || null
              : null;
          if (key !== name) continue;
          found = true;
          for (const statement of property.body?.statements || []) {
            if (ts.isReturnStatement(statement) && statement.expression &&
              mayBeUnresolved(statement.expression, seen)) return true;
          }
          continue;
        }
        if (!property.name) continue;
        const shorthand = ts.isShorthandPropertyAssignment(property);
        if (!shorthand && !ts.isPropertyAssignment(property)) continue;
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text
          : ts.isComputedPropertyName(property.name)
            ? [...staticValue(property.name.expression, seen)].find(value => typeof value === 'string' ||
              typeof value === 'number')?.toString() || null
            : null;
        if (key !== name) continue;
        found = true;
        const value = shorthand ? property.name : property.initializer;
        if (mayBeUnresolved(value, seen)) return true;
      }
      return !found;
    }
    if (!ts.isIdentifier(node)) return true;
    const symbol = checker.getSymbolAtLocation(node);
    const declaration = symbolDeclaration(symbol);
    if (!declaration || visited.has(symbol)) return true;
    const symbolSeen = new Set(seen).add(symbol);
    const index = Number(name);
    if (Number.isInteger(index) && index >= 0) {
      const restSources = (parameterArguments.get(symbol) || [])
        .filter(entry => entry && entry.restIndex === index && entry.source)
        .map(entry => entry.source);
      if (restSources.length) return restSources.some(source => mayBeUnresolved(source, symbolSeen));
    }
    const checks = [];
    const memberSources = [];
    for (const receiver of receiverSymbols(node)) {
      const byName = memberAssignments.get(receiver);
      if (byName) memberSources.push(...(byName.get(String(name)) || []));
    }
    for (const assigned of memberSources) checks.push({ source: assigned.source });
    if ((ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) && declaration.initializer) {
      const initializer = declaration.initializer;
      const hasNamedProperty = !ts.isObjectLiteralExpression(initializer) || initializer.properties.some(property => {
        if (!property.name) return false;
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text : null;
        return key === name;
      });
      if (hasNamedProperty) checks.push({ source: initializer, property: true });
    }
    for (const assigned of assignments.get(symbol) || []) {
      if (!assigned.name) checks.push({ source: assigned.source, property: true });
    }
    if (!checks.length) return true;
    return checks.some(check => check.property
      ? mayBeUnresolvedProperty(check.source, name, symbolSeen)
      : mayBeUnresolved(check.source, symbolSeen));
  }

  // Named property of a literal object origin, reached directly or through
  // identifier aliases. Static lookup only: keys must resolve to literals.
  function literalProperty(node, name, visited) {
    const found = new Set();
    if (!node || !name || visited.has(node)) return found;
    const seen = new Set(visited).add(node);
    const transparent = transparentExpression(node);
    if (transparent) return literalProperty(transparent, name, seen);
    if (moduleResolver?.resolveProperty) {
      for (const atom of resolveSet(node, seen)) {
        if (!moduleResolver.modulePathFromAtom(atom)) continue;
        for (const resolved of moduleResolver.resolveProperty([atom], name, virtualPath, seen)) found.add(resolved);
      }
      if (found.size) return found;
    }
    if (moduleResolver && ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' && ts.isStringLiteral(node.arguments[0])) {
      for (const atom of moduleResolver.resolveRequire(virtualPath, node.arguments[0].text)) {
        const modulePath = moduleResolver.modulePathFromAtom(atom);
        if (!modulePath) continue;
        for (const resolved of moduleResolver.resolveExport(modulePath, name, seen)) found.add(resolved);
      }
      return found;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          for (const atom of literalProperty(property.expression, name, seen)) found.add(atom);
          continue;
        }
        if (ts.isGetAccessorDeclaration(property)) {
          const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
            ? property.name.text
            : ts.isComputedPropertyName(property.name)
              ? [...staticValue(property.name.expression, seen)].find(value => typeof value === 'string' ||
                typeof value === 'number')?.toString() || null
              : null;
          if (key !== name) continue;
          for (const statement of property.body?.statements || []) {
            if (!ts.isReturnStatement(statement) || !statement.expression) continue;
            for (const atom of resolveSet(statement.expression, seen)) found.add(atom);
          }
          continue;
        }
        if (!property.name) continue;
        const shorthand = ts.isShorthandPropertyAssignment(property);
        if (!shorthand && !ts.isPropertyAssignment(property)) continue;
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text
          : ts.isComputedPropertyName(property.name)
            ? [...staticValue(property.name.expression, seen)].find(value => typeof value === 'string' ||
              typeof value === 'number')?.toString() || null
            : null;
        if (key !== name) continue;
        const value = shorthand ? property.name : property.initializer;
        for (const atom of resolveSet(value, seen)) found.add(atom);
      }
      return found;
    }
    if (moduleResolver?.resolveProperty) {
      for (const atom of resolveSet(node, visited)) {
        for (const resolved of moduleResolver.resolveProperty([atom], name, virtualPath, seen)) {
          found.add(resolved);
        }
      }
      if (found.size) return found;
    }
    if (!ts.isIdentifier(node)) return found;
    const symbol = checker.getSymbolAtLocation(node);
    const declaration = symbolDeclaration(symbol);
    if (!declaration || visited.has(symbol)) return found;
    const symbolSeen = new Set(seen).add(symbol);
    const origins = [];
    const memberSources = [];
    for (const receiver of receiverSymbols(node)) {
      const byName = memberAssignments.get(receiver);
      if (byName) memberSources.push(...(byName.get(String(name)) || []));
    }
    for (const assigned of memberSources) {
      for (const atom of resolveSet(assigned.source, seen)) found.add(atom);
    }
    if ((ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) && declaration.initializer) {
      origins.push(declaration.initializer);
    }
    for (const assigned of assignments.get(symbol) || []) if (!assigned.name) origins.push(assigned.source);
    for (const origin of origins) {
      for (const atom of literalProperty(origin, name, symbolSeen)) found.add(atom);
    }
    return found;
  }

  function valueMayBeUndefined(node, visited = new Set()) {
    if (!node || visited.has(node)) return true;
    const seen = new Set(visited).add(node);
    const transparent = transparentExpression(node);
    if (transparent) return valueMayBeUndefined(transparent, seen);
    if (ts.isVoidExpression(node)) return true;
    if (ts.isIdentifier(node) && node.text === 'undefined') return true;
    if (ts.isNumericLiteral(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isClassExpression(node) ||
      ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isNewExpression(node)) {
      return false;
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const directDeclaration = symbol?.valueDeclaration || symbol?.declarations?.[0];
      if (directDeclaration && (ts.isFunctionDeclaration(directDeclaration) ||
        ts.isClassDeclaration(directDeclaration))) return false;
      const declaration = symbolDeclaration(symbol);
      if (!declaration || visited.has(symbol)) return true;
      const symbolSeen = new Set(seen).add(symbol);
      const sources = [];
      if ((ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) && declaration.initializer) {
        sources.push(declaration.initializer);
      } else if (ts.isBindingElement(declaration)) {
        const bindingSourcesList = bindingSources(declaration, symbolSeen);
        if (bindingSourcesList) {
          for (const source of bindingSourcesList) sources.push(source);
        }
        if (declaration.initializer) sources.push(declaration.initializer);
      }
      for (const assigned of assignments.get(symbol) || []) {
        sources.push(assigned && assigned.source ? assigned.source : assigned);
      }
      if (!sources.length) return true;
      return sources.some(source => valueMayBeUndefined(source, symbolSeen));
    }
    const values = resolveSet(node, seen);
    if (values.has(UNDEFINED_VALUE)) return true;
    if (values.size) return false;
    return ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
  }

  function staticTruthiness(node, visited = new Set()) {
    if (!node || visited.has(node)) return null;
    const seen = new Set(visited).add(node);
    const transparent = transparentExpression(node);
    if (transparent) return staticTruthiness(transparent, seen);
    if (node.kind === ts.SyntaxKind.TrueKeyword || ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) || ts.isClassExpression(node) || ts.isObjectLiteralExpression(node) ||
      ts.isArrayLiteralExpression(node) || ts.isNewExpression(node)) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return false;
    if (ts.isNumericLiteral(node)) return Number(node.text) === 0 ? false : true;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text.length > 0;
    if (ts.isConditionalExpression(node)) {
      const whenTrue = staticTruthiness(node.whenTrue, seen);
      const whenFalse = staticTruthiness(node.whenFalse, seen);
      return whenTrue === whenFalse ? whenTrue : null;
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator === ts.SyntaxKind.EqualsToken) return staticTruthiness(node.right, seen);
      if (operator === ts.SyntaxKind.BarBarToken) {
        const left = staticTruthiness(node.left, seen);
        return left === true ? true : left === false ? staticTruthiness(node.right, seen) : null;
      }
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
        const left = staticTruthiness(node.left, seen);
        return left === false ? false : left === true ? staticTruthiness(node.right, seen) : null;
      }
    }
    if (!ts.isIdentifier(node)) return null;
    if (node.text === 'undefined') return false;
    const symbol = checker.getSymbolAtLocation(node);
    const directDeclaration = symbol?.valueDeclaration || symbol?.declarations?.[0];
    if (directDeclaration && (ts.isFunctionDeclaration(directDeclaration) ||
      ts.isClassDeclaration(directDeclaration))) return true;
    const declaration = symbolDeclaration(symbol);
    if (!declaration || visited.has(symbol)) return null;
    const symbolSeen = new Set(seen).add(symbol);
    const sources = [];
    if ((ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) && declaration.initializer) {
      sources.push(declaration.initializer);
    }
    for (const argument of parameterArguments.get(symbol) || []) {
      sources.push(argument && argument.source ? argument.source : argument);
    }
    for (const assigned of assignments.get(symbol) || []) {
      sources.push(assigned && assigned.source ? assigned.source : assigned);
    }
    if (!sources.length) return null;
    const states = sources.map(source => staticTruthiness(source, symbolSeen));
    if (states.every(state => state === true)) return true;
    if (states.every(state => state === false)) return false;
    return null;
  }

  function staticNullishness(node, visited = new Set()) {
    if (!node || visited.has(node)) return null;
    const seen = new Set(visited).add(node);
    const transparent = transparentExpression(node);
    if (transparent) return staticNullishness(transparent, seen);
    if (node.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(node) ||
      ts.isIdentifier(node) && node.text === 'undefined') return true;
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword ||
      ts.isNumericLiteral(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isClassExpression(node) ||
      ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isNewExpression(node)) return false;
    if (ts.isConditionalExpression(node)) {
      const whenTrue = staticNullishness(node.whenTrue, seen);
      const whenFalse = staticNullishness(node.whenFalse, seen);
      return whenTrue === whenFalse ? whenTrue : null;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return staticNullishness(node.right, seen);
    }
    if (!ts.isIdentifier(node)) return null;
    const symbol = checker.getSymbolAtLocation(node);
    const directDeclaration = symbol?.valueDeclaration || symbol?.declarations?.[0];
    if (directDeclaration && (ts.isFunctionDeclaration(directDeclaration) ||
      ts.isClassDeclaration(directDeclaration))) return false;
    const declaration = symbolDeclaration(symbol);
    if (!declaration || visited.has(symbol)) return null;
    const symbolSeen = new Set(seen).add(symbol);
    const sources = [];
    if ((ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) && declaration.initializer) {
      sources.push(declaration.initializer);
    }
    for (const argument of parameterArguments.get(symbol) || []) {
      sources.push(argument && argument.source ? argument.source : argument);
    }
    for (const assigned of assignments.get(symbol) || []) {
      sources.push(assigned && assigned.source ? assigned.source : assigned);
    }
    if (!sources.length) return null;
    const states = sources.map(source => staticNullishness(source, symbolSeen));
    if (states.every(state => state === false)) return false;
    if (states.every(state => state === true)) return true;
    return null;
  }

  function isDefinitelyTruthy(node) {
    return staticTruthiness(node) === true;
  }

  function isDefinitelyFalsy(node) {
    return staticTruthiness(node) === false;
  }

  function isDefinitelyNonNullish(node) {
    return staticNullishness(node) === false;
  }

  function bindingDefaultMayApply(binding, sources, visited) {
    if (!sources) return true;
    if (ts.isArrayBindingPattern(binding.parent)) {
      return sources.some(source => valueMayBeUndefined(source, visited));
    }
    const name = bindingPropertyName(binding);
    if (!name) return true;
    for (const source of sources) {
      const origins = propertyOriginNodes(source, name, visited);
      if (!origins.length || origins.some(origin => valueMayBeUndefined(origin, visited))) return true;
    }
    return false;
  }

  function addFromBindingElement(binding, visited, result) {
    const sources = bindingSources(binding);
    const sourceSet = new Set();
    if (sources) {
      for (const source of sources) {
        for (const atom of resolveSet(source, visited)) sourceSet.add(atom);
      }
    }
    const name = bindingPropertyName(binding);
    if (binding.initializer && bindingDefaultMayApply(binding, sources, visited)) {
      for (const atom of resolveSet(binding.initializer, visited)) result.add(atom);
    }
    if (sources) {
      for (const source of sources) {
        for (const atom of literalProperty(source, name, visited)) result.add(atom);
      }
    }
    if (ts.isArrayBindingPattern(binding.parent)) {
      for (const atom of sourceSet) result.add(atom);
    }
    if (name === 'directPostOwnerAlive') {
      result.add(LEGACY_OWNER);
      return;
    }
    if (name === 'kill' && hasAtom(sourceSet, PROCESS_OBJECT)) result.add(PID_PROBE);
    if (name === 'call' && hasAtom(sourceSet, PID_PROBE)) result.add(CALL_METHOD);
    if (name === 'apply' && hasAtom(sourceSet, PID_PROBE)) result.add(APPLY_METHOD);
    if (name === 'apply' && hasAtom(sourceSet, REFLECT_OBJECT)) result.add(REFLECT_APPLY);
    if (name === 'call' && hasAtom(sourceSet, REFLECT_APPLY)) result.add(REFLECT_CALL_METHOD);
    if (name === 'apply' && hasAtom(sourceSet, REFLECT_APPLY)) result.add(REFLECT_APPLY_METHOD);
  }

  function forwardedCallbackName(callee, visited = new Set()) {
    if (ts.isParenthesizedExpression(callee)) return forwardedCallbackName(callee.expression, visited);
    const isTimerRequire = expression => {
      if (!expression) return false;
      const node = ts.isParenthesizedExpression(expression) ? expression.expression : expression;
      return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' &&
        ts.isStringLiteral(node.arguments[0]) &&
        (node.arguments[0].text === 'node:timers' || node.arguments[0].text === 'timers');
    };
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      const members = ts.isPropertyAccessExpression(callee)
        ? new Set([callee.name.text]) : staticValue(callee.argumentExpression);
      if (members.size !== 1) return null;
      const member = [...members][0];
      if (typeof member !== 'string' || !FORWARDED_CALLBACK_APIS.has(member)) return null;
      if (isTimerRequire(callee.expression)) return member;
      const receiverSymbol = checker.getSymbolAtLocation(callee.expression);
      for (const declaration of receiverSymbol?.declarations || []) {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer &&
          isTimerRequire(declaration.initializer)) return member;
      }
      return null;
    }
    if (!ts.isIdentifier(callee)) return null;
    const symbol = checker.getSymbolAtLocation(callee);
    if (symbol && visited.has(symbol)) return null;
    const seen = new Set(visited);
    if (symbol) seen.add(symbol);
    let sawImport = false;
    for (const declaration of symbol?.declarations || []) {
      let parent = declaration;
      while (parent && !ts.isImportDeclaration(parent)) parent = parent.parent;
      if (!parent) continue;
      sawImport = true;
      if (!ts.isStringLiteral(parent.moduleSpecifier) ||
        (parent.moduleSpecifier.text !== 'node:timers' && parent.moduleSpecifier.text !== 'timers')) continue;
      if (ts.isImportSpecifier(declaration)) {
        const importedName = declaration.propertyName || declaration.name;
        if (FORWARDED_CALLBACK_APIS.has(importedName.text)) return importedName.text;
      }
    }
    if (sawImport) return null;
    for (const declaration of symbol?.declarations || []) {
      if (!ts.isBindingElement(declaration)) continue;
      const variable = declaration.parent?.parent;
      if (!variable || !ts.isVariableDeclaration(variable) || !variable.initializer ||
        !isTimerRequire(variable.initializer)) continue;
      const importedName = declaration.propertyName || declaration.name;
      if (ts.isIdentifier(importedName) && FORWARDED_CALLBACK_APIS.has(importedName.text)) {
        return importedName.text;
      }
    }
    if (FORWARDED_CALLBACK_APIS.has(callee.text) && !symbolDeclaration(symbol)) return callee.text;
    const declaration = symbolDeclaration(symbol);
    if (declaration && (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration) ||
      ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)) && declaration.initializer) {
      const resolved = forwardedCallbackName(declaration.initializer, seen);
      if (resolved) return resolved;
    }
    for (const assigned of assignments.get(symbol) || []) {
      const source = assigned && assigned.source ? assigned.source : assigned;
      const resolved = forwardedCallbackName(source, seen);
      if (resolved) return resolved;
    }
    return null;
  }

  function isForwardingCallbackApi(callee) {
    if ((ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      forwardedCallbackName(callee)) return true;
    return ts.isPropertyAccessExpression(callee) && callee.name.text === 'nextTick' &&
      hasAtom(staticValue(callee.expression), PROCESS_OBJECT);
  }

  indexRightHandSide(sourceFile);
  indexParameterArguments(sourceFile);
  for (const { access, value } of pendingMemberAssignments) indexMemberAssignment(access, value);

  function indexForwardedCallback(node, owner) {
    const argumentsList = expandCallArguments(node.arguments);
    const callback = argumentsList ? argumentsList[0] : node.arguments[0];
    const resolved = callback && staticValue(callback);
    const isProbe = resolved && hasAtom(resolved, PID_PROBE);
    const isProbeLike = resolved && [BOUND_PROBE, ...INVOCATION_METHODS].some(atom => hasAtom(resolved, atom));
    if (!isProbe && !isProbeLike) return;
    if (!isProbe) {
      violations.push(`unsupported process probe ${fileName}:${owner}`);
      return;
    }
    const callee = node.expression;
    const callbackName = forwardedCallbackName(callee);
    const usesDelay = callbackName === 'setTimeout' || callbackName === 'setInterval';
    const signal = argumentsList && argumentsList[usesDelay ? 3 : 2];
    const values = signal ? staticValue(signal) : new Set();
    if (hasAtom(values, 0)) kills.push({ file: fileName, owner });
    if (argumentsList === null || (signal && (values.size === 0 || mayBeUnresolved(signal)))) {
      violations.push(`unsupported process probe ${fileName}:${owner}`);
    }
  }

  const argumentMayCarryProbe = (expression, visited = new Set()) => {
    if (!expression || visited.has(expression)) return false;
    const seen = new Set(visited).add(expression);
    const node = ts.isSpreadElement(expression) ? expression.expression : expression;
    const atoms = staticValue(node);
    if ([PID_PROBE, PROCESS_OBJECT, BOUND_PROBE, BOUND_REFLECT_APPLY, REFLECT_APPLY,
      REFLECT_CALL_METHOD, REFLECT_APPLY_METHOD, ...INVOCATION_METHODS]
      .some(atom => hasAtom(atoms, atom))) return true;
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.some(property => ts.isSpreadAssignment(property)
        ? argumentMayCarryProbe(property.expression, seen)
        : ts.isPropertyAssignment(property)
          ? argumentMayCarryProbe(property.initializer, seen)
          : ts.isShorthandPropertyAssignment(property)
            ? argumentMayCarryProbe(property.name, seen) : false);
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.some(element => argumentMayCarryProbe(element, seen));
    }
    if (ts.isIdentifier(node)) {
      const symbol = node.text === 'undefined' ? null : checker.getSymbolAtLocation(node);
      const declaration = symbolDeclaration(symbol);
      if (declaration && (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) && declaration.initializer &&
        argumentMayCarryProbe(declaration.initializer, seen)) return true;
      return (assignments.get(symbol) || []).some(assigned =>
        argumentMayCarryProbe(assigned && assigned.source ? assigned.source : assigned, seen));
    }
    return false;
  };

  const visit = node => {
    if (ts.isNewExpression(node)) {
      const importedClass = [...staticValue(node.expression)].some(atom => atom?.classDeclaration);
      const argumentsList = expandCallArguments(node.arguments);
      const hasProbeArgument = argumentsList?.some(argument => hasAtom(staticValue(argument), PID_PROBE));
      if (importedClass && (argumentsList === null || hasProbeArgument)) {
        violations.push(`unsupported process probe ${fileName}:${generatedOwner || enclosingOwner(node)}`);
      }
    }
    if (ts.isCallExpression(node)) {
      const owner = generatedOwner || enclosingOwner(node);
      const callee = node.expression;
      const calleeNames = accessNames(callee);
      const expandedArguments = expandCallArguments(node.arguments);
      const callArguments = expandedArguments || [];
      if (isForwardingCallbackApi(callee)) indexForwardedCallback(node, owner);
      const arrayCallbackMethod = ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      const arrayCallback = callArguments[0] || node.arguments[0];
      if (arrayCallbackMethod && (finiteArrayCallbackMethods.has(arrayCallbackMethod) ||
        finiteArrayReducerMethods.has(arrayCallbackMethod)) && arrayCallback) {
        const elements = literalArrayElements(callee.expression);
        const callbackAtoms = staticValue(arrayCallback);
        if (hasAtom(callbackAtoms, PID_PROBE)) {
          if (!elements) violations.push(`unsupported process probe ${fileName}:${owner}`);
          else if (finiteArrayReducerMethods.has(arrayCallbackMethod)) {
            const signalArguments = finiteReducerSignalArguments(arrayCallbackMethod, elements, expandedArguments);
            if (signalArguments === null) {
              violations.push(`unsupported process probe ${fileName}:${owner}`);
            } else {
              let hasZeroSignal = false;
              let hasUnresolvedSignal = false;
              for (const signal of signalArguments) {
                if (!signal || ts.isOmittedExpression(signal)) {
                  hasUnresolvedSignal = true;
                  continue;
                }
                const signalValues = staticValue(signal);
                if (hasAtom(signalValues, 0)) hasZeroSignal = true;
                if (signalValues.size === 0 || mayBeUnresolved(signal)) hasUnresolvedSignal = true;
              }
              if (hasZeroSignal) kills.push({ file: fileName, owner });
              if (hasUnresolvedSignal) violations.push(`unsupported process probe ${fileName}:${owner}`);
            }
          } else if (elements[0] && !ts.isOmittedExpression(elements[0])) kills.push({ file: fileName, owner });
        } else if ([BOUND_PROBE, ...INVOCATION_METHODS].some(atom => hasAtom(callbackAtoms, atom))) {
          violations.push(`unsupported process probe ${fileName}:${owner}`);
        }
      }
      const calleeReceiver = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
        ? staticValue(callee.expression)
        : new Set();
      const method = calleeNames.size === 1 &&
        (calleeNames.has('bind') || calleeNames.has('call') || calleeNames.has('apply')) &&
        hasAtom(calleeReceiver, PID_PROBE);
      const methodName = calleeNames.size === 1 ? [...calleeNames][0] : null;
      if (method && methodName !== 'bind') {
        // `.call(thisArg, pid, signal)` / `.apply(thisArg, [pid, signal])` shift
        // the arguments. A signal this parse cannot resolve (absent, nonliteral
        // list, unknown value) is refused: never guessed, never evaluated.
        const list = callArguments[1];
        const listElements = literalArrayElements(list);
        const signal = methodName === 'call' ? callArguments[2]
          : listElements ? listElements[1] : undefined;
        const values = signal ? staticValue(signal) : new Set();
        if (hasAtom(values, 0)) kills.push({ file: fileName, owner });
        const unknownApplyList = methodName === 'apply' && (!list || !listElements);
        if (expandedArguments === null || unknownApplyList ||
          (signal && (values.size === 0 || mayBeUnresolved(signal)))) {
          violations.push(`unsupported process probe ${fileName}:${owner}`);
        }
      } else if (calleeNames.size === 1 &&
        (calleeNames.has('call') || calleeNames.has('apply')) &&
        hasAtom(calleeReceiver, REFLECT_APPLY)) {
        const target = calleeNames.has('call')
          ? callArguments[1]
          : literalArrayElements(callArguments[1])
            ? literalArrayElements(callArguments[1])[0]
            : undefined;
        const probeTarget = target && staticValue(target);
        if (probeTarget && [PID_PROBE, BOUND_PROBE, BOUND_REFLECT_APPLY, REFLECT_APPLY,
          REFLECT_CALL_METHOD, REFLECT_APPLY_METHOD, ...INVOCATION_METHODS]
          .some(atom => hasAtom(probeTarget, atom))) {
          violations.push(`unsupported process probe ${fileName}:${owner}`);
        }
      } else if (!method) {
        const resolved = staticValue(callee);
        const importedCallable = [...resolved].some(atom =>
          atom?.callable && atom.modulePath && atom.modulePath !== virtualPath);
        const probeBearingArguments = node.arguments.some(argument => argumentMayCarryProbe(argument));
        if (importedCallable && probeBearingArguments) {
          violations.push(`unsupported process probe ${fileName}:${owner}`);
        }
        const isBind = calleeNames.has('bind');
        if (!isBind && (hasAtom(resolved, BOUND_PROBE) || hasAtom(resolved, BOUND_REFLECT_APPLY))) {
          violations.push(`unsupported process probe ${fileName}:${owner}`);
        }
        if (hasAtom(resolved, REFLECT_CALL_METHOD)) {
          const target = callArguments[1] && staticValue(callArguments[1]);
          if (target && [PID_PROBE, BOUND_PROBE, BOUND_REFLECT_APPLY, ...INVOCATION_METHODS]
            .some(atom => hasAtom(target, atom))) {
            violations.push(`unsupported process probe ${fileName}:${owner}`);
          }
        }
        if (hasAtom(resolved, REFLECT_APPLY_METHOD)) {
          const list = callArguments[1];
          const listElements = literalArrayElements(list);
          const target = listElements && listElements[0] ? staticValue(listElements[0]) : null;
          if (target && [PID_PROBE, BOUND_PROBE, BOUND_REFLECT_APPLY, ...INVOCATION_METHODS]
            .some(atom => hasAtom(target, atom))) {
            violations.push(`unsupported process probe ${fileName}:${owner}`);
          }
        }
        const isProbe = hasAtom(resolved, PID_PROBE);
        if (isProbe && !isBind) {
          const signal = callArguments[1];
          const values = signal ? staticValue(signal) : new Set();
          if (hasAtom(values, 0)) kills.push({ file: fileName, owner });
          if (expandedArguments === null || (signal && (values.size === 0 || mayBeUnresolved(signal)))) {
            violations.push(`unsupported process probe ${fileName}:${owner}`);
          }
        }
        if (!isBind && INVOCATION_METHODS.some(atom => hasAtom(resolved, atom))) {
          violations.push(`unsupported process probe ${fileName}:${owner}`);
        }
        const probeTarget = callArguments[0] && staticValue(callArguments[0]);
        if (hasAtom(resolved, REFLECT_APPLY) && probeTarget &&
          [PID_PROBE, BOUND_PROBE, BOUND_REFLECT_APPLY, REFLECT_APPLY, ...INVOCATION_METHODS]
            .some(atom => hasAtom(probeTarget, atom))) {
          violations.push(`unsupported process probe ${fileName}:${owner}`);
        }
        if (hasAtom(resolved, LEGACY_OWNER)) legacyCalls.push({ file: fileName, owner });
      }
    }
    if (!generatedOwner && ts.isStringLiteral(node) && node.text.includes('process.kill')) {
      const nested = parseOwnerSites(fileName, node.text, enclosingOwner(node));
      kills.push(...nested.kills);
      legacyCalls.push(...nested.legacyCalls);
      violations.push(...nested.violations);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { kills, legacyCalls, violations };
}

function inventoryProcessOwnerSites(root) {
  const kills = [];
  const legacyCalls = [];
  const violations = [];
  const files = sourceFiles(root);
  const moduleResolver = createLocalModuleResolver(files);
  for (const full of files) {
    const relative = path.relative(root, full).split(path.sep).join('/');
    const parsed = parseOwnerSites(relative, fs.readFileSync(full, 'utf8'), null, moduleResolver, full);
    for (const site of parsed.kills) {
      const key = `${site.file}\u0000${site.owner}`;
      kills.push(key);
      if (!PRESERVED_PROBES.has(key)) violations.push(`unclassified process probe ${site.file}:${site.owner}`);
    }
    for (const site of parsed.legacyCalls) {
      legacyCalls.push(`${site.file}\u0000${site.owner}`);
      violations.push(`legacy directPostOwnerAlive callsite ${site.file}:${site.owner}`);
    }
    violations.push(...parsed.violations);
  }
  return { kills, legacyCalls, violations };
}

module.exports = {
  SRC_ROOT,
  PRESERVED_PROBES,
  sourceFiles,
  enclosingOwner,
  parseOwnerSites,
  inventoryProcessOwnerSites
};
