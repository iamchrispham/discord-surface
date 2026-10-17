'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { presentDecision } = require('../src/decision-present');
const { DiscordGateway } = require('../src/discord');
const { encodeDecisionCustomId } = require('../src/discord-interaction');
const { createDecisionConsumer, parseDecisionComponent, renderDecisionProjection } = require('../src/discord/decision');
const { READINESS, SurfaceState } = require('../src/state');

const NATIVE_ID = '9caa5d21-2169-429d-918b-5f08651b5dbd';

async function fixture(t, { callback = null, question: prompt = 'Choose the canonical answer' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-decision-gateway-'));
  const db = path.join(dir, 'surface.sqlite');
  const secretFile = path.join(dir, 'discord.secret');
  fs.writeFileSync(secretFile, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  let state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile });
  const binding = state.bindOrdinary({
    channelId: 'channel', guildId: 'guild', provider: 'codex', nativeId: NATIVE_ID, workspace: dir
  }, { sessionId: NATIVE_ID, threadId: NATIVE_ID }, '100');
  state.recordOrdinaryPreflight(binding, {
    file: path.join(dir, 'fixture.jsonl'), sessionId: NATIVE_ID, threadId: NATIVE_ID, workspace: dir
  });
  state.setBindingReadiness('channel', READINESS.READY);

  const request = {
    namespace: 'discord-gateway',
    requestId: `gateway-${path.basename(dir)}`,
    target: 'run:discord-gateway',
    head: '-',
    question: prompt,
    menu: [{ key: 'approve', consequence: 'apply the saved choice' }, 'hold'],
    channelId: 'channel',
    provider: 'codex',
    nativeId: NATIVE_ID,
    generation: 1
  };
  const canonical = {
    stateRoot: path.join(dir, 'canonical-state'),
    environment: {
      TELEGRAM_ROOT: path.join(dir, 'canonical-telegram'),
      TG_CANONICAL_STATE_ROOT: undefined
    }
  };
  const posts = [];
  const presentation = await presentDecision({
    state,
    request,
    token: 'fixture-token',
    canonical,
    authorizeOrdinary: async () => {},
    fetchImpl: async (_url, options) => {
      posts.push(JSON.parse(options.body));
      return { ok: true, status: 200, async json() { return { id: 'question-message' }; } };
    }
  });

  const edits = [];
  const callbacks = [];
  const dispatches = [];
  const question = {
    id: presentation.messageId,
    async edit(payload) { edits.push(payload); return { id: presentation.messageId, ...payload }; }
  };
  const channel = {
    id: 'channel',
    messages: { async fetch(messageId) { assert.equal(messageId, presentation.messageId); return question; } },
    async send(payload) { return { id: `reply-${payload.nonce || edits.length}` }; }
  };
  const listeners = new Map();
  const client = {
    application: { id: 'application', commands: null },
    channels: { async fetch(channelId) { assert.equal(channelId, 'channel'); return channel; } },
    on(name, listener) { listeners.set(name, listener); },
    off(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
    async destroy() {}
  };
  const createGateway = currentState => new DiscordGateway({
    state: currentState,
    client,
    providers: {
      codex: {
        async dispatch(message) { dispatches.push(message); return { status: 'submitted' }; }
      }
    },
    interactionFetch: async (url, options) => {
      callbacks.push({ url, body: JSON.parse(options.body) });
      if (callback) return callback(url, options);
      return { ok: true, status: 204, body: { async cancel() {} } };
    }
  });
  let gateway = createGateway(state);
  t.after(async () => {
    await gateway.stop();
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const result = { dir, db, state, request, presentation, posts, edits, callbacks, dispatches, gateway, listeners };
  result.reopen = async () => {
    await gateway.stop();
    state.close();
    state = new SurfaceState(db);
    gateway = createGateway(state);
    result.state = state;
    result.gateway = gateway;
    return result;
  };
  return result;
}

function component(presentation, id, selectedIndex, overrides = {}) {
  return {
    type: 3,
    id,
    applicationId: 'application',
    guildId: 'guild',
    channelId: 'channel',
    token: `token-${id}`,
    user: { id: 'operator' },
    message: { id: presentation.messageId },
    componentType: 2,
    customId: encodeDecisionCustomId(presentation.qid, selectedIndex),
    ...overrides
  };
}

function decisionMessages(state) {
  return state.listMessages().filter(message => message.decisionResult);
}

function assertDecisionProjection(payload, presentation, answer) {
  assert.equal(payload.content, presentation.content);
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].title, 'Selected action');
  assert.equal(payload.embeds[0].description, answer);
  assert.deepEqual(payload.components, []);
  assert.deepEqual(payload.attachments, []);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(payload.files, undefined);
}

async function waitForCondition(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setImmediate(resolve));
  }
}

const HISTORICAL_DECISION_KINDS = Object.freeze({
  PRESENTATION: 'decision-presentation',
  PRESENTATION_OUTCOME: 'decision-presentation-outcome',
  PRESENTATION_STALE: 'decision-presentation-stale',
  CLICK: 'decision-click',
  AUTHORIZATION_OUTCOME: 'decision-authorization-outcome',
  CLICK_STALE: 'decision-click-stale',
  CALLBACK_ATTEMPT: 'decision-callback-attempt',
  CALLBACK_OUTCOME: 'decision-callback-outcome',
  REJECTION_ATTEMPT: 'decision-rejection-attempt',
  REJECTION_OUTCOME: 'decision-rejection-outcome',
  TOKEN_RELEASE: 'decision-token-release',
  CANONICAL_IMPORT: 'decision-canonical-import',
  PROJECTION_OUTCOME: 'decision-projection-outcome',
  NATIVE_RETURN: 'decision-native-return',
  NATIVE_OUTCOME: 'decision-native-outcome'
});

const HISTORICAL_MARKER_KINDS = Object.freeze([
  HISTORICAL_DECISION_KINDS.AUTHORIZATION_OUTCOME,
  HISTORICAL_DECISION_KINDS.CLICK_STALE,
  HISTORICAL_DECISION_KINDS.REJECTION_ATTEMPT,
  HISTORICAL_DECISION_KINDS.REJECTION_OUTCOME,
  HISTORICAL_DECISION_KINDS.TOKEN_RELEASE
]);

// Historical fixture helpers write only to disposable state through its receipt interface.
function historicalAppend(state, kind, detail) {
  state.receipt(null, kind, { journal: 'decision-v1', ...detail });
}

function historicalClickOutput(state, interactionId) {
  return state.getDecisionClick(interactionId) ||
    state.listDecisionPendingWork().find(click => click.interactionId === interactionId) || null;
}

function historicalClickFor(state, interactionId) {
  const click = historicalClickOutput(state, interactionId);
  if (!click) return null;
  const rows = state.db.prepare('SELECT detail FROM receipts WHERE kind = ? ORDER BY id')
    .all(HISTORICAL_DECISION_KINDS.CLICK);
  for (const row of rows) {
    let detail;
    try { detail = JSON.parse(row.detail); } catch { continue; }
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) continue;
    if (detail.interactionId === interactionId) {
      return {
        ...click,
        applicationId: detail.applicationId ?? null,
        token: detail.token ?? null
      };
    }
  }
  return click;
}

function sameHistoricalBinding(left, right) {
  const fields = [
    'active', 'readiness', 'channelId', 'guildId', 'provider', 'nativeId', 'workspace',
    'sessionRoot', 'endpoint', 'conductorId', 'repoKey', 'generation'
  ];
  return Boolean(left && right && fields.every(field => left[field] === right[field]));
}

function historicalClickInput(rawInput, tokenBearing) {
  const input = {
    interactionId: rawInput.interactionId,
    presentationId: rawInput.presentationId,
    selectedKey: rawInput.selectedKey,
    actorId: rawInput.actorId,
    guildId: rawInput.guildId,
    channelId: rawInput.channelId,
    messageId: rawInput.messageId,
    binding: rawInput.binding,
    ...(rawInput.applicationId === undefined ? {} : { applicationId: rawInput.applicationId })
  };
  if (tokenBearing && rawInput.token !== undefined) input.token = rawInput.token;
  return input;
}

function createHistoricalDecisionWriters({ tokenBearing = false } = {}) {
  function admitClickInTransaction(state, input, beginCallback, authorizationPending) {
    if (historicalClickFor(state, input.interactionId)) {
      return { accepted: false, duplicate: true, click: historicalClickOutput(state, input.interactionId) };
    }
    const presentation = state.getDecisionPresentation(input.presentationId);
    if (!presentation) return { accepted: false, click: null };
    const config = state.requireConfig();
    if (presentation.state === 'stale' || presentation.state === 'refused' ||
      presentation.presentationOutcome !== 'sent' || input.guildId !== config.guildId ||
      input.actorId !== config.operatorId || input.actorId !== presentation.operatorId ||
      input.guildId !== presentation.guildId || input.channelId !== presentation.channelId ||
      input.messageId !== presentation.messageId || !presentation.messageId ||
      !presentation.keys.includes(input.selectedKey) ||
      !sameHistoricalBinding(input.binding, presentation.binding) ||
      !sameHistoricalBinding(state.getBinding(presentation.channelId), presentation.binding)) {
      return { accepted: false, click: null };
    }
    historicalAppend(state, HISTORICAL_DECISION_KINDS.CLICK, {
      interactionId: input.interactionId,
      presentationId: input.presentationId,
      selectedKey: input.selectedKey,
      actorId: input.actorId,
      guildId: input.guildId,
      channelId: input.channelId,
      messageId: input.messageId,
      binding: presentation.binding,
      ...(input.applicationId ? { applicationId: input.applicationId } : {}),
      ...(input.token ? { token: input.token } : {}),
      ...(authorizationPending ? { authorizationPending: true } : {})
    });
    if (beginCallback) historicalAppend(state, HISTORICAL_DECISION_KINDS.CALLBACK_ATTEMPT, { interactionId: input.interactionId });
    return { accepted: true, click: historicalClickOutput(state, input.interactionId) };
  }

  function admitClickAndBeginAuthorization(state, rawInput) {
    const input = historicalClickInput(rawInput, tokenBearing);
    return state.transaction(() => admitClickInTransaction(state, input, true, true));
  }

  function admitClickAndBeginCallback(state, rawInput) {
    const input = historicalClickInput(rawInput, false);
    return state.transaction(() => admitClickInTransaction(state, input, true, false));
  }

  function admitClick(state, rawInput) {
    const input = historicalClickInput(rawInput, tokenBearing);
    return state.transaction(() => admitClickInTransaction(state, input, false, false));
  }

  function writeAuthorizationOutcome(state, click, outcome) {
    historicalAppend(state, HISTORICAL_DECISION_KINDS.AUTHORIZATION_OUTCOME, {
      interactionId: click.interactionId,
      outcome
    });
    if (outcome === 'authorized' && click.token) {
      historicalAppend(state, HISTORICAL_DECISION_KINDS.TOKEN_RELEASE, { interactionId: click.interactionId });
    }
    return historicalClickOutput(state, click.interactionId);
  }

  function recordAuthorizationOutcome(state, interactionId, outcome) {
    const click = historicalClickFor(state, interactionId);
    if (!click || click.state !== 'authorization_pending' || click.authorizationOutcome) {
      return { accepted: false, click: historicalClickOutput(state, interactionId) };
    }
    let recordedOutcome = outcome;
    if (outcome === 'authorized' && !sameHistoricalBinding(state.getBinding(click.channelId), click.binding)) {
      recordedOutcome = 'denied';
    }
    return state.transaction(() => ({
      accepted: true,
      click: writeAuthorizationOutcome(state, click, recordedOutcome)
    }));
  }

  function reconcileClickBinding(state, interactionId) {
    return state.transaction(() => {
      const click = historicalClickFor(state, interactionId);
      if (!click) return { binding: null, click: null };
      const binding = state.getBinding(click.channelId);
      if (sameHistoricalBinding(binding, click.binding)) return { binding, click: historicalClickOutput(state, interactionId) };
      if (click.authorizationOutcome === null) {
        if (click.state !== 'authorization_pending') return { binding: null, click: historicalClickOutput(state, interactionId) };
        return { binding: null, click: writeAuthorizationOutcome(state, click, 'denied') };
      }
      if (click.authorizationOutcome !== 'authorized' ||
        (click.nativeReturn && click.nativeReturn.outcome !== null && click.nativeReturn.outcome !== 'not_submitted')) {
        return { binding: null, click: historicalClickOutput(state, interactionId) };
      }
      historicalAppend(state, HISTORICAL_DECISION_KINDS.CLICK_STALE, { interactionId });
      if (click.token) historicalAppend(state, HISTORICAL_DECISION_KINDS.TOKEN_RELEASE, { interactionId });
      return { binding: null, click: historicalClickOutput(state, interactionId) };
    });
  }

  function beginRejectionFollowup(state, interactionId) {
    const click = historicalClickFor(state, interactionId);
    if (!click || click.authorizationOutcome !== 'denied' || click.rejectionAttempted) {
      return { accepted: false, click: historicalClickOutput(state, interactionId) };
    }
    return state.transaction(() => {
      historicalAppend(state, HISTORICAL_DECISION_KINDS.REJECTION_ATTEMPT, { interactionId });
      return { accepted: true, click: historicalClickOutput(state, interactionId) };
    });
  }

  function recordRejectionOutcome(state, interactionId, outcome) {
    const click = historicalClickFor(state, interactionId);
    if (!click || click.authorizationOutcome !== 'denied' || !click.rejectionAttempted || click.rejectionOutcome !== null) {
      return { accepted: false, click: historicalClickOutput(state, interactionId) };
    }
    return state.transaction(() => {
      historicalAppend(state, HISTORICAL_DECISION_KINDS.REJECTION_OUTCOME, { interactionId, outcome });
      if (outcome === 'sent' || outcome === 'rejected' || (outcome === 'unknown' && click.callbackOutcome !== 'sent')) {
        if (click.token) historicalAppend(state, HISTORICAL_DECISION_KINDS.TOKEN_RELEASE, { interactionId });
      }
      return { accepted: true, click: historicalClickOutput(state, interactionId) };
    });
  }

  return {
    admitClick,
    admitClickAndBeginCallback,
    admitClickAndBeginAuthorization,
    beginRejectionFollowup,
    recordAuthorizationOutcome,
    recordRejectionOutcome,
    reconcileClickBinding
  };
}

function historicalImportWinnerAndQueueNativeReturn(state, interactionId, answer = 'approve') {
  const click = historicalClickFor(state, interactionId);
  assert.ok(click);
  const presentation = state.getDecisionPresentation(click.presentationId);
  const canonical = {
    qid: presentation.qid,
    questionGeneration: presentation.questionGeneration,
    target: presentation.target,
    source: 'current',
    materialized: true,
    reference: `fixture:${interactionId}`,
    answer
  };
  state.transaction(() => {
    historicalAppend(state, HISTORICAL_DECISION_KINDS.CANONICAL_IMPORT, { interactionId, ...canonical });
    const current = historicalClickOutput(state, interactionId);
    const result = state.acceptDecisionInteraction({
      interactionId: current.interactionId,
      presentationId: current.presentationId,
      selectedKey: current.selectedKey,
      actorId: current.actorId,
      guildId: current.guildId,
      channelId: current.channelId,
      questionMessageId: current.messageId,
      binding: current.binding,
      qid: canonical.qid,
      questionGeneration: canonical.questionGeneration,
      target: canonical.target,
      canonicalSource: canonical.source,
      canonicalReference: canonical.reference,
      answer: canonical.answer
    }, { inTransaction: true });
    assert.ok(result.accepted || result.duplicate);
    historicalAppend(state, HISTORICAL_DECISION_KINDS.NATIVE_RETURN, {
      interactionId,
      presentationId: current.presentationId,
      selectedKey: current.selectedKey,
      questionMessageId: current.messageId,
      qid: canonical.qid,
      questionGeneration: canonical.questionGeneration,
      target: canonical.target,
      canonicalSource: canonical.source,
      answer: canonical.answer,
      provider: current.binding.provider,
      nativeId: current.binding.nativeId,
      generation: current.binding.generation,
      channelId: current.binding.channelId,
      guildId: current.binding.guildId,
      workspace: current.binding.workspace,
      conductorId: current.binding.conductorId,
      repoKey: current.binding.repoKey,
      canonicalReference: canonical.reference
    });
  });
}

function rawJournalSnapshot(state) {
  const rows = state.db.prepare('SELECT id, kind, detail FROM receipts ORDER BY id').all();
  const bytes = rows.map(row => `${row.id}\0${row.kind}\0${row.detail}`).join('\n');
  return { count: rows.length, digest: crypto.createHash('sha256').update(bytes, 'utf8').digest('hex') };
}

function rawClickDetail(state, interactionId) {
  const rows = state.db.prepare('SELECT detail FROM receipts WHERE kind = ? ORDER BY id')
    .all(HISTORICAL_DECISION_KINDS.CLICK);
  for (const row of rows) {
    let detail;
    try { detail = JSON.parse(row.detail); } catch { continue; }
    if (detail?.interactionId === interactionId) return detail;
  }
  return null;
}

function historicalInput(f, interactionId, selectedKey = 'approve', extra = {}) {
  return {
    interactionId,
    presentationId: f.presentation.presentationId,
    selectedKey,
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel'),
    ...extra
  };
}

function createCompatibilityTestConsumer(f, counters, processAccepted = async () => {
  counters.native += 1;
  return { status: 'not_submitted' };
}) {
  return createDecisionConsumer({
    state: f.state,
    callbackTimeoutMs: 100,
    interactionFetch: async () => {
      counters.callbacks += 1;
      return { ok: true, status: 204, body: { async cancel() {} } };
    },
    waitForDispatch: async () => true,
    resolveRoute: async ({ executable, stateRoot, environment }) => {
      counters.canonical += 1;
      return {
        replay: {
          executable,
          stateRoot,
          telegramRoot: environment.TELEGRAM_ROOT
        }
      };
    },
    runCanonical: async (_route, operation, input) => {
      counters.canonical += 1;
      const questionGeneration = input.generation || input.questionGeneration;
      return {
        status: 'complete',
        payload: {
          ok: true,
          winner: { source: 'current', materialized: true },
          canonical_reference: {
            evidence_name: 'fixture-evidence',
            qid: input.qid,
            question_generation: questionGeneration
          },
          answer: 'approve',
          operation
        }
      };
    },
    processAccepted,
    project: async () => { counters.project += 1; }
  });
}

function assertNoToken(value, token) {
  assert.equal(JSON.stringify(value).includes(token), false);
}

function compatibilityMarkerFor(state, interactionId) {
  return state.listReceipts().some(row => {
    let detail;
    try { detail = JSON.parse(row.detail); } catch { return false; }
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return false;
    return detail.interactionId === interactionId && (
      HISTORICAL_MARKER_KINDS.includes(row.kind) ||
      (row.kind === HISTORICAL_DECISION_KINDS.CLICK && detail.authorizationPending === true)
    );
  });
}

function assertDecisionHistoryReadOnly(state, interactionId) {
  const before = rawJournalSnapshot(state);
  assert.throws(() => state.importDecisionWinner(interactionId, {
    qid: 'fixture-qid',
    questionGeneration: 'fixture-generation',
    target: 'fixture-target',
    source: 'current',
    materialized: true,
    reference: 'fixture-materialized',
    answer: 'approve'
  }), /historical decision is read-only/);
  assert.throws(() => state.importDecisionWinner(interactionId, {
    qid: 'fixture-qid',
    questionGeneration: 'fixture-generation',
    target: 'fixture-target',
    source: 'claim',
    materialized: false,
    reference: 'fixture-claim'
  }), /historical decision is read-only/);
  assert.throws(() => state.queueDecisionNativeReturn(interactionId), /historical decision is read-only/);
  assert.deepEqual(rawJournalSnapshot(state), before);
}

test('baseline old-kind histories reopen with baseline click and effect state', { timeout: 30000 }, async t => {
  const baselineWriters = createHistoricalDecisionWriters();
  const paired = await fixture(t);
  const baselineAdmission = baselineWriters.admitClickAndBeginCallback(
    paired.state, historicalInput(paired, 'h1-baseline-writer'));
  const currentAdmission = paired.state.admitDecisionClickAndBeginCallback(
    historicalInput(paired, 'h1-current-writer'));
  assert.equal(baselineAdmission.accepted, true);
  assert.equal(currentAdmission.accepted, true);
  const normalizeAdmissionRows = interactionId => paired.state.listReceipts()
    .filter(row => row.kind === HISTORICAL_DECISION_KINDS.CLICK || row.kind === HISTORICAL_DECISION_KINDS.CALLBACK_ATTEMPT)
    .filter(row => JSON.parse(row.detail).interactionId === interactionId)
    .map(row => ({ kind: row.kind, detail: { ...JSON.parse(row.detail), interactionId: '<id>' } }));
  assert.deepEqual(normalizeAdmissionRows('h1-baseline-writer'), normalizeAdmissionRows('h1-current-writer'));
  const presentation = paired.state.getDecisionPresentation(paired.presentation.presentationId);
  for (const id of ['h1-baseline-writer', 'h1-current-writer']) {
    assert.equal(paired.state.recordDecisionCallbackOutcome(id, 'sent').accepted, true);
    assert.equal(paired.state.importDecisionWinner(id, {
      qid: presentation.qid,
      questionGeneration: presentation.questionGeneration,
      target: presentation.target,
      source: 'current',
      materialized: true,
      reference: `fixture:${id}`,
      answer: 'approve'
    }).accepted, true);
  }
  const pairedReceipts = paired.state.listReceipts().map(row => ({ kind: row.kind, detail: JSON.parse(row.detail) }));
  assert.equal(pairedReceipts.filter(row => row.kind === HISTORICAL_DECISION_KINDS.CALLBACK_OUTCOME).length, 2);
  assert.equal(pairedReceipts.filter(row => row.kind === HISTORICAL_DECISION_KINDS.CANONICAL_IMPORT).length, 2);
  assert.equal(pairedReceipts.filter(row => row.kind === HISTORICAL_DECISION_KINDS.NATIVE_RETURN).length, 1);
  const pairedBefore = rawJournalSnapshot(paired.state);
  await paired.reopen();
  for (const id of ['h1-baseline-writer', 'h1-current-writer']) {
    assert.equal(paired.state.getDecisionClick(id).canonical.answer, 'approve');
    assert.equal(compatibilityMarkerFor(paired.state, id), false);
  }
  assert.deepEqual(rawJournalSnapshot(paired.state), pairedBefore);

  for (const nativeOutcome of ['in_flight', 'unknown', 'not_submitted', 'submitted', 'rejected']) {
    const f = await fixture(t);
    const id = `h1-${nativeOutcome}`;
    const presentation = f.state.getDecisionPresentation(f.presentation.presentationId);
    assert.equal(f.state.admitDecisionClickAndBeginCallback(historicalInput(f, id)).accepted, true);
    f.state.recordDecisionCallbackOutcome(id, 'unknown');
    assert.equal(f.state.importDecisionWinner(id, {
      qid: presentation.qid,
      questionGeneration: presentation.questionGeneration,
      target: presentation.target,
      source: 'current',
      materialized: true,
      reference: `fixture:${id}`,
      answer: 'approve'
    }).accepted, true);
    for (const projectionOutcome of ['unknown', 'not_sent', 'rate_limited']) {
      f.state.recordDecisionProjectionOutcome(id, projectionOutcome);
      assert.equal(f.state.getDecisionClick(id).projectionOutcome, projectionOutcome);
    }
    f.state.recordDecisionNativeReturnOutcome(id, nativeOutcome);
    const before = rawJournalSnapshot(f.state);
    assert.equal(compatibilityMarkerFor(f.state, id), false);
    await f.reopen();
    const click = f.state.getDecisionClick(id);
    assert.equal(click.callbackOutcome, 'unknown');
    assert.equal(click.canonical.answer, 'approve');
    assert.equal(click.projectionOutcome, 'rate_limited');
    assert.equal(click.nativeReturn.outcome, nativeOutcome);
    assert.equal(compatibilityMarkerFor(f.state, id), false);
    assert.deepEqual(rawJournalSnapshot(f.state), before);
  }
});

test('pre-cut authorization histories preserve pending custody and both callback orders', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const writers = createHistoricalDecisionWriters();
  const pendingId = 'h2-pending';
  const authorizedId = 'h3-authorized';
  const deniedId = 'h3-denied';
  const deniedFirstId = 'h3-denied-before-callback';
  for (const id of [pendingId, authorizedId, deniedId, deniedFirstId]) {
    assert.equal(writers.admitClickAndBeginAuthorization(f.state, historicalInput(f, id)).accepted, true);
  }
  f.state.recordDecisionCallbackOutcome(pendingId, 'unknown');
  f.state.recordDecisionCallbackOutcome(authorizedId, 'sent');
  assert.equal(writers.recordAuthorizationOutcome(f.state, authorizedId, 'authorized').accepted, true);
  assert.equal(writers.recordAuthorizationOutcome(f.state, deniedId, 'denied').accepted, true);
  f.state.recordDecisionCallbackOutcome(deniedId, 'unknown');
  assert.equal(writers.recordAuthorizationOutcome(f.state, deniedFirstId, 'denied').accepted, true);
  f.state.recordDecisionCallbackOutcome(deniedFirstId, 'unknown');
  await f.reopen();

  const pending = f.state.getDecisionClick(pendingId);
  assert.equal(pending.state, 'authorization_pending');
  assert.equal(pending.callbackOutcome, 'unknown');
  assert.ok(f.state.listDecisionPendingWork().some(click => click.interactionId === pendingId));
  const authorized = f.state.getDecisionClick(authorizedId);
  assert.equal(authorized.authorizationOutcome, 'authorized');
  assert.equal(authorized.callbackOutcome, 'sent');
  assert.ok(f.state.listDecisionPendingWork().some(click => click.interactionId === authorizedId));
  for (const id of [deniedId, deniedFirstId]) {
    assert.equal(f.state.getDecisionClick(id), null);
    assert.ok(f.state.listDecisionPendingWork().some(click => click.interactionId === id));
    assert.equal(compatibilityMarkerFor(f.state, id), true);
  }
  assert.deepEqual(rawJournalSnapshot(f.state), before);
  for (const id of [pendingId, authorizedId, deniedId, deniedFirstId]) {
    assertDecisionHistoryReadOnly(f.state, id);
  }
});

test('pre-cut rejection outcomes and interrupted attempts retain their exact reopened state', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const writers = createHistoricalDecisionWriters();
  const outcomes = ['not_sent', 'rate_limited', 'unknown', 'sent', 'rejected'];
  for (const outcome of outcomes) {
    const id = `h4-${outcome}`;
    assert.equal(writers.admitClickAndBeginAuthorization(f.state, historicalInput(f, id)).accepted, true);
    assert.equal(writers.recordAuthorizationOutcome(f.state, id, 'denied').accepted, true);
    f.state.recordDecisionCallbackOutcome(id, outcome === 'unknown' ? 'sent' : 'unknown');
    assert.equal(writers.beginRejectionFollowup(f.state, id).accepted, true);
    assert.equal(writers.recordRejectionOutcome(f.state, id, outcome).accepted, true);
  }
  const interruptedId = 'h4-interrupted-rejection';
  assert.equal(writers.admitClickAndBeginAuthorization(f.state, historicalInput(f, interruptedId)).accepted, true);
  assert.equal(writers.recordAuthorizationOutcome(f.state, interruptedId, 'denied').accepted, true);
  assert.equal(writers.beginRejectionFollowup(f.state, interruptedId).accepted, true);
  const before = rawJournalSnapshot(f.state);
  await f.reopen();

  for (const outcome of outcomes) {
    const id = `h4-${outcome}`;
    const receipts = f.state.listReceipts().map(row => ({ kind: row.kind, detail: JSON.parse(row.detail) }))
      .filter(row => row.detail.interactionId === id);
    assert.ok(receipts.some(row => row.kind === HISTORICAL_DECISION_KINDS.REJECTION_OUTCOME && row.detail.outcome === outcome));
    assert.equal(f.state.getDecisionClick(id), null);
    assert.equal(compatibilityMarkerFor(f.state, id), true);
    const isRetryable = outcome === 'not_sent' || outcome === 'rate_limited' || outcome === 'unknown';
    assert.equal(f.state.listDecisionPendingWork().some(click => click.interactionId === id), isRetryable);
  }
  assert.equal(f.state.getDecisionClick(interruptedId), null);
  const interrupted = f.state.listDecisionPendingWork().find(click => click.interactionId === interruptedId);
  assert.equal(interrupted.rejectionAttempted, true);
  assert.equal(interrupted.rejectionOutcome, null);
  assert.deepEqual(rawJournalSnapshot(f.state), before);
  assertDecisionHistoryReadOnly(f.state, 'h4-sent');
  assertDecisionHistoryReadOnly(f.state, 'h4-rejected');
});

test('historical markers hold both real decision replay entrypoints and exact generic interactions', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const writers = createHistoricalDecisionWriters();
  const pendingId = 'h10-pending';
  const completedId = 'h10-completed-denial';
  assert.equal(writers.admitClickAndBeginAuthorization(f.state, historicalInput(f, pendingId)).accepted, true);
  assert.equal(writers.admitClickAndBeginAuthorization(f.state, historicalInput(f, completedId)).accepted, true);
  assert.equal(writers.recordAuthorizationOutcome(f.state, completedId, 'denied').accepted, true);
  assert.equal(writers.beginRejectionFollowup(f.state, completedId).accepted, true);
  assert.equal(writers.recordRejectionOutcome(f.state, completedId, 'sent').accepted, true);
  for (const id of [pendingId, completedId, 'h10-unrelated-sibling']) {
    const accepted = f.state.acceptDiscordMessage({
      id,
      guildId: 'guild',
      channelId: 'channel',
      authorId: 'operator',
      isBot: false,
      attachments: [],
      content: `accepted ${id}`
    });
    assert.equal(accepted.accepted, true);
  }
  const before = rawJournalSnapshot(f.state);
  await f.reopen();
  assert.equal(f.state.getDecisionClick(completedId), null);
  assert.ok(!f.state.listDecisionPendingWork().some(click => click.interactionId === completedId));
  for (const id of [pendingId, completedId]) assertDecisionHistoryReadOnly(f.state, id);
  const beforeDecisionReplay = rawJournalSnapshot(f.state);

  const counters = { callbacks: 0, canonical: 0, native: 0, project: 0 };
  const decisionConsumer = createCompatibilityTestConsumer(f, counters);
  const parsed = parseDecisionComponent(component(f.presentation, pendingId, 0), 'application');
  const handled = await decisionConsumer.handleParsed(parsed);
  assert.equal(handled.continuing, true);
  const remaining = await decisionConsumer.recover(new AbortController().signal);
  assert.ok(remaining.some(click => click.interactionId === pendingId));
  assert.equal(counters.callbacks, 0);
  assert.equal(counters.canonical, 0);
  assert.equal(counters.native, 0);
  assert.equal(counters.project, 0);
  assert.deepEqual(rawJournalSnapshot(f.state), beforeDecisionReplay);

  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  await f.gateway.reconcilePending();
  assert.deepEqual(f.dispatches.map(message => message.id), ['h10-unrelated-sibling']);
  assert.equal(f.state.getMessage(pendingId).state, 'accepted');
  assert.equal(f.state.getMessage(completedId).state, 'accepted');
  const markedNativeRows = f.state.listReceipts().map(row => ({ kind: row.kind, detail: JSON.parse(row.detail) }))
    .filter(row => [pendingId, completedId].includes(row.detail.interactionId) &&
      row.kind === HISTORICAL_DECISION_KINDS.NATIVE_RETURN);
  assert.deepEqual(markedNativeRows, []);
});

test('CLICK_STALE holds only its exact interaction while unrelated work keeps baseline admission', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const writers = createHistoricalDecisionWriters();
  const staleId = 'h5-stale-click';
  assert.equal(writers.admitClickAndBeginAuthorization(f.state, historicalInput(f, staleId)).accepted, true);
  assert.equal(writers.recordAuthorizationOutcome(f.state, staleId, 'authorized').accepted, true);
  f.state.setBindingReadiness('channel', READINESS.PENDING);
  writers.reconcileClickBinding(f.state, staleId);
  assert.ok(f.state.listReceipts().some(row => row.kind === HISTORICAL_DECISION_KINDS.CLICK_STALE));
  f.state.setBindingReadiness('channel', READINESS.READY);
  for (const id of [staleId, 'h5-unrelated-native-work']) {
    assert.equal(f.state.acceptDiscordMessage({
      id,
      guildId: 'guild',
      channelId: 'channel',
      authorId: 'operator',
      isBot: false,
      attachments: [],
      content: `accepted ${id}`
    }).accepted, true);
  }
  await f.reopen();
  assert.equal(compatibilityMarkerFor(f.state, staleId), true);
  assert.equal(compatibilityMarkerFor(f.state, 'h5-unrelated-native-work'), false);
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  await f.gateway.reconcilePending();
  assert.deepEqual(f.dispatches.map(message => message.id), ['h5-unrelated-native-work']);
});

test('a later valid click on the same presentation passes its own baseline checks', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const writers = createHistoricalDecisionWriters();
  const heldId = 'h7-held-click';
  const laterId = 'h7-later-valid-click';
  assert.equal(writers.admitClickAndBeginAuthorization(f.state, historicalInput(f, heldId)).accepted, true);
  const counters = { callbacks: 0, canonical: 0, native: 0, project: 0 };
  const consumer = createCompatibilityTestConsumer(
    f,
    counters,
    (message, signal, options) => f.gateway.consumer.processAccepted(message, signal, options)
  );
  const parsed = parseDecisionComponent(component(f.presentation, laterId, 0), 'application');
  const result = await consumer.handleParsed(parsed);
  assert.equal(result.accepted, true);
  assert.equal(counters.callbacks, 1);
  assert.ok(counters.canonical > 0);
  assert.equal(counters.project, 1);
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.state.getDecisionClick(laterId).canonical.answer, 'approve');
  assert.equal(f.state.getDecisionClick(laterId).nativeReturn.outcome, 'submitted');
  assert.equal(compatibilityMarkerFor(f.state, heldId), true);
  assert.equal(compatibilityMarkerFor(f.state, laterId), false);
});

test('applicationId alone does not classify an old-kind-only click as historical', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const writers = createHistoricalDecisionWriters();
  const id = 'h11-application-id-only';
  assert.equal(writers.admitClick(f.state, historicalInput(f, id, 'approve', {
    applicationId: 'token-shaped-application-id'
  })).accepted, true);
  await f.reopen();
  assert.equal(compatibilityMarkerFor(f.state, id), false);
  assert.equal(f.state.getDecisionClick(id).applicationId, 'token-shaped-application-id');
  const counters = { callbacks: 0, canonical: 0, native: 0, project: 0 };
  const consumer = createCompatibilityTestConsumer(f, counters);
  await consumer.recover(new AbortController().signal);
  assert.equal(counters.canonical > 0, true);
  assert.equal(counters.callbacks, 0);
  assert.equal(f.state.getDecisionClick(id).canonical.answer, 'approve');
});

test('qualified token history stays readable while every returned view remains redacted', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const token = 'synthetic-history-token-H6-H15';
  const historical = createHistoricalDecisionWriters({ tokenBearing: true });
  const id = 'h6-token-history';
  const admission = historical.admitClickAndBeginAuthorization(f.state, historicalInput(f, id, 'approve', {
    applicationId: 'application',
    token
  }));
  const callback = f.state.recordDecisionCallbackOutcome(id, 'unknown');
  const authorization = historical.recordAuthorizationOutcome(f.state, id, 'authorized');
  assert.equal(admission.accepted, true);
  assert.equal(authorization.accepted, true);
  assertNoToken(admission, token);
  assertNoToken(callback, token);
  assertNoToken(authorization, token);
  const beforeReads = rawJournalSnapshot(f.state);
  const rawClick = rawClickDetail(f.state, id);
  assert.equal(rawClick.token === token, true);
  assert.ok(f.state.listReceipts().some(row => row.kind === HISTORICAL_DECISION_KINDS.TOKEN_RELEASE &&
    JSON.parse(row.detail).interactionId === id));
  await f.reopen();

  const click = f.state.getDecisionClick(id);
  const pending = f.state.listDecisionPendingWork().filter(item => item.interactionId === id);
  const listedRows = f.state.listReceipts();
  const listedClick = listedRows.find(row => row.kind === HISTORICAL_DECISION_KINDS.CLICK &&
    JSON.parse(row.detail).interactionId === id);
  const publicDetail = JSON.parse(listedClick.detail);
  const expectedRedaction = Object.fromEntries(Object.entries(rawClick).filter(([key]) => key !== 'token'));
  assert.equal(Object.hasOwn(publicDetail, 'token'), false);
  assert.deepEqual(publicDetail, expectedRedaction);
  const publicTokenRelease = listedRows.find(row => row.kind === HISTORICAL_DECISION_KINDS.TOKEN_RELEASE &&
    JSON.parse(row.detail).interactionId === id);
  assert.deepEqual(JSON.parse(publicTokenRelease.detail), { journal: 'decision-v1', interactionId: id });
  const publicOutputs = { click, pending, listedRows };
  assertNoToken(publicOutputs, token);
  assert.deepEqual(rawJournalSnapshot(f.state), beforeReads);

  const currentId = 'h6-current-writer-ignores-token';
  const currentAdmission = f.state.admitDecisionClickAndBeginCallback(historicalInput(f, currentId, 'hold', { token }));
  assert.equal(currentAdmission.accepted, true);
  assertNoToken(currentAdmission, token);
  const currentRawClick = rawClickDetail(f.state, currentId);
  assert.equal(Object.hasOwn(currentRawClick, 'token'), false);
  assertNoToken(f.state.getDecisionClick(currentId), token);
});

test('marked native outcomes remain observable without a second submission', { timeout: 30000 }, async t => {
  const outcomes = ['in_flight', 'unknown', 'not_submitted', 'submitted', 'rejected'];
  for (const outcome of outcomes) {
    const f = await fixture(t);
    const writers = createHistoricalDecisionWriters();
    const id = `h8-${outcome}`;
    assert.equal(writers.admitClickAndBeginAuthorization(f.state, historicalInput(f, id)).accepted, true);
    assert.equal(writers.recordAuthorizationOutcome(f.state, id, 'authorized').accepted, true);
    historicalImportWinnerAndQueueNativeReturn(f.state, id);
    if (outcome === 'submitted') {
      const accepted = f.state.getMessage(id);
      assert.equal(accepted.state, 'accepted');
      await f.gateway.consumer.processAccepted(accepted, new AbortController().signal, {
        continueUntilFinal: true,
        awaitDispatchOutcome: true
      });
      assert.equal(f.state.getMessage(id).state, 'submitted');
    }
    f.state.recordDecisionNativeReturnOutcome(id, outcome);
    f.state.recordDecisionProjectionOutcome(id, 'sent');
    const beforeReplay = rawJournalSnapshot(f.state);
    await f.reopen();

    const click = f.state.getDecisionClick(id);
    assert.equal(click.nativeReturn.outcome, outcome);
    assert.equal(compatibilityMarkerFor(f.state, id), true);
    if (outcome === 'submitted') {
      assert.equal(f.state.listDecisionPendingWork().some(item => item.interactionId === id), false);
    }
    assertDecisionHistoryReadOnly(f.state, id);
    f.gateway.started = true;
    f.gateway.transportReady = true;
    f.gateway.ready = true;
    if (outcome === 'submitted') {
      f.gateway.client.channels.fetch = async channelId => ({
        id: channelId,
        messages: { async fetch(messageId) { return { id: messageId, async edit(payload) { return { id: messageId, ...payload }; } }; } },
        async send() { return { id: 'fixture-reply' }; }
      });
    }
    await f.gateway.reconcilePending();
    assert.equal(f.dispatches.length, outcome === 'submitted' ? 1 : 0);
    assert.equal(f.state.getDecisionClick(id).nativeReturn.outcome, outcome);
    if (outcome === 'submitted') assert.equal(f.state.getMessage(id).state, 'submitted');
    if (outcome !== 'submitted') assert.deepEqual(rawJournalSnapshot(f.state), beforeReplay);
  }
});

test('later malformed receipts cannot erase a valid marker or widen it to sibling work', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const writers = createHistoricalDecisionWriters();
  const markedId = 'h13-marked-interaction';
  const siblingId = 'h13-unmarked-sibling';
  assert.equal(writers.admitClickAndBeginAuthorization(f.state, historicalInput(f, markedId)).accepted, true);
  f.state.receipt(null, HISTORICAL_DECISION_KINDS.CLICK, {
    journal: 'decision-v1', interactionId: markedId, authorizationPending: 'true'
  });
  f.state.receipt(null, 'decision-unknown-later', { journal: 'decision-v1', interactionId: markedId });
  f.state.receipt(null, HISTORICAL_DECISION_KINDS.AUTHORIZATION_OUTCOME, {
    journal: 'decision-v1', interactionId: 17, outcome: 'denied'
  });
  assert.equal(writers.admitClick(f.state, historicalInput(f, siblingId)).accepted, true);
  const before = rawJournalSnapshot(f.state);
  await f.reopen();

  assert.equal(compatibilityMarkerFor(f.state, markedId), true);
  assert.equal(compatibilityMarkerFor(f.state, siblingId), false);
  assert.ok(f.state.listDecisionPendingWork().some(click => click.interactionId === markedId));
  assertDecisionHistoryReadOnly(f.state, markedId);
  const decisionCounters = { callbacks: 0, canonical: 0, native: 0, project: 0 };
  const decisionConsumer = createCompatibilityTestConsumer(f, decisionCounters);
  const held = await decisionConsumer.handleParsed(
    parseDecisionComponent(component(f.presentation, markedId, 0), 'application'));
  assert.equal(held.continuing, true);
  const remaining = await decisionConsumer.recover(new AbortController().signal);
  assert.ok(remaining.some(click => click.interactionId === markedId));
  assert.equal(decisionCounters.callbacks + decisionCounters.canonical + decisionCounters.native + decisionCounters.project, 0);
  assert.deepEqual(rawJournalSnapshot(f.state), before);

  for (const id of [markedId, siblingId]) {
    assert.equal(f.state.acceptDiscordMessage({
      id,
      guildId: 'guild',
      channelId: 'channel',
      authorId: 'operator',
      isBot: false,
      attachments: [],
      content: `accepted ${id}`
    }).accepted, true);
  }
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  await f.gateway.reconcilePending();
  assert.deepEqual(f.dispatches.map(message => message.id), [siblingId]);

  const control = await fixture(t);
  const controlId = 'h13-unassignable-control';
  control.state.receipt(null, HISTORICAL_DECISION_KINDS.AUTHORIZATION_OUTCOME, {
    journal: 'decision-v1', interactionId: 17, outcome: 'denied'
  });
  assert.equal(control.state.acceptDiscordMessage({
    id: controlId,
    guildId: 'guild',
    channelId: 'channel',
    authorId: 'operator',
    isBot: false,
    attachments: [],
    content: 'unassignable corruption control'
  }).accepted, true);
  await control.reopen();
  assert.equal(compatibilityMarkerFor(control.state, controlId), false);
  control.gateway.started = true;
  control.gateway.transportReady = true;
  control.gateway.ready = true;
  await control.gateway.reconcilePending();
  assert.deepEqual(control.dispatches.map(message => message.id), [controlId]);
});

test('compatibility source inventory covers all marker kinds and effect consumers', () => {
  const source = relativePath => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
  const sourcePaths = directory => fs.readdirSync(path.join(__dirname, '..', directory), { withFileTypes: true })
    .flatMap(entry => {
      const relativePath = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) return sourcePaths(relativePath);
      return entry.isFile() && /\.(js|ts)$/.test(entry.name) ? [relativePath] : [];
    });
  const typeSource = source('src/state/decision/types.ts');
  const reducerSource = source('src/state/decision/reducer.ts');
  const expectedKinds = [
    'decision-presentation', 'decision-presentation-outcome', 'decision-presentation-stale',
    'decision-click', 'decision-authorization-outcome', 'decision-click-stale',
    'decision-callback-attempt', 'decision-callback-outcome', 'decision-rejection-attempt',
    'decision-rejection-outcome', 'decision-token-release', 'decision-canonical-import',
    'decision-projection-outcome', 'decision-native-return', 'decision-native-outcome'
  ];
  const kinds = [...typeSource.matchAll(/^\s+[A-Z_]+: '(decision-[^']+)'[,]?$/gm)].map(match => match[1]);
  assert.deepEqual(kinds, expectedKinds);

  const markerBlock = reducerSource.match(/const READ_COMPATIBILITY_KINDS:[\s\S]*?new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(markerBlock);
  assert.deepEqual(
    [...markerBlock[1].matchAll(/DECISION_RECEIPT_KINDS\.([A-Z_]+)/g)].map(match => match[1]),
    ['AUTHORIZATION_OUTCOME', 'CLICK_STALE', 'REJECTION_ATTEMPT', 'REJECTION_OUTCOME', 'TOKEN_RELEASE']
  );
  assert.match(reducerSource, /row\.kind === DECISION_RECEIPT_KINDS\.CLICK && detail\.authorizationPending === true/);

  const callSites = {
    'src/discord/decision.ts': 5,
    'src/discord/pending-reconciliation.js': 1,
    'src/state/decision/handlers.ts': 2,
    'src/state/decision/reducer.ts': 1
  };
  const classifierFiles = [...sourcePaths('src/discord'), ...sourcePaths('src/state')]
    .filter(relativePath => /decisionCompatibilityHeld\s*\(/.test(source(relativePath)))
    .sort();
  assert.deepEqual(classifierFiles, Object.keys(callSites).sort());
  for (const [relativePath, expectedCount] of Object.entries(callSites)) {
    const count = source(relativePath).match(/decisionCompatibilityHeld\s*\(/g)?.length || 0;
    assert.equal(count, expectedCount, relativePath);
  }

  const presentation = { content: 'saved prompt' };
  const inlineAnswer = 'é'.repeat(2048);
  assert.equal(Buffer.byteLength(inlineAnswer, 'utf8'), 4096);
  const inline = renderDecisionProjection(presentation, inlineAnswer);
  assert.equal(inline.content, presentation.content);
  assert.equal(inline.embeds[0].title, 'Selected action');
  assert.equal(inline.embeds[0].description, inlineAnswer);
  assert.deepEqual(inline.components, []);
  assert.deepEqual(inline.attachments, []);
  assert.deepEqual(inline.allowedMentions, { parse: [] });
  assert.equal(inline.files, undefined);

  const longAnswer = '界'.repeat(1366);
  assert.equal(Buffer.byteLength(longAnswer, 'utf8'), 4098);
  const attached = renderDecisionProjection(presentation, longAnswer);
  assert.equal(attached.content, presentation.content);
  assert.equal(attached.embeds[0].title, 'Selected action');
  assert.equal(attached.embeds[0].description, 'Full answer attached in selected-action.txt.');
  assert.equal(attached.files[0].name, 'selected-action.txt');
  assert.equal(Buffer.from(attached.files[0].attachment).toString('utf8'), longAnswer);
  assert.deepEqual(attached.components, []);
  assert.deepEqual(attached.attachments, []);
  assert.deepEqual(attached.allowedMentions, { parse: [] });
});

test('direct import and native queue refuse marked canonical histories without mutation', { timeout: 30000 }, async t => {
  const writers = createHistoricalDecisionWriters();
  const pending = await fixture(t);
  const pendingId = 'h14-pending-import-control';
  assert.equal(writers.admitClickAndBeginAuthorization(pending.state, historicalInput(pending, pendingId)).accepted, true);
  await pending.reopen();
  assertDecisionHistoryReadOnly(pending.state, pendingId);

  const canonical = await fixture(t);
  const canonicalId = 'h14-canonical-native-control';
  assert.equal(writers.admitClickAndBeginAuthorization(canonical.state, historicalInput(canonical, canonicalId)).accepted, true);
  assert.equal(writers.recordAuthorizationOutcome(canonical.state, canonicalId, 'authorized').accepted, true);
  historicalImportWinnerAndQueueNativeReturn(canonical.state, canonicalId);
  await canonical.reopen();
  const click = canonical.state.getDecisionClick(canonicalId);
  assert.equal(click.canonical.materialized, true);
  assert.ok(click.nativeReturn);
  assertDecisionHistoryReadOnly(canonical.state, canonicalId);
});

test('Gateway settles competing component clicks once and imports the canonical winner', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  const first = await f.gateway.handleInteraction(component(f.presentation, 'component-approve', 0), new AbortController().signal);
  const second = await f.gateway.handleInteraction(component(f.presentation, 'component-hold', 1), new AbortController().signal);

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(f.callbacks.length, 2);
  assert.deepEqual(f.callbacks.map(item => item.body), [{ type: 6 }, { type: 6 }]);
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.edits.length, 2);
  for (const edit of f.edits) assertDecisionProjection(edit, f.presentation, 'approve');
  assert.equal(decisionMessages(f.state).length, 1);
  const row = decisionMessages(f.state)[0];
  assert.equal(row.decisionResult.answer, 'approve');
  assert.equal(row.decisionResult.selectedKey, 'approve');
  assert.equal(row.decisionResult.questionMessageId, f.presentation.messageId);
  assert.equal(f.state.interactionResponseTarget(row.id), f.presentation.messageId);
  const losing = f.state.getDecisionClick('component-hold');
  assert.equal(losing.selectedKey, 'hold');
  assert.equal(losing.canonical.answer, 'approve');
  assert.equal(losing.canonical.source, 'current');
  assert.equal(compatibilityMarkerFor(f.state, 'component-approve'), false);
  assert.equal(compatibilityMarkerFor(f.state, 'component-hold'), false);
});

test('bound component ingress keeps callback custody before readiness and gates continuation', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.gateway.ready = true;
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.createInteractionRecoveryBarrier();
  const listener = f.listeners.get('interactionCreate');
  assert.equal(typeof listener, 'function');
  listener(component(f.presentation, 'barrier-component', 0));

  await waitForCondition(() => f.callbacks.length === 1, 'bound component callback was not attempted');
  assert.deepEqual(f.callbacks.map(item => item.body), [{ type: 6 }]);
  assert.equal(f.edits.length, 0);
  assert.equal(f.dispatches.length, 0);
  assert.equal(decisionMessages(f.state).length, 0);
  assert.equal(f.state.getDecisionClick('barrier-component').callbackOutcome, 'sent');
  assert.equal(f.state.getDecisionClick('barrier-component').canonical, null);

  f.gateway.resolveInteractionRecovery(true);
  await waitForCondition(() => f.edits.length === 1 && f.dispatches.length === 1,
    'decision continuation did not resume after readiness barrier');
  assertDecisionProjection(f.edits[0], f.presentation, 'approve');
  assert.equal(decisionMessages(f.state).length, 1);

  const aborted = await fixture(t);
  aborted.gateway.ready = true;
  aborted.gateway.started = true;
  aborted.gateway.transportReady = true;
  aborted.gateway.createInteractionRecoveryBarrier();
  const abortedListener = aborted.listeners.get('interactionCreate');
  assert.equal(typeof abortedListener, 'function');
  abortedListener(component(aborted.presentation, 'aborted-barrier-component', 0));
  await waitForCondition(() => aborted.callbacks.length === 1, 'aborted barrier callback was not attempted');
  await aborted.gateway.stop();
  assert.equal(aborted.edits.length, 0);
  assert.equal(aborted.dispatches.length, 0);
  assert.equal(decisionMessages(aborted.state).length, 0);
  const pending = aborted.state.getDecisionClick('aborted-barrier-component');
  assert.equal(pending.callbackOutcome, 'sent');
  assert.ok(aborted.state.listDecisionPendingWork().some(click => click.interactionId === 'aborted-barrier-component'));
});

test('decision native return is held before startup and proceeds once after a healthy start', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const listener = f.listeners.get('interactionCreate');
  assert.equal(typeof listener, 'function');
  assert.equal(f.gateway.started, false);

  listener(component(f.presentation, 'held-before-start', 0));
  await waitForCondition(() => f.callbacks.length === 1, 'held decision callback was not attempted');
  await Promise.all([...f.gateway.inFlight]);

  const held = f.state.getDecisionClick('held-before-start');
  assert.equal(held.callbackOutcome, 'sent');
  assert.equal(held.nativeReturn, null);
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.edits.length, 0);
  assert.equal(decisionMessages(f.state).length, 0);

  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  listener(component(f.presentation, 'native-after-start', 0));
  await waitForCondition(() => f.callbacks.length === 2, 'started decision callback was not attempted');
  await Promise.all([...f.gateway.inFlight]);

  assert.equal(f.dispatches.length, 1);
  assert.equal(f.edits.length, 1);
  assertDecisionProjection(f.edits[0], f.presentation, 'approve');
  assert.equal(decisionMessages(f.state).length, 1);
  assert.equal(f.state.getDecisionClick('native-after-start').nativeReturn.outcome, 'submitted');
  assert.equal(f.state.getDecisionClick('held-before-start').nativeReturn, null);
});

test('original held click resumes through startDecisionRecovery without a second click', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const listener = f.listeners.get('interactionCreate');
  assert.equal(typeof listener, 'function');

  listener(component(f.presentation, 'held-original', 0));
  await waitForCondition(() => f.callbacks.length === 1, 'held original decision callback was not attempted');
  await Promise.all([...f.gateway.inFlight]);

  assert.equal(f.state.getDecisionClick('held-original').nativeReturn, null);
  assert.equal(f.dispatches.length, 0);

  f.gateway.ready = true;
  f.gateway.started = true;
  f.gateway.transportReady = true;
  await f.gateway.startDecisionRecovery(new AbortController().signal);

  const recovered = f.state.getDecisionClick('held-original');
  assert.equal(recovered.nativeReturn.outcome, 'submitted');
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.edits.length, 1);
  assert.equal(decisionMessages(f.state).length, 1);

  await f.gateway.startDecisionRecovery(new AbortController().signal);
  assert.equal(f.state.getDecisionClick('held-original').nativeReturn.outcome, 'submitted');
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.edits.length, 1);
  assert.equal(decisionMessages(f.state).length, 1);
});

test('losing projection refuses binding and config drift during question fetch', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  await f.gateway.handleInteraction(component(f.presentation, 'projection-owner', 0), new AbortController().signal);
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'projection-loser',
    presentationId: f.presentation.presentationId,
    selectedKey: 'hold',
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);
  const canonical = f.state.getDecisionClick('projection-owner').canonical;
  assert.ok(canonical);
  assert.equal(f.state.importDecisionWinner('projection-loser', canonical).accepted, true);
  const click = f.state.getDecisionClick('projection-loser');
  assert.equal(f.state.getMessage('projection-loser'), null);

  const channel = await f.gateway.client.channels.fetch('channel');
  const fetchQuestion = channel.messages.fetch.bind(channel.messages);
  f.gateway.client.channels.fetch = async channelId => {
    assert.equal(channelId, 'channel');
    return channel;
  };
  let fetchStartedResolve;
  let releaseFetchResolve;
  let fetchStarted = new Promise(resolve => { fetchStartedResolve = resolve; });
  let releaseFetch = new Promise(resolve => { releaseFetchResolve = resolve; });
  channel.messages.fetch = async messageId => {
    const question = await fetchQuestion(messageId);
    fetchStartedResolve();
    await releaseFetch;
    return question;
  };
  const beforeLosingProjection = f.edits.length;
  const staleBindingProjection = f.gateway.projectDecisionMessage({ click, answer: 'approve' }, new AbortController().signal);
  await fetchStarted;
  f.state.db.prepare('UPDATE bindings SET native_id=?, generation=? WHERE channel_id=?')
    .run('6b2d4b45-9d15-4894-8f2a-fc9a7c36b7d1', 2, 'channel');
  releaseFetchResolve();
  await assert.rejects(staleBindingProjection, /authorization/);
  assert.equal(f.edits.length, beforeLosingProjection);

  f.state.db.prepare('UPDATE bindings SET native_id=?, generation=? WHERE channel_id=?')
    .run(NATIVE_ID, 1, 'channel');
  f.state.setConfig({ operatorId: 'replacement-operator', guildId: 'replacement-guild' });
  fetchStarted = new Promise(resolve => { fetchStartedResolve = resolve; });
  releaseFetch = new Promise(resolve => { releaseFetchResolve = resolve; });
  const staleConfigProjection = f.gateway.projectDecisionMessage({ click, answer: 'approve' }, new AbortController().signal);
  await fetchStarted;
  releaseFetchResolve();
  await assert.rejects(staleConfigProjection, /authorization/);
  assert.equal(f.edits.length, beforeLosingProjection);
});

test('Gateway rejects malformed, forged, stale, and unauthorized component custody before callback', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const malformed = await f.gateway.handleInteraction(component(f.presentation, 'bad-code', 0, { customId: 'd:not-valid:99' }), new AbortController().signal);
  const stale = await f.gateway.handleInteraction(component(f.presentation, 'stale-source', 0, { message: { id: 'other-question' } }), new AbortController().signal);
  const unauthorized = await f.gateway.handleInteraction(component(f.presentation, 'wrong-operator', 0, { user: { id: 'other-operator' } }), new AbortController().signal);

  assert.equal(malformed.accepted, false);
  assert.equal(stale.accepted, false);
  assert.equal(unauthorized.accepted, false);
  assert.equal(f.callbacks.length, 0);
  assert.equal(decisionMessages(f.state).length, 0);
  assert.equal(f.state.listDecisionPendingWork().length, 0);
});

test('callback uncertainty does not cancel canonical settlement or native custody', { timeout: 30000 }, async t => {
  const f = await fixture(t, {
    callback: async () => { throw new Error('Discord callback connection lost'); }
  });
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  const result = await f.gateway.handleInteraction(component(f.presentation, 'callback-unknown', 0), new AbortController().signal);
  const click = f.state.getDecisionClick('callback-unknown');

  assert.equal(result.accepted, true);
  assert.equal(result.callback.outcome, 'unknown');
  assert.equal(click.callbackOutcome, 'unknown');
  assert.equal(f.dispatches.length, 1);
  assert.equal(decisionMessages(f.state).length, 1);
});

test('recovery resumes an admitted click without repeating its callback and preserves the question target', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'recovered-component',
    presentationId: f.presentation.presentationId,
    selectedKey: 'hold',
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);
  const recoveredState = new SurfaceState(f.db);
  recoveredState.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(f.dir, 'discord.secret') });
  const recoveredGateway = new DiscordGateway({
    state: recoveredState,
    client: f.gateway.client,
    providers: { codex: { async dispatch(message) { f.dispatches.push(message); return { status: 'submitted' }; } } },
    interactionFetch: async () => { throw new Error('recovery must not repeat component callback'); }
  });
  t.after(async () => { await recoveredGateway.stop(); recoveredState.close(); });
  const remaining = await recoveredGateway.startDecisionRecovery(new AbortController().signal);
  const click = recoveredState.getDecisionClick('recovered-component');
  assert.equal(f.edits.length, 1);
  assertDecisionProjection(f.edits[0], f.presentation, 'hold');

  assert.deepEqual(remaining, []);
  assert.equal(click.callbackOutcome, null);
  assert.equal(click.canonical.answer, 'hold');
  assert.equal(recoveredState.interactionResponseTarget('recovered-component'), f.presentation.messageId);
  assert.equal(recoveredState.listMessages().filter(message => message.decisionResult).length, 1);
});

test('restart recovery classifies an interrupted callback without resending it', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'restart-callback',
    presentationId: f.presentation.presentationId,
    selectedKey: 'hold',
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);
  f.state.close();

  const recoveredState = new SurfaceState(f.db);
  recoveredState.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(f.dir, 'discord.secret') });
  const restart = recoveredState.recoverAfterRestart();
  assert.equal(restart.interactionCallbacks, 0);
  assert.equal(recoveredState.getDecisionClick('restart-callback').callbackOutcome, 'unknown');
  let recoveryCallbacks = 0;
  const recoveredGateway = new DiscordGateway({
    state: recoveredState,
    client: f.gateway.client,
    providers: { codex: { async dispatch(message) { f.dispatches.push(message); return { status: 'submitted' }; } } },
    interactionFetch: async () => {
      recoveryCallbacks += 1;
      throw new Error('restart recovery must not repeat component callback');
    }
  });
  t.after(async () => { await recoveredGateway.stop(); recoveredState.close(); });
  const remaining = await recoveredGateway.startDecisionRecovery(new AbortController().signal);
  const click = recoveredState.getDecisionClick('restart-callback');
  assert.equal(f.edits.length, 1);
  assertDecisionProjection(f.edits[0], f.presentation, 'hold');

  assert.deepEqual(remaining, []);
  assert.equal(recoveryCallbacks, 0);
  assert.equal(click.callbackOutcome, 'unknown');
  assert.equal(click.canonical.answer, 'hold');
  assert.equal(recoveredState.interactionResponseTarget('restart-callback'), f.presentation.messageId);
  assert.equal(recoveredState.listMessages().filter(message => message.decisionResult).length, 1);
});

test('ordinary recovery is returned while decision recovery remains independently pending', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const admitted = f.state.admitDecisionClickAndBeginCallback({
    interactionId: 'pending-decision',
    presentationId: f.presentation.presentationId,
    selectedKey: 'approve',
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    messageId: f.presentation.messageId,
    binding: f.state.getBinding('channel')
  });
  assert.equal(admitted.accepted, true);
  f.gateway.decisionConsumer.recover = signal => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve([]), { once: true });
  });
  const ordinary = f.state.acceptDiscordMessage({
    id: '9000', guildId: 'guild', channelId: 'channel', authorId: 'operator',
    isBot: false, attachments: [], content: 'ordinary sibling'
  });
  assert.equal(ordinary.accepted, true);
  const result = await f.gateway.reconcilePending();

  assert.ok(Array.isArray(result));
  assert.equal(f.dispatches.length, 1);
});

test('cancellation leaves accepted pre-row custody and Gateway stop drains it', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  const result = await f.gateway.handleInteraction(component(f.presentation, 'cancelled-component', 0), controller.signal);

  assert.equal(result.accepted, true);
  assert.equal(result.message, null);
  assert.equal(f.state.getMessage('cancelled-component'), null);
  assert.equal(f.state.listDecisionPendingWork().length, 1);
  await f.gateway.stop();
  assert.equal(f.gateway.stopping, false);
});

test('decision projection preserves a 2,000-character saved prompt', { timeout: 30000 }, async t => {
  const probe = await fixture(t, { question: 'Q' });
  const renderedSuffix = probe.presentation.content.slice(1);
  const prompt = 'Q'.repeat(2000 - renderedSuffix.length);
  const f = await fixture(t, { question: prompt });
  assert.equal(f.presentation.content.length, 2000);
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  const result = await f.gateway.handleInteraction(component(f.presentation, 'long-prompt', 0), new AbortController().signal);

  assert.equal(result.accepted, true);
  assert.equal(f.edits.length, 1);
  assertDecisionProjection(f.edits[0], f.presentation, 'approve');
});

test('decision projection keeps complete answers at the embed and file boundary', () => {
  const presentation = { content: 'Q'.repeat(2000) };
  const inlineAnswer = 'A'.repeat(4096);
  const inline = renderDecisionProjection(presentation, inlineAnswer);
  assert.equal(inline.content, presentation.content);
  assert.equal(inline.embeds[0].description, inlineAnswer);
  assert.deepEqual(inline.components, []);
  assert.deepEqual(inline.allowedMentions, { parse: [] });
  assert.deepEqual(inline.attachments, []);
  assert.equal(inline.files, undefined);

  const longAnswer = 'B'.repeat(4097);
  const attached = renderDecisionProjection(presentation, longAnswer);
  assert.equal(attached.content, presentation.content);
  assert.equal(attached.embeds[0].title, 'Selected action');
  assert.equal(attached.embeds[0].description, 'Full answer attached in selected-action.txt.');
  assert.equal(attached.files[0].name, 'selected-action.txt');
  assert.equal(Buffer.from(attached.files[0].attachment).toString('utf8'), longAnswer);
  assert.deepEqual(attached.components, []);
  assert.deepEqual(attached.allowedMentions, { parse: [] });
  assert.deepEqual(attached.attachments, []);
});
