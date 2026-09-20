const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeAgentMessage, KINDS } = require('../src/agent-message');
const { claudeEvent, codexPrompt } = require('../src/native');
const { DECISION_REASONS: DOMAIN_DECISION_REASONS } = require('../src/state/decision');
const {
  DECISION_NATIVE_OUTCOMES,
  DECISION_RECEIPT_KINDS,
  DECISION_REASONS: STATE_DECISION_REASONS,
  DECISION_STATES,
  DECISION_TRANSPORT_OUTCOMES,
  DECISION_WINNER_SOURCES,
  MESSAGE_STATES,
  UnresolvedWorkError,
  SurfaceState
} = require('../src/state');

const NATIVE_ID = '9caa5d21-2169-429d-918b-5f08651b5dbd';

function fixture({ guildId = 'guild', channelId = 'channel' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-decision-state-'));
  const dbPath = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(dbPath);
  state.setConfig({
    operatorId: 'operator',
    guildId,
    secretFile: path.join(dir, 'discord.secret')
  });
  state.bind({
    channelId,
    guildId,
    provider: 'codex',
    nativeId: NATIVE_ID,
    workspace: dir
  });
  state.setBindingReadiness(channelId, 'ready');
  return { dir, dbPath, state };
}

function closeFixture({ dir, state }) {
  try { state.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function presentation(state, overrides = {}) {
  return {
    presentationId: 'presentation-1',
    requestId: 'request-1',
    qid: 'qid-1',
    questionGeneration: 'question-generation-1',
    target: 'target-1',
    guildId: 'guild',
    channelId: 'channel',
    binding: state.getBinding('channel'),
    keys: ['approve', 'decline'],
    ...overrides
  };
}

function click(state, overrides = {}) {
  return {
    interactionId: 'interaction-1',
    presentationId: 'presentation-1',
    selectedKey: 'approve',
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    messageId: 'message-1',
    binding: state.getBinding('channel'),
    ...overrides
  };
}

function decisionInteraction(state, overrides = {}) {
  return {
    interactionId: 'decision-interaction-1',
    presentationId: 'presentation-1',
    selectedKey: 'approve',
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    questionMessageId: 'message-1',
    binding: state.getBinding('channel'),
    qid: 'qid-1',
    questionGeneration: 'question-generation-1',
    target: 'target-1',
    canonicalSource: DECISION_WINNER_SOURCES.CURRENT,
    canonicalReference: 'answer-1',
    answer: 'canonical answer',
    ...overrides
  };
}

function decisionJson(text) {
  const line = text.split('\n').find(value => value.startsWith('Decision JSON: '));
  assert.ok(line, 'decision JSON line missing');
  return JSON.parse(line.slice('Decision JSON: '.length));
}

function presented(state) {
  const registered = state.registerDecisionPresentation(presentation(state));
  assert.equal(registered.created, true);
  return state.recordDecisionPresentationOutcome(
    'presentation-1',
    DECISION_TRANSPORT_OUTCOMES.SENT,
    'message-1'
  );
}

function materializedWinner(overrides = {}) {
  return {
    qid: 'qid-1',
    questionGeneration: 'question-generation-1',
    target: 'target-1',
    source: DECISION_WINNER_SOURCES.CURRENT,
    materialized: true,
    reference: 'answer-1',
    answer: 'canonical answer',
    ...overrides
  };
}

function canonicalRoute(dir, suffix = 'one') {
  return {
    executable: path.join(dir, suffix, 'tg-canonical.mjs'),
    stateRoot: path.join(dir, suffix, 'state'),
    telegramRoot: path.join(dir, suffix, 'telegram')
  };
}

test('presentation custody distinguishes unanswered from accepted work and persists', () => {
  const fixtureState = fixture();
  try {
    const { state, dbPath, dir } = fixtureState;
    assert.strictEqual(STATE_DECISION_REASONS, DOMAIN_DECISION_REASONS);
    const output = presented(state);
    assert.equal(output.state, DECISION_STATES.PRESENTED_UNANSWERED);
    assert.equal(output.questionGeneration, 'question-generation-1');
    assert.equal(typeof output.binding.generation, 'number');
    assert.deepEqual(state.listDecisionPendingWork(), []);
    assert.equal(state.hasUnresolved('channel'), false);
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.PRESENTATION).length, 1);

    state.close();
    const reopened = new SurfaceState(dbPath);
    try {
      const restored = reopened.getDecisionPresentation('presentation-1');
      assert.equal(restored.state, DECISION_STATES.PRESENTED_UNANSWERED);
      assert.equal(restored.messageId, 'message-1');
      assert.equal(restored.questionGeneration, 'question-generation-1');
    } finally {
      reopened.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (error) {
    closeFixture(fixtureState);
    throw error;
  }
});

test('producer route and content persist across reopen and remain duplicate-stable', () => {
  const fixtureState = fixture();
  try {
    const { state, dbPath, dir } = fixtureState;
    const route = canonicalRoute(dir);
    const input = presentation(state, {
      namespace: 'producer-namespace',
      presentationId: 'producer-presentation',
      requestId: 'producer-request',
      canonicalRoute: { ...route },
      content: 'Promote the canonical answer?'
    });
    const created = state.registerDecisionPresentation(input);
    assert.equal(created.created, true);
    assert.deepEqual(created.presentation.canonicalRoute, route);
    assert.equal(created.presentation.content, input.content);
    input.canonicalRoute.stateRoot = path.join(dir, 'mutated-state');
    input.content = 'mutated content';
    assert.equal(created.presentation.canonicalRoute.stateRoot, route.stateRoot);
    assert.equal(created.presentation.content, 'Promote the canonical answer?');

    const duplicate = state.registerDecisionPresentation(presentation(state, {
      namespace: 'producer-namespace',
      presentationId: 'producer-presentation',
      requestId: 'producer-request',
      canonicalRoute: route,
      content: 'Promote the canonical answer?'
    }));
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.duplicate, true);

    assert.throws(
      () => state.registerDecisionPresentation(presentation(state, {
        namespace: 'producer-namespace',
        presentationId: 'producer-presentation',
        requestId: 'producer-request',
        canonicalRoute: route,
        content: 'Changed canonical content'
      })),
      /presentation identity conflicts with existing custody/
    );
    assert.throws(
      () => state.registerDecisionPresentation(presentation(state, {
        namespace: 'changed-namespace',
        presentationId: 'producer-presentation',
        requestId: 'producer-request',
        canonicalRoute: route,
        content: 'Promote the canonical answer?'
      })),
      /presentation identity conflicts with existing custody/
    );
    assert.throws(
      () => state.registerDecisionPresentation(presentation(state, {
        namespace: 'producer-namespace',
        presentationId: 'producer-presentation',
        requestId: 'producer-request',
        canonicalRoute: canonicalRoute(dir, 'changed'),
        content: 'Promote the canonical answer?'
      })),
      /presentation identity conflicts with existing custody/
    );

    const sent = state.recordDecisionPresentationOutcome(
      'producer-presentation',
      DECISION_TRANSPORT_OUTCOMES.SENT,
      'producer-message'
    );
    assert.equal(sent.messageId, 'producer-message');
    const registeredRepeat = state.registerDecisionPresentation(presentation(state, {
      namespace: 'producer-namespace',
      presentationId: 'producer-presentation',
      requestId: 'producer-request',
      canonicalRoute: route,
      content: 'Promote the canonical answer?'
    }));
    assert.equal(registeredRepeat.created, false);
    assert.equal(registeredRepeat.duplicate, true);
    assert.equal(registeredRepeat.presentation.messageId, 'producer-message');
    assert.deepEqual(state.findDecisionPresentation({
      namespace: 'producer-namespace',
      requestId: 'producer-request',
      channelId: 'channel',
      provider: 'codex',
      nativeId: NATIVE_ID,
      generation: 1
    }), sent);
    assert.equal(state.findDecisionPresentation({
      namespace: 'other-namespace',
      requestId: 'producer-request',
      channelId: 'channel',
      provider: 'codex',
      nativeId: NATIVE_ID,
      generation: 1
    }), null);
    assert.deepEqual(state.recordDecisionPresentationOutcome(
      'producer-presentation',
      DECISION_TRANSPORT_OUTCOMES.SENT
    ), sent);
    assert.deepEqual(state.recordDecisionPresentationOutcome(
      'producer-presentation',
      DECISION_TRANSPORT_OUTCOMES.SENT,
      null
    ), sent);
    assert.deepEqual(state.recordDecisionPresentationOutcome(
      'producer-presentation',
      DECISION_TRANSPORT_OUTCOMES.SENT,
      'producer-message'
    ), sent);
    assert.throws(
      () => state.recordDecisionPresentationOutcome(
        'producer-presentation',
        DECISION_TRANSPORT_OUTCOMES.SENT,
        'different-producer-message'
      ),
      /presentation outcome conflicts with existing custody/
    );

    const receipt = state.listReceipts().find(row => row.kind === DECISION_RECEIPT_KINDS.PRESENTATION);
    assert.deepEqual(JSON.parse(receipt.detail).canonicalRoute, route);
    assert.equal(JSON.parse(receipt.detail).content, 'Promote the canonical answer?');

    state.close();
    const reopened = new SurfaceState(dbPath);
    try {
      const restored = reopened.getDecisionPresentation('producer-presentation');
      assert.equal(restored.namespace, 'producer-namespace');
      assert.deepEqual(restored.canonicalRoute, route);
      assert.equal(restored.content, 'Promote the canonical answer?');
      assert.equal(restored.messageId, 'producer-message');
      assert.deepEqual(reopened.findDecisionPresentation({
        namespace: 'producer-namespace',
        requestId: 'producer-request',
        channelId: 'channel',
        provider: 'codex',
        nativeId: NATIVE_ID,
        generation: 1
      }), restored);
    } finally {
      reopened.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (error) {
    closeFixture(fixtureState);
    throw error;
  }
});

test('producer lookup refuses ambiguous saved presentations', () => {
  const fixtureState = fixture();
  try {
    const { state, dir } = fixtureState;
    const input = {
      namespace: 'ambiguous-namespace',
      requestId: 'ambiguous-request',
      canonicalRoute: canonicalRoute(dir),
      content: 'ambiguous content'
    };
    assert.equal(state.registerDecisionPresentation(presentation(state, {
      ...input,
      presentationId: 'ambiguous-presentation-1'
    })).created, true);
    assert.equal(state.registerDecisionPresentation(presentation(state, {
      ...input,
      presentationId: 'ambiguous-presentation-2'
    })).created, true);
    assert.throws(
      () => state.findDecisionPresentation({
        namespace: input.namespace,
        requestId: input.requestId,
        channelId: 'channel',
        provider: 'codex',
        nativeId: NATIVE_ID,
        generation: 1
      }),
      /decision presentation lookup is ambiguous/
    );
  } finally {
    closeFixture(fixtureState);
  }
});

test('producer route and content require complete bounded absolute values', () => {
  const fixtureState = fixture();
  try {
    const { state, dir } = fixtureState;
    const route = canonicalRoute(dir);
    assert.throws(
      () => state.registerDecisionPresentation(presentation(state, { canonicalRoute: route })),
      /canonicalRoute and content must be provided together/
    );
    assert.throws(
      () => state.registerDecisionPresentation(presentation(state, { content: 'content without route' })),
      /canonicalRoute and content must be provided together/
    );
    assert.throws(
      () => state.registerDecisionPresentation(presentation(state, {
        canonicalRoute: { ...route, stateRoot: 'relative/state' },
        content: 'content'
      })),
      /canonicalRoute\.stateRoot must be an absolute path/
    );
    assert.throws(
      () => state.registerDecisionPresentation(presentation(state, {
        canonicalRoute: { ...route, executable: `${route.executable}\nforged` },
        content: 'content'
      })),
      /canonicalRoute\.executable must be an absolute path/
    );
    assert.throws(
      () => state.registerDecisionPresentation(presentation(state, {
        canonicalRoute: route,
        content: ''
      })),
      /content must be a non-empty string/
    );
    assert.throws(
      () => state.registerDecisionPresentation(presentation(state, {
        canonicalRoute: route,
        content: 'x'.repeat(2001)
      })),
      /content must be a non-empty string of at most 2000 characters/
    );
  } finally {
    closeFixture(fixtureState);
  }
});

test('producer registration rechecks binding inside its transaction', () => {
  const fixtureState = fixture();
  try {
    const { state, dir } = fixtureState;
    const originalGetBinding = state.getBinding.bind(state);
    let calls = 0;
    state.getBinding = channelId => {
      const binding = originalGetBinding(channelId);
      calls += 1;
      return calls === 2 && binding ? { ...binding, generation: binding.generation + 1 } : binding;
    };
    const result = state.registerDecisionPresentation(presentation(state, {
      presentationId: 'transactional-presentation',
      requestId: 'transactional-request',
      canonicalRoute: canonicalRoute(dir),
      content: 'transactional content'
    }));
    assert.equal(result.created, false);
    assert.equal(result.reason, 'stale-binding');
    assert.ok(calls >= 2);
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.PRESENTATION).length, 0);
  } finally {
    closeFixture(fixtureState);
  }
});

test('click admission is authenticated, duplicate-safe, and continuation-preserving', () => {
  const fixtureState = fixture();
  try {
    const { state } = fixtureState;
    presented(state);
    const first = state.admitDecisionClick(click(state));
    assert.equal(first.accepted, true);
    assert.equal(first.click.state, DECISION_STATES.CLICK_ADMITTED);

    const duplicate = state.admitDecisionClick(click(state));
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.continuing, true);
    assert.equal(duplicate.click.interactionId, 'interaction-1');

    const conflict = state.admitDecisionClick(click(state, { selectedKey: 'decline' }));
    assert.equal(conflict.accepted, false);
    assert.equal(conflict.reason, 'duplicate-interaction-conflict');
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.CLICK).length, 1);
    assert.equal(state.listDecisionPendingWork().length, 1);
  } finally {
    closeFixture(fixtureState);
  }
});

test('stale binding refuses a new click without creating click custody', () => {
  const fixtureState = fixture();
  try {
    const { state } = fixtureState;
    presented(state);
    state.db.prepare('UPDATE bindings SET active=0 WHERE channel_id=?').run('channel');
    const rejected = state.admitDecisionClick(click(state));
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.stale, true);
    assert.equal(rejected.reason, 'stale-binding');
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.CLICK).length, 0);
  } finally {
    closeFixture(fixtureState);
  }
});

test('claim-only winner remains pending until the materialized saved winner arrives', () => {
  const fixtureState = fixture();
  try {
    const { state } = fixtureState;
    presented(state);
    assert.equal(state.admitDecisionClick(click(state)).accepted, true);
    assert.equal(state.beginDecisionCallback('interaction-1').accepted, true);
    assert.equal(state.recordDecisionCallbackOutcome('interaction-1', DECISION_TRANSPORT_OUTCOMES.UNKNOWN).accepted, true);
    const imported = state.importDecisionWinner('interaction-1', {
      qid: 'qid-1',
      questionGeneration: 'question-generation-1',
      target: 'target-1',
      source: DECISION_WINNER_SOURCES.CLAIM,
      materialized: false,
      reference: 'claim-1'
    });
    assert.equal(imported.accepted, true);
    assert.equal(imported.click.state, DECISION_STATES.CLAIM_ONLY);
    const native = state.queueDecisionNativeReturn('interaction-1');
    assert.equal(native.accepted, false);
    assert.equal(native.reason, 'native-return-requires-materialized-winner');
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.NATIVE_RETURN).length, 0);
    assert.equal(state.getMessage('interaction-1'), null);
    assert.throws(() => state.unbind('channel'), UnresolvedWorkError);

    const materialized = state.importDecisionWinner('interaction-1', materializedWinner({
      source: DECISION_WINNER_SOURCES.HISTORY,
      reference: 'saved-answer-1',
      answer: 'saved answer'
    }));
    assert.equal(materialized.accepted, true);
    assert.equal(materialized.click.state, DECISION_STATES.NATIVE_RETURN_PENDING);
    assert.equal(materialized.click.nativeReturn.qid, 'qid-1');
    assert.equal(materialized.click.nativeReturn.questionGeneration, 'question-generation-1');
    assert.equal(materialized.click.nativeReturn.target, 'target-1');
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.NATIVE_RETURN).length, 1);
    assert.equal(state.getMessage('interaction-1').content, 'saved answer');
    assert.equal(state.interactionResponseTarget('interaction-1'), 'message-1');
    const queuedDuplicate = state.queueDecisionNativeReturn('interaction-1');
    assert.equal(queuedDuplicate.accepted, false);
    assert.equal(queuedDuplicate.duplicate, true);

    const conflict = state.importDecisionWinner('interaction-1', materializedWinner({
      reference: 'different-answer',
      answer: 'different canonical answer'
    }));
    assert.equal(conflict.accepted, false);
    assert.equal(conflict.reason, 'canonical-result-conflict');
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.CANONICAL_IMPORT).length, 2);
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.NATIVE_RETURN).length, 1);
    assert.equal(state.listMessages().filter(message => message.id.startsWith('interaction-')).length, 1);
  } finally {
    closeFixture(fixtureState);
  }
});

test('materialized winner uses opaque question generation and dedupes native return', () => {
  const fixtureState = fixture();
  try {
    const { state } = fixtureState;
    presented(state);
    assert.equal(state.admitDecisionClick(click(state)).accepted, true);
    assert.equal(state.admitDecisionClick(click(state, { interactionId: 'interaction-2', selectedKey: 'decline' })).accepted, true);

    const wrongGeneration = state.importDecisionWinner('interaction-1', materializedWinner({ questionGeneration: 'numeric-looking-2' }));
    assert.equal(wrongGeneration.accepted, false);
    assert.equal(wrongGeneration.reason, 'canonical-identity-mismatch');

    const firstImport = state.importDecisionWinner('interaction-1', materializedWinner());
    assert.equal(firstImport.accepted, true);
    assert.equal(firstImport.click.state, DECISION_STATES.NATIVE_RETURN_PENDING);
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.NATIVE_RETURN).length, 1);
    const secondImport = state.importDecisionWinner('interaction-2', materializedWinner({
      source: DECISION_WINNER_SOURCES.HISTORY,
      reference: 'saved-answer-1'
    }));
    assert.equal(secondImport.accepted, true);
    assert.equal(secondImport.click.state, DECISION_STATES.MATERIALIZED_PROJECTION_PENDING);
    assert.equal(secondImport.click.nativeReturn, null);
    assert.equal(state.getDecisionClick('interaction-1').state, DECISION_STATES.NATIVE_RETURN_PENDING);
    assert.equal(state.recordDecisionProjectionOutcome('interaction-1', DECISION_TRANSPORT_OUTCOMES.SENT).accepted, true);

    const firstDuplicate = state.queueDecisionNativeReturn('interaction-1');
    assert.equal(firstDuplicate.accepted, false);
    assert.equal(firstDuplicate.duplicate, true);
    const duplicate = state.queueDecisionNativeReturn('interaction-2');
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.existingInteractionId, 'interaction-1');
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.NATIVE_RETURN).length, 1);

    const outcome = state.recordDecisionNativeReturnOutcome('interaction-1', DECISION_NATIVE_OUTCOMES.NOT_SUBMITTED);
    assert.equal(outcome.accepted, true);
    assert.equal(outcome.click.state, DECISION_STATES.UNKNOWN);
    assert.equal(outcome.click.nativeReturn.outcome, DECISION_NATIVE_OUTCOMES.NOT_SUBMITTED);
  } finally {
    closeFixture(fixtureState);
  }
});

test('materialized occurrence preserves provenance, dedupes reopen, and separates generations', () => {
  const fixtureState = fixture();
  try {
    const { state, dbPath } = fixtureState;
    presented(state);
    assert.equal(state.admitDecisionClick(click(state)).accepted, true);
    assert.equal(state.admitDecisionClick(click(state, { interactionId: 'interaction-2', selectedKey: 'decline' })).accepted, true);

    const first = state.importDecisionWinner('interaction-1', materializedWinner());
    assert.equal(first.accepted, true);
    assert.equal(first.click.state, DECISION_STATES.NATIVE_RETURN_PENDING);
    const provenance = state.importDecisionWinner('interaction-2', materializedWinner({
      source: DECISION_WINNER_SOURCES.HISTORY,
      reference: 'history-answer-1'
    }));
    assert.equal(provenance.accepted, true);
    assert.equal(provenance.click.canonical.source, DECISION_WINNER_SOURCES.HISTORY);
    assert.equal(provenance.click.canonical.reference, 'history-answer-1');
    assert.equal(provenance.click.nativeReturn, null);
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.CANONICAL_IMPORT).length, 2);
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.NATIVE_RETURN).length, 1);

    const duplicate = state.importDecisionWinner('interaction-1', materializedWinner({
      source: DECISION_WINNER_SOURCES.HISTORY,
      reference: 'reopened-history-answer-1'
    }));
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.duplicate, true);
    const conflict = state.importDecisionWinner('interaction-2', materializedWinner({ answer: 'different answer' }));
    assert.equal(conflict.accepted, false);
    assert.equal(conflict.reason, 'canonical-result-conflict');
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.CANONICAL_IMPORT).length, 2);
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.NATIVE_RETURN).length, 1);

    assert.equal(state.registerDecisionPresentation(presentation(state, {
      presentationId: 'presentation-2',
      requestId: 'request-2'
    })).created, true);
    assert.equal(state.recordDecisionPresentationOutcome('presentation-2', DECISION_TRANSPORT_OUTCOMES.SENT, 'message-2').state,
      DECISION_STATES.PRESENTED_UNANSWERED);
    assert.equal(state.admitDecisionClick(click(state, {
      interactionId: 'interaction-3',
      presentationId: 'presentation-2',
      messageId: 'message-2'
    })).accepted, true);
    const presentationProvenance = state.importDecisionWinner('interaction-3', materializedWinner({
      source: DECISION_WINNER_SOURCES.HISTORY,
      reference: 'presentation-history-answer-1'
    }));
    assert.equal(presentationProvenance.accepted, true);
    assert.equal(presentationProvenance.click.nativeReturn, null);
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.NATIVE_RETURN).length, 1);

    assert.equal(state.registerDecisionPresentation(presentation(state, {
      presentationId: 'presentation-3',
      requestId: 'request-3',
      questionGeneration: 'question-generation-2'
    })).created, true);
    assert.equal(state.recordDecisionPresentationOutcome('presentation-3', DECISION_TRANSPORT_OUTCOMES.SENT, 'message-3').state,
      DECISION_STATES.PRESENTED_UNANSWERED);
    assert.equal(state.admitDecisionClick(click(state, {
      interactionId: 'interaction-4',
      presentationId: 'presentation-3',
      messageId: 'message-3'
    })).accepted, true);
    const secondOccurrence = state.importDecisionWinner('interaction-4', materializedWinner({
      questionGeneration: 'question-generation-2',
      reference: 'answer-2',
      answer: 'different answer'
    }));
    assert.equal(secondOccurrence.accepted, true);
    assert.equal(secondOccurrence.click.nativeReturn.questionGeneration, 'question-generation-2');
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.NATIVE_RETURN).length, 2);

    state.close();
    fixtureState.state = new SurfaceState(dbPath);
    const reopenedDuplicate = fixtureState.state.importDecisionWinner('interaction-1', materializedWinner({
      source: DECISION_WINNER_SOURCES.HISTORY,
      reference: 'reopened-history-answer-1'
    }));
    assert.equal(reopenedDuplicate.accepted, false);
    assert.equal(reopenedDuplicate.duplicate, true);
    const reopenedQueue = fixtureState.state.queueDecisionNativeReturn('interaction-3');
    assert.equal(reopenedQueue.accepted, false);
    assert.equal(reopenedQueue.duplicate, true);
    assert.equal(reopenedQueue.existingInteractionId, 'interaction-1');
    assert.equal(fixtureState.state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.NATIVE_RETURN).length, 2);
  } finally {
    closeFixture(fixtureState);
  }
});

test('materialized winner rolls back when native intent append fails', () => {
  const fixtureState = fixture();
  try {
    const { state } = fixtureState;
    presented(state);
    assert.equal(state.admitDecisionClick(click(state)).accepted, true);
    const originalReceipt = state.receipt.bind(state);
    state.receipt = (discordId, kind, detail) => {
      if (kind === DECISION_RECEIPT_KINDS.NATIVE_RETURN) throw new Error('simulated native intent receipt failure');
      return originalReceipt(discordId, kind, detail);
    };
    assert.throws(
      () => state.importDecisionWinner('interaction-1', materializedWinner()),
      /simulated native intent receipt failure/
    );
    const restored = state.getDecisionClick('interaction-1');
    assert.equal(restored.state, DECISION_STATES.CLICK_ADMITTED);
    assert.equal(restored.canonical, null);
    assert.equal(restored.nativeReturn, null);
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.CANONICAL_IMPORT).length, 0);
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.NATIVE_RETURN).length, 0);
    assert.equal(state.getMessage('interaction-1'), null);
  } finally {
    closeFixture(fixtureState);
  }
});

test('materialized winner admits one interaction row and preserves canonical target across competing clicks', () => {
  const fixtureState = fixture();
  try {
    const { state, dbPath } = fixtureState;
    presented(state);
    assert.equal(state.admitDecisionClick(click(state)).accepted, true);
    assert.equal(state.admitDecisionClick(click(state, { interactionId: 'interaction-2', selectedKey: 'decline' })).accepted, true);

    const winner = state.importDecisionWinner('interaction-2', materializedWinner({
      source: DECISION_WINNER_SOURCES.HISTORY,
      reference: 'saved-answer-2',
      answer: 'canonical winner'
    }));
    assert.equal(winner.accepted, true);
    const row = state.getMessage('interaction-2');
    assert.equal(row.content, 'canonical winner');
    assert.equal(row.authorId, 'operator');
    assert.deepEqual(row.decisionResult, {
      qid: 'qid-1',
      questionGeneration: 'question-generation-1',
      target: 'target-1',
      canonicalSource: DECISION_WINNER_SOURCES.HISTORY,
      canonicalReference: 'saved-answer-2',
      answer: 'canonical winner',
      questionMessageId: 'message-1',
      interactionId: 'interaction-2',
      selectedKey: 'decline'
    });
    assert.deepEqual(decisionJson(codexPrompt(row)), row.decisionResult);
    assert.deepEqual(decisionJson(claudeEvent(row).content), row.decisionResult);
    assert.equal(state.getMessage('interaction-1'), null);
    assert.equal(state.interactionResponseTarget('interaction-2'), 'message-1');

    const origin = state.listReceipts().find(receipt => receipt.discord_id === 'interaction-2' && receipt.kind === 'interaction-origin');
    assert.deepEqual(JSON.parse(origin.detail), {
      interactionId: 'interaction-2',
      source: 'decision-component',
      presentationId: 'presentation-1',
      selectedKey: 'decline',
      actorId: 'operator',
      guildId: 'guild',
      channelId: 'channel',
      questionMessageId: 'message-1',
      responseMessageId: 'message-1',
      qid: 'qid-1',
      questionGeneration: 'question-generation-1',
      target: 'target-1',
      canonicalSource: DECISION_WINNER_SOURCES.HISTORY,
      canonicalReference: 'saved-answer-2',
      answer: 'canonical winner',
      provider: 'codex',
      nativeId: NATIVE_ID,
      workspace: fixtureState.dir,
      endpoint: null,
      conductorId: null,
      repoKey: null,
      generation: 1,
      readiness: 'ready',
      binding: state.getBinding('channel')
    });

    const losingImport = state.importDecisionWinner('interaction-1', materializedWinner({
      source: DECISION_WINNER_SOURCES.HISTORY,
      reference: 'saved-answer-2',
      answer: 'canonical winner'
    }));
    assert.equal(losingImport.accepted, true);
    assert.equal(losingImport.click.nativeReturn, null);
    assert.equal(state.listMessages().filter(message => message.id.startsWith('interaction-')).length, 1);

    state.close();
    fixtureState.state = new SurfaceState(dbPath);
    assert.equal(fixtureState.state.getMessage('interaction-2').content, 'canonical winner');
    const recovered = fixtureState.state.queueDecisionNativeReturn('interaction-1');
    assert.equal(recovered.accepted, false);
    assert.equal(recovered.duplicate, true);
    assert.equal(recovered.existingInteractionId, 'interaction-2');
    assert.equal(fixtureState.state.interactionResponseTarget('interaction-2'), 'message-1');
  } finally {
    closeFixture(fixtureState);
  }
});

test('stale binding rejects materialized interaction admission atomically', () => {
  const fixtureState = fixture();
  try {
    const { state } = fixtureState;
    presented(state);
    assert.equal(state.admitDecisionClick(click(state)).accepted, true);
    state.db.prepare('UPDATE bindings SET active=0 WHERE channel_id=?').run('channel');
    assert.throws(
      () => state.importDecisionWinner('interaction-1', materializedWinner()),
      /materialized winner native interaction admission failed: stale-binding/
    );
    const restored = state.getDecisionClick('interaction-1');
    assert.equal(restored.canonical, null);
    assert.equal(restored.nativeReturn, null);
    assert.equal(state.getMessage('interaction-1'), null);
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.NATIVE_RETURN).length, 0);
  } finally {
    closeFixture(fixtureState);
  }
});

test('native return advances from in-flight to submitted across reopen', () => {
  const fixtureState = fixture();
  try {
    const { state, dbPath } = fixtureState;
    presented(state);
    assert.equal(state.admitDecisionClick(click(state)).accepted, true);
    assert.equal(state.importDecisionWinner('interaction-1', materializedWinner()).accepted, true);
    assert.equal(state.recordDecisionProjectionOutcome('interaction-1', DECISION_TRANSPORT_OUTCOMES.SENT).accepted, true);
    const queuedDuplicate = state.queueDecisionNativeReturn('interaction-1');
    assert.equal(queuedDuplicate.accepted, false);
    assert.equal(queuedDuplicate.duplicate, true);
    const inFlight = state.recordDecisionNativeReturnOutcome('interaction-1', DECISION_NATIVE_OUTCOMES.IN_FLIGHT);
    assert.equal(inFlight.accepted, true);
    assert.equal(inFlight.click.nativeReturn.outcome, DECISION_NATIVE_OUTCOMES.IN_FLIGHT);

    state.close();
    fixtureState.state = new SurfaceState(dbPath);
    const submitted = fixtureState.state.recordDecisionNativeReturnOutcome('interaction-1', DECISION_NATIVE_OUTCOMES.SUBMITTED);
    assert.equal(submitted.accepted, true);
    assert.equal(submitted.click.state, DECISION_STATES.TERMINAL);
    assert.equal(submitted.click.nativeReturn.outcome, DECISION_NATIVE_OUTCOMES.SUBMITTED);

    const duplicate = fixtureState.state.recordDecisionNativeReturnOutcome('interaction-1', DECISION_NATIVE_OUTCOMES.SUBMITTED);
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.duplicate, true);
    const conflict = fixtureState.state.recordDecisionNativeReturnOutcome('interaction-1', DECISION_NATIVE_OUTCOMES.NOT_SUBMITTED);
    assert.equal(conflict.accepted, false);
    assert.equal(conflict.reason, 'native-outcome-conflict');
  } finally {
    closeFixture(fixtureState);
  }
});

test('click and callback admission is atomic and duplicate-safe', () => {
  const fixtureState = fixture();
  try {
    const { state } = fixtureState;
    presented(state);
    const first = state.admitDecisionClickAndBeginCallback(click(state));
    assert.equal(first.accepted, true);
    assert.equal(first.click.state, DECISION_STATES.CALLBACK_PENDING);
    assert.equal(first.click.callbackAttempted, true);
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.CLICK).length, 1);
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.CALLBACK_ATTEMPT).length, 1);

    const duplicate = state.admitDecisionClickAndBeginCallback(click(state));
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.continuing, true);
    assert.equal(state.listReceipts().filter(row => row.kind === DECISION_RECEIPT_KINDS.CALLBACK_ATTEMPT).length, 1);
  } finally {
    closeFixture(fixtureState);
  }
});

test('public decision interaction rejects numeric and object question generations', () => {
  const fixtureState = fixture();
  try {
    const { state } = fixtureState;
    presented(state);
    for (const [index, questionGeneration] of [2, {}].entries()) {
      const result = state.acceptDecisionInteraction(decisionInteraction(state, {
        interactionId: `invalid-generation-${index}`,
        questionGeneration
      }));
      assert.deepEqual(result, { accepted: false, reason: 'invalid-decision-interaction' });
      assert.equal(state.getMessage(`invalid-generation-${index}`), null);
    }
    assert.equal(state.listReceipts().some(row => row.kind === 'interaction-origin'), false);
  } finally {
    closeFixture(fixtureState);
  }
});

test('getMessage exposes validated decision context and rejects malformed decision evidence', () => {
  const fixtureState = fixture();
  try {
    const { state } = fixtureState;
    presented(state);
    assert.equal(state.admitDecisionClick(click(state)).accepted, true);
    assert.equal(state.importDecisionWinner('interaction-1', materializedWinner({
      source: DECISION_WINNER_SOURCES.HISTORY,
      reference: 'saved-answer-1',
      answer: 'saved answer'
    })).accepted, true);
    const decision = state.getMessage('interaction-1');
    assert.deepEqual(decision.decisionResult, {
      qid: 'qid-1',
      questionGeneration: 'question-generation-1',
      target: 'target-1',
      canonicalSource: DECISION_WINNER_SOURCES.HISTORY,
      canonicalReference: 'saved-answer-1',
      answer: 'saved answer',
      questionMessageId: 'message-1',
      interactionId: 'interaction-1',
      selectedKey: 'approve'
    });
    assert.deepEqual(decisionJson(codexPrompt(decision)), decision.decisionResult);
    assert.deepEqual(decisionJson(claudeEvent(decision).content), decision.decisionResult);

    const ordinary = state.acceptDiscordMessage({
      id: 'ordinary-message-1', guildId: 'guild', channelId: 'channel', authorId: 'operator',
      isBot: false, attachments: [], content: 'ordinary request'
    });
    assert.equal(ordinary.accepted, true);
    assert.equal(state.getMessage('ordinary-message-1').decisionResult, undefined);

    const agentFixtureState = fixture({ guildId: '100', channelId: '102' });
    const agentState = agentFixtureState.state;
    const agentBinding = agentState.getBinding('102');
    agentState.enrollThread({ threadId: '103', parentChannelId: '102', guildId: '100' }, agentBinding);
    agentState.markThreadBoundary('103', 'ready', 'fixture ready', null, null, agentBinding);
    const agentPacket = {
      id: 'agent-request-1',
      kind: KINDS.REQUEST,
      source: {
        guildId: '100', channelId: '101', provider: 'claude',
        nativeId: '22222222-2222-2222-2222-222222222222', generation: 1
      },
      target: {
        guildId: agentBinding.guildId, channelId: '103', provider: agentBinding.provider,
        nativeId: agentBinding.nativeId, generation: agentBinding.generation
      },
      replyTo: null,
      text: 'agent context'
    };
    try {
      const agent = agentState.acceptDiscordMessage({
        id: 'agent-message-1', guildId: agentBinding.guildId, channelId: '103', authorId: 'agent-author',
        isBot: true, attachments: [], content: encodeAgentMessage(agentPacket, 'decision-agent-token')
      }, { agentToken: 'decision-agent-token' });
      assert.equal(agent.accepted, true);
      assert.equal(agentState.getMessage('agent-message-1').decisionResult, undefined);
      assert.deepEqual(agentState.getMessage('agent-message-1').agentMessage, agentPacket);
    } finally {
      closeFixture(agentFixtureState);
    }

    const origin = state.listReceipts().find(row => row.discord_id === 'interaction-1' && row.kind === 'interaction-origin');
    const malformed = { ...JSON.parse(origin.detail), canonicalSource: DECISION_WINNER_SOURCES.CLAIM };
    state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(JSON.stringify(malformed), origin.id);
    assert.throws(() => state.getMessage('interaction-1'), /decision interaction origin is invalid/);
  } finally {
    closeFixture(fixtureState);
  }
});

test('pre-row decision custody blocks binding mutation without adding a post-row gate', () => {
  const fixtureState = fixture();
  try {
    const { state } = fixtureState;
    presented(state);
    assert.equal(state.admitDecisionClick(click(state)).accepted, true);
    assert.throws(() => state.unbind('channel'), UnresolvedWorkError);
    assert.throws(() => state.rebind({
      ...state.getBinding('channel'),
      nativeId: '7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b'
    }), UnresolvedWorkError);

    assert.equal(state.importDecisionWinner('interaction-1', materializedWinner()).accepted, true);
    assert.throws(() => state.unbind('channel'), UnresolvedWorkError);
    state.db.prepare('UPDATE messages SET state=? WHERE discord_id=?').run(MESSAGE_STATES.REPLIED, 'interaction-1');
    assert.doesNotThrow(() => state.unbind('channel'));
    assert.equal(state.getBinding('channel').active, false);
  } finally {
    closeFixture(fixtureState);
  }
});

test('click and callback admission rolls back when either receipt append fails', () => {
  for (const failureKind of [DECISION_RECEIPT_KINDS.CLICK, DECISION_RECEIPT_KINDS.CALLBACK_ATTEMPT]) {
    const fixtureState = fixture();
    try {
      const { state } = fixtureState;
      presented(state);
      const originalReceipt = state.receipt.bind(state);
      state.receipt = (discordId, kind, detail) => {
        if (kind === failureKind) throw new Error(`simulated ${failureKind} receipt failure`);
        return originalReceipt(discordId, kind, detail);
      };
      assert.throws(
        () => state.admitDecisionClickAndBeginCallback(click(state)),
        new RegExp(`simulated ${failureKind} receipt failure`)
      );
      assert.equal(state.getDecisionClick('interaction-1'), null);
      assert.equal(state.listReceipts().some(row => row.kind === DECISION_RECEIPT_KINDS.CLICK && JSON.parse(row.detail).interactionId === 'interaction-1'), false);
      assert.equal(state.listReceipts().some(row => row.kind === DECISION_RECEIPT_KINDS.CALLBACK_ATTEMPT && JSON.parse(row.detail).interactionId === 'interaction-1'), false);
    } finally {
      closeFixture(fixtureState);
    }
  }
});

test('canonical question generation rejects numeric coercion', () => {
  const fixtureState = fixture();
  try {
    const { state } = fixtureState;
    assert.throws(
      () => state.registerDecisionPresentation(presentation(state, { questionGeneration: 2 })),
      /questionGeneration must be a non-empty string/
    );
  } finally {
    closeFixture(fixtureState);
  }
});
