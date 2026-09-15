import {
  DECISION_NATIVE_OUTCOMES,
  DECISION_RECEIPT_KINDS,
  DECISION_REASONS,
  DECISION_STATES,
  DECISION_TRANSPORT_OUTCOMES,
  DECISION_WINNER_SOURCES,
  DecisionError,
  type DecisionBinding,
  type DecisionCanonicalResult,
  type DecisionCanonicalRoute,
  type DecisionClickAdmission,
  type DecisionClickInput,
  type DecisionHandlers,
  type DecisionPresentationInput,
  type DecisionPresentationLookupInput,
  type DecisionState,
  type DecisionStateStore,
  type DecisionTransitionResult,
  type MutableClick,
  type MutablePresentation
} from './types';
import {
  PENDING_STATES,
  append,
  bindingMatches,
  clickFor,
  currentBinding,
  findPresentation,
  mutableClickOutput,
  mutablePresentationOutput,
  nativeOutcome,
  normalizeBinding,
  normalizePresentationPayload,
  normalizeKeys,
  optionalText,
  outcome,
  presentationFor,
  questionGeneration,
  sameMaterializedAnswer,
  sameOccurrence,
  sameCanonical,
  sameCanonicalRoute,
  sameClickInput,
  snapshot,
  text,
  winnerSource
} from './reducer';

function requirePresentationInput(input: DecisionPresentationInput): {
  namespace?: string;
  presentationId: string;
  requestId: string;
  qid: string;
  questionGeneration: string;
  target: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  binding: DecisionBinding;
  keys: string[];
  canonicalRoute?: DecisionCanonicalRoute;
  content?: string;
} {
  const presentationId = text(input?.presentationId, 'presentationId', 256);
  const requestId = text(input?.requestId, 'requestId', 256);
  const qid = text(input?.qid, 'qid', 256);
  if (requestId === qid) throw new DecisionError('owner qid must remain distinct from requestId');
  const payload = normalizePresentationPayload(input?.canonicalRoute, input?.content);
  const namespace = input?.namespace == null ? undefined : text(input.namespace, 'namespace', 256);
  return {
    ...(namespace !== undefined ? { namespace } : {}),
    presentationId,
    requestId,
    qid,
    questionGeneration: questionGeneration(input?.questionGeneration),
    target: text(input?.target, 'target', 256),
    guildId: text(input?.guildId, 'guildId', 128),
    channelId: text(input?.channelId, 'channelId', 128),
    messageId: optionalText(input?.messageId, 'messageId', 256),
    binding: normalizeBinding(input?.binding),
    keys: normalizeKeys(input?.keys),
    ...payload
  };
}

type NormalizedClickInput = Omit<DecisionClickInput, 'binding'> & { binding: DecisionBinding };

function requireClickInput(input: DecisionClickInput): NormalizedClickInput {
  return {
    interactionId: text(input?.interactionId, 'interactionId', 256),
    presentationId: text(input?.presentationId, 'presentationId', 256),
    selectedKey: text(input?.selectedKey, 'selectedKey', 128),
    actorId: text(input?.actorId, 'actorId', 256),
    guildId: text(input?.guildId, 'guildId', 128),
    channelId: text(input?.channelId, 'channelId', 128),
    messageId: text(input?.messageId, 'messageId', 256),
    binding: normalizeBinding(input?.binding)
  };
}

function admitClickInTransaction(
  state: DecisionStateStore,
  input: NormalizedClickInput,
  beginCallback: boolean
): DecisionClickAdmission {
  const existing = clickFor(state, input.interactionId);
  if (existing) {
    if (!sameClickInput(existing, input, input.binding)) {
      return { accepted: false, duplicate: true, reason: DECISION_REASONS.DUPLICATE_INTERACTION_CONFLICT, click: mutableClickOutput(existing) };
    }
    return {
      accepted: false,
      duplicate: true,
      continuing: PENDING_STATES.has(existing.state),
      click: mutableClickOutput(existing)
    };
  }
  const presentation = presentationFor(state, input.presentationId);
  if (!presentation) return { accepted: false, reason: DECISION_REASONS.UNKNOWN_PRESENTATION, click: null };
  const config = state.requireConfig();
  if (presentation.state === DECISION_STATES.STALE || presentation.state === DECISION_STATES.REFUSED ||
    presentation.presentationOutcome !== DECISION_TRANSPORT_OUTCOMES.SENT) {
    return { accepted: false, stale: presentation.state === DECISION_STATES.STALE, reason: DECISION_REASONS.PRESENTATION_NOT_ADMISSIBLE, click: null };
  }
  if (input.guildId !== config.guildId || input.actorId !== config.operatorId || input.actorId !== presentation.operatorId) {
    return { accepted: false, reason: DECISION_REASONS.UNAUTHORIZED_INTERACTION, click: null };
  }
  if (input.guildId !== presentation.guildId || input.channelId !== presentation.channelId ||
    input.messageId !== presentation.messageId || !presentation.messageId) {
    return { accepted: false, stale: true, reason: DECISION_REASONS.PRESENTATION_IDENTITY_MISMATCH, click: null };
  }
  if (!presentation.keys.includes(input.selectedKey)) {
    return { accepted: false, reason: DECISION_REASONS.UNKNOWN_SELECTION, click: null };
  }
  if (!bindingMatches(input.binding, presentation.binding) || !currentBinding(state, presentation.binding)) {
    return { accepted: false, stale: true, reason: DECISION_REASONS.STALE_BINDING, click: null };
  }
  append(state, DECISION_RECEIPT_KINDS.CLICK, {
    interactionId: input.interactionId,
    presentationId: input.presentationId,
    selectedKey: input.selectedKey,
    actorId: input.actorId,
    guildId: input.guildId,
    channelId: input.channelId,
    messageId: input.messageId,
    binding: presentation.binding
  });
  if (beginCallback) append(state, DECISION_RECEIPT_KINDS.CALLBACK_ATTEMPT, { interactionId: input.interactionId });
  return { accepted: true, click: mutableClickOutput(clickFor(state, input.interactionId) as MutableClick) };
}

function queueNativeReturnInTransaction(state: DecisionStateStore, interactionId: string): DecisionTransitionResult {
  const click = clickFor(state, interactionId);
  if (!click) return { accepted: false, reason: DECISION_REASONS.UNKNOWN_INTERACTION, click: null };
  const canonical = click.canonical;
  if (!canonical?.materialized || canonical.source === DECISION_WINNER_SOURCES.CLAIM || !canonical.answer) {
    return { accepted: false, reason: DECISION_REASONS.NATIVE_RETURN_REQUIRES_MATERIALIZED_WINNER, click: mutableClickOutput(click) };
  }
  if (click.nativeReturn) return { accepted: false, duplicate: true, reason: DECISION_REASONS.NATIVE_RETURN_ALREADY_QUEUED, click: mutableClickOutput(click) };
  const existing = [...snapshot(state).clicks.values()].find(candidate => {
    const nativeReturn = candidate.nativeReturn;
    if (!nativeReturn) return false;
    return sameOccurrence(nativeReturn, canonical) &&
      nativeReturn.provider === click.binding.provider &&
      nativeReturn.nativeId === click.binding.nativeId &&
      nativeReturn.generation === click.binding.generation;
  });
  if (existing) {
    return {
      accepted: false,
      duplicate: true,
      reason: DECISION_REASONS.NATIVE_RETURN_ALREADY_QUEUED,
      existingInteractionId: existing.interactionId,
      click: mutableClickOutput(click)
    };
  }
  const interaction = state.acceptDecisionInteraction({
    interactionId: click.interactionId,
    presentationId: click.presentationId,
    selectedKey: click.selectedKey,
    actorId: click.actorId,
    guildId: click.guildId,
    channelId: click.channelId,
    questionMessageId: click.messageId,
    binding: click.binding,
    qid: canonical.qid,
    questionGeneration: canonical.questionGeneration,
    target: canonical.target,
    canonicalSource: canonical.source,
    canonicalReference: canonical.reference,
    answer: canonical.answer
  }, { inTransaction: true });
  if (!interaction.accepted && !interaction.duplicate) {
    throw new DecisionError(`materialized winner native interaction admission failed: ${interaction.reason || 'unknown'}`);
  }
  append(state, DECISION_RECEIPT_KINDS.NATIVE_RETURN, {
    interactionId,
    presentationId: click.presentationId,
    selectedKey: click.selectedKey,
    questionMessageId: click.messageId,
    qid: canonical.qid,
    questionGeneration: canonical.questionGeneration,
    target: canonical.target,
    canonicalSource: canonical.source,
    answer: canonical.answer,
    provider: click.binding.provider,
    nativeId: click.binding.nativeId,
    generation: click.binding.generation,
    channelId: click.binding.channelId,
    guildId: click.binding.guildId,
    workspace: click.binding.workspace,
    conductorId: click.binding.conductorId,
    repoKey: click.binding.repoKey,
    canonicalReference: canonical.reference
  });
  return { accepted: true, click: mutableClickOutput(clickFor(state, interactionId) as MutableClick) };
}

export function createDecisionHandlers(): DecisionHandlers {
  return {
    findPresentation(state, rawInput: DecisionPresentationLookupInput) {
      return findPresentation(state, rawInput);
    },

    registerPresentation(state, rawInput) {
      const input = requirePresentationInput(rawInput);
      const config = state.requireConfig();
      if (input.guildId !== config.guildId || input.binding.guildId !== config.guildId) {
        return { created: false, duplicate: false, reason: DECISION_REASONS.UNAUTHORIZED_PRESENTATION, presentation: null };
      }
      if (!currentBinding(state, input.binding)) {
        return { created: false, duplicate: false, reason: DECISION_REASONS.STALE_BINDING, presentation: null };
      }
      return state.transaction(() => {
        if (!currentBinding(state, input.binding)) {
          return { created: false, duplicate: false, reason: DECISION_REASONS.STALE_BINDING, presentation: null };
        }
        const existing = presentationFor(state, input.presentationId);
        if (existing) {
          const same = existing.namespace === input.namespace && existing.requestId === input.requestId && existing.qid === input.qid && existing.questionGeneration === input.questionGeneration &&
            existing.target === input.target && existing.guildId === input.guildId && existing.channelId === input.channelId &&
            (existing.messageId === input.messageId ||
              (input.messageId === null && existing.presentationOutcome === DECISION_TRANSPORT_OUTCOMES.SENT && existing.messageId !== null)) &&
            existing.operatorId === config.operatorId &&
            bindingMatches(existing.binding, input.binding) && existing.keys.length === input.keys.length &&
            existing.keys.every((key, index) => key === input.keys[index]) &&
            sameCanonicalRoute(existing.canonicalRoute, input.canonicalRoute) && existing.content === input.content;
          if (!same) throw new DecisionError('presentation identity conflicts with existing custody');
          return { created: false, duplicate: true, presentation: mutablePresentationOutput(existing) };
        }
        append(state, DECISION_RECEIPT_KINDS.PRESENTATION, {
          ...(input.namespace !== undefined ? { namespace: input.namespace } : {}),
          presentationId: input.presentationId,
          requestId: input.requestId,
          qid: input.qid,
          questionGeneration: input.questionGeneration,
          target: input.target,
          guildId: input.guildId,
          channelId: input.channelId,
          messageId: input.messageId,
          operatorId: config.operatorId,
          binding: input.binding,
          keys: input.keys,
          ...(input.canonicalRoute ? { canonicalRoute: { ...input.canonicalRoute } } : {}),
          ...(input.content !== undefined ? { content: input.content } : {})
        });
        return { created: true, duplicate: false, presentation: mutablePresentationOutput(presentationFor(state, input.presentationId) as MutablePresentation) };
      });
    },

    recordPresentationOutcome(state, presentationId, rawOutcome, rawMessageId = null) {
      const id = text(presentationId, 'presentationId', 256);
      const nextOutcome = outcome(rawOutcome);
      const messageId = rawMessageId == null ? null : text(rawMessageId, 'messageId', 256);
      return state.transaction(() => {
        const presentation = presentationFor(state, id);
        if (!presentation) throw new DecisionError('presentation is unknown');
        const existing = presentation.presentationOutcome;
        if (existing) {
          if (existing !== nextOutcome || (messageId !== null && presentation.messageId !== messageId)) {
            throw new DecisionError('presentation outcome conflicts with existing custody');
          }
          return mutablePresentationOutput(presentation);
        }
        if (nextOutcome === DECISION_TRANSPORT_OUTCOMES.SENT && !messageId) throw new DecisionError('sent presentation requires a messageId');
        if (nextOutcome !== DECISION_TRANSPORT_OUTCOMES.SENT && messageId) throw new DecisionError('failed presentation cannot carry a messageId');
        append(state, DECISION_RECEIPT_KINDS.PRESENTATION_OUTCOME, {
          presentationId: id,
          outcome: nextOutcome,
          ...(messageId ? { messageId } : {})
        });
        return mutablePresentationOutput(presentationFor(state, id) as MutablePresentation);
      });
    },

    markPresentationStale(state, presentationId, reason) {
      const id = text(presentationId, 'presentationId', 256);
      const staleReason = text(reason, 'reason', 512);
      return state.transaction(() => {
        const presentation = presentationFor(state, id);
        if (!presentation) throw new DecisionError('presentation is unknown');
        if (presentation.state === DECISION_STATES.STALE && presentation.staleReason === staleReason) return mutablePresentationOutput(presentation);
        append(state, DECISION_RECEIPT_KINDS.PRESENTATION_STALE, { presentationId: id, reason: staleReason });
        return mutablePresentationOutput(presentationFor(state, id) as MutablePresentation);
      });
    },

    getPresentation(state, presentationId) {
      const presentation = presentationFor(state, presentationId);
      return presentation ? mutablePresentationOutput(presentation) : null;
    },

    admitClick(state, rawInput) {
      const input = requireClickInput(rawInput);
      return state.transaction(() => admitClickInTransaction(state, input, false));
    },

    admitClickAndBeginCallback(state, rawInput) {
      const input = requireClickInput(rawInput);
      return state.transaction(() => admitClickInTransaction(state, input, true));
    },

    getClick(state, interactionId) {
      const click = clickFor(state, interactionId);
      return click ? mutableClickOutput(click) : null;
    },

    beginCallback(state, interactionId) {
      const id = text(interactionId, 'interactionId', 256);
      return state.transaction(() => {
        const click = clickFor(state, id);
        if (!click) return { accepted: false, reason: DECISION_REASONS.UNKNOWN_INTERACTION, click: null };
        if (click.callbackAttempted) return { accepted: false, duplicate: true, reason: DECISION_REASONS.CALLBACK_ALREADY_ATTEMPTED, click: mutableClickOutput(click) };
        if (([DECISION_STATES.TERMINAL, DECISION_STATES.REFUSED, DECISION_STATES.STALE] as readonly DecisionState[]).includes(click.state)) {
          return { accepted: false, reason: DECISION_REASONS.INTERACTION_NOT_CALLBACK_PENDING, click: mutableClickOutput(click) };
        }
        append(state, DECISION_RECEIPT_KINDS.CALLBACK_ATTEMPT, { interactionId: id });
        return { accepted: true, click: mutableClickOutput(clickFor(state, id) as MutableClick) };
      });
    },

    recordCallbackOutcome(state, interactionId, rawOutcome) {
      const id = text(interactionId, 'interactionId', 256);
      const nextOutcome = outcome(rawOutcome);
      return state.transaction(() => {
        const click = clickFor(state, id);
        if (!click) return { accepted: false, reason: DECISION_REASONS.UNKNOWN_INTERACTION, click: null };
        if (!click.callbackAttempted) return { accepted: false, reason: DECISION_REASONS.CALLBACK_ATTEMPT_MISSING, click: mutableClickOutput(click) };
        if (click.callbackOutcome) {
          if (click.callbackOutcome === nextOutcome) return { accepted: false, duplicate: true, reason: DECISION_REASONS.CALLBACK_OUTCOME_RECORDED, click: mutableClickOutput(click) };
          return { accepted: false, reason: DECISION_REASONS.CALLBACK_OUTCOME_CONFLICT, click: mutableClickOutput(click) };
        }
        append(state, DECISION_RECEIPT_KINDS.CALLBACK_OUTCOME, { interactionId: id, outcome: nextOutcome });
        return { accepted: true, click: mutableClickOutput(clickFor(state, id) as MutableClick) };
      });
    },

    importWinner(state, interactionId, rawResult) {
      const id = text(interactionId, 'interactionId', 256);
      const result: DecisionCanonicalResult = {
        qid: text(rawResult?.qid, 'qid', 256),
        questionGeneration: questionGeneration(rawResult?.questionGeneration),
        target: text(rawResult?.target, 'target', 256),
        source: winnerSource(rawResult?.source),
        materialized: rawResult?.materialized === true,
        reference: text(rawResult?.reference, 'reference', 512),
        ...(rawResult?.answer === undefined ? {} : { answer: text(rawResult.answer, 'answer', 10000) })
      };
      if (result.source === DECISION_WINNER_SOURCES.CLAIM && result.materialized) {
        return { accepted: false, reason: DECISION_REASONS.CLAIM_CANNOT_BE_MATERIALIZED, click: null };
      }
      if (result.source !== DECISION_WINNER_SOURCES.CLAIM && !result.materialized) {
        return { accepted: false, reason: DECISION_REASONS.MATERIALIZED_WINNER_REQUIRED, click: null };
      }
      if (result.materialized && !result.answer) return { accepted: false, reason: DECISION_REASONS.MATERIALIZED_WINNER_ANSWER_MISSING, click: null };
      return state.transaction(() => {
        const click = clickFor(state, id);
        if (!click) return { accepted: false, reason: DECISION_REASONS.UNKNOWN_INTERACTION, click: null };
        const presentation = presentationFor(state, click.presentationId);
        if (!presentation) return { accepted: false, reason: DECISION_REASONS.UNKNOWN_PRESENTATION, click: mutableClickOutput(click) };
        if (result.qid !== presentation.qid || result.questionGeneration !== presentation.questionGeneration || result.target !== presentation.target) {
          return { accepted: false, reason: DECISION_REASONS.CANONICAL_IDENTITY_MISMATCH, click: mutableClickOutput(click) };
        }
        const conflictingOccurrence = [...snapshot(state).clicks.values()].find(candidate => candidate.canonical?.materialized &&
          sameOccurrence(candidate.canonical, result) && !sameMaterializedAnswer(candidate.canonical, result));
        if (result.materialized && conflictingOccurrence) {
          return { accepted: false, reason: DECISION_REASONS.CANONICAL_RESULT_CONFLICT, click: mutableClickOutput(click) };
        }
        if (click.canonical) {
          if (sameCanonical(click.canonical, result)) {
            return { accepted: false, duplicate: true, reason: DECISION_REASONS.CANONICAL_RESULT_RECORDED, click: mutableClickOutput(click) };
          }
          const claimOnly = click.canonical.source === DECISION_WINNER_SOURCES.CLAIM && !click.canonical.materialized;
          const materializedWinner = result.source !== DECISION_WINNER_SOURCES.CLAIM && result.materialized;
          if (!claimOnly || !materializedWinner) {
            return { accepted: false, reason: DECISION_REASONS.CANONICAL_RESULT_CONFLICT, click: mutableClickOutput(click) };
          }
        }
        append(state, DECISION_RECEIPT_KINDS.CANONICAL_IMPORT, {
          interactionId: id,
          qid: result.qid,
          questionGeneration: result.questionGeneration,
          target: result.target,
          source: result.source,
          materialized: result.materialized,
          reference: result.reference,
          ...(result.materialized ? { answer: result.answer } : {})
        });
        if (result.materialized) {
          const native = queueNativeReturnInTransaction(state, id);
          if (!native.accepted && !native.duplicate) throw new DecisionError('materialized winner native return admission failed');
        }
        return { accepted: true, click: mutableClickOutput(clickFor(state, id) as MutableClick) };
      });
    },

    recordProjectionOutcome(state, interactionId, rawOutcome) {
      const id = text(interactionId, 'interactionId', 256);
      const nextOutcome = outcome(rawOutcome);
      return state.transaction(() => {
        const click = clickFor(state, id);
        if (!click) return { accepted: false, reason: DECISION_REASONS.UNKNOWN_INTERACTION, click: null };
        if (!click.canonical?.materialized) return { accepted: false, reason: DECISION_REASONS.PROJECTION_REQUIRES_MATERIALIZED_WINNER, click: mutableClickOutput(click) };
        if (click.projectionOutcome) {
          if (click.projectionOutcome === nextOutcome) return { accepted: false, duplicate: true, reason: DECISION_REASONS.PROJECTION_OUTCOME_RECORDED, click: mutableClickOutput(click) };
          return { accepted: false, reason: DECISION_REASONS.PROJECTION_OUTCOME_CONFLICT, click: mutableClickOutput(click) };
        }
        append(state, DECISION_RECEIPT_KINDS.PROJECTION_OUTCOME, { interactionId: id, outcome: nextOutcome });
        return { accepted: true, click: mutableClickOutput(clickFor(state, id) as MutableClick) };
      });
    },

    queueNativeReturn(state, interactionId) {
      const id = text(interactionId, 'interactionId', 256);
      return state.transaction(() => queueNativeReturnInTransaction(state, id));
    },

    recordNativeReturnOutcome(state, interactionId, rawOutcome) {
      const id = text(interactionId, 'interactionId', 256);
      const nextOutcome = nativeOutcome(rawOutcome);
      return state.transaction(() => {
        const click = clickFor(state, id);
        if (!click) return { accepted: false, reason: DECISION_REASONS.UNKNOWN_INTERACTION, click: null };
        if (!click.nativeReturn) return { accepted: false, reason: DECISION_REASONS.NATIVE_RETURN_NOT_QUEUED, click: mutableClickOutput(click) };
        if (click.nativeReturn.outcome) {
          if (click.nativeReturn.outcome === nextOutcome) return { accepted: false, duplicate: true, reason: DECISION_REASONS.NATIVE_OUTCOME_RECORDED, click: mutableClickOutput(click) };
          const completesInFlight = click.nativeReturn.outcome === DECISION_NATIVE_OUTCOMES.IN_FLIGHT &&
            nextOutcome === DECISION_NATIVE_OUTCOMES.SUBMITTED;
          if (!completesInFlight) return { accepted: false, reason: DECISION_REASONS.NATIVE_OUTCOME_CONFLICT, click: mutableClickOutput(click) };
        }
        append(state, DECISION_RECEIPT_KINDS.NATIVE_OUTCOME, { interactionId: id, outcome: nextOutcome });
        return { accepted: true, click: mutableClickOutput(clickFor(state, id) as MutableClick) };
      });
    },

    pendingWork(state) {
      const current = snapshot(state);
      return [...current.clicks.values()].filter(click => PENDING_STATES.has(click.state)).map(mutableClickOutput);
    }
  };
}
