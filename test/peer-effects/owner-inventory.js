'use strict';


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '../..');

const EXPECTED_TRANSPORT = {
  'src/direct-post.ts': {
    verifyAgentDestination: 1,
    sendDiscordMessage: 1
  },
  // The destination lookup itself lives one owner deeper: direct-post.ts calls
  // verifyAgentDestination, which calls fetchDiscordChannel here. Pin the
  // primitive too, so a new unbracketed GET added at this layer fails.
  'src/direct-post/delivery-identity.ts': {
    fetchDiscordChannel: 1
  },
  'src/board-refresh.ts': {
    fetchBoardInstallation: 1,
    fetchBoardChannel: 1,
    fetchBoardTarget: 1,
    patchBoardMessage: 1
  }
};

// Files that must never call fetch directly. Peer service injects loadChannels,
// so a raw fetch there would bypass the bracketed lookup.
const NO_RAW_FETCH = new Set([
  ...Object.keys(EXPECTED_TRANSPORT),
  'src/peer/service.js',
  'src/peer/post.js'
]);

const REFUSAL = /native caller|peer caller|caller changed|caller has no active binding|caller binding is ambiguous|caller identity is unavailable|binding changed|binding is stale|aborted|closing/i;

function parse(fileName, text) {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
}

// Walk from a call expression to the nearest enclosing named function or method.
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

function callSites(sourceFile) {
  const sites = [];
  const scopes = [new Map()];

  const declare = (name, canonical = null, tracked = false) => {
    scopes[scopes.length - 1].set(name, { canonical, tracked });
  };
  const lookup = name => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const binding = scopes[index].get(name);
      if (binding) return binding;
    }
    return null;
  };
  const canonicalForExpression = expression => {
    if (!expression) return null;
    if (ts.isIdentifier(expression)) return lookup(expression.text)?.canonical ?? expression.text;
    if (ts.isPropertyAccessExpression(expression)) {
      const object = canonicalForExpression(expression.expression);
      return object ? `${object}.${expression.name.text}` : null;
    }
    if (ts.isElementAccessExpression(expression)) {
      const object = canonicalForExpression(expression.expression);
      const argument = expression.argumentExpression;
      if (object === 'globalThis' && argument && ts.isStringLiteral(argument)) return argument.text;
      return null;
    }
    return null;
  };
  const aliasValue = expression => {
    if (!expression) return { canonical: null, tracked: false };
    if (ts.isIdentifier(expression)) {
      const binding = lookup(expression.text);
      return { canonical: binding?.canonical ?? expression.text, tracked: true };
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      return { canonical: canonicalForExpression(expression), tracked: true };
    }
    return { canonical: null, tracked: false };
  };
  const declarePattern = (pattern, value = null) => {
    if (ts.isIdentifier(pattern)) {
      declare(pattern.text, value?.canonical ?? null, value?.tracked ?? false);
      return;
    }
    if (ts.isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
        const property = element.propertyName || element.name;
        declare(element.name.text, ts.isIdentifier(property) ? property.text : null, true);
      }
    }
  };
  const visitParameters = parameters => {
    for (const parameter of parameters) declarePattern(parameter.name);
  };
  const objectPropertyInitializers = new Map();
  const visit = node => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)) {
      for (const element of node.importClause.namedBindings.elements) {
        declare(element.name.text, (element.propertyName || element.name).text, true);
      }
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      let value = null;
      if (node.initializer &&
          ts.isCallExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === 'require' &&
          ts.isObjectBindingPattern(node.name) &&
          node.initializer.arguments[0] && ts.isStringLiteral(node.initializer.arguments[0])) {
        value = { canonical: null, tracked: true };
        for (const element of node.name.elements) {
          if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
          const property = element.propertyName || element.name;
          declare(element.name.text, ts.isIdentifier(property) ? property.text : null, true);
        }
      } else {
        value = aliasValue(node.initializer);
        declarePattern(node.name, value);
      }
      if (node.initializer) visit(node.initializer);
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isIdentifier(node.left)) {
        const value = aliasValue(node.right);
        const binding = lookup(node.left.text);
        if (binding) {
          binding.canonical = value.canonical;
          binding.tracked = value.tracked;
        } else {
          declare(node.left.text, value.canonical, value.tracked);
        }
      }
      visit(node.right);
      return;
    }
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) declare(node.name.text, null, false);
      scopes.push(new Map());
      visitParameters(node.parameters);
      if (node.body) visit(node.body);
      scopes.pop();
      return;
    }
    if (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node)) {
      scopes.push(new Map());
      for (const statement of node.statements) visit(statement);
      scopes.pop();
      return;
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      let canonical = null;
      let name = null;
      let indirect = false;
      if (ts.isIdentifier(expression)) {
        name = expression.text;
        const binding = lookup(name);
        canonical = binding ? binding.canonical : name;
        indirect = Boolean(binding?.tracked);
      } else if (ts.isPropertyAccessExpression(expression)) {
        name = expression.name.text;
        if (name === 'call' || name === 'apply') {
          canonical = canonicalForExpression(expression.expression);
          indirect = true;
        } else {
          const receiver = expression.expression;
          const candidates = ts.isIdentifier(receiver) ? objectPropertyInitializers.get(receiver.text) : null;
          let initializer = null;
          if (candidates) {
            for (const candidate of candidates) {
              if (candidate.position < node.getStart(sourceFile)) initializer = candidate.properties.get(name) || null;
            }
          }
          if (initializer && ts.isIdentifier(initializer)) {
            canonical = canonicalForExpression(initializer);
            indirect = true;
          } else {
            canonical = name;
          }
        }
      } else if (ts.isElementAccessExpression(expression)) {
        indirect = true;
        name = expression.getText(sourceFile);
        canonical = canonicalForExpression(expression);
      }
      if (name) {
        sites.push({
          node,
          name,
          canonical,
          indirect,
          owner: enclosingOwner(node)
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  const collectObjectPropertyInitializers = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ts.isObjectLiteralExpression(node.initializer)) {
      const properties = new Map();
      for (const property of node.initializer.properties) {
        if (ts.isPropertyAssignment(property)) {
          const propertyName = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
            ? property.name.text
            : null;
          if (propertyName) properties.set(propertyName, property.initializer);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          properties.set(property.name.text, property.name);
        }
      }
      const entries = objectPropertyInitializers.get(node.name.text) || [];
      entries.push({ position: node.getStart(sourceFile), properties });
      objectPropertyInitializers.set(node.name.text, entries);
    }
    ts.forEachChild(node, collectObjectPropertyInitializers);
  };
  collectObjectPropertyInitializers(sourceFile);

  // Imports are hoisted, so aliases used by earlier-looking declarations still
  // resolve to their lexical binding rather than to a name-global map.
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const element of statement.importClause.namedBindings.elements) {
        declare(element.name.text, (element.propertyName || element.name).text, true);
      }
    }
  }
  for (const statement of sourceFile.statements) visit(statement);
  return sites;
}

// Names bound to a createCallerAssertion(...) result in one source file.
function assertionFactoryNames(sourceFile) {
  const names = [];
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'createCallerAssertion') {
      if (ts.isIdentifier(node.name)) names.push(node.name.text);
      else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) names.push(element.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function hasFactoryCall(sourceFile) {
  return callSites(sourceFile).some(site => site.canonical === 'createCallerAssertion');
}

// Resolve an object literal's named properties, following identifier spreads of
// other object-literal variable declarations one level deep.
function objectProperties(expression, variableInitializers) {
  const properties = new Map();
  if (!expression || !ts.isObjectLiteralExpression(expression)) return properties;
  for (const property of expression.properties) {
    if (ts.isPropertyAssignment(property) && property.name) {
      properties.set(property.name.getText().replace(/['"]/g, ''), property.initializer);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      properties.set(property.name.getText(), property.name);
    } else if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) {
      const spread = objectProperties(variableInitializers.get(property.expression.text), variableInitializers);
      for (const [key, value] of spread) if (!properties.has(key)) properties.set(key, value);
    }
  }
  return properties;
}

function variableInitializers(sourceFile) {
  const initializers = new Map();
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      initializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return initializers;
}

function referencesRequestField(initializer) {
  if (!initializer) return true;
  const text = initializer.getText();
  return /\b(input|args|request)\s*\./.test(text) || /\[\s*['"]assertCallerCurrent['"]\s*\]/.test(text) ||
    /objectAssign|Object\.assign/.test(text);
}

// A property that is written as null or undefined is treated as absent.
function suppliesValue(initializer) {
  if (!initializer) return false;
  if (initializer.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isIdentifier(initializer) && initializer.text === 'undefined') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Inventory checkers. Each returns an array of human-readable violations.

function transportViolations(sources) {
  const violations = [];
  for (const [file, expected] of Object.entries(EXPECTED_TRANSPORT)) {
    const text = sources[file];
    if (typeof text !== 'string') {
      violations.push(`${file}: source is missing`);
      continue;
    }
    const sourceFile = parse(file, text);
    const counts = new Map();
    for (const site of callSites(sourceFile)) {
      if (site.canonical === 'fetch' || site.name === 'fetch' ||
          (ts.isPropertyAccessExpression(site.node.expression) && site.name === 'fetch')) {
        violations.push(`${file}: direct fetch call at ${site.owner || '<top>'}`);
      }
      if (Object.hasOwn(expected, site.canonical)) {
        counts.set(site.canonical, (counts.get(site.canonical) || 0) + 1);
      }
    }
    for (const [name, wanted] of Object.entries(expected)) {
      const got = counts.get(name) || 0;
      if (got !== wanted) violations.push(`${file}: ${name} expected ${wanted}, found ${got}`);
    }
    // A transport import that is not part of the pinned inventory is a new site.
    const visit = node => {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings)) {
        const specifier = node.moduleSpecifier.getText();
        if (/discord|delivery-identity|direct-post/.test(specifier)) {
          for (const element of node.importClause.namedBindings.elements) {
            if (element.isTypeOnly) continue;
            const canonical = (element.propertyName || element.name).text;
            if (!Object.hasOwn(expected, canonical) && /fetch|send|patch|Destination/i.test(canonical)) {
              violations.push(`${file}: unexpected transport import ${canonical} from ${specifier}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  // Raw fetch must not appear in any owner that is expected to route through
  // an inventoried transport helper, including peer service (which injects
  // loadChannels) and post.
  for (const file of NO_RAW_FETCH) {
    if (Object.hasOwn(EXPECTED_TRANSPORT, file)) continue;
    const text = sources[file];
    if (typeof text !== 'string') {
      violations.push(`${file}: source is missing`);
      continue;
    }
    for (const site of callSites(parse(file, text))) {
      if (site.name === 'fetch') violations.push(`${file}: direct fetch call at ${site.owner || '<top>'}`);
    }
  }
  return violations;
}

function serverFetchViolations(sources) {
  const file = 'src/peer/server.js';
  const text = sources[file];
  if (typeof text !== 'string') return [`${file}: source is missing`];
  const sites = callSites(parse(file, text)).filter(site => site.canonical === 'fetch' || site.name === 'fetch');
  const violations = [];
  if (sites.length !== 1) violations.push(`${file}: fetch expected 1, found ${sites.length}`);
  for (const site of sites) {
    if (site.owner !== 'loadChannels') violations.push(`${file}: fetch outside loadChannels at ${site.owner || '<top>'}`);
  }
  return violations;
}

function channelLookupViolations(sources) {
  const violations = [];
  const text = sources['src/peer/service.js'];
  if (typeof text !== 'string') {
    violations.push('src/peer/service.js: source is missing');
    return violations;
  }
  const sourceFile = parse('src/peer/service.js', text);
  const sites = callSites(sourceFile);
  const lookups = sites.filter(site => site.canonical === 'loadChannels');
  if (lookups.length !== 1) violations.push(`src/peer/service.js: loadChannels expected 1, found ${lookups.length}`);
  const factoryNames = new Set(assertionFactoryNames(sourceFile));
  factoryNames.add('assertCallerCurrent');
  const assertions = sites.filter(site => factoryNames.has(site.name) || factoryNames.has(site.canonical));
  if (!hasFactoryCall(sourceFile)) violations.push('src/peer/service.js: no createCallerAssertion call found');
  if (lookups.length === 1) {
    const lookup = lookups[0].node;
    const before = assertions.some(site => site.node.pos < lookup.pos && site.owner === lookups[0].owner);
    const after = assertions.some(site => site.node.end > lookup.end && site.owner === lookups[0].owner);
    if (!before) violations.push('src/peer/service.js: no caller assertion before loadChannels');
    if (!after) violations.push('src/peer/service.js: no caller assertion after loadChannels');
  }
  return violations;
}

// Public peer roles must forward the assertion produced by the peer caller owner.
function wiringViolations(sources) {
  const violations = [];
  for (const file of ['src/peer/service.js', 'src/peer/post.js']) {
    const text = sources[file];
    if (typeof text !== 'string') {
      violations.push(`${file}: source is missing`);
      continue;
    }
    const sourceFile = parse(file, text);
    const initializers = variableInitializers(sourceFile);
    const factoryNames = new Set(assertionFactoryNames(sourceFile));
    if (!hasFactoryCall(sourceFile)) violations.push(`${file}: no createCallerAssertion call found`);
    const runCalls = callSites(sourceFile).filter(site =>
      site.canonical === 'runDirectPost' || site.canonical === 'runBoardRefresh');
    if (file.endsWith('service.js')) {
      const sendRun = runCalls.filter(site => site.owner === 'send');
      if (sendRun.length !== 1) violations.push('src/peer/service.js: send must call runDirectPost exactly once');
      for (const site of sendRun) {
        const properties = objectProperties(site.node.arguments[0], initializers);
        const value = properties.get('assertCallerCurrent');
        if (!suppliesValue(value)) violations.push('src/peer/service.js: send does not supply assertCallerCurrent');
        else if (referencesRequestField(value)) violations.push('src/peer/service.js: assertCallerCurrent comes from request fields');
        else if (!(ts.isIdentifier(value) && factoryNames.has(value.text)) &&
                 !(ts.isCallExpression(value) && calleeName(value) === 'createCallerAssertion')) {
          violations.push('src/peer/service.js: assertCallerCurrent is not derived from createCallerAssertion');
        }
      }
    } else {
      const announce = runCalls.filter(site => site.owner === 'postByRole');
      const board = announce.filter(site => site.canonical === 'runBoardRefresh');
      const direct = announce.filter(site => site.canonical === 'runDirectPost');
      if (direct.length !== 1) violations.push('src/peer/post.js: postByRole must call announcement runDirectPost exactly once');
      if (board.length !== 1) violations.push('src/peer/post.js: postByRole must call runBoardRefresh exactly once');
      for (const site of [...direct, ...board]) {
        const properties = objectProperties(site.node.arguments[0], initializers);
        const value = properties.get('assertCallerCurrent');
        if (!suppliesValue(value)) violations.push(`src/peer/post.js: ${site.canonical} does not receive assertCallerCurrent`);
        else if (referencesRequestField(value)) violations.push(`src/peer/post.js: ${site.canonical} assertion comes from request fields`);
        else if (!(ts.isIdentifier(value) && factoryNames.has(value.text)) &&
                 !(ts.isCallExpression(value) && calleeName(value) === 'createCallerAssertion')) {
          violations.push(`src/peer/post.js: ${site.canonical} assertion is not derived from createCallerAssertion`);
        }
      }
    }
    // bindingCurrent and agentDestinationCurrent stay synchronous.
    const visit = node => {
      if (ts.isPropertyAssignment(node) && node.name && ['bindingCurrent', 'agentDestinationCurrent'].includes(node.name.getText())) {
        const initializer = node.initializer;
        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
          if (initializer.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
            violations.push(`${file}: ${node.name.getText()} must remain synchronous`);
          }
          const containsAwait = node => {
            if (ts.isAwaitExpression(node)) return true;
            return ts.forEachChild(node, containsAwait) || false;
          };
          if (containsAwait(initializer)) violations.push(`${file}: ${node.name.getText()} must not await`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  const revalidation = sources['test/peer-effect-revalidation.test.js'];
  if (typeof revalidation !== 'string') violations.push('test/peer-effect-revalidation.test.js: source is missing');
  else if (/FIXED|PEER_EFFECT_EXPECT_FIXED|transitional\s*\(/.test(revalidation)) {
    violations.push('test/peer-effect-revalidation.test.js: still contains a transitional expected-red mode');
  }
  return violations;
}

function realSources() {
  const files = [
    'src/direct-post.ts', 'src/direct-post/delivery-identity.ts', 'src/board-refresh.ts',
    'src/peer/service.js', 'src/peer/server.js', 'src/peer/post.js', 'test/peer-effect-revalidation.test.js'
  ];
  return Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(ROOT, file), 'utf8')]));
}

function rejectionViolations(sources) {
  const counts = { 'src/peer/service.js': 1, 'src/direct-post.ts': 2, 'src/board-refresh.ts': 4 };
  const violations = [];
  for (const [file, expected] of Object.entries(counts)) {
    const tree = parse(file, sources[file]);
    const nullable = new Set();
    const owners = new Map();
    let constructors = 0;
    function declarations(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        if (node.initializer?.kind === ts.SyntaxKind.NullKeyword) nullable.add(node.name.text);
        if (node.initializer && ts.isNewExpression(node.initializer) &&
            node.initializer.expression.getText(tree) === 'TransportRejection') {
          if (owners.has(node.name.text)) violations.push(`${file}: duplicate rejection owner ${node.name.text}`);
          owners.set(node.name.text, 0);
        }
      }
      if (ts.isNewExpression(node) && node.expression.getText(tree) === 'TransportRejection') constructors += 1;
      ts.forEachChild(node, declarations);
    }
    declarations(tree);
    function visit(node) {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left) && nullable.has(node.left.text) && ts.isIdentifier(node.right)) {
        let parent = node.parent;
        while (parent && !ts.isCatchClause(parent) && !ts.isFunctionLike(parent)) parent = parent.parent;
        if (parent && ts.isCatchClause(parent) && parent.variableDeclaration?.name.getText(tree) === node.right.text) {
          violations.push(`${file}: nullable rejection sentinel ${node.left.text}`);
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) && node.expression.name.text === 'capture' &&
          owners.has(node.expression.expression.text)) {
        const owner = node.expression.expression.text;
        owners.set(owner, owners.get(owner) + 1);
        let parent = node.parent;
        while (parent && !ts.isCatchClause(parent) && !ts.isFunctionLike(parent)) parent = parent.parent;
        const binding = parent && ts.isCatchClause(parent) ? parent.variableDeclaration?.name : undefined;
        if (!binding || !ts.isIdentifier(binding) || node.arguments.length !== 1 ||
            !ts.isIdentifier(node.arguments[0]) || node.arguments[0].text !== binding.text) {
          violations.push(`${file}: ${owner} must capture its raw catch value`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    if (constructors !== expected || owners.size !== expected) {
      violations.push(`${file}: expected ${expected} rejection owners, found ${constructors} constructors and ${owners.size} bindings`);
    }
    for (const [owner, captures] of owners) {
      if (captures !== 1) violations.push(`${file}: ${owner} must capture exactly once, found ${captures}`);
    }
  }
  return violations;
}

function ownerViolations(sources) {
  return [...transportViolations(sources), ...serverFetchViolations(sources), ...channelLookupViolations(sources), ...wiringViolations(sources), ...rejectionViolations(sources)];
}


module.exports = { rejectionViolations, wiringViolations, realSources, ownerViolations, REFUSAL };
