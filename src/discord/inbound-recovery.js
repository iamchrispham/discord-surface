'use strict';

function createInboundRecoveryHandlers({
  isNativeProofBeforeBindingBoundary,
  READINESS,
  compareDiscordIds,
  isRetryableIntakeBoundary,
  isInterruptedRetryBoundary,
  isNativeProofRetryBoundary,
  nativeProofDeadlineDetail,
  NATIVE_PROOF_PHASES,
  classifyRecoveryFailure,
  recoveryError,
  CODEX_VALIDATION_KINDS,
  CLOSING_CUSTODY_DETAIL,
  waitForRecoveryOperation,
  retryPendingBoundaryDetail,
  recoveryFetch,
  recoveryKind,
  isRetryableFetchBoundary,
  CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX,
  conductorMarkerMatchesTopic,
  refusesUnqualifiedBaseline,
  recoverThread,
  THREAD_STATES
}) {
  return {
    async recoverInbound(signal, reason, lifecycleEpoch = this.lifecycleEpoch, channelIds = null, recoveryDeadline = null) {
        if (signal?.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
        const deadline = recoveryDeadline ?? (Date.now() + this.recoveryTimeoutMs);
        let baseReason = String(reason || '');
        let previousReason;
        do {
          previousReason = baseReason;
          baseReason = baseReason.replace(/(?: full follow-up| boundary retry| follow-up)$/, '');
        } while (baseReason !== previousReason);
        const selectedChannels = channelIds ? new Set(channelIds) : null;
        let bindings = this.state.listBindings().filter(binding => binding.active &&
          (!selectedChannels || selectedChannels.has(binding.channelId)));
        const isBeforeBindingPriority = binding => {
          if (binding.provider !== 'codex' || !this.state.isOrdinaryBinding(binding)) return false;
          const watermark = this.state.getIntakeWatermark(binding.channelId);
          return isNativeProofBeforeBindingBoundary(watermark?.state, watermark?.detail);
        };
        const prioritized = [];
        const deferred = [];
        for (const binding of bindings) {
          if (isBeforeBindingPriority(binding)) prioritized.push(binding);
          else deferred.push(binding);
        }
        if (prioritized.length) bindings = prioritized.concat(deferred);
        const hasCoveredReadyWatermark = currentBoundary => currentBoundary?.state === READINESS.READY &&
          ((currentBoundary.last_seen_id === null && currentBoundary.recovered_through_id === null) ||
            (typeof currentBoundary.last_seen_id === 'string' && currentBoundary.last_seen_id.length > 0 &&
              typeof currentBoundary.recovered_through_id === 'string' && currentBoundary.recovered_through_id.length > 0 &&
              compareDiscordIds(currentBoundary.recovered_through_id, currentBoundary.last_seen_id) >= 0));
        const classifyReadiness = (currentBinding, currentBoundary) => {
          if (currentBoundary?.state === READINESS.READY &&
              (currentBinding?.readiness === READINESS.READY ||
                (currentBinding?.readiness === READINESS.RECOVERING && hasCoveredReadyWatermark(currentBoundary)))) return READINESS.READY;
          const retryableBoundary = isRetryableIntakeBoundary(currentBoundary) || isInterruptedRetryBoundary(currentBoundary);
          if (currentBinding?.readiness === READINESS.GAP) return READINESS.GAP;
          if (currentBinding?.readiness === READINESS.UNAVAILABLE) return READINESS.UNAVAILABLE;
          if (!retryableBoundary && currentBoundary?.state === READINESS.GAP) return READINESS.GAP;
          if (currentBoundary?.state === READINESS.UNAVAILABLE &&
              !retryableBoundary) return READINESS.UNAVAILABLE;
          if (currentBinding?.readiness === READINESS.PENDING || currentBoundary?.state === READINESS.PENDING || retryableBoundary) return READINESS.PENDING;
          if (currentBinding?.readiness === READINESS.RECOVERING && currentBoundary?.state === READINESS.READY &&
              currentBoundary.last_seen_id && (!currentBoundary.recovered_through_id ||
                compareDiscordIds(currentBoundary.last_seen_id, currentBoundary.recovered_through_id) > 0)) return READINESS.PENDING;
          if (currentBoundary?.state === READINESS.UNAVAILABLE) return READINESS.UNAVAILABLE;
          return null;
        };
        const isRetryableRecoveryBoundary = boundary => boundary &&
          (isRetryableIntakeBoundary(boundary) || isInterruptedRetryBoundary(boundary) ||
            isNativeProofRetryBoundary(boundary.state, boundary.detail));
        const scheduleRecoveryRetry = (channelId, retryDeadline) => {
          const nativeProofHeld = () => {
            const boundary = this.state.getIntakeWatermark(channelId);
            return isNativeProofRetryBoundary(boundary?.state, boundary?.detail);
          };
          if (this.stopping || this.recoveryRetryScheduledChannels.has(channelId) || nativeProofHeld()) return;
          this.recoveryRetryScheduledChannels.add(channelId);
          queueMicrotask(() => {
            this.recoveryRetryScheduledChannels.delete(channelId);
            if (this.stopping || !this.isCurrentLifecycle(lifecycleEpoch) || nativeProofHeld()) return;
            this.recoverTransport(reason, lifecycleEpoch, [channelId], retryDeadline).catch(error => {
              this.logger(`Discord intake boundary retry failed: ${error.message}`);
            });
          });
        };
        let failure = null;
        for (const binding of bindings) {
          if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
          if (Date.now() >= deadline) {
            const watermark = this.state.getIntakeWatermark(binding.channelId);
            const nativeProofHeld = isNativeProofRetryBoundary(watermark?.state, watermark?.detail);
            const genericRetry = isRetryableIntakeBoundary(watermark) || isInterruptedRetryBoundary(watermark);
            const beforeNativeProof = binding.provider === 'codex' && this.state.isOrdinaryBinding(binding) &&
              !genericRetry && ![READINESS.GAP, READINESS.UNAVAILABLE].includes(watermark?.state);
            if (nativeProofHeld || beforeNativeProof) {
              const detail = nativeProofHeld ? watermark.detail
                : nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.BEFORE_BINDING, deadline);
              const recorded = await this.recordBoundary(binding, null, READINESS.UNAVAILABLE, detail,
                watermark?.gap_from ?? watermark?.recovered_through_id, watermark?.gap_to ?? null,
                signal, deadline, watermark, binding.readiness);
              if (recorded?.watermark) failure ||= { ready: false, state: READINESS.UNAVAILABLE };
              else {
                const currentBinding = this.state.getBinding(binding.channelId);
                const currentBoundary = this.state.getIntakeWatermark(binding.channelId);
                const currentState = classifyReadiness(currentBinding, currentBoundary);
                failure ||= { ready: false, state: currentState || READINESS.UNAVAILABLE };
              }
              continue;
            }
            const currentState = classifyReadiness(binding, watermark);
            if (currentState === READINESS.READY) {
              // The shared deadline can expire before this route is visited. A
              // persisted READY marker does not prove this startup pass fetched its
              // channel and history, so give it the same fresh scoped retry as a
              // recovering route.
              if ([READINESS.READY, READINESS.RECOVERING].includes(binding.readiness)) {
                scheduleRecoveryRetry(binding.channelId, Date.now() + this.recoveryTimeoutMs);
              }
              continue;
            }
            if (isRetryableRecoveryBoundary(watermark) ||
                [READINESS.PENDING, READINESS.GAP, READINESS.UNAVAILABLE].includes(watermark?.state)) {
              if (currentState === READINESS.PENDING || isRetryableRecoveryBoundary(watermark)) {
                scheduleRecoveryRetry(binding.channelId, Date.now() + this.recoveryTimeoutMs);
                failure ||= { ready: false, state: watermark?.state || 'unavailable' };
              } else if (watermark && [READINESS.GAP, READINESS.UNAVAILABLE].includes(watermark.state)) {
                // F13: an expired deadline on an already-terminal watermark must restore
                // the RECOVERING binding's durable readiness through the existing
                // expected-boundary/readiness guard, preserving cursor/gap bounds and
                // detail. A newer READY/PENDING or changed binding must not be overwritten.
                const recorded = await this.recordBoundary(binding, null, watermark.state,
                  watermark.detail || `${reason} intake ${watermark.state}`, watermark.gap_from, watermark.gap_to,
                  signal, deadline, watermark, binding.readiness);
                if (recorded?.watermark) failure ||= { ready: false, state: watermark.state };
                else {
                  const currentBinding = this.state.getBinding(binding.channelId);
                  const currentBoundary = this.state.getIntakeWatermark(binding.channelId);
                  const restoredState = classifyReadiness(currentBinding, currentBoundary);
                  failure ||= { ready: false, state: restoredState || 'unavailable' };
                }
              } else {
                failure ||= { ready: false, state: watermark?.state || 'unavailable' };
              }
            } else {
              const classified = binding.provider === 'codex' && this.state.isOrdinaryBinding(binding)
                ? { state: READINESS.UNAVAILABLE, detail: nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.BEFORE_BINDING, deadline) }
                : classifyRecoveryFailure(recoveryError(CODEX_VALIDATION_KINDS.DEADLINE,
                  `${reason} recovery exceeded ${this.recoveryTimeoutMs}ms`));
              const recorded = await this.recordBoundary(binding, null, classified.state, classified.detail,
                watermark?.recovered_through_id, null, signal, deadline, watermark, binding.readiness);
              if (recorded?.watermark) failure ||= { ready: false, state: classified.state };
              else {
                const currentBinding = this.state.getBinding(binding.channelId);
                const currentBoundary = this.state.getIntakeWatermark(binding.channelId);
                const currentState = classifyReadiness(currentBinding, currentBoundary);
                failure ||= { ready: false, state: currentState || 'unavailable' };
              }
            }
            continue;
          }
          const handoffRecovery = this.state.recoverInterruptedOrdinaryHandoffIntake?.(binding.channelId, binding);
          if (handoffRecovery?.deferred) {
            this.scheduleDeferredHandoffRecovery(binding.channelId);
            continue;
          }
          const recovering = this.state.setBindingReadiness(binding.channelId, READINESS.RECOVERING, `${reason} intake recovery in progress`, binding);
          if (!recovering) {
            const currentBinding = this.state.getBinding(binding.channelId);
            const currentBoundary = this.state.getIntakeWatermark(binding.channelId);
            const currentState = classifyReadiness(currentBinding, currentBoundary);
            if (currentState === READINESS.READY) continue;
            if (currentState === READINESS.PENDING && !this.stopping) {
              this.recoverTransport(reason, lifecycleEpoch, [binding.channelId], deadline).catch(error => {
                this.logger(`Discord intake readiness retry failed: ${error.message}`);
              });
            }
            failure ||= { ready: false, state: currentState || 'unavailable' };
            continue;
          }
          let watermark = this.state.getIntakeWatermark(binding.channelId);
          let ownedBoundary = watermark;
          let ownedReadiness = recovering.readiness;
          // Capture the qualified coverage input from the owned snapshot before any
          // reconciliation write in this pass can replace the boundary detail. A cursor
          // qualifies only when it is a string of decimal digits ("0" included).
          const ownedCoverageCursor = watermark?.recovered_through_id;
          // A pass that starts from the closing-custody marker under the attempt that queued it is the one retry: it records
          // gap if custody is still ahead. A pass under another lifecycle or deadline gets its own retry.
          const closingCustodyAttempt = this.closingCustodyRetries.get(binding.channelId);
          const closingCustodyRetry = typeof watermark?.detail === 'string' && watermark.detail.endsWith(CLOSING_CUSTODY_DETAIL) &&
            closingCustodyAttempt?.lifecycleEpoch === lifecycleEpoch && closingCustodyAttempt.deadline === deadline;
          const currentRecovery = () => this.isCurrentBinding(binding) &&
            this.state.getBinding(binding.channelId)?.readiness === ownedReadiness;
          const classifyCurrentReadiness = () => {
            if (!this.isCurrentBinding(binding)) return null;
            const currentBinding = this.state.getBinding(binding.channelId);
            const currentBoundary = this.state.getIntakeWatermark(binding.channelId);
            const state = classifyReadiness(currentBinding, currentBoundary);
            return state ? { state, binding: currentBinding, watermark: currentBoundary } : null;
          };
          const adoptCurrentReadiness = () => {
            const current = classifyCurrentReadiness();
            if (!current) return null;
            if (current.state === READINESS.READY || current.state === READINESS.PENDING) {
              ownedReadiness = current.state;
              ownedBoundary = current.watermark;
              watermark = current.watermark;
            }
            return current;
          };
          const queueRecoveryIfPending = (retryDeadline = deadline) => {
            if (this.stopping) return;
            const current = classifyCurrentReadiness();
            if (current?.state !== READINESS.PENDING) return;
            scheduleRecoveryRetry(binding.channelId, retryDeadline);
          };
          const recordOwnedBoundary = async (owner, channel, nextState, detail, gapFrom, gapTo, signal, deadline, expectedBoundary) => {
            if (nextState === READINESS.GAP || nextState === READINESS.UNAVAILABLE) {
              if (!currentRecovery()) {
                const current = adoptCurrentReadiness();
                if (current?.state === READINESS.READY) return { watermark: current.watermark, concurrentReady: true };
                if (current?.state === READINESS.PENDING) queueRecoveryIfPending();
                return null;
              }
              const currentBoundary = this.state.getIntakeWatermark(binding.channelId);
              if (currentBoundary?.state === READINESS.GAP || currentBoundary?.state === READINESS.UNAVAILABLE) {
                // F13: a terminal watermark already owns the route. Route the refusal
                // through the existing guarded boundary writer with the ORIGINAL watermark
                // and expected RECOVERING readiness so the binding is restored to the
                // durable terminal state, not left RECOVERING. The newer watermark and a
                // changed binding/readiness are fenced by markIntakeBoundary.
                const restored = await this.recordBoundary(owner, channel, currentBoundary.state,
                  currentBoundary.detail || detail, currentBoundary.gap_from, currentBoundary.gap_to,
                  signal, deadline, currentBoundary, ownedReadiness);
                if (restored?.watermark) ownedReadiness = restored.watermark.state;
                if (!restored) {
                  const current = adoptCurrentReadiness();
                  if (current?.state === READINESS.READY) return { watermark: current.watermark, concurrentReady: true };
                  if (current?.state === READINESS.PENDING) queueRecoveryIfPending();
                }
                return restored;
              }
              if (currentBoundary) {
                expectedBoundary = currentBoundary;
                gapFrom = currentBoundary.recovered_through_id;
              }
            }
            const result = await this.recordBoundary(owner, channel, nextState, detail, gapFrom, gapTo, signal, deadline, expectedBoundary, ownedReadiness);
            if (result?.watermark) ownedReadiness = result.watermark.state;
            if (result && !currentRecovery()) queueRecoveryIfPending();
            if (!result) {
              const current = adoptCurrentReadiness();
              if (current?.state === READINESS.READY) return { watermark: current.watermark, concurrentReady: true };
              queueRecoveryIfPending();
            }
            return result;
          };
          let retryBoundary = null;
          if (isRetryableRecoveryBoundary(watermark)) {
            retryBoundary = watermark;
          }
          let nativeProofRetryDetail = retryBoundary && isNativeProofRetryBoundary(retryBoundary.state, retryBoundary.detail)
            ? retryBoundary.detail : null;
          if (watermark && ['gap', 'unavailable'].includes(watermark.state) && !retryBoundary) {
            // F13: route the pre-fetch terminal refusal through recordBoundary with the
            // original watermark and expected RECOVERING readiness so the binding is
            // restored to the durable terminal state without a raw readiness write. A
            // newer READY/PENDING or changed binding/lifecycle/generation is not overwritten.
            const recorded = await this.recordBoundary(binding, null, watermark.state,
              watermark.detail || `${reason} intake ${watermark.state}`, watermark.gap_from, watermark.gap_to,
              signal, deadline, watermark, ownedReadiness);
            if (recorded?.watermark) ownedBoundary = recorded.watermark;
            else {
              const current = adoptCurrentReadiness();
              if (current?.state === READINESS.READY) continue;
              if (current?.state === READINESS.PENDING) queueRecoveryIfPending();
            }
            failure ||= { ready: false, state: watermark.state };
            continue;
          }
          let channel;
          let recoveryAttempted = false;
          try {
            channel = await waitForRecoveryOperation(() => {
              if (retryBoundary) {
                const beforeBindingRetry = isNativeProofBeforeBindingBoundary(retryBoundary.state, retryBoundary.detail);
                const nativeProofRetry = isNativeProofRetryBoundary(retryBoundary.state, retryBoundary.detail);
                let retryDetail;
                if (beforeBindingRetry) retryDetail = nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.PREFLIGHT, deadline);
                else if (nativeProofRetry) retryDetail = retryBoundary.detail;
                else retryDetail = retryPendingBoundaryDetail(reason, retryBoundary);
                if (nativeProofRetry) nativeProofRetryDetail = retryDetail;
                const retrying = this.state.markIntakeBoundary(binding.channelId, 'pending', retryDetail,
                  retryBoundary.gap_from, retryBoundary.gap_to, binding, null, retryBoundary, ownedReadiness);
                if (!retrying) throw recoveryError('stale', 'Discord intake boundary changed before channel recovery');
                watermark = retrying;
                ownedBoundary = retrying;
                ownedReadiness = retrying.state;
                retryBoundary = null;
              }
              recoveryAttempted = true;
              return recoveryFetch(() => this.client.channels.fetch(binding.channelId));
            }, signal, deadline);
            if (!channel) throw new Error('Discord channel is unavailable');
          } catch (error) {
            const kind = recoveryKind(error);
            if (kind === CODEX_VALIDATION_KINDS.STOPPED) return { ready: false, state: 'stopped' };
            if (kind === CODEX_VALIDATION_KINDS.DEADLINE && retryBoundary && !recoveryAttempted) {
              const restored = this.state.markIntakeBoundary(binding.channelId, retryBoundary.state,
                retryBoundary.detail || `${reason} retry deadline expired`, retryBoundary.gap_from,
                retryBoundary.gap_to, binding, null, retryBoundary, ownedReadiness);
              if (restored) {
                scheduleRecoveryRetry(binding.channelId, Date.now() + this.recoveryTimeoutMs);
                failure ||= { ready: false, state: 'unavailable' };
              }
              else {
                const current = adoptCurrentReadiness();
                if (current?.state === READINESS.READY) continue;
                if (current?.state === READINESS.PENDING) {
                  scheduleRecoveryRetry(binding.channelId, Date.now() + this.recoveryTimeoutMs);
                }
                failure ||= { ready: false, state: current?.state || 'unavailable' };
              }
              continue;
            }
            if (kind === 'stale') {
              const current = adoptCurrentReadiness();
              if (current?.state === READINESS.READY) continue;
              if (current?.state === READINESS.PENDING) {
                retryBoundary = current.watermark;
                queueRecoveryIfPending();
              }
              failure ||= { ready: false, state: current?.state || 'unavailable', error };
              continue;
            }
            const transientChannelLookup = isRetryableFetchBoundary(READINESS.UNAVAILABLE, error?.message);
            const nativeProofRetry = typeof nativeProofRetryDetail === 'string' &&
              (!recoveryAttempted || transientChannelLookup);
            const classified = classifyRecoveryFailure(error);
            const retryState = nativeProofRetry ? READINESS.UNAVAILABLE : classified.state;
            const retryDetail = nativeProofRetry ? nativeProofRetryDetail : classified.detail;
            const recorded = await recordOwnedBoundary(binding, null, retryState, retryDetail,
              ownedBoundary?.recovered_through_id, null, signal, deadline, ownedBoundary);
            if (recorded?.watermark) ownedBoundary = recorded.watermark;
            if (!recorded?.concurrentReady) failure ||= { ready: false, state: retryState, error };
            continue;
          }
          if (!currentRecovery()) {
            const current = adoptCurrentReadiness();
            if (current?.state === READINESS.READY) continue;
            if (current?.state === READINESS.PENDING) queueRecoveryIfPending();
            failure ||= { ready: false, state: current?.state || 'unavailable' };
            continue;
          }
          const ordinary = this.state.isOrdinaryBinding?.(binding);
          if (ordinary && channel.guildId && channel.guildId !== binding.guildId) {
            const error = new Error('Discord channel is outside the configured guild');
            const recorded = await recordOwnedBoundary(binding, channel, 'unavailable', error.message, ownedBoundary?.recovered_through_id, null, signal, deadline, ownedBoundary);
            if (recorded?.watermark) ownedBoundary = recorded.watermark;
            if (!recorded?.concurrentReady) failure ||= { ready: false, state: 'unavailable', error };
            continue;
          }
          if (ordinary) {
            const preflightController = new AbortController();
            const relayAbort = () => preflightController.abort();
            signal?.addEventListener('abort', relayAbort, { once: true });
            try {
              await waitForRecoveryOperation(
                () => this.verifyOrdinaryNative(binding, { signal: preflightController.signal, deadline }),
                signal,
                deadline,
                () => preflightController.abort()
              );
            } catch (error) {
              const kind = recoveryKind(error);
              if (kind === CODEX_VALIDATION_KINDS.STOPPED) return { ready: false, state: 'stopped' };
              if (kind === 'stale') {
                const current = adoptCurrentReadiness();
                if (current?.state === READINESS.READY) continue;
                if (current?.state === READINESS.PENDING) queueRecoveryIfPending();
                failure ||= { ready: false, state: current?.state || 'unavailable', error };
                continue;
              }
              const preflightReason = ['Claude endpoint unavailable', 'ordinary-bind', 'reconnect', 'startup'].includes(baseReason);
              const classified = classifyRecoveryFailure(error);
              let detail = classified.detail;
              if (kind !== CODEX_VALIDATION_KINDS.DEADLINE && preflightReason && binding.provider === 'claude') {
                detail = `${CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX} ${error.message}`;
              } else if (kind !== CODEX_VALIDATION_KINDS.DEADLINE && preflightReason && binding.provider === 'codex') {
                detail = `Codex transcript proof unavailable before event write: ${error.message}`;
              }
              const nativeDeadline = binding.provider === 'codex' && kind === CODEX_VALIDATION_KINDS.DEADLINE;
              if (nativeDeadline) detail = nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.PREFLIGHT, deadline);
              const heldState = nativeDeadline ? READINESS.UNAVAILABLE : classified.state;
              const recorded = await recordOwnedBoundary(binding, channel, heldState, detail, ownedBoundary?.recovered_through_id, null, signal, deadline, ownedBoundary);
              if (recorded?.watermark) ownedBoundary = recorded.watermark;
              if (!recorded?.concurrentReady) failure ||= { ready: false, state: heldState, error };
              continue;
            } finally {
              signal?.removeEventListener('abort', relayAbort);
              preflightController.abort();
            }
          }
          if (!ordinary && !conductorMarkerMatchesTopic(channel.topic, binding)) {
            const error = new Error('Discord channel topic does not identify the current conductor and native generation');
            const recorded = await recordOwnedBoundary(binding, channel, 'unavailable', error.message, ownedBoundary?.recovered_through_id, null, signal, deadline, ownedBoundary);
            if (recorded?.watermark) ownedBoundary = recorded.watermark;
            if (!recorded?.concurrentReady) failure ||= { ready: false, state: 'unavailable', error };
            continue;
          }
          if (!this.fetchHistoryInjected && typeof channel.messages?.fetch !== 'function') {
            const error = new Error('Discord history fetch is unavailable for intake recovery');
            const recorded = await recordOwnedBoundary(binding, channel, 'unavailable', error.message, ownedBoundary?.recovered_through_id, null, signal, deadline, ownedBoundary);
            if (recorded?.watermark) ownedBoundary = recorded.watermark;
            if (!recorded?.concurrentReady) failure ||= { ready: false, state: 'unavailable', error };
            continue;
          }
          const permission = this.historyPermission(channel, { requireSend: ordinary });
          if (!permission.known || !permission.allowed) {
            let detail = 'Discord channel history permission is unknown';
            if (permission.known && ordinary) detail = 'Discord channel lacks history or reply permission';
            else if (permission.known) detail = 'Discord channel lacks ViewChannel or ReadMessageHistory';
            const error = new Error(detail);
            const recorded = await recordOwnedBoundary(binding, channel, 'unavailable', error.message, ownedBoundary?.recovered_through_id, null, signal, deadline, ownedBoundary);
            if (recorded?.watermark) ownedBoundary = recorded.watermark;
            if (!recorded?.concurrentReady) failure ||= { ready: false, state: 'unavailable', error };
            continue;
          }
          let qualifiedEmptyBaseline = false;
          if (watermark?.state === READINESS.READY && !watermark.last_seen_id && !watermark.recovered_through_id) {
            // An upgraded empty READY watermark is verified empty coverage, not an
            // unknown baseline. Qualify it without replaying historical messages.
            const migrated = this.state.setIntakeBaseline(
              binding.channelId,
              '0',
              `${reason} verified empty history baseline`,
              binding,
              watermark
            );
            if (!migrated) {
              const current = adoptCurrentReadiness();
              if (current?.state === READINESS.READY) continue;
              if (current?.state === READINESS.PENDING) queueRecoveryIfPending();
              failure ||= { ready: false, state: current?.state || READINESS.PENDING };
              continue;
            }
            ownedBoundary = migrated;
            watermark = migrated;
            qualifiedEmptyBaseline = true;
            const recorded = await recordOwnedBoundary(
              binding,
              channel,
              READINESS.PENDING,
              `${reason} verified empty history baseline`,
              null,
              null,
              signal,
              deadline,
              migrated
            );
            if (!recorded?.watermark || recorded.stale || recorded.blocked || (!recorded.concurrentReady && !currentRecovery())) {
              failure ||= { ready: false, state: READINESS.PENDING };
              continue;
            }
          }
          // A genuinely new parent route may only install its history boundary from a
          // permission-qualified covered cursor on the owned snapshot. A null/unknown
          // historical parent refuses visibly HERE, before any history request: no
          // cutoff is ever inferred from newest history, last_seen_id, channel id,
          // channel creation time, wall clock, or a later retry.
          if (!qualifiedEmptyBaseline && refusesUnqualifiedBaseline({ coveredCursor: ownedCoverageCursor })) {
            const refusalDetail = watermark
              ? retryPendingBoundaryDetail(`${reason} baseline refused without historical coverage`, watermark)
              : `${reason} history boundary requires qualified historical coverage`;
            const refused = await recordOwnedBoundary(binding, channel, READINESS.PENDING,
              refusalDetail, ownedBoundary?.recovered_through_id, null, signal, deadline, ownedBoundary);
            if (refused?.watermark) ownedBoundary = refused.watermark;
            if (!refused?.concurrentReady) failure ||= { ready: false, state: READINESS.PENDING };
            continue;
          }
          watermark = this.state.getIntakeWatermark(binding.channelId);
          let after = watermark?.recovered_through_id || null;
          let pages = 0;
          let total = 0;
          let complete = false;
          let attemptedId = null;
          try {
            while (pages < this.historyMaxPages && total < this.historyMaxMessages && Date.now() < deadline) {
              if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
              const options = { limit: this.historyPageLimit, signal };
              if (after) options.after = after;
              const page = this.historyMessages(await waitForRecoveryOperation(() => recoveryFetch(() => this.fetchHistory(channel, options)), signal, deadline));
              if (!currentRecovery()) throw recoveryError('stale', 'Discord recovery binding changed during history fetch');
              const fetchedBoundary = this.state.getIntakeWatermark(binding.channelId);
              if (fetchedBoundary?.state === READINESS.GAP || fetchedBoundary?.state === READINESS.UNAVAILABLE) {
                throw recoveryError('stale', 'Discord intake boundary changed during history fetch');
              }
              if (fetchedBoundary) ownedBoundary = fetchedBoundary;
              pages += 1;
              if (!page.length) { complete = true; break; }
              if (page.some(message => typeof message?.id !== 'string' || !message.id)) throw new Error('Discord history message has no stable ID');
              page.sort((a, b) => compareDiscordIds(a.id, b.id));
              const fresh = after ? page.filter(message => compareDiscordIds(message.id, after) > 0) : page;
              if (!fresh.length) { complete = true; break; }
              for (const message of fresh) {
                if (total >= this.historyMaxMessages) break;
                if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
                if (Date.now() >= deadline) throw recoveryError(CODEX_VALIDATION_KINDS.DEADLINE, 'Discord recovery deadline exceeded while admitting history');
                attemptedId = message.id;
                const admitted = await this.consumer.intakeMessage(this.normalizeFetchedMessage(message, channel), false, message.id, binding, false, signal, deadline, true);
                if (admitted?.stale) throw recoveryError('stale', 'Discord recovery binding changed during history intake');
                if (!currentRecovery()) throw recoveryError('stale', 'Discord recovery binding changed during history intake');
                const afterIntake = this.state.getIntakeWatermark(binding.channelId);
                if (afterIntake?.state === READINESS.GAP || afterIntake?.state === READINESS.UNAVAILABLE) {
                  throw recoveryError('stale', 'Discord intake boundary changed during history intake');
                }
                if (afterIntake) ownedBoundary = afterIntake;
                total += 1;
                if (!after || compareDiscordIds(message.id, after) > 0) after = message.id;
              }
              if (total >= this.historyMaxMessages) break;
              if (fresh.length < page.length && page.length === this.historyPageLimit) {
                throw new Error('Discord history page overlapped the cursor without complete coverage');
              }
              if (page.length < this.historyPageLimit) { complete = true; break; }
            }
          } catch (error) {
            const kind = recoveryKind(error);
            if (kind === CODEX_VALIDATION_KINDS.STOPPED) return { ready: false, state: 'stopped' };
            if (kind === 'stale') {
              const current = adoptCurrentReadiness();
              if (current?.state === READINESS.READY) continue;
              if (current?.state === READINESS.PENDING) queueRecoveryIfPending();
              failure ||= { ready: false, state: current?.state || 'unavailable', error };
              continue;
            }
            const classified = classifyRecoveryFailure(error);
            const recorded = await recordOwnedBoundary(binding, channel, classified.state, classified.detail, ownedBoundary?.recovered_through_id, attemptedId || after, signal, deadline, ownedBoundary);
            if (recorded?.watermark) ownedBoundary = recorded.watermark;
            if (!recorded?.concurrentReady) failure ||= { ready: false, state: classified.state, error };
            continue;
          }
          if (!complete) {
            const pageBoundReached = pages >= this.historyMaxPages;
            const messageBoundReached = total >= this.historyMaxMessages;
            const classified = pageBoundReached || messageBoundReached
              ? { state: READINESS.GAP, detail: pageBoundReached
                ? `history page bound ${this.historyMaxPages} reached`
                : `history message bound ${this.historyMaxMessages} reached` }
              : classifyRecoveryFailure(recoveryError(CODEX_VALIDATION_KINDS.DEADLINE,
                `history recovery deadline ${this.recoveryTimeoutMs}ms reached`));
            const recorded = await recordOwnedBoundary(binding, channel, classified.state, classified.detail, ownedBoundary?.recovered_through_id, after, signal, deadline, ownedBoundary);
            if (recorded?.watermark) ownedBoundary = recorded.watermark;
            if (!recorded?.concurrentReady) failure ||= { ready: false, state: classified.state };
            continue;
          }
          const boundary = await recordOwnedBoundary(binding, channel, 'ready', `${reason} watermark backfill complete`, null, null, signal, deadline, ownedBoundary);
          if (!boundary || boundary.stale || boundary.blocked || (!boundary.concurrentReady && !currentRecovery())) {
            failure ||= { ready: false, state: 'unavailable' };
            continue;
          }
          const finalWatermark = this.state.getIntakeWatermark(binding.channelId);
          const finalBinding = this.state.getBinding(binding.channelId);
          const liveCustodyAhead = finalWatermark?.last_seen_id && (!finalWatermark.recovered_through_id || compareDiscordIds(finalWatermark.last_seen_id, finalWatermark.recovered_through_id) > 0);
          if (liveCustodyAhead && !closingCustodyRetry) {
            // Custody accepted during the close still needs one bounded history reread.
            const retryDeadline = Date.now() + this.recoveryTimeoutMs;
            this.closingCustodyRetries.set(binding.channelId, { lifecycleEpoch, deadline: retryDeadline });
            const retrying = await recordOwnedBoundary(binding, channel, READINESS.PENDING, `${reason} ${CLOSING_CUSTODY_DETAIL}`,
              null, null, signal, deadline, finalWatermark);
            queueRecoveryIfPending(retryDeadline);
            if (!retrying?.concurrentReady) failure ||= { ready: false, state: classifyCurrentReadiness()?.state || READINESS.PENDING };
          } else if (liveCustodyAhead || (finalBinding?.readiness !== READINESS.READY && finalBinding?.readiness !== READINESS.UNAVAILABLE)) {
            const detail = liveCustodyAhead
              ? CLOSING_CUSTODY_DETAIL
              : 'binding readiness changed while recovery readiness was closing';
            const recorded = await recordOwnedBoundary(binding, channel, 'gap', detail, finalWatermark?.recovered_through_id, finalWatermark?.last_seen_id, signal, deadline, finalWatermark);
            if (!recorded?.concurrentReady) failure ||= { ready: false, state: 'gap' };
          }
        }
        for (const enrollment of this.state.listThreadEnrollments()) {
          if (!enrollment.active || (selectedChannels && !selectedChannels.has(enrollment.parentChannelId) && !selectedChannels.has(enrollment.threadId))) continue;
          const recovered = await recoverThread(this, enrollment, signal, lifecycleEpoch, waitForRecoveryOperation, false, deadline);
          const currentEnrollment = this.state.getThreadEnrollment(enrollment.threadId);
          if (!recovered) {
            if (currentEnrollment?.active && [THREAD_STATES.GAP, THREAD_STATES.UNAVAILABLE].includes(currentEnrollment.state)) {
              failure ||= { ready: false, state: currentEnrollment.state };
            } else if (currentEnrollment?.active && currentEnrollment.state === THREAD_STATES.PENDING && !this.isPreAdoptionRetryableThread(enrollment.threadId)) {
              const currentCount = this.liveIntakeCounts.get(enrollment.threadId) || 0;
              this.liveIntakeCounts.set(enrollment.threadId, Math.max(currentCount, this.liveCheckpointThreshold));
            }
          }
        }
        return failure || { ready: true, state: 'ready' };
      }
  };
}

module.exports = { createInboundRecoveryHandlers };
