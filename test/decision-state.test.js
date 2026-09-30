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
