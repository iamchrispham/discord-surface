const path = require('node:path');
const { createIntakeSerialization } = require('./intake-serialization');
const { createCourierPickupDeadline } = require('./courier-pickup-deadline');
const { PREFIX: AGENT_PREFIX } = require('../agent-message');
const { WATCHER_NOTICE_PREFIX } = require('../watcher-notice');
const { AGENT_ATTACHMENT_FILENAME, normalizeAgentMessage } = require('../agent-attachment');
const { ACK_WAITING, acknowledgmentCommand } = require('../acknowledgment');
const { codexPrompt, dispatchAndObserve, agentCompletionCommand, isCodexWatcherNotice, watcherNoticeCompletionCommand, observeSubmitted, readInitialCursor } = require('../native');
const { MESSAGE_STATES, READINESS, RECOVERY_LIMITS } = require('../state');
const { COURIER_OUTCOMES, COURIER_RESULT_STATUSES, isCourierOriginAllowed } = require('../state/courier-route');
const { THREAD_STATES } = require('../state/thread-enrollment');
const { createTransportReceiptDelivery } = require('./transport-receipts');
const { createOwnerAdmission } = require('./owner-admission');
const { optionalReplyContext } = require('./reply-context-fetch');
const { createReplyDelivery } = require('./reply-delivery');

function createSurfaceConsumer(options, { recoveryError, recoveryKind, compareDiscordIds, bindingIdentityMatches, eventToInput, classifyReplyError }) {
  const { state, stateDir = path.dirname(state.dbPath), providers, sendReply, sendTransportReceipt, prepareReply, trackReceipt, observeOptions = {},
    agentCredential = () => null, agentAttachmentFetch = globalThis.fetch,
    agentAttachmentTimeoutMs = RECOVERY_LIMITS.timeoutMs, agentBotId = () => null, readyForLiveIntake = null, courierRoute = null } = options;
  const { issueTransportReceipt, launchTransportReceipt, waitForReceipts } = createTransportReceiptDelivery({ state, sendTransportReceipt, trackReceipt });
  const { abortNativeWork, courierCustodyRequiresOwnerHold, enqueueOwnerWork, existingNativeWork, hasCurrentNativeAcknowledgment, refreshCourierCustodyBlock, refreshNativeWorkChannel, releaseAcknowledged, releaseHandledWithoutPost, startNativeWork, waitForNativeWork, retryRetiredCourierWork } = createOwnerAdmission({ state, compareDiscordIds });
  const { serializeIntake, releaseIntake } = createIntakeSerialization({ recoveryKind, recoveryError });
  const deliverReply = createReplyDelivery({ state, sendReply, prepareReply, ACK_WAITING, MESSAGE_STATES, classifyReplyError });

  function rejectEnrolledChildBot(message, expectedBinding, ready, coverageId = null) {
    const route = state.getMessageRoute(message?.channelId);
    if (!route?.enrollment || !message?.author?.bot) return null;
    const content = typeof message.content === 'string' ? message.content : '';
    const input = eventToInput(message);
    if (content.startsWith(AGENT_PREFIX) || content.startsWith(WATCHER_NOTICE_PREFIX) || input.attachments?.length) return null;
    return state.acceptDiscordMessage(input, { ready, coverageId, expectedBinding });
  }

  function connectedBotId() {
    return typeof agentBotId === 'function' ? agentBotId() : agentBotId;
  }

  function storedAttachmentInput(message) {
    const input = eventToInput(message);
    if (!message?.author?.bot || !Array.isArray(input.attachments) || input.attachments.length !== 1 ||
      input.attachments[0]?.filename !== AGENT_ATTACHMENT_FILENAME) return null;
    const stored = state.getMessage(message.id);
    if (!stored) return null;
    return { ...input, content: stored.content, attachments: stored.attachments };
  }

  function replyContextIntakeEligible(message, expectedBinding = null) {
    if (!message?.reference?.messageId || message.author?.bot) return false;
    try {
      const input = eventToInput(message);
      const config = state.requireConfig();
      if (input.guildId !== config.guildId || input.authorId !== config.operatorId) return false;
      if (typeof input.content !== 'string' || input.content.length > 10000 || !Array.isArray(input.attachments) ||
        (input.content.length === 0 && input.attachments.length === 0)) return false;
      const route = state.getMessageRoute(input.channelId);
      const enrolledRoute = route?.enrollment || null;
      const binding = route?.binding || state.getBinding(input.channelId);
      if (!binding || !binding.active || binding.guildId !== input.guildId) return false;
      if (expectedBinding && !bindingIdentityMatches(expectedBinding, binding)) return false;
      if (state.ordinaryHandoffPauses?.has(binding.channelId) && !enrolledRoute) return false;
      if (enrolledRoute && [THREAD_STATES.GAP, THREAD_STATES.UNAVAILABLE].includes(enrolledRoute.state)) return false;
      if (state.getMessage(input.id)) return false;

      const watermark = state.getIntakeWatermark(binding.channelId);
      let cutoff = enrolledRoute
        ? enrolledRoute.recoveredThroughId || null
        : watermark?.recovered_through_id || null;
      const handoffCutoff = route?.handoffCutoffId || null;
      if (handoffCutoff && (!cutoff || compareDiscordIds(cutoff, handoffCutoff) < 0)) cutoff = handoffCutoff;
      if (cutoff && (!/^\d+$/.test(input.id) || !/^\d+$/.test(cutoff) || compareDiscordIds(input.id, cutoff) <= 0)) return false;
      return true;
    } catch {
      return false;
    }
  }

  async function normalizeSurfaceMessage(message, options) {
    const input = eventToInput(message);
    if (input.isBot && typeof input.content === 'string' && input.content.startsWith(WATCHER_NOTICE_PREFIX)) return input;
    const replyContextEligibleBeforeNormalization = !input.isBot && replyContextIntakeEligible(message, options?.expectedBinding);
    const normalized = await normalizeAgentMessage(message, input, options);
    if (input.isBot) return normalized;
    const replyContextStillEligible = replyContextEligibleBeforeNormalization &&
      replyContextIntakeEligible(message, options?.expectedBinding);
    if (!replyContextStillEligible) return normalized;
    const replyContext = await optionalReplyContext(message, options);
    return replyContext ? { ...normalized, replyContext } : normalized;
  }

  function courierDispatchStatus(result) {
    if (result?.status === COURIER_OUTCOMES.SUBMITTED) return COURIER_OUTCOMES.SUBMITTED;
    if (result?.status === COURIER_OUTCOMES.NOT_SUBMITTED) return COURIER_OUTCOMES.NOT_SUBMITTED;
    return COURIER_OUTCOMES.UNCERTAIN;
  }

  function selectedCourierRoute(message) {
    if (!courierRoute || typeof courierRoute !== 'object' || typeof courierRoute.routeId !== 'string') return false;
    if (!isCourierOriginAllowed(state, message)) return false;
    const selected = state.getCourierRoute(courierRoute.routeId) || courierRoute;
    if (!selected || selected.parentChannelId !== message.channelId || selected.guildId !== message.guildId) return false;
    if (message.provider !== 'codex') return false;
    if (message.agentMessage) return selected.deliveryChannelId === message.deliveryChannelId;
    if (message.watcherNotice) return selected.deliveryChannelId === message.deliveryChannelId;
    const config = state.requireConfig();
    return message.authorId === config.operatorId && (
      message.channelId === message.deliveryChannelId || selected.deliveryChannelId === message.deliveryChannelId
    );
  }

  function courierDispatchError(status) {
    return new Error(`courier dispatch ${status}`);
  }

  async function dispatchAtCourierBoundary(message, _parentProvider, dispatchOptions, selected) {
    const binding = state.currentMessageBinding(message)?.binding;
    const observerCursor = readInitialCursor(message.nativeId, binding?.sessionRoot || undefined);
    const completion = message.watcherNotice
      ? watcherNoticeCompletionCommand(message, state.dbPath, undefined, stateDir)
      : message.agentMessage ? agentCompletionCommand(message, state.dbPath, undefined, stateDir) : null;
    const prompt = codexPrompt(message, acknowledgmentCommand(message, state.dbPath), completion);
    const input = { routeId: selected.routeId, prompt, observerCursor };
    const claimed = state.beginCourierAttempt(message.id, input);
    if (!claimed.accepted) {
      const previousOutcome = claimed.outcome?.outcome;
      if (previousOutcome) {
        const current = state.authorizeCourierAttempt(message.id, claimed.attempt.attemptId, input);
        if (!current.authorized && current.status !== COURIER_RESULT_STATUSES.DUPLICATE) {
          const status = previousOutcome === COURIER_OUTCOMES.UNCERTAIN
            ? COURIER_OUTCOMES.UNCERTAIN
            : COURIER_OUTCOMES.NOT_SUBMITTED;
          return { status, error: courierDispatchError(current.status) };
        }
        return {
          status: previousOutcome,
          cursor: claimed.attempt?.observerCursor || observerCursor,
          ...(previousOutcome === COURIER_OUTCOMES.UNCERTAIN ? { error: courierDispatchError(previousOutcome) } : {})
        };
      }
      return { status: COURIER_OUTCOMES.NOT_SUBMITTED, error: courierDispatchError(claimed.status) };
    }
    dispatchOptions.onCursor?.(observerCursor);
    if (dispatchOptions.signal?.aborted) {
      state.recordCourierOutcome(message.id, claimed.attempt.attemptId, COURIER_OUTCOMES.NOT_SUBMITTED, {
        reason: 'courier dispatch stopped before queue submission'
      });
      return { status: COURIER_OUTCOMES.NOT_SUBMITTED, error: courierDispatchError(COURIER_OUTCOMES.NOT_SUBMITTED) };
    }
    const authorized = state.authorizeCourierAttempt(message.id, claimed.attempt.attemptId, input);
    if (!authorized.authorized) {
      const priorOutcome = authorized.outcome?.outcome;
      if (Object.values(COURIER_OUTCOMES).includes(priorOutcome)) {
        return {
          status: priorOutcome,
          cursor: authorized.attempt?.observerCursor || observerCursor,
          ...(priorOutcome === COURIER_OUTCOMES.UNCERTAIN ? { error: courierDispatchError(priorOutcome) } : {})
        };
      }
      const status = [COURIER_RESULT_STATUSES.STALE, COURIER_RESULT_STATUSES.HELD, COURIER_RESULT_STATUSES.CONFLICT].includes(authorized.status)
        ? COURIER_OUTCOMES.NOT_SUBMITTED
        : COURIER_OUTCOMES.UNCERTAIN;
      state.recordCourierOutcome(message.id, claimed.attempt.attemptId, status, {
        reason: `courier authorization ${authorized.status}`
      });
      return { status, error: courierDispatchError(authorized.status) };
    }
    const provider = providers[authorized.route.courier.provider];
    if (!provider || typeof provider.dispatchCourier !== 'function') {
      state.recordCourierOutcome(message.id, claimed.attempt.attemptId, COURIER_OUTCOMES.NOT_SUBMITTED, {
        reason: 'courier provider has no fixed queue boundary'
      });
      return { status: COURIER_OUTCOMES.NOT_SUBMITTED, error: courierDispatchError(COURIER_OUTCOMES.NOT_SUBMITTED) };
    }
    let dispatched;
    try {
      dispatched = await provider.dispatchCourier(authorized.envelope, { signal: dispatchOptions.signal });
    } catch (error) {
      dispatched = { status: COURIER_OUTCOMES.UNCERTAIN, error };
    }
    const status = courierDispatchStatus(dispatched);
    state.authorizeCourierAttempt(message.id, claimed.attempt.attemptId, input);
    const recorded = state.recordCourierOutcome(message.id, claimed.attempt.attemptId, status, {
      ...(dispatched?.error ? { error: String(dispatched.error.message || dispatched.error).slice(0, 200) } : {})
    });
    const savedStatus = recorded.outcome?.outcome || status;
    const error = savedStatus === COURIER_OUTCOMES.NOT_SUBMITTED
      ? courierDispatchError(savedStatus)
      : dispatched?.error;
    return { status: savedStatus, cursor: observerCursor, ...(error ? { error } : {}) };
  }

  function processAccepted(message, signal, options) {
    return retryRetiredCourierWork(message, signal, options, startAccepted);
  }

  function startAccepted(message, signal, { continueUntilFinal = true, awaitExisting = true, handoff = false, awaitDispatchOutcome = false } = {}) {
    const existing = existingNativeWork(message, awaitExisting);
    if (existing) return existing;
    const durable = state.getMessage(message?.id) || message;
    const courierAttempt = state.getCourierAttempt?.(durable.id);
    const retiredCourierAttempt = Boolean(courierAttempt &&
      state.hasRetiredCourierAttempt?.(durable.id, courierAttempt.attempt.receiptId));
    const selected = !retiredCourierAttempt && selectedCourierRoute(durable)
      ? { routeId: courierRoute.routeId }
      : null;
    let dispatchOverride = null;
    if (selected) {
      dispatchOverride = (dispatchMessage, parentProvider, dispatchOptions) =>
        dispatchAtCourierBoundary(dispatchMessage, parentProvider, dispatchOptions, selected);
    } else if (isCodexWatcherNotice(durable)) {
      dispatchOverride = async () => ({
        status: COURIER_OUTCOMES.NOT_SUBMITTED,
        error: new Error('Codex watcher notice requires a matching courier route')
      });
    }
    return enqueueOwnerWork(message, signal, (onNativeSettled, ownerEntry) => {
      let settleHandoff;
      let rejectHandoff;
      let settleDispatchOutcome;
      let rejectDispatchOutcome;
      const handoffPromise = handoff ? new Promise((resolve, reject) => {
        settleHandoff = resolve;
        rejectHandoff = reject;
      }) : null;
      const dispatchOutcomePromise = awaitDispatchOutcome ? new Promise((resolve, reject) => {
        settleDispatchOutcome = resolve;
        rejectDispatchOutcome = reject;
      }) : null;
      handoffPromise?.catch(() => {});
      let nativeSettled = false;
      const refreshDispatchBlock = () => {
        refreshCourierCustodyBlock(message.id, ownerEntry);
      };
      const settleNative = () => {
        if (nativeSettled) return;
        nativeSettled = true;
        refreshDispatchBlock();
        onNativeSettled();
      };
      refreshDispatchBlock();
      if (ownerEntry.dispatchBlocked) settleNative();
      const work = ownerEntry.dispatchBlocked
        ? Promise.resolve({ status: COURIER_OUTCOMES.NOT_SUBMITTED, message: state.getMessage(message.id) })
        : startNativeWork(message, signal, async taskSignal => {
        let result;
        const pickupDeadline = selected
          ? createCourierPickupDeadline(state, message.id, taskSignal, observeOptions.timeoutMs)
          : null;
        try {
          if (courierCustodyRequiresOwnerHold(message.id)) {
            ownerEntry.dispatchBlocked = true;
            return { status: COURIER_OUTCOMES.NOT_SUBMITTED, message: state.getMessage(message.id) };
          }
          result = await dispatchAndObserve(state, message.id, providers, {
            ...observeOptions,
            signal: pickupDeadline?.signal || taskSignal,
            continueUntilFinal,
            ...(dispatchOverride ? { dispatch: dispatchOverride } : {}),
            onDispatchOutcome: outcome => {
              if (outcome?.status === 'not_submitted') {
                ownerEntry.dispatchBlocked = !hasCurrentNativeAcknowledgment(state.getMessage(message.id));
              }
              refreshDispatchBlock();
              settleDispatchOutcome?.(outcome);
            },
            onSubmitted: submitted => {
              settleHandoff?.({ status: 'observing', message: submitted });
              pickupDeadline?.arm();
            }
          });
          if (await pickupDeadline?.shouldDispatchParent()) {
            if (isCodexWatcherNotice(message)) {
              result = {
                status: COURIER_OUTCOMES.NOT_SUBMITTED,
                message: state.getMessage(message.id),
                error: new Error('Codex watcher notice requires a matching courier route')
              };
            } else {
              result = await dispatchAndObserve(state, message.id, providers, {
                ...observeOptions,
                signal: taskSignal,
                continueUntilFinal,
                onDispatchOutcome: outcome => {
                  if (outcome?.status === 'not_submitted') {
                    ownerEntry.dispatchBlocked = !hasCurrentNativeAcknowledgment(state.getMessage(message.id));
                  }
                  refreshDispatchBlock();
                }
              });
            }
          }
          const promoted = state.getMessage(message.id);
          if (promoted?.state === MESSAGE_STATES.REPLY_READY && result.message?.state !== MESSAGE_STATES.REPLY_READY) {
            result = { ...result, message: promoted };
          }
          if (['uncertain', 'not_submitted', 'native-already-acknowledged'].includes(result.status) &&
            promoted?.state === MESSAGE_STATES.SUBMITTED) {
            result = await observeSubmitted(state, promoted, providers[promoted.provider], {
              ...observeOptions,
              signal: taskSignal,
              continueUntilFinal
            });
          }
        } finally {
          pickupDeadline?.close();
          settleNative();
        }
        return deliverReply(message, result, taskSignal);
      }, settleNative);
      work.then(
        result => {
          settleHandoff?.(result);
          settleDispatchOutcome?.(result);
        },
        error => {
          rejectHandoff?.(error);
          rejectDispatchOutcome?.(error);
        }
      );
      if (awaitDispatchOutcome) return dispatchOutcomePromise;
      if (!handoff) return work;
      return handoffPromise;
    }, awaitExisting, handoff);
  }

  async function handleMessage(message, signal, expectedBinding = null, onIntake = null, bypassBarrier = false) {
    const childBotRejection = rejectEnrolledChildBot(message, expectedBinding, true);
    if (childBotRejection) {
      if (!childBotRejection.stale) onIntake?.(message, childBotRejection);
      return childBotRejection;
    }
    const intake = await serializeIntake(message, async () => {
      const input = storedAttachmentInput(message) || await normalizeSurfaceMessage(message, {
          fetchImpl: agentAttachmentFetch,
          signal,
          timeoutMs: agentAttachmentTimeoutMs,
          botId: connectedBotId(),
          expectedBinding
        });
      const readyForLive = typeof readyForLiveIntake === 'function' ? readyForLiveIntake(message, expectedBinding) : true;
      const currentBinding = expectedBinding ? state.getBinding(expectedBinding.channelId) : null;
      const ready = readyForLive && (!expectedBinding || (
        currentBinding?.readiness === READINESS.READY && bindingIdentityMatches(expectedBinding, currentBinding)
      ));
      const result = state.acceptDiscordMessage(input, {
        ready,
        expectedBinding,
        agentToken: input.isBot && (input.content?.startsWith(AGENT_PREFIX) || input.content?.startsWith(WATCHER_NOTICE_PREFIX)) ? agentCredential() : null
      });
      if (!result.stale) onIntake?.(message, result);
      return ready ? result : { ...result, held: true };
    }, { signal, bypassBarrier });
    if (!intake.accepted) return intake;
    launchTransportReceipt(message);
    if (intake.held) return intake;
    return processAccepted(message, signal);
  }

  async function intakeMessage(message, ready = false, coverageId = null, expectedBinding = null, emitReceipt = false, signal = null, deadline = null, bypassBarrier = false) {
    const childBotRejection = rejectEnrolledChildBot(message, expectedBinding, ready, coverageId);
    if (childBotRejection) return childBotRejection;
    const intake = await serializeIntake(message, async () => {
      const input = storedAttachmentInput(message) || await normalizeSurfaceMessage(message, {
          fetchImpl: agentAttachmentFetch,
          signal,
          timeoutMs: agentAttachmentTimeoutMs,
          deadline,
          botId: connectedBotId(),
          expectedBinding
        });
      const currentBinding = expectedBinding ? state.getBinding(expectedBinding.channelId) : null;
      const effectiveReady = !bypassBarrier && expectedBinding
        ? currentBinding?.readiness === READINESS.READY
        : ready;
      return state.acceptDiscordMessage(input, {
        ready: effectiveReady,
        coverageId,
        expectedBinding,
          agentToken: input.isBot && (input.content?.startsWith(AGENT_PREFIX) || input.content?.startsWith(WATCHER_NOTICE_PREFIX)) ? agentCredential() : null
      });
    }, { signal, bypassBarrier });
    if (emitReceipt && intake.accepted) launchTransportReceipt(message);
    return intake;
  }

  async function handleStoredMessage(message, signal, { continueUntilFinal = false, handoff = false, awaitDispatchOutcome = false } = {}) {
    if (!state.isInteractionMessage?.(message.id)) launchTransportReceipt(message);
    return processAccepted(message, signal, { continueUntilFinal, awaitExisting: false, handoff, awaitDispatchOutcome });
  }

  function resumeSubmitted(message, signal, { awaitExisting = false, continueUntilFinal = false, deferReply = false } = {}) {
    if (!state.isInteractionMessage?.(message.id)) launchTransportReceipt(message);
    const existing = existingNativeWork(message, awaitExisting);
    if (existing) {
      releaseAcknowledged(message.id);
      return existing;
    }
    const work = enqueueOwnerWork(message, signal, (onNativeSettled, ownerEntry) => {
      let nativeSettled = false;
      const refreshDispatchBlock = () => {
        refreshCourierCustodyBlock(message.id, ownerEntry);
      };
      const settleNative = () => {
        if (nativeSettled) return;
        nativeSettled = true;
        refreshDispatchBlock();
        onNativeSettled();
      };
      const work = startNativeWork(message, signal, async taskSignal => {
        const provider = providers[message.provider];
        const attempt = state.getCourierAttempt?.(message.id);
        const pickupDeadline = attempt && !state.hasRetiredCourierAttempt?.(message.id, attempt.attempt.receiptId)
          ? createCourierPickupDeadline(state, message.id, taskSignal, observeOptions.timeoutMs)
          : null;
        let result;
        try {
          pickupDeadline?.arm();
          result = await observeSubmitted(state, message, provider, {
            ...observeOptions,
            signal: pickupDeadline?.signal || taskSignal,
            continueUntilFinal
          });
          if (await pickupDeadline?.shouldDispatchParent()) {
            if (isCodexWatcherNotice(message)) {
              result = {
                status: COURIER_OUTCOMES.NOT_SUBMITTED,
                message: state.getMessage(message.id),
                error: new Error('Codex watcher notice requires a matching courier route')
              };
            } else {
              result = await dispatchAndObserve(state, message.id, providers, {
                ...observeOptions,
                signal: taskSignal,
                continueUntilFinal
              });
            }
          }
        } finally {
          pickupDeadline?.close();
          settleNative();
        }
        const holdReply = typeof deferReply === 'function' ? deferReply() : deferReply;
        return holdReply ? result : deliverReply(message, result, taskSignal);
      }, settleNative);
      if (continueUntilFinal) return Promise.resolve({ status: 'observing', message: state.getMessage(message.id) });
      return work;
    }, awaitExisting, continueUntilFinal);
    releaseAcknowledged(message.id);
    return work;
  }

  return { abortNativeWork, deliverReply, handleMessage, handleStoredMessage, intakeMessage, issueTransportReceipt, processAccepted,
    refreshNativeWorkChannel, releaseAcknowledged, releaseHandledWithoutPost, releaseIntake, resumeSubmitted, waitForNativeWork, waitForReceipts };
}

module.exports = { createSurfaceConsumer };
