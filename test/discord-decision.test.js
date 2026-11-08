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
const { CANONICAL_OPERATIONS } = require('../src/decision-canonical');
const { DECISION_REASONS, READINESS, SurfaceState } = require('../src/state');

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
      if (operation === CANONICAL_OPERATIONS.READ) {
        const presentation = f.state.getDecisionPresentation(f.presentation.presentationId);
        return {
          status: 'complete',
          payload: {
            ok: true,
            operation,
            qid: input.qid,
            question_generation: questionGeneration,
            source: 'current',
            evidence_name: 'fixture-evidence',
            answer: {
              qid: input.qid,
              question_generation: questionGeneration,
              target: presentation.target,
              answer: 'approve'
            }
          }
        };
      }
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
    for (const projectionOutcome of ['unknown', 'not_sent', 'rate_limited']) {
      const f = await fixture(t);
      const presentation = f.state.getDecisionPresentation(f.presentation.presentationId);
      const id = `h1-${nativeOutcome}-${projectionOutcome}`;
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
      f.state.recordDecisionProjectionOutcome(id, projectionOutcome);

      const queued = f.state.getDecisionClick(id);
      assert.equal(queued.canonical.answer, 'approve');
      assert.equal(queued.projectionOutcome, projectionOutcome);
      assert.ok(queued.nativeReturn);
      assert.equal(queued.nativeReturn.outcome, null);
      const interactionRows = () => f.state.listReceipts().map(row => ({ kind: row.kind, detail: JSON.parse(row.detail) }))
        .filter(row => row.detail.interactionId === id);
      const queuedRows = interactionRows();
      assert.equal(queuedRows.filter(row => row.kind === HISTORICAL_DECISION_KINDS.NATIVE_RETURN).length, 1);
      assert.equal(queuedRows.filter(row => row.kind === HISTORICAL_DECISION_KINDS.NATIVE_OUTCOME).length, 0);

      const recorded = f.state.recordDecisionNativeReturnOutcome(id, nativeOutcome);
      assert.equal(recorded.accepted, true);
      assert.equal(recorded.click.nativeReturn.outcome, nativeOutcome);
      const nativeRows = interactionRows().filter(row =>
        row.kind === HISTORICAL_DECISION_KINDS.NATIVE_RETURN || row.kind === HISTORICAL_DECISION_KINDS.NATIVE_OUTCOME);
      assert.equal(nativeRows.filter(row => row.kind === HISTORICAL_DECISION_KINDS.NATIVE_RETURN).length, 1);
      assert.equal(nativeRows.filter(row => row.kind === HISTORICAL_DECISION_KINDS.NATIVE_OUTCOME).length, 1);
      assert.equal(nativeRows.find(row => row.kind === HISTORICAL_DECISION_KINDS.NATIVE_OUTCOME).detail.outcome, nativeOutcome);
      assert.equal(compatibilityMarkerFor(f.state, id), false);

      const before = rawJournalSnapshot(f.state);
      await f.reopen();
      const click = f.state.getDecisionClick(id);
      assert.equal(click.callbackOutcome, 'unknown');
      assert.equal(click.canonical.answer, 'approve');
      assert.equal(click.projectionOutcome, projectionOutcome);
      assert.equal(click.nativeReturn.outcome, nativeOutcome);
      assert.deepEqual(interactionRows().filter(row =>
        row.kind === HISTORICAL_DECISION_KINDS.NATIVE_RETURN || row.kind === HISTORICAL_DECISION_KINDS.NATIVE_OUTCOME), nativeRows);
      assert.equal(compatibilityMarkerFor(f.state, id), false);
      assert.deepEqual(rawJournalSnapshot(f.state), before);
    }
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
  const before = rawJournalSnapshot(f.state);
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

test('malformed legacy applicationId quarantines only its interaction during replay', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const affectedId = 'h5-invalid-application-id';
  const siblingId = 'h5-valid-sibling-application-id';
  assert.equal(f.state.admitDecisionClick(historicalInput(f, siblingId)).accepted, true);
  assert.equal(f.state.getDecisionClick(siblingId).interactionId, siblingId);
  assert.ok(f.state.listDecisionPendingWork().some(click => click.interactionId === siblingId));
  f.state.recoverAfterRestart();
  assert.equal(f.state.getDecisionClick(siblingId).interactionId, siblingId);

  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.CLICK, {
    ...historicalInput(f, affectedId), applicationId: 17, authorizationPending: true
  });
  const beforeReads = rawJournalSnapshot(f.state);
  assert.equal(f.state.getDecisionClick(siblingId).interactionId, siblingId);
  assert.ok(f.state.listDecisionPendingWork().some(click => click.interactionId === siblingId));
  f.state.recoverAfterRestart();
  assert.equal(f.state.getDecisionClick(affectedId), null);
  assert.ok(!f.state.listDecisionPendingWork().some(click => click.interactionId === affectedId));
  assertDecisionHistoryReadOnly(f.state, affectedId);
  const admissionRefusal = { accepted: false, reason: DECISION_REASONS.UNKNOWN_INTERACTION, click: null };
  assert.deepEqual(f.state.admitDecisionClick(historicalInput(f, affectedId)), admissionRefusal);
  assert.deepEqual(f.state.admitDecisionClickAndBeginCallback(historicalInput(f, affectedId)), admissionRefusal);
  assert.deepEqual(rawJournalSnapshot(f.state), beforeReads);
});

test('malformed legacy token quarantines only its interaction during replay', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const affectedId = 'h5-invalid-token';
  const siblingId = 'h5-valid-sibling-token';
  assert.equal(f.state.admitDecisionClick(historicalInput(f, siblingId)).accepted, true);
  assert.equal(f.state.getDecisionClick(siblingId).interactionId, siblingId);
  assert.ok(f.state.listDecisionPendingWork().some(click => click.interactionId === siblingId));
  f.state.recoverAfterRestart();
  assert.equal(f.state.getDecisionClick(siblingId).interactionId, siblingId);

  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.CLICK, {
    ...historicalInput(f, affectedId), token: 17, authorizationPending: true
  });
  const beforeReads = rawJournalSnapshot(f.state);
  assert.equal(f.state.getDecisionClick(siblingId).interactionId, siblingId);
  assert.ok(f.state.listDecisionPendingWork().some(click => click.interactionId === siblingId));
  f.state.recoverAfterRestart();
  assert.equal(f.state.getDecisionClick(affectedId), null);
  assert.ok(!f.state.listDecisionPendingWork().some(click => click.interactionId === affectedId));
  assertDecisionHistoryReadOnly(f.state, affectedId);
  const admissionRefusal = { accepted: false, reason: DECISION_REASONS.UNKNOWN_INTERACTION, click: null };
  assert.deepEqual(f.state.admitDecisionClick(historicalInput(f, affectedId)), admissionRefusal);
  assert.deepEqual(f.state.admitDecisionClickAndBeginCallback(historicalInput(f, affectedId)), admissionRefusal);
  assert.deepEqual(rawJournalSnapshot(f.state), beforeReads);
});

test('malformed legacy authorization outcome quarantines only its interaction during replay', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const affectedId = 'h5-invalid-authorization';
  const siblingId = 'h5-valid-sibling-authorization';
  assert.equal(f.state.admitDecisionClick(historicalInput(f, siblingId)).accepted, true);
  assert.equal(f.state.getDecisionClick(siblingId).interactionId, siblingId);
  assert.ok(f.state.listDecisionPendingWork().some(click => click.interactionId === siblingId));
  f.state.recoverAfterRestart();
  assert.equal(f.state.getDecisionClick(siblingId).interactionId, siblingId);

  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.CLICK, {
    ...historicalInput(f, affectedId), authorizationPending: true
  });
  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.AUTHORIZATION_OUTCOME, {
    interactionId: affectedId, outcome: 'invalid-synthetic'
  });
  const beforeReads = rawJournalSnapshot(f.state);
  assert.equal(f.state.getDecisionClick(siblingId).interactionId, siblingId);
  assert.ok(f.state.listDecisionPendingWork().some(click => click.interactionId === siblingId));
  f.state.recoverAfterRestart();
  assert.equal(f.state.getDecisionClick(affectedId), null);
  assert.ok(!f.state.listDecisionPendingWork().some(click => click.interactionId === affectedId));
  assertDecisionHistoryReadOnly(f.state, affectedId);
  const admissionRefusal = { accepted: false, reason: DECISION_REASONS.UNKNOWN_INTERACTION, click: null };
  assert.deepEqual(f.state.admitDecisionClick(historicalInput(f, affectedId)), admissionRefusal);
  assert.deepEqual(f.state.admitDecisionClickAndBeginCallback(historicalInput(f, affectedId)), admissionRefusal);
  assert.deepEqual(rawJournalSnapshot(f.state), beforeReads);
});

test('malformed legacy rejection outcome quarantines only its interaction during replay', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const affectedId = 'h5-invalid-rejection';
  const siblingId = 'h5-valid-sibling-rejection';
  assert.equal(f.state.admitDecisionClick(historicalInput(f, siblingId)).accepted, true);
  assert.equal(f.state.getDecisionClick(siblingId).interactionId, siblingId);
  assert.ok(f.state.listDecisionPendingWork().some(click => click.interactionId === siblingId));
  f.state.recoverAfterRestart();
  assert.equal(f.state.getDecisionClick(siblingId).interactionId, siblingId);

  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.CLICK, {
    ...historicalInput(f, affectedId), authorizationPending: true
  });
  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.AUTHORIZATION_OUTCOME, {
    interactionId: affectedId, outcome: 'denied'
  });
  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.REJECTION_ATTEMPT, { interactionId: affectedId });
  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.REJECTION_OUTCOME, {
    interactionId: affectedId, outcome: 'invalid-synthetic'
  });
  const beforeReads = rawJournalSnapshot(f.state);
  assert.equal(f.state.getDecisionClick(siblingId).interactionId, siblingId);
  assert.ok(f.state.listDecisionPendingWork().some(click => click.interactionId === siblingId));
  f.state.recoverAfterRestart();
  assert.equal(f.state.getDecisionClick(affectedId), null);
  assert.ok(!f.state.listDecisionPendingWork().some(click => click.interactionId === affectedId));
  assertDecisionHistoryReadOnly(f.state, affectedId);
  const admissionRefusal = { accepted: false, reason: DECISION_REASONS.UNKNOWN_INTERACTION, click: null };
  assert.deepEqual(f.state.admitDecisionClick(historicalInput(f, affectedId)), admissionRefusal);
  assert.deepEqual(f.state.admitDecisionClickAndBeginCallback(historicalInput(f, affectedId)), admissionRefusal);
  assert.deepEqual(rawJournalSnapshot(f.state), beforeReads);
});

test('malformed current-format callback outcome remains strict during replay', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const interactionId = 'h5-current-invalid-callback';
  assert.equal(f.state.admitDecisionClickAndBeginCallback(historicalInput(f, interactionId)).accepted, true);
  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.CALLBACK_OUTCOME, {
    interactionId, outcome: 'invalid-synthetic'
  });
  const beforeReads = rawJournalSnapshot(f.state);
  assert.throws(() => f.state.getDecisionClick(interactionId), error =>
    error?.constructor?.name === 'DecisionError' && error.message === 'invalid decision transport outcome');
  assert.deepEqual(rawJournalSnapshot(f.state), beforeReads);
});

test('valid marked legacy click remains duplicate-safe during admission', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const writers = createHistoricalDecisionWriters();
  const interactionId = 'h6-valid-legacy-duplicate';
  assert.equal(writers.admitClickAndBeginAuthorization(f.state, historicalInput(f, interactionId)).accepted, true);
  const beforeDuplicate = rawJournalSnapshot(f.state);
  const duplicate = f.state.admitDecisionClickAndBeginCallback(historicalInput(f, interactionId));
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.continuing, true);
  assert.equal(duplicate.click.interactionId, interactionId);
  assert.deepEqual(rawJournalSnapshot(f.state), beforeDuplicate);
});

test('orphan outcomes and duplicate click rows stay ignored in ordered replay', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const orphanId = 'h6-orphan-authorization-outcome';
  const duplicateId = 'h6-duplicate-click';
  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.AUTHORIZATION_OUTCOME, {
    interactionId: orphanId, outcome: 'invalid-synthetic'
  });
  assert.equal(f.state.getDecisionClick(orphanId), null);
  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.CLICK, {
    ...historicalInput(f, orphanId), authorizationPending: true
  });
  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.CLICK, {
    ...historicalInput(f, duplicateId), authorizationPending: true
  });
  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.CLICK, {
    ...historicalInput(f, duplicateId), applicationId: 17, authorizationPending: true
  });
  const beforeReads = rawJournalSnapshot(f.state);
  assert.equal(f.state.getDecisionClick(orphanId).interactionId, orphanId);
  assert.equal(f.state.getDecisionClick(duplicateId).interactionId, duplicateId);
  assert.ok(f.state.listDecisionPendingWork().some(click => click.interactionId === orphanId));
  assert.ok(f.state.listDecisionPendingWork().some(click => click.interactionId === duplicateId));
  assert.deepEqual(rawJournalSnapshot(f.state), beforeReads);
});

test('quarantined legacy history still reserves canonical and native conflicts', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const affectedId = 'h6-quarantined-proof';
  const conflictingId = 'h6-conflicting-winner';
  const nativeDuplicateId = 'h6-native-duplicate';
  const presentation = f.presentation;
  const winner = answer => ({
    qid: presentation.qid,
    questionGeneration: presentation.questionGeneration,
    target: presentation.target,
    source: 'current',
    materialized: true,
    reference: `legacy-proof:${answer}`,
    answer
  });
  const rowsFor = interactionId => f.state.db.prepare(
    'SELECT id, kind, detail FROM receipts ORDER BY id'
  ).all().filter(row => JSON.parse(row.detail)?.interactionId === interactionId);

  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.CLICK, {
    ...historicalInput(f, affectedId), authorizationPending: true
  });
  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.AUTHORIZATION_OUTCOME, {
    interactionId: affectedId, outcome: 'authorized'
  });
  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.AUTHORIZATION_OUTCOME, {
    interactionId: affectedId, outcome: 'invalid-synthetic'
  });
  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.CALLBACK_OUTCOME, {
    interactionId: affectedId, outcome: 'sent'
  });
  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.CANONICAL_IMPORT, {
    interactionId: affectedId,
    qid: presentation.qid,
    questionGeneration: presentation.questionGeneration,
    target: presentation.target,
    source: 'current',
    materialized: true,
    reference: 'legacy-proof:approve',
    answer: 'approve'
  });
  const binding = f.state.getBinding('channel');
  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.NATIVE_RETURN, {
    interactionId: affectedId,
    presentationId: presentation.presentationId,
    selectedKey: 'approve',
    questionMessageId: presentation.messageId,
    qid: presentation.qid,
    questionGeneration: presentation.questionGeneration,
    target: presentation.target,
    canonicalSource: 'current',
    answer: 'approve',
    provider: binding.provider,
    nativeId: binding.nativeId,
    generation: binding.generation,
    channelId: binding.channelId,
    guildId: binding.guildId,
    workspace: binding.workspace,
    canonicalReference: 'legacy-proof:approve'
  });
  const affectedRows = rowsFor(affectedId);
  assert.equal(f.state.getDecisionClick(affectedId), null);
  assert.equal(f.state.getDecisionPresentation(presentation.presentationId).clickCount, 1);

  assert.equal(f.state.admitDecisionClick(historicalInput(f, conflictingId)).accepted, true);
  const conflicting = f.state.importDecisionWinner(conflictingId, winner('different'));
  assert.equal(conflicting.accepted, false);
  assert.equal(conflicting.reason, DECISION_REASONS.CANONICAL_RESULT_CONFLICT);

  assert.equal(f.state.admitDecisionClick(historicalInput(f, nativeDuplicateId)).accepted, true);
  assert.equal(f.state.importDecisionWinner(nativeDuplicateId, winner('approve')).accepted, true);
  assert.equal(f.state.getDecisionPresentation(presentation.presentationId).clickCount, 3);
  const queued = f.state.queueDecisionNativeReturn(nativeDuplicateId);
  assert.equal(queued.accepted, false);
  assert.equal(queued.duplicate, true);
  assert.equal(queued.reason, DECISION_REASONS.NATIVE_RETURN_ALREADY_QUEUED);
  assert.equal(queued.existingInteractionId, affectedId);
  assert.equal(rowsFor(nativeDuplicateId).some(row => row.kind === HISTORICAL_DECISION_KINDS.NATIVE_RETURN), false);
  assert.deepEqual(rowsFor(affectedId), affectedRows);
});

test('quarantined legacy callback attempts stay unchanged during restart recovery', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const writers = createHistoricalDecisionWriters();
  const affectedId = 'h7-quarantined-restart';
  const siblingId = 'h7-healthy-restart';
  assert.equal(writers.admitClickAndBeginAuthorization(f.state, historicalInput(f, affectedId)).accepted, true);
  assert.equal(f.state.admitDecisionClickAndBeginCallback(historicalInput(f, siblingId)).accepted, true);
  historicalAppend(f.state, HISTORICAL_DECISION_KINDS.AUTHORIZATION_OUTCOME, {
    interactionId: affectedId, outcome: 'invalid-synthetic'
  });
  const rowsFor = interactionId => f.state.db.prepare(
    'SELECT id, kind, detail FROM receipts ORDER BY id'
  ).all().filter(row => JSON.parse(row.detail)?.interactionId === interactionId);
  const affectedRows = rowsFor(affectedId);

  f.state.recoverAfterRestart();
  assert.equal(f.state.getDecisionClick(affectedId), null);
  assert.equal(f.state.getDecisionClick(siblingId).callbackOutcome, 'unknown');
  assert.equal(rowsFor(affectedId).some(row => row.kind === HISTORICAL_DECISION_KINDS.CALLBACK_OUTCOME), false);
  assert.deepEqual(rowsFor(affectedId), affectedRows);
  const recoveredSiblingRows = rowsFor(siblingId);
  assert.equal(recoveredSiblingRows.filter(row => row.kind === HISTORICAL_DECISION_KINDS.CALLBACK_OUTCOME).length, 1);

  f.state.recoverAfterRestart();
  assert.deepEqual(rowsFor(affectedId), affectedRows);
  assert.deepEqual(rowsFor(siblingId), recoveredSiblingRows);
});

test('historical markers hold both real decision replay entrypoints and exact generic interactions', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const writers = createHistoricalDecisionWriters();
  const pendingId = '100000000000000010';
  const completedId = '100000000000000020';
  const siblingId = '100000000000000005';
  assert.equal(writers.admitClickAndBeginAuthorization(f.state, historicalInput(f, pendingId)).accepted, true);
  assert.equal(writers.admitClickAndBeginAuthorization(f.state, historicalInput(f, completedId)).accepted, true);
  assert.equal(writers.recordAuthorizationOutcome(f.state, completedId, 'denied').accepted, true);
  assert.equal(writers.beginRejectionFollowup(f.state, completedId).accepted, true);
  assert.equal(writers.recordRejectionOutcome(f.state, completedId, 'sent').accepted, true);
  for (const id of [pendingId, completedId, siblingId]) {
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
  assert.deepEqual(f.dispatches.map(message => message.id), [siblingId]);
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
  const staleId = '100000000000000040';
  const siblingId = '100000000000000035';
  assert.equal(writers.admitClickAndBeginAuthorization(f.state, historicalInput(f, staleId)).accepted, true);
  assert.equal(writers.recordAuthorizationOutcome(f.state, staleId, 'authorized').accepted, true);
  f.state.setBindingReadiness('channel', READINESS.PENDING);
  writers.reconcileClickBinding(f.state, staleId);
  assert.ok(f.state.listReceipts().some(row => row.kind === HISTORICAL_DECISION_KINDS.CLICK_STALE));
  f.state.setBindingReadiness('channel', READINESS.READY);
  for (const id of [staleId, siblingId]) {
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
  assert.equal(compatibilityMarkerFor(f.state, siblingId), false);
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  await f.gateway.reconcilePending();
  assert.deepEqual(f.dispatches.map(message => message.id), [siblingId]);
});

test('a later valid click on the same presentation passes its own baseline checks', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const writers = createHistoricalDecisionWriters();
  const heldId = '100000000000000060';
  const laterId = '100000000000000070';
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
  const receiptRows = () => f.state.db.prepare(
    'SELECT id, discord_id, kind, detail, created_at FROM receipts ORDER BY id'
  ).all();
  assert.equal(writers.admitClick(f.state, historicalInput(f, id, 'approve', {
    applicationId: 'token-shaped-application-id'
  })).accepted, true);
  const originalRows = receiptRows();
  const originalRowIds = new Set(originalRows.map(row => row.id));
  const rawClickBeforeReopen = rawClickDetail(f.state, id);
  assert.equal(rawClickBeforeReopen.applicationId, 'token-shaped-application-id');
  assert.equal(Object.hasOwn(rawClickBeforeReopen, 'token'), false);
  await f.reopen();
  assert.deepEqual(receiptRows(), originalRows);
  assert.equal(compatibilityMarkerFor(f.state, id), false);
  const clickBeforeRecovery = f.state.getDecisionClick(id);
  assert.equal(Object.hasOwn(clickBeforeRecovery, 'applicationId'), false);
  assert.equal(Object.hasOwn(clickBeforeRecovery, 'token'), false);
  const publicClickRow = f.state.listReceipts().find(row => row.kind === HISTORICAL_DECISION_KINDS.CLICK &&
    JSON.parse(row.detail).interactionId === id);
  const publicClickDetail = JSON.parse(publicClickRow.detail);
  assert.equal(publicClickDetail.applicationId, 'token-shaped-application-id');
  assert.equal(Object.hasOwn(publicClickDetail, 'token'), false);
  assert.deepEqual(rawClickDetail(f.state, id), rawClickBeforeReopen);
  const counters = { callbacks: 0, canonical: 0, native: 0, project: 0 };
  const consumer = createCompatibilityTestConsumer(f, counters);
  await consumer.recover(new AbortController().signal);
  assert.equal(counters.canonical > 0, true);
  assert.equal(counters.callbacks, 0);
  const recoveredClick = f.state.getDecisionClick(id);
  assert.equal(recoveredClick.canonical.answer, 'approve');
  assert.equal(Object.hasOwn(recoveredClick, 'applicationId'), false);
  assert.equal(Object.hasOwn(recoveredClick, 'token'), false);
  assert.equal(compatibilityMarkerFor(f.state, id), false);
  assert.deepEqual(rawClickDetail(f.state, id), rawClickBeforeReopen);
  assert.deepEqual(receiptRows().filter(row => originalRowIds.has(row.id)), originalRows);
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
  const markedId = '100000000000000100';
  const genericSiblingId = '100000000000000090';
  const decisionSiblingId = '100000000000000110';
  assert.equal(writers.admitClickAndBeginAuthorization(f.state, historicalInput(f, markedId)).accepted, true);
  f.state.receipt(null, HISTORICAL_DECISION_KINDS.CLICK, {
    journal: 'decision-v1', interactionId: markedId, authorizationPending: 'true'
  });
  f.state.receipt(null, 'decision-unknown-later', { journal: 'decision-v1', interactionId: markedId });
  f.state.receipt(null, HISTORICAL_DECISION_KINDS.AUTHORIZATION_OUTCOME, {
    journal: 'decision-v1', interactionId: 17, outcome: 'denied'
  });
  const before = rawJournalSnapshot(f.state);
  await f.reopen();

  assert.equal(compatibilityMarkerFor(f.state, markedId), true);
  assert.equal(compatibilityMarkerFor(f.state, decisionSiblingId), false);
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

  for (const id of [genericSiblingId, markedId]) {
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
  const markedReceiptRows = f.state.db.prepare(
    'SELECT id, discord_id, kind, detail, created_at FROM receipts ORDER BY id'
  ).all().filter(row => JSON.parse(row.detail).interactionId === markedId);
  assert.equal(writers.admitClick(f.state, historicalInput(f, decisionSiblingId)).accepted, true);
  const siblingRemaining = await decisionConsumer.recover(new AbortController().signal);
  assert.ok(siblingRemaining.some(click => click.interactionId === markedId));
  assert.equal(f.state.getDecisionClick(decisionSiblingId).canonical.answer, 'approve');
  assert.ok(decisionCounters.canonical > 0);
  assert.ok(decisionCounters.native > 0);
  assert.ok(decisionCounters.project > 0);
  assert.deepEqual(f.state.db.prepare(
    'SELECT id, discord_id, kind, detail, created_at FROM receipts ORDER BY id'
  ).all().filter(row => JSON.parse(row.detail).interactionId === markedId), markedReceiptRows);

  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  await f.gateway.reconcilePending();
  const genericMessage = f.state.getMessage(genericSiblingId);
  const markedMessage = f.state.getMessage(markedId);
  const decisionMessage = f.state.getMessage(decisionSiblingId);
  assert.ok(genericMessage);
  assert.ok(markedMessage);
  assert.ok(decisionMessage);
  assert.equal(genericMessage.state, 'submitted');
  assert.equal(f.state.hasNativeAcknowledgment(genericMessage), false);
  assert.equal(markedMessage.state, 'accepted');
  assert.equal(f.state.isInteractionMessage(markedId), false);
  assert.equal(decisionMessage.state, 'accepted');
  assert.equal(f.state.isInteractionMessage(decisionSiblingId), true);
  assert.equal(compatibilityMarkerFor(f.state, decisionSiblingId), false);
  assert.equal(f.state.getDecisionClick(decisionSiblingId).canonical.answer, 'approve');
  assert.ok(f.state.listDecisionPendingWork().some(click => click.interactionId === decisionSiblingId));
  assert.equal(f.state.hasNativeAcknowledgment(decisionMessage), false);
  assert.deepEqual(f.dispatches.map(message => message.id), [genericSiblingId]);
  assert.deepEqual(f.state.db.prepare(
    'SELECT id, discord_id, kind, detail, created_at FROM receipts ORDER BY id'
  ).all().filter(row => JSON.parse(row.detail).interactionId === markedId), markedReceiptRows);

  const control = await fixture(t);
  const controlId = '100000000000000120';
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

  const longAnswer = '界'.repeat(4097);
  assert.equal(longAnswer.length, 4097);
  assert.equal(Buffer.byteLength(longAnswer, 'utf8'), 12291);
  const attached = renderDecisionProjection(presentation, longAnswer);
  assert.equal(attached.content, `${presentation.content}\n\nSelected action is attached in selected-action.txt.`);
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


for (const scenario of [
  {
    title: 'Gateway stop releases a held decision channel fetch before its late result',
    stage: 'channel',
    outcome: 'not_sent'
  },
  {
    title: 'Gateway stop releases a held decision message fetch before its late result',
    stage: 'message',
    outcome: 'not_sent'
  },
  {
    title: 'Gateway stop classifies a held decision edit as unknown before its late result',
    stage: 'edit',
    outcome: 'unknown'
  }
]) {
  test(scenario.title, { timeout: 30000 }, async t => {
    let releaseHeld;
    let enterHeld;
    const held = new Promise(resolve => { releaseHeld = resolve; });
    const entered = new Promise(resolve => { enterHeld = resolve; });
    const release = () => {
      releaseHeld();
      enterHeld();
    };
    t.signal.addEventListener('abort', release, { once: true });
    t.after(release);
    let f;
    let stopping;
    try {
      f = await fixture(t);
      const calls = { channel: 0, message: 0, edit: 0 };
      const waitForHeld = value => {
        enterHeld();
        return held.then(() => value);
      };
      const question = {
        id: f.presentation.messageId,
        edit(payload) {
          calls.edit += 1;
          f.edits.push(payload);
          const edited = { id: f.presentation.messageId, ...payload };
          return scenario.stage === 'edit' ? waitForHeld(edited) : Promise.resolve(edited);
        }
      };
      const channel = {
        id: 'channel',
        messages: {
          fetch(messageId) {
            assert.equal(messageId, f.presentation.messageId);
            calls.message += 1;
            return scenario.stage === 'message' ? waitForHeld(question) : Promise.resolve(question);
          }
        }
      };
      f.gateway.client.channels.fetch = channelId => {
        assert.equal(channelId, 'channel');
        calls.channel += 1;
        return scenario.stage === 'channel' ? waitForHeld(channel) : Promise.resolve(channel);
      };
      f.gateway.started = true;
      f.gateway.transportReady = true;
      f.gateway.ready = true;
      const listener = f.listeners.get('interactionCreate');
      assert.equal(typeof listener, 'function');
      const interactionId = `stop-held-projection-${scenario.stage}`;
      listener(component(f.presentation, interactionId, 0));
      await entered;
      assert.equal(t.signal.aborted, false, 'the controlled projection wait was reached');
      const tracked = [...f.gateway.inFlight];
      assert.equal(tracked.length, 1, 'the real interaction listener owns the projection work');
      let workSettled = false;
      Promise.allSettled(tracked).then(() => { workSettled = true; });
      let stopSettled = false;
      let stopError;
      stopping = f.gateway.stop().then(
        () => { stopSettled = true; },
        error => { stopError = error; stopSettled = true; }
      );
      // Only abort continuations may run before this turn. The SDK wait stays held.
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(workSettled, true, 'stop must settle tracked work without the held SDK result');
      assert.equal(stopSettled, true, 'stop must not join the unresolved SDK promise');
      assert.ifError(stopError);
      await stopping;
      assert.equal(f.gateway.inFlight.size, 0);
      assert.equal(f.gateway.controllers.size, 0);
      const click = f.state.getDecisionClick(interactionId);
      assert.equal(click.projectionOutcome, scenario.outcome,
        'an uninvoked edit is not_sent and an invoked ambiguous edit is unknown');
      const beforeLateResult = { ...calls };
      assert.equal(calls.edit, scenario.stage === 'edit' ? 1 : 0);
      release();
      await held;
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(calls, beforeLateResult, 'a late SDK result starts no further lookup or edit');
      assert.equal(f.dispatches.length, 0, 'stop and late fulfillment start no native dispatch');
      assert.equal(f.state.getDecisionClick(interactionId).projectionOutcome, scenario.outcome,
        'late success cannot replace the cancellation outcome');
    } finally {
      release();
      if (stopping) await stopping;
      if (f) await Promise.allSettled([...f.gateway.inFlight]);
      t.signal.removeEventListener('abort', release);
    }
  });
}
