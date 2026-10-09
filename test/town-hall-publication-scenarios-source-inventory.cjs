'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const PUBLICATION_OWNER_PREFIX = 'src/state/town-hall-publication/';
const PUBLICATION_OWNER_FILES = Object.freeze({
  index: `${PUBLICATION_OWNER_PREFIX}index.ts`,
  projection: `${PUBLICATION_OWNER_PREFIX}projection.ts`,
  repository: `${PUBLICATION_OWNER_PREFIX}repository.ts`,
  journal: `${PUBLICATION_OWNER_PREFIX}journal.ts`,
  types: `${PUBLICATION_OWNER_PREFIX}types.ts`
});
const PUBLICATION_DEFINITION_OWNERS = Object.freeze({ appendEvent: PUBLICATION_OWNER_FILES.journal, canonicalEvent: PUBLICATION_OWNER_FILES.journal, decodePublication: PUBLICATION_OWNER_FILES.journal, readRows: PUBLICATION_OWNER_FILES.journal, classifyLiveness: PUBLICATION_OWNER_FILES.repository, groupEvents: PUBLICATION_OWNER_FILES.projection });
const PUBLICATION_OWNER_FILE_LIST = Object.freeze([
  PUBLICATION_OWNER_FILES.repository,
  PUBLICATION_OWNER_FILES.journal,
  PUBLICATION_OWNER_FILES.projection,
  PUBLICATION_OWNER_FILES.types,
  PUBLICATION_OWNER_FILES.index
]);
// Derivation of these two allowlists is the census in F-001: the publication
// receipt prefix/constants and the event vocabulary are consumed only by the
// five owner files. Any new consumer (for example an alternate writer) fails.
const PUBLICATION_RECEIPT_CONSUMER_ALLOWLIST = Object.freeze([
  PUBLICATION_OWNER_FILES.repository,
  PUBLICATION_OWNER_FILES.projection,
  PUBLICATION_OWNER_FILES.types,
  PUBLICATION_OWNER_FILES.index
]);
const PUBLICATION_EVENT_CONSUMER_ALLOWLIST = PUBLICATION_OWNER_FILE_LIST;
const FINITE_PUBLICATION_VALUES = Object.freeze([
  'planned', 'claimed', 'in_flight', 'sent', 'not_sent', 'rejected', 'rate_limited', 'unknown', 'stale'
]);
const PUBLICATION_EVENT_VOCABULARY = Object.freeze(['reserved', 'in_flight', 'outcome', 'confirmed']);
const PUBLICATION_PREFIX_LITERALS = Object.freeze(['town-hall-publication/v1:', 'town-hall-instruction/v1:']);
const APPEND_EVENT_CALL_COUNT = 5;
const RETRYABLE_OUTCOME_REFS = Object.freeze([
  'DIRECT_POST_OUTCOMES.NOT_SENT',
  'DIRECT_POST_OUTCOMES.REJECTED',
  'DIRECT_POST_OUTCOMES.RATE_LIMITED',
  'DIRECT_POST_OUTCOMES.STALE'
]);
const BLOCKED_RESERVE_STATUS_REFS = Object.freeze([
  'DIRECT_POST_PART_STATUSES.CLAIMED',
  'DIRECT_POST_PART_STATUSES.IN_FLIGHT',
  'DIRECT_POST_OUTCOMES.SENT',
  'DIRECT_POST_OUTCOMES.UNKNOWN'
]);

function publicationSourceRoot() {
  const override = process.env.TOWN_HALL_PUBLICATION_SOURCE_ROOT;
  return override ? path.resolve(override) : path.resolve(__dirname, '..');
}

function listProductionSourceFiles(root) {
  const { spawnSync } = require('node:child_process');
  const run = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.error || result.status !== 0) return null;
    return result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  };
  const keep = file => !file.endsWith('.d.ts') && (file.endsWith('.ts') || file.endsWith('.js'));
  const tracked = run(['ls-files', 'src']);
  const untracked = run(['ls-files', '--others', '--exclude-standard', 'src']) || [];
  if (tracked !== null && (tracked.length > 0 || untracked.length > 0)) {
    return [...new Set([...tracked, ...untracked])].filter(keep).sort();
  }
  // Source-root override that is not a git checkout: walk the source tree.
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (keep(rel)) files.push(rel);
      }
    }
  };
  walk(path.join(root, 'src'));
  return files.sort();
}

function parseProductionSources(root, files) {
  const ts = require('typescript');
  return files.map(file => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
    );
    return { file, text, sourceFile };
  });
}

function walkAst(node, visit) {
  const ts = require('typescript');
  visit(node);
  ts.forEachChild(node, child => walkAst(child, visit));
}

// Constant-fold a string expression made only of literals and local const
// identifiers. Returns null when the expression depends on a runtime value.
function foldStringExpression(ts, node, constMap) {
  if (!node) return null;
  if (ts.isParenthesizedExpression(node)) return foldStringExpression(ts, node.expression, constMap);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return constMap.has(node.text) ? constMap.get(node.text) : null;
  if (ts.isTemplateExpression(node)) {
    // Fold a template whose head and substitutions are all constant strings.
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = foldStringExpression(ts, span.expression, constMap);
      if (expression === null) return null;
      value += expression + span.literal.text;
    }
    return value;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldStringExpression(ts, node.left, constMap);
    const right = foldStringExpression(ts, node.right, constMap);
    if (left !== null && right !== null) return left + right;
  }
  return null;
}

// AST-based consumer census. Comments are not AST nodes, so a comment-only
// mention of a constant is not a consumer; a split literal concatenation is
// folded, so it cannot evade the prefix allowlist.
function collectConsumerEvidence(ts, record) {
  const constMap = new Map();
  walkAst(record.sourceFile, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const folded = foldStringExpression(ts, node.initializer, constMap);
      if (folded !== null) constMap.set(node.name.text, folded);
    }
  });
  const evidence = {
    symbols: new Set(),
    prefixLines: [],
    receiptLines: [],
    receiptDetailEventLines: []
  };
  const lineOf = node => record.sourceFile.getLineAndCharacterOfPosition(node.getStart(record.sourceFile)).line + 1;
  walkAst(record.sourceFile, node => {
    if (ts.isIdentifier(node)) evidence.symbols.add(node.text);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isBinaryExpression(node) || ts.isIdentifier(node)) {
      const folded = foldStringExpression(ts, node, constMap);
      if (folded !== null && PUBLICATION_PREFIX_LITERALS.includes(folded)) {
        const line = lineOf(node);
        if (!evidence.prefixLines.includes(line)) evidence.prefixLines.push(line);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isReceipt = (ts.isIdentifier(callee) && callee.text === 'receipt') ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'receipt');
      if (isReceipt) {
        evidence.receiptLines.push(lineOf(node));
        const usesPrefix = node.arguments.some(argument => {
          let folded = null;
          walkAst(argument, child => {
            if (folded !== null) return;
            const value = foldStringExpression(ts, child, constMap);
            if (value !== null && PUBLICATION_PREFIX_LITERALS.includes(value)) folded = value;
          });
          return folded !== null;
        });
        const usesEventVocabulary = node.arguments.some(argument => {
          let found = false;
          walkAst(argument, child => {
            if (!ts.isObjectLiteralExpression(child)) return;
            for (const property of child.properties) {
              if (!ts.isPropertyAssignment(property)) continue;
              const name = property.name;
              const named = (ts.isIdentifier(name) && name.text === 'event') ||
                (ts.isStringLiteral(name) && name.text === 'event');
              if (!named) continue;
              const folded = foldStringExpression(ts, property.initializer, constMap);
              if (folded !== null && PUBLICATION_EVENT_VOCABULARY.includes(folded)) found = true;
            }
          });
          return found;
        });
        if (usesPrefix || usesEventVocabulary) evidence.receiptDetailEventLines.push(lineOf(node));
      }
    }
  });
  return evidence;
}

// Focused ownership census over the publication owner. It rejects a duplicate
// writer/decoder definition, a caller outside the owner, a new prefix/constant
// consumer and a raw finite status/outcome literal.
function analyzePublicationOwnership(records) {
  const ts = require('typescript');
  const failures = [];
  const definitions = [];
  const variableDeclarations = [];
  const calls = [];
  const stringLiterals = [];
  const consumerEvidence = new Map();
  for (const record of records) {
    const lineOf = node =>
      record.sourceFile.getLineAndCharacterOfPosition(node.getStart(record.sourceFile)).line + 1;
    walkAst(record.sourceFile, node => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        definitions.push({ name: node.name.text, file: record.file });
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        variableDeclarations.push({ name: node.name.text, file: record.file, initializer: node.initializer || null });
        if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
          definitions.push({ name: node.name.text, file: record.file });
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        calls.push({ name: node.expression.text, file: record.file });
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        stringLiterals.push({ value: node.text, file: record.file, line: lineOf(node) });
      }
    });
    consumerEvidence.set(record.file, collectConsumerEvidence(ts, record));
  }
  const definitionsNamed = name => definitions.filter(entry => entry.name === name);
  const callsNamed = name => calls.filter(entry => entry.name === name);
  const recordsByFile = new Map(records.map(record => [record.file, record]));
  const typesRecord = recordsByFile.get(PUBLICATION_OWNER_FILES.types);

  // 1. exactly one appendEvent definition and exactly five callers.
  const appendDefinitions = definitionsNamed('appendEvent');
  if (appendDefinitions.length !== 1) {
    failures.push(`expected exactly one appendEvent definition, found ${appendDefinitions.length}: ${appendDefinitions.map(d => d.file).join(', ') || 'none'}`);
  } else if (appendDefinitions[0].file !== PUBLICATION_DEFINITION_OWNERS.appendEvent) {
    failures.push(`appendEvent must be defined in ${PUBLICATION_DEFINITION_OWNERS.appendEvent}, found ${appendDefinitions[0].file}`);
  }
  const appendCalls = callsNamed('appendEvent');
  if (appendCalls.length !== APPEND_EVENT_CALL_COUNT) {
    failures.push(`expected exactly ${APPEND_EVENT_CALL_COUNT} appendEvent calls, found ${appendCalls.length}: ${appendCalls.map(c => c.file).join(', ') || 'none'}`);
  }
  for (const call of appendCalls) {
    if (call.file !== PUBLICATION_OWNER_FILES.repository) {
      failures.push(`appendEvent is called outside the owner at ${call.file}`);
    }
  }

  // 2. exactly one decodePublication definition.
  const decodeDefinitions = definitionsNamed('decodePublication');
  if (decodeDefinitions.length !== 1) {
    failures.push(`expected exactly one decodePublication definition, found ${decodeDefinitions.length}: ${decodeDefinitions.map(d => d.file).join(', ') || 'none'}`);
  } else if (decodeDefinitions[0].file !== PUBLICATION_DEFINITION_OWNERS.decodePublication) {
    failures.push(`decodePublication must be defined in ${PUBLICATION_DEFINITION_OWNERS.decodePublication}, found ${decodeDefinitions[0].file}`);
  }

  // 3. the publication read path readRows -> canonicalEvent lives only with the
  // owner. The journal workflow has its own private readRows helper, so scope
  // the ownership check to the owner files and reject any duplicated
  // readRows -> canonicalEvent path outside them.
  for (const name of ['readRows', 'canonicalEvent']) {
    const named = definitions.filter(entry => entry.name === name && PUBLICATION_OWNER_FILE_LIST.includes(entry.file));
    if (named.length !== 1) {
      failures.push(`expected exactly one ${name} definition under the publication owner, found ${named.length}: ${named.map(d => d.file).join(', ') || 'none'}`);
      continue;
    }
    if (named[0].file !== PUBLICATION_DEFINITION_OWNERS[name]) {
      failures.push(`${name} must be defined in ${PUBLICATION_DEFINITION_OWNERS[name]}, found ${named[0].file}`);
    }
  }
  const canonicalOutsideOwner = definitions
    .filter(entry => entry.name === 'canonicalEvent' && !PUBLICATION_OWNER_FILE_LIST.includes(entry.file));
  for (const entry of canonicalOutsideOwner) {
    failures.push(`canonicalEvent is duplicated outside the publication owner at ${entry.file}`);
  }
  const readRowsOutsideOwner = definitions
    .filter(entry => entry.name === 'readRows' && !PUBLICATION_OWNER_FILE_LIST.includes(entry.file));
  for (const entry of readRowsOutsideOwner) {
    const callsCanonical = calls.some(call => call.file === entry.file && call.name === 'canonicalEvent');
    const definesCanonical = definitions.some(other => other.file === entry.file && other.name === 'canonicalEvent');
    if (callsCanonical || definesCanonical) {
      failures.push(`duplicated publication read path readRows -> canonicalEvent outside the owner at ${entry.file}`);
    }
  }
  if (!calls.some(call => call.file === PUBLICATION_DEFINITION_OWNERS.canonicalEvent && call.name === 'canonicalEvent')) {
    failures.push('canonicalEvent must be reached from the publication read path');
  }

  // 4. exact allowlist of receipt-prefix/constant and event-vocabulary consumers,
  // detected from the AST (comments ignored, literal concatenation folded).
  const receiptConsumerFailures = [];
  const eventConsumerFailures = [];
  for (const record of records) {
    const evidence = consumerEvidence.get(record.file);
    const isOwner = PUBLICATION_OWNER_FILE_LIST.includes(record.file);
    if (!isOwner) {
      if (evidence.symbols.has('TOWN_HALL_PUBLICATION_RECEIPTS')) {
        receiptConsumerFailures.push(`${record.file} references TOWN_HALL_PUBLICATION_RECEIPTS`);
      }
      if (evidence.prefixLines.length > 0) {
        receiptConsumerFailures.push(`${record.file}:${evidence.prefixLines.join(',')} builds/uses a publication receipt prefix`);
      }
      if (evidence.receiptDetailEventLines.length > 0) {
        receiptConsumerFailures.push(`${record.file}:${evidence.receiptDetailEventLines.join(',')} writes a publication receipt (state.receipt with publication prefix/event vocabulary)`);
      }
      if (evidence.symbols.has('TOWN_HALL_PUBLICATION_EVENTS')) {
        eventConsumerFailures.push(`${record.file} references TOWN_HALL_PUBLICATION_EVENTS`);
      }
    }
  }
  for (const failure of receiptConsumerFailures) {
    failures.push(`publication receipt constants may only be consumed by the four owner files: ${failure}`);
  }
  for (const failure of eventConsumerFailures) {
    failures.push(`publication event vocabulary may only be consumed by the five owner files: ${failure}`);
  }
  const receiptConsumers = records
    .filter(record => {
      const evidence = consumerEvidence.get(record.file);
      return evidence.symbols.has('TOWN_HALL_PUBLICATION_RECEIPTS') ||
        evidence.prefixLines.length > 0 ||
        evidence.receiptDetailEventLines.length > 0;
    })
    .map(record => record.file)
    .sort();
  try {
    assert.deepEqual(receiptConsumers, [...PUBLICATION_RECEIPT_CONSUMER_ALLOWLIST].sort(),
      'publication receipt constants may only be consumed by the four owner files');
  } catch (error) {
    failures.push(error.message);
  }
  const eventConsumers = records
    .filter(record => consumerEvidence.get(record.file).symbols.has('TOWN_HALL_PUBLICATION_EVENTS'))
    .map(record => record.file)
    .sort();
  try {
    assert.deepEqual(eventConsumers, [...PUBLICATION_EVENT_CONSUMER_ALLOWLIST].sort(),
      'publication event vocabulary may only be consumed by the five owner files');
  } catch (error) {
    failures.push(error.message);
  }
  for (const name of ['TOWN_HALL_PUBLICATION_RECEIPTS', 'TOWN_HALL_PUBLICATION_EVENTS']) {
    const declarations = variableDeclarations.filter(entry => entry.name === name);
    if (declarations.length !== 1 || declarations[0].file !== PUBLICATION_OWNER_FILES.types) {
      failures.push(`${name} must be declared exactly once in ${PUBLICATION_OWNER_FILES.types}, found ${declarations.map(d => d.file).join(', ') || 'none'}`);
    }
  }

  // 5. F3: no raw finite status/outcome literal survives in the owner repository
  // or projection; the finite sets come from the shared typed vocabularies.
  for (const file of [PUBLICATION_OWNER_FILES.repository, PUBLICATION_OWNER_FILES.projection]) {
    for (const literal of stringLiterals.filter(entry => entry.file === file)) {
      if (FINITE_PUBLICATION_VALUES.includes(literal.value)) {
        failures.push(`raw finite status/outcome literal ${JSON.stringify(literal.value)} at ${file}:${literal.line}`);
      }
    }
  }
  const initializerOf = (file, name) => {
    const declaration = variableDeclarations.find(entry => entry.file === file && entry.name === name);
    return declaration ? declaration.initializer : null;
  };
  const propertyRefsIn = node => {
    const refs = [];
    walkAst(node, child => {
      if (ts.isPropertyAccessExpression(child)) refs.push(child.getText(child.getSourceFile()));
    });
    return refs.sort();
  };
  const retryable = initializerOf(PUBLICATION_OWNER_FILES.projection, 'RETRYABLE_OUTCOMES');
  if (!retryable) {
    failures.push('RETRYABLE_OUTCOMES initializer not found in projection.ts');
  } else {
    try {
      assert.deepEqual(propertyRefsIn(retryable), [...RETRYABLE_OUTCOME_REFS].sort(),
        'RETRYABLE_OUTCOMES must be built from the shared typed vocabularies');
    } catch (error) {
      failures.push(error.message);
    }
  }
  const blocked = initializerOf(PUBLICATION_OWNER_FILES.repository, 'BLOCKED_RESERVE_STATUSES');
  if (!blocked) {
    failures.push('BLOCKED_RESERVE_STATUSES initializer not found in repository.ts');
  } else {
    try {
      assert.deepEqual(propertyRefsIn(blocked), [...BLOCKED_RESERVE_STATUS_REFS].sort(),
        'BLOCKED_RESERVE_STATUSES must be built from the shared typed vocabularies');
    } catch (error) {
      failures.push(error.message);
    }
  }
  for (const [key, label] of [['repository', 'repository.ts'], ['projection', 'projection.ts']]) {
    const record = recordsByFile.get(PUBLICATION_OWNER_FILES[key]);
    if (!record ||
        !record.text.includes('DIRECT_POST_OUTCOMES') ||
        !record.text.includes('DIRECT_POST_PART_STATUSES')) {
      failures.push(`${label} must consume DIRECT_POST_OUTCOMES and DIRECT_POST_PART_STATUSES`);
    }
  }
  if (!typesRecord || !/TownHallPublicationStatus\s*=\s*TownHallJournalState/.test(typesRecord.text)) {
    failures.push('types.ts must derive TownHallPublicationStatus from TownHallJournalState');
  }

  return failures;
}

module.exports = { PUBLICATION_DEFINITION_OWNERS, publicationSourceRoot, listProductionSourceFiles, parseProductionSources, walkAst, foldStringExpression, collectConsumerEvidence, analyzePublicationOwnership, PUBLICATION_OWNER_PREFIX, PUBLICATION_OWNER_FILES, PUBLICATION_OWNER_FILE_LIST, PUBLICATION_RECEIPT_CONSUMER_ALLOWLIST, PUBLICATION_EVENT_CONSUMER_ALLOWLIST, FINITE_PUBLICATION_VALUES, PUBLICATION_EVENT_VOCABULARY, PUBLICATION_PREFIX_LITERALS, APPEND_EVENT_CALL_COUNT, RETRYABLE_OUTCOME_REFS, BLOCKED_RESERVE_STATUS_REFS };
