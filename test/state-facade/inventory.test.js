const test = require('node:test');
const assert = require('node:assert/strict');

const {
  alterBody,
  asiMutation,
  classAsiMutation,
  insert,
  matches,
  matchesWithAddedBaseline,
  matchesWithAddedBodyBaseline,
  matchesWithCandidateBaseline,
  removeMethod,
  returnedHandlerSource,
  source
} = require('./owner-test-helpers');

test('retained method return line break refused', () => {
  assert.equal(!matches(classAsiMutation), true);
});

test('return line break refused', () => {
  assert.equal(!matches(asiMutation), true);
});

test('class heritage change refused', () => {
  assert.equal(!matches(source.replace('class SurfaceState {', 'class SurfaceState extends unownedBase {')), true);
});

test('retained parameter initializer refused', () => {
  assert.equal(!matches(source.replace('directPostOwnerIdentity(pid)', 'directPostOwnerIdentity(pid = Date.now())')), true);
});

test('changed top-level behavior refused', () => {
  assert.equal(!matches(source.replace('class SurfaceState {', 'const unowned = Date.now();\nclass SurfaceState {')), true);
});

test('existing factory initializer change refused', () => {
  assert.equal(!matches(source.replace('const configurationHandlers = createConfigurationHandlers(', 'const configurationHandlers = createFakeHandlers(')), true);
});

test('reassigned handler singleton refused', () => {
  const text = source
    .replace('const configurationHandlers = createConfigurationHandlers(', 'let configurationHandlers = createConfigurationHandlers(')
    .replace('const ordinaryBindingHandlers = createOrdinaryBindingHandlers({', 'configurationHandlers = {};\nconst ordinaryBindingHandlers = createOrdinaryBindingHandlers({');
  assert.equal(!matches(text), true);
});

test('existing delegate retarget refused', () => {
  assert.equal(!matches(source.replace('return configurationHandlers.getConfig.apply', 'return configurationHandlers.setConfig.apply')), true);
});

test('existing delegate removal refused', () => {
  assert.equal(!matches(removeMethod('getConfig')), true);
});

test('existing forwarding delegate removal refused', () => {
  assert.equal(!matches(removeMethod('acceptInteraction')), true);
});

test('candidate baseline cannot remove a required public delegate', () => {
  assert.equal(matchesWithCandidateBaseline(removeMethod('getConfig')), false);
});

test('swapped arguments refused', () => {
  assert.equal(!matches(insert('newForward(a, b) { return configurationHandlers.setConfig.call(this, b, a); }')), true);
});

test('omitted argument refused', () => {
  assert.equal(!matches(insert('newForward(a, b) { return configurationHandlers.setConfig.call(this, a); }')), true);
});

test('optional call marker refused', () => {
  assert.equal(!matches(insert('newForward(...args) { return configurationHandlers.getConfig?.call(this, args); }')), true);
});

test('optional apply marker refused', () => {
  assert.equal(!matches(insert('newForward(...args) { return configurationHandlers.getConfig?.apply(this, args); }')), true);
});

test('ordered call accepted when recorded in baseline', () => {
  const text = insert('newForward(a, b) { return configurationHandlers.setConfig.call(this, a, b); }');
  assert.equal(matchesWithAddedBaseline(text), true);
});

test('rest call accepted when recorded in baseline', () => {
  const text = insert('newForward(...args) { return configurationHandlers.setConfig.call(this, ...args); }');
  assert.equal(matchesWithAddedBaseline(text), true);
});

test('fixed delegate cannot omit required handler arguments', () => {
  const thisBound = insert('newForward() { return configurationHandlers.setConfig.call(this); }');
  const stateBound = insert('newForward() { return provisionIntentHandlers.beginProvisionIntent(this); }');
  assert.equal(matchesWithAddedBaseline(thisBound), false);
  assert.equal(matchesWithAddedBaseline(stateBound), false);
});

test('parameter initializer refused', () => {
  assert.equal(!matches(insert('newForward(a = Date.now()) { return configurationHandlers.setConfig.call(this, a); }')), true);
});

test('static delegate refused', () => {
  assert.equal(!matches(insert('static newForward(...args) { return configurationHandlers.getConfig.apply(this, args); }')), true);
});

test('new handler cannot approve itself', () => {
  assert.equal(!matches(insert('newInline() { return fakeHandlers.getConfig(this); }').replace('class SurfaceState {', 'const fakeHandlers = createFakeHandlers();\nclass SurfaceState {')), true);
});

test('shadowed handler refused', () => {
  assert.equal(!matches(insert('newInline(configurationHandlers) { return configurationHandlers.getConfig(this); }')), true);
});

test('destructured shadow refused', () => {
  assert.equal(!matches(insert('newInline({configurationHandlers}) { return configurationHandlers.getConfig(this); }')), true);
});

test('new getter refused', () => {
  assert.equal(!matches(insert('get newInline() { return Date.now(); }')), true);
});

test('new field refused', () => {
  assert.equal(!matches(insert('newInline = Date.now();')), true);
});

test('computed method refused', () => {
  assert.equal(!matches(insert("['getConfig'](...args) { return configurationHandlers.getConfig.apply(this, args); }")), true);
});

test('baseline accepted', () => {
  assert.equal(matches(source), true);
});

test('recognizes string and numeric keys while preserving the exported owner', () => {
  const stringKey = source.replace(
    /(module\.exports\s*=\s*\{[\s\S]*?)\bSurfaceState(?=\s*[,}])/, '$1"SurfaceState": SurfaceState');
  assert.equal(matchesWithCandidateBaseline(stringKey), true);
  const numericKey = source.replace('module.exports = {', 'module.exports = { 1: null,');
  assert.equal(matchesWithCandidateBaseline(numericKey), true);
});

test('keeps the actual owner when an earlier export key names another constructor', () => {
  const text = source.replace('module.exports = {', 'class ActualState { constructor() {} }\nmodule.exports = { SurfaceState: ActualState,');
  assert.equal(matchesWithCandidateBaseline(text), true);
});

test('rejects the constructor at the effective final export key', () => {
  const candidate = source.replace('module.exports = {', 'class ActualState { constructor() {} }\nmodule.exports = {');
  const text = candidate.replace(/(module\.exports\s*=\s*\{[\s\S]*?)(\n\s*};)/, (match, properties, close) =>
    `${properties}${properties.trimEnd().endsWith(',') ? '' : ','}\n  SurfaceState: ActualState${close}`);
  assert.equal(matchesWithCandidateBaseline(text), false);
});

test('rejects bare and parenthesized exported constructor escapes', () => {
  for (const argument of ['SurfaceState', '(SurfaceState)']) {
    const text = source.replace('class SurfaceState {',
      `function remove(value) {}\nclass SurfaceState {`).replace(
      'module.exports = {', `remove(${argument});\nmodule.exports = {`);
    assert.equal(matchesWithCandidateBaseline(text), false, argument);
  }
});

test('keeps protected parameter defaults fixed after body reclassification', () => {
  const text = source.replace(/(_bindOrdinaryClaude\([^)]*\)\s*\{)/, signature =>
    `${signature.replace(/\s*=\s*[^,)]+/g, '')}\n  const retained = true;`);
  assert.equal(matchesWithCandidateBaseline(text), false);
});

test('rejects a reassigned exported owner binding', () => {
  const text = source.replace('module.exports = {', 'SurfaceState = class {}\nmodule.exports = {');
  assert.equal(matches(text), false);
});

test('new inline body refused', () => {
  assert.equal(!matches(insert('newInline() { const value = Date.now(); return value; }')), true);
});

test('new inline body cannot be approved by extending the baseline', () => {
  const text = insert('newInline() { return Date.now(); }');
  assert.equal(matchesWithAddedBodyBaseline(text), false);
});

test('noncallable direct returned handler overwrite refused', () => {
  const text = returnedHandlerSource('{ hidden(state, value) {}, hidden: 0 }');
  assert.equal(matchesWithCandidateBaseline(text), false);
});

test('noncallable spread returned handler overwrite refused', () => {
  const text = returnedHandlerSource('{ hidden(state, value) {}, ...{ hidden: 0 } }');
  assert.equal(matchesWithCandidateBaseline(text), false);
});

test('inline factory cannot approve callable returned handler override', () => {
  const text = returnedHandlerSource('{ hidden: 0, hidden(state, value) {} }');
  assert.equal(matchesWithCandidateBaseline(text), false);
});

test('comment-only change accepted', () => {
  assert.equal(matches(source.replace('class SurfaceState {', 'class SurfaceState { /* harmless trivia */')), true);
});

test('changed retained body refused', () => {
  assert.equal(!matches(alterBody('directPostOwnerIdentity')), true);
});

test('removed retained method refused', () => {
  assert.equal(!matches(removeMethod('directPostOwnerIdentity')), true);
});

test('changed constructor refused', () => {
  assert.equal(!matches(alterBody('constructor')), true);
});

test('optional delegation refused', () => {
  assert.equal(!matches(insert('newInline(...args) { return configurationHandlers?.getConfig(this, ...args); }')), true);
});

test('rejects a stale exports alias after replacing module exports', () => {
  const exportStart = source.lastIndexOf('module.exports =');
  const text = source.slice(0, exportStart) + `module.exports = { Other: true };
exports.SurfaceState = SurfaceState;
`;
  assert.equal(matchesWithCandidateBaseline(text), false);
});

test('rejects non-assignment export mutations', () => {
  for (const mutation of [
    'delete module.exports.SurfaceState;',
    "Object.defineProperty(module.exports, 'SurfaceState', { value: class {} });"
  ]) {
    assert.equal(matchesWithCandidateBaseline(`${source}\n${mutation}`), false);
  }
});

test('rejects exported owner prototype mutations', () => {
  for (const mutation of [
    'delete SurfaceState.prototype.getConfig;',
    'SurfaceState.prototype.getConfig = () => null;'
  ]) {
    assert.equal(matchesWithCandidateBaseline(`${source}\n${mutation}`), false);
  }
});

test('rejects exported owner prototype mutations through aliases', () => {
  const text = `${source}
const proto = SurfaceState.prototype;
delete proto.getConfig;`;
  assert.equal(matchesWithCandidateBaseline(text), false);
});

test('rejects an exported constructor passed to a mutating helper with a candidate baseline', () => {
  const text = `${source}
function remove(C) { delete C.prototype.getConfig; }
remove(SurfaceState);`;
  assert.equal(matchesWithCandidateBaseline(text), false);
});

test('requires the recorded defaults on protected forwarding signatures', () => {
  for (const name of ['_bindOrdinary', '_bindOrdinaryClaude']) {
    const original = `${name}(binding, identity, adoptionCutoff = null, options = {})`;
    const replacement = `${name}(binding, identity, adoptionCutoff, options)`;
    const text = source.replace(original, replacement);
    assert.notEqual(text, source, `fixture signature for ${name}`);
    assert.equal(matchesWithCandidateBaseline(text), false, name);
  }
});

test('resolves owner exports in property order and rejects ambiguous later writes', () => {
  const exportStart = source.lastIndexOf('module.exports = {');
  const ownerEntry = source.indexOf('SurfaceState', exportStart);
  const ownerEntryEnd = source.indexOf(',', ownerEntry) + 1;
  assert.ok(exportStart >= 0 && ownerEntry > exportStart && ownerEntryEnd > ownerEntry);
  const withSpread = value => source.slice(0, ownerEntryEnd) +
    `\n  ...{ ${value} },` + source.slice(ownerEntryEnd);

  assert.equal(matchesWithCandidateBaseline(withSpread('OtherSurface: null')), true);
  assert.equal(matchesWithCandidateBaseline(withSpread('SurfaceState: null')), false);
});

test('rejects unresolved computed writes to the exported owner with a candidate baseline', () => {
  const text = `${source}
const key = 'SurfaceState';
module.exports[key] = class {};`;
  assert.equal(matchesWithCandidateBaseline(text), false);
});

test('rejects computed, assigned, destructured, and shadowed prototype escapes', () => {
  for (const mutation of [
    "const proto = SurfaceState['prototype'];\nproto.getConfig = () => null;",
    'let proto;\nproto = SurfaceState.prototype;\nproto.getConfig = () => null;',
    'const { prototype: proto } = SurfaceState;\nproto.getConfig = () => null;',
    'const proto = SurfaceState.prototype;\nfunction shadow() { const proto = {}; }\nproto.getConfig = () => null;'
  ]) {
    assert.equal(matchesWithCandidateBaseline(`${source}\n${mutation}`), false);
  }
});
