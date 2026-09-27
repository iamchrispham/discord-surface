// Focused architectural contract for the acknowledgment facade/owner split.
// Proves the public facade still exposes the exact original surface and that its
// runtime identities are the same objects the four typed owners export. No
// production database, no network calls, no timers.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// The facade requires ../dist/acknowledgment.js, so npm run build must precede.
const facade = require(path.join(ROOT, 'src/acknowledgment.js'));
const constants = require(path.join(ROOT, 'dist/acknowledgment/constants.js'));
const receipts = require(path.join(ROOT, 'dist/acknowledgment/receipts.js'));
const delivery = require(path.join(ROOT, 'dist/acknowledgment/delivery.js'));
const watch = require(path.join(ROOT, 'dist/acknowledgment/watch.js'));

const PUBLIC_NAMES = [
  'ACK',
  'ACK_OUTCOMES',
  'ACK_WAITING',
  'NATIVE_PROVIDERS',
  'REACTION',
  'acknowledgmentCommand',
  'createAcknowledgmentDelivery',
  'isAcknowledgmentPending',
  'pendingAcknowledgments',
  'recordNativeAcknowledgment',
  'waitForAcknowledgment',
  'watchAcknowledgments'
];

test('facade preserves acknowledgment owner identities', { timeout: 8000 }, () => {
  assert.deepEqual(Object.keys(facade).sort(), PUBLIC_NAMES, 'public facade surface changed');

  // Receipt functions re-export the receipts owner's own functions.
  for (const name of ['isAcknowledgmentPending', 'pendingAcknowledgments', 'recordNativeAcknowledgment']) {
    assert.equal(typeof receipts[name], 'function', `receipts owner is missing ${name}`);
    assert.equal(facade[name], receipts[name], `facade.${name} is not the receipts owner export`);
  }

  // Delivery factories re-export the delivery owner's own functions.
  for (const name of ['createAcknowledgmentDelivery', 'waitForAcknowledgment']) {
    assert.equal(typeof delivery[name], 'function', `delivery owner is missing ${name}`);
    assert.equal(facade[name], delivery[name], `facade.${name} is not the delivery owner export`);
  }

  // Watcher re-exports the watch owner's own function.
  assert.equal(typeof watch.watchAcknowledgments, 'function', 'watch owner is missing watchAcknowledgments');
  assert.equal(facade.watchAcknowledgments, watch.watchAcknowledgments, 'facade.watchAcknowledgments is not the watch owner export');

  // Public constants and symbols are the constants owner's exact objects.
  for (const name of ['ACK', 'ACK_OUTCOMES', 'ACK_WAITING', 'NATIVE_PROVIDERS', 'REACTION']) {
    assert.ok(Object.prototype.hasOwnProperty.call(constants, name), `constants owner is missing ${name}`);
    assert.equal(facade[name], constants[name], `facade.${name} is not the constants owner export`);
  }

  // The command entrypoint stays defined by the facade itself, not delegated to an owner.
  assert.equal(typeof facade.acknowledgmentCommand, 'function');
  for (const [owner, module] of [['constants', constants], ['receipts', receipts], ['delivery', delivery], ['watch', watch]]) {
    assert.equal(Object.prototype.hasOwnProperty.call(module, 'acknowledgmentCommand'), false, `acknowledgmentCommand must not be exported by ${owner}`);
  }
});

test('facade preserves default and explicit CLI paths', { timeout: 8000 }, () => {
  const message = {
    id: '101',
    provider: 'Codex',
    nativeId: '9caa5d21-2169-429d-918b-5f08651b5dbd',
    generation: 2
  };
  const dbPath = '/fixture.sqlite';

  const defaultArgv = facade.acknowledgmentCommand(message, dbPath);
  const explicitArgv = facade.acknowledgmentCommand(message, dbPath, '/custom/cli.js');

  const defaultCli = path.join(ROOT, 'src', 'cli.js');

  // Boundary correctness: no missing or extra args, no argument bleeding.
  assert.equal(defaultArgv.length, explicitArgv.length);
  assert.equal(defaultArgv[0], process.execPath);
  assert.equal(explicitArgv[0], process.execPath);
  assert.equal(defaultArgv[1], defaultCli);
  assert.equal(explicitArgv[1], '/custom/cli.js');
  assert.equal(defaultArgv[2], 'native-ack');
  assert.equal(explicitArgv[2], 'native-ack');

  // The only path difference is the injected CLI entrypoint.
  assert.deepEqual(defaultArgv.slice(3), explicitArgv.slice(3));

  // Every flag is immediately followed by exactly one non-flag value.
  const tail = defaultArgv.slice(3);
  assert.equal(tail.length % 2, 0, 'argv flag/value tail must be complete pairs');
  for (let index = 0; index < tail.length; index += 2) {
    assert.match(tail[index], /^--/, `argv[${index}] must be a flag`);
    assert.doesNotMatch(String(tail[index + 1]), /^--/, `argv[${index + 1}] must not be a flag`);
  }

  const pairs = new Map();
  for (let index = 0; index < tail.length; index += 2) {
    assert.equal(pairs.has(tail[index]), false, `duplicate flag ${tail[index]}`);
    pairs.set(tail[index], tail[index + 1]);
  }
  assert.deepEqual([...pairs.keys()], ['--db', '--provider', '--message-id', '--native-id', '--generation']);
  assert.equal(pairs.get('--db'), dbPath);
  assert.equal(pairs.get('--provider'), 'Codex');
  assert.equal(pairs.get('--message-id'), '101');
  assert.equal(pairs.get('--native-id'), '9caa5d21-2169-429d-918b-5f08651b5dbd');
  assert.equal(pairs.get('--generation'), '2');

  // Each value appears exactly once; none bleeds into a neighboring flag.
  for (const value of [dbPath, 'Codex', '101', '9caa5d21-2169-429d-918b-5f08651b5dbd', '2']) {
    assert.equal(defaultArgv.filter(part => part === value).length, 1, `value ${value} must appear exactly once`);
  }
});
