const path = require('node:path');

function hasOrdinaryBindingReceipt({ db }, binding) {
  return Boolean(db.prepare(`SELECT 1 FROM receipts
    WHERE kind='ordinary-bound'
      AND json_extract(detail, '$.channelId')=?
      AND json_extract(detail, '$.nativeId')=?
      AND json_extract(detail, '$.workspace')=?
      AND json_extract(detail, '$.generation')=?
    LIMIT 1`).get(binding.channelId, binding.nativeId, binding.workspace, binding.generation));
}

function hasOrdinaryPreflightReceipt({ db }, binding) {
  return Boolean(db.prepare(`SELECT 1 FROM receipts
    WHERE kind='ordinary-native-preflight'
      AND json_extract(detail, '$.channelId')=?
      AND json_extract(detail, '$.nativeId')=?
      AND json_extract(detail, '$.workspace')=?
      AND json_extract(detail, '$.generation')=?
      AND json_extract(detail, '$.sessionRoot') IS ?
      AND json_extract(detail, '$.outcome')='verified'
    LIMIT 1`).get(binding.channelId, binding.nativeId, binding.workspace, binding.generation, binding.sessionRoot || null));
}

function createOrdinaryBindingHandlers({
  BindingError,
  StaleGenerationError,
  MESSAGE_STATES,
  PROVIDERS,
  READINESS,
  UnresolvedWorkError,
  assertText,
  assertUuid,
  bindingMatchesExpected,
  now
}) {
  return {
    bindOrdinary(state, binding, identity, adoptionCutoff = null) {
      if (binding.conductorId != null || binding.repoKey != null) throw new BindingError('ordinary bindings cannot carry conductor identity');
      if (!identity || typeof identity.sessionId !== 'string' || typeof identity.threadId !== 'string' || identity.sessionId !== identity.threadId) {
        throw new BindingError('ordinary Codex identity is missing or conflicting');
      }
      assertUuid(identity.sessionId, 'sessionId');
      assertUuid(identity.threadId, 'threadId');
      if (identity.sessionId !== binding.nativeId || identity.threadId !== binding.nativeId) {
        throw new BindingError('ordinary Codex identity does not match the native session');
      }
      return state.bind({ ...binding, provider: PROVIDERS.CODEX, conductorId: null, repoKey: null, readiness: READINESS.PENDING, ordinaryIdentity: identity }, adoptionCutoff === null ? undefined : {
        intakeCutoff: adoptionCutoff,
        intakeCutoffDetail: 'ordinary binding adoption cutoff'
      });
    },

    rebindOrdinary(state, binding, identity, nativeProof = null, intakeCutoff = null) {
      if (binding.conductorId != null || binding.repoKey != null) throw new BindingError('ordinary bindings cannot carry conductor identity');
      if (!identity || typeof identity.sessionId !== 'string' || typeof identity.threadId !== 'string' || identity.sessionId !== identity.threadId) {
        throw new BindingError('ordinary Codex identity is missing or conflicting');
      }
      assertUuid(identity.sessionId, 'sessionId');
      assertUuid(identity.threadId, 'threadId');
      const existing = state.getBinding(binding.channelId);
      if (!existing || !state.isOrdinaryBindingRecord(existing)) {
        throw new BindingError('ordinary binding tombstone is unavailable for reuse');
      }
      const requestedSessionRoot = binding.sessionRoot === undefined
        ? (!existing.active && nativeProof ? nativeProof.sessionRoot || null : existing.sessionRoot)
        : binding.sessionRoot;
      const sessionRootMatches = (existing.sessionRoot || null) === (requestedSessionRoot || null);
      const verifiedRootRelocation = sessionRootMatches || Boolean(nativeProof &&
        typeof nativeProof.file === 'string' && path.isAbsolute(nativeProof.file) &&
        nativeProof.sessionId === existing.nativeId && nativeProof.threadId === existing.nativeId &&
        nativeProof.workspace === existing.workspace && nativeProof.sessionRoot === requestedSessionRoot);
      const sameOwner = existing.nativeId === binding.nativeId && existing.workspace === binding.workspace &&
        identity.sessionId === existing.nativeId && identity.threadId === existing.nativeId && verifiedRootRelocation;
      if (existing.guildId !== binding.guildId || existing.provider !== PROVIDERS.CODEX ||
        !sameOwner) {
        throw new BindingError('ordinary binding owner changed; use explicit handoff');
      }
      if (existing.active && sessionRootMatches) {
        throw new BindingError('ordinary binding tombstone is unavailable for reuse');
      }
      if (existing.active && !sessionRootMatches &&
        (state.hasUnresolved(binding.channelId) || state.hasUnresolvedOrdinaryPost(binding.channelId))) {
        const input = state.bindingInput({
          ...binding,
          channelId: binding.channelId,
          provider: PROVIDERS.CODEX,
          conductorId: null,
          repoKey: null,
          readiness: READINESS.PENDING,
          ordinaryIdentity: identity
        }, existing);
        return state.transaction(() => {
          const current = state.getBinding(binding.channelId);
          if (!bindingMatchesExpected(current, existing)) throw new StaleGenerationError('ordinary root relocation source identity is stale');
          const dispatching = state.db.prepare(
            'SELECT 1 FROM messages WHERE channel_id=? AND state IN (?, ?, ?) LIMIT 1'
          ).get(binding.channelId, MESSAGE_STATES.DISPATCHING, MESSAGE_STATES.UNCERTAIN, MESSAGE_STATES.SUBMITTED);
          if (dispatching) {
            throw new BindingError('ordinary binding root relocation is unavailable while dispatch is in flight');
          }
          if (state.hasUnresolvedOrdinaryPost(binding.channelId)) {
            throw new BindingError('ordinary binding root relocation has unresolved post custody');
          }
          state.assertLegacyMigrationSafe(binding.channelId);
          const updatedAt = now();
          state.db.prepare('UPDATE bindings SET session_root=?, readiness=?, updated_at=? WHERE channel_id=?')
            .run(input.sessionRoot, READINESS.PENDING, updatedAt, binding.channelId);
          state.db.prepare("UPDATE intake_watermarks SET state='pending', detail=?, gap_from=NULL, gap_to=NULL, updated_at=? WHERE channel_id=?")
            .run('ordinary transcript root relocated; intake recovery reopened', updatedAt, binding.channelId);
          state.receipt(null, 'ordinary-root-relocated', {
            channelId: binding.channelId, generation: existing.generation, sessionRoot: input.sessionRoot
          });
          return state.getBinding(binding.channelId);
        });
      }
      const rebound = {
        ...binding,
        sessionRoot: !existing.active && binding.sessionRoot === undefined ? requestedSessionRoot : binding.sessionRoot,
        provider: PROVIDERS.CODEX, conductorId: null, repoKey: null, readiness: READINESS.PENDING, ordinaryIdentity: identity
      };
      return state.rebind(rebound, {
        intakeCutoff,
        rejectUnresolvedOrdinaryPost: existing.active && !sessionRootMatches,
        resetIntake: !sessionRootMatches,
        sessionRootOverride: !existing.active && binding.sessionRoot === undefined ? requestedSessionRoot : undefined
      });
    },

    isOrdinaryBindingRecord(state, binding) {
      if (!binding || binding.provider !== PROVIDERS.CODEX || binding.conductorId || binding.repoKey) return false;
      return hasOrdinaryBindingReceipt(state, binding);
    },

    isOrdinaryBinding(state, binding) {
      return Boolean(binding?.active) && hasOrdinaryBindingReceipt(state, binding);
    },

    hasOrdinaryPreflight(state, binding) {
      if (!this.isOrdinaryBinding(state, binding)) return false;
      return hasOrdinaryPreflightReceipt(state, binding);
    },

    recordOrdinaryPreflight(state, binding, detail = {}) {
      return state.transaction(() => {
        const current = state.getBinding(binding?.channelId);
        if (!bindingMatchesExpected(current, binding)) return null;
        if (!state.isOrdinaryBinding(current)) throw new BindingError('binding is not an ordinary Codex binding');
        if (!detail || typeof detail !== 'object' || typeof detail.file !== 'string' || !path.isAbsolute(detail.file) ||
          detail.sessionId !== current.nativeId || detail.threadId !== current.nativeId || detail.workspace !== current.workspace) {
          throw new BindingError('ordinary Codex native preflight proof does not match the binding');
        }
        state.receipt(null, 'ordinary-native-preflight', {
          ...detail,
          channelId: current.channelId, guildId: current.guildId, provider: current.provider,
          nativeId: current.nativeId, workspace: current.workspace, generation: current.generation,
          sessionRoot: current.sessionRoot || null,
          outcome: 'verified'
        });
        return current;
      });
    },

    handoffOrdinary(state, { channelId, provider, fromNativeId, fromGeneration, nativeId, workspace, sessionRoot, handoffId, identity, nativeProof, intakeCutoff = null }) {
      if (intakeCutoff !== null) assertText(intakeCutoff, 'lastSeenId', 128);
      if (provider !== PROVIDERS.CODEX) throw new BindingError('ordinary handoff requires the Codex provider');
      assertUuid(fromNativeId, 'fromNativeId');
      assertUuid(nativeId, 'nativeId');
      if (!Number.isInteger(fromGeneration) || fromGeneration < 1) throw new BindingError('fromGeneration must be a positive integer');
      assertText(handoffId, 'handoffId', 256);
      if (!identity || identity.sessionId !== nativeId || identity.threadId !== nativeId) {
        throw new BindingError('ordinary handoff identity does not match the successor native session');
      }
      assertUuid(identity.sessionId, 'sessionId');
      assertUuid(identity.threadId, 'threadId');
      assertText(workspace, 'workspace', 4096);
      if (!path.isAbsolute(workspace)) throw new BindingError('workspace must be absolute');
      const existing = state.getBinding(channelId);
      if (!existing || !state.isOrdinaryBindingRecord(existing)) throw new BindingError('ordinary handoff source is unavailable');
      const requestedSessionRoot = sessionRoot === undefined ? existing.sessionRoot : sessionRoot;
      if (requestedSessionRoot !== null && requestedSessionRoot !== undefined) {
        assertText(requestedSessionRoot, 'sessionRoot', 4096);
        if (!path.isAbsolute(requestedSessionRoot)) throw new BindingError('sessionRoot must be absolute');
      }
      const input = state.bindingInput({
        channelId, guildId: existing.guildId, provider: PROVIDERS.CODEX, nativeId, workspace,
        sessionRoot: requestedSessionRoot, conductorId: null, repoKey: null, readiness: READINESS.PENDING
      }, existing);
      if (!nativeProof || typeof nativeProof.file !== 'string' || !path.isAbsolute(nativeProof.file) ||
        nativeProof.sessionId !== nativeId || nativeProof.threadId !== nativeId || nativeProof.workspace !== workspace ||
        (nativeProof.sessionRoot || null) !== (input.sessionRoot || null)) {
        throw new BindingError('ordinary handoff requires a matching Codex transcript proof');
      }
      const previous = state.findOrdinaryHandoff(handoffId);
      if (previous) {
        const sameRequest = previous.channelId === channelId && previous.provider === PROVIDERS.CODEX &&
          previous.fromNativeId === fromNativeId && previous.fromGeneration === fromGeneration &&
          previous.nativeId === nativeId &&
          previous.generation === existing.generation && existing.active && existing.nativeId === nativeId &&
          existing.generation === fromGeneration + 1 && existing.workspace === input.workspace &&
          (existing.sessionRoot || null) === (input.sessionRoot || null);
        if (!sameRequest) throw new BindingError('handoff ID is already used for a different successor');
        const retryResult = state.transaction(() => {
          const current = state.getBinding(channelId);
          if (!current || !bindingMatchesExpected(current, existing) || !current.active ||
            current.provider !== PROVIDERS.CODEX || current.conductorId || current.repoKey ||
            current.nativeId !== nativeId || current.generation !== fromGeneration + 1 ||
            current.workspace !== input.workspace || (current.sessionRoot || null) !== (input.sessionRoot || null)) {
            throw new StaleGenerationError('ordinary handoff retry binding identity is stale');
          }
          state.receipt(null, 'ordinary-handoff-retry', {
            channelId, provider: PROVIDERS.CODEX, handoffId, nativeId, generation: current.generation
          });
          return { ...current, handoffReconciled: true };
        });
        state.ordinaryHandoffPauses.delete(channelId);
        state.ordinaryHandoffPauseSnapshots?.delete(channelId);
        return retryResult;
      }
      if (existing.provider !== PROVIDERS.CODEX || existing.conductorId || existing.repoKey ||
        existing.nativeId !== fromNativeId || existing.generation !== fromGeneration) {
        throw new StaleGenerationError('ordinary handoff source identity is stale');
      }
      if (nativeId === fromNativeId) throw new BindingError('successor handoff requires a different native session UUID');
      if (!existing.active && !state.hasUnboundReceipt(channelId, fromGeneration)) {
        throw new BindingError('ordinary handoff tombstone has no matching unbind receipt');
      }
      if (state.hasUnresolved(channelId) || state.hasUnresolvedOrdinaryPost(channelId)) {
        throw new UnresolvedWorkError('cannot handoff while work is unresolved');
      }
      state.assertNativeOwnerFree(PROVIDERS.CODEX, nativeId, channelId);
      const handoffResult = state.transaction(() => {
        const current = state.getBinding(channelId);
        if (!bindingMatchesExpected(current, existing)) throw new StaleGenerationError('ordinary handoff source identity is stale');
        if (!current || current.provider !== PROVIDERS.CODEX || current.conductorId || current.repoKey ||
          current.nativeId !== fromNativeId || current.generation !== fromGeneration) {
          throw new StaleGenerationError('ordinary handoff source identity is stale');
        }
        if (!current.active && !state.hasUnboundReceipt(channelId, fromGeneration)) {
          throw new BindingError('ordinary handoff tombstone has no matching unbind receipt');
        }
        if (state.hasUnresolved(channelId) || state.hasUnresolvedOrdinaryPost(channelId)) {
          throw new UnresolvedWorkError('cannot handoff while work is unresolved');
        }
        state.assertNativeOwnerFree(PROVIDERS.CODEX, nativeId, channelId);
        state.assertLegacyMigrationSafe(channelId);
        if (intakeCutoff !== null) {
          state.setIntakeCutoffInTransaction(channelId, current.guildId, intakeCutoff, 'ordinary handoff adoption cutoff', current);
        }
        const generation = existing.generation + 1;
        const updatedAt = now();
        state.db.prepare(`UPDATE bindings SET native_id=?, workspace=?, session_root=?, readiness=?, generation=?, active=1, updated_at=?
          WHERE channel_id=? AND provider=? AND generation=? AND native_id=? AND active=?`)
          .run(input.nativeId, input.workspace, input.sessionRoot, READINESS.PENDING, generation, updatedAt, channelId,
            PROVIDERS.CODEX, fromGeneration, fromNativeId, existing.active ? 1 : 0);
        state.db.prepare("UPDATE intake_watermarks SET state='pending', detail=?, gap_from=NULL, gap_to=NULL, updated_at=? WHERE channel_id=?")
          .run('ordinary handoff; intake recovery reopened', updatedAt, channelId);
        state.receipt(null, 'ordinary-handoff', {
          channelId, provider: PROVIDERS.CODEX, handoffId,
          fromNativeId, fromGeneration, fromActive: existing.active,
          nativeId: input.nativeId, generation, workspace: input.workspace, sessionRoot: input.sessionRoot,
          sessionId: identity.sessionId, threadId: identity.threadId, transcriptFile: nativeProof.file
        });
        state.receipt(null, 'ordinary-bound', {
          channelId, guildId: existing.guildId, provider: PROVIDERS.CODEX, nativeId: input.nativeId,
          workspace: input.workspace, generation, sessionRoot: input.sessionRoot,
          sessionId: identity.sessionId, threadId: identity.threadId
        });
        return state.getBinding(channelId);
      });
      state.ordinaryHandoffPauses.delete(channelId);
      state.ordinaryHandoffPauseSnapshots?.delete(channelId);
      return handoffResult;
    }
  };
}

module.exports = { createOrdinaryBindingHandlers, hasOrdinaryBindingReceipt, hasOrdinaryPreflightReceipt };
