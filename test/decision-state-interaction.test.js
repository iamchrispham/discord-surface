const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeAgentMessage, KINDS } = require('../src/agent-message');
const { claudeEvent, codexPrompt } = require('../src/native');
const {
  DECISION_AUTHORIZATION_OUTCOMES,
  DECISION_REASONS: DOMAIN_DECISION_REASONS
} = require('../src/state/decision');
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

test('denied rejection follow-up stays pending across restart until sent', () => {
  const fixtureState = fixture();
  try {
    const { state, dbPath } = fixtureState;
    presented(state);
    assert.equal(state.admitDecisionClickAndBeginAuthorization({ ...click(state), applicationId: 'application', token: 'token' }).accepted, true);
    assert.equal(state.recordDecisionAuthorizationOutcome('interaction-1', DECISION_AUTHORIZATION_OUTCOMES.DENIED).accepted, true);
    assert.equal(state.beginDecisionRejectionFollowup('interaction-1').accepted, true);
    assert.equal(state.recordDecisionRejectionOutcome('interaction-1', DECISION_TRANSPORT_OUTCOMES.RATE_LIMITED).accepted, true);
    assert.equal(state.listDecisionPendingWork().length, 1);

    state.close();
    fixtureState.state = new SurfaceState(dbPath);
    const recovered = fixtureState.state.listDecisionPendingWork()[0];
    assert.equal(recovered.token, 'token');
    assert.equal(fixtureState.state.beginDecisionRejectionFollowup('interaction-1').accepted, true);
    assert.equal(fixtureState.state.recordDecisionRejectionOutcome('interaction-1', DECISION_TRANSPORT_OUTCOMES.SENT).accepted, true);
    assert.equal(fixtureState.state.listDecisionPendingWork().length, 0);
  } finally {
    closeFixture(fixtureState);
  }
});

test('successful projection closes custody after native submission', () => {
  const fixtureState = fixture();
  try {
    const { state } = fixtureState;
    presented(state);
    assert.equal(state.admitDecisionClick(click(state)).accepted, true);
    assert.equal(state.importDecisionWinner('interaction-1', materializedWinner()).accepted, true);
    assert.equal(state.recordDecisionNativeReturnOutcome('interaction-1', DECISION_NATIVE_OUTCOMES.SUBMITTED).accepted, true);
    assert.equal(state.getDecisionClick('interaction-1')?.state, DECISION_STATES.MATERIALIZED_PROJECTION_PENDING);
    assert.equal(state.recordDecisionProjectionOutcome('interaction-1', DECISION_TRANSPORT_OUTCOMES.SENT).accepted, true);
    assert.equal(state.getDecisionClick('interaction-1')?.state, DECISION_STATES.TERMINAL);
    assert.equal(state.listDecisionPendingWork().length, 0);
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
      id: '9001', guildId: 'guild', channelId: 'channel', authorId: 'operator',
      isBot: false, attachments: [], content: 'ordinary request'
    });
    assert.equal(ordinary.accepted, true);
    assert.equal(state.getMessage('9001').decisionResult, undefined);

    const agentFixtureState = fixture({ guildId: '100', channelId: '102' });
    const agentState = agentFixtureState.state;
    const agentBinding = agentState.getBinding('102');
    agentState.enrollThread({ threadId: '103', parentChannelId: '102', guildId: '100' , adoptionCutoff: '100'}, agentBinding);
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
        id: '9000', guildId: agentBinding.guildId, channelId: '103', authorId: 'agent-author',
        isBot: true, attachments: [], content: encodeAgentMessage(agentPacket, 'decision-agent-token')
      }, { agentToken: 'decision-agent-token' });
      assert.equal(agent.accepted, true);
      assert.equal(agentState.getMessage('9000').decisionResult, undefined);
      assert.deepEqual(agentState.getMessage('9000').agentMessage, agentPacket);
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
