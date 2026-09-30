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
const { NATIVE_ID, fixture, closeFixture, presentation, click, decisionInteraction, decisionJson, presented, materializedWinner, canonicalRoute } = require('./decision-state-fixture');

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
