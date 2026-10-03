'use strict';

function createTransportRecoveryHandlers({ READINESS, THREAD_STATES, RECOVERY_POLICIES, recoveryKind, createTransportRecoveryWaiter, RECOVERY_WAITER_DEADLINE_GRACE_MS }) {
  return {
  async recoverTransport(reason, lifecycleEpoch = this.lifecycleEpoch, channelIds = null, recoveryDeadline = null,
    { recoveryPolicy = RECOVERY_POLICIES.FULL } = {}) {
    if (!this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
    const overallDeadline = recoveryDeadline ?? (Date.now() + this.recoveryTimeoutMs);
    let callerScope = null;
    if (channelIds !== null && channelIds !== undefined) {
      callerScope = new Set(channelIds);
    } else if (recoveryPolicy === RECOVERY_POLICIES.UNRESOLVED) {
      callerScope = new Set([
        ...this.state.listBindings()
          .filter(binding => binding.active && (binding.readiness !== READINESS.READY ||
            this.state.getIntakeWatermark(binding.channelId)?.state !== READINESS.READY))
          .map(binding => binding.channelId),
        ...this.state.listThreadEnrollments()
          .filter(enrollment => enrollment.active && enrollment.state !== THREAD_STATES.READY)
          .map(enrollment => enrollment.threadId)
      ]);
    }
    const expandScope = scope => {
      if (scope === null) return null;
      const expanded = new Set(scope);
      for (const enrollment of this.state.listThreadEnrollments()) {
        if (!enrollment.active) continue;
        if (expanded.has(enrollment.parentChannelId) || expanded.has(enrollment.threadId)) expanded.add(enrollment.threadId);
      }
      return expanded;
    };
    const allActiveEnrollmentsReady = () => this.state.listThreadEnrollments().every(enrollment => !enrollment.active || enrollment.state === THREAD_STATES.READY);
    const scopeIsReady = scope => {
      const expanded = expandScope(scope);
      const scopedChannels = expanded === null
        ? new Set(this.state.listBindings().filter(binding => binding.active).map(binding => binding.channelId))
        : expanded;
      for (const channelId of scopedChannels) {
        const binding = this.state.getBinding(channelId);
        const watermark = this.state.getIntakeWatermark(channelId);
        if (binding?.active && binding.readiness === READINESS.READY && watermark?.state === READINESS.READY) continue;
        const enrollment = this.state.getThreadEnrollment(channelId);
        if (enrollment?.active && enrollment.state === THREAD_STATES.READY) continue;
        return false;
      }
      if (expanded === null && !allActiveEnrollmentsReady()) return false;
      return true;
    };
    const scopesIntersect = (left, right) => {
      if (left === null || right === null) return true;
      const leftScope = expandScope(left);
      const rightScope = expandScope(right);
      return [...leftScope].some(channelId => rightScope.has(channelId));
    };
    const makeResult = (waiter, fallback = null) => {
      if (waiter.stopped || !this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
      if (scopeIsReady(waiter.scope)) return { ready: true, state: 'ready' };
      if (waiter.scope === null && waiter.childCount === 0 && waiter.ownResult?.ready === true && allActiveEnrollmentsReady()) return waiter.ownResult;
      const result = fallback || waiter.lastResult || waiter.ownResult || { ready: false, state: 'unavailable' };
      return result?.ready === true ? { ready: false, state: 'unavailable', error: result.error } : result;
    };
    const attachParents = waiter => {
      for (const parent of this.recoveryActiveWaiters) {
        if (parent === waiter || parent.settled || !scopesIntersect(parent.scope, waiter.scope)) continue;
        parent.pending += 1;
        parent.childCount += 1;
        parent.extendDeadline(waiter.deadline);
        waiter.parents.add(parent);
      }
    };
    const startRecoveryPass = (scope, deadline, passReason, passLifecycle, activeWaiters) => {
      if (Date.now() >= deadline || activeWaiters.every(waiter => waiter.settled)) {
        return Promise.resolve({ ready: false, state: 'unavailable' });
      }
      this.recoveryActiveWaiters = new Set(activeWaiters.filter(waiter => !waiter.settled));
      this.recoveryController = new AbortController();
      const controller = this.recoveryController;
      const connectionEpoch = this.connectionEpoch;
      let resolvePass;
      let rejectPass;
      const activeRecovery = new Promise((resolve, reject) => {
        resolvePass = resolve;
        rejectPass = reject;
      });
      this.recoveryPromise = activeRecovery;
      Promise.resolve().then(async () => {
        try {
          const result = await this.recoverInbound(controller.signal, passReason, passLifecycle,
            scope === null ? null : new Set(scope), deadline);
          if (controller.signal.aborted || connectionEpoch !== this.connectionEpoch || !this.isCurrentLifecycle(passLifecycle)) {
            resolvePass({ ready: false, state: 'stopped' });
            return;
          }
          const hasReadyBinding = this.state.listBindings().some(binding => binding.active && binding.readiness === READINESS.READY);
          this.ready = result.ready || (result.state !== 'stopped' && hasReadyBinding);
          resolvePass(result);
        } catch (error) {
          rejectPass(error);
        }
      });
      const cleanup = () => {
        if (this.recoveryPromise !== activeRecovery) return;
        this.recoveryPromise = null;
        this.recoveryController = null;
        this.releaseRecoveredAttachmentIntake();
        this.scheduleHeldLiveCheckpoints();
      };
      activeRecovery.then(cleanup, cleanup).catch(() => {});
      return activeRecovery;
    };
    const drainRecoveryFollowups = async () => {
      while (true) {
        if (!this.pendingRecoveryRequests.length) {
          await Promise.resolve();
          if (!this.pendingRecoveryRequests.length) break;
        }
        const request = this.pendingRecoveryRequests.shift();
        if (!request) continue;
        if (!this.isCurrentLifecycle(request.lifecycleEpoch)) {
          request.waiter.stop();
          continue;
        }
        const activeWaiters = [request.waiter, ...request.waiter.parents].filter(waiter => !waiter.settled);
        this.recoveryActiveWaiters = new Set(activeWaiters);
        // Scoped followups are serialized, so their timeout starts when this pass begins.
        const passDeadline = request.scope === null
          ? request.deadline
          : Date.now() + this.recoveryTimeoutMs;
        if (request.scope !== null) {
          request.waiter.extendDeadline(passDeadline);
          for (const parent of request.waiter.parents) parent.extendDeadline(passDeadline);
        }
        if (request.capturedClosingCustodyAttempts) {
          for (const [channelId, attempt] of request.capturedClosingCustodyAttempts) {
            if (this.closingCustodyRetries.get(channelId) === attempt && attempt.lifecycleEpoch === request.lifecycleEpoch) {
              attempt.deadline = passDeadline;
            }
          }
        }
        let result;
        try {
          result = await startRecoveryPass(request.scope, passDeadline, request.reason,
            request.lifecycleEpoch, activeWaiters);
        } catch (error) {
          result = { ready: false, state: recoveryKind(error) || 'unavailable', error };
        }
        request.waiter.completeOwn(result);
        this.recoveryActiveWaiters = new Set(activeWaiters.filter(waiter => !waiter.settled));
        if (result?.state === 'stopped') {
          for (const pending of this.pendingRecoveryRequests.splice(0)) pending.waiter.stop();
          break;
        }
      }
      return { ready: true, state: 'ready' };
    };
    const ensureFollowupCoordinator = () => {
      if (this.recoveryFollowupPromise) return;
      const activeRecovery = this.recoveryPromise || Promise.resolve();
      const coordinator = activeRecovery.then(
        () => drainRecoveryFollowups(),
        () => drainRecoveryFollowups()
      );
      this.recoveryFollowupPromise = coordinator;
      const finishCoordinator = () => {
        if (this.recoveryFollowupPromise !== coordinator) return;
        this.recoveryFollowupPromise = null;
        this.recoveryFollowupScope = null;
        this.recoveryActiveWaiters.clear();
        if (this.pendingRecoveryRequests.length) ensureFollowupCoordinator();
      };
      coordinator.then(finishCoordinator, finishCoordinator).catch(() => {});
    };

    const recoveryAlreadyQueued = this.recoveryPromise || this.recoveryFollowupPromise;
    const queuedScoped = recoveryAlreadyQueued && callerScope !== null;
    const waiter = createTransportRecoveryWaiter(callerScope, queuedScoped ? null : overallDeadline, makeResult, RECOVERY_WAITER_DEADLINE_GRACE_MS);
    if (recoveryAlreadyQueued) {
      if (callerScope === null) this.ready = false;
      attachParents(waiter);
      let capturedClosingCustodyAttempts = null;
      if (callerScope !== null && recoveryDeadline !== null) {
        for (const channelId of callerScope) {
          const attempt = this.closingCustodyRetries.get(channelId);
          if (attempt && attempt.lifecycleEpoch === lifecycleEpoch && attempt.deadline === recoveryDeadline) {
            if (!capturedClosingCustodyAttempts) capturedClosingCustodyAttempts = new Map();
            capturedClosingCustodyAttempts.set(channelId, attempt);
          }
        }
      }
      this.pendingRecoveryRequests.push({
        scope: callerScope === null ? null : new Set(callerScope),
        deadline: queuedScoped ? null : overallDeadline,
        reason,
        lifecycleEpoch,
        waiter,
        capturedClosingCustodyAttempts
      });
      this.recoveryFollowupScope = callerScope === null ? null : new Set(callerScope);
      ensureFollowupCoordinator();
      return waiter.promise;
    }

    if (callerScope === null) this.ready = false;
    const activeRecovery = startRecoveryPass(callerScope, overallDeadline, reason,
      lifecycleEpoch, [waiter]);
    activeRecovery.then(
      result => waiter.completeOwn(result),
      error => waiter.completeOwn({ ready: false, state: recoveryKind(error) || 'unavailable', error })
    ).catch(() => {});
    return waiter.promise;
  }
  };
}

module.exports = { createTransportRecoveryHandlers };
