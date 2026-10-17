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

function compilerContextFor(relativePath, source) {
  const sourceFileName = path.resolve(repositoryRoot, relativePath);
  const isTypeScript = /\.(?:[cm]?ts|tsx)$/i.test(relativePath);
  const scriptKind = /\.tsx$/i.test(relativePath)
    ? ts.ScriptKind.TSX
    : isTypeScript ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const compilerOptions = {
    allowJs: true,
    checkJs: false,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.None,
    noEmit: true,
    noResolve: true,
    noLib: true,
    types: [],
  };
  const sourceFile = ts.createSourceFile(
    sourceFileName,
    source,
    compilerOptions.target,
    true,
    scriptKind,
  );
  const effects = {
    sourceReads: 0,
    externalReadAttempts: [],
    externalSourceRequests: [],
    moduleResolutionRequests: [],
    typeReferenceResolutionRequests: [],
    writes: 0,
  };
  const isSuppliedFile = (fileName) => path.resolve(fileName) === sourceFileName;
  const host = {
    getSourceFile(fileName) {
      if (!isSuppliedFile(fileName)) {
        effects.externalSourceRequests.push(fileName);
        return undefined;
      }
      effects.sourceReads += 1;
      return sourceFile;
    },
    getDefaultLibFileName: () => '',
    writeFile() {
      effects.writes += 1;
      throw new Error('Compiler output is disabled');
    },
    getCurrentDirectory: () => repositoryRoot,
    getDirectories: () => [],
    fileExists: (fileName) => isSuppliedFile(fileName),
    readFile(fileName) {
      if (!isSuppliedFile(fileName)) {
        effects.externalReadAttempts.push(fileName);
        return undefined;
      }
      return source;
    },
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    directoryExists: () => false,
    realpath: (fileName) => fileName,
    resolveModuleNames(moduleNames) {
      effects.moduleResolutionRequests.push(...moduleNames);
      return moduleNames.map(() => undefined);
    },
    resolveTypeReferenceDirectives(typeReferenceDirectiveNames) {
      effects.typeReferenceResolutionRequests.push(...typeReferenceDirectiveNames);
      return typeReferenceDirectiveNames.map(() => undefined);
    },
  };
  const program = ts.createProgram([sourceFileName], compilerOptions, host);
  const programSourceFile = program.getSourceFile(sourceFileName);
  if (!programSourceFile) throw new Error('Compiler did not load the supplied source file');
  return {
    program,
    sourceFile: programSourceFile,
    checker: program.getTypeChecker(),
    host,
    effects,
  };
}

function constInitializerFor(declaration) {
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name) ||
      !declaration.initializer) return undefined;
  const declarationList = declaration.parent;
  if (!ts.isVariableDeclarationList(declarationList) ||
      (declarationList.flags & ts.NodeFlags.Const) === 0) return undefined;
  return declaration.initializer;
}

function declarationsAt(checker, identifier, sourceFile) {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol) return undefined;
  const declarations = symbol.getDeclarations() || [];
  if (declarations.length === 0) return undefined;
  if (declarations.some((declaration) => declaration.getSourceFile() !== sourceFile)) {
    return [];
  }
  return declarations;
}

function staticFragmentsFromExpression(expression, context, seen = new Set()) {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return [current.text];
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [
      ...staticFragmentsFromExpression(current.left, context, seen),
      ...staticFragmentsFromExpression(current.right, context, seen),
    ];
  }
  if (ts.isTemplateExpression(current)) {
    const fragments = [current.head.text];
    for (const span of current.templateSpans) {
      fragments.push(...staticFragmentsFromExpression(span.expression, context, seen));
      fragments.push(span.literal.text);
    }
    return fragments;
  }
  if (!ts.isIdentifier(current)) return [undefined];
  const declarations = declarationsAt(context.checker, current, context.sourceFile);
  if (!declarations || declarations.length !== 1) return [undefined];
  const initializer = constInitializerFor(declarations[0]);
  if (!initializer || seen.has(declarations[0])) return [undefined];
  seen.add(declarations[0]);
  const fragments = staticFragmentsFromExpression(initializer, context, seen);
  seen.delete(declarations[0]);
  return fragments;
}

function mayNameCodec(expression, context) {
  const fragments = staticFragmentsFromExpression(expression, context);
  const knownText = fragments.filter((fragment) => typeof fragment === 'string').join('');
  return /town-hall-child/.test(knownText) ||
    /(?:^|[^a-z0-9_-])town-hall-(?:c(?:h(?:i(?:l(?:d)?)?)?)?)?(?:$|[^a-z0-9_-])/i.test(knownText) ||
    hasUnresolvedTownHallChildPattern(fragments) ||
    /town-hall-child/.test(expression.getText(context.sourceFile));
}

function hasUnresolvedTownHallChildPattern(fragments) {
  const unresolvedSegment = 'hall';
  const ordered = [];
  for (const fragment of fragments) {
    const previous = ordered[ordered.length - 1];
    if (typeof fragment === 'string' && typeof previous === 'string') {
      ordered[ordered.length - 1] += fragment;
    } else {
      ordered.push(fragment);
    }
  }

  for (let startIndex = 0; startIndex < ordered.length; startIndex += 1) {
    const startFragment = ordered[startIndex];
    if (typeof startFragment !== 'string') continue;
    const lowerStart = startFragment.toLowerCase();
    let startAt = lowerStart.indexOf('town-');
    while (startAt !== -1) {
      const previousCharacter = startAt > 0 ? startFragment[startAt - 1] : undefined;
      const previousFragment = ordered[startIndex - 1];
      const hasPathBoundary = startAt > 0
        ? previousCharacter === '/' || previousCharacter === '\\'
        : startIndex === 0 || previousFragment === undefined;

      if (hasPathBoundary) {
        for (let endIndex = startIndex + 1; endIndex < ordered.length; endIndex += 1) {
          const endFragment = ordered[endIndex];
          if (typeof endFragment !== 'string') continue;
          const lowerEnd = endFragment.toLowerCase();
          let endAt = lowerEnd.indexOf('-child');
          while (endAt !== -1) {
            const trailing = endFragment.slice(endAt + '-child'.length);
            const supportedSuffix = /^(?:\.(?:[cm]?[jt]sx?))?(?:[?#].*)?$/i.test(trailing);
            const suffixMayBeEmpty = ordered.slice(endIndex + 1).every((part) => part === undefined);
            const middle = [startFragment.slice(startAt + 'town-'.length)];
            middle.push(...ordered.slice(startIndex + 1, endIndex));
            middle.push(endFragment.slice(0, endAt));

            if (supportedSuffix && suffixMayBeEmpty && middle.includes(undefined)) {
              let positions = new Set([0]);
              let sawUnknown = false;
              for (const part of middle) {
                const nextPositions = new Set();
                for (const position of positions) {
                  if (part === undefined) {
                    sawUnknown = true;
                    for (let next = position; next <= unresolvedSegment.length; next += 1) {
                      nextPositions.add(next);
                    }
                    continue;
                  }
                  const literal = part.toLowerCase();
                  if (unresolvedSegment.startsWith(literal, position)) {
                    nextPositions.add(position + literal.length);
                  }
                }
                positions = nextPositions;
                if (positions.size === 0) break;
              }
              if (sawUnknown && positions.has(unresolvedSegment.length)) return true;
            }
            endAt = lowerEnd.indexOf('-child', endAt + 1);
          }
        }
      }

      startAt = lowerStart.indexOf('town-', startAt + 1);
    }
  }

  return false;
}

function staticStringFromExpression(expression, context, seen = new Set()) {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return { value: current.text, mayBeCodec: false };
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringFromExpression(current.left, context, seen);
    const right = staticStringFromExpression(current.right, context, seen);
    if (left.value !== undefined && right.value !== undefined) {
      return { value: left.value + right.value, mayBeCodec: false };
    }
    return {
      value: undefined,
      mayBeCodec: left.mayBeCodec || right.mayBeCodec || mayNameCodec(current, context),
    };
  }
  if (ts.isTemplateExpression(current)) {
    let value = current.head.text;
    for (const span of current.templateSpans) {
      const substitution = staticStringFromExpression(span.expression, context, seen);
      if (substitution.value === undefined) {
        return { value: undefined, mayBeCodec: mayNameCodec(current, context) };
      }
      value += substitution.value + span.literal.text;
    }
    return { value, mayBeCodec: false };
  }
  if (!ts.isIdentifier(current)) {
    return { value: undefined, mayBeCodec: mayNameCodec(current, context) };
  }

  const declarations = declarationsAt(context.checker, current, context.sourceFile);
  if (!declarations || declarations.length !== 1) {
    return { value: undefined, mayBeCodec: mayNameCodec(current, context) };
  }
  const initializer = constInitializerFor(declarations[0]);
  if (!initializer || seen.has(declarations[0])) {
    return { value: undefined, mayBeCodec: mayNameCodec(current, context) };
  }
  seen.add(declarations[0]);
  const value = staticStringFromExpression(initializer, context, seen);
  seen.delete(declarations[0]);
  return {
    value: value.value,
    mayBeCodec: value.mayBeCodec || (value.value === undefined && mayNameCodec(initializer, context)),
  };
}

function loaderFromExpression(expression, context, seen = new Set()) {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  if (ts.isIdentifier(current)) {
    const declarations = declarationsAt(context.checker, current, context.sourceFile);
    if (!declarations) return current.text === 'require' ? 'loader' : 'none';
    if (declarations.length !== 1) return 'ambiguous';
    const initializer = constInitializerFor(declarations[0]);
    if (!initializer) return 'none';
    if (seen.has(declarations[0])) return 'ambiguous';
    seen.add(declarations[0]);
    return loaderFromExpression(initializer, context, seen);
  }
  const memberName = moduleMemberNameFromExpression(current, context);
  if (memberName === 'require' && ts.isIdentifier(current.expression) &&
      current.expression.text === 'module') {
    return declarationsAt(context.checker, current.expression, context.sourceFile) ? 'none' : 'loader';
  }
  return 'none';
}

function moduleMemberNameFromExpression(expression, context) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (!ts.isElementAccessExpression(expression)) return undefined;
  return staticStringFromExpression(expression.argumentExpression, context).value;
}

function moduleReferenceExpression(node, siteKind) {
  if (siteKind === 'import' || siteKind === 'export') return node.moduleSpecifier;
  if (siteKind === 'import-equals' && ts.isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression;
  }
  return undefined;
}

function productionFileLoadsCodec(relativePath, source) {
  const context = compilerContextFor(relativePath, source);
  const { sourceFile } = context;

  let found = false;
  function visit(node) {
    if (found) return;
    const siteKind = moduleReferenceSiteKind(node);
    if (siteKind === 'import' || siteKind === 'export' || siteKind === 'import-equals') {
      const expression = moduleReferenceExpression(node, siteKind);
      if (expression) {
        const specifier = staticStringFromExpression(expression, context);
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
      const loader = isDynamicImport ? 'loader' : loaderFromExpression(node.expression, context);
      if (loader === 'loader' || loader === 'ambiguous') {
        const argument = node.arguments[0];
        if (argument) {
          const specifier = staticStringFromExpression(argument, context);
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

  assert.deepEqual(
    controls.map(([relativePath, source]) => [
      relativePath,
      productionFileLoadsCodec(relativePath, source),
    ]),
    controls.map(([relativePath]) => [relativePath, true]),
    'consumer controls must all be recognized',
  );

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

  assert.deepEqual(
    controls.map(([relativePath, source]) => [
      relativePath,
      productionFileLoadsCodec(relativePath, source),
    ]),
    controls.map(([relativePath]) => [relativePath, true]),
    'template consumer controls must all be recognized',
  );
});

test('consumer inventory follows direct loader aliases and static paths through them', () => {
  const controls = [
    ['src/require-alias-source.js', "const load = require; const codec = load('../src/town-hall-child.ts');"],
    ['src/module-require-alias-emitted.js', "const load = module.require; const codec = load('../dist/town-hall-child.js');"],
    ['src/require-path-alias-source.js', "const load = require; const codecPath = `../src/town-hall-child.ts`; const codec = load(codecPath);"],
    ['src/module-require-path-alias-emitted.js', "const load = module . require ;\nconst codecPath = `../dist/town-hall-child.js` ;\nconst codec = load ( codecPath ) ;"],
  ];

  assert.deepEqual(
    controls.map(([relativePath, source]) => [
      relativePath,
      productionFileLoadsCodec(relativePath, source),
    ]),
    controls.map(([relativePath]) => [relativePath, true]),
    'aliased consumer controls must all be recognized',
  );
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

  assert.deepEqual(
    positiveControls.map(([relativePath, source]) => [
      relativePath,
      productionFileLoadsCodec(relativePath, source),
    ]),
    positiveControls.map(([relativePath]) => [relativePath, true]),
    'lexical consumer controls must all be recognized',
  );

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
    ['src/shadowed-path-parameter.js', `
      function ignoreCodec(codecPath) {
        return require(codecPath);
      }
    `],
    ['src/shadowed-import-require.ts', `
      import require from './unrelated-loader';
      require('./town-hall-child.ts');
    `],
    ['src/shadowed-import-module.ts', `
      import module from './unrelated-module';
      module.require('../dist/town-hall-child.js');
    `],
    ['src/shadowed-function-require.js', `
      function require() { return null; }
      require('./town-hall-child.ts');
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

test('consumer inventory resolves outer paths in default parameter initializers', () => {
  const controls = [
    ['src/default-path-source.js', `
      const codecPath = './town-hall-child.ts';
      function consume(codec = require(codecPath)) {
        var codecPath = '../unrelated.js';
        return codec;
      }
      consume();
    `],
    ['src/default-path-emitted.js', `
      const codecPath = '../dist/town-hall-child.js';
      function consume(codec = module.require(codecPath)) {
        var codecPath = '../unrelated.js';
        return codec;
      }
      consume();
    `],
    ['src/default-require-body-shadow.js', `
      const codecPath = './town-hall-child.ts';
      function consume(codec = require(codecPath)) {
        var require = () => null;
        return codec;
      }
      consume();
    `],
    ['src/default-module-body-shadow.js', `
      const codecPath = '../dist/town-hall-child.js';
      function consume(codec = module.require(codecPath)) {
        var module = { require: () => null };
        return codec;
      }
      consume();
    `],
  ];

  assert.deepEqual(
    controls.map(([relativePath, source]) => [
      relativePath,
      productionFileLoadsCodec(relativePath, source),
    ]),
    controls.map(([relativePath]) => [relativePath, true]),
    'default-parameter path consumers must all be recognized',
  );
});

test('consumer inventory resolves outer loader aliases in default parameter initializers', () => {
  const controls = [
    ['src/default-alias-source.js', `
      const load = require;
      function consume(codec = load('./town-hall-child.ts')) {
        var load = () => null;
        return codec;
      }
      consume();
    `],
    ['src/default-module-alias-emitted.js', `
      const load = module.require;
      function consume(codec = load('../dist/town-hall-child.js')) {
        var load = () => null;
        return codec;
      }
      consume();
    `],
  ];

  assert.deepEqual(
    controls.map(([relativePath, source]) => [
      relativePath,
      productionFileLoadsCodec(relativePath, source),
    ]),
    controls.map(([relativePath]) => [relativePath, true]),
    'default-parameter loader consumers must all be recognized',
  );
});

test('consumer inventory folds static string concatenations and template substitutions', () => {
  const positiveControls = [
    ['src/split-source-concatenation.js', "const codec = require('./town-hall-' + 'child');"],
    ['src/split-emitted-const-chain.js', `
      const prefix = '../dist/town-hall-';
      const suffix = 'child.js';
      const codec = require(prefix + suffix);
    `],
    ['src/reused-const-fragment.js', `
      const prefix = './town-hall-';
      const empty = '';
      const codec = require(prefix + 'child' + empty + empty);
    `],
    ['src/template-source-substitution.js', "const codec = require(`./town-hall-${'child.ts'}`);"],
    ['src/template-emitted-substitution.js', `
      const suffix = 'child.js';
      const codec = require(` + '`../dist/town-hall-${suffix}`' + `);
    `],
  ];

  assert.deepEqual(
    positiveControls.map(([relativePath, source]) => [
      relativePath,
      productionFileLoadsCodec(relativePath, source),
    ]),
    positiveControls.map(([relativePath]) => [relativePath, true]),
    'static expression consumers must all be recognized',
  );

  const negativeControls = [
    ['src/unrelated-static-concatenation.js', "require('./unrelated-' + 'module');"],
    ['src/unrelated-static-template.js', "require(`./unrelated-${'module'}`);"],
  ];

  for (const [relativePath, source] of negativeControls) {
    assert.equal(
      productionFileLoadsCodec(relativePath, source),
      false,
      'unrelated static expression was treated as a codec consumer: ' + relativePath,
    );
  }
});

test('consumer inventory recognizes statically named bracketed module require calls', () => {
  const positiveControls = [
    ['src/bracket-require-single-source.js', "module['require']('./town-hall-child.ts');"],
    ['src/bracket-require-double-emitted.js', 'module["require"]("../dist/town-hall-child.js");'],
    ['src/bracket-require-template-source.js', "module[`require`]('./town-hall-child');"],
    ['src/bracket-require-constant-alias.js', `
      const member = ('require');
      const load = module[(member)];
      const codec = load('../dist/town-hall-child.js');
    `],
  ];

  for (const [relativePath, source] of positiveControls) {
    assert.equal(
      productionFileLoadsCodec(relativePath, source),
      true,
      'bracketed module require was not recognized: ' + relativePath,
    );
  }

  const negativeControls = [
    ['src/bracket-unrelated-module-member.js', "module['resolve']('../dist/town-hall-child.js');"],
    ['src/bracket-unknown-module-member.js', "module[getMemberName()]('../dist/town-hall-child.js');"],
    ['src/bracket-unrelated-target.js', "module['require']('./unrelated-module');"],
    ['src/bracket-shadowed-module-class.js', `
      class module { static require(value) { return value; } }
      module.require('../dist/town-hall-child.js');
    `],
  ];

  for (const [relativePath, source] of negativeControls) {
    assert.equal(
      productionFileLoadsCodec(relativePath, source),
      false,
      'non-global or unrelated bracketed member was treated as a codec consumer: ' + relativePath,
    );
  }
});

test('consumer inventory refuses unresolved split codec path fragments', () => {
  const unresolvedControls = [
    ['src/split-source-dynamic.js', "function load(runtimePart) { return require('./town-' + runtimePart + '-child'); }"],
    ['src/split-emitted-dynamic.js', "function load(runtimePart) { return require('../dist/town-' + runtimePart + '-child.js'); }"],
    ['src/split-source-template-dynamic.js', "function load(runtimePart) { return require(`./town-${runtimePart}-child.ts`); }"],
    ['src/split-emitted-template-alias-dynamic.js', "const prefix = '../dist/town-'; const suffix = '-child.js'; function load(runtimePart) { return require(`${prefix}${runtimePart}${suffix}`); }"],
    ['src/split-source-const-alias-dynamic.js', `
      const prefix = './town-';
      const suffix = '-child';
      function load(runtimePart) {
        const codecPath = prefix + runtimePart + suffix;
        return require(codecPath);
      }
    `],
  ];

  for (const [relativePath, source] of unresolvedControls) {
    assert.throws(
      () => productionFileLoadsCodec(relativePath, source),
      /Unclassified codec loader syntax/,
      'unresolved codec-shaped path was not refused: ' + relativePath,
    );
  }

  assert.equal(
    productionFileLoadsCodec(
      'src/split-source-static-constant.js',
      "const runtimePart = 'hall'; require('./town-' + runtimePart + '-child');",
    ),
    true,
    'a constant split codec path should resolve normally',
  );
  assert.equal(
    productionFileLoadsCodec(
      'src/unrelated-dynamic-path.js',
      "function load(runtimePart) { return require('./config-' + runtimePart + '.json'); }",
    ),
    false,
    'an unrelated unresolved path should remain compatible',
  );
});

test('consumer inventory refuses recognized codec expressions outside the finite evaluator', () => {
  assert.throws(
    () => productionFileLoadsCodec(
      'src/partial-computed-codec-path.js',
      "const suffix = getCodecSuffix(); require('./town-hall-' + suffix);",
    ),
    /Unclassified codec loader syntax/,
  );
});

test('consumer classifier uses one isolated read-only compiler Program per source', () => {
  const relativePath = 'src/compiler-isolation.js';
  const context = compilerContextFor(relativePath, 'const load = require; load("./unrelated");');
  const sourceFileName = path.resolve(repositoryRoot, relativePath);

  assert.deepEqual(context.program.getSourceFiles().map((sourceFile) => sourceFile.fileName), [
    sourceFileName,
  ]);
  assert.ok(context.effects.sourceReads > 0);
  assert.equal(context.program.getCompilerOptions().allowJs, true);
  assert.equal(context.program.getCompilerOptions().target, ts.ScriptTarget.Latest);
  assert.equal(context.program.getCompilerOptions().noEmit, true);
  assert.equal(context.program.getCompilerOptions().noResolve, true);
  assert.equal(context.program.getCompilerOptions().noLib, true);
  assert.deepEqual(context.program.getCompilerOptions().types, []);
  assert.deepEqual(context.effects.externalSourceRequests, []);
  assert.deepEqual(context.effects.moduleResolutionRequests, []);
  assert.deepEqual(context.effects.typeReferenceResolutionRequests, []);
  assert.equal(context.effects.writes, 0);
  assert.equal(context.host.readFile(path.join(repositoryRoot, 'types', 'ambient.d.ts')), undefined);
  assert.equal(context.host.fileExists(path.join(repositoryRoot, 'types', 'ambient.d.ts')), false);
  assert.deepEqual(context.effects.externalReadAttempts, [
    path.join(repositoryRoot, 'types', 'ambient.d.ts'),
  ]);
  assert.throws(
    () => context.host.writeFile(path.join(repositoryRoot, 'output.js'), 'source'),
    /Compiler output is disabled/,
  );
  assert.equal(context.effects.writes, 1);
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

  function callsFor(name) {
    const target = functionNamed(name);
    assert.ok(target, name + ' is present');
    const calls = [];
    function collect(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        calls.push(node.expression.text);
      }
      ts.forEachChild(node, collect);
    }
    collect(target);
    return calls.sort();
  }

  function memberReadsFor(name, receiver) {
    const target = functionNamed(name);
    assert.ok(target, name + ' is present');
    const reads = [];
    function collect(node) {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
          node.expression.text === receiver) {
        reads.push('property:' + node.name.text);
      }
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) &&
          node.expression.text === receiver) {
        const argument = node.argumentExpression;
        reads.push('element:' + (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)
          ? argument.text
          : 'computed'));
      }
      ts.forEachChild(node, collect);
    }
    collect(target);
    return reads.sort();
  }

  assert.deepEqual(predicatesFor('moduleReferenceSiteKind'), [
    'isCallExpression', 'isExportDeclaration', 'isImportDeclaration', 'isImportEqualsDeclaration',
  ]);
  assert.deepEqual(predicatesFor('moduleReferenceExpression'), ['isExternalModuleReference']);
  assert.deepEqual(predicatesFor('staticFragmentsFromExpression'), [
    'isBinaryExpression', 'isIdentifier', 'isNoSubstitutionTemplateLiteral',
    'isParenthesizedExpression', 'isStringLiteral', 'isTemplateExpression',
  ]);
  assert.deepEqual(predicatesFor('loaderFromExpression'), [
    'isIdentifier', 'isParenthesizedExpression',
  ]);
  assert.deepEqual(predicatesFor('moduleMemberNameFromExpression'), [
    'isElementAccessExpression', 'isPropertyAccessExpression',
  ]);
  assert.deepEqual(predicatesFor('staticStringFromExpression'), [
    'isBinaryExpression', 'isIdentifier', 'isNoSubstitutionTemplateLiteral',
    'isParenthesizedExpression', 'isStringLiteral', 'isTemplateExpression',
  ]);
  assert.deepEqual(predicatesFor('hasUnresolvedTownHallChildPattern'), []);
  assert.deepEqual(callsFor('mayNameCodec'), [
    'hasUnresolvedTownHallChildPattern', 'staticFragmentsFromExpression',
  ]);
  assert.deepEqual(callsFor('staticFragmentsFromExpression'), [
    'constInitializerFor', 'declarationsAt', 'staticFragmentsFromExpression',
  ]);
  assert.deepEqual(callsFor('loaderFromExpression'), [
    'constInitializerFor', 'declarationsAt', 'declarationsAt', 'loaderFromExpression',
    'moduleMemberNameFromExpression',
  ]);
  assert.deepEqual(callsFor('moduleMemberNameFromExpression'), ['staticStringFromExpression']);
  assert.deepEqual(memberReadsFor('moduleMemberNameFromExpression', 'expression'), [
    'property:argumentExpression', 'property:name',
  ]);
  assert.deepEqual(memberReadsFor('hasUnresolvedTownHallChildPattern', 'fragments'), []);
  assert.deepEqual(callsFor('hasUnresolvedTownHallChildPattern'), []);

  const productionClassifier = functionNamed('productionFileLoadsCodec');
  assert.ok(productionClassifier, 'production classifier is present');
  let siteDispatches = 0;
  const resolverSites = {
    loaderFromExpression: 0,
    moduleReferenceExpression: 0,
    staticStringFromExpression: 0,
  };
  function inspectProductionClassifier(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === 'moduleReferenceSiteKind') siteDispatches += 1;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        Object.hasOwn(resolverSites, node.expression.text)) {
      resolverSites[node.expression.text] += 1;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'ts' &&
        /^is[A-Z]/.test(node.expression.name.text)) {
      assert.fail('production classifier added a reader predicate outside the syntax inventory');
    }
    ts.forEachChild(node, inspectProductionClassifier);
  }
  inspectProductionClassifier(productionClassifier);
  assert.equal(siteDispatches, 1);
  assert.deepEqual(resolverSites, {
    loaderFromExpression: 1,
    moduleReferenceExpression: 1,
    staticStringFromExpression: 2,
  });
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
