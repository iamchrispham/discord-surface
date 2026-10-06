const test = require('node:test');

const assert = require('node:assert/strict');

const fs = require('node:fs');

const path = require('node:path');

const ts = require('typescript');

const { compact, inventory, matches: matchesInventory } = require('./state-facade/inventory');

const { discoverFactory } = require('./state-facade/handler-discovery');

const baseline = require('./state-facade/baseline.json');

const source = fs.readFileSync(path.join(__dirname, '../src/state.js'), 'utf8');

function matches(text) { return matchesInventory(text, baseline); }

function baselineWith(text, methodName) {
  const candidate = compact(inventory(text));
  return {
    ...baseline,
    forwarding: [...baseline.forwarding, methodName].sort(),
    delegationBodies: { ...baseline.delegationBodies, [methodName]: candidate.delegationBodies[methodName] }
  };
}

function matchesWithAddedBaseline(text, methodName = 'newForward') {
  return matchesInventory(text, baselineWith(text, methodName));
}

function matchesWithCandidateBaseline(text) {
  return matchesInventory(text, compact(inventory(text)));
}

function baselineWithBody(text, methodName) {
  const candidate = compact(inventory(text));
  return {
    ...baseline,
    bodies: { ...baseline.bodies, [methodName]: candidate.bodies[methodName] }
  };
}

function matchesWithAddedBodyBaseline(text, methodName = 'newInline') {
  return matchesInventory(text, baselineWithBody(text, methodName));
}

function returnedHandlerSource(objectLiteral) {
  return source.replace(
    'class SurfaceState {',
    `function createFakeHandlers() { return ${objectLiteral}; }
const fakeHandlers = createFakeHandlers();
class SurfaceState {
newForward(value) { return fakeHandlers.hidden(this, value); }
`
  );
}

test('rejects asynchronous companion factories', () => {
  const asyncFactory = returnedHandlerSource('createConfigurationHandlers({})')
    .replace('function createFakeHandlers()', 'async function createFakeHandlers()');
  const asyncExpression = source.replace(
    'class SurfaceState {',
    `const createFakeHandlers = async () => createConfigurationHandlers({});
const fakeHandlers = createFakeHandlers();
class SurfaceState {`
  );
  assert.equal(discoverFactory(ts.createSourceFile('async-factory.js', asyncFactory, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), 'createFakeHandlers').approved, false);
  assert.equal(discoverFactory(ts.createSourceFile('async-expression.js', asyncExpression, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), 'createFakeHandlers').approved, false);
});

test('rejects companion factories with an implicit fallthrough', () => {
  const fallthroughFactory = source.replace(
    'class SurfaceState {',
    `function createFakeHandlers() { if (enabled) return createConfigurationHandlers({}); }
const fakeHandlers = createFakeHandlers();
class SurfaceState {`
  );
  assert.equal(discoverFactory(ts.createSourceFile('fallthrough-factory.js', fallthroughFactory, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), 'createFakeHandlers').approved, false);
});

test('accepts arguments-object call forwarding for this-bound handlers', () => {
  const candidate = insert('newForward(value) { return configurationHandlers.setConfig.call(this, ...arguments); }');
  assert.equal(matchesWithAddedBaseline(candidate), true);
});

const insert = body => source.replace('class SurfaceState {', `class SurfaceState {\n${body}\n`);

function alterBody(name) {
  const changed = source.replace(new RegExp(`(${name}\\([^]*?\\)\\s*\\{)`), '$1\nconst injected = 1;');
  assert.notEqual(changed, source, `${name} mutation must change source`);
  return changed;
}

function removeMethod(name) {
  const parsed = ts.createSourceFile('state.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const owner = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SurfaceState');
  const method = owner.members.find(node => node.name?.getText(parsed) === name);
  assert.ok(method, `removal mutation must find ${name}`);
  return source.slice(0, method.getStart(parsed)) + source.slice(method.end);
}

const methodAsiSource = ts.createSourceFile('state.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

const methodAsiOwner = methodAsiSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SurfaceState');

let methodAsiTarget;

for (const member of methodAsiOwner.members) {
  if (!member.name || !Object.hasOwn(baseline.bodies, member.name.getText(methodAsiSource))) continue;
  function findReturn(node) {
    if (!methodAsiTarget && ts.isReturnStatement(node) && node.expression?.kind === ts.SyntaxKind.NullKeyword) {
      methodAsiTarget = { member: member.name.getText(methodAsiSource), node };
    }
    ts.forEachChild(node, findReturn);
  }
  findReturn(member.body);
}

assert.ok(methodAsiTarget, 'retained class ASI control must locate actual null return');

const methodAsiStatement = methodAsiTarget.node;

const classAsiMutation = source.slice(0, methodAsiStatement.getStart(methodAsiSource)) + 'return\nnull;' + source.slice(methodAsiStatement.end);

assert.notEqual(classAsiMutation, source);

const asiMutation = source.replace('return null;', 'return\nnull;');

assert.notEqual(asiMutation, source, 'ASI mutation must change source');

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

test('existing delegate retarget refused', () => {
  assert.equal(!matches(source.replace('return configurationHandlers.getConfig.apply', 'return configurationHandlers.setConfig.apply')), true);
});

test('existing delegate removal refused', () => {
  assert.equal(!matches(removeMethod('getConfig')), true);
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

test('conditional factory branches must all resolve to a companion', () => {
  const text = source.replace(
    'class SurfaceState {',
    `function createFakeHandlers() {
  if (process.env.FAKE_HANDLER) return { hidden() {} };
  return createConfigurationHandlers({});
}
const fakeHandlers = createFakeHandlers();
class SurfaceState {
newForward(...args) { return fakeHandlers.getConfig.apply(this, args); }
`
  );
  assert.equal(matchesWithCandidateBaseline(text), false);
});

test('nested companion factories are resolved per return branch', () => {
  const text = source.replace(
    'class SurfaceState {',
    `function createNestedHandlers() { return createConfigurationHandlers({}); }
function createFakeHandlers() {
  if (process.env.FAKE_HANDLER) return createNestedHandlers();
  return createNestedHandlers();
}
const fakeHandlers = createFakeHandlers();
class SurfaceState {
newForward(...args) { return fakeHandlers.getConfig.apply(this, args); }
`
  );
  assert.equal(matchesWithCandidateBaseline(text), true);
});

test('returned bare factory function cannot approve a handler wrapper', () => {
  const text = source.replace(
    'class SurfaceState {',
    `function createFakeHandlers() { return createConfigurationHandlers; }
const fakeHandlers = createFakeHandlers();
class SurfaceState {
newForward(...args) { return fakeHandlers.getConfig.apply(this, args); }
`
  );
  assert.equal(matchesWithCandidateBaseline(text), false);
});

test('arbitrary call refused', () => {
  assert.equal(!matches(insert('newInline() { return arbitrary(this); }')), true);
});

test('SQL call refused', () => {
  assert.equal(!matches(insert("newInline() { return this.db.prepare('SELECT 1').all(); }")), true);
});

test('transformed argument refused', () => {
  assert.equal(!matches(insert("newInline(value) { return configurationHandlers.setConfig.apply(this, value + 'changed'); }")), true);
});

test('nested call refused', () => {
  assert.equal(!matches(insert('newInline(value) { return configurationHandlers.setConfig(this, transform(value)); }')), true);
});

test('new handler delegation requires baseline', () => {
  const text = insert('newForward(...args) { return configurationHandlers.getConfig.apply(this, args); }');
  assert.equal(matches(text), false);
});

test('new handler delegation is accepted when recorded in baseline', () => {
  const text = insert('newForward(...args) { return configurationHandlers.getConfig.apply(this, args); }');
  assert.equal(matchesWithAddedBaseline(text), true);
});

test('baseline cannot approve static delegation', () => {
  const text = insert('static newForward(...args) { return configurationHandlers.getConfig.apply(this, args); }');
  assert.equal(matchesWithAddedBaseline(text), false);
});

test('baseline cannot approve async delegation', () => {
  const text = insert('async newForward(...args) { return configurationHandlers.getConfig.apply(this, args); }');
  assert.equal(matchesWithAddedBaseline(text), false);
});

test('pure handler delegation is refused when recorded in baseline', () => {
  const text = insert('newForward(...args) { return conductorCustodyHandlers.transferDetail(this, ...args); }');
  assert.equal(matchesWithAddedBaseline(text), false);
});

test('lazy factory delegation accepted when recorded in baseline', () => {
  const text = insert('newForward(...args) { return schemaHandlers.createSchema.apply(this, args); }');
  assert.equal(matchesWithAddedBaseline(text), true);
});

test('composed factory delegation accepted when recorded in baseline', () => {
  const text = insert('newForward(...args) { return courierRouteHandlers.claimCourierForward(this, ...args); }');
  assert.equal(matchesWithAddedBaseline(text), true);
});

test('fixed delegation preserves optional handler parameters', () => {
  const text = insert('newForward() { return topicPublicationHandlers.listTopicPublications.call(this); }');
  assert.equal(matchesWithAddedBaseline(text), false);
});

test('fixed delegation accepts the full optional handler surface', () => {
  const text = insert('newForward(channelId) { return topicPublicationHandlers.listTopicPublications.call(this, channelId); }');
  assert.equal(matchesWithAddedBaseline(text), true);
});

test('direct state argument delegation accepted when recorded in baseline', () => {
  const text = insert('newForward(...args) { return provisionIntentHandlers.beginProvisionIntent(this, ...args); }');
  assert.equal(matchesWithAddedBaseline(text), true);
});

test('explicit-state handler rejects bound forwarding', () => {
  assert.equal(!matches(insert('newForward(...args) { return provisionIntentHandlers.beginProvisionIntent.apply(this, args); }')), true);
});

test('this-bound handler rejects explicit-state forwarding', () => {
  assert.equal(!matches(insert('newForward(...args) { return configurationHandlers.getConfig(this, ...args); }')), true);
});

test('non-callable shorthand cannot approve delegation', () => {
  assert.equal(!matches(insert('newForward(...args) { return conductorCustodyHandlers.CUSTODY_RECEIPT_KINDS.apply(this, args); }')), true);
});

test('proto method receives an own body fingerprint', () => {
  assert.equal(!matches(insert('__proto__() { return Date.now(); }')), true);
});

test('cooked method name collision refused', () => {
  assert.equal(!matches(insert('g\\u0065tConfig() { return configurationHandlers.getConfig(this); }')), true);
});

test('missing handler method refused', () => {
  assert.equal(!matches(insert('newForward(...args) { return configurationHandlers.noSuchMethod.apply(this, args); }')), true);
});

test('generator delegation refused', () => {
  assert.equal(!matches(insert('*newForward(...args) { return configurationHandlers.getConfig.apply(this, args); }')), true);
});

test('comment-only change accepted', () => {
  assert.equal(matches(source.replace('class SurfaceState {', 'class SurfaceState { /* harmless trivia */')), true);
});

test('changed retained body refused', () => {
  assert.equal(!matches(alterBody('directPostOwnerIdentity')), true);
});

test('changed constructor refused', () => {
  assert.equal(!matches(alterBody('constructor')), true);
});

test('optional delegation refused', () => {
  assert.equal(!matches(insert('newInline(...args) { return configurationHandlers?.getConfig(this, ...args); }')), true);
});
