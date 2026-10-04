'use strict';

function createPendingReconciliationHandlers({ heldParentRequestIds, MESSAGE_STATES, CODEX_VALIDATION_KINDS, recoveryKind, waitForRecoveryOperation, startReconciliationLookup, recoveryFetch, attachReconciliationWaiter, storeReconciliationSnapshot, hasReconciliationLookup, assertPublicThread, storedChannelMatches, conductorMarkerMatchesTopic, DISPATCH_OUTCOMES, DECISION_TRANSPORT_OUTCOMES }) {
  return {
    async reconcilePending(before, signal, readyOnly = false, channelIds = null, messageIds = null) {
      const deadline = Date.now() + this.recoveryTimeoutMs;
      const passLifecycle = this.lifecycleEpoch;
      const passConnectionEpoch = this.connectionEpoch;
      const reconciliationConnection = { gateway: this, epoch: passConnectionEpoch };
      const selectedChannels = channelIds ? new Set(channelIds) : null;
      const selectedMessages = messageIds ? new Set(messageIds) : null;
      if (selectedChannels && selectedMessages) {
        for (const channelId of [...selectedChannels]) {
          const enrollment = this.state.getThreadEnrollment(channelId);
          if (!enrollment?.active || !enrollment.parentChannelId) continue;
          const heldParentIds = heldParentRequestIds(this.state, [enrollment.parentChannelId], [channelId]);
          if (heldParentIds.some(messageId => selectedMessages.has(messageId))) {
            selectedChannels.add(enrollment.parentChannelId);
          }
        }
      }
      this.consumer?.releaseHandledWithoutPost?.();
      const isHeldDurable = message => message.state === 'submitted' || message.state === 'reply_ready';
      const allowed = message => (!selectedMessages || selectedMessages.has(message.id)) &&
        (!selectedChannels || selectedChannels.has(message.channelId) || selectedChannels.has(message.deliveryChannelId)) &&
        (!readyOnly || this.state.getMessageRoute(message.deliveryChannelId || message.channelId)?.ready ||
          isHeldDurable(message));
      const decisionProjectionPending = message => {
        const click = this.state.listDecisionPendingWork?.().find(candidate => candidate.interactionId === message.id);
        const retryable = click?.projectionOutcome == null || [
          DECISION_TRANSPORT_OUTCOMES.NOT_SENT,
          DECISION_TRANSPORT_OUTCOMES.RATE_LIMITED,
          DECISION_TRANSPORT_OUTCOMES.UNKNOWN
        ].includes(click.projectionOutcome);
        return Boolean(click?.canonical?.materialized && retryable);
      };
      this.startDecisionRecovery(signal, selectedChannels);
      const candidates = this.state.recoveryCandidates(before).filter(allowed);
      const retryOrder = messageIds ? new Map(messageIds.map((messageId, index) => [messageId, index])) : null;
      const ordered = candidates.sort((a, b) => {
        if (retryOrder) return retryOrder.get(a.id) - retryOrder.get(b.id);
        return a.createdAt.localeCompare(b.createdAt);
      });
      const blockedOwners = new Set();
      let reconciliationRetryQueued = false;
      const reconciliationRetryMessageIds = [];
      const queueReconciliationRetry = messageIdsToRetry => {
        if (this.stopping || signal?.aborted) return;
        for (const messageId of messageIdsToRetry || []) {
          if (!reconciliationRetryMessageIds.includes(messageId)) reconciliationRetryMessageIds.push(messageId);
        }
        if (reconciliationRetryQueued || !reconciliationRetryMessageIds.length) return;
        reconciliationRetryQueued = true;
        queueMicrotask(() => {
          // Drain this batch before the awaited pass so later settlements can queue a new one.
          reconciliationRetryQueued = false;
          const retryMessageIds = reconciliationRetryMessageIds.splice(0);
          if (this.stopping || signal?.aborted || !retryMessageIds.length) return;
          const retryThreadIds = new Set();
          const blockedOwnerKeys = new Set();
          for (const messageId of retryMessageIds) {
            const message = this.state.getMessage(messageId);
            if (message?.state !== 'accepted' || !message.deliveryChannelId ||
                message.deliveryChannelId === message.channelId) continue;
            if (!this.state.getMessageRoute(message.deliveryChannelId)?.ready) {
              retryThreadIds.add(message.deliveryChannelId);
              blockedOwnerKeys.add(`${message.provider}:${message.nativeId}`);
            }
          }
          const retry = messageIds => {
            if (!messageIds.length) return Promise.resolve();
            return this.reconcilePending(before, {
              allowPaused: true,
              readyOnly: true,
              channelIds,
              messageIds
            }).catch(error => this.logger(`Discord reply reconciliation retry failed: ${error.message}`));
          };
          if (!retryThreadIds.size) {
            retry(retryMessageIds);
            return;
          }
          const blockedRetryMessageIds = retryMessageIds.filter(messageId => {
            const message = this.state.getMessage(messageId);
            return message && blockedOwnerKeys.has(`${message.provider}:${message.nativeId}`);
          });
          const blockedRetryMessageIdSet = new Set(blockedRetryMessageIds);
          const immediateRetryMessageIds = retryMessageIds.filter(messageId =>
            !blockedRetryMessageIdSet.has(messageId)
          );
          const recoverBlocked = () => this.recoverTransport('accepted custody recovery retry', passLifecycle, [...retryThreadIds])
            .then(recovery => {
              const routesReady = [...retryThreadIds].every(threadId =>
                this.state.getMessageRoute(threadId)?.ready
              );
              if (recovery?.ready !== true && !routesReady) {
                this.logger(`Discord accepted custody recovery retry held: ${recovery?.state || 'unavailable'}`);
                return;
              }
              retry(blockedRetryMessageIds);
            })
            .catch(error => this.logger(`Discord accepted custody recovery retry failed: ${error.message}`));
          if (!immediateRetryMessageIds.length) {
            recoverBlocked();
            return;
          }
          retry(immediateRetryMessageIds).then(recoverBlocked).catch(() => {});
        });
      };
      const storedMessages = new Map();
      const storedMessageFor = message => {
        let storedMessage = storedMessages.get(message.id);
        if (!storedMessage) {
          storedMessage = {
            ...message,
            id: message.id,
            guildId: message.guildId,
            channelId: message.deliveryChannelId || message.channelId,
            content: message.content,
            author: { id: message.authorId, bot: false }
          };
          storedMessages.set(message.id, storedMessage);
        }
        return storedMessage;
      };
      const canDeliverSettledReply = (message, storedMessage) => {
        if (!storedMessage.channel) return false;
        const route = this.state.getMessageRoute(message.deliveryChannelId || message.channelId);
        if (!route?.ready) return false;
        const permission = this.historyPermission(storedMessage.channel, { requireSend: true });
        return permission.known && permission.allowed;
      };
      // F14 phase 1: admit every eligible submitted native observation up front through
      // the existing per-owner queue ordering/deduplication/cancellation, WITHOUT
      // spending the network deadline and WITHOUT waiting for native completion.
      // Admission never dispatches or replies; a later native completion still needs
      // its own reconciliation pass to reach reply.
      for (const message of ordered) {
        if (signal?.aborted) break;
        if (message.state !== 'submitted') continue;
        const storedMessage = storedMessageFor(message);
        try {
          const admitted = this.consumer.resumeSubmitted(storedMessage, signal, {
            continueUntilFinal: true,
            deferReply: () => {
              const deferred = !canDeliverSettledReply(message, storedMessage);
              if (deferred && !storedMessage.channel &&
                this.state.getMessage(message.id)?.state === MESSAGE_STATES.REPLY_READY) queueReconciliationRetry([message.id]);
              return deferred;
            }
          });
          // Admission observes existing submitted work; its settlement is handled by the
          // owning observer/queue, so a rejected admission must not become an unhandled
          // rejection in the recovery pass.
          if (admitted && typeof admitted.catch === 'function') admitted.catch(() => {});
        } catch (error) {
          if (recoveryKind(error) === CODEX_VALIDATION_KINDS.STOPPED) break;
          this.state.markObservationUnavailable(message.id, error);
        }
      }
      // F14 phase 2: the existing bounded channel fetch / reply reconciliation.
      for (let candidateIndex = 0; candidateIndex < ordered.length; candidateIndex += 1) {
        const message = ordered[candidateIndex];
        if (signal?.aborted) return this.state.recoveryCandidates(before).filter(allowed);
        const key = `${message.provider}:${message.nativeId}`;
        if (blockedOwners.has(key)) continue;
        const storedMessage = storedMessageFor(message);
        let result;
        let channel;
        let channelFetchStarted = false;
        // Tracks whether THIS pass actually registered its settlement waiter on an
        // owned in-flight lookup. Distinct from channelFetchStarted, which records
        // only whether this pass initiated the SDK fetch: an adopting reconnect
        // attaches to an already-pending promise without starting a fetch.
        let waiterAttached = false;
        let lookupAbandoned = false;
        let deferredRetryMessageIds = [];
        let releaseLookupWaiter = null;
        const lookupDestinationId = message.deliveryChannelId || message.channelId;
        try {
          channel = await waitForRecoveryOperation(
            () => {
              const lookupPromise = startReconciliationLookup(
                this.client,
                lookupDestinationId,
                message.id,
                () => recoveryFetch(() => {
                  channelFetchStarted = true;
                  return this.client.channels.fetch(lookupDestinationId);
                }),
                reconciliationConnection
              );
              releaseLookupWaiter = attachReconciliationWaiter(this.client, lookupDestinationId, {
                isCurrent: () => !this.stopping && this.isCurrentLifecycle(passLifecycle) &&
                  passConnectionEpoch === this.connectionEpoch,
                settled: settledChannel => {
                  // A caller whose bounded wait ended must not lose the lookup. Save
                  // the one-use snapshot for this exact continuation and wake it via
                  // the existing retry producer only when this pass gave up waiting.
                  // Same-owner successors stay here until the predecessor is queued.
                  if (!lookupAbandoned) return;
                  storeReconciliationSnapshot(this.client, lookupDestinationId, message.id, settledChannel, reconciliationConnection);
                  if (this.stopping || signal?.aborted || !this.isCurrentLifecycle(passLifecycle) ||
                      passConnectionEpoch !== this.connectionEpoch) return;
                  queueReconciliationRetry([message.id, ...deferredRetryMessageIds]);
                },
                failed: () => {
                  if (!lookupAbandoned || this.stopping || signal?.aborted ||
                      !this.isCurrentLifecycle(passLifecycle) ||
                      passConnectionEpoch !== this.connectionEpoch) return;
                  queueReconciliationRetry([message.id, ...deferredRetryMessageIds]);
                }
              });
              // Only an actually owned in-flight lookup gives this pass late
              // settlement interest. A consumed one-use snapshot resolves without
              // registering an entry, so it must leave this false.
              waiterAttached = hasReconciliationLookup(this.client, lookupDestinationId);
              return lookupPromise;
            },
            signal,
            deadline
          );
          releaseLookupWaiter?.();
        } catch (error) {
          if (recoveryKind(error) === CODEX_VALIDATION_KINDS.STOPPED) {
            releaseLookupWaiter?.();
            return this.state.recoveryCandidates(before).filter(allowed);
          }
          if (recoveryKind(error) === CODEX_VALIDATION_KINDS.DEADLINE && waiterAttached) {
            lookupAbandoned = true;
            // Rotate unrelated candidates ahead of the retry, but keep undispatched
            // custody for this native owner in its original order. A destination
            // whose single-flight lookup is still owned is NOT requeued here: its
            // attached waiter wakes it on genuine settlement, and requeuing it every
            // deadline would be the endless replacement chain the ruling forbids.
            const lookupInFlight = hasReconciliationLookup(this.client, lookupDestinationId);
            const laterCandidates = ordered.slice(candidateIndex + 1);
            const laterOwnerIds = [];
            const otherOwnerIds = [];
            for (const candidate of laterCandidates) {
              const candidateKey = `${candidate.provider}:${candidate.nativeId}`;
              if (candidateKey === key) laterOwnerIds.push(candidate.id);
              else otherOwnerIds.push(candidate.id);
            }
            if (lookupInFlight) deferredRetryMessageIds = laterOwnerIds;
            const retryMessageIds = lookupInFlight
              ? otherOwnerIds
              : [...otherOwnerIds, message.id, ...laterOwnerIds];
            queueReconciliationRetry(retryMessageIds);
          }
          blockedOwners.add(key);
          if (!channelFetchStarted) {
            if (!waiterAttached) continue;
            queueReconciliationRetry([message.id, ...deferredRetryMessageIds]);
          }
          this.markThreadDeliveryUnavailable(message, error);
          this.state.markObservationUnavailable(message.id, error);
          continue;
        }
        if (!channel) {
          blockedOwners.add(key);
          const error = new Error('Discord channel is unavailable during recovery');
          this.markThreadDeliveryUnavailable(message, error);
          this.state.markObservationUnavailable(message.id, error);
          continue;
        }
        if (message.deliveryChannelId && message.deliveryChannelId !== message.channelId) {
          try { assertPublicThread(channel, this.state.getBinding(message.channelId), message.deliveryChannelId, this.client.user); }
          catch (error) {
            this.markThreadDeliveryUnavailable(message, error);
            blockedOwners.add(key);
            continue;
          }
        } else {
          const binding = this.state.getBinding(message.channelId);
          if (!binding?.active || !storedChannelMatches(channel, message)) {
            blockedOwners.add(key);
            continue;
          }
          if (isHeldDurable(message)) {
            const ordinary = this.state.isOrdinaryBinding?.(binding) === true;
            if ((ordinary && channel.guildId && channel.guildId !== binding.guildId) ||
                (!ordinary && !conductorMarkerMatchesTopic(channel.topic, binding))) {
              blockedOwners.add(key);
              continue;
            }
            const permission = this.historyPermission(channel, { requireSend: true });
            if (!permission.known || !permission.allowed) {
              blockedOwners.add(key);
              continue;
            }
          }
        }
        storedMessage.channel = channel;
        // F11: attach the verified channel to the ORIGINAL observation entry without
        // replacing its promise/observer, so a deferred reply on the existing work can
        // still deliver after the recovery fetch that failed once finally succeeds.
        this.consumer?.refreshNativeWorkChannel?.(storedMessage);
        if (!this.state.getMessageRoute(message.deliveryChannelId || message.channelId)?.ready &&
            !isHeldDurable(message)) {
          blockedOwners.add(key);
          continue;
        }
        let recoveryOperationStarted = false;
        try {
          const startRecoveryOperation = operation => {
            recoveryOperationStarted = true;
            return operation();
          };
          const settleReplyDeadline = () => {
            const current = this.state.getMessage(message.id);
            if (current?.state !== 'replying') return current;
            return this.state.markReplyFailure(message.id, new Error('Discord recovery deadline exceeded while delivering reply'), true);
          };
          const deliverReplyWithinRecovery = (replyMessage, replyResult) => {
            const deliveryController = new AbortController();
            const settle = () => {
              deliveryController.abort();
              settleReplyDeadline();
            };
            const relayAbort = () => settle();
            if (signal?.aborted) settle();
            else signal?.addEventListener('abort', relayAbort, { once: true });
            return waitForRecoveryOperation(
              () => startRecoveryOperation(() => this.consumer.deliverReply(replyMessage, replyResult, deliveryController.signal)),
              signal,
              deadline,
              settle
            ).finally(() => signal?.removeEventListener('abort', relayAbort));
          };
          if (message.state === 'accepted') {
            if (decisionProjectionPending(message)) {
              blockedOwners.add(key);
              continue;
            }
            for (let attempt = 0; attempt < 2; attempt += 1) {
              recoveryOperationStarted = false;
              result = await waitForRecoveryOperation(
                () => startRecoveryOperation(() => this.consumer.handleStoredMessage(storedMessage, signal, { continueUntilFinal: true, handoff: true, awaitDispatchOutcome: true })),
                signal,
                deadline
              );
              const stillAccepted = result?.status === DISPATCH_OUTCOMES.NOT_SUBMITTED &&
                this.state.getMessage(message.id)?.state === 'accepted';
              if (!stillAccepted || !this.state.getMessageRoute(message.deliveryChannelId || message.channelId)?.ready) break;
            }
          } else if (message.state === 'submitted') {
            const current = this.state.getMessage(message.id);
            if (current?.state === 'reply_ready') {
              this.state.recoverNativeReplyAcknowledgment(message.id);
              recoveryOperationStarted = false;
              result = await deliverReplyWithinRecovery(storedMessage, { status: current.state, message: current });
            }
          } else {
            this.state.recoverNativeReplyAcknowledgment(message.id);
            recoveryOperationStarted = false;
            result = await deliverReplyWithinRecovery(storedMessage, { status: message.state, message });
          }
          if (result === DISPATCH_OUTCOMES.NOT_SUBMITTED || result?.status === DISPATCH_OUTCOMES.NOT_SUBMITTED) {
            blockedOwners.add(key);
          }
        } catch (error) {
          if (recoveryKind(error) === CODEX_VALIDATION_KINDS.STOPPED) return this.state.recoveryCandidates(before).filter(allowed);
          if (recoveryKind(error) === CODEX_VALIDATION_KINDS.DEADLINE) {
            const current = this.state.getMessage(message.id);
            if (!recoveryOperationStarted || current?.state === 'reply_ready') {
              // The preflight check or reply preparation skipped delivery, so retain custody for a fresh pass.
              queueReconciliationRetry([message.id]);
            }
          }
          blockedOwners.add(key);
          this.state.markObservationUnavailable(message.id, error);
          continue;
        }
      }
      return this.state.recoveryCandidates(before).filter(allowed);
    }
  };
}

module.exports = { createPendingReconciliationHandlers };
