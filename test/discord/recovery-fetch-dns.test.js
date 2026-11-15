const test = require('node:test');
const assert = require('node:assert/strict');

const { fixture: intakeFixture } = require('../helpers/intake-recovery-fixture');
const { fixture: threadFixture } = require('../issue-thread-fixture');
const { CODEX_VALIDATION_KINDS } = require('../../src/native');
const {
  RECOVERY_DNS_MARKER_PREFIX,
  classifyRecoveryFailure,
  isRetryableFetchBoundary,
  isRetryableHttp503Boundary,
  recoveryFetch,
  retryPendingBoundaryDetail
} = require('../../src/discord/recovery-fetch');

function dnsError(hostname = 'discord.com') {
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
    code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname
  });
}

function fetchFailedDnsError(hostname = 'discord.com') {
  return new TypeError('fetch failed', { cause: dnsError(hostname) });
}

test('recoveryFetch marks supported DNS causes and preserves the transport cause', async () => {
  for (const transportError of [dnsError(), fetchFailedDnsError()]) {
    await assert.rejects(
      recoveryFetch(async () => { throw transportError; }),
      error => {
        assert.match(error.message, /^Discord DNS failure during recovery: /);
        assert.equal(error.cause, transportError);
        return true;
      }
    );
  }
});

test('DNS classification stays narrow and keeps existing precedence', async () => {
  const messageOnly = new Error('getaddrinfo ENOTFOUND discord.com');
  await assert.rejects(recoveryFetch(async () => { throw messageOnly; }), error => error === messageOnly);

  const wrongHost = dnsError('api.discord.com');
  await assert.rejects(recoveryFetch(async () => { throw wrongHost; }), error => error === wrongHost);

  const unsupportedCause = fetchFailedDnsError('api.discord.com');
  await assert.rejects(recoveryFetch(async () => { throw unsupportedCause; }), error => error === unsupportedCause);

  const http503 = Object.assign(dnsError(), { status: 503 });
  await assert.rejects(recoveryFetch(async () => { throw http503; }), error => {
    assert.match(error.message, /^Discord HTTP 503 during recovery: /);
    assert.equal(error.cause, http503);
    return true;
  });

  const auth = Object.assign(new Error('unauthorized'), { status: 401 });
  await assert.rejects(recoveryFetch(async () => { throw auth; }), error => error === auth);

  assert.equal(isRetryableFetchBoundary('unavailable', `${RECOVERY_DNS_MARKER_PREFIX}getaddrinfo ENOTFOUND discord.com`), true);
  assert.equal(isRetryableHttp503Boundary('unavailable', `${RECOVERY_DNS_MARKER_PREFIX}getaddrinfo ENOTFOUND discord.com`), false);
  assert.equal(classifyRecoveryFailure(messageOnly).detail, messageOnly.message);
  assert.equal(
    retryPendingBoundaryDetail('channel recovery', {
      state: 'unavailable', detail: `${RECOVERY_DNS_MARKER_PREFIX}getaddrinfo ENOTFOUND discord.com`
    }),
    'Discord recovery retry pending: channel recovery after DNS failure'
  );
});

test('DNS provenance never overrides auth or recovery control metadata', async () => {
  const authDirect = Object.assign(dnsError(), { status: 401 });
  const authFetch = Object.assign(fetchFailedDnsError(), { status: 401 });
  const authCause = fetchFailedDnsError();
  authCause.cause.status = 401;
  for (const transportError of [authDirect, authFetch, authCause]) {
    await assert.rejects(
      recoveryFetch(async () => { throw transportError; }),
      error => error === transportError
    );
  }

  for (const recoveryKind of [CODEX_VALIDATION_KINDS.DEADLINE, CODEX_VALIDATION_KINDS.STOPPED, 'stale', 'cancelled']) {
    const direct = Object.assign(dnsError(), { recoveryKind });
    const fetchFailed = fetchFailedDnsError();
    fetchFailed.recoveryKind = recoveryKind;
    const cause = fetchFailedDnsError();
    cause.cause.recoveryKind = recoveryKind;
    for (const transportError of [direct, fetchFailed, cause]) {
      await assert.rejects(
        recoveryFetch(async () => { throw transportError; }),
        error => error === transportError
      );
    }
  }
});

for (const { id, kind, label } of [
  { id: '1000', kind: 'channel', label: 'parent channel' },
  { id: '1000', kind: 'history', label: 'parent history' },
  { id: '2000', kind: 'channel', label: 'adopted child channel' },
  { id: '2000', kind: 'history', label: 'adopted child history' }
]) {
  test(`${label} DNS failure retries after SQLite reopen with cursor intact`, { timeout: 5000 }, async t => {
    const f = intakeFixture(t);
    f.fail({ id, kind, error: dnsError() });
    await f.recover();
    assert.equal(f.boundary(id).state, 'unavailable');
    assert.match(f.boundary(id).detail, /^Discord DNS failure during recovery: /);
    assert.equal(f.cursor(id), '100');

    await f.reopen();
    f.fail(null);
    f.calls.length = 0;
    await f.recover();
    assert.ok(
      f.calls.some(call => call.id === id && call.kind === kind),
      'healthy recovery skipped the fresh fetch after database reopen'
    );
    assert.equal(f.boundary(id).state, 'ready');
    assert.equal(f.cursor(id), '100');
  });
}

for (const kind of ['channel', 'history']) {
  test(`pre-adoption child ${kind} DNS failure retries without widening HTTP 503 handling`, { timeout: 5000 }, async t => {
    const f = intakeFixture(t, { adoptThread: false });
    f.fail({ id: '2000', kind, error: dnsError() });
    await f.recover();
    assert.equal(f.boundary('2000').state, 'unavailable');
    assert.match(f.boundary('2000').detail, /^Discord DNS failure during recovery: /);
    assert.equal(f.cursor('2000'), null);

    await f.reopen();
    f.fail(null);
    f.calls.length = 0;
    await f.recover();
    assert.ok(
      f.calls.some(call => call.id === '2000' && call.kind === kind),
      'healthy pre-adoption recovery skipped the fresh fetch after database reopen'
    );
    assert.equal(f.boundary('2000').state, 'ready');
    assert.equal(f.cursor('2000'), '0');
  });
}

test('outbound reply lookup holds custody on DNS failure and sends after later success', async t => {
  const f = threadFixture(t);
  f.ready();
  const stored = f.state.acceptDiscordMessage({
    ...f.message('101'), authorId: 'operator', isBot: false, attachments: []
  }, { expectedBinding: f.state.getBinding(f.parent.id) }).message;
  const originalFetch = f.client.channels.fetch;
  const transportError = dnsError();
  let fail = true;
  f.client.channels.fetch = async id => {
    if (fail && id === f.child.id) throw transportError;
    return originalFetch(id);
  };

  await assert.rejects(
    f.gateway.sendReply(stored, { id: '101', replyText: 'answer', replyNonce: 'reply-101' }),
    error => {
      assert.equal(error.outcome, 'not_sent');
      assert.match(error.message, /^Discord DNS failure during recovery: /);
      assert.equal(error.cause, transportError);
      return true;
    }
  );
  assert.equal(f.sends.length, 0);
  assert.equal(f.state.getMessage('101').state, 'accepted');
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, 'unavailable');

  fail = false;
  await f.gateway.sendReply(f.state.getMessage('101'), { id: '101', replyText: 'answer', replyNonce: 'reply-101' });
  assert.equal(f.sends.length, 1);
  assert.equal(f.state.getMessage('101').state, 'accepted');
});

function seedReplyReady(f, id) {
  const message = f.message(id, '1000');
  assert.equal(f.state.acceptDiscordMessage({ ...message, authorId: 'operator', isBot: false }).accepted, true);
  assert.equal(f.state.claimDispatch(id).claimed, true);
  assert.equal(f.state.markSubmitted(id).state, 'submitted');
  const stored = f.state.getMessage(id);
  f.state.recordNativeReply({
    provider: stored.provider,
    messageId: stored.id,
    nativeId: stored.nativeId,
    generation: stored.generation,
    text: 'saved reply'
  });
}

test('pending reply reconciliation keeps reply custody on DNS failure and retries later', { timeout: 5000 }, async t => {
  const f = intakeFixture(t);
  seedReplyReady(f, '101');
  f.enableDelivery();
  f.gateway.sendAcknowledgment = async () => {};
  f.fail({ id: '1000', kind: 'channel', error: dnsError() });

  await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
  assert.equal(f.state.getMessage('101').state, 'reply_ready');
  assert.equal(f.replies.length, 0);
  assert.equal(f.dispatched.length, 0);

  f.fail(null);
  f.calls.length = 0;
  await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
  assert.equal(f.state.getMessage('101').state, 'replied');
  assert.equal(f.replies.length, 1);
  assert.ok(f.calls.some(call => call.id === '1000' && call.kind === 'channel'));
  assert.equal(f.dispatched.length, 0);
});
