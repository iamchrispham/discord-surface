import { createFilePreparationHandlers, assertFilePreparationClaim } from './direct-post/file-preparation';
import { projectNewestDirectPostAttempt } from './direct-post/receipt-queries';
export { queryDirectPostRows, querySentAgentResultRows, projectNewestDirectPostAttempt } from './direct-post/receipt-queries';
import { DIRECT_POST_OUTCOMES } from './direct-post/contracts';
import type {
  DirectPostOutcome,
  DirectPostPartStatus,
  DirectPostBinding,
  DirectPostPartMeta,
  DirectPostReceiptDetail,
  DirectPostReceiptRow,
  DirectPostState,
  SentAgentResultRow,
  DirectPostOwnerIdentity,
  DirectPostInspection,
  DirectPostClaim,
  DirectPostEvent,
  DirectPostMatchEvent,
  DirectPostOutcomeRecord,
  DirectPostHandlers,
  RawOutcomeRow,
  DirectPostErrorConstructor,
  DirectPostDependencies
} from './direct-post/contracts';
export { DIRECT_POST_OUTCOMES } from './direct-post/contracts';
export type {
  DirectPostOutcome,
  DirectPostPartStatus,
  DirectPostBinding,
  DirectPostPartMeta,
  DirectPostReceiptDetail,
  DirectPostReceiptRow,
  DirectPostState,
  DirectPostFilePreparationSeed,
  SentAgentResultRow,
  DirectPostOwnerIdentity,
  DirectPostInspection,
  DirectPostClaim,
  DirectPostEvent,
  DirectPostOutcomeRecord,
  DirectPostHandlers
} from './direct-post/contracts';
import { createHash } from 'node:crypto';
import { isAgentSourcePromotion } from './agent-routing';
import { KINDS, sameAddress, type AgentAddress, type AgentMessage, type AgentProvider } from '../agent-message';
import type { WatcherNotice } from '../watcher-notice';
import { identityKeyValueMatches, identityValueMatches, samePeerAgentPacket, snapshotCustodyFields, validatedOutcomeDetail } from './direct-post/outcome-identity';
export { samePeerAgentPacket } from './direct-post/outcome-identity';

const identityKeys: readonly (keyof DirectPostPartMeta)[] = [
  'textHash', 'inReplyTo', 'channelId', 'guildId', 'provider', 'nativeId', 'generation',
  'conductorId', 'repoKey', 'partCount', 'deliveryChannelId', 'agentPacket', 'agentRequestTarget', 'watcherNotice', 'caption', 'fileManifest'
];

function validateMeta(meta: DirectPostPartMeta | null | undefined, BindingError: DirectPostErrorConstructor, assertText: DirectPostDependencies['assertText']): asserts meta is DirectPostPartMeta {
  if (!meta || typeof meta !== 'object') throw new BindingError('direct post metadata is required');
  assertText(meta.requestId, 'requestId', 256);
  assertText(meta.attemptId, 'attemptId', 128);
  if (!Number.isInteger(meta.partIndex) || meta.partIndex < 0 || !Number.isInteger(meta.partCount) || meta.partCount < 1 || meta.partIndex >= meta.partCount) {
    throw new BindingError('direct post part index is invalid');
  }
}

function packetTargetChannelId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const target = (value as Record<string, unknown>).target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  const channelId = (target as Record<string, unknown>).channelId;
  return typeof channelId === 'string' ? channelId : null;
}

function bindingTargetChannels(state: DirectPostState, channelId: string): Set<string> {
  return new Set([channelId, ...state.listThreadEnrollments(channelId).map(enrollment => enrollment.threadId)]);
}

function targetsBinding(detail: DirectPostReceiptDetail, channelId: string, targetChannels: Set<string>): boolean {
  if (detail.channelId === channelId) return true;
  if (typeof detail.deliveryChannelId === 'string' && targetChannels.has(detail.deliveryChannelId)) return true;
  const targetChannelId = packetTargetChannelId(detail.agentPacket);
  return targetChannelId !== null && targetChannels.has(targetChannelId);
}

function directPostCustodyKey(detail: DirectPostReceiptDetail): string {
  const source = (detail.agentPacket as AgentMessage | undefined)?.source;
  return [
    detail.requestId,
    source?.guildId ?? detail.guildId,
    source?.channelId ?? detail.channelId,
    source?.provider ?? detail.provider,
    source?.nativeId ?? detail.nativeId,
    source?.generation ?? detail.generation
  ].map(value => String(value ?? '')).join('\u0000');
}

function scopedAgentRows(state: DirectPostState, meta: DirectPostPartMeta): DirectPostReceiptRow[] {
  const rows = state.directPostRows(meta.requestId, meta.agentPacket ? meta.channelId : null);
  if (!meta.agentPacket) return rows;
  const sources = [meta.agentPacket.source, meta.legacyAgentPacket?.source].filter(Boolean);
  return rows.filter(row => row.detail.guildId === meta.guildId && row.detail.channelId === meta.channelId &&
    row.detail.provider === meta.provider && row.detail.nativeId === meta.nativeId &&
    row.detail.generation === meta.generation &&
    ([row.detail.agentPacket, row.detail.legacyAgentPacket].every(packet => !packet || typeof packet !== 'object') ||
      [row.detail.agentPacket, row.detail.legacyAgentPacket].some(packet =>
        packet && typeof packet === 'object' && sources.some(source => sameAddress((packet as AgentMessage).source, source))) ||
      row.detail.routingVersion !== undefined));
}

export function createDirectPostHandlers(dependencies: DirectPostDependencies): DirectPostHandlers {
  const {
    BindingError,
    StaleGenerationError,
    StateCorruptError,
    DIRECT_POST_ATTEMPT,
    DIRECT_POST_OUTCOME,
    DIRECT_POST_FILE_PREPARATION,
    assertText,
    bindingMatchesExpected,
    parseJson,
    now
  } = dependencies;

  function normalizedIdentity(detail: DirectPostReceiptDetail): DirectPostReceiptDetail {
    const original = detail.legacyAgentPacket;
    if (!isAgentSourcePromotion(original, detail.agentPacket, String(detail.channelId))) return detail;
    return { ...detail, agentPacket: original, agentRequestTarget: undefined,
      textHash: createHash('sha256').update(JSON.stringify(original)).digest('hex') };
  }

  function normalizedLegacyRow(detail: DirectPostReceiptDetail, original: AgentMessage | undefined, channelId: string): DirectPostReceiptDetail {
    if (!original || (!identityValueMatches(detail.agentPacket, original) && !isAgentSourcePromotion(original, detail.agentPacket, channelId))) {
      return normalizedIdentity(detail);
    }
    return { ...normalizedIdentity(detail), textHash: createHash('sha256').update(JSON.stringify(original)).digest('hex') };
  }

  function assertRequestIdentity(rows: DirectPostReceiptRow[], meta: DirectPostPartMeta): void {
    if (meta.legacyAgentPacket) {
      if (!isAgentSourcePromotion(meta.legacyAgentPacket, meta.agentPacket, meta.channelId) ||
          !rows.some(row => identityValueMatches(normalizedIdentity(row.detail).agentPacket, meta.legacyAgentPacket))) {
        throw new BindingError('direct post source migration lacks matching legacy custody');
      }
      const prior = rows.find(row => row.detail.legacyAgentPacket);
      if (prior && !identityValueMatches(prior.detail.agentPacket, meta.agentPacket)) {
        throw new BindingError('direct post request identity conflicts with existing custody');
      }
    }
    const incoming = normalizedIdentity(meta as unknown as DirectPostReceiptDetail);
    for (const row of rows) {
      const existing = normalizedLegacyRow(row.detail, meta.legacyAgentPacket, meta.channelId);
      const samePeerRoute = existing.peerRouting === true && meta.peerRouting === true &&
        samePeerAgentPacket(existing.agentPacket, incoming.agentPacket, meta.channelId);
      for (const key of identityKeys) {
        if (key === 'textHash' && samePeerRoute) continue;
        if (!identityKeyValueMatches(key, existing[key], incoming[key], meta.channelId, samePeerRoute)) {
          throw new BindingError('direct post request identity conflicts with existing custody');
        }
      }
    }
  }

  function assertResultRequestActive(state: DirectPostState, meta: DirectPostPartMeta): void {
    if (meta.agentPacket && state.isAgentResultForWithdrawnRequest(meta.agentPacket)) {
      throw new BindingError('agent request was withdrawn');
    }
  }

  function inspectPart(state: DirectPostState, meta: DirectPostPartMeta): DirectPostInspection | null {
    assertResultRequestActive(state, meta);
    const rows = scopedAgentRows(state, meta);
    assertRequestIdentity(rows, meta);
    const partRows = rows.filter(row => row.detail.partIndex === meta.partIndex);
    const { attempt: latest, outcome, latestPreflight } = projectNewestDirectPostAttempt(partRows, {
      attemptKind: DIRECT_POST_ATTEMPT,
      outcomeKind: DIRECT_POST_OUTCOME
    });
    const latestAttemptOutcome = outcome;
    const finalOutcomeByAttempt = new Map<unknown, DirectPostReceiptRow>();
    for (const row of partRows) {
      if (row.kind !== DIRECT_POST_OUTCOME || !row.detail.attemptId || row.detail.phase === 'preflight') continue;
      finalOutcomeByAttempt.set(row.detail.attemptId, row);
    }
    const latestConfirmedOutcome = Array.from(finalOutcomeByAttempt.values())
      .filter(row => ['sent', 'unknown'].includes(row.detail.outcome as string))
      .sort((a, b) => a.id - b.id).at(-1);
    const assertParentCurrent = (): void => {
      if (!state.directPostBindingCurrent(meta.binding, meta.operatorId)) throw new StaleGenerationError('direct post binding is stale');
    };
    const allowUnreadyAgentRoute = meta.agentPacket?.kind === KINDS.RESULT &&
      meta.agentPacket.source.channelId !== meta.binding.channelId;
    const assertRouteCurrent = (): void => {
      if (!state.directPostBindingCurrent(meta.binding, meta.operatorId, meta.agentPacket?.source.channelId,
        allowUnreadyAgentRoute)) {
        throw new StaleGenerationError('direct post binding is stale');
      }
    };
    if (latestPreflight && !latestConfirmedOutcome && (!latest || (latestPreflight.id > latest.id &&
      (!latestAttemptOutcome || latestPreflight.id > latestAttemptOutcome.id)))) {
      const status = latestPreflight.detail.outcome as string;
      const retryableRateLimit = status === 'rate_limited' && !meta.legacyAgentPacket;
      const retryableStale = status === 'stale' && !meta.legacyAgentPacket;
      if (status !== 'not_sent' && !retryableRateLimit && !retryableStale) {
        assertRouteCurrent();
        return { claimed: false, status, attemptId: meta.attemptId, nonce: meta.nonce, outcome: latestPreflight.detail };
      }
    }
    if (!latest) {
      assertRouteCurrent();
      return null;
    }
    assertParentCurrent();
    if (!outcome) return { claimed: false, status: 'in_flight', attemptId: latest.detail.attemptId as string, nonce: latest.detail.nonce as string };
    const status = outcome.detail.outcome as string;
    if (status === 'sent' || status === 'unknown') {
      return { claimed: false, status, attemptId: latest.detail.attemptId as string, nonce: latest.detail.nonce as string, outcome: outcome.detail };
    }
    if (!['not_sent', 'rejected', 'rate_limited', 'stale'].includes(status)) {
      return { claimed: false, status, attemptId: latest.detail.attemptId as string, nonce: latest.detail.nonce as string, outcome: outcome.detail };
    }
    assertRouteCurrent();
    return null;
  }

  const handlers: DirectPostHandlers = {
    hasUnresolvedBindingPost(state, channelId) {
      const targetChannels = bindingTargetChannels(state, channelId);
      const rows = state.directPostRows(null, null, [...targetChannels]);
      const requests = new Map<unknown, { partCount: number; parts: Map<number, { attempts: DirectPostReceiptRow[]; outcomes: DirectPostReceiptRow[] }> }>();
      const attemptPart = new Map<unknown, number>();
      const relevantRequests = new Set<unknown>();
      for (const row of rows) {
        if (row.kind !== DIRECT_POST_ATTEMPT || !targetsBinding(row.detail, channelId, targetChannels)) continue;
        const requestKey = directPostCustodyKey(row.detail);
        relevantRequests.add(requestKey);
        const partCount = Object.hasOwn(row.detail, 'partCount') ? row.detail.partCount as number : 1;
        const partIndex = Object.hasOwn(row.detail, 'partIndex') ? row.detail.partIndex as number : 0;
        if (!Number.isSafeInteger(partCount) || partCount < 1 || !Number.isSafeInteger(partIndex) || partIndex < 0 || partIndex >= partCount) return true;
        const request = requests.get(requestKey) || { partCount, parts: new Map<number, { attempts: DirectPostReceiptRow[]; outcomes: DirectPostReceiptRow[] }>() };
        if (request.partCount !== partCount) return true;
        const part = request.parts.get(partIndex) || { attempts: [], outcomes: [] };
        part.attempts.push(row);
        request.parts.set(partIndex, part);
        requests.set(requestKey, request);
        if (typeof row.detail.attemptId === 'string' && row.detail.attemptId) attemptPart.set(`${requestKey}\u0000${row.detail.attemptId}`, partIndex);
      }
      for (const row of rows) {
        if (row.kind !== DIRECT_POST_OUTCOME || typeof row.detail?.attemptId !== 'string' || !row.detail.attemptId) continue;
        const requestKey = directPostCustodyKey(row.detail);
        if (!relevantRequests.has(requestKey)) continue;
        const request = requests.get(requestKey);
        const partIndex = attemptPart.get(`${requestKey}\u0000${row.detail.attemptId}`);
        if (!request || partIndex === undefined) continue;
        const part = request.parts.get(partIndex);
        if (part) part.outcomes.push(row);
      }
      for (const request of requests.values()) {
        const projections = new Map<number, ReturnType<typeof projectNewestDirectPostAttempt>>();
        for (const [partIndex, part] of request.parts) {
          projections.set(partIndex, projectNewestDirectPostAttempt([...part.attempts, ...part.outcomes], {
            attemptKind: DIRECT_POST_ATTEMPT,
            outcomeKind: DIRECT_POST_OUTCOME
          }));
        }
        let definitiveFailure = false;
        for (const projection of projections.values()) {
          const value = projection.outcome?.detail?.outcome as string | undefined;
          if (!projection.attempt || !value || value === 'unknown' || !(DIRECT_POST_OUTCOMES as readonly string[]).includes(value)) return true;
          if (value !== 'sent') definitiveFailure = true;
        }
        if (definitiveFailure) continue;
        for (let partIndex = 0; partIndex < request.partCount; partIndex += 1) {
          const projection = projections.get(partIndex);
          const value = projection?.outcome?.detail?.outcome as string | undefined;
          if (!projection || !projection.attempt || !value || value === 'unknown' || !(DIRECT_POST_OUTCOMES as readonly string[]).includes(value)) return true;
        }
      }
      return false;
    },

    hasUnresolvedOrdinaryPost(state, channelId) {
      return handlers.hasUnresolvedBindingPost(state, channelId);
    },

    inspectDirectPostPart(state, meta) {
      validateMeta(meta, BindingError, assertText);
      return state.transaction(() => inspectPart(state, meta));
    },

    recordDirectPostPreflight(state, meta, outcome, detail = {}) {
      validateMeta(meta, BindingError, assertText);
      if (!DIRECT_POST_OUTCOMES.includes(outcome)) throw new BindingError('invalid direct post outcome');
      const snapshots = new WeakMap<object, unknown>();
      const canonicalMeta = snapshotCustodyFields(meta, snapshots);
      detail = validatedOutcomeDetail(canonicalMeta, detail, BindingError, snapshots);
      return state.transaction(() => {
        assertResultRequestActive(state, canonicalMeta);
        const rows = scopedAgentRows(state, canonicalMeta);
        assertRequestIdentity(rows, canonicalMeta);
        const { attemptId: _attemptId, ...preflightMeta } = canonicalMeta;
        const next = { journal: 'direct-post-v1', ...preflightMeta, ...detail, phase: 'preflight', outcome };
        state.receipt(null, DIRECT_POST_OUTCOME, next);
        return next;
      });
    },

    beginDirectPostPart(state, meta) {
      validateMeta(meta, BindingError, assertText);
      return state.transaction(() => {
        const existing = inspectPart(state, meta);
        if (existing) return existing;
        assertFilePreparationClaim(state, meta, BindingError, DIRECT_POST_FILE_PREPARATION, parseJson, StateCorruptError);
        const ownerIdentity = state.directPostOwnerIdentity(process.pid);
        state.receipt(null, DIRECT_POST_ATTEMPT, {
          journal: 'direct-post-v1', ...meta, ...ownerIdentity, status: 'attempted'
        });
        return { claimed: true, status: 'claimed', attemptId: meta.attemptId, nonce: meta.nonce };
      });
    },

    recordDirectPostOutcome(state, requestId, attemptId, outcome, detail = {}) {
      assertText(requestId, 'requestId', 256);
      assertText(attemptId, 'attemptId', 128);
      if (!DIRECT_POST_OUTCOMES.includes(outcome)) throw new BindingError('invalid direct post outcome');
      return state.transaction(() => {
        const rows = state.directPostRows(requestId);
        const attempt = rows.find(row => row.kind === DIRECT_POST_ATTEMPT && row.detail.attemptId === attemptId);
        if (!attempt) throw new BindingError('direct post attempt is unknown');
        detail = validatedOutcomeDetail(attempt.detail as unknown as DirectPostPartMeta, detail, BindingError);
        const existing = rows.find(row => row.kind === DIRECT_POST_OUTCOME && row.detail.attemptId === attemptId);
        if (existing) return existing.detail as DirectPostOutcomeRecord;
        const next = { ...attempt.detail, ...detail, outcome };
        state.receipt(null, DIRECT_POST_OUTCOME, next);
        return next;
      });
    },

    reconcileDirectPostOutcome(state, requestId, attemptId, resolution, evidence = {}) {
      assertText(requestId, 'requestId', 256);
      assertText(attemptId, 'attemptId', 128);
      if (!['sent', 'not_sent'].includes(resolution)) {
        throw new BindingError('direct post reconciliation must resolve to sent or not_sent');
      }
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
        throw new BindingError('direct post reconciliation evidence is required');
      }
      const evidenceText = [evidence.evidenceScope, evidence.scope, evidence.source, evidence.reason, evidence.note,
        evidence.evidence, evidence.messageId, evidence.nonce]
        .find(value => typeof value === 'string' && value.trim().length > 0);
      if (!evidenceText) throw new BindingError('direct post reconciliation evidence is required');
      return state.transaction(() => {
        const rows = state.directPostRows(requestId);
        const attempt = rows.find(row => row.kind === DIRECT_POST_ATTEMPT && row.detail.attemptId === attemptId);
        if (!attempt) throw new BindingError('direct post attempt is unknown');
        const outcomes = rows.filter(row => row.kind === DIRECT_POST_OUTCOME && row.detail.attemptId === attemptId)
          .sort((left, right) => left.id - right.id);
        const previous = outcomes.at(-1);
        if (!previous || previous.detail.outcome !== 'unknown') {
          throw new BindingError('direct post attempt does not need reconciliation');
        }
        for (const key of ['channelId', 'guildId'] as const) {
          if (evidence[key] !== undefined && evidence[key] !== attempt.detail[key]) {
            throw new BindingError(`direct post reconciliation ${key} does not match the attempt`);
          }
        }
        const next = {
          ...attempt.detail,
          outcome: resolution,
          reconciledFrom: 'unknown',
          reconciliationEvidence: evidence
        };
        if (resolution === 'sent') {
          const messageId = evidence.messageId === undefined ? null : assertText(evidence.messageId, 'messageId', 128);
          const nonce = evidence.nonce === undefined ? null : assertText(evidence.nonce, 'nonce', 256);
          if (!messageId && !nonce) throw new BindingError('sent direct post reconciliation requires a messageId or nonce');
          if (messageId) next.messageId = messageId;
          if (nonce) {
            if (attempt.detail.nonce !== undefined && nonce !== attempt.detail.nonce) {
              throw new BindingError('sent direct post reconciliation nonce does not match the attempt');
            }
            next.nonce = nonce;
          }
        }
        state.receipt(null, DIRECT_POST_OUTCOME, next);
        state.receipt(null, 'direct-post-reconciled', {
          requestId, attemptId, channelId: attempt.detail.channelId, guildId: attempt.detail.guildId,
          outcome: resolution, evidence
        });
        return next;
      });
    },

    directPostOutcomeMatches(state, event, key, value) {
      const jsonPath = { messageId: '$.messageId', nonce: '$.nonce' }[key];
      if (!jsonPath) throw new BindingError('direct post outcome lookup key is invalid');
      const rows = state.db.prepare(`SELECT detail FROM receipts
        WHERE discord_id IS NULL AND kind=?
          AND json_extract(detail, '${jsonPath}')=?
          AND json_extract(detail, '$.channelId')=?
          AND json_extract(detail, '$.guildId')=?`).all<RawOutcomeRow>(
        DIRECT_POST_OUTCOME, value, event.channelId, event.guildId
      );
      return rows.some(row => {
        const detail = parseJson(row.detail, null);
        if (!detail || detail.journal !== 'direct-post-v1') throw new StateCorruptError('direct post receipt is malformed');
        return detail.outcome === 'sent' && detail[key] === value;
      });
    },

    excludeDirectPost(this: DirectPostHandlers, state, event) {
      if (!event || typeof event.id !== 'string' || typeof event.channelId !== 'string' || typeof event.guildId !== 'string') return false;
      if (this.directPostOutcomeMatches(state, event as DirectPostMatchEvent, 'messageId', event.id)) return true;
      return Boolean(event.isBot && typeof event.nonce === 'string' && this.directPostOutcomeMatches(state, event as DirectPostMatchEvent, 'nonce', event.nonce));
    },

    ...createFilePreparationHandlers(dependencies)
  };
  return handlers;
}
