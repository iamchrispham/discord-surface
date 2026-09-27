// Focused architectural contract for the interaction-state facade/owner split.
// Proves the public facade still exposes the exact original surface, that the
// four source owners retain their designated functions/interfaces/constants,
// and that the facade's error path for a missing build is unchanged. No
// production database, no network calls, no child processes, no timers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const ts = require(path.join(ROOT, 'node_modules/typescript'));

// The facade requires ../dist/state/interaction.js, so npm run build must precede.
const facade = require(path.join(ROOT, 'src/state/interaction.js'));
const constants = require(path.join(ROOT, 'dist/state/interaction/constants.js'));

const OWNER_FILES = {
  facade: 'src/state/interaction.ts',
  constants: 'src/state/interaction/constants.ts',
  contracts: 'src/state/interaction/contracts.ts',
  origin: 'src/state/interaction/origin.ts'
};
const FACADE_FUNCTIONS = ['createInteractionHandlers'];
const ORIGIN_FUNCTIONS = [
  'parseJson',
  'validText',
  'validDecisionText',
  'validOptionalText',
  'validDecisionBinding',
  'bindingMatchesExpected',
  'originDetail',
  'decisionOriginDetail',
  'latestOriginDetail',
  'latestOriginRecord',
  'latestDecisionNativeRecord',
  'materializedSource',
  'decisionOriginText',
  'decisionResultForMessage',
  'sameDecisionBinding',
  'sameDecisionInteraction',
  'validDecisionInput',
  'validInput'
];
const INTERFACES = [
  'SqlRow',
  'SqlStatement',
  'InteractionDatabase',
  'InteractionBinding',
  'InteractionMessage',
  'InteractionState',
  'InteractionTransportRecord',
  'InteractionInput',
  'InteractionAcceptance',
  'InteractionAcceptanceOptions'
];
const CONSTANTS = ['INTERACTION_ORIGIN', 'INTERACTION_TRANSPORT', 'INTERACTION_SOURCES'];
const PUBLIC_NAMES = ['INTERACTION_ORIGIN', 'INTERACTION_SOURCES', 'INTERACTION_TRANSPORT', 'createInteractionHandlers'];

function readSource(key) {
  return fs.readFileSync(path.join(ROOT, OWNER_FILES[key]), 'utf8');
}

function parse(key) {
  return ts.createSourceFile('owner.ts', readSource(key), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function functionNames(parsed) {
  return parsed.statements.filter(ts.isFunctionDeclaration).map(node => node.name.text).sort();
}

function interfaceNames(parsed) {
  return parsed.statements.filter(ts.isInterfaceDeclaration).map(node => node.name.text).sort();
}

function variableNames(parsed) {
  const names = [];
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) names.push(declaration.name.text);
    }
  }
  return names.sort();
}

function importSpecifiers(parsed) {
  return parsed.statements.filter(ts.isImportDeclaration).map(node => node.moduleSpecifier.text);
}

test('facade and owners preserve responsibilities and identities', { timeout: 8000 }, () => {
  // The facade's runtime surface is exactly the three constants plus the factory.
  assert.deepEqual(Object.keys(facade).sort(), PUBLIC_NAMES, 'public facade surface changed');
  assert.equal(typeof facade.createInteractionHandlers, 'function', 'facade factory is missing');
  for (const name of CONSTANTS) {
    assert.ok(Object.prototype.hasOwnProperty.call(constants, name), `constants owner is missing ${name}`);
    assert.equal(facade[name], constants[name], `facade.${name} is not the constants owner value`);
  }
  for (const name of ['InteractionMessage', 'InteractionInput', 'InteractionAcceptance', 'InteractionAcceptanceOptions']) {
    assert.equal(Object.prototype.hasOwnProperty.call(facade, name), false, `${name} must stay type-only on the facade`);
  }

  // Each known responsibility stays in its designated owner, while allowing
  // that owner to grow with legitimate local declarations.
  const ownerParses = Object.fromEntries(Object.keys(OWNER_FILES).map(key => [key, parse(key)]));
  const assertOwned = (name, owner, namesByOwner, kind) => {
    assert.ok(namesByOwner[owner].includes(name), `${kind} ${name} moved out of ${owner}`);
    for (const [key, names] of Object.entries(namesByOwner)) {
      if (key !== owner) {
        assert.equal(names.includes(name), false, `${kind} ${name} duplicated in ${key}`);
      }
    }
  };

  const functionsByOwner = Object.fromEntries(
    Object.entries(ownerParses).map(([key, parsed]) => [key, functionNames(parsed)]),
  );
  for (const name of FACADE_FUNCTIONS) assertOwned(name, 'facade', functionsByOwner, 'function');
  for (const name of ORIGIN_FUNCTIONS) assertOwned(name, 'origin', functionsByOwner, 'function');

  const interfacesByOwner = Object.fromEntries(
    Object.entries(ownerParses).map(([key, parsed]) => [key, interfaceNames(parsed)]),
  );
  for (const name of INTERFACES) assertOwned(name, 'contracts', interfacesByOwner, 'interface');

  const constantsByOwner = Object.fromEntries(
    Object.entries(ownerParses).map(([key, parsed]) => [key, variableNames(parsed)]),
  );
  for (const name of CONSTANTS) assertOwned(name, 'constants', constantsByOwner, 'constant');

  // Ownership remains explicit through distinct, non-empty owner paths.
  const ownerEntries = Object.entries(OWNER_FILES);
  assert.equal(
    new Set(ownerEntries.map(([, file]) => file)).size,
    ownerEntries.length,
    'owner paths must remain distinct',
  );
  for (const [key] of ownerEntries) {
    assert.notEqual(readSource(key).trim(), '', `${key} owner must contain source`);
  }

  // No companion may depend back on the facade at runtime or type level.
  for (const key of ['constants', 'contracts', 'origin']) {
    const text = readSource(key);
    assert.doesNotMatch(text, /from\s+['"]\.\.\/interaction(?:\.js)?['"]/, `${key} must not import the facade`);
    assert.doesNotMatch(text, /require\(['"]\.\.\/interaction(?:\.js)?['"]\)/, `${key} must not require the facade`);
  }

  // All decision vocabulary in origin resolves to the single decision owner.
  const originImports = importSpecifiers(parse('origin'));
  const decisionImports = originImports.filter(specifier => specifier.includes('decision'));
  assert.ok(decisionImports.length > 0, 'origin must import the decision vocabulary');
  for (const specifier of decisionImports) {
    assert.equal(specifier, '../decision/types', `decision vocabulary redirected: ${specifier}`);
  }
  for (const specifier of ['../decision/types', './constants', './contracts']) {
    assert.ok(originImports.includes(specifier), `origin must import ${specifier}`);
  }

  // Missing-build behavior: requiring the facade with the dist artifact absent
  // surfaces the dedicated build-missing error instead of a raw module error.
  const facadePath = path.join(ROOT, 'src/state/interaction.js');
  const wrapperRequest = '../../dist/state/interaction.js';
  const originalLoad = Module._load;
  try {
    Module._load = function (request) {
      if (request === wrapperRequest) {
        const missing = new Error(`Cannot find module '${wrapperRequest}'`);
        missing.code = 'MODULE_NOT_FOUND';
        throw missing;
      }
      return originalLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve(facadePath)];
    assert.throws(
      () => require(facadePath),
      /discord-surface interaction state build is missing; run npm run build before starting/,
      'facade must translate a missing build into the dedicated error'
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(facadePath)];
  }
});

test('handlers preserve callback write contract through the split', { timeout: 8000 }, () => {
  const handlers = facade.createInteractionHandlers();
  assert.deepEqual(Object.keys(handlers).sort(), [
    'acceptDecisionInteraction',
    'acceptInteraction',
    'beginCallback',
    'decisionResult',
    'isInteractionMessage',
    'recordCallbackOutcome',
    'recoverCallbacksInTransaction',
    'responseTarget'
  ], 'handler vocabulary changed');

  const beginSentinel = { messageId: '', started: true };
  const outcomeSentinel = { messageId: '', outcome: '' };
  function makeFakeState() {
    const calls = { begin: [], outcome: [] };
    return {
      beginSentinel,
      outcomeSentinel,
      calls,
      state: {
        beginTransportReceipt(messageId, options) {
          calls.begin.push({ messageId, options });
          return beginSentinel;
        },
        recordTransportReceiptOutcome(messageId, outcome, detail, transport) {
          calls.outcome.push({ messageId, outcome, detail, transport });
          return outcomeSentinel;
        }
      }
    };
  }

  const first = makeFakeState();
  assert.equal(handlers.beginCallback(first.state, 'interaction-1'), first.beginSentinel, 'beginCallback must return the receipt owner sentinel');
  assert.equal(first.calls.begin.length, 1, 'beginCallback must write exactly one attempt');
  assert.equal(first.calls.begin[0].messageId, 'interaction-1');
  assert.equal(first.calls.begin[0].options.transport, facade.INTERACTION_TRANSPORT);
  assert.equal(first.calls.begin[0].options.ownerPid, process.pid);
  assert.equal(first.calls.begin[0].options.ownerIdentity, null, 'absent identity hook must yield null');
  assert.deepEqual(Object.keys(first.calls.begin[0].options).sort(), ['ownerIdentity', 'ownerPid', 'transport']);

  const invalid = makeFakeState();
  assert.throws(() => handlers.beginCallback(invalid.state, ''), /messageId must be a non-empty string of at most 128 characters/);
  assert.equal(invalid.calls.begin.length, 0, 'invalid id must throw before any receipt write');

  const recorded = makeFakeState();
  assert.equal(handlers.recordCallbackOutcome(recorded.state, 'interaction-1', 'sent'), recorded.outcomeSentinel, 'recordCallbackOutcome must return the receipt owner sentinel');
  assert.equal(recorded.calls.outcome.length, 1, 'recordCallbackOutcome must write exactly one outcome');
  assert.equal(recorded.calls.outcome[0].messageId, 'interaction-1');
  assert.equal(recorded.calls.outcome[0].outcome, 'sent');
  assert.equal(recorded.calls.outcome[0].detail.transport, facade.INTERACTION_TRANSPORT, 'detail must carry the interaction transport');
  assert.equal(recorded.calls.outcome[0].transport, facade.INTERACTION_TRANSPORT, 'transport argument must carry the interaction transport');
  assert.deepEqual(Object.keys(recorded.calls.outcome[0].detail), ['transport']);

  const detailed = makeFakeState();
  handlers.recordCallbackOutcome(detailed.state, 'interaction-1', 'sent', { responseMessageId: 'response-1' });
  assert.equal(detailed.calls.outcome[0].detail.responseMessageId, 'response-1', 'supplied detail fields must be preserved');
  assert.equal(detailed.calls.outcome[0].detail.transport, facade.INTERACTION_TRANSPORT);
  assert.equal(detailed.calls.outcome[0].transport, facade.INTERACTION_TRANSPORT);
});
