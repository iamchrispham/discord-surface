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

function staticStringFromExpression(expression, staticPaths) {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) return current.text;
  if (ts.isIdentifier(current)) return staticPaths.get(current.text);
  return undefined;
}

function isModuleRequire(expression) {
  return ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'module' &&
    expression.name.text === 'require';
}

function isLoaderExpression(expression, loaderAliases) {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return (ts.isIdentifier(current) && loaderAliases.has(current.text)) || isModuleRequire(current);
}

function productionFileLoadsCodec(relativePath, source) {
  const scriptKind = /\.tsx$/i.test(relativePath)
    ? ts.ScriptKind.TSX
    : /\.ts$/i.test(relativePath) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const declarations = [];
  const staticPaths = new Map();
  const loaderAliases = new Set(['require']);

  function collectDeclarations(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.push(node);
    }
    ts.forEachChild(node, collectDeclarations);
  }
  collectDeclarations(sourceFile);

  for (let pass = 0; pass < declarations.length; pass += 1) {
    for (const declaration of declarations) {
      if ((declaration.parent.flags & ts.NodeFlags.Const) === 0) continue;
      const name = declaration.name.text;
      const value = staticStringFromExpression(declaration.initializer, staticPaths);
      if (value !== undefined && !staticPaths.has(name)) staticPaths.set(name, value);
      if (isLoaderExpression(declaration.initializer, loaderAliases)) loaderAliases.add(name);
    }
  }

  let found = false;
  function visit(node) {
    if (found) return;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) &&
        resolvesToCodec(node.moduleSpecifier.text, relativePath)) {
      found = true;
      return;
    }

    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isDynamicImport || isLoaderExpression(node.expression, loaderAliases)) {
        const argument = node.arguments[0];
        if (argument) {
          const specifier = staticStringFromExpression(argument, staticPaths);
          if (specifier !== undefined && resolvesToCodec(specifier, relativePath)) {
            found = true;
            return;
          }
          if (specifier === undefined && argument.getText(sourceFile).includes('town-hall-child')) {
            throw new Error('Unclassified codec loader syntax in ' + relativePath);
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
