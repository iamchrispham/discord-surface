'use strict';

function createGatewayLifecycleHandlers({
  readSecret,
  recoveryError,
  CODEX_VALIDATION_KINDS,
  READINESS,
  THREAD_STATES,
  isNativeProofRetryBoundary,
  CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX,
  watchAcknowledgments,
  MESSAGE_STATES,
  ACK_WAITING,
  invalidateReconciliationWaiters,
  DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS,
  LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS
}) {
  return {
    async start(secretFile) {
    if (this.stopping) throw new Error('Discord gateway is stopping');
    if (this.startPromise) return this.startPromise;
    const epoch = ++this.lifecycleEpoch;
    this.ready = false;
    this.starting = true;
    this.started = false;
    this.createInteractionRecoveryBarrier();
    const startPromise = (async () => {
      const token = readSecret(secretFile);
      this.discordToken = token;
      await this.client.login(token);
      if (!this.isCurrentLifecycle(epoch)) throw recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Discord startup was stopped during login');
      try {
        await this.registerApplicationCommand();
      } catch (error) {
        this.logger(`Discord application command registration failed: ${error.message}`);
      }
      for (const binding of this.state.listBindings().filter(binding => binding.active)) {
        this.state.recoverInterruptedOrdinaryHandoffIntake?.(binding.channelId, binding);
      }
      const recovery = await this.recoverTransport('startup', epoch);
      if (!this.isCurrentLifecycle(epoch)) throw recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Discord startup was stopped during recovery');
      const unresolvedBindings = this.state.listBindings().filter(binding => binding.active && binding.readiness !== READINESS.READY);
      const unresolvedThreadEnrollments = this.state.listThreadEnrollments().filter(enrollment =>
        enrollment.active && enrollment.state !== THREAD_STATES.READY
      );
      const aggregateRecoveryReady = recovery.ready && unresolvedThreadEnrollments.length === 0;
      const aggregateRecoveryState = aggregateRecoveryReady
        ? recovery.state
        : unresolvedThreadEnrollments[0]?.state || recovery.state;
      const hasEndpointUnavailableBinding = !aggregateRecoveryReady && ['gap', 'unavailable'].includes(recovery.state) &&
        unresolvedBindings.length > 0 && unresolvedBindings.every(binding => {
          const watermark = this.state.getIntakeWatermark(binding.channelId);
          return watermark?.state === READINESS.UNAVAILABLE &&
            typeof watermark.detail === 'string' && (
              isNativeProofRetryBoundary(watermark.state, watermark.detail) ||
              watermark.detail.startsWith(CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX) ||
              watermark.detail.startsWith('Codex transcript proof unavailable before event write:')
            );
        }) && unresolvedThreadEnrollments.every(enrollment => this.isPreAdoptionRetryableThread(enrollment.threadId));
      const hasPersistedRecoveryHolds = !aggregateRecoveryReady && recovery.state !== 'stopped' &&
        (unresolvedBindings.length > 0 || unresolvedThreadEnrollments.length > 0) &&
        unresolvedBindings.every(binding => {
          const watermark = this.state.getIntakeWatermark(binding.channelId);
          return watermark && [READINESS.PENDING, READINESS.GAP, READINESS.UNAVAILABLE].includes(watermark.state) &&
            binding.readiness === watermark.state;
        }) &&
        unresolvedThreadEnrollments.every(enrollment =>
          [THREAD_STATES.PENDING, THREAD_STATES.GAP, THREAD_STATES.UNAVAILABLE].includes(enrollment.state));
      if (!aggregateRecoveryReady && !hasEndpointUnavailableBinding && !hasPersistedRecoveryHolds) {
        throw new Error(`Discord intake recovery is ${aggregateRecoveryState}`);
      }
      if (hasEndpointUnavailableBinding) this.ready = true;
      this.transportReady = true;
      this.started = true;
      this.flushLegacyParentReconciliation();
      this.resolveInteractionRecovery(true);
      this.schedulePendingHandoffRecoveryPoll();
      this.acknowledgments = watchAcknowledgments({
        state: this.state,
        send: (message, reaction) => this.sendAcknowledgment(message, reaction),
        deliver: this.deliverAcknowledgment,
        onAcknowledged: messageId => {
          if (this.stopping) return null;
          const message = this.state.getMessage(messageId);
          if (![MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLY_READY].includes(message?.state)) return ACK_WAITING;
          this.consumer?.releaseAcknowledged?.(messageId);
          return this.reconcilePending(undefined, {
            allowPaused: true,
            readyOnly: true,
            channelIds: [message.channelId],
            messageIds: [messageId]
          });
        },
        logger: this.logger
      });
    })();
    this.startPromise = startPromise;
    try { return await startPromise; }
    catch (error) {
      this.started = false;
      throw error;
    }
    finally {
      if (this.startPromise === startPromise) this.startPromise = null;
      this.starting = false;
      if (!this.started) this.ready = false;
      if (!this.started) this.transportReady = false;
      if (!this.started) this.resolveInteractionRecovery(false);
      if (!this.started) this.discordToken = null;
    }
  },
    async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.lifecycleEpoch += 1;
    this.connectionEpoch += 1;
    this.stopping = true;
    this.started = false;
    this.transportReady = false;
    this.resolveInteractionRecovery(false);
    invalidateReconciliationWaiters(this.client);
    for (const timer of this.liveAttachmentRecoveryTimers) clearImmediate(timer);
    this.liveAttachmentRecoveryTimers.clear();
    for (const channelId of this.attachmentIntakeBlockedChannels) this.consumer.releaseIntake(channelId);
    this.attachmentIntakeBlockedChannels.clear();
    this.attachmentIntakeRetryPendingChannels.clear();
    this.attachmentIntakeRetryMessages.clear();
    this.attachmentIntakeRetryInFlight.clear();
    if (this.deferredHandoffRecoveryTimer) clearTimeout(this.deferredHandoffRecoveryTimer);
    this.deferredHandoffRecoveryTimer = null;
    this.deferredHandoffRecoveryTimerDeadline = null;
    if (this.pendingHandoffRecoveryPollTimer) clearTimeout(this.pendingHandoffRecoveryPollTimer);
    this.pendingHandoffRecoveryPollTimer = null;
    this.deferredHandoffRecoveryChannels.clear();
    this.pendingHandoffRecoveryChannels.clear();
    this.pendingFullRecovery = false;
    if (this.decisionRecoveryWakeTimer) clearTimeout(this.decisionRecoveryWakeTimer);
    this.decisionRecoveryWakeTimer = null;
    this.decisionRecoveryWakeDeadline = 0;
    this.decisionRecoveryWakeChannels.clear();
    this.pendingRecoveryChannels.clear();
    this.queuedDecisionRecoveryAll = false;
    this.queuedDecisionRecoveryChannels.clear();
    this.queuedDecisionRecoveryDeferred = false;
    for (const request of this.pendingRecoveryRequests.splice(0)) request.waiter?.stop?.();
    this.recoveryRetryScheduledChannels.clear();
    this.closingCustodyRetries.clear();
    this.deferredHandoffRecoveryDelayMs = DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS;
    this.stopPromise = (async () => {
      this.ready = false;
      this.recoveryController?.abort();
      this.decisionRecoveryController?.abort();
      this.liveCheckpointController?.abort();
      const recovery = this.recoveryPromise;
      const reconnect = this.reconnectPromise;
      const liveCheckpoint = this.liveCheckpointPromise;
      await Promise.allSettled([recovery, reconnect, liveCheckpoint].filter(Boolean));
      if (this.liveCheckpointRetryTimer) clearTimeout(this.liveCheckpointRetryTimer);
      this.liveCheckpointRetryTimer = null;
      this.liveCheckpointRetryChannels = null;
      this.liveCheckpointRetryDelayMs = LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS;
      this.liveIntakeCounts.clear();
      for (const controller of this.controllers) controller.abort();
      for (const controller of this.receiptControllers) controller.abort();
      const acknowledgmentStop = this.acknowledgments?.stop();
      this.acknowledgments = null;
      this.consumer.abortNativeWork();
      await Promise.allSettled([...this.inFlight]);
      await this.consumer.waitForNativeWork();
      await this.consumer.waitForReceipts();
      await acknowledgmentStop;
      this.client.off?.('messageCreate', this.boundMessage);
      this.client.off?.('interactionCreate', this.boundInteraction);
      this.client.off?.('shardResume', this.boundResume);
      this.client.off?.('resume', this.boundResume);
      this.client.off?.('shardDisconnect', this.boundDisconnect);
      this.client.off?.('shardReconnecting', this.boundReconnecting);
      this.client.off?.('shardReady', this.boundShardReady);
      try {
        if (typeof this.client.destroy === 'function') await this.client.destroy();
      } finally {
        this.discordToken = null;
      }
    })();
    try { await this.stopPromise; }
    finally {
      this.stopPromise = null;
      this.stopping = false;
    }
  }
  };
}

module.exports = { createGatewayLifecycleHandlers };
