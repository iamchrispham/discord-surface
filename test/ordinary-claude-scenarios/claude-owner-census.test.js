'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Claude owner structural census helpers (AST only: file + factory/class + method).
// ---------------------------------------------------------------------------

const CLAUDE_OWNER = 'src/state/ordinary-binding-claude.ts';
const CODEX_OWNER = 'src/state/ordinary-binding.ts';
const CLAUDE_FACTORY = 'createOrdinaryClaudeBindingHandlers';

const CLAUDE_HANDLER_METHODS = [
  'bindOrdinaryClaude',
  'rebindOrdinaryClaude',
  'isOrdinaryBindingRecord',
  'isOrdinaryBinding',
  'hasOrdinaryPreflight',
  'recordOrdinaryPreflight'
];

const FACADE_TO_HANDLER = {
  _bindOrdinaryClaude: 'bindOrdinaryClaude',
  _rebindOrdinaryClaude: 'rebindOrdinaryClaude',
  _isOrdinaryBindingRecord: 'isOrdinaryBindingRecord',
  _isOrdinaryBinding: 'isOrdinaryBinding',
  _hasOrdinaryPreflight: 'hasOrdinaryPreflight',
  _recordOrdinaryPreflight: 'recordOrdinaryPreflight'
};

const SQL_FREE_METHODS = [...Object.keys(FACADE_TO_HANDLER), ...CLAUDE_HANDLER_METHODS];

const RECEIPT_KINDS = new Set(['BOUND', 'NATIVE_PREFLIGHT']);

const EXPECTED_RECEIPT_SITES = [
  `${CODEX_OWNER}|hasOrdinaryBindingReceipt|ORDINARY_RECEIPT_KINDS.BOUND`,
  `${CODEX_OWNER}|hasOrdinaryPreflightReceipt|ORDINARY_RECEIPT_KINDS.NATIVE_PREFLIGHT`,
  `${CODEX_OWNER}|recordOrdinaryPreflight|ORDINARY_RECEIPT_KINDS.NATIVE_PREFLIGHT`,
  `${CODEX_OWNER}|handoffOrdinary|ORDINARY_RECEIPT_KINDS.BOUND`,
  'src/state/binding-lifecycle.js|bind|ORDINARY_RECEIPT_KINDS.BOUND',
  'src/state/binding-lifecycle.js|rebind|ORDINARY_RECEIPT_KINDS.BOUND',
  `${CLAUDE_OWNER}|recordOrdinaryPreflight|ORDINARY_RECEIPT_KINDS.NATIVE_PREFLIGHT`
];

const EXPECTED_HELPER_CALLS = [
  `${CODEX_OWNER}|rebindOrdinary|isOrdinaryBindingRecord`,
  `${CODEX_OWNER}|handoffOrdinary|isOrdinaryBindingRecord`,
  `${CODEX_OWNER}|isOrdinaryBindingRecord|hasOrdinaryBindingReceipt`,
  `${CODEX_OWNER}|isOrdinaryBinding|hasOrdinaryBindingReceipt`,
  `${CODEX_OWNER}|hasOrdinaryPreflight|hasOrdinaryPreflightReceipt`,
  `${CLAUDE_OWNER}|isOrdinaryBindingRecord|hasOrdinaryBindingReceipt`,
  `${CLAUDE_OWNER}|isOrdinaryBinding|isOrdinaryBindingRecord`,
  `${CLAUDE_OWNER}|hasOrdinaryPreflight|hasOrdinaryPreflightReceipt`,
  `${CLAUDE_OWNER}|rebindOrdinaryClaude|isOrdinaryBindingRecord`
];

function inventoryParser() {
  return require('typescript');
}

function sourceFiles(root) {
  const found = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|ts)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) found.push(full);
    }
  };
  walk(root);
  return found;
}

function relativeSourceFiles(workspaceRoot) {
  return sourceFiles(path.join(workspaceRoot, 'src')).map(file =>
    path.relative(workspaceRoot, file).split(path.sep).join('/')).sort();
}

function ownerOf(ts, node) {
  const isFunctionLike = n => ts.isArrowFunction(n) || ts.isFunctionExpression(n);
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name) return current.name.text;
    if (ts.isConstructorDeclaration(current)) return 'constructor';
    if (ts.isPropertyAssignment(current) && current.name && current.initializer && isFunctionLike(current.initializer)) {
      return current.name.getText();
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer &&
        isFunctionLike(current.initializer)) {
      return current.name.text;
    }
    current = current.parent;
  }
  return '<module>';
}

function unwrap(ts, expression) {
  let current = expression;
  while (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function calleeInfo(ts, call) {
  const expression = unwrap(ts, call.expression);
  if (ts.isPropertyAccessExpression(expression)) {
    return { receiver: expression.expression.getText(), method: expression.name.text };
  }
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
      return { receiver: expression.expression.getText(), method: argument.text };
    }
  }
  return null;
}

function parseEntry(ts, entry) {
  return ts.createSourceFile(entry.file, entry.text, ts.ScriptTarget.Latest, true,
    entry.file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
}

function findClass(ts, source, name) {
  let found = null;
  const visit = node => {
    if (ts.isClassDeclaration(node) && node.name && node.name.text === name) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function classMethods(ts, classNode) {
  return classNode.members.filter(member => ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name));
}

function walkNodes(ts, root, visit) {
  visit(root);
  ts.forEachChild(root, child => walkNodes(ts, child, visit));
}

function callsIn(ts, node) {
  const calls = [];
  walkNodes(ts, node, current => { if (ts.isCallExpression(current)) calls.push(current); });
  return calls;
}

function constantStringExpression(ts, expression) {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (!ts.isTemplateExpression(expression)) return null;
  let value = expression.head.text;
  for (const span of expression.templateSpans) {
    const interpolation = constantStringExpression(ts, span.expression);
    if (interpolation === null) return null;
    value += interpolation + span.literal.text;
  }
  return value;
}

function claudeFactoryMethods(ts, source) {
  let factory = null;
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === CLAUDE_FACTORY) factory = node;
    if (!factory) ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(factory, `${CLAUDE_FACTORY} must exist in ${CLAUDE_OWNER}`);
  let objectLiteral = null;
  walkNodes(ts, factory, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'handlers' &&
      node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      objectLiteral = node.initializer;
    }
  });
  assert.ok(objectLiteral, `the ${CLAUDE_FACTORY} handlers object literal must exist`);
  return objectLiteral.properties
    .filter(property => (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) &&
      property.name && ts.isIdentifier(property.name))
    .map(property => property.name.text);
}

function facadeClaudeCensus(ts, facade) {
  return classMethods(ts, facade).map(member => member.name.text).filter(name => name.includes('Claude')).sort();
}

function facadeDelegates(ts, facade) {
  const delegates = [];
  for (const member of classMethods(ts, facade)) {
    const owner = member.name.text;
    for (const call of callsIn(ts, member)) {
      const info = calleeInfo(ts, call);
      if (info && info.receiver === 'ordinaryClaudeBindingHandlers') {
        delegates.push(`${owner}->${info.method}`);
      }
    }
  }
  return delegates.sort();
}

function receiptSites(ts, entries) {
  const sites = [];
  for (const entry of entries) {
    const source = parseEntry(ts, entry);
    walkNodes(ts, source, node => {
      if (ts.isCallExpression(node)) {
        const info = calleeInfo(ts, node);
        const kind = node.arguments[1];
        const kindText = kind && constantStringExpression(ts, kind);
        if (info?.method === 'receipt' &&
          ['ordinary-bound', 'ordinary-native-preflight'].includes(kindText)) {
          sites.push(`${entry.file}|${ownerOf(ts, node)}|${info.receiver}.receipt|literal:${kindText}`);
        }
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === 'ORDINARY_RECEIPT_KINDS' && RECEIPT_KINDS.has(node.name.text)) {
        sites.push(`${entry.file}|${ownerOf(ts, node)}|ORDINARY_RECEIPT_KINDS.${node.name.text}`);
      }
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === 'ORDINARY_RECEIPT_KINDS' &&
        node.argumentExpression && ts.isStringLiteral(node.argumentExpression) &&
        RECEIPT_KINDS.has(node.argumentExpression.text)) {
        sites.push(`${entry.file}|${ownerOf(ts, node)}|ORDINARY_RECEIPT_KINDS['${node.argumentExpression.text}']`);
      }
    });
  }
  return sites.sort();
}

function helperCalls(ts, entries) {
  const calls = [];
  for (const entry of entries) {
    if (entry.file !== CLAUDE_OWNER && entry.file !== CODEX_OWNER) continue;
    const source = parseEntry(ts, entry);
    walkNodes(ts, source, node => {
      if (!ts.isCallExpression(node)) return;
      const expression = unwrap(ts, node.expression);
      let method = null;
      let receiver = null;
      if (ts.isIdentifier(expression)) method = expression.text;
      else {
        const info = calleeInfo(ts, node);
        if (info) { method = info.method; receiver = info.receiver; }
      }
      if (!method) return;
      const shared = method === 'hasOrdinaryBindingReceipt' || method === 'hasOrdinaryPreflightReceipt';
      const delegate = (method === 'isOrdinaryBindingRecord' || method === '_isOrdinaryBindingRecord') &&
        (receiver === 'handlers' || receiver === 'this' || receiver === 'state');
      if (shared || delegate) calls.push(`${entry.file}|${ownerOf(ts, node)}|${method.replace(/^_/, '')}`);
    });
  }
  return calls.sort();
}

function sqlFindings(ts, source, file, methodNames) {
  const findings = [];
  walkNodes(ts, source, current => {
    let text = null;
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) text = current.text;
    else if (ts.isTemplateExpression(current)) text = current.getText();
    if (text !== null && /receipts/.test(text) && /kind/.test(text) && methodNames.has(ownerOf(ts, current))) {
      findings.push(`${file}|${ownerOf(ts, current)}|receipt SQL literal`);
    }
    if (ts.isCallExpression(current)) {
      const info = calleeInfo(ts, current);
      if (info && info.method === 'prepare' && /(^|\.)db$/.test(info.receiver.replace(/\?\./g, '.')) &&
        methodNames.has(ownerOf(ts, current))) {
        findings.push(`${file}|${ownerOf(ts, current)}|db.prepare`);
      }
    }
  });
  return findings;
}

function renderClaudeInventory(ts, entries) {
  const claudeEntry = entries.find(entry => entry.file === CLAUDE_OWNER);
  const facadeEntry = entries.find(entry => entry.file === 'src/state.js');
  assert.ok(claudeEntry, `${CLAUDE_OWNER} must be scanned from source`);
  assert.ok(facadeEntry, 'src/state.js must be scanned from source');
  const claudeSource = parseEntry(ts, claudeEntry);
  const facade = findClass(ts, parseEntry(ts, facadeEntry), 'SurfaceState');
  assert.ok(facade, 'SurfaceState class must exist in src/state.js');
  const sqlMethods = new Set(SQL_FREE_METHODS);
  return {
    factoryMethods: claudeFactoryMethods(ts, claudeSource).sort(),
    claudeNames: facadeClaudeCensus(ts, facade),
    delegates: facadeDelegates(ts, facade),
    receiptSites: receiptSites(ts, entries),
    helperCalls: helperCalls(ts, entries),
    sqlFindings: [
      ...sqlFindings(ts, claudeSource, CLAUDE_OWNER, sqlMethods),
      ...sqlFindings(ts, parseEntry(ts, facadeEntry), 'src/state.js', sqlMethods)
    ]
  };
}

function realInventoryEntries(workspaceRoot) {
  return relativeSourceFiles(workspaceRoot).map(file => ({
    file,
    text: fs.readFileSync(path.join(workspaceRoot, file), 'utf8')
  }));
}

test('Claude binding owner inventory pins the factory dispatch, receipt census and SQL boundary', { timeout: 8000 }, () => {
  const ts = inventoryParser();
  const workspaceRoot = path.join(__dirname, '..', '..');
  const entries = realInventoryEntries(workspaceRoot);
  const real = renderClaudeInventory(ts, entries);

  assert.deepEqual(real.factoryMethods, CLAUDE_HANDLER_METHODS.slice().sort(),
    `${CLAUDE_FACTORY} must declare exactly the six Claude handler methods`);
  assert.deepEqual(real.claudeNames, ['_bindOrdinaryClaude', '_rebindOrdinaryClaude', 'bindOrdinaryClaude', 'rebindOrdinaryClaude'],
    'SurfaceState must retain exactly the four Claude-named methods');
  assert.equal(real.delegates.length, Object.keys(FACADE_TO_HANDLER).length,
    'exactly six facade delegates must reach ordinaryClaudeBindingHandlers');
  for (const [facade, handler] of Object.entries(FACADE_TO_HANDLER)) {
    assert.ok(real.delegates.includes(`${facade}->${handler}`),
      `${facade} must delegate to ordinaryClaudeBindingHandlers.${handler}`);
  }

  assert.deepEqual(real.receiptSites, EXPECTED_RECEIPT_SITES.slice().sort(),
    'the ordinary receipt-kind census must be exactly the seven production owners');
  assert.deepEqual(real.helperCalls, EXPECTED_HELPER_CALLS.slice().sort(),
    'shared receipt-helper and classification delegates must match exactly');
  assert.deepEqual(real.sqlFindings, [],
    'receipt SELECT SQL and db.prepare must stay out of the facade and Claude owner methods');

  for (const kindLiteral of ["'ordinary-native-preflight'", '`ordinary-native-preflight`']) {
    const rawWriterEntries = entries.map(entry => entry.file === 'src/state.js'
      ? { ...entry, text: entry.text.replace('_recordOrdinaryPreflight(binding, detail = {}) {',
        `_recordOrdinaryPreflight(binding, detail = {}) { this.receipt(null, ${kindLiteral}, detail);`) }
      : entry);
    const rawWriter = renderClaudeInventory(ts, rawWriterEntries);
    assert.equal(rawWriter.receiptSites.length, real.receiptSites.length + 1);
    assert.notDeepEqual(rawWriter.receiptSites, EXPECTED_RECEIPT_SITES.slice().sort());
  }

  // Mutant: a non-Claude-named duplicate writer using a constant template
  // expression must still be rejected by the receipt-site census.
  const interpolatedWriterMutantEntries = entries.map(entry => entry.file === 'src/state.js'
    ? {
      ...entry,
      text: entry.text.replace('_recordOrdinaryPreflight(binding, detail = {}) {',
        "recordOrdinaryPreflightCopy(binding, detail = {}) { this.receipt(null, `ordinary-native-${'preflight'}`, detail); }\n\n  _recordOrdinaryPreflight(binding, detail = {}) {")
    }
    : entry);
  const interpolatedWriterMutant = renderClaudeInventory(ts, interpolatedWriterMutantEntries);
  assert.equal(interpolatedWriterMutant.receiptSites.length, real.receiptSites.length + 1,
    'a constant interpolated receipt writer must be rejected by the inventory');
  assert.notDeepEqual(interpolatedWriterMutant.receiptSites, EXPECTED_RECEIPT_SITES.slice().sort());

  // Mutant: a non-Claude writer using computed vocabulary access must still be rejected.
  const computedWriterMutantEntries = entries.map(entry => entry.file === 'src/state.js'
    ? {
      ...entry,
      text: entry.text.replace('_recordOrdinaryPreflight(binding, detail = {}) {',
        "_extraReceiptWriter() { this.receipt(null, ORDINARY_RECEIPT_KINDS['NATIVE_PREFLIGHT'], {}); }\n\n  _recordOrdinaryPreflight(binding, detail = {}) {")
    }
    : entry);
  const computedWriterMutant = renderClaudeInventory(ts, computedWriterMutantEntries);
  assert.equal(computedWriterMutant.receiptSites.length, real.receiptSites.length + 1,
    'a computed vocabulary receipt writer must be rejected by the inventory');
  assert.notDeepEqual(computedWriterMutant.receiptSites, EXPECTED_RECEIPT_SITES.slice().sort());

  // Mutant: an in-memory copied private Claude preflight policy with a receipt write
  // must be rejected by the name census and the receipt-site census.
  const facadeEntry = entries.find(entry => entry.file === 'src/state.js');
  const facadeSource = parseEntry(ts, facadeEntry);
  const classNode = findClass(ts, facadeSource, 'SurfaceState');
  assert.ok(classNode, 'SurfaceState class must exist for the mutant injection');
  const injected = '\n  _privateClaudePreflightCopy(binding, detail = {}) {\n' +
    '    return this.transaction(() => {\n' +
    '      const current = this.getBinding(binding?.channelId);\n' +
    '      if (!bindingMatchesExpected(current, binding)) return null;\n' +
    '      if (!this._isOrdinaryBinding(current)) throw new BindingError(`binding is not an ordinary ${current?.provider || \'native\'} binding`);\n' +
    '      if (!detail || typeof detail !== \'object\' || typeof detail.file !== \'string\' || !path.isAbsolute(detail.file) ||\n' +
    '        detail.sessionId !== current.nativeId || detail.threadId !== current.nativeId || detail.workspace !== current.workspace) {\n' +
    '        throw new BindingError(`ordinary ${current.provider} native preflight proof does not match the binding`);\n' +
    '      }\n' +
    "      if (detail.harness !== 'claude-code' || detail.endpoint !== current.endpoint) {\n" +
    "        throw new BindingError('ordinary Claude native preflight proof does not match the binding');\n" +
    '      }\n' +
    "      this.receipt(null, ORDINARY_RECEIPT_KINDS.NATIVE_PREFLIGHT, { ...detail });\n" +
    '      return current;\n' +
    '    });\n' +
    '  }\n';
  const mutantText = facadeEntry.text.slice(0, classNode.end - 1) + injected + facadeEntry.text.slice(classNode.end - 1);
  assert.ok(mutantText.includes('_privateClaudePreflightCopy'), 'sanity: the injected mutant must be present');
  const mutantEntries = entries.map(entry => entry.file === 'src/state.js' ? { ...entry, text: mutantText } : entry);
  const mutant = renderClaudeInventory(ts, mutantEntries);
  assert.notDeepEqual(mutant.claudeNames, real.claudeNames,
    'an added Claude-named private policy copy must fail the method census');
  assert.equal(mutant.claudeNames.length, real.claudeNames.length + 1);
  assert.notDeepEqual(mutant.receiptSites, real.receiptSites,
    'an added NATIVE_PREFLIGHT receipt write must fail the receipt-site census');
  assert.equal(mutant.receiptSites.length, real.receiptSites.length + 1);

  // Restored control passes again.
  const restored = renderClaudeInventory(ts, entries);
  assert.deepEqual(restored, real, 'the restored source must pass the Claude inventory unchanged');
});
