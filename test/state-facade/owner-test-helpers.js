const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ts = require('typescript');

const { compact, inventory, matches: matchesInventory } = require('./inventory');
const { discoverFactory } = require('./handler-discovery');
const baseline = require('./baseline.json');

const source = fs.readFileSync(path.join(__dirname, '../../src/state.js'), 'utf8');

function matches(text) {
  return matchesInventory(text, baseline);
}

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

function discoverTempFactory(companionSource) {
  return discoverTempFactoryFiles({ 'companion.js': companionSource }, `const { createFakeHandlers } = require('./companion');
function createWrapper() { return createFakeHandlers({}); }
const fakeHandlers = createWrapper();
class SurfaceState {`);
}

function discoverTempFactoryFiles(files, ownerSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-discovery-'));
  try {
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
    const ownerPath = path.join(root, 'owner.js');
    const parsed = ts.createSourceFile(ownerPath, ownerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    return discoverFactory(parsed, 'createWrapper');
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function insert(body) {
  return source.replace('class SurfaceState {', `class SurfaceState {\n${body}\n`);
}

function alterBody(name) {
  const changed = source.replace(new RegExp(`(${name}\\([^]*?\\)\\s*\\{)`), '$1\nconst injected = 1;');
  if (changed === source) throw new Error(`${name} mutation must change source`);
  return changed;
}

function removeMethod(name) {
  const parsed = ts.createSourceFile('state.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const owner = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SurfaceState');
  const method = owner.members.find(node => node.name?.getText(parsed) === name);
  if (!method) throw new Error(`removal mutation must find ${name}`);
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
if (!methodAsiTarget) throw new Error('retained class ASI control must locate actual null return');

const methodAsiStatement = methodAsiTarget.node;
const classAsiMutation = source.slice(0, methodAsiStatement.getStart(methodAsiSource)) +
  'return\nnull;' + source.slice(methodAsiStatement.end);
const asiMutation = source.replace('return null;', 'return\nnull;');

module.exports = {
  alterBody,
  asiMutation,
  baseline,
  classAsiMutation,
  compact,
  discoverFactory,
  discoverTempFactory,
  discoverTempFactoryFiles,
  insert,
  inventory,
  matches,
  matchesWithAddedBaseline,
  matchesWithAddedBodyBaseline,
  matchesWithCandidateBaseline,
  removeMethod,
  returnedHandlerSource,
  source
};
