const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function assertRegistered(root) {
  const owners = fs.readdirSync(path.join(root, 'src'), { recursive: true }).filter(name => name.endsWith('.ts')).map(name => `src/${name.split(path.sep).join('/')}`);
  for (const config of ['tsconfig.json', 'tsconfig.typecheck.json']) {
    const included = new Set(JSON.parse(fs.readFileSync(path.join(root, config), 'utf8')).include);
    assert.deepEqual(owners.filter(owner => !included.has(owner)).sort(), [], `${config}: unregistered production owners`);
  }
}

test('every production TypeScript owner is explicitly registered', () => {
  assertRegistered(path.resolve(__dirname, '..'));
});

test('a new unregistered owner fails the inventory check', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-owner-inventory-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    for (const config of ['tsconfig.json', 'tsconfig.typecheck.json']) fs.writeFileSync(path.join(root, config), JSON.stringify({ include: [] }));
    assertRegistered(root);
    fs.writeFileSync(path.join(root, 'src', 'new-owner.ts'), 'export {};');
    assert.throws(() => assertRegistered(root), /unregistered production owners/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


{
  const assert = require('node:assert/strict');
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');
  const { test } = require('node:test');

  const repositoryRoot = path.resolve(__dirname, '..');
  const codecTargets = new Set([
    path.join(repositoryRoot, 'src/town-hall-child'),
    path.join(repositoryRoot, 'src/town-hall-child.js'),
    path.join(repositoryRoot, 'src/town-hall-child.ts'),
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
    })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);

    const productionFiles = trackedFiles.filter((relativePath) => {
      if (!/\.(?:[cm]?[jt]sx?)$/i.test(relativePath)) return false;
      const segments = relativePath.split('/');
      if (segments.some((segment) => ['test', 'tests', '__tests__'].includes(segment))) return false;
      if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(relativePath)) return false;
      return ![
        'src/town-hall-child.js',
        'src/town-hall-child.ts',
      ].includes(relativePath);
    });

    const consumers = productionFiles.filter((relativePath) => {
      const source = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
      return productionFileLoadsCodec(relativePath, source);
    });

    assert.deepEqual(consumers, []);
  });

  test('consumer inventory catches loader forms and ignores unrelated modules', () => {
    const controls = [
      ['src/new/nested-consumer.js', "const codec = require('../town-hall-child');"],
      ['src/named-alias.js', "import { decodeTownHallChild as decode } from './town-hall-child';"],
      ['src/namespace-require.js', "const codec = require('./town-hall-child');"],
      ['src/dynamic-import.js', "const codec = import('./town-hall-child');"],
      ['src/re-export.js', "export { decodeTownHallChild } from './town-hall-child';"],
      ['src/const-require-path.js', "const codecPath = './town-hall-child'; const codec = require(codecPath);"],
      ['src/module-require.js', "const codec = module.require('./town-hall-child');"],
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
}
