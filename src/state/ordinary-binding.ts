import * as path from 'node:path';
import { ORDINARY_RECEIPT_KINDS } from '../ordinary/constants';
import type {
  OrdinaryBindingRecord,
  OrdinaryBindingState,
  OrdinaryBindingDependencies,
  OrdinaryBindingHandlers
} from './ordinary-binding/contracts';
export type {
  OrdinaryBindingSqlStatement,
  OrdinaryBindingDatabase,
  OrdinaryBindingIdentity,
  OrdinaryNativeProof,
  OrdinaryMessageState,
  OrdinaryProvider,
  OrdinaryReadiness,
  OrdinaryBindingInput,
  OrdinaryBindingHandlerInput,
  OrdinaryBindingRecord,
  OrdinaryHandoffRecord,
  OrdinaryBindOptions,
  OrdinaryRebindOptions,
  OrdinaryRebindHandlerOptions,
  OrdinaryBindingState,
  OrdinaryBindingDependencies,
  OrdinaryHandoffInput,
  OrdinaryHandoffResult,
  OrdinaryBindingHandlers
} from './ordinary-binding/contracts';

export function hasOrdinaryBindingReceipt(
  { db }: Pick<OrdinaryBindingState, 'db'>,
  binding: OrdinaryBindingRecord
): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM receipts
    WHERE kind='${ORDINARY_RECEIPT_KINDS.BOUND}'
      AND json_extract(detail, '$.channelId')=?
      AND json_extract(detail, '$.provider')=?
      AND json_extract(detail, '$.nativeId')=?
      AND json_extract(detail, '$.workspace')=?
      AND json_extract(detail, '$.generation')=?
    LIMIT 1`).get(binding.channelId, binding.provider, binding.nativeId, binding.workspace, binding.generation));
}

export function hasOrdinaryPreflightReceipt(
  { db }: Pick<OrdinaryBindingState, 'db'>,
  binding: OrdinaryBindingRecord
): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM receipts
    WHERE kind='${ORDINARY_RECEIPT_KINDS.NATIVE_PREFLIGHT}'
      AND json_extract(detail, '$.channelId')=?
      AND json_extract(detail, '$.provider')=?
      AND json_extract(detail, '$.nativeId')=?
      AND json_extract(detail, '$.workspace')=?
      AND json_extract(detail, '$.generation')=?
      AND json_extract(detail, '$.sessionRoot') IS ?
      AND json_extract(detail, '$.outcome')='verified'
    LIMIT 1`).get(binding.channelId, binding.provider, binding.nativeId, binding.workspace, binding.generation, binding.sessionRoot || null));
}

function maxDiscordId(
  compareDiscordIds: OrdinaryBindingDependencies['compareDiscordIds'],
  current: string | null,
  candidate: string
): string {
  if (!current) return candidate;
  return compareDiscordIds(current, candidate) < 0 ? candidate : current;
}

function advanceEnrolledThreadCutoffs(
  compareDiscordIds: OrdinaryBindingDependencies['compareDiscordIds'],
  state: OrdinaryBindingState,
  parentChannelId: string,
  intakeCutoff: string,
  updatedAt: string
): void {
  const rows = state.db.prepare(`SELECT thread_id, recovered_through_id
    FROM thread_enrollments
    WHERE parent_channel_id=? AND active=1`).all<{ thread_id: string; recovered_through_id: string | null }>(parentChannelId);
  for (const row of rows) {
    const next = maxDiscordId(compareDiscordIds, row.recovered_through_id, intakeCutoff);
    if (next === row.recovered_through_id) continue;
    state.db.prepare('UPDATE thread_enrollments SET recovered_through_id=?, updated_at=? WHERE thread_id=? AND active=1')
      .run(next, updatedAt, row.thread_id);
  }
}

export function createOrdinaryBindingHandlers(
  {
    BindingError,
    StaleGenerationError,
    MESSAGE_STATES,
    PROVIDERS,
    READINESS,
    UnresolvedWorkError,
    assertText,
    assertUuid,
    compareDiscordIds,
    bindingMatchesExpected,
    now
  }: OrdinaryBindingDependencies
): OrdinaryBindingHandlers {
  const handlers: OrdinaryBindingHandlers = {
    advanceEnrolledThreadCutoffs(state, parentChannelId, intakeCutoff, updatedAt) {
      advanceEnrolledThreadCutoffs(compareDiscordIds, state, parentChannelId, intakeCutoff, updatedAt);
    },

    bindOrdinary(state, binding, identity, adoptionCutoff = null, options = {}) {
      if (binding.conductorId != null || binding.repoKey != null) throw new BindingError('ordinary bindings cannot carry conductor identity');
      if (!identity || typeof identity.sessionId !== 'string' || typeof identity.threadId !== 'string' || identity.sessionId !== identity.threadId) {
        throw new BindingError('ordinary Codex identity is missing or conflicting');
      }
      assertUuid(identity.sessionId, 'sessionId');
      assertUuid(identity.threadId, 'threadId');
      if (identity.sessionId !== binding.nativeId || identity.threadId !== binding.nativeId) {
        throw new BindingError('ordinary Codex identity does not match the native session');
      }
      return state.bind({ ...binding, provider: PROVIDERS.CODEX, conductorId: null, repoKey: null, readiness: READINESS.PENDING, ordinaryIdentity: identity }, adoptionCutoff === null ? options : {
        intakeCutoff: adoptionCutoff,
        intakeCutoffDetail: 'ordinary binding adoption cutoff',
        beforeMutation: options.beforeMutation
      });
    },

    rebindOrdinary(state, binding, identity, nativeProof = null, intakeCutoff = null, options = {}) {
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
        (state.hasUnresolved(binding.channelId) || state.hasUnresolvedBindingPost(binding.channelId))) {
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
          if (state.hasUnresolvedBindingPost(binding.channelId)) {
            throw new BindingError('ordinary binding root relocation has unresolved post custody');
          }
          state.assertLegacyMigrationSafe(binding.channelId);
          if (typeof options.beforeMutation === 'function') options.beforeMutation();
          const updatedAt = now();
          state.db.prepare('UPDATE bindings SET session_root=?, readiness=?, updated_at=? WHERE channel_id=?')
            .run(input.sessionRoot, READINESS.PENDING, updatedAt, binding.channelId);
          state.db.prepare("UPDATE intake_watermarks SET state='pending', detail=?, gap_from=NULL, gap_to=NULL, updated_at=? WHERE channel_id=?")
            .run('ordinary transcript root relocated; intake recovery reopened', updatedAt, binding.channelId);
          state.receipt(null, ORDINARY_RECEIPT_KINDS.ROOT_RELOCATED, {
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
        resetIntake: !sessionRootMatches,
        sessionRootOverride: !existing.active && binding.sessionRoot === undefined ? requestedSessionRoot : undefined,
        beforeMutation: options.beforeMutation
      });
    },

    isOrdinaryBindingRecord(state, binding): binding is OrdinaryBindingRecord {
      if (!binding || binding.provider !== PROVIDERS.CODEX || binding.conductorId || binding.repoKey) return false;
      return hasOrdinaryBindingReceipt(state, binding);
    },

    isOrdinaryBinding(state, binding): binding is OrdinaryBindingRecord {
      if (!binding || !binding.active || binding.provider !== PROVIDERS.CODEX || binding.conductorId || binding.repoKey) return false;
      return hasOrdinaryBindingReceipt(state, binding);
    },

    hasOrdinaryPreflight(this: OrdinaryBindingHandlers, state, binding) {
      if (!this.isOrdinaryBinding(state, binding)) return false;
      return hasOrdinaryPreflightReceipt(state, binding);
    },

    recordOrdinaryPreflight(state, binding, detail) {
      return state.transaction(() => {
        const current = state.getBinding(binding?.channelId);
        if (!bindingMatchesExpected(current, binding)) return null;
        const currentProvider = current?.provider || 'native';
        if (!state.isOrdinaryBinding(current)) throw new BindingError(`binding is not an ordinary ${currentProvider} binding`);
        if (!detail || typeof detail !== 'object' || typeof detail.file !== 'string' || !path.isAbsolute(detail.file) ||
          detail.sessionId !== current.nativeId ||
          detail.threadId !== current.nativeId ||
          detail.workspace !== current.workspace) {
          throw new BindingError(`ordinary ${current.provider} native preflight proof does not match the binding`);
        }
        state.receipt(null, ORDINARY_RECEIPT_KINDS.NATIVE_PREFLIGHT, {
          ...detail,
          channelId: current.channelId, guildId: current.guildId,
          provider: current.provider,
          nativeId: current.nativeId, workspace: current.workspace,
          generation: current.generation,
          sessionRoot: current.sessionRoot || null,
          outcome: 'verified'
        });
        return current;
      });
    },

    handoffOrdinary(state, { channelId, provider, fromNativeId, fromGeneration, nativeId, workspace, sessionRoot, handoffId, identity, nativeProof, intakeCutoff = null, enrollmentProof = null, beforeMutation = undefined }) {
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
      const previous = state._findOrdinaryHandoff(handoffId);
      if (previous) {
        const sameRequest = previous.channelId === channelId && previous.provider === PROVIDERS.CODEX &&
          previous.fromNativeId === fromNativeId && previous.fromGeneration === fromGeneration &&
          previous.nativeId === nativeId &&
          previous.generation === existing.generation && existing.active && existing.nativeId === nativeId &&
          existing.generation === fromGeneration + 1 && existing.workspace === input.workspace &&
          (existing.sessionRoot || null) === (input.sessionRoot || null);
        if (!sameRequest) throw new BindingError('handoff ID is already used for a different successor');
        const retryResult = state.transaction(() => {
          state.receipt(null, ORDINARY_RECEIPT_KINDS.HANDOFF_RETRY, {
            channelId, provider: PROVIDERS.CODEX, handoffId, nativeId, generation: existing.generation
          });
          return { ...existing, handoffReconciled: true };
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
      if (state.hasUnresolved(channelId) || state.hasUnresolvedBindingPost(channelId)) {
        throw new UnresolvedWorkError('cannot handoff while work is unresolved');
      }
      state.assertNativeOwnerFree(PROVIDERS.CODEX, nativeId, channelId);
      const hasActiveEnrollments = state.listThreadEnrollments(channelId).some(enrollment => enrollment.active);
      if (hasActiveEnrollments && intakeCutoff === null) {
        throw new BindingError('active thread enrollments require an observed intake cutoff');
      }
      try {
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
          if (state.hasUnresolved(channelId) || state.hasUnresolvedBindingPost(channelId)) {
            throw new UnresolvedWorkError('cannot handoff while work is unresolved');
          }
          state.assertNativeOwnerFree(PROVIDERS.CODEX, nativeId, channelId);
          const hasCurrentActiveEnrollments = state.listThreadEnrollments(channelId).some(enrollment => enrollment.active);
          if (hasCurrentActiveEnrollments && intakeCutoff === null) {
            throw new BindingError('active thread enrollments require an observed intake cutoff');
          }
          state.assertLegacyMigrationSafe(channelId);
          if (typeof beforeMutation === 'function') beforeMutation();
          const updatedAt = now();
          if (intakeCutoff !== null) {
            if (enrollmentProof) {
              if (typeof state.assertThreadEnrollmentCoverage !== 'function') {
                throw new BindingError('handoff enrollment proof cannot be validated');
              }
              state.assertThreadEnrollmentCoverage(channelId, enrollmentProof);
            }
            state.setIntakeCutoffInTransaction(channelId, current.guildId, intakeCutoff, 'ordinary handoff adoption cutoff', current);
            advanceEnrolledThreadCutoffs(compareDiscordIds, state, channelId, intakeCutoff, updatedAt);
          }
          const generation = existing.generation + 1;
          state.db.prepare(`UPDATE bindings SET native_id=?, workspace=?, session_root=?, readiness=?, generation=?, active=1, updated_at=?
            WHERE channel_id=? AND provider=? AND generation=? AND native_id=? AND active=?`)
            .run(input.nativeId, input.workspace, input.sessionRoot, READINESS.PENDING, generation, updatedAt, channelId,
              PROVIDERS.CODEX, fromGeneration, fromNativeId, existing.active ? 1 : 0);
          state.db.prepare("UPDATE intake_watermarks SET state='pending', detail=?, gap_from=NULL, gap_to=NULL, updated_at=? WHERE channel_id=?")
            .run('ordinary handoff; intake recovery reopened', updatedAt, channelId);
          state.receipt(null, ORDINARY_RECEIPT_KINDS.HANDOFF, {
            channelId, provider: PROVIDERS.CODEX, handoffId,
            fromNativeId, fromGeneration, fromActive: existing.active,
            nativeId: input.nativeId, generation, intakeCutoff, workspace: input.workspace, sessionRoot: input.sessionRoot,
            sessionId: identity.sessionId, threadId: identity.threadId, transcriptFile: nativeProof.file
          });
          state.receipt(null, ORDINARY_RECEIPT_KINDS.BOUND, {
            channelId, guildId: existing.guildId, provider: PROVIDERS.CODEX, nativeId: input.nativeId,
            workspace: input.workspace, generation, sessionRoot: input.sessionRoot,
            sessionId: identity.sessionId, threadId: identity.threadId
          });
          return state.getBinding(channelId);
        });
        state.ordinaryHandoffPauses.delete(channelId);
        state.ordinaryHandoffPauseSnapshots?.delete(channelId);
        return handoffResult;
      } catch (error) {
        if (!(error instanceof StaleGenerationError)) throw error;
        const committed = state._findOrdinaryHandoff(handoffId);
        const successor = state.getBinding(channelId);
        const reconciled = committed && successor && successor.active && successor.provider === PROVIDERS.CODEX &&
          !successor.conductorId && !successor.repoKey && successor.nativeId === nativeId &&
          successor.generation === fromGeneration + 1 && successor.workspace === input.workspace &&
          (successor.sessionRoot || null) === (input.sessionRoot || null) &&
          committed.channelId === channelId && committed.provider === PROVIDERS.CODEX &&
          committed.fromNativeId === fromNativeId && committed.fromGeneration === fromGeneration &&
          committed.nativeId === nativeId && committed.generation === successor.generation &&
          committed.workspace === input.workspace && (committed.sessionRoot || null) === (input.sessionRoot || null);
        if (!reconciled) throw error;
        const retryResult = state.transaction(() => {
          const current = state.getBinding(channelId);
          const latest = state._findOrdinaryHandoff(handoffId);
          if (!latest || !bindingMatchesExpected(current, successor) || latest.nativeId !== nativeId ||
            latest.generation !== current?.generation) throw error;
          state.receipt(null, ORDINARY_RECEIPT_KINDS.HANDOFF_RETRY, {
            channelId, provider: PROVIDERS.CODEX, handoffId, nativeId, generation: current!.generation
          });
          return { ...current!, handoffReconciled: true };
        });
        state.ordinaryHandoffPauses.delete(channelId);
        state.ordinaryHandoffPauseSnapshots?.delete(channelId);
        return retryResult;
      }
    }
  };
  return handlers;
}
