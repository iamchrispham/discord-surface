const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { COURIER_RECEIPT_KINDS, COURIER_RECOVERY_TRIGGERS } = require('../src/state/courier-route');
const { COURIER_NATIVE } = require('./courier-route-fixture');
const {
  beginPredecessor, consumerInput, createWatcherFixture, deadline,
  forwardEvent, reopen, retireByPublicRecovery, retirementReceipts, scenarioConsumer
} = require('./helpers/watcher-retired-recovery.cjs');

function duplicateBegin(f, message) {
  return f.state.beginCourierAttempt(message.id, consumerInput(f, message));
}

async function runConsumer(f, messageId, signal) {
  const courier = [];
  const direct = [];
  const consumer = scenarioConsumer(f, { courier, direct });
  try {
    await consumer.processAccepted(f.state.getMessage(messageId), signal, { continueUntilFinal: false, awaitDispatchOutcome: true });
  } finally {
    consumer.abortNativeWork();
    await consumer.waitForNativeWork();
  }
  return { courier, direct };
}

test('pickup deadline fences the attempt without renewing queue submission on wake', { timeout: 5000 }, async t => {
  const { f, message } = createWatcherFixture(t);
  const courier = [];
  const direct = [];
  const consumer = scenarioConsumer(f, { courier, direct, observeOptions: { timeoutMs: 10 } });
  const bound = deadline();
  try {
    for (let wake = 0; wake < 4; wake++) {
      await Promise.race([
        consumer.processAccepted(f.state.getMessage(message.id), bound.controller.signal, { continueUntilFinal: false }),
        bound.expired
      ]);
      assert.equal(f.state.getMessage(message.id).state, 'accepted');
    }
    assert.equal(courier.length, 1);
    assert.equal(direct.length, 0);
    assert.deepEqual(retirementReceipts(f.state, message.id).map(r => JSON.parse(r.detail).trigger), [COURIER_RECOVERY_TRIGGERS.PICKUP_DEADLINE]);
    const predecessor = f.state.getCourierAttempt(message.id).attempt;
    const beforeProjection = retirementReceipts(f.state, message.id).length;
    assert.deepEqual(f.state.getCourierDeliveryStatus(message.id), [{
      messageId: message.id, attemptId: predecessor.attemptId, status: 'retired',
      recoveryEligible: true, recoveryReason: 'retry_confirmation_required'
    }]);
    assert.equal(retirementReceipts(f.state, message.id).length, beforeProjection);
    assert.equal(f.state.recoverCourierAttempt(message.id, predecessor.attemptId).duplicate, false);
    assert.equal(f.state.recoverCourierAttempt(message.id, predecessor.attemptId).duplicate, true);
    assert.equal(f.state.getCourierDeliveryStatus(message.id)[0].recoveryEligible, false);
    assert.equal(retirementReceipts(f.state, message.id).length, 2);
    await Promise.race([
      consumer.processAccepted(f.state.getMessage(message.id), bound.controller.signal, { continueUntilFinal: false }),
      bound.expired
    ]);
    assert.equal(courier.length, 2);
    assert.equal(f.state.getCourierAttempt(message.id).attempt.predecessorAttemptId, predecessor.attemptId);
    assert.equal(direct.length, 0);
  } finally {
    bound.clear();
    bound.controller.abort();
    consumer.abortNativeWork();
    await consumer.waitForNativeWork();
  }
});

test('restart between dispatch claim and successor write keeps retired notice accepted', { timeout: 5000 }, async t => {
  const { f, message } = createWatcherFixture(t);
  const { claim } = beginPredecessor(f, message);
  retireByPublicRecovery(f, message, claim);
  assert.equal(f.state.claimDispatch(message.id).claimed, true);
  reopen(f);
  f.state.recoverAfterRestart();
  assert.equal(f.state.getMessage(message.id).state, 'accepted');
  const bound = deadline();
  try {
    const result = await runConsumer(f, message.id, bound.controller.signal);
    assert.equal(result.courier.length, 1);
    assert.equal(result.direct.length, 0);
    assert.notEqual(f.state.getCourierAttempt(message.id).attempt.attemptId, claim.attempt.attemptId);
  } finally {
    bound.clear();
    bound.controller.abort();
  }
});

test('historical public retirement needs explicit confirmation and keeps its old forwarding fence', { timeout: 5000 }, t => {
  const { f, message } = createWatcherFixture(t);
  const { input, claim } = beginPredecessor(f, message);
  retireByPublicRecovery(f, message, claim);
  const retirement = retirementReceipts(f.state, message.id)[0];
  const oldDetail = JSON.parse(retirement.detail);
  delete oldDetail.trigger;
  f.state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(JSON.stringify(oldDetail), retirement.id);
  assert.equal(duplicateBegin(f, message).accepted, false);
  assert.throws(() => f.state.readCourierInput(f.route.routeId, message.id, claim.attempt.attemptId, COURIER_NATIVE, f.dir), /not eligible/);
  assert.equal(f.state.recoverCourierAttempt(message.id, claim.attempt.attemptId).duplicate, false);
  assert.equal(f.state.recoverCourierAttempt(message.id, claim.attempt.attemptId).duplicate, true);
  const successor = duplicateBegin(f, message);
  assert.equal(successor.accepted, true);
  assert.equal(successor.attempt.predecessorAttemptId, claim.attempt.attemptId);
  assert.equal(retirementReceipts(f.state, message.id).length, 2);
  assert.equal(f.state.claimDispatch(message.id).claimed, true);
  assert.throws(() => f.state.claimCourierForward(f.route.routeId, forwardEvent(f, message, input.prompt)), /submission was refused/);
});

test('formatted successor overflow preserves accepted custody through the consumer', { timeout: 5000 }, async t => {
  const { f, message } = createWatcherFixture(t);
  const { claim } = beginPredecessor(f, message);
  retireByPublicRecovery(f, message, claim);
  const begin = f.state.beginCourierAttempt.bind(f.state);
  f.state.beginCourierAttempt = (id, input) => begin(id, { ...input, prompt: 'x'.repeat(100000) });
  const bound = deadline();
  try {
    const result = await runConsumer(f, message.id, bound.controller.signal);
    assert.equal(result.courier.length, 0);
    assert.equal(result.direct.length, 0);
    assert.equal(f.state.getMessage(message.id).state, 'accepted');
    assert.equal(f.state.getCourierAttempt(message.id).attempt.attemptId, claim.attempt.attemptId);
  } finally {
    f.state.beginCourierAttempt = begin;
    bound.clear();
    bound.controller.abort();
  }
});

test('malformed and contradictory retirement records cannot authorize a successor', { timeout: 5000 }, t => {
  for (const detail of [1, true, 'invalid', [], { source: 'courier-recovery', attemptId: 'another-attempt', trigger: COURIER_RECOVERY_TRIGGERS.EXPLICIT }]) {
    const { f, message } = createWatcherFixture(t);
    const { claim } = beginPredecessor(f, message);
    retireByPublicRecovery(f, message, claim);
    f.state.receipt(message.id, COURIER_RECEIPT_KINDS.RECONCILED_NOT_SUBMITTED, detail);
    assert.equal(duplicateBegin(f, message).accepted, false);
    assert.equal(f.state.getCourierAttempt(message.id).attempt.attemptId, claim.attempt.attemptId);
    assert.equal(f.state.getMessage(message.id).state, 'accepted');
  }
});

test('every production recovery caller is classified and a new caller breaks the inventory', { timeout: 5000 }, t => {
  function recoveryReferences(root) {
    const sites = [];
    function visitDirectory(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) { visitDirectory(file); continue; }
        if (!/\.(?:[cm]?js|tsx?)$/.test(entry.name)) continue;
        const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        function visit(node) {
          const member = ts.isPropertyAccessExpression(node) && node.name.text === 'recoverCourierAttempt';
          const indexed = ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) &&
            node.argumentExpression.text === 'recoverCourierAttempt';
          const direct = ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
            node.expression.text === 'recoverCourierAttempt';
          if (member || indexed || direct) sites.push(path.relative(root, file).split(path.sep).join('/'));
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
    visitDirectory(root);
    return sites.sort();
  }
  const root = path.resolve(__dirname, '../src');
  const expected = ['cli/recovery-commands.js', 'discord/courier-pickup-deadline.js', 'state.js'];
  assert.deepEqual(recoveryReferences(root), expected);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-callers-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  for (const name of expected) {
    const destination = path.join(scratch, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, name), destination);
  }
  fs.writeFileSync(path.join(scratch, 'unclassified.js'), 'state.recoverCourierAttempt(messageId, attemptId);');
  assert.deepEqual(recoveryReferences(scratch), [...expected, 'unclassified.js']);
  const deadlineSource = ts.createSourceFile('deadline.js', fs.readFileSync(path.join(root, expected[1]), 'utf8'), ts.ScriptTarget.Latest, true);
  const triggers = [];
  function findTriggers(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'recoverCourierAttempt') triggers.push(node.arguments[2]?.getText(deadlineSource));
    ts.forEachChild(node, findTriggers);
  }
  findTriggers(deadlineSource);
  assert.deepEqual(triggers, ['COURIER_RECOVERY_TRIGGERS.PICKUP_DEADLINE']);
});
