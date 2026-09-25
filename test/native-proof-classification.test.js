const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateCodexSessionIdentity, validateCodexSessionIdentityAsync, CODEX_VALIDATION_KINDS: K } = require('../src/native');
const ID = '11111111-1111-4111-8111-111111111111';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-kind-'));
  const root = path.join(dir, 'sessions');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = name => fs.writeFileSync(path.join(root, name), JSON.stringify({
    type: 'session_meta', payload: { id: ID, cwd: dir }
  }) + '\n');
  return { dir, root, write };
}

for (const [label, validate] of [['sync', validateCodexSessionIdentity], ['async', validateCodexSessionIdentityAsync]]) {
  test(`${label} proof distinguishes unavailable, ambiguity, workspace mismatch and success`, async t => {
    const f = fixture(t);
    const check = (workspace, kind) => assert.rejects(async () => validate(ID, workspace, f.root), error => typeof kind === 'string' && error.recoveryKind === kind);
    await check(f.dir, K.UNAVAILABLE);
    f.write(`${ID}.jsonl`);
    await check('/other-workspace', K.WORKSPACE_MISMATCH);
    assert.equal((await validate(ID, f.dir, f.root)).sessionId, ID);
    f.write(`second-${ID}.jsonl`);
    await check(f.dir, K.AMBIGUOUS);
  });

  test(`${label} proof classifies conflicting transcript identity`, async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, `${ID}-conflict.jsonl`), JSON.stringify({
      type: 'session_meta', payload: {
        id: ID,
        session_id: '99999999-9999-4999-8999-999999999999',
        cwd: f.dir
      }
    }) + '\n');
    await assert.rejects(async () => validate(ID, f.dir, f.root), error => error.recoveryKind === K.IDENTITY_MISMATCH);
  });
}

test('async proof preserves deadline and cancellation kinds through unavailable wrapper', async t => {
  const f = fixture(t);
  f.write(`${ID}.jsonl`);
  for (const [options, kind] of [
    [{ deadline: Date.now() - 1 }, K.DEADLINE],
    [{ signal: AbortSignal.abort() }, K.STOPPED]
  ]) {
    await assert.rejects(() => validateCodexSessionIdentityAsync(ID, f.dir, f.root, options), error =>
      error.recoveryKind === kind && error.cause?.recoveryKind === kind);
  }
});

test('only complete typed deadline markers allow retry and never a history gap', () => {
  const { nativeProofDeadlineDetail, isNativeProofRetryBoundary, NATIVE_PROOF_PHASES } = require('../src/discord/native-proof-recovery');
  const detail = nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.PREFLIGHT, 100, 101);
  for (const state of ['unavailable', 'pending']) assert.equal(isNativeProofRetryBoundary(state, detail), true);
  for (const state of ['gap', 'ready', undefined]) assert.equal(isNativeProofRetryBoundary(state, detail), false);
  for (const invalid of [null, '', 'Native proof recovery v1: {}', 'Native proof recovery v1: null',
    detail.replace('deadline', 'permission'), detail.replace('preflight', 'unknown'), detail.replace('100', 'null')]) {
    assert.equal(isNativeProofRetryBoundary('unavailable', invalid), false);
  }
});
