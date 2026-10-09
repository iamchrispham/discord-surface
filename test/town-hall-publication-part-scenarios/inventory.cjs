'use strict';
const { PUBLICATION_OWNER_FILES, PUBLICATION_OWNER_FILE_LIST, PUBLICATION_DEFINITION_OWNERS, PUBLICATION_RECEIPT_CONSUMER_ALLOWLIST, APPEND_EVENT_CALL_COUNT } = require('../town-hall-publication-scenarios-source-inventory.cjs');

function register({ test, assert, fs, os, path, SurfaceState, BindingError, StateCorruptError, discordNonce, TOWN_HALL_PUBLICATION_RECEIPTS, createTownHallPublicationHandlers, planTownHallRoomParts, INSTRUCTION_PREFIX, PUBLICATION_PREFIX, INSTRUCTION_PART_PREFIX, PUBLICATION_PART_PREFIX, CORRUPT, INVALID_KEY, MISSING_JOURNAL, INVALID_PART, PROJECT_ROOT, SOURCE_ID, CODEX_ID, SECOND_ID, OWNER, address, input, longInput, fixture, publicationKeyFor, partPublicationKey, partReceiptKind, receiptIds, rowsOf, sortedKeys, assertBindingError, assertCorrupt, publicationHandlers, overrideOwnerAlive, insertRawReceipt, dropExpressionIndexes, restoreExpressionIndexes, insertMessagesRow, partIds, journalPlan, eventDetail, seedSentPart }) {
function listProductionSourceFiles() {
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!entry.name.endsWith('.d.ts') && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
        files.push(path.relative(PROJECT_ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  walk(path.join(PROJECT_ROOT, 'src'));
  return files.sort();
}

function parseSources(files) {
  const ts = require('typescript');
  return files.map(file => {
    const text = fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf8');
    return {
      file,
      text,
      sourceFile: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS)
    };
  });
}

function collectDefinitions(ts, records) {
  const definitions = [];
  const calls = [];
  const receiptWrites = [];
  const constantConsumers = new Set();
  const visit = (record, node) => {
    const line = record.sourceFile.getLineAndCharacterOfPosition(node.getStart(record.sourceFile)).line + 1;
    if (ts.isFunctionDeclaration(node) && node.name) {
      definitions.push({ name: node.name.text, file: record.file, node });
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        definitions.push({ name: node.name.text, file: record.file, node });
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls.push({ name: node.expression.text, file: record.file, node });
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isReceipt = (ts.isIdentifier(callee) && callee.text === 'receipt') ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'receipt');
      if (isReceipt) {
        const text = node.getText(record.sourceFile);
        const publicationWriter = text.includes('TOWN_HALL_PUBLICATION_RECEIPTS') ||
          text.includes('PUBLICATION_PART_PREFIX') || text.includes('PUBLICATION_PREFIX') ||
          text.includes('INSTRUCTION_PART_PREFIX') || text.includes('context.receiptKind');
        if (publicationWriter) {
          receiptWrites.push({ file: record.file, text, referencesPartKind: publicationWriter });
        }
      }
    }
    if (ts.isIdentifier(node) && (node.text === 'TOWN_HALL_PUBLICATION_RECEIPTS' || node.text === 'TOWN_HALL_PUBLICATION_EVENTS')) {
      let ancestor = node.parent;
      while (ancestor && !ts.isImportDeclaration(ancestor)) ancestor = ancestor.parent;
      if (!ancestor) constantConsumers.add(`${record.file}:${node.text}`);
    }
    ts.forEachChild(node, child => visit(record, child));
  };
  for (const record of records) visit(record, record.sourceFile);
  return { definitions, calls, receiptWrites, constantConsumers };
}

function assertReceiptConsumerFiles(consumers, expectedFiles) {
  const suffix = ':TOWN_HALL_PUBLICATION_RECEIPTS';
  const actual = [...consumers].filter(value => value.endsWith(suffix))
    .map(value => value.slice(0, -suffix.length)).sort();
  assert.deepEqual(actual, [...expectedFiles].sort(), 'receipt constants have exactly four real owner consumers');
}

test('publication part transitions keep one writer and decoder', () => {
  const ts = require('typescript');
  const records = parseSources(listProductionSourceFiles());
  const { definitions, calls, receiptWrites, constantConsumers } = collectDefinitions(ts, records);
  const repositoryFile = PUBLICATION_OWNER_FILES.repository;
  const journalFile = PUBLICATION_DEFINITION_OWNERS.appendEvent;
  const contextFile = 'src/state/town-hall-publication/context.ts';
  const projectionFile = PUBLICATION_OWNER_FILES.projection;
  const ownerFiles = PUBLICATION_OWNER_FILE_LIST;

  const ownerDirectory = 'src/state/town-hall-publication/';
  const inOwner = entry => entry.file.startsWith(ownerDirectory);
  const definitionOwners = PUBLICATION_DEFINITION_OWNERS;
  for (const [name, ownerFile] of Object.entries(definitionOwners)) {
    const found = definitions.filter(entry => entry.name === name && inOwner(entry));
    assert.equal(found.length, 1, `expected one ${name} definition under the publication owner, found ${found.map(entry => entry.file).join(', ')}`);
    assert.equal(found[0].file, ownerFile, `${name} belongs to ${ownerFile}`);
  }
  const groupEvents = definitions.filter(entry => entry.name === 'groupEvents' && inOwner(entry));
  assert.equal(groupEvents.length, 1, 'expected one groupEvents definition');
  assert.equal(groupEvents[0].file, projectionFile, 'groupEvents belongs to projection.ts');
  for (const name of ['appendEvent', 'canonicalEvent', 'decodePublication', 'readRows', 'classifyLiveness', 'groupEvents']) {
    assert.equal(definitions.filter(entry => entry.name === name && entry.file === contextFile).length, 0, `${name} must not be defined in context.ts`);
  }

  const appendCalls = calls.filter(entry => entry.name === 'appendEvent');
  assert.equal(appendCalls.length, APPEND_EVENT_CALL_COUNT, `expected five appendEvent calls, found ${appendCalls.length}`);
  assert.ok(appendCalls.every(entry => entry.file === repositoryFile), 'appendEvent is only called in repository.ts');

  const partWrites = receiptWrites.filter(entry => entry.referencesPartKind);
  assert.equal(partWrites.length, 1, 'exactly one publication receipt writer call site');
  assert.equal(partWrites[0].file, journalFile, 'no receipt writes outside journal.ts');
  assert.equal(receiptWrites.filter(entry => entry.referencesPartKind && entry.file !== journalFile).length, 0);

  for (const consumer of constantConsumers) {
    const file = consumer.slice(0, consumer.lastIndexOf(':'));
    assert.ok(ownerFiles.includes(file), `publication constants consumed outside the owner files: ${consumer}`);
  }

  const repositoryRecord = records.find(record => record.file === repositoryFile);
  assert.ok(repositoryRecord);
  assertReceiptConsumerFiles(constantConsumers, PUBLICATION_RECEIPT_CONSUMER_ALLOWLIST);
  const unusedImportText = repositoryRecord.text.replace(
    "TOWN_HALL_PUBLICATION_RECEIPTS.PUBLICATION_PART_PREFIX + key + ':'",
    "'town-hall-publication-part/v1:' + key + ':'"
  );
  assert.notEqual(unusedImportText, repositoryRecord.text);
  const unusedImportRecord = {
    ...repositoryRecord,
    text: unusedImportText,
    sourceFile: ts.createSourceFile(repositoryFile, unusedImportText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  };
  const mutantConsumers = collectDefinitions(ts, records.map(record =>
    record.file === repositoryFile ? unusedImportRecord : record)).constantConsumers;
  assert.throws(() => assertReceiptConsumerFiles(mutantConsumers, PUBLICATION_RECEIPT_CONSUMER_ALLOWLIST), /four real owner consumers/);

  const entrypoints = ['getTownHallPublication', 'reserveTownHallPublication', 'markTownHallPublicationInFlight',
    'recordTownHallPublicationOutcome', 'recoverTownHallPublication', 'confirmTownHallPublication'];
  for (const name of entrypoints) {
    const declaration = repositoryRecord.sourceFile.statements.find(statement =>
      ts.isFunctionDeclaration(statement) && statement.name && statement.name.text === name);
    assert.ok(declaration, `${name} must be exported by repository.ts`);
    const parameters = declaration.parameters;
    const last = parameters[parameters.length - 1];
    assert.ok(last && ts.isIdentifier(last.name) && last.name.text === 'partId', `${name} must take a final partId parameter`);
    assert.ok(last.questionToken, `${name}'s partId must be optional`);
  }
});

test('publication part suite and readonly types are registered once', () => {
  const newSuite = 'test/town-hall-publication-parts.test.js';
  const roomSuite = 'test/town-hall-room-parts.test.js';
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const tokens = pkg.scripts.test.trim().split(/\s+/);
  assert.equal(tokens.filter(entry => entry === newSuite).length, 1, 'the new suite must be registered exactly once');
  assert.equal(tokens.filter(entry => entry === roomSuite).length, 1, 'room parts stays registered exactly once');

  const newContext = 'src/state/town-hall-publication/context.ts';
  const baseConfig = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'tsconfig.json'), 'utf8'));
  assert.equal(baseConfig.include.filter(entry => entry === newContext).length, 1, 'tsconfig lists context.ts once');
  assert.equal(baseConfig.include.filter(entry => entry === 'test/types/town-hall-publication-parts-types.ts').length, 0, 'tsconfig excludes the type fixture');

  const fixturePath = 'test/types/town-hall-publication-parts-types.ts';
  const typesConfig = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'tsconfig.typecheck.json'), 'utf8'));
  assert.equal(typesConfig.include.filter(entry => entry === newContext).length, 1, 'typecheck lists context.ts once');
  assert.equal(typesConfig.include.filter(entry => entry === fixturePath).length, 1, 'typecheck lists the new fixture once');

  const fixture = fs.readFileSync(path.join(PROJECT_ROOT, fixturePath), 'utf8');
  assert.equal((fixture.match(/@ts-expect-error/g) || []).length, 8, 'the new fixture pins exactly eight errors');
  assert.equal(/\bany\b|@ts-ignore|@ts-nocheck/.test(fixture), false, 'the new fixture must not use an escape hatch');
});
}

module.exports = register;
