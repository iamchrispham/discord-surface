'use strict';

function createLiveCheckpointHandlers({
  heldParentRequestIds,
  CODEX_VALIDATION_KINDS,
  recoveryKind,
  THREAD_STATES,
  LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS,
  LIVE_CHECKPOINT_RETRY_MAX_DELAY_MS,
  READINESS,
  waitForRecoveryOperation,
  recoveryError,
  compareDiscordIds,
  recoverThread
}) {
  return {
    beginLiveCheckpoint(triggeredCounts = new Map(), { allowPendingRecovery = true } = {}) {
        if (this.liveCheckpointPromise || this.stopping || this.recoveryPromise) return;
        const controller = new AbortController();
        const epoch = this.lifecycleEpoch;
        this.liveCheckpointController = controller;
        let advancedChannels = new Set();
        const checkpoint = this.checkpointHealthyIntake(controller.signal, epoch, triggeredCounts)
          .then(async result => {
            advancedChannels = result instanceof Set ? result : new Set();
            const threads = [...advancedChannels].filter(channelId => this.state.getThreadEnrollment(channelId)?.active);
            if (threads.length) {
              const parentChannels = threads
                .map(channelId => this.state.getThreadEnrollment(channelId)?.parentChannelId)
                .filter(Boolean);
              if (!controller.signal.aborted && this.isCurrentLifecycle(epoch)) {
                await this.reconcilePending(undefined, { readyOnly: true, channelIds: threads });
                const parentRequestIds = heldParentRequestIds(this.state, [...new Set(parentChannels)], threads);
                if (parentRequestIds.length && !controller.signal.aborted && this.isCurrentLifecycle(epoch)) {
                  await this.reconcilePending(undefined, {
                    readyOnly: true,
                    channelIds: [...new Set(parentChannels)],
                    messageIds: parentRequestIds
                  });
                }
              }
            }
            return result;
          })
          .catch(error => {
            if (recoveryKind(error) !== CODEX_VALIDATION_KINDS.STOPPED) this.logger(`Discord live intake checkpoint failed: ${error.message}`);
          })
          .finally(() => {
            if (this.liveCheckpointPromise === checkpoint) this.liveCheckpointPromise = null;
            if (this.liveCheckpointController === controller) this.liveCheckpointController = null;
            if (this.stopping) return;
            const deferredChannels = [...this.liveIntakeCounts.entries()]
              .filter(([channelId, count]) => count >= this.liveCheckpointThreshold && this.state.getMessageRoute(channelId)?.binding.active);
            const deferredCounts = new Map(deferredChannels);
            for (const [channelId] of deferredChannels) this.liveIntakeCounts.set(channelId, 0);
            for (const [channelId, count] of triggeredCounts) {
              if (advancedChannels.has(channelId) || !this.state.getMessageRoute(channelId)?.binding.active) continue;
              const currentCount = this.liveIntakeCounts.get(channelId) || 0;
              const deferredCount = deferredCounts.get(channelId);
              if (deferredCount === undefined) this.liveIntakeCounts.set(channelId, currentCount + count);
              else deferredCounts.set(channelId, deferredCount + count);
            }
            for (const [channelId, count] of this.liveIntakeCounts) {
              if (count < this.liveCheckpointThreshold || !this.state.getMessageRoute(channelId)?.binding.active) continue;
              deferredCounts.set(channelId, count);
              this.liveIntakeCounts.set(channelId, 0);
            }
            for (const channelId of deferredCounts.keys()) {
              if (!this.isPreAdoptionRetryableThread(channelId)) continue;
              deferredCounts.delete(channelId);
              this.liveIntakeCounts.delete(channelId);
            }
            if (this.recoveryPromise) {
              for (const [channelId, count] of deferredCounts) {
                const currentCount = this.liveIntakeCounts.get(channelId) || 0;
                this.liveIntakeCounts.set(channelId, Math.max(currentCount, count));
              }
              return;
            }
            if (!deferredCounts.size) {
              this.liveCheckpointRetryDelayMs = LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS;
              return;
            }
            const immediateCounts = new Map();
            for (const [channelId, count] of deferredCounts) {
              const pendingRecovery = allowPendingRecovery && this.state.getThreadEnrollment(channelId)?.state === THREAD_STATES.PENDING && !this.isPreAdoptionRetryableThread(channelId);
              if (!advancedChannels.has(channelId) && !pendingRecovery) continue;
              immediateCounts.set(channelId, count);
              deferredCounts.delete(channelId);
            }
            if (deferredCounts.size) this.scheduleLiveCheckpointRetry(deferredCounts);
            else this.liveCheckpointRetryDelayMs = LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS;
            if (immediateCounts.size) this.beginLiveCheckpoint(immediateCounts, { allowPendingRecovery: false });
          });
        this.liveCheckpointPromise = checkpoint;
      },

    scheduleLiveCheckpointRetry(deferredCounts) {
        if (!deferredCounts?.size || this.stopping) return;
        const retryChannels = this.liveCheckpointRetryChannels || new Set();
        for (const [channelId, count] of deferredCounts) {
          const currentCount = this.liveIntakeCounts.get(channelId) || 0;
          this.liveIntakeCounts.set(channelId, Math.max(currentCount, count));
          retryChannels.add(channelId);
        }
        this.liveCheckpointRetryChannels = retryChannels;
        if (this.liveCheckpointRetryTimer) return;
        const retryDelay = Math.min(this.liveCheckpointRetryDelayMs || LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS, LIVE_CHECKPOINT_RETRY_MAX_DELAY_MS);
        this.liveCheckpointRetryDelayMs = Math.min(retryDelay * 2, LIVE_CHECKPOINT_RETRY_MAX_DELAY_MS);
        const timer = setTimeout(() => {
          if (this.liveCheckpointRetryTimer === timer) this.liveCheckpointRetryTimer = null;
          const channels = this.liveCheckpointRetryChannels || new Set();
          this.liveCheckpointRetryChannels = null;
          if (this.stopping || this.recoveryPromise || this.liveCheckpointPromise) return;
          const retryCounts = new Map();
          for (const channelId of channels) {
            if (!this.state.getMessageRoute(channelId)?.binding.active) continue;
            if (this.isPreAdoptionRetryableThread(channelId)) continue;
            const count = this.liveIntakeCounts.get(channelId) || 0;
            if (count < this.liveCheckpointThreshold) continue;
            retryCounts.set(channelId, count);
            this.liveIntakeCounts.set(channelId, 0);
          }
          if (retryCounts.size) this.beginLiveCheckpoint(retryCounts, { allowPendingRecovery: false });
        }, retryDelay);
        timer.unref?.();
        this.liveCheckpointRetryTimer = timer;
      },

    async checkpointHealthyIntake(signal, lifecycleEpoch, triggeredCounts = new Map()) {
        const deadline = Date.now() + this.recoveryTimeoutMs;
        const triggeredChannels = triggeredCounts instanceof Map ? new Set(triggeredCounts.keys()) : new Set();
        const bindings = this.state.listBindings().filter(binding => binding.active
          && binding.readiness === READINESS.READY
          && (!triggeredChannels.size || triggeredChannels.has(binding.channelId)));
        const advancedChannels = new Set();
        for (const binding of bindings) {
          if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) throw recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Discord live intake checkpoint was stopped');
          const watermark = this.state.getIntakeWatermark(binding.channelId);
          if (!watermark?.recovered_through_id || typeof this.state.hasIntakeEvidence !== 'function') continue;
          if (typeof this.client?.channels?.fetch !== 'function') continue;
          let channel;
          try {
            channel = await waitForRecoveryOperation(() => this.client.channels.fetch(binding.channelId), signal, deadline);
            if (!channel || typeof channel.messages?.fetch !== 'function') continue;
            const permission = this.historyPermission(channel, { requireSend: this.state.isOrdinaryBinding?.(binding) });
            if (!permission.known || !permission.allowed) continue;
            let after = watermark.recovered_through_id;
            let pages = 0;
            let total = 0;
            let complete = false;
            while (pages < this.historyMaxPages && total < this.historyMaxMessages && Date.now() < deadline) {
              if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) throw recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Discord live intake checkpoint was stopped');
              const page = this.historyMessages(await waitForRecoveryOperation(
                () => this.fetchHistory(channel, { limit: this.historyPageLimit, after, signal }),
                signal,
                deadline
              ));
              pages += 1;
              if (!page.length) { complete = true; break; }
              if (page.some(message => typeof message?.id !== 'string' || message.id.length === 0)) break;
              page.sort((left, right) => compareDiscordIds(left?.id, right?.id));
              const fresh = page.filter(message => typeof message?.id === 'string' && compareDiscordIds(message.id, after) > 0);
              if (!fresh.length) { complete = true; break; }
              for (const message of fresh) {
                if (total >= this.historyMaxMessages) break;
                if (!this.state.hasIntakeEvidence(message.id)) {
                  complete = false;
                  break;
                }
                after = message.id;
                total += 1;
              }
              if (!complete && total < this.historyMaxMessages && fresh.some(message => !this.state.hasIntakeEvidence(message.id))) break;
              if (total >= this.historyMaxMessages) {
                const consumedPage = after === fresh[fresh.length - 1].id;
                if (page.length < this.historyPageLimit && consumedPage) complete = true;
                break;
              }
              if (page.length < this.historyPageLimit) { complete = true; break; }
            }
            if (!complete || !after) continue;
            const checkpointed = this.state.checkpointIntake(binding.channelId, after, binding);
            if (checkpointed?.recovered_through_id && compareDiscordIds(checkpointed.recovered_through_id, watermark.recovered_through_id) > 0) {
              advancedChannels.add(binding.channelId);
            }
          } catch (error) {
            if (recoveryKind(error) === CODEX_VALIDATION_KINDS.STOPPED) throw error;
          }
        }
        for (const enrollment of this.state.listThreadEnrollments()) {
          if (!enrollment.active || ![THREAD_STATES.READY, THREAD_STATES.PENDING].includes(enrollment.state) ||
              (triggeredChannels.size && !triggeredChannels.has(enrollment.threadId))) continue;
          if (this.isPreAdoptionRetryableThread(enrollment.threadId)) continue;
          const checkpointOnly = enrollment.state === THREAD_STATES.READY;
          const recovered = await recoverThread(this, enrollment, signal, lifecycleEpoch, waitForRecoveryOperation, checkpointOnly, deadline);
          if (recovered) {
            advancedChannels.add(enrollment.threadId);
          } else if (checkpointOnly && this.state.getThreadEnrollment(enrollment.threadId)?.state === THREAD_STATES.PENDING) {
            const currentCount = this.liveIntakeCounts.get(enrollment.threadId) || 0;
            this.liveIntakeCounts.set(enrollment.threadId, Math.max(currentCount, this.liveCheckpointThreshold));
          }
        }
        return advancedChannels;
      }
  };
}

module.exports = { createLiveCheckpointHandlers };
