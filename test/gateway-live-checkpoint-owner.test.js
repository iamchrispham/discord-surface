'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const Module = require('node:module');
const { facadeOwnerInventory } = require('./helpers/facade-owner-inventory.cjs');

const ownerPath = require.resolve('../src/discord/live-checkpoint');
const gatewayPath = require.resolve('../src/discord');
const methods = ['beginLiveCheckpoint', 'scheduleLiveCheckpointRetry', 'checkpointHealthyIntake'];

test('checkpoint forwarding sites defer argument evaluation to the owner', () => {
  const text = fs.readFileSync(gatewayPath, 'utf8');
  function check(text) {
    const source = ts.createSourceFile(gatewayPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const sites = [];
    function visit(node) {
      if (ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent) && node.parent.name?.text === 'DiscordGateway' && methods.includes(node.name.getText(source))) {
        sites.push(node.name.getText(source));
        for (const parameter of node.parameters) {
          assert.ok(ts.isIdentifier(parameter.name), node.name.getText(source));
          assert.ok(parameter.initializer === undefined, node.name.getText(source));
        }
      }
      ts.forEachChild(node, visit);
    }
    assert.deepEqual(facadeOwnerInventory(ts, source, { ownerName: 'liveCheckpointHandlers', factoryName: 'createLiveCheckpointHandlers', facadeNames: methods }), []);
    visit(source);
    assert.deepEqual(sites, methods);
  }
  check(text);
  const aliased = text.replace('  isCurrentBinding(binding) {', `  aliasCheckpoint(options = {}) {
    const alias = liveCheckpointHandlers;
    return alias.beginLiveCheckpoint.call(this, options);
  }

  isCurrentBinding(binding) {`);
  assert.notEqual(aliased, text);
  assert.throws(() => check(aliased));
  for (const parameters of ['options = {}', 'options']) {
    const optional = text.replace('  isCurrentBinding(binding) {', `  extraCheckpointFacade(${parameters}) {
    return liveCheckpointHandlers?.beginLiveCheckpoint.apply(this, arguments);
  }

  isCurrentBinding(binding) {`);
    assert.notEqual(optional, text);
    assert.throws(() => check(optional), { code: 'ERR_ASSERTION' });
  }
  for (const access of ["liveCheckpointHandlers['beginLiveCheckpoint']", '(liveCheckpointHandlers).beginLiveCheckpoint']) {
    const unsupported = text.replace('  isCurrentBinding(binding) {', `  extraCheckpointFacade(options = {}) {
    return ${access}.apply(this, arguments);
  }

  isCurrentBinding(binding) {`);
    assert.notEqual(unsupported, text);
    assert.throws(() => check(unsupported), { code: 'ERR_ASSERTION' });
  }
  for (const member of ["extraCheckpoint = () => liveCheckpointHandlers.beginLiveCheckpoint.apply(this, arguments);", "extraCheckpoint(options = liveCheckpointHandlers.beginLiveCheckpoint) {}", "get extraCheckpoint() { return liveCheckpointHandlers.beginLiveCheckpoint; }", "set extraCheckpoint(value) { liveCheckpointHandlers.beginLiveCheckpoint.call(this, value); }"]) {
    const extra = text.replace('  isCurrentBinding(binding) {', `  ${member}\n\n  isCurrentBinding(binding) {`);
    assert.notEqual(extra, text);
    assert.throws(() => check(extra), { code: 'ERR_ASSERTION' });
  }
  const constructorConsumer = text.replace('constructor(', 'constructor(').replace('    this.deferredHandoffRecoveryTimer = null;', '    liveCheckpointHandlers.beginLiveCheckpoint.call(this);\n    this.deferredHandoffRecoveryTimer = null;');
  assert.notEqual(constructorConsumer, text);
  assert.throws(() => check(constructorConsumer), { code: 'ERR_ASSERTION' });
  for (const name of methods) {
    const needle = `liveCheckpointHandlers.${name}.apply(this, arguments)`;
    const grouped = text.replace(needle, `((liveCheckpointHandlers).${name})['apply']((this), (arguments))`);
    assert.notEqual(grouped, text);
    check(grouped);
    const conditional = text.replace(`return ${needle};`, `const dispatch = () => ${needle}; if (this?.extraCheckpoint) dispatch(); return dispatch();`);
    assert.notEqual(conditional, text);
    assert.throws(() => check(conditional), { code: 'ERR_ASSERTION' });
  }
  const { DiscordGateway } = require(gatewayPath);
  assert.deepEqual(methods.map(name => DiscordGateway.prototype[name].length), [0, 1, 2]);
});

test('real checkpoint owner reads option getters once', () => {
  const { DiscordGateway } = require(gatewayPath);
  let reads = 0;
  const options = {
    get allowPendingRecovery() {
      reads++;
      if (reads > 1) throw new Error('option getter evaluated twice');
      return false;
    }
  };
  const receiver = { stopping: true };
  assert.equal(DiscordGateway.prototype.beginLiveCheckpoint.call(receiver, new Map(), options), undefined);
  assert.equal(reads, 1);
});

test('checkpoint facade preserves receiver, arguments and outcomes', async () => {
  const savedOwner = require.cache[ownerPath];
  const savedGateway = require.cache[gatewayPath];
  const calls = [];
  let value;
  let failure;
  let factories = 0;
  require.cache[ownerPath] = {
    id: ownerPath,
    filename: ownerPath,
    loaded: true,
    exports: {
      createLiveCheckpointHandlers(dependencies) {
        factories++;
        assert.deepEqual(Object.keys(dependencies).sort(), [
          'CODEX_VALIDATION_KINDS', 'LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS',
          'LIVE_CHECKPOINT_RETRY_MAX_DELAY_MS', 'READINESS', 'THREAD_STATES',
          'compareDiscordIds', 'heldParentRequestIds', 'recoverThread',
          'recoveryError', 'recoveryKind', 'waitForRecoveryOperation'
        ].sort());
        return Object.fromEntries(methods.map(name => [name, function(...args) {
          calls.push({ name, receiver: this, args });
          if (failure) throw failure;
          return value;
        }]));
      }
    }
  };
  delete require.cache[gatewayPath];
  try {
    const { DiscordGateway } = require(gatewayPath);
    assert.equal(factories, 1);
    const receiver = Object.create(DiscordGateway.prototype);
    const argumentRows = [
      [Object.freeze({ marker: 1 }), undefined, null, 'extra'],
      [Object.freeze({ position: 0 }), Object.freeze({ position: 1 }), Object.freeze({ position: 2 }), Object.freeze({ position: 3 })]
    ];
    for (const name of methods) {
      const method = DiscordGateway.prototype[name];
      for (const args of argumentRows) {
      for (const target of [receiver, null, undefined, 17]) {
        for (const outcome of [Object.freeze({ result: name }), undefined, null, 17, Promise.resolve(19)]) {
          value = outcome;
          failure = null;
          calls.length = 0;
          const result = method.apply(target, args);
          if (name === 'checkpointHealthyIntake') assert.equal(await result, await outcome);
          else assert.equal(result, outcome);
          assert.equal(calls.length, 1);
          assert.equal(calls[0].name, name);
          assert.equal(calls[0].receiver, target);
          assert.equal(calls[0].args.length, args.length);
          args.forEach((argument, index) => assert.equal(calls[0].args[index], argument));
        }
        failure = new Error(name);
        if (name === 'checkpointHealthyIntake') {
          await assert.rejects(method.apply(target, args), error => error === failure);
        } else {
          assert.throws(() => method.apply(target, args), error => error === failure);
        }
      }
      }
    }
    const originalText = fs.readFileSync(gatewayPath, 'utf8');
    const objectArgs = argumentRows[1];
    async function verifyArgumentIdentity(text, name) {
      const loaded = new Module(`${gatewayPath}.control`, module);
      loaded.filename = gatewayPath;
      loaded.paths = Module._nodeModulePaths(require('node:path').dirname(gatewayPath));
      loaded._compile(text, gatewayPath);
      calls.length = 0;
      failure = null;
      value = Object.freeze({ result: name });
      await loaded.exports.DiscordGateway.prototype[name].apply(receiver, objectArgs);
      assert.equal(calls.length, 1);
      objectArgs.forEach((argument, index) => assert.equal(calls[0].args[index], argument));
    }
    for (const name of methods) {
      for (let position = 0; position < objectArgs.length; position++) {
        await verifyArgumentIdentity(originalText, name);
        const clonedArguments = objectArgs.map((_, index) => index === position ? `{ ...arguments[${index}] }` : `arguments[${index}]`).join(', ');
        const needle = `liveCheckpointHandlers.${name}.apply(this, arguments)`;
        const mutant = originalText.replace(needle, `liveCheckpointHandlers.${name}.apply(this, [${clonedArguments}])`);
        assert.notEqual(mutant, originalText);
        await assert.rejects(verifyArgumentIdentity(mutant, name), assert.AssertionError);
      }
    }
  } finally {
    if (savedOwner) require.cache[ownerPath] = savedOwner;
    else delete require.cache[ownerPath];
    if (savedGateway) require.cache[gatewayPath] = savedGateway;
    else delete require.cache[gatewayPath];
  }
});
