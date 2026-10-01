'use strict';

// Structural owner contract for the provision command extraction. Static only:
// the installed TypeScript parser reads the companion and its cli.js wiring; no
// handler runs, no module is loaded, no fixture is written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const COMPANION = 'src/cli/provision-commands.js';
const ENTRYPOINT = 'src/cli.js';
const FACTORY = 'createProvisionCommands';
const HANDLERS = ['migrationRequested', 'categoryFor', 'provisionInternal', 'provision'];

function readSource(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function parse(relative) {
  const kind = relative.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(relative, readSource(relative), ts.ScriptTarget.Latest, true, kind);
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}

function trackedSources() {
  const tracked = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(file => /\.(js|ts)$/.test(file) && !/\.d\.ts$/.test(file));
  // The companion may be untracked in a working tree before its first commit.
  return [...new Set([...tracked, COMPANION, ENTRYPOINT])].sort();
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

// Every declaration site of the four names across tracked src, keyed by name.
function declarationSites() {
  const sites = new Map(HANDLERS.map(name => [name, []]));
  for (const file of trackedSources()) {
    const source = ts.createSourceFile(file, readSource(file), ts.ScriptTarget.Latest, true,
      file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    walk(source, node => {
      if (ts.isFunctionDeclaration(node) && node.name && sites.has(node.name.text)) {
        sites.get(node.name.text).push({ file, node, kind: 'function' });
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && sites.has(node.name.text)) {
        sites.get(node.name.text).push({ file, node, kind: 'variable' });
      }
    });
  }
  return sites;
}

function factoryBody(parsed) {
  const factory = parsed.statements.find(statement => functionDeclaration(statement, FACTORY));
  assert.ok(factory, `companion must declare function ${FACTORY}`);
  return factory.body;
}

function callWithCallee(parsed, callee) {
  const calls = [];
  walk(parsed, node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) calls.push(node);
  });
  return calls;
}

function objectProperties(objectLiteral) {
  return objectLiteral.properties.map(property => ({
    property,
    name: property.name && ts.isIdentifier(property.name) ? property.name.text : null,
    shorthand: ts.isShorthandPropertyAssignment(property)
  }));
}

test('provision handlers are owned by createProvisionCommands and wired once', { timeout: 8000 }, () => {
  const companion = parse(COMPANION);
  const entrypoint = parse(ENTRYPOINT);
  const body = factoryBody(companion);

  // Declared exactly once, directly inside the factory body, in order.
  const directDeclarations = body.statements
    .filter(statement => ts.isFunctionDeclaration(statement) && statement.name)
    .map(statement => statement.name.text);
  assert.deepEqual(directDeclarations, HANDLERS, 'factory body must declare exactly the four handlers in order');

  // Nowhere else in tracked src may any of the four be a function/variable declaration.
  const sites = declarationSites();
  for (const name of HANDLERS) {
    const found = sites.get(name);
    assert.equal(found.length, 1, `${name} must be declared exactly once across tracked src`);
    assert.equal(found[0].file, COMPANION, `${name} must be declared in ${COMPANION}`);
    assert.equal(found[0].kind, 'function', `${name} must be a function declaration`);
    const siteBlock = found[0].node.parent;
    assert.ok(ts.isBlock(siteBlock) && siteBlock.statements.includes(found[0].node),
      `${name} must sit directly in a function body`);
    const siteFactory = siteBlock.parent;
    assert.ok(ts.isFunctionDeclaration(siteFactory) && siteFactory.name && siteFactory.name.text === FACTORY,
      `${name} must sit directly in the ${FACTORY} body`);
  }

  // The factory returns shorthand properties with exactly that vocabulary and order.
  const returns = [];
  walk(body, node => { if (ts.isReturnStatement(node)) returns.push(node); });
  const objectReturns = returns.filter(node => node.expression && ts.isObjectLiteralExpression(node.expression));
  assert.equal(objectReturns.length, 1, 'factory must have exactly one object-literal return');
  const returned = objectProperties(objectReturns[0].expression);
  assert.deepEqual(returned.map(entry => entry.name), HANDLERS, 'factory return must be the four handlers in order');
  for (const entry of returned) assert.ok(entry.shorthand, `${entry.name} must be a shorthand property`);

  // module.exports exposes only createProvisionCommands.
  const exportObjects = [];
  walk(companion, node => {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const left = node.left;
    const isModuleExports = ts.isPropertyAccessExpression(left) && left.name.text === 'exports' &&
      ts.isIdentifier(left.expression) && left.expression.text === 'module';
    const isExportsProperty = ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) &&
      left.expression.text === 'exports';
    if (!isModuleExports && !isExportsProperty) return;
    exportObjects.push({ left, right: node.right, isModuleExports });
    assert.equal(isModuleExports, true, 'companion must export via module.exports only');
    assert.ok(ts.isObjectLiteralExpression(node.right), 'module.exports must be an object literal');
  });
  assert.equal(exportObjects.length, 1, 'companion must assign module.exports exactly once');
  const exported = objectProperties(exportObjects[0].right);
  assert.deepEqual(exported.map(entry => entry.name), ['createProvisionCommands'], 'module.exports must expose only createProvisionCommands');
  assert.ok(exported[0].shorthand, 'createProvisionCommands must be a shorthand export');

  // cli.js injects cliPath: __filename and destructures the four handlers from the factory call.
  const factoryCalls = callWithCallee(entrypoint, FACTORY);
  assert.equal(factoryCalls.length, 1, 'cli.js must call createProvisionCommands exactly once');
  const factoryArgs = factoryCalls[0].arguments;
  assert.equal(factoryArgs.length, 1, 'createProvisionCommands takes one options object');
  assert.ok(ts.isObjectLiteralExpression(factoryArgs[0]), 'createProvisionCommands options must be an object literal');
  const cliPath = factoryArgs[0].properties.find(property => property.name && property.name.getText() === 'cliPath');
  assert.ok(cliPath, 'createProvisionCommands options must include cliPath');
  assert.ok(ts.isIdentifier(cliPath.initializer) && cliPath.initializer.text === '__filename',
    'cliPath must be initialized from the __filename identifier');

  const destructured = [];
  walk(entrypoint, node => {
    if (!ts.isVariableDeclaration(node) || !ts.isObjectBindingPattern(node.name)) return;
    if (!bindingNames(node.name).includes('categoryFor')) return;
    destructured.push(node);
  });
  assert.equal(destructured.length, 1, 'categoryFor must be bound once in cli.js, by destructuring');
  assert.equal(destructured[0].initializer, factoryCalls[0], 'the destructuring must read the createProvisionCommands call');
  for (const name of HANDLERS) {
    assert.equal(destructured[0].name.elements.some(element => element.name && element.name.text === name), true,
      `cli.js destructuring must bind ${name}`);
  }
  for (const name of HANDLERS) {
    assert.deepEqual(sites.get(name).filter(site => site.file === ENTRYPOINT), [],
      `${name} must not be redeclared in cli.js`);
  }

  // Binding patterns are declarations too: a destructured binding of any handler
  // in another tracked src file must fail even though declarationSites ignores it.
  for (const file of trackedSources()) {
    const source = ts.createSourceFile(file, readSource(file), ts.ScriptTarget.Latest, true,
      file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    walk(source, node => {
      if (!ts.isVariableDeclaration(node)) return;
      if (!ts.isObjectBindingPattern(node.name) && !ts.isArrayBindingPattern(node.name)) return;
      const bound = bindingNames(node.name).filter(name => HANDLERS.includes(name));
      if (bound.length === 0) return;
      const allowed = file === ENTRYPOINT && node.initializer &&
        ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === FACTORY;
      assert.ok(allowed,
        `${bound.join(', ')} must not be destructured outside the ${FACTORY} call in ${file}`);
    });
  }

  // Destructured parameters and catch-clause bindings are declarations too. The
  // only legitimate guarded parameter is categoryFor injected into the handoff
  // factory, which cli.js feeds as a shorthand property.
  const parameterInjections = new Map([['src/cli/conductor-handoff.js:createConductorHandoff', new Set(['categoryFor'])]]);
  for (const file of trackedSources()) {
    const source = ts.createSourceFile(file, readSource(file), ts.ScriptTarget.Latest, true,
      file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    walk(source, node => {
      const patterns = [];
      if (ts.isFunctionLike(node) && node.parameters) {
        const functionName = node.name && node.name.text;
        const allowed = parameterInjections.get(`${file}:${functionName}`) || new Set();
        for (const parameter of node.parameters) {
          if (ts.isObjectBindingPattern(parameter.name) || ts.isArrayBindingPattern(parameter.name)) {
            patterns.push({ pattern: parameter.name, allowed });
          }
        }
      }
      if (ts.isCatchClause(node) && node.variableDeclaration &&
        (ts.isObjectBindingPattern(node.variableDeclaration.name) || ts.isArrayBindingPattern(node.variableDeclaration.name))) {
        patterns.push({ pattern: node.variableDeclaration.name, allowed: new Set() });
      }
      for (const { pattern, allowed } of patterns) {
        const unexpected = bindingNames(pattern).filter(name => HANDLERS.includes(name) && !allowed.has(name));
        assert.equal(unexpected.length, 0,
          `${unexpected.join(', ')} must not be bound by a parameter or catch pattern in ${file}`);
      }
    });
  }

  // The main switch routes each command to its own handler.
  const main = entrypoint.statements.find(statement => functionDeclaration(statement, 'main'));
  assert.ok(main, 'cli.js must declare main');
  const switches = [];
  walk(main.body, node => { if (ts.isSwitchStatement(node)) switches.push(node); });
  assert.equal(switches.length, 1, 'main must contain exactly one dispatch switch');
  const clauses = switches[0].caseBlock.clauses;
  const clauseFor = value => clauses.find(clause => ts.isCaseClause(clause) &&
    ts.isStringLiteral(clause.expression) && clause.expression.text === value);
  const returnedCallName = (clause, expected) => {
    const matches = [];
    for (const statement of clause.statements) {
      walk(statement, node => {
        if (ts.isReturnStatement(node) && node.expression && ts.isCallExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) && node.expression.expression.text === expected) matches.push(node);
      });
    }
    return matches;
  };
  const provisionClause = clauseFor('provision');
  const provisionRunClause = clauseFor('provision-run');
  assert.ok(provisionClause, "main switch must have a 'provision' case");
  assert.ok(provisionRunClause, "main switch must have a 'provision-run' case");
  assert.ok(returnedCallName(provisionClause, 'provision').length > 0,
    "'provision' must return a call to provision");
  assert.ok(returnedCallName(provisionRunClause, 'provisionInternal').length > 0,
    "'provision-run' must return a call to provisionInternal");

  // The handoff wiring forwards categoryFor as shorthand from the factory binding.
  const handoffCalls = callWithCallee(entrypoint, 'createConductorHandoff');
  assert.equal(handoffCalls.length, 1, 'cli.js must call createConductorHandoff exactly once');
  const handoffArg = handoffCalls[0].arguments[0];
  assert.ok(handoffArg && ts.isObjectLiteralExpression(handoffArg), 'createConductorHandoff options must be an object literal');
  const handoffCategory = handoffArg.properties.find(property => property.name && property.name.getText() === 'categoryFor');
  assert.ok(handoffCategory, 'createConductorHandoff must receive categoryFor');
  assert.ok(ts.isShorthandPropertyAssignment(handoffCategory), 'categoryFor must be passed as a shorthand property');
});
