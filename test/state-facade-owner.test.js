const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');

const { matches, matchesWithCandidateBaseline, source } = require('./state-facade/owner-test-helpers');
const { requireBindings } = require('./state-facade/handler-discovery-require');
const { reexportedModulePaths } = require('./state-facade/handler-discovery-exports');

function parseJavaScript(text) {
  return ts.createSourceFile('fixture.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function receiverOfCreateHandlers(parsed) {
  let receiver = null;
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'createHandlers') {
      receiver = node.expression.expression;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return receiver;
}

test('accepts the unchanged persistence facade baseline', () => {
  assert.equal(matches(source), true);
});

test('rejects a static modifier on a retained non-forwarding facade method', () => {
  const parsed = parseJavaScript(source);
  const owner = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SurfaceState');
  const method = owner.members.find(node => ts.isMethodDeclaration(node) && node.name?.text === 'directPostOwnerIdentity');
  assert.ok(method);
  const changed = source.slice(0, method.getStart(parsed)) + 'static ' + source.slice(method.getStart(parsed));

  assert.equal(matchesWithCandidateBaseline(changed), false);
});

for (const [label, mutation] of [
  ['direct const alias', 'const facade = module.exports; delete facade.SurfaceState;'],
  ['assignment-created alias', 'let facade; facade = module.exports; delete facade.SurfaceState;'],
  ['computed module exports alias', "const facade = module['exports']; delete facade.SurfaceState;"],
  ['computed exported property', "delete module.exports['SurfaceState'];"],
  ['called function alias', 'function removeExport() { const facade = module.exports; delete facade.SurfaceState; } removeExport();']
]) {
  test(`rejects ${label} deletion of the facade export`, () => {
    assert.equal(matchesWithCandidateBaseline(`${source}\n${mutation}`), false);
  });
}

for (const [label, mutation] of [
  ['helper-parameter', 'function removeFacade(facade) { delete facade.SurfaceState; } removeFacade(module.exports);'],
  ['parenthesized argument', 'function removeFacade(facade) { delete facade.SurfaceState; } removeFacade((module.exports));'],
  ['parenthesized alias', 'const facade = (module.exports); function removeFacade(value) { delete value.SurfaceState; } removeFacade(facade);'],
  ['grouped assignment alias', 'let facade; (facade) = module.exports; function removeFacade(value) { delete value.SurfaceState; } removeFacade(facade);'],
  ['nested grouped assignment alias', 'let facade; (((facade))) = module.exports; function removeFacade(value) { delete value.SurfaceState; } removeFacade(facade);'],
  ['computed export argument', "function removeFacade(facade) { delete facade.SurfaceState; } removeFacade(module['exports']);"],
  ['call argument', 'function removeFacade(facade) { delete facade.SurfaceState; } removeFacade.call(null, module.exports);'],
  ['apply argument', 'function removeFacade(facade) { delete facade.SurfaceState; } removeFacade.apply(null, [module.exports]);'],
  ['object argument', 'function removeFacade(value) { delete value.facade.SurfaceState; } removeFacade({ facade: module.exports });'],
  ['array argument', 'function removeFacade(value) { delete value[0].SurfaceState; } removeFacade([module.exports]);'],
  ['spread argument', 'function removeFacade(facade) { delete facade.SurfaceState; } removeFacade(...[module.exports]);'],
  ['shorthand alias argument', 'const facade = module.exports; function removeFacade(value) { delete value.facade.SurfaceState; } removeFacade({ facade });'],
  ['object spread argument', 'function removeFacade(value) { delete value.facade.SurfaceState; } removeFacade({ ...{ facade: module.exports } });']
]) {
  test(`rejects ${label} export-object argument escape`, () => {
    assert.equal(matchesWithCandidateBaseline(`${source}\n${mutation}`), false);
  });
}

test('accepts unrelated helper calls with ordinary object and array arguments', () => {
  const helper = `function removeFacade(value) { delete value.SurfaceState; }
    removeFacade({ SurfaceState: true, exports: false });
    removeFacade([{ SurfaceState: true }]);`;

  assert.equal(matchesWithCandidateBaseline(`${source}\n${helper}`), true);
});

for (const [label, write] of [
  ['array destructuring assignment', '[factories] = [{}];'],
  ['destructuring loop target', 'for ([factories] of [[{}]]) {}'],
  ['unary update', 'factories++;']
]) {
  test(`invalidates required factory bindings after ${label}`, () => {
    const parsed = parseJavaScript(`let factories = require('./factories'); ${write} const handlers = factories.createHandlers();`);
    const receiver = receiverOfCreateHandlers(parsed);

    assert.ok(receiver);
    assert.equal(requireBindings(parsed).get('factories', receiver), null);
  });
}

test('ignores re-exports inside an uncalled function or conditional scope', () => {
  const parsed = parseJavaScript(`
    __exportStar(require('./active-handlers'), exports);
    function publishLater() { __exportStar(require('./uncalled-handlers'), exports); }
    if (false) __exportStar(require('./conditional-handlers'), exports);
  `);

  assert.deepEqual(reexportedModulePaths(parsed), ['./active-handlers']);
});
