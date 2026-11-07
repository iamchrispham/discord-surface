const test = require('node:test');
const assert = require('node:assert/strict');

const {
  discoverTempFactory,
  discoverTempFactoryFiles,
  source,
  discoverFactory
} = require('./owner-test-helpers');
const ts = require('typescript');

test('rejects asynchronous companion factories', () => {
  const asyncFactory = source.replace(
    'class SurfaceState {',
    `async function createFakeHandlers() { return createConfigurationHandlers({}); }
const fakeHandlers = createFakeHandlers();
class SurfaceState {`
  );
  const asyncExpression = source.replace(
    'class SurfaceState {',
    `const createFakeHandlers = async () => createConfigurationHandlers({});
const fakeHandlers = createFakeHandlers();
class SurfaceState {`
  );
  assert.equal(discoverFactory(ts.createSourceFile('async-factory.js', asyncFactory, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), 'createFakeHandlers').approved, false);
  assert.equal(discoverFactory(ts.createSourceFile('async-expression.js', asyncExpression, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), 'createFakeHandlers').approved, false);
});

test('rejects asynchronous imported companion factories', () => {
  const discovery = discoverTempFactory(`async function createFakeHandlers() { return { hidden(state, value) {} }; }
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects unexported imported companion factories', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() { return { hidden(state, value) {} }; }
module.exports = {};`);
  assert.equal(discovery.approved, false);
});

test('ignores nested export assignments', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() { return { hidden(state, value) {} }; }
module.exports = {};
function installFakeHandlers() { module.exports = { createFakeHandlers }; }`);
  assert.equal(discovery.approved, false);
});

test('rejects reassigned require receivers', () => {
  const discovery = discoverTempFactoryFiles({
    'helpers.js': `function hidden(state, value) { return value; }
module.exports = { hidden };`,
    'companion.js': `let helpers = require('./helpers');
helpers = {};
function createFakeHandlers() { return { hidden: helpers.hidden }; }
module.exports = { createFakeHandlers };`
  }, `const { createFakeHandlers } = require('./companion');
function createWrapper() { return createFakeHandlers({}); }
const fakeHandlers = createWrapper();
class SurfaceState {`);
  assert.equal(discovery.approved, false);
});

test('rejects require receivers reassigned from child scopes', () => {
  const discovery = discoverTempFactoryFiles({
    'helpers.js': `function hidden(state, value) { return value; }
module.exports = { hidden };`,
    'companion.js': `let helpers = require('./helpers');
if (disabled) { helpers = {}; }
function createFakeHandlers() { return { hidden: helpers.hidden }; }
module.exports = { createFakeHandlers };`
  }, `const { createFakeHandlers } = require('./companion');
function createWrapper() { return createFakeHandlers({}); }
const fakeHandlers = createWrapper();
class SurfaceState {`);
  assert.equal(discovery.approved, false);
});

test('accepts an unchanged callable binding before a write census', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  let hidden = (state, value) => value;
  return { hidden };
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, true);
});

test('rejects for-of writes to callable bindings', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  let hidden = (state, value) => value;
  for (hidden of [0]) {}
  return { hidden };
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('accepts an untouched destructured handler alias', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  const handlers = { hidden(state, value) {} };
  const [alias = handlers] = [];
  return handlers;
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, true);
});

test('rejects writes through a destructured default alias', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  const handlers = { hidden(state, value) {} };
  const [alias = handlers] = [];
  alias.hidden = 0;
  return handlers;
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('resolves require bindings from the lexical scope at the call site', () => {
  const discovery = discoverTempFactoryFiles({
    'companion.js': `function createFakeHandlers() { return { hidden(state, value) {} }; }
module.exports = { createFakeHandlers };`,
    'other.js': `function createFakeHandlers() { return {}; }
module.exports = { createFakeHandlers };`
  }, `const { createFakeHandlers } = require('./companion');
{
  const { createFakeHandlers } = require('./other');
}
function createWrapper() { return createFakeHandlers({}); }
const fakeHandlers = createWrapper();
class SurfaceState {`);
  assert.equal(discovery.approved, true);
  assert.equal(discovery.methods.has('hidden'), true);
});

test('rejects lexical-this arrow handlers', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  return { hidden: value => this.write(value) };
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects a labeled break that falls through a companion factory', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  outer: {
    if (disabled) break outer;
    return { hidden(state, value) {} };
  }
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('clears a factory removed by a later module export', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() { return { hidden(state, value) {} }; }
module.exports = { createFakeHandlers };
module.exports = {};`);
  assert.equal(discovery.approved, false);
});

test('ignores exports alias writes after replacing module exports', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() { return { hidden(state, value) {} }; }
module.exports = {};
exports.createFakeHandlers = createFakeHandlers;`);
  assert.equal(discovery.approved, false);
});

test('rejects a named import from a default module export', () => {
  const discovery = discoverTempFactoryFiles({
    'companion.js': `function createFakeHandlers() { return { hidden(state, value) {} }; }
module.exports = createFakeHandlers;`
  }, `const { createFakeHandlers } = require('./companion');
function createWrapper() { return createFakeHandlers({}); }
const fakeHandlers = createWrapper();
class SurfaceState {`);
  assert.equal(discovery.approved, false);
});

test('inventories the exported factory target', () => {
  const discovery = discoverTempFactoryFiles({
    'companion.js': `function createFakeHandlers() { return { hidden(state, value) {} }; }
function actualFactory() { return {}; }
module.exports = { createFakeHandlers: actualFactory };`
  }, `const { createFakeHandlers } = require('./companion');
function createWrapper() { return createFakeHandlers({}); }
const fakeHandlers = createWrapper();
class SurfaceState {`);
  assert.equal(discovery.approved, false);
});

test('rejects a helper overwritten after its named export', () => {
  const discovery = discoverTempFactoryFiles({
    'helpers.js': `function hidden(state, value) { return value; }
module.exports = { hidden };
module.exports.hidden = 0;`,
    'companion.js': `const helpers = require('./helpers');
function createFakeHandlers() { return { hidden: helpers.hidden }; }
module.exports = { createFakeHandlers };`
  }, `const { createFakeHandlers } = require('./companion');
function createWrapper() { return createFakeHandlers({}); }
const fakeHandlers = createWrapper();
class SurfaceState {`);
  assert.equal(discovery.approved, false);
});

test('records rest parameters on this-bound handlers', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  return { hidden(...values) { return this.write(...values); } };
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, true);
  assert.equal(discovery.methods.get('hidden').hasRestParameter, true);
});

test('rejects handlers that require both state and a receiver', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  return { hidden(state, value) { return this.write(value); } };
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});
