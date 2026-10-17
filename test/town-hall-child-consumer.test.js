const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const repositoryRoot = path.resolve(__dirname, '..');
const codecTargets = new Set([
  'src/town-hall-child',
  'src/town-hall-child.js',
  'src/town-hall-child.ts',
  'dist/town-hall-child',
  'dist/town-hall-child.js',
].map((relativePath) => path.join(repositoryRoot, relativePath)));
const codecDefinitions = new Set([
  'src/town-hall-child.js',
  'src/town-hall-child.ts',
  'dist/town-hall-child.js',
]);

function resolvesToCodec(specifier, importerPath) {
  const normalized = specifier.replace(/\\/g, '/').replace(/[?#].*$/, '');
  let resolvedPath;

  if (normalized.startsWith('./') || normalized.startsWith('../')) {
    resolvedPath = path.resolve(repositoryRoot, path.dirname(importerPath), normalized);
  } else if (normalized.startsWith('@/')) {
    resolvedPath = path.resolve(repositoryRoot, normalized.slice(2));
  } else if (normalized.startsWith('src/')) {
    resolvedPath = path.resolve(repositoryRoot, normalized);
  } else if (normalized.startsWith('dist/')) {
    resolvedPath = path.resolve(repositoryRoot, normalized);
  } else {
    return false;
  }

  if (codecTargets.has(resolvedPath)) return true;
  return codecTargets.has(resolvedPath.replace(/\.(?:[cm]?[jt]sx?)$/i, ''));
}

function moduleReferenceSiteKind(node) {
  if (ts.isImportDeclaration(node)) return 'import';
  if (ts.isExportDeclaration(node)) return 'export';
  if (ts.isImportEqualsDeclaration(node)) return 'import-equals';
  if (ts.isCallExpression(node)) return 'call';
  return undefined;
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name];
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap((element) =>
      ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
  }
  return [];
}

function isFunctionLikeNode(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) || ts.isSetAccessor(node) || ts.isConstructorDeclaration(node);
}

function lexicalBindingsFor(sourceFile) {
  const scopeByNode = new WeakMap();
  const rootScope = { parent: undefined, functionScope: undefined, bindings: new Map() };
  rootScope.functionScope = rootScope;

  function createScope(parent, functionScope = false) {
    const scope = { parent, functionScope: undefined, bindings: new Map() };
    scope.functionScope = functionScope ? scope : parent.functionScope;
    return scope;
  }

  function addBinding(scope, name, binding) {
    const declarations = scope.bindings.get(name) || [];
    declarations.push(binding);
    scope.bindings.set(name, declarations);
  }

  function addPattern(scope, name, binding) {
    for (const identifier of bindingNames(name)) {
      addBinding(scope, identifier.text, ts.isIdentifier(name) ? binding : { kind: 'other' });
    }
  }

  function visit(node, parentScope) {
    let scope = parentScope;
    if (node === sourceFile) scope = rootScope;
    else if (isFunctionLikeNode(node)) scope = createScope(parentScope, true);
    else if (ts.isClassExpression(node)) scope = createScope(parentScope);
    else if (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node) ||
        ts.isCatchClause(node) || ts.isForStatement(node) ||
        ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      scope = createScope(parentScope);
    }
    scopeByNode.set(node, scope);

    if (isFunctionLikeNode(node)) {
      for (const parameter of node.parameters) addPattern(scope, parameter.name, { kind: 'other' });
      if (ts.isFunctionDeclaration(node) && node.name && scope.parent) {
        addBinding(scope.parent, node.name.text, { kind: 'other' });
      } else if (ts.isFunctionExpression(node) && node.name) {
        addBinding(scope, node.name.text, { kind: 'other' });
      }
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      addPattern(scope, node.variableDeclaration.name, { kind: 'other' });
    }
    if (ts.isVariableDeclaration(node)) {
      const declarationList = node.parent;
      const isConst = ts.isVariableDeclarationList(declarationList) &&
        (declarationList.flags & ts.NodeFlags.Const) !== 0;
      const targetScope = ts.isVariableDeclarationList(declarationList) &&
        (declarationList.flags & ts.NodeFlags.BlockScoped) === 0
        ? scope.functionScope
        : scope;
      const binding = isConst && ts.isIdentifier(node.name) && node.initializer
        ? { kind: 'const', initializer: node.initializer, scope, node }
        : { kind: 'other' };
      addPattern(targetScope, node.name, binding);
    }
    if (ts.isClassDeclaration(node) && node.name) {
      addBinding(scope, node.name.text, { kind: 'other' });
    }
    if (ts.isClassExpression(node) && node.name) {
      addBinding(scope, node.name.text, { kind: 'other' });
    }
    if ((ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) && ts.isIdentifier(node.name)) {
      addBinding(scope, node.name.text, { kind: 'other' });
    }
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      if (clause.name) addBinding(scope, clause.name.text, { kind: 'other' });
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        addBinding(scope, clause.namedBindings.name.text, { kind: 'other' });
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          addBinding(scope, element.name.text, { kind: 'other' });
        }
      }
    }
    if (ts.isImportEqualsDeclaration(node)) {
      addBinding(scope, node.name.text, { kind: 'other' });
    }

    ts.forEachChild(node, (child) => visit(child, scope));
  }
  visit(sourceFile, undefined);
  return { rootScope, scopeByNode };
}

function bindingAt(scope, name) {
  for (let current = scope; current; current = current.parent) {
    const declarations = current.bindings.get(name);
    if (declarations) return declarations;
  }
  return undefined;
}

function staticStringFromExpression(expression, scope, seen = new Set()) {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return { value: current.text, mayBeCodec: false };
  }
  if (!ts.isIdentifier(current)) {
    return { value: undefined, mayBeCodec: /town-hall-child/.test(current.getText()) };
  }

  const declarations = bindingAt(scope, current.text);
  if (!declarations) return { value: undefined, mayBeCodec: false };
  const candidates = declarations.filter((binding) => binding.kind === 'const');
  const mayBeCodec = declarations.some((binding) =>
    binding.initializer && /town-hall-child/.test(binding.initializer.getText()));
  if (declarations.length !== 1 || candidates.length !== 1) {
    return { value: undefined, mayBeCodec };
  }

  const binding = candidates[0];
  if (seen.has(binding.node)) return { value: undefined, mayBeCodec };
  seen.add(binding.node);
  const value = staticStringFromExpression(
    binding.initializer,
    binding.scope,
    seen,
  );
  return { value: value.value, mayBeCodec: value.mayBeCodec || mayBeCodec };
}

function loaderFromExpression(expression, scope, seen = new Set()) {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  if (ts.isIdentifier(current)) {
    const declarations = bindingAt(scope, current.text);
    if (!declarations) return current.text === 'require' ? 'loader' : 'none';
    if (declarations.length !== 1) return 'ambiguous';
    if (declarations[0].kind !== 'const') return 'none';
    const binding = declarations[0];
    if (!binding.initializer) return 'none';
    if (seen.has(binding.node)) return 'ambiguous';
    seen.add(binding.node);
    return loaderFromExpression(binding.initializer, binding.scope, seen);
  }
  if (ts.isPropertyAccessExpression(current) && current.name.text === 'require' &&
      ts.isIdentifier(current.expression) && current.expression.text === 'module') {
    return bindingAt(scope, 'module') ? 'none' : 'loader';
  }
  return 'none';
}

function moduleReferenceExpression(node, siteKind) {
  if (siteKind === 'import' || siteKind === 'export') return node.moduleSpecifier;
  if (siteKind === 'import-equals' && ts.isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression;
  }
  return undefined;
}

function productionFileLoadsCodec(relativePath, source) {
  const isTypeScript = /\.(?:[cm]?ts|tsx)$/i.test(relativePath);
  const scriptKind = /\.tsx$/i.test(relativePath)
    ? ts.ScriptKind.TSX
    : isTypeScript ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const { rootScope, scopeByNode } = lexicalBindingsFor(sourceFile);

  let found = false;
  function visit(node) {
    if (found) return;
    const siteKind = moduleReferenceSiteKind(node);
    const scope = scopeByNode.get(node) || rootScope;
    if (siteKind === 'import' || siteKind === 'export' || siteKind === 'import-equals') {
      const expression = moduleReferenceExpression(node, siteKind);
      if (expression) {
        const specifier = staticStringFromExpression(expression, scope);
        if (specifier.value !== undefined && resolvesToCodec(specifier.value, relativePath)) {
          found = true;
          return;
        }
        if (specifier.value === undefined && specifier.mayBeCodec) {
          throw new Error('Unclassified codec loader syntax in ' + relativePath);
        }
      }
    }

    if (siteKind === 'call') {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const loader = isDynamicImport ? 'loader' : loaderFromExpression(node.expression, scope);
      if (loader === 'loader' || loader === 'ambiguous') {
        const argument = node.arguments[0];
        if (argument) {
          const specifier = staticStringFromExpression(argument, scope);
          if (specifier.value !== undefined && resolvesToCodec(specifier.value, relativePath)) {
            found = true;
            return;
          }
          if (specifier.value === undefined && (specifier.mayBeCodec || loader === 'ambiguous')) {
            throw new Error('Unclassified codec loader syntax in ' + relativePath + ': ' +
              argument.getText(sourceFile));
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function trackedFilesFromGit() {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    maxBuffer: 16 * 1024 * 1024,
  }).toString('utf8').split('\0').filter(Boolean);
}

function productionPathsFromTrackedFiles(trackedFiles) {
  return trackedFiles.filter((relativePath) => {
    if (!/\.(?:[cm]?[jt]sx?)$/i.test(relativePath) || /\.d\.ts$/i.test(relativePath)) return false;
    const segments = relativePath.split('/');
    if (segments.some((segment) => ['test', 'tests', '__tests__'].includes(segment))) return false;
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(relativePath)) return false;
    return !codecDefinitions.has(relativePath);
  });
}

test('tracked production files have no premature town-hall child codec consumers', () => {
  const productionFiles = productionPathsFromTrackedFiles(trackedFilesFromGit());

  const consumers = productionFiles.filter((relativePath) => {
    const source = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
    return productionFileLoadsCodec(relativePath, source);
  });

  assert.deepEqual(consumers, []);
});

test('consumer inventory catches source and emitted loader forms and ignores unrelated modules', () => {
  const controls = [
    ['src/new/nested-consumer.js', "const codec = require('../town-hall-child');"],
    ['src/named-alias.js', "import { decodeTownHallChild as decode } from './town-hall-child.ts';"],
    ['src/namespace-require.js', "const codec = require('./town-hall-child.js');"],
    ['src/dynamic-import.js', "const codec = import('./town-hall-child');"],
    ['src/re-export.js', "export { decodeTownHallChild } from './town-hall-child';"],
    ['src/const-require-path.js', "const codecPath = '../dist/town-hall-child.js'; const codec = require(codecPath);"],
    ['src/module-require.js', "const codec = module.require('../dist/town-hall-child.js');"],
    ['src/source-codec-import.ts', "import { decodeTownHallChild } from './town-hall-child.ts';"],
    ['src/source-facade-require.js', "const codec = require('./town-hall-child.js');"],
    ['src/emitted-codec-require.js', "const codec = require('../dist/town-hall-child.js');"],
    ['src/source-alias-import.js', "import { decodeTownHallChild } from '@/src/town-hall-child.ts';"],
    ['src/const-dynamic-import.js', "const codecPath = '../dist/town-hall-child.js'; const codec = import(codecPath);"],
    ['src/import-equals-source.ts', "import codec = require('./town-hall-child');"],
    ['src/import-equals-emitted.ts', "import codec = require('../dist/town-hall-child.js');"],
  ];

  for (const [relativePath, source] of controls) {
    assert.equal(
      productionFileLoadsCodec(relativePath, source),
      true,
      'consumer control was missed: ' + relativePath,
    );
  }

  assert.equal(
    productionFileLoadsCodec('src/unrelated.js', "const config = require('./unrelated-module');"),
    false,
  );
});

test('consumer inventory recognizes static template loaders for source and emitted codecs', () => {
  const controls = [
    ['src/template-source.js', 'const codec = require(`../src/town-hall-child.ts`);'],
    ['src/template-emitted.js', 'const codec = require(`../dist/town-hall-child.js`);'],
  ];

  for (const [relativePath, source] of controls) {
    assert.equal(
      productionFileLoadsCodec(relativePath, source),
      true,
      'template consumer control was missed: ' + relativePath,
    );
  }
});

test('consumer inventory follows direct loader aliases and static paths through them', () => {
  const controls = [
    ['src/require-alias-source.js', "const load = require; const codec = load('../src/town-hall-child.ts');"],
    ['src/module-require-alias-emitted.js', "const load = module.require; const codec = load('../dist/town-hall-child.js');"],
    ['src/require-path-alias-source.js', "const load = require; const codecPath = `../src/town-hall-child.ts`; const codec = load(codecPath);"],
    ['src/module-require-path-alias-emitted.js', "const load = module . require ;\nconst codecPath = `../dist/town-hall-child.js` ;\nconst codec = load ( codecPath ) ;"],
  ];

  for (const [relativePath, source] of controls) {
    assert.equal(
      productionFileLoadsCodec(relativePath, source),
      true,
      'aliased consumer control was missed: ' + relativePath,
    );
  }
});

test('consumer inventory resolves supported bindings at their lexical use', () => {
  const positiveControls = [
    ['src/nested-source-shadow.js', `
      const codecPath = '../unrelated.js';
      function consume() {
        const codecPath = './town-hall-child.ts';
        return require(codecPath);
      }
    `],
    ['src/nested-emitted-shadow.js', `
      const codecPath = '../unrelated.js';
      const load = require;
      function consume() {
        const codecPath = '../dist/town-hall-child.js';
        return load(codecPath);
      }
    `],
    ['src/block-scoped-class-require.js', `
      function consume() {
        {
          class require {}
        }
        return require('./town-hall-child.ts');
      }
    `],
    ['src/path-before-loader.js', "const codecPath = './town-hall-child.ts';\nconst load = require;\nconst codec = load(codecPath);"],
  ];

  for (const [relativePath, source] of positiveControls) {
    assert.equal(
      productionFileLoadsCodec(relativePath, source),
      true,
      'lexical consumer control was missed: ' + relativePath,
    );
  }

  const negativeControls = [
    ['src/nested-unrelated-shadow.js', `
      const codecPath = './town-hall-child.ts';
      function ignoreCodec() {
        const codecPath = '../unrelated.js';
        return require(codecPath);
      }
    `],
    ['src/shadowed-loader-parameter.js', `
      const load = require;
      function ignoreCodec(load) {
        return load('./town-hall-child.ts');
      }
    `],
    ['src/shadowed-module-parameter.js', `
      function ignoreCodec(module) {
        return module.require('../dist/town-hall-child.js');
      }
    `],
    ['src/shadowed-require-parameter.js', `
      function ignoreCodec(require) {
        return require('./town-hall-child.ts');
      }
    `],
    ['src/shadowed-class-expression-require.js', `
      const loader = class require {
        load() {
          return require('./town-hall-child.ts');
        }
      };
    `],
    ['src/unrelated-dynamic-call.js', "const runBody = require('../unrelated-module').runBody;\nrunBody(args);"],
  ];

  for (const [relativePath, source] of negativeControls) {
    assert.equal(
      productionFileLoadsCodec(relativePath, source),
      false,
      'shadowed loader was treated as a codec consumer: ' + relativePath,
    );
  }
});

test('consumer inventory pins the supported module-reader syntax sites', () => {
  const source = fs.readFileSync(__filename, 'utf8');
  const sourceFile = ts.createSourceFile(__filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function functionNamed(name) {
    let result;
    function find(node) {
      if (ts.isFunctionDeclaration(node) && node.name && node.name.text === name) result = node;
      ts.forEachChild(node, find);
    }
    find(sourceFile);
    return result;
  }

  function predicatesFor(name) {
    const target = functionNamed(name);
    assert.ok(target, name + ' is present');
    const predicates = [];
    function collect(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'ts') {
        predicates.push(node.expression.name.text);
      }
      ts.forEachChild(node, collect);
    }
    collect(target);
    return [...new Set(predicates)].sort();
  }

  assert.deepEqual(predicatesFor('moduleReferenceSiteKind'), [
    'isCallExpression', 'isExportDeclaration', 'isImportDeclaration', 'isImportEqualsDeclaration',
  ]);
  assert.deepEqual(predicatesFor('moduleReferenceExpression'), ['isExternalModuleReference']);
  assert.deepEqual(predicatesFor('loaderFromExpression'), [
    'isIdentifier', 'isParenthesizedExpression', 'isPropertyAccessExpression',
  ]);
  assert.deepEqual(predicatesFor('staticStringFromExpression'), [
    'isIdentifier', 'isNoSubstitutionTemplateLiteral', 'isParenthesizedExpression', 'isStringLiteral',
  ]);

  const productionClassifier = functionNamed('productionFileLoadsCodec');
  assert.ok(productionClassifier, 'production classifier is present');
  let siteDispatches = 0;
  function inspectProductionClassifier(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === 'moduleReferenceSiteKind') siteDispatches += 1;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'ts' &&
        /^is[A-Z]/.test(node.expression.name.text)) {
      assert.fail('production classifier added a reader predicate outside the syntax inventory');
    }
    ts.forEachChild(node, inspectProductionClassifier);
  }
  inspectProductionClassifier(productionClassifier);
  assert.equal(siteDispatches, 1);
});

test('consumer inventory fails closed on an unclassified static codec loader site', () => {
  assert.throws(
    () => productionFileLoadsCodec(
      'src/computed-loader.js',
      'const codec = require(String.raw`../dist/town-hall-child.js`);',
    ),
    /Unclassified codec loader syntax/,
  );
});

test('a new tracked production path passes through the inventory boundary', () => {
  const relativePath = 'src/new-enumerated-consumer.js';
  const trackedFiles = [...trackedFilesFromGit(), relativePath];
  const productionFiles = productionPathsFromTrackedFiles(trackedFiles);
  const consumers = productionFiles.filter((candidate) => candidate === relativePath &&
    productionFileLoadsCodec(candidate, 'const codec = require(`../dist/town-hall-child.js`);'));

  assert.equal(productionFiles.includes(relativePath), true);
  assert.deepEqual(consumers, [relativePath]);
});
