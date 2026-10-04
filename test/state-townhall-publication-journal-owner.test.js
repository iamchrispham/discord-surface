const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const baselineFile = 'test/state-townhall-publication-journal-baseline.json';
const baselineDigest = '35affd316c406a11a06fead7bf3bdd3477c70082e535002a99c62da25a78425b';
const baseline = JSON.parse(read(baselineFile));
const files = Object.freeze({ journal: 'src/state/town-hall-publication/journal.ts', repository: 'src/state/town-hall-publication/repository.ts' });
const parse = owner => {
  const tree = ts.createSourceFile(files[owner], read(files[owner]), ts.ScriptTarget.Latest, true);
  assert.equal(tree.parseDiagnostics.length, 0);
  return tree;
};
const names = (node, tree) => {
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.map(item => item.name.getText(tree));
  if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) return node.exportClause.elements.map(item => item.name.text);
  return node.name ? [node.name.text] : [];
};
const exported = node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
const declarations = owner => {
  const tree = parse(owner);
  return tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => ({ names: names(node, tree), owner, sha256: digest(node.getText(tree).replace(/^export\s+/, '')) }));
};
const functions = owner => {
  const tree = parse(owner);
  return tree.statements.filter(ts.isFunctionDeclaration).map(node => ({ name: node.name.text, owner, bodySha256: digest(node.body.getText(tree)), publicDeclarationSha256: exported(node) ? digest(node.getText(tree)) : null }));
};
const exportsOf = owner => {
  const tree = parse(owner);
  return tree.statements.filter(node => exported(node) || ts.isExportDeclaration(node)).flatMap(node => names(node, tree)).sort();
};
const countCalls = (owner, predicate) => {
  let count = 0;
  const visit = node => { if (ts.isCallExpression(node) && predicate(node)) count += 1; ts.forEachChild(node, visit); };
  visit(parse(owner));
  return count;
};

test('public publication transitions retain their original declarations', () => {
  const original = baseline.functions.filter(item => item.publicDeclarationSha256);
  const current = functions('repository').filter(item => item.publicDeclarationSha256);
  assert.equal(original.length, 7);
  assert.deepEqual(current, original);
  assert.deepEqual(exportsOf('repository'), baseline.repositoryExports);
});
test('publication journal helpers retain their original bodies', () => {
  for (const owner of Object.keys(files)) {
    assert.deepEqual(functions(owner).map(({ publicDeclarationSha256, ...row }) => row), baseline.functions.filter(row => row.owner === owner).map(({ publicDeclarationSha256, ...row }) => row));
  }
});
test('publication journal declarations have one owner', () => {
  for (const owner of Object.keys(files)) assert.deepEqual(declarations(owner), baseline.declarations.filter(row => row.owner === owner));
  assert.deepEqual(exportsOf('journal'), baseline.journalExports);
});
test('publication journal imports preserve public transition ownership', () => {
  for (const owner of Object.keys(files)) {
    const tree = parse(owner);
    assert.deepEqual(tree.statements.filter(ts.isImportDeclaration).map(node => digest(node.getText(tree))), baseline.imports[owner]);
  }
  assert.equal(digest(read('src/state/town-hall-publication/index.ts')), baseline.facadeSha256);
});
test('publication journal reader and writer checks remain exact', () => {
  const append = node => ts.isIdentifier(node.expression) && node.expression.text === 'appendEvent';
  const receipt = node => ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'receipt';
  assert.equal(countCalls('repository', append), 5);
  assert.equal(countCalls('journal', append), 0);
  assert.equal(countCalls('repository', receipt), 0);
  assert.equal(countCalls('journal', receipt), 1);
  for (const name of ['readRows', 'readRowsByPrefix', 'canonicalEvent', 'decodePublication', 'appendEvent']) {
    const actual = functions('journal').find(row => row.name === name);
    assert.equal(actual.bodySha256, baseline.functions.find(row => row.name === name).bodySha256);
  }
});
test('publication journal module has no new resource lifecycle', () => {
  const transaction = node => ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'transaction';
  assert.equal(countCalls('journal', transaction), 0);
  for (const owner of Object.keys(files)) {
    assert.ok(read(files[owner]).split('\n').length < 500);
    assert.deepEqual(declarations(owner), baseline.declarations.filter(row => row.owner === owner));
  }
});
test('publication journal source is included in both strict builds', () => {
  for (const [file, original] of Object.entries(baseline.configs)) {
    const expected = structuredClone(original);
    expected.include.push(files.journal);
    assert.deepEqual(JSON.parse(read(file)), expected);
  }
});
test('publication journal owner suite is registered exactly once', () => {
  const suite = 'test/state-townhall-publication-journal-owner.test.js';
  const testTokens = JSON.parse(read('package.json')).scripts.test.split(/\s+/);
  assert.equal(testTokens.filter(token => token === suite).length, 1);
});
test('publication journal baseline has the complete frozen declaration inventory', () => {
  assert.equal(digest(read(baselineFile)), baselineDigest);
  assert.equal(baseline.head, '48fa4aebc1f3c67120307f96b77847494eb8d451');
  assert.equal(baseline.functions.length, 30);
  assert.equal(new Set(baseline.functions.map(row => row.name)).size, 30);
  assert.equal(baseline.declarations.length, 52);
});
