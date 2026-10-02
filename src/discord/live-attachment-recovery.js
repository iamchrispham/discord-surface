function createLiveAttachmentRecoveryHandlers({ recoveryKind, bindingIdentityMatches, AGENT_ATTACHMENT_RECOVERY_KINDS, CODEX_VALIDATION_KINDS, READINESS, THREAD_STATES }) {
  return {
  isAttachmentIntakeFailure(error) {
    return [AGENT_ATTACHMENT_RECOVERY_KINDS.INTAKE, CODEX_VALIDATION_KINDS.DEADLINE].includes(recoveryKind(error));
  },

  async retryLiveAttachment(message, binding) {
    const route = typeof message?.channelId === 'string' ? this.state.getMessageRoute(message.channelId) : null;
    const currentBinding = route?.binding || (binding?.channelId ? this.state.getBinding(binding.channelId) : null);
    if (!this.ready || !currentBinding?.active || currentBinding.readiness !== READINESS.READY ||
      !bindingIdentityMatches(binding, currentBinding) || (route?.enrollment && !route.ready)) return { attempted: false };
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      return { attempted: true, result: await this.consumer.handleMessage(message, controller.signal, currentBinding, null, true) };
    } finally {
      this.controllers.delete(controller);
      controller.abort();
    }
  },

  retryPendingLiveAttachment(channelId) {
    const existing = this.attachmentIntakeRetryInFlight.get(channelId);
    if (existing) return existing;
    const pending = this.attachmentIntakeRetryMessages.get(channelId);
    if (!pending) return Promise.resolve({ attempted: true });
    const work = (async () => {
      try {
        const retry = await this.retryLiveAttachment(pending.message, pending.binding);
        if (!retry.attempted) return retry;
        this.attachmentIntakeRetryPendingChannels.delete(channelId);
        this.attachmentIntakeRetryMessages.delete(channelId);
        this.releaseRecoveredAttachmentIntake(channelId);
        return retry;
      } catch (error) {
        this.logger(`live attachment retry failed: ${error.message}`);
        await this.recordLiveAttachmentGap(pending.message, pending.binding, error);
        return { attempted: false };
      }
    })();
    this.attachmentIntakeRetryInFlight.set(channelId, work);
    work.finally(() => this.attachmentIntakeRetryInFlight.delete(channelId)).catch(() => {});
    return work;
  },

  async recordLiveAttachmentGap(message, binding, error, signal = null) {
    const deliveryChannelId = typeof message?.channelId === 'string' ? message.channelId : binding?.channelId;
    const route = deliveryChannelId ? this.state.getMessageRoute(deliveryChannelId) : null;
    const enrollment = route?.enrollment || null;
    const childDelivery = Boolean(deliveryChannelId && binding?.channelId && deliveryChannelId !== binding.channelId);
    const clearPending = () => {
      if (!deliveryChannelId) return;
      const pending = this.attachmentIntakeRetryMessages.get(deliveryChannelId);
      if (pending && !bindingIdentityMatches(pending.binding, binding)) return;
      this.attachmentIntakeRetryPendingChannels.delete(deliveryChannelId);
      this.attachmentIntakeRetryMessages.delete(deliveryChannelId);
      this.consumer.releaseIntake(deliveryChannelId);
      this.attachmentIntakeBlockedChannels.delete(deliveryChannelId);
    };
    if (childDelivery && (!enrollment || enrollment.parentChannelId !== binding?.channelId ||
      route.binding.channelId !== binding.channelId)) {
      clearPending();
      return null;
    }
    const currentBinding = binding?.channelId ? this.state.getBinding(binding.channelId) : null;
    const bindingIsCurrent = Boolean(binding?.active && currentBinding?.active &&
      bindingIdentityMatches(binding, currentBinding));
    if (!bindingIsCurrent) {
      clearPending();
      return null;
    }
    if (signal?.aborted || this.stopping) return null;
    const intakeChannelId = deliveryChannelId || binding.channelId;
    this.attachmentIntakeBlockedChannels.add(intakeChannelId);
    this.attachmentIntakeRetryMessages.set(intakeChannelId, { message, binding });
    const watermark = childDelivery ? null : this.state.getIntakeWatermark(binding.channelId);
    // Preserve verified-empty coverage when a live gap races startup migration.
    const verifiedEmptyCursor = !childDelivery && watermark?.state === READINESS.READY &&
      !watermark.last_seen_id && !watermark.recovered_through_id ? '0' : null;
    if (verifiedEmptyCursor) {
      try {
        this.state.setIntakeBaseline(binding.channelId, verifiedEmptyCursor,
          'live attachment gap recovery cursor', binding);
      } catch (baselineError) {
        this.logger(`live attachment gap baseline failed: ${baselineError.message}`);
      }
    }
    const gapFrom = childDelivery
      ? enrollment.recoveredThroughId || enrollment.lastSeenId || null
      : watermark?.recovered_through_id || watermark?.last_seen_id ||
        verifiedEmptyCursor;
    const detail = `live attachment intake failed for ${message?.id || 'unknown message'}: ${String(error?.message || error).slice(0, 900)}`;
    const boundary = childDelivery
      ? this.markThreadBoundary(intakeChannelId, THREAD_STATES.GAP, detail, gapFrom, message?.id || null, binding)
      : await this.recordBoundary(binding, null, 'gap', detail, gapFrom, message?.id || null, signal);
    if ((!childDelivery && !boundary?.watermark) || (childDelivery && !boundary) || signal?.aborted || this.stopping) return boundary;
    const recoveryTimer = setImmediate(() => {
      this.liveAttachmentRecoveryTimers.delete(recoveryTimer);
      const currentRoute = childDelivery ? this.state.getMessageRoute(intakeChannelId) : null;
      const routeIsCurrent = !childDelivery || Boolean(currentRoute?.enrollment?.active &&
        currentRoute.enrollment.threadId === intakeChannelId && currentRoute.enrollment.parentChannelId === binding.channelId &&
        currentRoute.binding.channelId === binding.channelId);
      if (this.stopping || !this.isCurrentBinding(binding) || !routeIsCurrent) {
        clearPending();
        return;
      }
      if (!childDelivery) {
        let reconciled;
        try { reconciled = this.state.reconcileIntake(binding.channelId, binding); }
        catch (recoveryError) {
          this.logger(`live attachment gap reconciliation failed: ${recoveryError.message}`);
          return;
        }
        if (!reconciled) return;
        if (!reconciled.recovered_through_id) {
          let baseline;
          try {
            baseline = this.state.setIntakeBaseline(binding.channelId, gapFrom || '0', 'live attachment gap recovery cursor', binding);
          } catch (recoveryError) {
            this.logger(`live attachment gap baseline refused: ${recoveryError.message}`);
            return;
          }
          if (!baseline) return;
        }
      } else {
        let reconciled;
        try { reconciled = this.state.reconcileIntake(intakeChannelId, binding); }
        catch (recoveryError) {
          this.logger(`live attachment child gap reconciliation failed: ${recoveryError.message}`);
          clearPending();
          return;
        }
        if (!reconciled) {
          clearPending();
          return;
        }
      }
      this.recoverTransport('live-attachment-gap', this.lifecycleEpoch, [intakeChannelId]).then(async recovery => {
        const recoveredRoute = childDelivery ? this.state.getMessageRoute(intakeChannelId) : null;
        const recoveredRouteIsCurrent = !childDelivery || Boolean(recoveredRoute?.enrollment?.active &&
          recoveredRoute.enrollment.threadId === intakeChannelId && recoveredRoute.enrollment.parentChannelId === binding.channelId &&
          recoveredRoute.binding.channelId === binding.channelId);
        if (this.stopping || !this.isCurrentBinding(binding) || !recoveredRouteIsCurrent) {
          clearPending();
          return;
        }
        if (!this.state.getMessage(message.id)) {
          const retry = await this.retryPendingLiveAttachment(intakeChannelId);
          if (!retry.attempted) return;
        } else {
          this.attachmentIntakeRetryPendingChannels.delete(intakeChannelId);
          this.attachmentIntakeRetryMessages.delete(intakeChannelId);
        }
        this.releaseRecoveredAttachmentIntake(intakeChannelId);
        if (recovery.ready) {
          await this.reconcilePending(undefined, { readyOnly: true });
        } else if (this.ready) {
          await this.reconcilePending(undefined, { readyOnly: true });
        }
      }).catch(recoveryError => {
        this.logger(`live attachment recovery failed: ${recoveryError.message}`);
      });
    });
    this.liveAttachmentRecoveryTimers.add(recoveryTimer);
    this.attachmentIntakeRetryPendingChannels.add(intakeChannelId);
    return boundary;
  },

  releaseRecoveredAttachmentIntake(channelId = null) {
    const candidates = channelId ? [channelId] : [...this.attachmentIntakeBlockedChannels];
    for (const blockedChannelId of candidates) {
      const route = this.state.getMessageRoute(blockedChannelId);
      const binding = route?.binding || this.state.getBinding(blockedChannelId);
      if (!binding?.active || !route?.ready) continue;
      if (this.attachmentIntakeRetryPendingChannels.has(blockedChannelId)) {
        const pending = this.attachmentIntakeRetryMessages.get(blockedChannelId);
        if (pending && this.state.getMessage(pending.message.id)) {
          this.attachmentIntakeRetryPendingChannels.delete(blockedChannelId);
          this.attachmentIntakeRetryMessages.delete(blockedChannelId);
        } else {
          void this.retryPendingLiveAttachment(blockedChannelId).catch(error => {
            this.logger(`live attachment retry scheduling failed: ${error.message}`);
          });
          continue;
        }
      }
      this.consumer.releaseIntake(blockedChannelId);
      this.attachmentIntakeBlockedChannels.delete(blockedChannelId);
    }
  }
  };
}

module.exports = { createLiveAttachmentRecoveryHandlers };
