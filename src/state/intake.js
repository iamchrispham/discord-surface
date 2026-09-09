const crypto = require('node:crypto');

function pauseOrdinaryHandoffIntake(state, channelId, expectedBinding, pendingState, detail) {
  const binding = state.getBinding(channelId);
  const watermark = state.getIntakeWatermark(channelId);
  const snapshot = {
    state: watermark?.state || (binding?.readiness === 'ready' ? 'ready' : 'pending'),
    detail: watermark?.detail || null,
    gapFrom: watermark?.gap_from || null,
    gapTo: watermark?.gap_to || null,
    expectedBinding: expectedBinding || binding || null,
    ownerPid: process.pid,
    ownerIdentity: state.directPostOwnerIdentity?.(process.pid) || null,
    ownerToken: crypto.randomUUID()
  };
  state.ordinaryHandoffPauseSnapshots?.set(channelId, snapshot);
  state.ordinaryHandoffPauses.add(channelId);
  try {
    const result = state.markIntakeBoundary(channelId, pendingState, detail, null, null, expectedBinding, {
      channelId,
      ownerPid: snapshot.ownerPid,
      ownerIdentity: snapshot.ownerIdentity,
      ownerToken: snapshot.ownerToken,
      pauseState: pendingState,
      pauseDetail: String(detail || '').slice(0, 1000) || null,
      snapshot: {
        state: snapshot.state,
        detail: snapshot.detail,
        gapFrom: snapshot.gapFrom,
        gapTo: snapshot.gapTo,
        readiness: null
      },
      expectedBinding: snapshot.expectedBinding
    });
    if (!result) {
      state.ordinaryHandoffPauses.delete(channelId);
      state.ordinaryHandoffPauseSnapshots?.delete(channelId);
    } else {
      snapshot.pausedReadiness = state.getBinding(channelId)?.readiness;
    }
    return result;
  } catch (error) {
    state.ordinaryHandoffPauses.delete(channelId);
    state.ordinaryHandoffPauseSnapshots?.delete(channelId);
    throw error;
  }
}

function restoreOrdinaryHandoffIntake(state, channelId, expectedBinding) {
  const snapshot = state.ordinaryHandoffPauseSnapshots?.get(channelId);
  let result = null;
  if (snapshot) {
    const pauseMetadata = { ownerToken: snapshot.ownerToken };
    result = state.markIntakeBoundary(channelId, snapshot.state, snapshot.detail, snapshot.gapFrom, snapshot.gapTo,
      expectedBinding || snapshot.expectedBinding || null, pauseMetadata);
  }
  if (!snapshot || result) {
    state.ordinaryHandoffPauses.delete(channelId);
    state.ordinaryHandoffPauseSnapshots?.delete(channelId);
  }
  return result;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function pauseOwnerAlive(state, pause) {
  if (!processAlive(pause.ownerPid)) return false;
  if (!pause.ownerIdentity || typeof state.directPostOwnerIdentity !== 'function') return true;
  const actualIdentity = state.directPostOwnerIdentity(pause.ownerPid);
  if (!actualIdentity) return true;
  if (pause.ownerIdentity.ownerStartTime && actualIdentity.ownerStartTime !== pause.ownerIdentity.ownerStartTime) return false;
  if (pause.ownerIdentity.ownerCommand && actualIdentity.ownerCommand !== pause.ownerIdentity.ownerCommand) return false;
  return true;
}

function persistedHandoffPause(state, channelId) {
  const watermark = state.getIntakeWatermark(channelId);
  if (!watermark) return null;
  const row = state.db.prepare("SELECT detail FROM receipts WHERE kind='ordinary-handoff-intake-paused' AND json_extract(detail, '$.channelId')=? ORDER BY id DESC LIMIT 1").get(channelId);
  if (!row) return null;
  let pause;
  try { pause = JSON.parse(row.detail); } catch { return null; }
  if (!pause || typeof pause !== 'object') return null;
  if (pause.pauseState !== watermark.state || pause.pauseDetail !== watermark.detail) return null;
  return pause;
}

function intakePauseAllowsUpdate(state, channelId, pauseMetadata = null) {
  if (state.ordinaryHandoffPauses?.has(channelId)) {
    const snapshot = state.ordinaryHandoffPauseSnapshots?.get(channelId);
    return Boolean(snapshot && pauseMetadata?.ownerToken && pauseMetadata.ownerToken === snapshot.ownerToken);
  }
  const pause = persistedHandoffPause(state, channelId);
  if (!pause) return true;
  return Boolean(pauseMetadata?.ownerToken && pauseMetadata.ownerToken === pause.ownerToken);
}

function recoverInterruptedOrdinaryHandoffIntake(state, channelId, expectedBinding, readyState, handoffDetail) {
  if (state.ordinaryHandoffPauses?.has(channelId)) return null;
  const watermark = state.getIntakeWatermark(channelId);
  if (!watermark || watermark.detail !== handoffDetail) return null;
  const row = state.db.prepare("SELECT detail FROM receipts WHERE kind='ordinary-handoff-intake-paused' AND json_extract(detail, '$.channelId')=? ORDER BY id DESC LIMIT 1").get(channelId);
  if (!row) return null;
  let pause;
  try { pause = JSON.parse(row.detail); } catch { return null; }
  if (pauseOwnerAlive(state, pause)) return null;
  const snapshot = pause.snapshot;
  if (!snapshot || typeof snapshot.state !== 'string') return null;
  const pauseMetadata = { ownerToken: pause.ownerToken };
  const restored = state.markIntakeBoundary(channelId, snapshot.state || readyState, snapshot.detail || null,
    snapshot.gapFrom || null, snapshot.gapTo || null, expectedBinding || pause.expectedBinding || null,
    pauseMetadata);
  if (!restored) return null;
  state.receipt(null, 'ordinary-handoff-intake-recovered', {
    channelId,
    ownerPid: pause.ownerPid,
    ownerIdentity: pause.ownerIdentity,
    ownerToken: pause.ownerToken,
    state: restored.state
  });
  return restored;
}

function intakeCutoffDecision(eventId, cutoffId, compare) {
  if (cutoffId === null) return null;
  if (!/^\d+$/.test(eventId) || !/^\d+$/.test(cutoffId)) return 'incomparable-intake-cutoff';
  return compare(eventId, cutoffId) <= 0 ? 'before-intake-cutoff' : null;
}

function createIntakeHandlers({ BindingError, READINESS, assertText, bindingMatchesExpected, compareDiscordIds, now }) {
  return {
    hasIntakeEvidence(state, discordId) {
      assertText(discordId, 'discordId', 128);
      const row = state.db.prepare(`SELECT 1 FROM messages WHERE discord_id=?
        UNION ALL SELECT 1 FROM receipts WHERE kind='intake-rejected'
          AND json_extract(detail, '$.discordId')=?
          AND json_extract(detail, '$.reason') IN ('bot-source', 'automatic-publication', 'unauthorized-sender', 'invalid-event')
        LIMIT 1`).get(discordId, discordId);
      return Boolean(row);
    },

    checkpointIntake(state, channelId, coverageId, expectedBinding = null) {
      assertText(channelId, 'channelId', 128);
      assertText(coverageId, 'coverageId', 128);
      return state.transaction(() => {
        const binding = state.getBinding(channelId);
        if (!binding || !binding.active) throw new BindingError('intake channel is not active');
        if (!bindingMatchesExpected(binding, expectedBinding)) return null;
        const existing = state.getIntakeWatermark(channelId);
        if (!existing) throw new BindingError('intake watermark is unknown');
        if (existing.last_seen_id && compareDiscordIds(existing.last_seen_id, coverageId) < 0) {
          return existing;
        }
        const recoveredThrough = existing.recovered_through_id && compareDiscordIds(existing.recovered_through_id, coverageId) >= 0
          ? existing.recovered_through_id
          : coverageId;
        state.db.prepare('UPDATE intake_watermarks SET recovered_through_id=?, updated_at=? WHERE channel_id=?')
          .run(recoveredThrough, now(), channelId);
        state.receipt(null, 'intake-checkpoint', { channelId, coverageId: recoveredThrough });
        return state.getIntakeWatermark(channelId);
      });
    },

    setIntakeCutoff(state, channelId, guildId, lastSeenId, detail, expectedBinding = undefined) {
      assertText(channelId, 'channelId', 128);
      assertText(guildId, 'guildId', 128);
      assertText(lastSeenId, 'lastSeenId', 128);
      return state.transaction(() => this.setIntakeCutoffInTransaction(state, channelId, guildId, lastSeenId, detail, expectedBinding));
    },

    setIntakeCutoffInTransaction(state, channelId, guildId, lastSeenId, detail, expectedBinding = undefined) {
      const binding = state.getBinding(channelId);
      if (expectedBinding !== undefined && (expectedBinding === null
        ? binding !== null
        : !bindingMatchesExpected(binding, expectedBinding))) return null;
      const existing = state.getIntakeWatermark(channelId);
      const knownGuildId = existing?.guild_id || binding?.guildId;
      if (knownGuildId && knownGuildId !== guildId) throw new BindingError('intake channel belongs to another guild');
      const retainedLastSeen = existing?.last_seen_id && compareDiscordIds(existing.last_seen_id, lastSeenId) > 0
        ? existing.last_seen_id
        : lastSeenId;
      const retainedRecoveredThrough = existing?.recovered_through_id && compareDiscordIds(existing.recovered_through_id, lastSeenId) > 0
        ? existing.recovered_through_id
        : lastSeenId;
      const cutoffDetail = String(detail || '').slice(0, 1000) || null;
      if (existing) {
        state.db.prepare('UPDATE intake_watermarks SET guild_id=?, last_seen_id=?, recovered_through_id=?, state=?, detail=?, gap_from=NULL, gap_to=NULL, updated_at=? WHERE channel_id=?')
          .run(guildId, retainedLastSeen, retainedRecoveredThrough, 'pending', cutoffDetail, now(), channelId);
      } else {
        state.db.prepare('INSERT INTO intake_watermarks(channel_id, guild_id, last_seen_id, recovered_through_id, state, detail, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
          .run(channelId, guildId, retainedLastSeen, retainedRecoveredThrough, 'pending', cutoffDetail, now());
      }
      state.receipt(null, 'intake-baseline', { channelId, lastSeenId: retainedLastSeen, detail: cutoffDetail });
      return state.getIntakeWatermark(channelId);
    },

    markIntakeBoundary(state, channelId, boundaryState, detail = null, gapFrom = null, gapTo = null, expectedBinding = null, pauseMetadata = null) {
      assertText(channelId, 'channelId', 128);
      if (!['pending', 'ready', 'gap', 'unavailable'].includes(boundaryState)) throw new BindingError('invalid intake watermark state');
      return state.transaction(() => {
        const binding = state.getBinding(channelId);
        const existing = state.getIntakeWatermark(channelId);
        if (!bindingMatchesExpected(binding, expectedBinding)) return null;
        if (!intakePauseAllowsUpdate(state, channelId, pauseMetadata)) return null;
        if (pauseMetadata && Object.prototype.hasOwnProperty.call(pauseMetadata, 'expectedReadiness')
          && binding?.readiness !== pauseMetadata.expectedReadiness) return null;
        if (!existing && !binding) throw new BindingError('intake channel is unknown');
        if (boundaryState === 'ready' && state.isOrdinaryBinding(binding) && !state.hasOrdinaryPreflight(binding)) {
          throw new BindingError('ordinary Codex native preflight is required before READY');
        }
        if (boundaryState === 'ready') state.assertLegacyMigrationSafe(channelId);
        const guildId = existing?.guild_id || binding.guildId;
        if (existing) {
          state.db.prepare('UPDATE intake_watermarks SET state=?, detail=?, gap_from=?, gap_to=?, updated_at=? WHERE channel_id=?')
            .run(boundaryState, detail ? String(detail).slice(0, 1000) : null, gapFrom, gapTo, now(), channelId);
        } else {
          state.db.prepare('INSERT INTO intake_watermarks(channel_id, guild_id, state, detail, gap_from, gap_to, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
            .run(channelId, guildId, boundaryState, detail ? String(detail).slice(0, 1000) : null, gapFrom, gapTo, now());
        }
        if (binding) {
          const readiness = boundaryState === 'ready' ? READINESS.READY : boundaryState === 'gap' ? READINESS.GAP : boundaryState === 'unavailable' ? READINESS.UNAVAILABLE : READINESS.PENDING;
          if (pauseMetadata?.snapshot && typeof pauseMetadata.snapshot === 'object') {
            pauseMetadata.snapshot.readiness = readiness;
          }
          state.db.prepare('UPDATE bindings SET readiness=?, updated_at=? WHERE channel_id=?').run(readiness, now(), channelId);
        }
        state.receipt(null, 'intake-boundary', { channelId, state: boundaryState, detail: detail || undefined, gapFrom: gapFrom || undefined, gapTo: gapTo || undefined });
        if (pauseMetadata) state.receipt(null, 'ordinary-handoff-intake-paused', pauseMetadata);
        return state.getIntakeWatermark(channelId);
      });
    },

    reconcileIntake(state, channelId, expectedBinding = null) {
      assertText(channelId, 'channelId', 128);
      return state.transaction(() => {
        if (!intakePauseAllowsUpdate(state, channelId)) return null;
        const binding = state.getBinding(channelId);
        const watermark = state.getIntakeWatermark(channelId);
        if (!binding || !binding.active || !watermark) throw new BindingError('intake boundary is unknown');
        if (!bindingMatchesExpected(binding, expectedBinding)) return null;
        state.db.prepare("UPDATE intake_watermarks SET state='pending', detail=?, gap_from=NULL, gap_to=NULL, updated_at=? WHERE channel_id=?")
          .run('explicit intake reconciliation requested', now(), channelId);
        state.db.prepare('UPDATE bindings SET readiness=?, updated_at=? WHERE channel_id=?').run(READINESS.PENDING, now(), channelId);
        state.receipt(null, 'intake-reconcile-requested', { channelId, conductorId: binding.conductorId });
        return state.getIntakeWatermark(channelId);
      });
    }
  };
}

module.exports = {
  createIntakeHandlers,
  intakeCutoffDecision,
  pauseOrdinaryHandoffIntake,
  restoreOrdinaryHandoffIntake,
  recoverInterruptedOrdinaryHandoffIntake
};
