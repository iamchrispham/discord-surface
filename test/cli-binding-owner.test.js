'use strict';

// Structural owner contract for the binding command extraction. Static only:
// the installed TypeScript parser reads the companion and its cli.js wiring; no
// handler runs, no module is loaded, no fixture is written. A "declaration site"
// is a function declaration directly inside the companion factory or a
// module-scope declaration of the same name elsewhere; closure-local helpers
// that merely shadow bind/unbind (for example the lifecycle SQL helpers in
// src/state/binding-lifecycle.js) are not command owners.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const COMPANION = 'src/cli/binding-commands.js';
const ENTRYPOINT = 'src/cli.js';
const FACTORY = 'createBindingCommands';
const HANDLERS = ['bindingArgs', 'bind', 'threadEnroll', 'unbind'];
const DEPENDENCIES = ['required', 'openState', 'print', 'requestGatewayRecovery', 'gatewayProcessStatus'];
const REQUIRES = [
  { specifier: 'node:path', names: ['path'] },
  { specifier: '../state', names: ['BindingError', 'READINESS', 'RECOVERY_LIMITS'] },
  { specifier: '../discord', names: ['readSecret', 'requireInstalled', 'waitForRecoveryOperation'] },
  { specifier: '../discord/thread-enrollment', names: ['enrollPublicThread'] },
  { specifier: '../discord/history-access', names: ['readAdoptionCutoff'] },
  { specifier: '../discord/handoff-fence', names: ['assertOrdinaryIntakeRange', 'assertHandoffIntakeCoverage', 'createHandoffFence', 'deleteHandoffFence'] },
  { specifier: '../ordinary-codex', names: ['resolveExistingChannel'] },
  { specifier: '../ordinary-bind/constants', names: ['GATEWAY_CAPABILITIES'] },
  { specifier: './command-cleanup', names: ['completeCommandCleanup'] }
];

function parseText(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
}

function readSource(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function parse(relative) {
  return parseText(relative, readSource(relative));
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}

function functionDeclaration(node, name) {
  return ts.isFunctionDeclaration(node) && node.name && node.name.text === name && Boolean(node.body);
}

function bindingNames(node) {
  const names = [];
  ts.forEachChild(node, child => {
    if (ts.isIdentifier(child)) names.push(child.text);
    else if (ts.isBindingElement(child)) {
      if (ts.isIdentifier(child.name)) names.push(child.name.text);
      else if (child.name && (ts.isObjectBindingPattern(child.name) || ts.isArrayBindingPattern(child.name))) {
        names.push(...bindingNames(child.name));
      }
    } else if (ts.isObjectBindingPattern(child) || ts.isArrayBindingPattern(child)) names.push(...bindingNames(child));
  });
  return names;
}

function objectProperties(objectLiteral) {
  return objectLiteral.properties.map(property => ({
    property,
    name: property.name && ts.isIdentifier(property.name) ? property.name.text : null,
    shorthand: ts.isShorthandPropertyAssignment(property)
  }));
}

// git ls-files src plus the untracked companion under test.
function trackedSources() {
  const tracked = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(file => /\.(js|ts)$/.test(file) && !/\.d\.ts$/.test(file));
  return [...new Set([...tracked, COMPANION])].sort();
}

function loadSources() {
  return trackedSources().map(file => ({ file, text: readSource(file) }));
}

function requireBindings(parsed) {
  const found = [];
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (!initializer || !ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression) ||
        initializer.expression.text !== 'require') continue;
      const [specifier] = initializer.arguments;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      if (ts.isIdentifier(declaration.name)) found.push({ specifier: specifier.text, names: [declaration.name.text] });
      else if (ts.isObjectBindingPattern(declaration.name) || ts.isArrayBindingPattern(declaration.name)) {
        found.push({ specifier: specifier.text, names: bindingNames(declaration.name) });
      }
    }
  }
  return found;
}

// `exports.bind = ...` / `module.exports.bind = ...` at module scope declares a
// copied workflow just as a function declaration does. The base must be exactly
// `exports` or `module.exports`. Callable object exports are classified separately.
function exportAssignmentName(left) {
  if (!ts.isPropertyAccessExpression(left)) return null;
  if (!ts.isIdentifier(left.name) || !HANDLERS.includes(left.name.text)) return null;
  const base = left.expression;
  const isExportsBase = ts.isIdentifier(base) && base.text === 'exports';
  const isModuleExportsBase = ts.isPropertyAccessExpression(base) && ts.isIdentifier(base.name) &&
    base.name.text === 'exports' && ts.isIdentifier(base.expression) && base.expression.text === 'module';
  return isExportsBase || isModuleExportsBase ? left.name.text : null;
}

// Declaration sites per handler name over a list of {file, text}. A facade
// destructuring of the factory call is a reference, not a declaration; every
// other module-scope binding, function declaration, or exports assignment is a
// declaration site, as is a direct declaration inside the companion factory body.
function ownerDeclarationSites(sources) {
  const sites = new Map(HANDLERS.map(name => [name, []]));
  const record = (name, site) => { if (sites.has(name)) sites.get(name).push(site); };
  for (const { file, text } of sources) {
    const parsed = parseText(file, text);
    const factory = parsed.statements.find(statement => functionDeclaration(statement, FACTORY));
    if (factory && factory.body) {
      for (const statement of factory.body.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name) record(statement.name.text, { file, scope: 'factory' });
      }
    }
    for (const statement of parsed.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        record(statement.name.text, { file, scope: 'module' });
        continue;
      }
      if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) &&
        statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const exported = exportAssignmentName(statement.expression.left);
        if (exported) record(exported, { file, scope: 'export-assignment' });
        const { left, right } = statement.expression;
        const moduleObject = ts.isPropertyAccessExpression(left) &&
          ts.isIdentifier(left.expression) && left.expression.text === 'module' &&
          left.name.text === 'exports' && ts.isObjectLiteralExpression(right);
        if (moduleObject) {
          for (const property of right.properties) {
            const implementation = ts.isMethodDeclaration(property) ||
              (ts.isPropertyAssignment(property) &&
                (ts.isFunctionExpression(property.initializer) || ts.isArrowFunction(property.initializer)));
            if (!implementation) continue;
            const key = property.name;
            const literal = ts.isComputedPropertyName(key) ? key.expression : key;
            if (ts.isStringLiteral(literal) || (!ts.isComputedPropertyName(key) && ts.isIdentifier(literal))) {
              record(literal.text, { file, scope: 'export-object-implementation' });
            }
          }
        }
        continue;
      }
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          record(declaration.name.text, { file, scope: 'module-variable' });
          continue;
        }
        if (!ts.isObjectBindingPattern(declaration.name) && !ts.isArrayBindingPattern(declaration.name)) continue;
        const initializer = declaration.initializer;
        const facadeReference = file === ENTRYPOINT && initializer && ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression) && initializer.expression.text === FACTORY;
        if (facadeReference) continue;
        for (const name of bindingNames(declaration.name)) record(name, { file, scope: 'destructured' });
      }
    }
  }
  return sites;
}

// Pure inventory: every owner declaration site must sit in the companion
// factory. Any module-scope copy in another tracked source file is a violation.
function copiedOwnerDeclarations(sources) {
  const violations = [];
  const sites = ownerDeclarationSites(sources);
  for (const name of HANDLERS) {
    for (const site of sites.get(name)) {
      if (site.file === COMPANION && site.scope === 'factory') continue;
      violations.push({ file: site.file, name, scope: site.scope });
    }
  }
  return violations;
}

function callWithCallee(parsed, callee) {
  const calls = [];
  walk(parsed, node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) calls.push(node);
  });
  return calls;
}

function moduleScopeHandlers(parsed) {
  const found = [];
  for (const statement of parsed.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && HANDLERS.includes(statement.name.text)) {
      found.push({ name: statement.name.text, scope: 'module' });
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && HANDLERS.includes(declaration.name.text)) found.push({ name: declaration.name.text, scope: 'module-variable' });
    }
  }
  return found;
}

function mainSwitch(entrypoint) {
  const main = entrypoint.statements.find(statement => functionDeclaration(statement, 'main'));
  assert.ok(main, 'cli.js must declare main');
  const switches = [];
  walk(main.body, node => { if (ts.isSwitchStatement(node)) switches.push(node); });
  assert.equal(switches.length, 1, 'main must contain exactly one dispatch switch');
  return switches[0];
}

function caseClause(switchNode, value) {
  return switchNode.caseBlock.clauses.find(clause => ts.isCaseClause(clause) &&
    ts.isStringLiteral(clause.expression) && clause.expression.text === value);
}

function returnedCall(clause, callee) {
  const calls = [];
  for (const statement of clause.statements) {
    walk(statement, node => {
      if (!ts.isReturnStatement(node) || !node.expression || !ts.isCallExpression(node.expression)) return;
      if (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === callee) calls.push(node.expression);
    });
  }
  return calls;
}

test('binding command factory owns the four workflows', { timeout: 8000 }, () => {
  const companion = parse(COMPANION);
  const factory = companion.statements.find(statement => functionDeclaration(statement, FACTORY));
  assert.ok(factory, `companion must declare function ${FACTORY}`);

  // The factory takes exactly the five injected dependencies, in order.
  assert.equal(factory.parameters.length, 1, `${FACTORY} takes one options object`);
  assert.ok(ts.isObjectBindingPattern(factory.parameters[0].name), `${FACTORY} options must be destructured`);
  assert.deepEqual(bindingNames(factory.parameters[0].name), DEPENDENCIES,
    `${FACTORY} must inject exactly the five named dependencies in order`);

  // Declared exactly once, directly inside the factory body, in order.
  const directDeclarations = factory.body.statements
    .filter(statement => ts.isFunctionDeclaration(statement) && statement.name)
    .map(statement => statement.name.text);
  assert.deepEqual(directDeclarations, HANDLERS, 'factory body must declare exactly the four handlers in order');

  // Nowhere else may a handler be an owner declaration; one site each, in the factory.
  const sites = ownerDeclarationSites(loadSources());
  for (const name of HANDLERS) {
    const found = sites.get(name);
    assert.equal(found.length, 1, `${name} must have exactly one owner declaration site across tracked src plus companion`);
    assert.equal(found[0].file, COMPANION, `${name} must be declared in ${COMPANION}`);
    assert.equal(found[0].scope, 'factory', `${name} must sit directly in the ${FACTORY} body`);
  }

  // The factory returns shorthand properties with exactly that vocabulary and order.
  // Only the factory's own direct return counts; the handler bodies contain their
  // own object-literal returns.
  const returns = factory.body.statements.filter(statement => ts.isReturnStatement(statement));
  const objectReturns = returns.filter(node => node.expression && ts.isObjectLiteralExpression(node.expression));
  assert.equal(objectReturns.length, 1, 'factory must have exactly one object-literal return');
  const returned = objectProperties(objectReturns[0].expression);
  assert.deepEqual(returned.map(entry => entry.name), HANDLERS, 'factory return must be the four handlers in order');
  for (const entry of returned) assert.ok(entry.shorthand, `${entry.name} must be a shorthand property`);

  // The companion requires exactly the declared dependency vocabulary.
  assert.deepEqual(requireBindings(companion), REQUIRES, 'companion must require exactly the declared dependency vocabulary');

  // module.exports exposes only createBindingCommands.
  const exportObjects = [];
  walk(companion, node => {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const left = node.left;
    const isModuleExports = ts.isPropertyAccessExpression(left) && left.name.text === 'exports' &&
      ts.isIdentifier(left.expression) && left.expression.text === 'module';
    const isExportsProperty = ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) &&
      left.expression.text === 'exports';
    if (!isModuleExports && !isExportsProperty) return;
    exportObjects.push({ right: node.right, isModuleExports });
    assert.equal(isModuleExports, true, 'companion must export via module.exports only');
    assert.ok(ts.isObjectLiteralExpression(node.right), 'module.exports must be an object literal');
  });
  assert.equal(exportObjects.length, 1, 'companion must assign module.exports exactly once');
  const exported = objectProperties(exportObjects[0].right);
  assert.deepEqual(exported.map(entry => entry.name), [FACTORY], 'module.exports must expose only createBindingCommands');
  assert.ok(exported[0].shorthand, 'createBindingCommands must be a shorthand export');
});

test('binding command facade preserves exports and dispatch', { timeout: 8000 }, () => {
  const entrypoint = parse(ENTRYPOINT);

  // The factory require sits in the ./cli/* block after the startup guard.
  const guardIndex = entrypoint.statements.findIndex(statement => ts.isIfStatement(statement) &&
    statement.expression.getText(entrypoint).startsWith('require.main === module'));
  assert.ok(guardIndex >= 0, 'cli.js must keep its startup guard');
  const requireIndex = entrypoint.statements.findIndex(statement => {
    if (!ts.isVariableStatement(statement)) return false;
    return statement.declarationList.declarations.some(declaration => ts.isObjectBindingPattern(declaration.name) &&
      bindingNames(declaration.name).includes(FACTORY));
  });
  assert.ok(requireIndex > guardIndex, `${FACTORY} must be required after the startup guard`);

  // The factory is instantiated once with the five dependencies and destructured
  // into the four handler names, in order.
  const factoryCalls = callWithCallee(entrypoint, FACTORY);
  assert.equal(factoryCalls.length, 1, `cli.js must call ${FACTORY} exactly once`);
  const [options] = factoryCalls[0].arguments;
  assert.equal(factoryCalls[0].arguments.length, 1, `${FACTORY} takes one options object`);
  assert.ok(ts.isObjectLiteralExpression(options), `${FACTORY} options must be an object literal`);
  const injected = objectProperties(options);
  assert.deepEqual(injected.map(entry => entry.name), DEPENDENCIES, `${FACTORY} must receive the five dependencies in order`);
  for (const entry of injected) assert.ok(entry.shorthand, `${entry.name} must be passed as a shorthand property`);

  const destructured = [];
  walk(entrypoint, node => {
    if (!ts.isVariableDeclaration(node) || !ts.isObjectBindingPattern(node.name)) return;
    if (bindingNames(node.name).includes('bindingArgs')) destructured.push(node);
  });
  assert.equal(destructured.length, 1, 'bindingArgs must be bound once in cli.js, by destructuring');
  assert.equal(destructured[0].initializer, factoryCalls[0], 'the destructuring must read the createBindingCommands call');
  assert.deepEqual(destructured[0].name.elements.map(element => element.name && element.name.text), HANDLERS,
    'the facade destructuring must bind the four handlers in order');

  // cli.js must not keep any module-scope declaration of the moved handlers.
  assert.deepEqual(moduleScopeHandlers(entrypoint), [], 'cli.js must not redeclare a moved binding handler');

  // The main switch routes each command to its handler, with rebind still forcing true.
  const switchNode = mainSwitch(entrypoint);
  const bindClause = caseClause(switchNode, 'bind');
  const rebindClause = caseClause(switchNode, 'rebind');
  const unbindClause = caseClause(switchNode, 'unbind');
  const threadClause = caseClause(switchNode, 'thread-enroll');
  assert.ok(bindClause, "main switch must have a 'bind' case");
  assert.ok(rebindClause, "main switch must have a 'rebind' case");
  assert.ok(unbindClause, "main switch must have a 'unbind' case");
  assert.ok(threadClause, "main switch must have a 'thread-enroll' case");

  const bindCalls = returnedCall(bindClause, 'bind');
  assert.equal(bindCalls.length, 1, "'bind' must return exactly one bind call");
  assert.equal(bindCalls[0].arguments.length, 1, "'bind' must call bind(args)");
  assert.ok(ts.isIdentifier(bindCalls[0].arguments[0]) && bindCalls[0].arguments[0].text === 'args',
    "'bind' must pass args");

  const rebindCalls = returnedCall(rebindClause, 'bind');
  assert.equal(rebindCalls.length, 1, "'rebind' must return exactly one bind call");
  assert.equal(rebindCalls[0].arguments.length, 2, "'rebind' must call bind(args, true)");
  assert.ok(ts.isIdentifier(rebindCalls[0].arguments[0]) && rebindCalls[0].arguments[0].text === 'args',
    "'rebind' must pass args");
  assert.equal(rebindCalls[0].arguments[1].kind, ts.SyntaxKind.TrueKeyword, "'rebind' must force the rebind flag true");

  const unbindCalls = returnedCall(unbindClause, 'unbind');
  assert.equal(unbindCalls.length, 1, "'unbind' must return exactly one unbind call");
  assert.equal(unbindCalls[0].arguments.length, 1, "'unbind' must call unbind(args)");
  assert.ok(ts.isIdentifier(unbindCalls[0].arguments[0]) && unbindCalls[0].arguments[0].text === 'args',
    "'unbind' must pass args");

  const threadCalls = returnedCall(threadClause, 'threadEnroll');
  assert.equal(threadCalls.length, 1, "'thread-enroll' must return exactly one threadEnroll call");
  assert.equal(threadCalls[0].arguments.length, 1, "'thread-enroll' must call threadEnroll(args)");
  assert.ok(ts.isIdentifier(threadCalls[0].arguments[0]) && threadCalls[0].arguments[0].text === 'args',
    "'thread-enroll' must pass args");

  // The public facade still exports the moved names.
  const exportsNode = entrypoint.statements.find(statement => ts.isExpressionStatement(statement) &&
    ts.isBinaryExpression(statement.expression) && statement.expression.left.getText(entrypoint) === 'module.exports');
  assert.ok(exportsNode && ts.isObjectLiteralExpression(exportsNode.expression.right), 'cli.js must assign module.exports an object literal');
  const publicNames = objectProperties(exportsNode.expression.right).map(entry => entry.name);
  for (const name of ['bindingArgs', 'threadEnroll', 'unbind']) {
    assert.ok(publicNames.includes(name), `module.exports must still include ${name}`);
  }
});

test('binding command inventory rejects copied owners', { timeout: 8000 }, () => {
  // The real tree has exactly one owner declaration site per handler, in the companion.
  const realSources = loadSources();
  assert.deepEqual(copiedOwnerDeclarations(realSources), [],
    'tracked src plus companion must not declare a binding workflow outside the companion factory');

  // A newly copied workflow in another tracked source file is detected.
  const copied = [...realSources, { file: 'src/cli/copied-binding.js', text: 'async function bind(args) { return args; }\n' }];
  assert.deepEqual(copiedOwnerDeclarations(copied),
    [{ file: 'src/cli/copied-binding.js', name: 'bind', scope: 'module' }],
    'a copied top-level bind workflow must be rejected');

  // A copied workflow in the same style as threadEnroll is detected too.
  const copiedThread = [...realSources, { file: 'src/cli/copied-thread.js', text: 'async function threadEnroll(args) { return args; }\n' }];
  assert.deepEqual(copiedOwnerDeclarations(copiedThread),
    [{ file: 'src/cli/copied-thread.js', name: 'threadEnroll', scope: 'module' }],
    'a copied top-level threadEnroll workflow must be rejected');

  // An exports assignment is a copied owner too: `exports.bind = ...` and
  // `module.exports.threadEnroll = ...` must be recorded as export-assignment
  // sites rather than slipping past the module-scope declaration checks.
  const copiedExport = [...realSources, { file: 'src/cli/copied-export.js', text: 'exports.bind = async function bind(args) { return args; };\n' }];
  assert.deepEqual(copiedOwnerDeclarations(copiedExport),
    [{ file: 'src/cli/copied-export.js', name: 'bind', scope: 'export-assignment' }],
    'a copied exports.bind workflow must be rejected');

  const copiedModuleExport = [...realSources, { file: 'src/cli/copied-module-export.js', text: 'module.exports.threadEnroll = async function threadEnroll() {};\n' }];
  assert.deepEqual(copiedOwnerDeclarations(copiedModuleExport),
    [{ file: 'src/cli/copied-module-export.js', name: 'threadEnroll', scope: 'export-assignment' }],
    'a copied module.exports.threadEnroll workflow must be rejected');

  // The base restriction is load-bearing: only `exports`/`module.exports` count.
  // A same-named property on any other receiver is an unrelated helper and must
  // not be treated as a copied owner.
  const unrelatedBase = [...realSources, {
    file: 'src/cli/unrelated-base.js',
    text: 'const registry = {};\nregistry.bind = async function bind(args) { return args; };\nconfig.unbind = 1;\n'
  }];
  assert.deepEqual(copiedOwnerDeclarations(unrelatedBase), [],
    'a non-exports assignment to a handler name must not be treated as a copied owner');

  for (const name of HANDLERS) {
    const forms = [
      `${name}(args) { return args; }`,
      `${name}: async function(args) { return args; }`,
      `${name}: async args => args`,
      `['${name}'](args) { return args; }`,
      `'${name}': args => args`
    ];
    for (const [index, form] of forms.entries()) {
      const file = `src/cli/object-${name}-${index}.js`;
      assert.deepEqual(copiedOwnerDeclarations([...realSources, {
        file, text: `module.exports = { ${form} };`
      }]), [{ file, name, scope: 'export-object-implementation' }],
      `callable object export ${name} form ${index} must be rejected`);
    }
  }
  assert.deepEqual(copiedOwnerDeclarations([...realSources, {
    file: 'src/cli/shorthand-references.js',
    text: 'module.exports = { bindingArgs, bind, threadEnroll, unbind };'
  }]), [], 'shorthand exports reference existing handlers');
  assert.deepEqual(copiedOwnerDeclarations([...realSources, {
    file: 'src/cli/unrelated-object.js',
    text: 'module.exports = { other(args) { return args; }, bind: 1 }; const unrelated = { unbind() {} };'
  }]), [], 'non-callable handler properties and unrelated objects are not implementations');

  // A destructuring copy outside the factory call is a declaration site; the
  // facade's own factory destructuring is a reference and stays clean.
  const copiedBindingArg = [...realSources, { file: 'src/cli/copied-facade.js', text: "const { bindingArgs } = require('./other');\n" }];
  assert.deepEqual(copiedOwnerDeclarations(copiedBindingArg),
    [{ file: 'src/cli/copied-facade.js', name: 'bindingArgs', scope: 'destructured' }],
    'a destructured binding outside the factory call must be rejected');

  // A second declaration inside the companion factory is visible as a second site.
  const duplicated = realSources.map(source => source.file === COMPANION
    ? { ...source, text: source.text.replace('return { bindingArgs, bind, threadEnroll, unbind };', 'function unbind() {}\n\nreturn { bindingArgs, bind, threadEnroll, unbind };') }
    : source);
  assert.equal(ownerDeclarationSites(duplicated).get('unbind').length, 2,
    'a second factory-body declaration of unbind must be visible');
});

test('binding owner suite is registered once', { timeout: 8000 }, () => {
  const packageJson = JSON.parse(readSource('package.json'));
  const command = packageJson.scripts.test.split(/\s+/);
  const registration = 'test/cli-binding-owner.test.js';
  assert.equal(command.filter(token => token === registration).length, 1,
    `${registration} must be registered exactly once in scripts.test`);
  const provisionIndex = command.indexOf('test/cli-provision-owner.test.js');
  const bindingIndex = command.indexOf(registration);
  const recoveryIndex = command.indexOf('test/cli-recovery-owner.test.js');
  assert.ok(provisionIndex >= 0 && recoveryIndex >= 0, 'neighbouring owner suites must stay registered');
  assert.equal(bindingIndex, provisionIndex + 1, `${registration} must sit directly beside cli-provision-owner.test.js`);
  assert.equal(recoveryIndex, bindingIndex + 1, `${registration} must keep the neighbouring owner order`);
});
