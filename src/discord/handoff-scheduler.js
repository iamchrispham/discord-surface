'use strict';

function createHandoffSchedulerHandlers({
  READINESS,
  DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS,
  DEFERRED_HANDOFF_RECOVERY_MAX_DELAY_MS,
  PENDING_HANDOFF_RECOVERY_POLL_MS
}) {
  function scheduleDeferredHandoffRecovery(channelId, { pendingGeneration = false } = {}) {
    if (this.stopping || typeof channelId !== 'string') return;
    const channels = pendingGeneration ? this.pendingHandoffRecoveryChannels : this.deferredHandoffRecoveryChannels;
    channels.add(channelId);
    const delay = Math.max(1, this.deferredHandoffRecoveryDelayMs);
    const timerDeadline = Date.now() + delay;
    if (this.deferredHandoffRecoveryTimer) {
      const currentDeadline = this.deferredHandoffRecoveryTimerDeadline ?? Number.POSITIVE_INFINITY;
      if (timerDeadline >= currentDeadline) return;
      clearTimeout(this.deferredHandoffRecoveryTimer);
      this.deferredHandoffRecoveryTimer = null;
    }
    this.deferredHandoffRecoveryDelayMs = Math.min(delay * 2, DEFERRED_HANDOFF_RECOVERY_MAX_DELAY_MS);
    const timer = setTimeout(() => {
      if (this.deferredHandoffRecoveryTimer !== timer) return;
      this.deferredHandoffRecoveryTimer = null;
      this.deferredHandoffRecoveryTimerDeadline = null;
      if (this.stopping || (!this.deferredHandoffRecoveryChannels.size && !this.pendingHandoffRecoveryChannels.size)) return;
      const deferredChannels = [...this.deferredHandoffRecoveryChannels];
      const pendingChannels = [...this.pendingHandoffRecoveryChannels];
      this.deferredHandoffRecoveryChannels.clear();
      this.pendingHandoffRecoveryChannels.clear();
      const requeue = (channelIds, pendingGeneration = false) => {
        for (const deferredChannelId of channelIds) {
          this.scheduleDeferredHandoffRecovery(deferredChannelId, { pendingGeneration });
        }
      };
      if (this.started && !this.transportReady) {
        requeue(deferredChannels);
        requeue(pendingChannels, true);
        return;
      }
      Promise.resolve().then(async () => {
        if (this.stopping) return;
        if (this.recoveryPromise) {
          requeue(deferredChannels);
          requeue(pendingChannels, true);
          return;
        }
        const recoverableChannels = new Set();
        const reconcileOnlyChannels = new Set();
        for (const channelId of new Set([...deferredChannels, ...pendingChannels])) {
          const binding = this.state.getBinding(channelId);
          const recovery = this.state.recoverInterruptedOrdinaryHandoffIntake?.(channelId, binding);
          const liveHandoffFence = this.state.ordinaryHandoffPauses?.has(channelId);
          if (recovery?.deferred) {
            this.deferredHandoffRecoveryChannels.add(channelId);
          } else if (recovery && binding?.active) {
            recoverableChannels.add(channelId);
          } else if (liveHandoffFence) {
            continue;
          } else if (binding?.active && this.state.isOrdinaryBinding?.(binding) &&
            [READINESS.PENDING, READINESS.RECOVERING].includes(binding.readiness)) {
            recoverableChannels.add(channelId);
          } else if (binding?.active && binding.readiness === READINESS.READY) {
            reconcileOnlyChannels.add(channelId);
          }
        }
        if (recoverableChannels.size) {
          for (const channelId of recoverableChannels) {
            const channelIds = new Set([channelId]);
            const recovery = await this.recoverTransport('ordinary-handoff', this.lifecycleEpoch, channelIds);
            if (recovery.ready) await this.reconcilePending(undefined, { channelIds });
            else if (this.ready) await this.reconcilePending(undefined, { readyOnly: true, channelIds });
          }
        }
        if (reconcileOnlyChannels.size) {
          await this.reconcilePending(undefined, {
            allowPaused: !this.ready,
            readyOnly: true,
            channelIds: reconcileOnlyChannels
          });
        }
      }).catch(error => this.logger(`Deferred ordinary handoff recovery failed: ${error.message}`)).finally(() => {
        if (this.stopping) return;
        if (this.deferredHandoffRecoveryChannels.size || this.pendingHandoffRecoveryChannels.size) {
          const deferredChannels = [];
          for (const channelId of this.deferredHandoffRecoveryChannels) {
            deferredChannels.push(channelId);
          }
          if (deferredChannels.length) requeue(deferredChannels);
          if (this.pendingHandoffRecoveryChannels.size) requeue([...this.pendingHandoffRecoveryChannels], true);
        } else {
          this.deferredHandoffRecoveryDelayMs = DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS;
        }
      });
    }, delay);
    timer.unref?.();
    this.deferredHandoffRecoveryTimer = timer;
    this.deferredHandoffRecoveryTimerDeadline = timerDeadline;
  }

  function schedulePendingHandoffRecoveryPoll() {
    if (this.stopping || !this.started || this.pendingHandoffRecoveryPollTimer) return;
    const timer = setTimeout(() => {
      if (this.pendingHandoffRecoveryPollTimer === timer) this.pendingHandoffRecoveryPollTimer = null;
      if (this.stopping || !this.started) return;
      const pendingHandoffChannels = new Set(this.state.listPendingOrdinaryHandoffChannels?.() || []);
      for (const binding of this.state.listBindings?.() || []) {
        if (binding.active && binding.readiness === READINESS.PENDING && this.state.isOrdinaryBinding?.(binding)) {
          pendingHandoffChannels.add(binding.channelId);
        }
      }
      for (const channelId of pendingHandoffChannels) {
        this.scheduleDeferredHandoffRecovery(channelId, { pendingGeneration: true });
      }
      this.schedulePendingHandoffRecoveryPoll();
    }, PENDING_HANDOFF_RECOVERY_POLL_MS);
    timer.unref?.();
    this.pendingHandoffRecoveryPollTimer = timer;
  }

  return { scheduleDeferredHandoffRecovery, schedulePendingHandoffRecoveryPoll };
}

module.exports = { createHandoffSchedulerHandlers };
