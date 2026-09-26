'use strict';

// PR109 T4: bounded source inventory for the prepared-text-source handoff. The
// four readTextFile call sites and four runDirectPost call sites are a finite,
// classified set: any new call site or a rehomed owner fails this pin. The role
// table pins which POST_ROLES values are publication callers of this class.
// This is a source inventory, not proof against dynamic dispatch.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const SRC_ROOT = path.resolve(__dirname, '..', 'src');

const READ_TEXT_FILE_SITES = new Map([
  ['peer/service.js\u0000send', 1],
  ['direct-post.ts\u0000runDirectPost', 1],
  ['direct-post.ts\u0000runWatcherNoticePost', 1],
  ['direct-post/source.ts\u0000prepareFileSource', 1]
]);

const RUN_DIRECT_POST_SITES = new Map([
  ['peer/service.js\u0000send', 1],
  ['cli.js\u0000directPost', 1],
  ['peer/post.js\u0000postByRole', 1],
  ['direct-post.ts\u0000runWatcherNoticePost', 1]
]);

function sourceFiles(root) {
  const found = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|ts)$/.test(entry.name)) found.push(full);
    }
  };
  walk(root);
  return found;
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

function parseCallSites(fileName, text, callees) {
  const kind = fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const sites = [];
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const callee = ts.isIdentifier(expression) ? expression.text
        : (ts.isPropertyAccessExpression(expression) ? expression.name.text : null);
      if (callees.has(callee)) sites.push({ callee, file: fileName, owner: enclosingOwner(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

function enumerateCallSites(root, callees) {
  const sites = [];
  for (const full of sourceFiles(root)) {
    const relative = path.relative(root, full).split(path.sep).join('/');
    sites.push(...parseCallSites(relative, fs.readFileSync(full, 'utf8'), callees));
  }
  return sites;
}

function tally(sites) {
  const counts = new Map();
  for (const site of sites) {
    const key = `${site.file}\u0000${site.owner}`;
    if (!counts.has(key)) counts.set(key, 0);
    counts.set(key, counts.get(key) + 1);
  }
  return counts;
}

// Unknown owner keys fail before the deep-equality drift check.
function assertClassified(counts, known, label) {
  for (const key of counts.keys()) {
    if (!known.has(key)) throw new Error(`unclassified ${label}: ${key.split('\u0000').join(':')}`);
  }
  assert.deepEqual(counts, known, `${label} classify exactly`);
}

test('readTextFile and runDirectPost call-site inventories classify exactly their known owners', () => {
  const textFileSites = enumerateCallSites(SRC_ROOT, new Set(['readTextFile']));
  const directPostSites = enumerateCallSites(SRC_ROOT, new Set(['runDirectPost']));
  assert.equal(textFileSites.length, 4, 'exactly four readTextFile call sites');
  assert.equal(directPostSites.length, 4, 'exactly four runDirectPost call sites');
  assertClassified(tally(textFileSites), READ_TEXT_FILE_SITES, 'readTextFile owners');
  assertClassified(tally(directPostSites), RUN_DIRECT_POST_SITES, 'runDirectPost owners');
  const synthetic = parseCallSites('peer/new-owner.js',
    'function addedCaller(input) {\n  return readTextFile(input.text_file);\n}', new Set(['readTextFile']));
  assert.equal(synthetic.length, 1);
  assert.throws(() => assertClassified(tally(synthetic), READ_TEXT_FILE_SITES, 'readTextFile owners'),
    /unclassified readTextFile owners: peer\/new-owner\.js:addedCaller/,
    'an unclassified new call site fails the pin');
});

const POST_ROLE_COVERAGE = new Map([
  ['announce', { key: 'ANNOUNCE', surface: 'peer_send publish', preparedTextSource: false,
    detail: 'existing single-read path' }],
  ['board', { key: 'BOARD', surface: 'board refresh', preparedTextSource: false,
    detail: 'board refresh, not a publication caller of this class' }],
  ['child', { key: 'CHILD', surface: 'peer send', preparedTextSource: true,
    detail: 'delegates to peer send which supplies preparedTextSource' }]
]);

function classifyPostRole(role) {
  const coverage = POST_ROLE_COVERAGE.get(role);
  if (!coverage) throw new Error(`unclassified post role: ${role}`);
  return coverage;
}

test('every exported POST_ROLES value has a prepared-text-source coverage classification', () => {
  const { POST_ROLES } = require('../src/peer/post.js');
  const exportedRoles = Object.values(POST_ROLES);
  assert.equal(exportedRoles.length, 3, 'three exported post roles');
  assert.deepEqual(new Set(exportedRoles), new Set(POST_ROLE_COVERAGE.keys()),
    'the coverage table matches the exported role vocabulary exactly');
  for (const role of exportedRoles) {
    const coverage = classifyPostRole(role);
    assert.equal(typeof coverage.detail, 'string');
    assert.equal(typeof coverage.preparedTextSource, 'boolean');
  }
  assert.equal(classifyPostRole(POST_ROLES.ANNOUNCE).preparedTextSource, false);
  assert.equal(classifyPostRole(POST_ROLES.BOARD).preparedTextSource, false);
  assert.equal(classifyPostRole(POST_ROLES.CHILD).preparedTextSource, true);
  assert.throws(() => classifyPostRole('new-role'), /unclassified post role: new-role/,
    'an unclassified or newly exported role fails the pin');
});
