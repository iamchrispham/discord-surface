const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const files = Object.freeze({ journal: 'src/state/town-hall-publication/journal.ts', repository: 'src/state/town-hall-publication/repository.ts' });
const repositoryPublicExports = Object.freeze(['SqlRow', 'confirmTownHallPublication', 'getTownHallPublication', 'getTownHallPublicationSet', 'markTownHallPublicationInFlight', 'recordTownHallPublicationOutcome', 'recoverTownHallPublication', 'reserveTownHallPublication']);
const journalPublicExports = Object.freeze(['appendEvent', 'decodePublication', 'readRowsByPrefix']);
const journalFunctionNames = Object.freeze(['appendEvent', 'canonicalEvent', 'decodePublication', 'readRows', 'readRowsByPrefix']);
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
const functionNames = owner => parse(owner).statements.filter(ts.isFunctionDeclaration).map(node => node.name.text);
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

test('public publication transitions retain their public interface', () => {
  assert.deepEqual(exportsOf('repository'), repositoryPublicExports);
});

test('publication journal helpers have one owner', () => {
  const journalExports = exportsOf('journal');
  for (const name of journalPublicExports) assert.ok(journalExports.includes(name));
  const journalFunctions = functionNames('journal');
  const repositoryFunctions = functionNames('repository');
  for (const name of journalFunctionNames) {
    assert.ok(journalFunctions.includes(name));
    assert.equal(repositoryFunctions.includes(name), false);
  }
});
test('publication journal reader and writer ownership remains explicit', () => {
  const append = node => ts.isIdentifier(node.expression) && node.expression.text === 'appendEvent';
  const receipt = node => ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'receipt';
  assert.equal(countCalls('repository', append), 5);
  assert.equal(countCalls('journal', append), 0);
  assert.equal(countCalls('repository', receipt), 0);
  assert.equal(countCalls('journal', receipt), 1);
});
test('publication journal module has no new resource lifecycle', () => {
  const transaction = node => ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'transaction';
  assert.equal(countCalls('journal', transaction), 0);
});
test('publication journal source is included in both strict builds', () => {
  for (const file of ['tsconfig.json', 'tsconfig.typecheck.json']) {
    const config = JSON.parse(read(file));
    assert.equal(config.include.filter(entry => entry === files.journal).length, 1);
  }
});
test('publication journal owner suite is registered exactly once', () => {
  const suite = 'test/state-townhall-publication-journal-owner.test.js';
  const testTokens = JSON.parse(read('package.json')).scripts.test.split(/\s+/);
  assert.equal(testTokens.filter(token => token === suite).length, 1);
});
