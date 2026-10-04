'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const SRC_ROOT = path.join(__dirname, '..', '..', 'src');

// ===========================================================================
// CLASS CENSUS: process-owner liveness probes and legacy destructive checks
// ===========================================================================
// Class. Every production PID liveness probe -- a `process.kill(pid, 0)`
// invocation (direct, aliased, property/element access) -- and every legacy
// destructive owner check -- a `directPostOwnerAlive` invocation -- must be
// inventoried through its resolved lexical alias, or refused as an
// `unclassified process probe` / `legacy directPostOwnerAlive callsite`
// violation when a potential probe cannot be resolved. Resolution is
// symbol-based over the TypeScript checker, never identifier spelling.
//
// Owner. parseOwnerSites/staticValue in this file; consumed by
// inventoryProcessOwnerSites and the two suites
// test/process-owner-evidence.test.js (scenario inventory.cjs) and
// test/process-owner-alias.test.js.
//
// Resolved shapes (a symbol resolves to a SET of possible static atoms; any
// possible probe wins):
//   - const/let/var initializer alias (`const probe = process.kill`)
//   - assignment-after-declaration / reassignment (`let probe; probe =
//     process.kill`) -- all assignments in the file are indexed class-first,
//     not flow-ordered, so a later ordinary assignment cannot erase a probe
//   - object destructuring, rename `{ kill: probe } = process` and shorthand
//     `{ kill } = process`
//   - mutable process-object alias (`let proc = process; proc.kill(pid, 0)`)
//   - zero-signal alias (`let signal = 0; process.kill(pid, signal)`)
//   - alias chains (`let second = first`)
//   - cyclic aliases (`let a = b; let b = a`) terminate via a bounded per-path
//     visited set of nodes and symbols; a probe-valued assignment in the cycle
//     still yields the kill and violation
//   - conditional/logical value unions (`flag ? process.kill : other`,
//     `a || b`) contribute every branch conservatively
//   - detected-but-unsupported sources (`.bind`/`.call`/`.apply` directly on a
//     probe-valued expression) still yield a kill/violation rather than being
//     silently dropped
//
// Negative controls (must stay non-probes):
//   - same-name lexical shadow (`const process = { kill() {} }`) and an inner
//     shadow of an outer probe alias
//   - ordinary mutable function reassignment without process.kill
//   - nonzero-only signal (`9`, or `9` reassigned to `10`)
//   - uninitialized never-assigned alias, and an absent initializer (no crash,
//     no classification by name)
//
// Boundary. This is a static parse of source text only. Values assigned
// outside the parsed source at runtime are outside this guarantee. Fixture
// source is read and parsed as text, never executed.
// ===========================================================================

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

  // Class-first assignment index: every `=` whose left is an Identifier, keyed
  // by the checker symbol of the left. A mutable symbol is resolved over its
  // initializer AND every assignment anywhere in the file, regardless of flow
  // order, so a possible probe can never be erased by an ordinary reassignment.
  const assignments = new Map();
  const recordAssignment = (symbol, right) => {
    if (!symbol) return;
    const existing = assignments.get(symbol);
    if (existing) existing.push(right);
    else assignments.set(symbol, [right]);
  };
  const indexRightHandSide = expression => {
    if (!expression) return;
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = expression.left;
      if (ts.isIdentifier(left)) {
        recordAssignment(checker.getSymbolAtLocation(left), expression.right);
      }
    }
    ts.forEachChild(expression, indexRightHandSide);
  };
  indexRightHandSide(sourceFile);

  const hasAtom = (set, atom) => Boolean(set) && set.has(atom);

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
      let name = null;
      if (ts.isElementAccessExpression(node)) {
        if (ts.isStringLiteral(node.argumentExpression)) name = node.argumentExpression.text;
        else return empty;
      } else {
        name = node.name.text;
      }
      const receiver = resolveSet(node.expression, seen);
      if (name === 'directPostOwnerAlive') return new Set([LEGACY_OWNER]);
      if (name === 'kill' && hasAtom(receiver, PROCESS_OBJECT)) return new Set([PID_PROBE]);
      // A probe method borrowed off a probe-valued receiver (.bind/.call/.apply)
      // stays a potential probe source; shield it so the invocation still counts
      // as a kill instead of vanishing.
      if ((name === 'bind' || name === 'call' || name === 'apply') && hasAtom(receiver, PID_PROBE)) {
        return new Set([PID_PROBE]);
      }
      return empty;
    }

    if (ts.isCallExpression(node)) {
      // `probe.bind(...)` yields a bound probe; a later invocation of that
      // result is still a potential liveness probe. `.call`/`.apply` are
      // invocations themselves, handled at the call visitor with shifted args.
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'bind' &&
        hasAtom(resolveSet(callee.expression, seen), PID_PROBE)) {
        return new Set([PID_PROBE]);
      }
      return empty;
    }

    if (!ts.isIdentifier(node)) return empty;
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol) {
      return node.text === 'process' ? new Set([PROCESS_OBJECT])
        : node.text === 'directPostOwnerAlive' ? new Set([LEGACY_OWNER]) : empty;
    }
    const declaration = symbol.valueDeclaration;
    if (!declaration) {
      return node.text === 'process' ? new Set([PROCESS_OBJECT])
        : node.text === 'directPostOwnerAlive' ? new Set([LEGACY_OWNER]) : empty;
    }
    if (visited.has(symbol)) return empty;
    const symbolSeen = new Set(visited).add(symbol);

    const result = new Set();
    const addFrom = valueNode => {
      for (const atom of resolveSet(valueNode, symbolSeen)) result.add(atom);
    };

    if (ts.isVariableDeclaration(declaration)) {
      addFrom(declaration.initializer);
    } else if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
      addFromBindingElement(declaration, symbolSeen, result);
    } else if (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration) ||
      ts.isArrowFunction(declaration) || ts.isMethodDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
      // Function-shaped declarations are not probes by themselves; their body
      // is visited separately when it contains a call expression.
      return empty;
    }

    for (const assigned of assignments.get(symbol) || []) addFrom(assigned);
    return result;
  }

  function addFromBindingElement(binding, visited, result) {
    const pattern = binding.parent;
    const variable = pattern.parent;
    const source = ts.isVariableDeclaration(variable) ? variable.initializer : null;
    const sourceSet = resolveSet(source, visited);
    const name = binding.propertyName
      ? (ts.isIdentifier(binding.propertyName) ? binding.propertyName.text
        : ts.isStringLiteral(binding.propertyName) ? binding.propertyName.text : null)
      : (ts.isIdentifier(binding.name) ? binding.name.text : null);
    if (binding.initializer) {
      for (const atom of resolveSet(binding.initializer, visited)) result.add(atom);
    }
    if (name === 'directPostOwnerAlive') {
      result.add(LEGACY_OWNER);
      return;
    }
    if (name === 'kill' && hasAtom(sourceSet, PROCESS_OBJECT)) result.add(PID_PROBE);
  }

  const visit = node => {
    if (ts.isCallExpression(node)) {
      const owner = generatedOwner || enclosingOwner(node);
      const callee = node.expression;
      const method = ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === 'bind' || callee.name.text === 'call' || callee.name.text === 'apply') &&
        hasAtom(staticValue(callee.expression), PID_PROBE);
      if (method && callee.name.text !== 'bind') {
        // `probe.call(thisArg, pid, signal)` / `probe.apply(thisArg, [pid, signal])`
        // invoke a probe with shifted arguments; `.bind` instead yields a bound
        // probe that a later call site resolves through the ordinary path.
        let signal = null;
        if (callee.name.text === 'call') signal = node.arguments[2];
        else if (ts.isArrayLiteralExpression(node.arguments[1])) signal = node.arguments[1].elements[1];
        if (signal && hasAtom(staticValue(signal), 0)) kills.push({ file: fileName, owner });
      } else if (!method) {
        const resolved = staticValue(callee);
        const isProbe = hasAtom(resolved, PID_PROBE);
        if (isProbe && node.arguments.length >= 2 && hasAtom(staticValue(node.arguments[1]), 0)) {
          kills.push({ file: fileName, owner });
        }
        if (hasAtom(resolved, LEGACY_OWNER)) legacyCalls.push({ file: fileName, owner });
      }
    }
    if (!generatedOwner && ts.isStringLiteral(node) && node.text.includes('process.kill')) {
      const nested = parseOwnerSites(fileName, node.text, enclosingOwner(node));
      kills.push(...nested.kills);
      legacyCalls.push(...nested.legacyCalls);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { kills, legacyCalls };
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
