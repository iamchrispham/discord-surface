const test = require('node:test');
const assert = require('node:assert/strict');

const {
  insert,
  matches,
  matchesWithAddedBaseline,
  matchesWithCandidateBaseline,
  source
} = require('./owner-test-helpers');

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
