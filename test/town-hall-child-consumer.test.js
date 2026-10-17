const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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

function productionFileLoadsCodec(relativePath, source) {
  const literalPatterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\b(?:module\s*\.\s*)?require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of literalPatterns) {
    for (const match of source.matchAll(pattern)) {
      if (resolvesToCodec(match[1], relativePath)) return true;
    }
  }

  const codecPathVariables = new Set();
  const pathDeclaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"]+)\2/g;
  for (const match of source.matchAll(pathDeclaration)) {
    if (resolvesToCodec(match[3], relativePath)) codecPathVariables.add(match[1]);
  }

  for (const variable of codecPathVariables) {
    const escapedVariable = variable.replace(/\$/g, '\\$');
    const variableLoader = new RegExp(
      '\\b(?:module\\s*\\.\\s*)?require\\s*\\(\\s*' + escapedVariable +
        '\\s*\\)|\\bimport\\s*\\(\\s*' + escapedVariable + '\\s*\\)',
    );
    if (variableLoader.test(source)) return true;
  }

  return false;
}

test('tracked production files have no premature town-hall child codec consumers', () => {
  const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    maxBuffer: 16 * 1024 * 1024,
  }).toString('utf8').split('\0').filter(Boolean);
  const productionFiles = trackedFiles.filter((relativePath) => {
    if (!/\.(?:[cm]?[jt]sx?)$/i.test(relativePath) || /\.d\.ts$/i.test(relativePath)) return false;
    const segments = relativePath.split('/');
    if (segments.some((segment) => ['test', 'tests', '__tests__'].includes(segment))) return false;
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(relativePath)) return false;
    return !codecDefinitions.has(relativePath);
  });

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
