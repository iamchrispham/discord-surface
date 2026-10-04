'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

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

function sourceFiles(root) {
  const found = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|ts)$/.test(entry.name)) found.push(full);
    }
  };
  walk(root);
  return found;
}

function enclosingOwner(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText();
    if (ts.isPropertyAssignment(current) && current.name &&
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

function parseOwnerSites(fileName, text, generatedOwner = null) {
  const kind = fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const virtualPath = path.resolve(fileName);
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
  const parameterArguments = new Map();
  const recordAssignment = (symbol, value) => {
    if (!symbol) return;
    const existing = assignments.get(symbol);
    if (existing) existing.push(value);
    else assignments.set(symbol, [value]);
  };
  const recordParameterArgument = (symbol, value) => {
    if (!symbol || !value) return;
    const existing = parameterArguments.get(symbol);
    if (existing) existing.push(value);
    else parameterArguments.set(symbol, [value]);
  };
  const indexRightHandSide = expression => {
    if (!expression) return;
    const operator = ts.isBinaryExpression(expression) ? expression.operatorToken.kind : null;
    const isAssignment = operator === ts.SyntaxKind.EqualsToken ||
      operator === ts.SyntaxKind.BarBarEqualsToken ||
      operator === ts.SyntaxKind.QuestionQuestionEqualsToken ||
      operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken;
    if (ts.isBinaryExpression(expression) && isAssignment) {
      const left = ts.isParenthesizedExpression(expression.left) ? expression.left.expression : expression.left;
      if (ts.isIdentifier(left)) {
        recordAssignment(checker.getSymbolAtLocation(left), { source: expression.right });
      } else if (ts.isObjectLiteralExpression(left)) {
        for (const property of left.properties) {
          let target = null;
          let name = null;
          if (ts.isPropertyAssignment(property)) {
            name = ts.isIdentifier(property.name) ? property.name.text
              : ts.isStringLiteral(property.name) ? property.name.text : null;
            // Resolve the target identifier node directly; its symbol is the
            // lexical place, which is what a call-site identifier resolves to.
            target = ts.isIdentifier(property.initializer) ? checker.getSymbolAtLocation(property.initializer)
              : ts.isParenthesizedExpression(property.initializer) && ts.isIdentifier(property.initializer.expression)
                ? checker.getSymbolAtLocation(property.initializer.expression) : null;
          } else if (ts.isShorthandPropertyAssignment(property)) {
            name = property.name.text;
            // For shorthand, `getSymbolAtLocation(property.name)` returns the
            // shorthand property symbol, not the assigned variable; the value
            // symbol is the lexical place the call site uses.
            target = checker.getShorthandAssignmentValueSymbol(property);
          }
          if (target) recordAssignment(target, { source: expression.right, name });
        }
      } else if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
        const propertySymbol = ts.isPropertyAccessExpression(left)
          ? checker.getSymbolAtLocation(left.name)
          : checker.getSymbolAtLocation(left);
        recordAssignment(propertySymbol, { source: expression.right });
      }
    }
    ts.forEachChild(expression, indexRightHandSide);
  };
  indexRightHandSide(sourceFile);

  const callableParameters = callee => {
    if (!ts.isIdentifier(callee)) return [];
    const symbol = checker.getSymbolAtLocation(callee);
    const declaration = symbol && symbol.valueDeclaration;
    if (declaration && (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration) ||
      ts.isArrowFunction(declaration) || ts.isMethodDeclaration(declaration))) {
      return declaration.parameters;
    }
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer &&
      (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer))) {
      return declaration.initializer.parameters;
    }
    return [];
  };
  const indexParameterArguments = node => {
    if (ts.isCallExpression(node)) {
      const parameters = callableParameters(node.expression);
      for (let index = 0; index < parameters.length; index += 1) {
        const argument = node.arguments[index];
        if (argument && !ts.isSpreadElement(argument)) {
          recordParameterArgument(checker.getSymbolAtLocation(parameters[index].name), argument);
        }
      }
    }
    ts.forEachChild(node, indexParameterArguments);
  };
  indexParameterArguments(sourceFile);

  const hasAtom = (set, atom) => Boolean(set) && set.has(atom);

  function accessNames(node, visited) {
    if (ts.isPropertyAccessExpression(node)) return new Set([node.name.text]);
    if (ts.isElementAccessExpression(node)) return staticValue(node.argumentExpression, visited);
    return new Set();
  }

  // True only for a symbol bound by an object-destructuring pattern
  // (BindingElement), whose possible values are the pattern sources of its
  // enclosing parameter or variable declaration. Returns false for plain
  // variables, which resolve through their own initializer.
  function bindingSources(declaration) {
    if (!ts.isBindingElement(declaration) || !ts.isObjectBindingPattern(declaration.parent)) return false;
    const container = declaration.parent.parent;
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

  function resolveSet(node, visited) {
    const empty = new Set();
    if (!node || visited.has(node)) return empty;
    const seen = new Set(visited).add(node);
    if (ts.isParenthesizedExpression(node)) return resolveSet(node.expression, seen);
    if (ts.isNumericLiteral(node)) return new Set([Number(node.text)]);
    if (ts.isStringLiteral(node)) return new Set([node.text]);
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
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken) {
        const union = resolveSet(node.left, seen);
        for (const atom of resolveSet(node.right, seen)) union.add(atom);
        return union;
      }
      return empty;
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const names = accessNames(node, seen);
      if (!names.size) return empty;
      const receiver = resolveSet(node.expression, seen);
      const result = new Set();
      for (const name of names) {
        if (name === 'directPostOwnerAlive') result.add(LEGACY_OWNER);
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
      const propertySymbol = ts.isPropertyAccessExpression(node)
        ? checker.getSymbolAtLocation(node.name)
        : checker.getSymbolAtLocation(node);
      for (const assigned of assignments.get(propertySymbol) || []) {
        for (const atom of resolveSet(assigned.source, seen)) result.add(atom);
      }
      return result;
    }

    if (ts.isCallExpression(node)) {
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
      return empty;
    }

    if (!ts.isIdentifier(node)) return empty;
    // A shorthand property key names the property symbol; the value is the binding.
    const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    const declaration = symbol && symbol.valueDeclaration;
    if (!declaration) {
      if (node.text === 'process') return new Set([PROCESS_OBJECT]);
      if (node.text === 'Reflect') return new Set([REFLECT_OBJECT]);
      return node.text === 'directPostOwnerAlive' ? new Set([LEGACY_OWNER]) : empty;
    }
    if (visited.has(symbol)) return empty;
    const symbolSeen = new Set(visited).add(symbol);

    const result = new Set();
    const addFrom = valueNode => {
      for (const atom of resolveSet(valueNode, symbolSeen)) result.add(atom);
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
      if (entry.name === 'apply' && hasAtom(sourceSet, REFLECT_OBJECT)) result.add(REFLECT_APPLY);
      if (entry.name === 'call' && hasAtom(sourceSet, REFLECT_APPLY)) result.add(REFLECT_CALL_METHOD);
      if (entry.name === 'apply' && hasAtom(sourceSet, REFLECT_APPLY)) result.add(REFLECT_APPLY_METHOD);
      for (const atom of literalProperty(entry.source, entry.name, symbolSeen)) result.add(atom);
    };

    if (ts.isVariableDeclaration(declaration)) {
      addFrom(declaration.initializer);
    } else if (ts.isParameter(declaration)) {
      addFrom(declaration.initializer);
    } else if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
      addFromBindingElement(declaration, symbolSeen, result);
    } else if (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration) ||
      ts.isArrowFunction(declaration) || ts.isMethodDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
      // Function-shaped declarations are not probes by themselves; their body
      // is visited separately when it contains a call expression.
      return empty;
    }

    for (const argument of parameterArguments.get(symbol) || []) addFrom(argument);
    for (const assigned of assignments.get(symbol) || []) addFromAssignment(assigned);
    return result;
  }

  // Logical signal expressions keep their known branch values, but an
  // unresolved short-circuit operand still represents a possible zero at
  // runtime and must be refused rather than accepted as the known branch.
  function mayBeUnresolved(node, visited = new Set()) {
    if (!node || visited.has(node)) return true;
    const seen = new Set(visited).add(node);
    if (ts.isParenthesizedExpression(node)) return mayBeUnresolved(node.expression, seen);
    if (ts.isNumericLiteral(node) || ts.isStringLiteral(node)) return false;
    if (ts.isConditionalExpression(node)) {
      return mayBeUnresolved(node.whenTrue, seen) || mayBeUnresolved(node.whenFalse, seen);
    }
    if (ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
      return mayBeUnresolved(node.left, seen) || mayBeUnresolved(node.right, seen);
    }
    return staticValue(node).size === 0;
  }

  // Named property of a literal object origin, reached directly or through
  // identifier aliases. Static lookup only: computed keys are not evaluated.
  function literalProperty(node, name, visited) {
    const found = new Set();
    if (!node || !name || visited.has(node)) return found;
    const seen = new Set(visited).add(node);
    if (ts.isParenthesizedExpression(node)) return literalProperty(node.expression, name, seen);
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (!property.name) continue;
        const shorthand = ts.isShorthandPropertyAssignment(property);
        if (!shorthand && !ts.isPropertyAssignment(property)) continue;
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
        if (key !== name) continue;
        const value = shorthand ? property.name : property.initializer;
        for (const atom of resolveSet(value, seen)) found.add(atom);
      }
      return found;
    }
    if (!ts.isIdentifier(node)) return found;
    const symbol = checker.getSymbolAtLocation(node);
    const declaration = symbol && symbol.valueDeclaration;
    if (!declaration || visited.has(symbol)) return found;
    const symbolSeen = new Set(seen).add(symbol);
    const origins = [];
    if ((ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) && declaration.initializer) {
      origins.push(declaration.initializer);
    }
    for (const assigned of assignments.get(symbol) || []) if (!assigned.name) origins.push(assigned.source);
    for (const origin of origins) {
      for (const atom of literalProperty(origin, name, symbolSeen)) found.add(atom);
    }
    return found;
  }

  function addFromBindingElement(binding, visited, result) {
    const sources = bindingSources(binding);
    const sourceSet = new Set();
    if (sources) {
      for (const source of sources) {
        for (const atom of resolveSet(source, visited)) sourceSet.add(atom);
      }
    }
    const name = binding.propertyName
      ? (ts.isIdentifier(binding.propertyName) ? binding.propertyName.text
        : ts.isStringLiteral(binding.propertyName) ? binding.propertyName.text : null)
      : (ts.isIdentifier(binding.name) ? binding.name.text : null);
    if (binding.initializer) {
      for (const atom of resolveSet(binding.initializer, visited)) result.add(atom);
    }
    if (sources) {
      for (const source of sources) {
        for (const atom of literalProperty(source, name, visited)) result.add(atom);
      }
    }
    if (name === 'directPostOwnerAlive') {
      result.add(LEGACY_OWNER);
      return;
    }
    if (name === 'kill' && hasAtom(sourceSet, PROCESS_OBJECT)) result.add(PID_PROBE);
    if (name === 'apply' && hasAtom(sourceSet, REFLECT_OBJECT)) result.add(REFLECT_APPLY);
    if (name === 'call' && hasAtom(sourceSet, REFLECT_APPLY)) result.add(REFLECT_CALL_METHOD);
    if (name === 'apply' && hasAtom(sourceSet, REFLECT_APPLY)) result.add(REFLECT_APPLY_METHOD);
  }

  const visit = node => {
    if (ts.isCallExpression(node)) {
      const owner = generatedOwner || enclosingOwner(node);
      const callee = node.expression;
      const calleeNames = accessNames(callee);
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
        const list = node.arguments[1];
        const signal = methodName === 'call' ? node.arguments[2]
          : list && ts.isArrayLiteralExpression(list) ? list.elements[1] : undefined;
        const values = signal ? staticValue(signal) : new Set();
        if (hasAtom(values, 0)) kills.push({ file: fileName, owner });
        if (values.size === 0 || (signal && mayBeUnresolved(signal))) {
          violations.push(`unsupported process probe ${fileName}:${owner}`);
        }
      } else if (calleeNames.size === 1 &&
        (calleeNames.has('call') || calleeNames.has('apply')) &&
        hasAtom(calleeReceiver, REFLECT_APPLY)) {
        const target = calleeNames.has('call')
          ? node.arguments[1]
          : node.arguments[1] && ts.isArrayLiteralExpression(node.arguments[1])
            ? node.arguments[1].elements[0]
            : undefined;
        const probeTarget = target && staticValue(target);
        if (probeTarget && [PID_PROBE, BOUND_PROBE, ...INVOCATION_METHODS, REFLECT_APPLY]
          .some(atom => hasAtom(probeTarget, atom))) {
          violations.push(`unsupported process probe ${fileName}:${owner}`);
        }
      } else if (!method) {
        const resolved = staticValue(callee);
        const isBind = calleeNames.has('bind');
        if (!isBind && (hasAtom(resolved, BOUND_PROBE) || hasAtom(resolved, BOUND_REFLECT_APPLY))) {
          violations.push(`unsupported process probe ${fileName}:${owner}`);
        }
        if (hasAtom(resolved, REFLECT_CALL_METHOD)) {
          const target = node.arguments[1] && staticValue(node.arguments[1]);
          if (target && [PID_PROBE, BOUND_PROBE, BOUND_REFLECT_APPLY, ...INVOCATION_METHODS, REFLECT_APPLY]
            .some(atom => hasAtom(target, atom))) {
            violations.push(`unsupported process probe ${fileName}:${owner}`);
          }
        }
        if (hasAtom(resolved, REFLECT_APPLY_METHOD)) {
          const list = node.arguments[1];
          const target = list && ts.isArrayLiteralExpression(list) && list.elements[0]
            ? staticValue(list.elements[0]) : null;
          if (target && [PID_PROBE, BOUND_PROBE, BOUND_REFLECT_APPLY, ...INVOCATION_METHODS, REFLECT_APPLY]
            .some(atom => hasAtom(target, atom))) {
            violations.push(`unsupported process probe ${fileName}:${owner}`);
          }
        }
        const isProbe = hasAtom(resolved, PID_PROBE);
        if (isProbe && !isBind) {
          const signal = node.arguments[1];
          const values = signal ? staticValue(signal) : new Set();
          if (hasAtom(values, 0)) kills.push({ file: fileName, owner });
          if (values.size === 0 || (signal && mayBeUnresolved(signal))) {
            violations.push(`unsupported process probe ${fileName}:${owner}`);
          }
        }
        if (!isBind && INVOCATION_METHODS.some(atom => hasAtom(resolved, atom))) {
          violations.push(`unsupported process probe ${fileName}:${owner}`);
        }
        const probeTarget = node.arguments[0] && staticValue(node.arguments[0]);
        if (hasAtom(resolved, REFLECT_APPLY) && probeTarget &&
          [PID_PROBE, BOUND_PROBE, BOUND_REFLECT_APPLY, ...INVOCATION_METHODS, REFLECT_APPLY]
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
  for (const full of sourceFiles(root)) {
    const relative = path.relative(root, full).split(path.sep).join('/');
    const parsed = parseOwnerSites(relative, fs.readFileSync(full, 'utf8'));
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
