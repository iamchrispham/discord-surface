const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChannelType, GatewayIntentBits } = require('discord.js');
const { SurfaceState, MESSAGE_STATES, READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { DiscordGateway, waitForRecoveryOperation } = require('../src/discord');
const { enrollPublicThread, recoverThread, AdoptionRefusalError, ADOPTION_REFUSAL_DETAILS } = require('../src/discord/thread-enrollment');
const { GATEWAY_CAPABILITIES, gatewayProcessStatus, main, pathsFor, threadEnroll } = require('../src/cli');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const { startReconciliationLookup } = require('../dist/discord/reconciliation-lookups');
const { fixture, NATIVE, SUCCESSOR } = require('./issue-thread-fixture');
test('thread recovery keeps an untouched child pending after deadline exhaustion', async t => {
  const f = fixture(t); f.ready('100');
  const result = await recoverThread(
    f.gateway,
    f.state.getThreadEnrollment(f.child.id),
    new AbortController().signal,
    f.gateway.lifecycleEpoch,
    waitForRecoveryOperation,
    false,
    Date.now() - 1
  );
  assert.equal(result, false);
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.PENDING);
  assert.equal(f.fetched.length, 0);
  assert.equal(f.dispatched.length, 0);
  await recoverThread(f.gateway, f.state.getThreadEnrollment(f.child.id), new AbortController().signal, f.gateway.lifecycleEpoch, waitForRecoveryOperation);
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.READY);
});

test('closing recovery refuses READY when live child custody stays ahead of one extra history pass', async t => {
  const f = fixture(t);
  f.ready('100');
  f.gateway.historyPageLimit = 1;
  let calls = 0;
  f.gateway.fetchHistory = async () => {
    calls += 1;
    if (calls === 1) return [f.message('101')];
    if (calls > 2) return [];
    const live = f.state.acceptDiscordMessage({
      id: '102',
      guildId: 'guild',
      channelId: f.child.id,
      authorId: 'operator',
      isBot: false,
      content: 'arrived during recovery',
      attachments: []
    }, { ready: false, expectedBinding: f.state.getBinding(f.parent.id) });
    assert.equal(live.accepted, true);
    return [];
  };
  const result = await recoverThread(
    f.gateway,
    f.state.getThreadEnrollment(f.child.id),
    new AbortController().signal,
    f.gateway.lifecycleEpoch,
    waitForRecoveryOperation
  );
  const enrollment = f.state.getThreadEnrollment(f.child.id);
  assert.equal(result, false);
  assert.equal(enrollment.state, THREAD_STATES.GAP);
  assert.equal(enrollment.gapTo, '102');
  assert.equal(calls, 3);
  assert.equal(f.state.getBinding(f.parent.id).readiness, READINESS.READY);
});

test('thread recovery keeps pre-existing custody ahead fenced until history catches up', async t => {
  const f = fixture(t); f.ready('100');
  const accepted = f.state.acceptDiscordMessage({
    id: '102', guildId: 'guild', channelId: f.child.id, authorId: 'operator', isBot: false,
    content: 'thread question', attachments: []
  }, {
    ready: false,
    expectedBinding: f.state.getBinding(f.parent.id)
  });
  assert.equal(accepted.accepted, true);
  f.gateway.fetchHistory = async () => [];
  const result = await recoverThread(
    f.gateway,
    f.state.getThreadEnrollment(f.child.id),
    new AbortController().signal,
    f.gateway.lifecycleEpoch,
    waitForRecoveryOperation
  );
  const enrollment = f.state.getThreadEnrollment(f.child.id);
  assert.equal(result, false);
  assert.equal(enrollment.state, THREAD_STATES.GAP);
  assert.equal(enrollment.gapTo, '102');
});

test('checkpoint-only recovery reports no advancement when history has no new messages', async t => {
  const f = fixture(t);
  f.ready('100');
  f.gateway.fetchHistory = async () => [];
  const advanced = await f.gateway.checkpointHealthyIntake(
    new AbortController().signal,
    f.gateway.lifecycleEpoch,
    new Map([[f.child.id, 1]])
  );
  assert.equal(advanced.has(f.child.id), false);
  assert.equal(f.state.getThreadEnrollment(f.child.id).recoveredThroughId, '100');
});

test('failed child lookup leaves accepted reply definitely unsent and marks child unavailable', async t => {
  const f = fixture(t);
  f.ready();
  const stored = f.state.acceptDiscordMessage({
    id: '100',
    guildId: 'guild',
    channelId: f.child.id,
    authorId: 'operator',
    isBot: false,
    content: 'thread question',
    attachments: []
  }, { expectedBinding: f.state.getBinding(f.parent.id) }).message;
  const originalFetch = f.client.channels.fetch;
  f.client.channels.fetch = async id => {
    if (id === f.child.id) throw new Error('child fetch failed');
    return originalFetch(id);
  };
  await assert.rejects(
    f.gateway.sendReply(stored, { id: '100', replyText: 'answer', replyNonce: 'reply-100' }),
    error => error.outcome === 'not_sent' && error.message === 'child fetch failed'
  );
  assert.equal(f.sends.length, 0);
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.UNAVAILABLE);
  assert.equal(f.state.getMessage('100').state, MESSAGE_STATES.ACCEPTED);
});

test('recover child CLI wake requests the thread-specific Gateway capability', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-cli-thread-recover-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'unused.secret') });
  const binding = state.bind({ channelId: 'parent', guildId: 'guild', provider: 'codex', nativeId: NATIVE, workspace: dir }, { intakeCutoff: '100' });
  state.enrollThread({ threadId: 'child', parentChannelId: 'parent', guildId: 'guild' , adoptionCutoff: '100'}, binding);
  state.close();
  const paths = pathsFor({ 'state-dir': dir, db });
  const cliPath = path.resolve(__dirname, '..', 'src', 'cli.js');
  const title = `${process.execPath} ${cliPath} run --state-dir ${paths.stateDir}`;
  const fakeGateway = require('node:child_process').spawn(process.execPath, ['-e',
    `process.title=${JSON.stringify(title)}; process.on('SIGUSR2', () => {}); setTimeout(() => process.exit(0), 5000);`
  ], { stdio: 'ignore' });
  fs.writeFileSync(paths.pid, JSON.stringify({
    pid: fakeGateway.pid,
    guildId: 'guild',
    stateDir: paths.stateDir,
    db: paths.db,
    command: 'run',
    startedAt: new Date().toISOString(),
    capabilities: [GATEWAY_CAPABILITIES.ordinaryBindWake]
  }), { mode: 0o600 });
  t.after(async () => {
    if (fakeGateway.exitCode === null && fakeGateway.signalCode === null) fakeGateway.kill('SIGTERM');
    if (fakeGateway.exitCode === null && fakeGateway.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { try { fakeGateway.kill('SIGKILL'); } catch {} resolve(); }, 1000);
        fakeGateway.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const statusDeadline = Date.now() + 1000;
  while (Date.now() < statusDeadline && gatewayProcessStatus(paths).state !== 'running') {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(gatewayProcessStatus(paths).state, 'running');
  const originalArgv = process.argv;
  let output = '';
  const originalWrite = process.stdout.write;
  process.argv = [process.execPath, cliPath, 'recover', '--state-dir', dir, '--db', db, '--intake-channel-id', 'child'];
  process.stdout.write = chunk => { output += String(chunk); return true; };
  try {
    await main();
  } finally {
    process.argv = originalArgv;
    process.stdout.write = originalWrite;
  }
  const result = JSON.parse(output);
  assert.deepEqual(result.gatewayWake, {
    requested: false,
    pid: fakeGateway.pid,
    state: 'running',
    reason: 'gateway-wake-unsupported',
    capability: GATEWAY_CAPABILITIES.threadEnrollmentRecoveryWake
  });
});


test('history bounds and cancellation preserve custody without touching parent', async t => {
  const f = fixture(t); f.ready('100');
  f.gateway.historyPageLimit = 1; f.gateway.historyMaxPages = 1;
  f.histories.set(f.child.id, [f.message('101'), f.message('102')]);
  const controller = new AbortController();
  await recoverThread(f.gateway, f.state.getThreadEnrollment(f.child.id), controller.signal, f.gateway.lifecycleEpoch, waitForRecoveryOperation);
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.GAP);
  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.ACCEPTED);
  assert.equal(f.state.getMessage('102'), null);
  assert.equal(f.state.getBinding(f.parent.id).readiness, READINESS.READY);
  controller.abort();
  assert.equal(await recoverThread(f.gateway, f.state.getThreadEnrollment(f.child.id), controller.signal, f.gateway.lifecycleEpoch, waitForRecoveryOperation), false);
});

test('enrollment fetched under predecessor cannot claim successor authority', async t => {
  const f = fixture(t);
  const original = f.client.channels.fetch;
  f.client.channels.fetch = async id => {
    const channel = await original(id);
    if (id === f.child.id) f.state.rebind({ channelId: f.parent.id, guildId: 'guild', provider: 'codex', nativeId: SUCCESSOR, workspace: f.dir });
    return channel;
  };
  await assert.rejects(enrollPublicThread(f.state, f.client, f.parent.id, f.child.id));
  assert.equal(f.state.getThreadEnrollment(f.child.id), null);
});

test('persisted child receipt uses child REST destination even when authority field is parent', async t => {
  const f = fixture(t); f.ready();
  await f.gateway.consumer.intakeMessage(f.message('100'), true);
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options.method });
    return { ok: true, status: 204, body: { async cancel() {} } };
  };
  try {
    f.gateway.discordToken = 'disposable-test-token';
    f.client.rest = {};
    await f.gateway.sendTransportReceipt(f.state.getMessage('100'), { reaction: '📥' });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].url.includes(`/channels/${f.child.id}/messages/100/reactions/`));
    assert.equal(requests[0].method, 'PUT');
    assert.equal(f.state.getMessage('100').channelId, f.parent.id);
  } finally {
    globalThis.fetch = originalFetch;
    f.gateway.discordToken = null;
    delete f.client.rest;
  }
});

test('child transport receipt preserves a definite not-sent lookup outcome', async t => {
  const f = fixture(t); f.ready();
  f.gateway.sendTransportReceipt = async () => {
    throw Object.assign(new Error('child lookup failed'), { outcome: 'not_sent' });
  };
  const intake = await f.gateway.consumer.intakeMessage(
    f.message('100'),
    true,
    null,
    f.state.getBinding(f.parent.id),
    true
  );
  assert.equal(intake.accepted, true);
  await f.gateway.consumer.waitForReceipts();
  assert.equal(f.state.getTransportReceipt('100').outcome.outcome, 'not_sent');
});

test('late child delivery failure cannot finish under a successor generation', async t => {
  const f = fixture(t); f.ready();
  f.gateway.boundMessage(f.message('100'));
  await Promise.all([...f.gateway.inFlight]);
  await f.gateway.consumer.waitForNativeWork();
  await f.gateway.consumer.waitForReceipts();
  const stored = f.state.getMessage('100');
  assert.equal(stored.state, MESSAGE_STATES.REPLIED);

  let startFetch;
  let rejectFetch;
  const fetchStarted = new Promise(resolve => { startFetch = resolve; });
  const originalFetch = f.client.channels.fetch;
  f.client.channels.fetch = async id => {
    if (id === f.child.id) {
      startFetch();
      return new Promise((_resolve, reject) => { rejectFetch = reject; });
    }
    return originalFetch(id);
  };
  try {
    const receipt = f.gateway.sendTransportReceipt(stored, { reaction: '👀', targetMessageId: stored.id });
    await fetchStarted;

    const original = f.state.getBinding(f.parent.id);
    const successor = f.state.rebind({ ...original, nativeId: SUCCESSOR, readiness: READINESS.READY }, { intakeCutoff: '100' });
    assert.equal(successor.generation, original.generation + 1);
    assert.equal(f.state.getThreadEnrollment(f.child.id).active, true);
    assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.READY);

    rejectFetch(new Error('late child lookup failed'));
    await assert.rejects(receipt, /late child lookup failed/);
    assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.READY);
  } finally {
    f.client.channels.fetch = originalFetch;
  }
});

test('unbound Gateway traffic does not throw or dispatch native work', async t => {
  const f = fixture(t); f.gateway.ready = true;
  const unbound = { ...f.parent, id: '3000' };
  assert.doesNotThrow(() => f.gateway.boundMessage(f.message('100', unbound)));
  await Promise.all([...f.gateway.inFlight]);
  assert.equal(f.state.getMessage('100'), null);
  assert.equal(f.dispatched.length, 0);
});

test('accepted reply survives temporary parent and child recovery readiness', async t => {
  const f = fixture(t); f.ready();
  await f.gateway.consumer.intakeMessage(f.message('100'), true);
  f.state.claimDispatch('100'); f.state.markSubmitted('100');
  f.state.recordNativeReply({ provider: 'codex', messageId: '100', nativeId: NATIVE, generation: 1, text: 'accepted answer' });
  f.state.markThreadBoundary(f.child.id, THREAD_STATES.PENDING, 'reconnect', null, null, f.state.getBinding(f.parent.id));
  f.state.setBindingReadiness(f.parent.id, READINESS.RECOVERING, 'reconnect');
  const result = await f.gateway.consumer.deliverReply(f.state.getMessage('100'), {
    status: MESSAGE_STATES.REPLY_READY, message: f.state.getMessage('100')
  });
  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  assert.ok(f.sends.some(send => send.channelId === f.child.id && send.content === 'accepted answer'));
});

test('initial adoption excludes old thread backlog without executing it', async t => {
  const f = fixture(t);
  // The qualified cutoff is acquired synchronously inside enrollPublicThread from
  // whatever history genuinely exists at that moment (D1/D6): populate the backlog
  // before enrollment so it is excluded by the committed cutoff, not by a later
  // first-recovery-page baseline step.
  f.histories.set(f.child.id, [f.message('100')]);
  await enrollPublicThread(f.state, f.client, f.parent.id, f.child.id);
  await recoverThread(f.gateway, f.state.getThreadEnrollment(f.child.id), new AbortController().signal, f.gateway.lifecycleEpoch, waitForRecoveryOperation);
  assert.equal(f.state.getMessage('100'), null);
  assert.equal(f.state.getThreadEnrollment(f.child.id).adoptedThroughId, '100');
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.READY);
  assert.equal(f.dispatched.length, 0);
});

test('empty adoption baseline retains live child custody as the history cursor', async t => {
  const f = fixture(t);
  await enrollPublicThread(f.state, f.client, f.parent.id, f.child.id);
  const binding = f.state.getBinding(f.parent.id);
  f.gateway.historyPageLimit = 1;
  let calls = 0;
  f.gateway.fetchHistory = async (_channel, options) => {
    calls += 1;
    if (calls === 1) {
      const live = f.state.acceptDiscordMessage({
        id: '101', guildId: 'guild', channelId: f.child.id, authorId: 'operator', isBot: false,
        content: 'live child question', attachments: []
      }, { ready: false, expectedBinding: binding });
      assert.equal(live.accepted, true);
      return [];
    }
    // 50 is fetched only after the empty qualified enrollment committed cutoff 0, so it
    // is prospective custody, not excluded backlog. 101 is also fetchable as ordinary
    // after-cutoff history once the page cursor reaches it, matching the live custody
    // already accepted above rather than losing it behind a stale page cursor.
    if (!options.after || options.after === '0') return [f.message('50')];
    if (options.after === '50') return [f.message('101')];
    return [];
  };
  await recoverThread(f.gateway, f.state.getThreadEnrollment(f.child.id), new AbortController().signal, f.gateway.lifecycleEpoch, waitForRecoveryOperation);
  assert.equal(f.state.getMessage('50').state, MESSAGE_STATES.ACCEPTED);
  assert.equal(f.state.getThreadEnrollment(f.child.id).recoveredThroughId, '101');
  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.ACCEPTED);
  assert.equal(f.state.getThreadEnrollment(f.child.id).adoptedThroughId, '0');
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.READY);
});

test('adoption baseline transaction keeps custody that arrives after the fetched snapshot', async t => {
  const f = fixture(t);
  // The qualified cutoff is acquired at enrollment from whatever history genuinely
  // exists then (D1/D6): 51 and 101 are the pre-enrollment backlog, excluded by the
  // committed cutoff 101. 102 arrives as concurrent custody right after the atomic
  // enrollment snapshot was persisted, and recovery reads it through an ordinary
  // after-cutoff history page, not an invented later baseline.
  f.histories.set(f.child.id, [f.message('51'), f.message('101')]);
  const enrolled = await enrollPublicThread(f.state, f.client, f.parent.id, f.child.id);
  assert.equal(enrolled.adoptedThroughId, '101');
  const binding = f.state.getBinding(f.parent.id);
  const live = f.state.acceptDiscordMessage({
    id: '102', guildId: 'guild', channelId: f.child.id, authorId: 'operator', isBot: false,
    content: 'thread question', attachments: []
  }, { ready: false, expectedBinding: binding });
  assert.equal(live.accepted, true);
  // 102 is also fetchable as ordinary after-cutoff history by the time recovery reads
  // it, matching the live gateway event above rather than losing it behind a stale
  // page cursor or an invented later baseline.
  f.histories.set(f.child.id, [...f.histories.get(f.child.id), f.message('102')]);
  const result = await recoverThread(
    f.gateway,
    f.state.getThreadEnrollment(f.child.id),
    new AbortController().signal,
    f.gateway.lifecycleEpoch,
    waitForRecoveryOperation
  );
  const enrollment = f.state.getThreadEnrollment(f.child.id);
  assert.equal(result, true);
  assert.equal(enrollment.adoptedThroughId, '101');
  assert.equal(enrollment.recoveredThroughId, '102');
  assert.equal(f.state.getMessage('51'), null);
  assert.equal(f.state.getMessage('101'), null);
  assert.equal(f.state.getMessage('102').state, MESSAGE_STATES.ACCEPTED);
});

test('missing or invalid history reader cannot falsely prove an empty ready thread', async t => {
  const f = fixture(t);
  // A missing/invalid reader must be exercised before enrollment, since the qualified
  // cutoff is now acquired synchronously inside enrollPublicThread (D1/D6). Enrolling
  // successfully and then injecting a reader failure is a distinct, already-covered
  // recovery scenario, not this pre-activation empty-proof claim.
  delete f.child.messages;
  const watermarkBefore = f.state.getIntakeWatermark(f.parent.id);
  await assert.rejects(
    enrollPublicThread(f.state, f.client, f.parent.id, f.child.id),
    error => error instanceof AdoptionRefusalError && error.detail === ADOPTION_REFUSAL_DETAILS.READER
  );
  assert.equal(f.state.getThreadEnrollment(f.child.id), null);
  assert.equal(f.state.getBinding(f.parent.id).readiness, READINESS.READY);
  assert.deepEqual(f.state.getIntakeWatermark(f.parent.id), watermarkBefore);
});
