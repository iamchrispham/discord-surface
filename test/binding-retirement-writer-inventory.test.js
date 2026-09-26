'use strict';

// PR109 T4: bounded source pin for SQL writes to `bindings`, classified by
// source-relative file and enclosing function/method. The five retiring owners,
// the first-bind exclusion, and the readiness-only writes are the complete
// baseline. Any added, removed, or renamed writer changes a classified map and
// fails this suite. This is a source inventory, not proof against dynamic SQL.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const SRC_ROOT = path.resolve(__dirname, '..', 'src');

// Owners that retire or relocate a binding and must consult the in-transaction
// classifier. Two live in ordinary-binding.ts, three in state.js.
const RETIRING_OWNERS = new Map([
  ['state.js\u0000rebind', 1],
  ['state.js\u0000unbind', 1],
  ['state.js\u0000handoffConductor', 1],
  ['state/ordinary-binding.ts\u0000rebindOrdinary', 1],
  ['state/ordinary-binding.ts\u0000handoffOrdinary', 1]
]);

// Initial bind refuses any existing row before and inside its transaction, so it
// is deliberately excluded from the retirement guard.
const FIRST_BIND_OWNERS = new Map([
  ['state.js\u0000bind', 1]
]);

// Readiness-only writes keep their existing authority and receive no hold.
const READINESS_OWNERS = new Map([
  ['state.js\u0000setBindingReadiness', 1],
  ['state.js\u0000upsertIntakeWatermark', 1],
  ['state/intake.js\u0000markIntakeBoundary', 1],
  ['state/intake.js\u0000reconcileIntake', 1],
  ['state/topic-publication.js\u0000beginTopicPublication', 1],
  ['state/schema/migration.js\u0000migrateSchema', 1]
]);

const WRITE_PATTERN = /\b(?:UPDATE|INSERT(?:\s+OR\s+REPLACE)?|DELETE\s+FROM)\b/i;
const OTHER_TABLES = /\b(?:intake_watermarks|topic_publications|messages|reply_parts|provision_intents|thread_enrollments|native_reply_files|config|receipts)\b/i;

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

// Walk from a prepare() call to the nearest enclosing named function or method.
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

function isBindingsWrite(sql) {
  return WRITE_PATTERN.test(sql) && /\bbindings\b/i.test(sql) && !OTHER_TABLES.test(sql);
}

function parseWriters(fileName, text) {
  const kind = fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const writers = [];
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'prepare') {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) {
          const sql = argument.text.replace(/\s+/g, ' ').trim();
          if (isBindingsWrite(sql)) writers.push({ file: fileName, owner: enclosingOwner(node), sql });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return writers;
}

function enumerateWriters(root) {
  const writers = [];
  for (const full of sourceFiles(root)) {
    const relative = path.relative(root, full).split(path.sep).join('/');
    writers.push(...parseWriters(relative, fs.readFileSync(full, 'utf8')));
  }
  return writers;
}

// Every writer must land in exactly one bucket; anything else fails the pin.
function classifyWriters(writers) {
  const retiring = new Map();
  const firstBind = new Map();
  const readiness = new Map();
  for (const writer of writers) {
    const key = `${writer.file}\u0000${writer.owner}`;
    const bucket = RETIRING_OWNERS.has(key) ? retiring
      : FIRST_BIND_OWNERS.has(key) ? firstBind
      : READINESS_OWNERS.has(key) ? readiness : null;
    if (!bucket) throw new Error(`unclassified bindings writer: ${writer.file}:${writer.owner}`);
    bucket.set(key, (bucket.get(key) || 0) + 1);
  }
  return { retiring, firstBind, readiness };
}

test('writer inventory pins the five retiring owners, first-bind, and six readiness writes', () => {
  const writers = enumerateWriters(SRC_ROOT);
  assert.equal(writers.length, 12, 'exactly twelve baseline bindings writers');
  const { retiring, firstBind, readiness } = classifyWriters(writers);
  assert.deepEqual(retiring, RETIRING_OWNERS, 'retiring owners classify exactly');
  assert.deepEqual(firstBind, FIRST_BIND_OWNERS, 'first-bind owner classifies exactly');
  assert.deepEqual(readiness, READINESS_OWNERS, 'readiness owners classify exactly');
  for (const writer of writers) {
    assert.match(writer.sql, /bindings/, 'each writer targets the bindings table');
    assert.equal(typeof writer.owner, 'string', 'each writer has an enclosing owner');
    assert.notEqual(writer.owner.length, 0, 'owner names are non-empty');
  }
});

test('writer inventory rejects an unclassified added writer and ignores other tables', () => {
  const synthetic = [
    'function addedWriter(db: any): void {',
    '  db.prepare("UPDATE bindings SET active=0 WHERE channel_id=?").run("101");',
    '  db.prepare("UPDATE messages SET state=? WHERE discord_id=?").run("x", "1");',
    '}'
  ].join('\n');
  const writers = parseWriters('state/new-owner.ts', synthetic);
  assert.equal(writers.length, 1, 'only the bindings write is enumerated');
  assert.equal(writers[0].owner, 'addedWriter');
  assert.throws(() => classifyWriters(writers), /unclassified bindings writer: state\/new-owner\.ts:addedWriter/);
  assert.throws(() => classifyWriters([{ file: 'state.js', owner: 'rebindV2', sql: 'UPDATE bindings SET active=0' }]),
    /unclassified bindings writer/, 'a renamed or moved owner is rejected');
  assert.doesNotThrow(() => classifyWriters(enumerateWriters(SRC_ROOT)), 'the real tree stays fully classified');
});
