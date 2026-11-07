const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ts = require('typescript');

const {
  compact,
  discoverFactory,
  discoverTempFactory,
  discoverTempFactoryFiles,
  insert,
  matchesWithAddedBaseline,
  matchesWithCandidateBaseline,
  source,
  inventory
} = require('./owner-test-helpers');
const { matches: matchesInventory } = require('./inventory');

test('rejects imported companion factories with reassigned callable identifiers', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  let hidden = (state, value) => value;
  hidden = 0;
  return { hidden };
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects callable bindings reassigned at module scope', () => {
  const discovery = discoverTempFactory(`let hidden = (state, value) => value;
hidden = 0;
function createFakeHandlers() { return { hidden }; }
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects imported companion factories with function-scoped var overwrites', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  var hidden = (state, value) => value;
  { var hidden = 0; }
  return { hidden };
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('resolves hoisted local bindings before outer callables', () => {
  const discovery = discoverTempFactory(`const hidden = (state, value) => value;
function createFakeHandlers() {
  return { hidden };
  var hidden = 0;
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects imported companion factories with aliased object mutations', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  const handlers = { hidden(state, value) {} };
  const alias = handlers;
  alias.hidden = 0;
  return handlers;
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

function withTempCompanion(companionSource, callback) {
  const root = fs.mkdtempSync(path.join(__dirname, 'discord-surface-inventory-'));
  const ownerPath = path.resolve(__dirname, '../../src/state.js');
  const modulePath = path.join(root, 'factories.js');
  const requirePath = path.relative(path.dirname(ownerPath), modulePath).split(path.sep).join('/');
  try {
    fs.writeFileSync(modulePath, companionSource);
    return callback({ ownerPath, requirePath, writeCompanion: text => fs.writeFileSync(modulePath, text) });
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('keeps imported factory receivers only while their properties remain unchanged', () => {
  withTempCompanion(`function createInner() { return { hidden(state, value) {} }; }
module.exports = { createInner };`, ({ requirePath }) => {
    const positive = source.replace('class SurfaceState {', `const factories = require(${JSON.stringify(requirePath)});
function createFakeHandlers() { return factories.createInner(); }
const fakeHandlers = createFakeHandlers();
class SurfaceState {`);
    assert.equal(matchesWithCandidateBaseline(positive), true);
    for (const mutation of [
      'factories.createInner = () => ({});',
      "factories['createInner'] = () => ({});",
      'delete factories.createInner;',
      "delete factories['createInner'];"
    ]) {
      const text = positive.replace('function createFakeHandlers()', `${mutation}\nfunction createFakeHandlers()`);
      assert.equal(matchesWithCandidateBaseline(text), false, mutation);
    }
  });
});

test('rejects calls through a reassigned CommonJS loader with a candidate baseline', () => {
  withTempCompanion(`function createInner() { return { hidden(state, value) {} }; }
module.exports = { createInner };`, ({ requirePath }) => {
    const text = source.replace('class SurfaceState {', `require = () => ({ createInner() { return {}; } });
const factories = require(${JSON.stringify(requirePath)});
function createFakeHandlers() { return factories.createInner(); }
const fakeHandlers = createFakeHandlers();
class SurfaceState {`);
    assert.equal(matchesWithCandidateBaseline(text), false);
  });
});

test('accepts only a wrapper forwarding its own rest parameter', () => {
  withTempCompanion(`function createInner() { return { hidden(state, value) {} }; }
module.exports = { createInner };`, ({ requirePath }) => {
    const prefix = `const createFakeHandlers = (...args) => require(${JSON.stringify(requirePath)}).createInner(...args);
const fakeHandlers = createFakeHandlers();
`;
    const positive = source.replace('class SurfaceState {', `${prefix}class SurfaceState {`);
    assert.equal(matchesWithCandidateBaseline(positive), true);
    const text = positive.replace('createInner(...args)', 'createInner(...otherArgs)');
    assert.equal(matchesWithCandidateBaseline(text), false);
  });
});

test('validates arguments to the registered handler initializer', () => {
  withTempCompanion(`function createInner() { return { hidden(state, value) {} }; }
function createFakeHandlers() { return createInner({}); }
module.exports = { createFakeHandlers };`, ({ requirePath }) => {
    const positive = source.replace('class SurfaceState {', `const { createFakeHandlers } = require(${JSON.stringify(requirePath)});
const fakeHandlers = createFakeHandlers({});
class SurfaceState {`);
    assert.equal(matchesWithCandidateBaseline(positive), true);
    const unresolved = positive.replace('createFakeHandlers({})', 'createFakeHandlers(missingDependency)');
    assert.equal(matchesWithCandidateBaseline(unresolved), false);
  });
});

test('preserves production handler dependencies by shorthand and explicit reference', () => {
  assert.equal(matchesWithCandidateBaseline(source), true);
  const explicit = source.replace(
    'createMessageRecoveryHandlers({ boardRefreshHandlers,',
    'createMessageRecoveryHandlers({ boardRefreshHandlers: boardRefreshHandlers,');
  assert.notEqual(explicit, source);
  assert.equal(matchesWithCandidateBaseline(explicit), true);

  const reassigned = source.replace(
    'const boardRefreshHandlers = createBoardRefreshHandlers();',
    'let boardRefreshHandlers = createBoardRefreshHandlers();\nboardRefreshHandlers = {};');
  assert.notEqual(reassigned, source);
  assert.equal(matchesWithCandidateBaseline(reassigned), false);
});

test('rejects comma expressions in returned factory callees', () => {
  withTempCompanion(`function createInner() { return { hidden(state, value) {} }; }
function createFakeHandlers() { return createInner({}); }
module.exports = { createFakeHandlers };`, ({ requirePath, writeCompanion }) => {
    const positive = source.replace('class SurfaceState {', `const { createFakeHandlers } = require(${JSON.stringify(requirePath)});
const fakeHandlers = createFakeHandlers();
class SurfaceState {`);
    assert.equal(matchesWithCandidateBaseline(positive), true);
    writeCompanion(`function createInner() { return { hidden(state, value) {} }; }
function createFakeHandlers() { return (missingDependency, createInner)({}); }
module.exports = { createFakeHandlers };`);
    assert.equal(matchesWithCandidateBaseline(positive), false);
  });
});

test('does not inventory a factory referenced without calling it', () => {
  withTempCompanion(`function createInner() { return { hidden(state, value) {} }; }
function createFakeHandlers() { return createInner(); }
module.exports = { createFakeHandlers };`, ({ requirePath, writeCompanion }) => {
    const positive = source.replace('class SurfaceState {', `const { createFakeHandlers } = require(${JSON.stringify(requirePath)});
const fakeHandlers = createFakeHandlers();
class SurfaceState {`);
    assert.equal(matchesWithCandidateBaseline(positive), true);
    writeCompanion(`function createInner() { return { hidden(state, value) {} }; }
function createFakeHandlers() { return createInner; }
module.exports = { createFakeHandlers };`);
    assert.equal(matchesWithCandidateBaseline(positive), false);
  });
});

test('rejects descriptor mutations of returned handlers', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  const handlers = { hidden(state, value) {} };
  Object.defineProperty(handlers, 'hidden', { value: 0 });
  return handlers;
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects array destructuring writes to callable bindings', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  let hidden = (state, value) => value;
  [hidden] = [0];
  return { hidden };
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects object destructuring writes to callable bindings', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  let hidden = (state, value) => value;
  ({ hidden } = { hidden: 0 });
  return { hidden };
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects destructured property writes to returned handlers', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  const handlers = { hidden(state, value) {} };
  [handlers.hidden] = [0];
  return handlers;
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects mutations through destructured handler aliases', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  const handlers = { hidden(state, value) {} };
  const [alias] = [handlers];
  alias.hidden = 0;
  return handlers;
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects handler objects mutated by local helpers', () => {
  const discovery = discoverTempFactory(`function rewriteHandlers(handlers) {
  handlers.hidden = 0;
}
function createFakeHandlers() {
  const handlers = { hidden(state, value) {} };
  rewriteHandlers(handlers);
  return handlers;
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('propagates returned aliases from simple local helpers before mutation checks', () => {
  withTempCompanion(`function identity(value) { return value; }
function createFakeHandlers() {
  const handlers = { hidden(state, value) {} };
  const alias = identity(handlers);
  return handlers;
}
module.exports = { createFakeHandlers };`, ({ requirePath, writeCompanion }) => {
    const positive = source.replace('class SurfaceState {', `const { createFakeHandlers } = require(${JSON.stringify(requirePath)});
const fakeHandlers = createFakeHandlers();
class SurfaceState {`);
    assert.equal(matchesWithCandidateBaseline(positive), true);
    writeCompanion(`function identity(value) { return value; }
function createFakeHandlers() {
  const handlers = { hidden(state, value) {} };
  const alias = identity(handlers);
  alias.hidden = 0;
  return handlers;
}
module.exports = { createFakeHandlers };`);
    assert.equal(matchesWithCandidateBaseline(positive), false);
  });
});

test('rejects Reflect.set mutations of returned handlers with a candidate baseline', () => {
  withTempCompanion(`function createFakeHandlers() {
  const handlers = { hidden(state, value) {} };
  return handlers;
}
module.exports = { createFakeHandlers };`, ({ requirePath, writeCompanion }) => {
    const positive = source.replace('class SurfaceState {', `const { createFakeHandlers } = require(${JSON.stringify(requirePath)});
const fakeHandlers = createFakeHandlers();
class SurfaceState {`);
    assert.equal(matchesWithCandidateBaseline(positive), true);
    writeCompanion(`function createFakeHandlers() {
  const handlers = { hidden(state, value) {} };
  Reflect.set(handlers, 'hidden', 0);
  return handlers;
}
module.exports = { createFakeHandlers };`);
    assert.equal(matchesWithCandidateBaseline(positive), false);
  });
});

test('rejects generator companion factories', () => {
  const discovery = discoverTempFactory(`function* createFakeHandlers() {
  return { hidden(state, value) {} };
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects asynchronous and generator handler callables', () => {
  for (const method of [
    'hidden: async (state, value) => value',
    '*hidden(state, value) { return value; }'
  ]) {
    const text = source.replace(
      'class SurfaceState {',
      `function createFakeHandlers() { return { ${method} }; }
const fakeHandlers = createFakeHandlers();
class SurfaceState {
newForward(...args) { return fakeHandlers.hidden.apply(this, args); }
`
    );
    assert.equal(matchesWithCandidateBaseline(text), false);
  }
});

test('rejects reassigned exported factory bindings', () => {
  const discovery = discoverTempFactory(`let createFakeHandlers = () => ({ hidden(state, value) {} });
createFakeHandlers = () => ({});
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects factory branches with different state positions', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  if (enabled) return { hidden(state, value) {} };
  return { hidden(deps, state, value) {} };
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects shadowed arguments-object forwarding', () => {
  const text = insert('newForward(arguments) { return configurationHandlers.setConfig.call(this, ...arguments); }');
  assert.equal(matchesWithAddedBaseline(text), false);
});

test('keeps the first export-star factory owner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-export-star-'));
  try {
    fs.writeFileSync(path.join(root, 'first.js'), `function createFakeHandlers() { return {}; }
module.exports = { createFakeHandlers };`);
    fs.writeFileSync(path.join(root, 'second.js'), `function createFakeHandlers() { return { hidden(state, value) {} }; }
module.exports = { createFakeHandlers };`);
    fs.writeFileSync(path.join(root, 'companion.js'), `__exportStar(require('./first'), exports);
__exportStar(require('./second'), exports);`);
    const ownerPath = path.join(root, 'owner.js');
    const ownerSource = ts.createSourceFile(ownerPath, `const { createFakeHandlers } = require('./companion');
function createWrapper() { return createFakeHandlers({}); }
const fakeHandlers = createWrapper();
class SurfaceState {`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(discoverFactory(ownerSource, 'createWrapper').approved, false);
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keeps later unbound state parameters marked unsafe', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  return { hidden(deps, state, value) {} };
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, true);
  assert.equal(discovery.methods.get('hidden').stateParameterIndex, 1);
});

test('rejects facade forwarding to an unbound later-state handler', () => {
  withTempCompanion('', ({ ownerPath, requirePath, writeCompanion }) => {
    const text = source.replace(
      'class SurfaceState {',
      `const { createFakeHandlers } = require(${JSON.stringify(requirePath)});
const fakeHandlers = createFakeHandlers();
class SurfaceState {
newForward(deps, value) { return fakeHandlers.hidden(this, deps, value); }
`
    );
    const writeFactory = parameters => writeCompanion(`function createFakeHandlers() {
  return { hidden(${parameters}) {} };
}
module.exports = { createFakeHandlers };`);

    writeFactory('state, deps, value');
    const positiveCandidate = compact(inventory(text, ownerPath));
    assert.equal(matchesInventory(text, positiveCandidate, ownerPath), true);

    writeFactory('deps, state, value');
    const laterStateCandidate = compact(inventory(text, ownerPath));
    assert.equal(matchesInventory(text, laterStateCandidate, ownerPath), false);
  });
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

test('rejects switch breaks that fall through the factory', () => {
  const switchBreak = source.replace(
    'class SurfaceState {',
    `function createFakeHandlers() {
  switch (enabled) {
    case true: break;
    default: return createConfigurationHandlers({});
  }
}
const fakeHandlers = createFakeHandlers();
class SurfaceState {`
  );
  assert.equal(discoverFactory(ts.createSourceFile('switch-break-factory.js', switchBreak, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), 'createFakeHandlers').approved, false);
});

test('accepts arguments-object call forwarding for this-bound handlers', () => {
  const candidate = insert('newForward(value) { return configurationHandlers.setConfig.call(this, ...arguments); }');
  assert.equal(matchesWithAddedBaseline(candidate), true);
});

test('rejects receiver factories shadowed inside the factory scope', () => {
  const discovery = discoverTempFactoryFiles({
    'helpers.js': `function createInner() { return { hidden(state, value) {} }; }
module.exports = { createInner };`,
    'companion.js': `const helpers = require('./helpers');
function createFakeHandlers() {
  const helpers = {};
  return helpers.createInner();
}
module.exports = { createFakeHandlers };`
  }, `const { createFakeHandlers } = require('./companion');
function createWrapper() { return createFakeHandlers({}); }
const fakeHandlers = createWrapper();
class SurfaceState {`);
  assert.equal(discovery.approved, false);
});

test('rejects mutually exclusive try and catch export writes', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() { return { hidden(state, value) {} }; }
try { exports.createFakeHandlers = 0; }
catch { exports.createFakeHandlers = createFakeHandlers; }`);
  assert.equal(discovery.approved, false);
});

test('rejects conditional export overwrites', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() { return { hidden(state, value) {} }; }
module.exports = { createFakeHandlers };
if (enabled) module.exports.createFakeHandlers = 0;`);
  assert.equal(discovery.approved, false);
});

test('rejects computed and compound conditional export overwrites', () => {
  for (const [exportSource, write] of [
    [
      'exports.createFakeHandlers = createFakeHandlers;',
      "if (enabled) exports['createFakeHandlers'] = 0;"
    ],
    [
      'module.exports = { createFakeHandlers };',
      'module.exports.createFakeHandlers ||= 0;'
    ],
    [
      'module.exports = { createFakeHandlers };',
      "if (enabled) Object.defineProperty(module.exports, 'createFakeHandlers', { value: 0 });"
    ],
    [
      'module.exports = { createFakeHandlers };',
      'Object.assign(module.exports, { createFakeHandlers: 0 });'
    ]
  ]) {
    const discovery = discoverTempFactory(`function createFakeHandlers() { return { hidden(state, value) {} }; }
${exportSource}
${write}`);
    assert.equal(discovery.approved, false, write);
  }
});

test('rejects delete, unary, and defineProperties export overwrites', () => {
  for (const write of [
    'if (enabled) delete module.exports.createFakeHandlers;',
    'if (enabled) ++module.exports.createFakeHandlers;',
    'if (enabled) Object.defineProperties(module.exports, { createFakeHandlers: { value: 0 } });'
  ]) {
    const discovery = discoverTempFactory(`function createFakeHandlers() { return { hidden(state, value) {} }; }
module.exports = { createFakeHandlers };
${write}`);
    assert.equal(discovery.approved, false, write);
  }
});

test('rejects static computed and spread export overwrites', () => {
  for (const [factorySource, exportObject] of [
    [
      '',
      "{ createFakeHandlers, ['createFakeHandlers']: 0 }"
    ],
    [
      'function otherFactory() { return { hidden(state, value) {} }; }',
      "{ createFakeHandlers, ['createFakeHandlers']: otherFactory }"
    ],
    [
      '',
      '{ createFakeHandlers, ...overrides }'
    ]
  ]) {
    const discovery = discoverTempFactory(`function createFakeHandlers() { return { hidden(state, value) {} }; }
${factorySource}
module.exports = ${exportObject};`);
    assert.equal(discovery.approved, false, exportObject);
  }
});

test('accepts stale exports alias writes after replacing module exports', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() { return { hidden(state, value) {} }; }
module.exports = { createFakeHandlers };
if (enabled) exports.createFakeHandlers = 0;`);
  assert.equal(discovery.approved, true);
});

test('rejects export getters with a non-callable return path', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() { return { hidden(state, value) {} }; }
Object.defineProperty(exports, 'createFakeHandlers', {
  get: function () { if (disabled) return 0; return createFakeHandlers; }
});`);
  assert.equal(discovery.approved, false);
});

test('rejects getter-local factory shadows', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() { return { hidden(state, value) {} }; }
Object.defineProperty(exports, 'createFakeHandlers', {
  get: function () {
    const createFakeHandlers = 0;
    return createFakeHandlers;
  }
});`);
  assert.equal(discovery.approved, false);
});

test('rejects fallthrough in a recursively resolved factory', () => {
  const discovery = discoverTempFactory(`function createInner() {
  if (enabled) return { hidden(state, value) {} };
}
function createFakeHandlers() { return createInner(); }
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects callable handlers followed by unresolved spreads', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers(overrides) {
  return { hidden(state, value) {}, ...overrides };
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects callable mutations through a called module helper', () => {
  const discovery = discoverTempFactory(`let hidden = (state, value) => value;
function clobber() { hidden = 0; }
function createFakeHandlers() {
  clobber();
  return { hidden };
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects exported factories mutated through module helpers', () => {
  const discovery = discoverTempFactory(`let createFakeHandlers = function () { return { hidden(state, value) {} }; };
function clobber() { createFakeHandlers = 0; }
clobber();
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('ignores mutations of helper-local shadow bindings', () => {
  for (const helper of [
    `function clobber(hidden) { hidden = 0; }`,
    `function clobber() { let hidden = 0; hidden = 1; }`,
    `const clobber = hidden => { hidden = 0; };`,
    `class Clobber { run(hidden) { hidden = 0; } }`
  ]) {
    const invocation = helper.startsWith('class') ? 'new Clobber().run();' : 'clobber();';
    const discovery = discoverTempFactory(`let hidden = (state, value) => value;
${helper}
function createFakeHandlers() {
  ${invocation}
  return { hidden };
}
module.exports = { createFakeHandlers };`);
    assert.equal(discovery.approved, true, helper);
  }
});

test('rejects unresolved computed handler keys', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  const methodName = 'hidden';
  return { hidden(state, value) {}, [methodName]: 0 };
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects a factory parameter that shadows an outer callable', () => {
  const discovery = discoverTempFactory(`const hidden = function hidden(state, value) { return value; };
function createFakeHandlers(hidden) { return { hidden }; }
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects factory calls with unresolved arguments while retaining static arguments', () => {
  withTempCompanion(`function createInner() {
  return { hidden(state, value) {} };
}
function createFakeHandlers() { return createInner({}); }
module.exports = { createFakeHandlers };`, ({ requirePath, writeCompanion }) => {
    const positive = source.replace('class SurfaceState {', `const { createFakeHandlers } = require(${JSON.stringify(requirePath)});
const fakeHandlers = createFakeHandlers();
class SurfaceState {`);
    assert.equal(matchesWithCandidateBaseline(positive), true);
    writeCompanion(`function createInner() {
  return { hidden(state, value) {} };
}
function createFakeHandlers() { return createInner(missingDependency); }
module.exports = { createFakeHandlers };`);
    assert.equal(matchesWithCandidateBaseline(positive), false);
  });
});

test('treats statically nonterminating factory loops as abrupt flow', () => {
  for (const loop of ['while (true) {}', 'for (;;) {}']) {
    withTempCompanion(`function createFakeHandlers() {
  ${loop}
  return { hidden(state, value) {} };
}
module.exports = { createFakeHandlers };`, ({ requirePath }) => {
      const text = source.replace('class SurfaceState {', `const { createFakeHandlers } = require(${JSON.stringify(requirePath)});
const fakeHandlers = createFakeHandlers();
class SurfaceState {`);
      assert.equal(matchesWithCandidateBaseline(text), false, loop);
    });
  }
  for (const loop of ['while (1) {}', 'while (((1))) {}']) {
    withTempCompanion(`function createFakeHandlers() {
  ${loop}
  return { hidden(state, value) {} };
}
module.exports = { createFakeHandlers };`, ({ requirePath }) => {
      const text = source.replace('class SurfaceState {', `const { createFakeHandlers } = require(${JSON.stringify(requirePath)});
const fakeHandlers = createFakeHandlers();
class SurfaceState {`);
      assert.equal(matchesWithCandidateBaseline(text), false, loop);
    });
  }
  withTempCompanion(`function createFakeHandlers() {
  if (false) return { hidden(state, value) {} };
  while (true) {}
}
module.exports = { createFakeHandlers };`, ({ requirePath }) => {
    const text = source.replace('class SurfaceState {', `const { createFakeHandlers } = require(${JSON.stringify(requirePath)});
const fakeHandlers = createFakeHandlers();
class SurfaceState {`);
    assert.equal(matchesWithCandidateBaseline(text), false);
  });
  withTempCompanion(`function createFakeHandlers() {
  while (true) { break; }
  return { hidden(state, value) {} };
}
module.exports = { createFakeHandlers };`, ({ requirePath }) => {
    const positive = source.replace('class SurfaceState {', `const { createFakeHandlers } = require(${JSON.stringify(requirePath)});
const fakeHandlers = createFakeHandlers();
class SurfaceState {`);
    assert.equal(matchesWithCandidateBaseline(positive), true);
  });
});

test('does not resolve a factory getter through a dead branch return', () => {
  withTempCompanion(`function createInner() { return { hidden(state, value) {} }; }
Object.defineProperty(exports, 'createFakeHandlers', {
  get: function () { return createInner; }
});`, ({ requirePath, writeCompanion }) => {
    const positive = source.replace('class SurfaceState {', `const { createFakeHandlers } = require(${JSON.stringify(requirePath)});
const fakeHandlers = createFakeHandlers();
class SurfaceState {`);
    assert.equal(matchesWithCandidateBaseline(positive), true);
    writeCompanion(`function createInner() { return { hidden(state, value) {} }; }
Object.defineProperty(exports, 'createFakeHandlers', {
  get: function () {
  if (false) return createInner;
  while (true) {}
  }
});`);
    assert.equal(matchesWithCandidateBaseline(positive), false);
  });
});

test('keeps later lexical declarations shadowing outer handler functions', () => {
  withTempCompanion(`function hidden(state, value) {}
function createFakeHandlers() { return { hidden }; }
module.exports = { createFakeHandlers };`, ({ requirePath, writeCompanion }) => {
    const positive = source.replace('class SurfaceState {', `const { createFakeHandlers } = require(${JSON.stringify(requirePath)});
const fakeHandlers = createFakeHandlers();
class SurfaceState {`);
    assert.equal(matchesWithCandidateBaseline(positive), true);
    writeCompanion(`function hidden(state, value) {}
function createFakeHandlers() { return { hidden }; const hidden = 0; }
module.exports = { createFakeHandlers };`);
    assert.equal(matchesWithCandidateBaseline(positive), false);
  });
});

test('resolves bare factory calls through their lexical bindings', () => {
  const companion = `function inner() { return { hidden(state, value) {} }; }
function createFakeHandlers() { return inner(); }
module.exports = { createFakeHandlers };`;
  withTempCompanion(companion, ({ requirePath, writeCompanion }) => {
    const positive = source.replace('class SurfaceState {', `const { createFakeHandlers } = require(${JSON.stringify(requirePath)});
const fakeHandlers = createFakeHandlers();
class SurfaceState {`);
    assert.equal(matchesWithCandidateBaseline(positive), true);
    writeCompanion(companion.replace(
      'function createFakeHandlers() { return inner(); }',
      'function createFakeHandlers() { const inner = () => ({}); return inner(); }'));
    assert.equal(matchesWithCandidateBaseline(positive), false);
  });
});

test('resolves destructured handlers after later object overwrites', () => {
  const companion = `function createFakeHandlers() {
  const { hidden } = { hidden: (state, value) => value };
  return { hidden };
}
module.exports = { createFakeHandlers };`;
  withTempCompanion(companion, ({ requirePath, writeCompanion }) => {
    const positive = source.replace('class SurfaceState {', `const { createFakeHandlers } = require(${JSON.stringify(requirePath)});
const fakeHandlers = createFakeHandlers();
class SurfaceState {`);
    assert.equal(matchesWithCandidateBaseline(positive), true);
    writeCompanion(companion.replace(
      '{ hidden: (state, value) => value }',
      '{ hidden: (state, value) => value, ...{ hidden: 0 } }'));
    assert.equal(matchesWithCandidateBaseline(positive), false);
  });
});

test('rejects writes, deletes, and escapes through required receiver aliases', () => {
  withTempCompanion(`function createInner() { return { hidden(state, value) {} }; }
module.exports = { createInner };`, ({ requirePath }) => {
    const prefix = `const fixtureFactories = require(${JSON.stringify(requirePath)});
const fixtureFactoryAlias = fixtureFactories;
const createFakeHandlers = (...args) => fixtureFactoryAlias.createInner(...args);
const fakeHandlers = createFakeHandlers();
`;
    const positive = source.replace('class SurfaceState {', `${prefix}class SurfaceState {`);
    assert.equal(matchesWithCandidateBaseline(positive), true);
    for (const mutation of [
      'fixtureFactoryAlias.createInner = 0;',
      'delete fixtureFactoryAlias.createInner;',
      'consume(fixtureFactoryAlias);'
    ]) {
      const negative = positive.replace(
        'const createFakeHandlers =',
        `function consume(value) {}\n${mutation}\nconst createFakeHandlers =`);
      assert.notEqual(negative, positive);
      assert.equal(matchesWithCandidateBaseline(negative), false, mutation);
    }
  });
});

test('ignores unreachable factory returns', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
  throw new Error('unreachable');
  return { hidden(state, value) {} };
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('clears an export overwritten by a value descriptor', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() { return { hidden(state, value) {} }; }
module.exports = { createFakeHandlers };
Object.defineProperty(exports, 'createFakeHandlers', { value: 0 });`);
  assert.equal(discovery.approved, false);
});

test('rejects a conditional finally break over a pending return', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() {
outer: try { return { hidden(state, value) {} }; }
finally { if (disabled) break outer; }
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects an uninitialized hoisted handler binding', () => {
  const discovery = discoverTempFactory(`const hidden = (state, value) => value;
function createFakeHandlers() {
  return { hidden };
  var hidden;
}
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});

test('rejects asynchronous export getters', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() { return { hidden(state, value) {} }; }
Object.defineProperty(exports, 'createFakeHandlers', {
  get: async function () { return createFakeHandlers; }
});`);
  assert.equal(discovery.approved, false);
});

test('resolves receiver-qualified factories before local names', () => {
  const discovery = discoverTempFactoryFiles({
    'helpers.js': `function createInner() { return {}; }
module.exports = { createInner };`,
    'companion.js': `const helpers = require('./helpers');
function createInner() { return { hidden(state, value) {} }; }
function createFakeHandlers() { return helpers.createInner(); }
module.exports = { createFakeHandlers };`
  }, `const { createFakeHandlers } = require('./companion');
function createWrapper() { return createFakeHandlers({}); }
const fakeHandlers = createWrapper();
class SurfaceState {`);
  assert.equal(discovery.approved, false);
});

test('rejects duplicate factory declarations', () => {
  const discovery = discoverTempFactory(`function createFakeHandlers() { return { hidden(state, value) {} }; }
function createFakeHandlers() { return {}; }
module.exports = { createFakeHandlers };`);
  assert.equal(discovery.approved, false);
});
