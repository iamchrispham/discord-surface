import { queryFilePreparationRows, latestFilePreparation } from './direct-post/receipt-queries';
export { queryDirectPostRows, querySentAgentResultRows } from './direct-post/receipt-queries';
import { DIRECT_POST_OUTCOMES } from './direct-post/contracts';
import type {
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
  DirectPostMatchEvent,
  DirectPostOutcomeRecord,
  DirectPostHandlers,
  DirectPostCustodyKey,
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
import type { AgentAddress, AgentMessage, AgentProvider } from '../agent-message';
import type { WatcherNotice } from '../watcher-notice';
import { DIRECT_POST_FILE_LIMITS, DIRECT_POST_FILE_PHASES, stagedDirectPostFilePath } from '../direct-post-file';
import type { DirectPostFileManifest, DirectPostFilePreparation } from '../direct-post-file';
import { NATIVE_REPLY_FILE_JOURNAL, NATIVE_REPLY_FILE_PREPARATION } from './native-reply-file';

const identityKeys: readonly (keyof DirectPostPartMeta)[] = [
  'textHash', 'inReplyTo', 'channelId', 'guildId', 'provider', 'nativeId', 'generation',
  'conductorId', 'repoKey', 'partCount', 'deliveryChannelId', 'agentPacket', 'agentRequestTarget', 'watcherNotice', 'caption', 'fileManifest'
];

function identityKeyValueMatches(key: string, left: unknown, right: unknown): boolean {
  if (key === 'agentPacket' && (left === undefined || left === null || right === undefined || right === null)) return true;
  return identityValueMatches(left, right);
}

function identityValueMatches(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

const immutableDetailKeys: Record<DirectPostCustodyKey, true> = {
  requestId: true,
  inReplyTo: true,
  attemptId: true,
  sourcePath: true,
  textHash: true,
  operatorId: true,
  partHash: true,
  channelId: true,
  guildId: true,
  provider: true,
  nativeId: true,
  generation: true,
  conductorId: true,
  repoKey: true,
  partIndex: true,
  partCount: true,
  nonce: true,
  binding: true,
  deliveryChannelId: true,
  agentPacket: true,
  legacyAgentPacket: true,
  agentRequestTarget: true,
  routingVersion: true,
  presentation: true,
  watcherNotice: true,
  caption: true,
  fileManifest: true,
  ownerPid: true,
  ownerStartTime: true,
  ownerCommand: true,
  journal: true,
};

function validatedOutcomeDetail(expected: DirectPostPartMeta, input: Record<string, unknown>, BindingError: DirectPostErrorConstructor, snapshots = new WeakMap<object, unknown>()): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BindingError('direct post outcome detail is invalid');
  const expectedSnapshot = snapshotCustodyFields(expected, snapshots);
  const detail = snapshotCustodyFields(input, snapshots);
  for (const key of Object.keys(immutableDetailKeys)) {
    if (!Object.hasOwn(detail, key)) continue;
    const expectedValue = key === 'journal' ? 'direct-post-v1' : (expectedSnapshot as unknown as Record<string, unknown>)[key];
    if (!identityValueMatches(detail[key], expectedValue)) {
      throw new BindingError(`direct post outcome cannot override immutable ${key}`);
    }
  }
  if (Object.hasOwn(detail, 'outcome')) throw new BindingError('direct post outcome cannot override immutable outcome');
  return detail;
}

function snapshotCustodyValue(value: unknown, snapshots: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (snapshots.has(value)) return snapshots.get(value);
  const serialized = JSON.stringify(value);
  const snapshot = serialized === undefined ? undefined : JSON.parse(serialized);
  snapshots.set(value, snapshot);
  return snapshot;
}

function snapshotCustodyFields<T>(input: T, snapshots = new WeakMap<object, unknown>()): T {
  const snapshot = { ...(input as object) } as Record<string, unknown>;
  for (const key of Object.keys(immutableDetailKeys)) {
    if (Object.hasOwn(snapshot, key)) snapshot[key] = snapshotCustodyValue(snapshot[key], snapshots);
  }
  return snapshot as T;
}

function assertFileSeed(seed: DirectPostFilePreparationSeed, BindingError: DirectPostErrorConstructor, assertText: DirectPostDependencies['assertText']): void {
  assertText(seed.preparationId, 'preparationId', 128);
  assertText(seed.requestId, 'requestId', 256);
  assertText(seed.custodyRoot, 'custodyRoot', 4096);
  assertText(seed.sourcePath, 'sourcePath', 4096);
  assertText(seed.stagedPath, 'stagedPath', 4096);
  assertText(seed.filename, 'filename', 255);
  assertText(seed.caption, 'caption', 2000);
  assertText(seed.captionHash, 'captionHash', 128);
  if (!Number.isSafeInteger(seed.size) || seed.size < 0 || seed.size > DIRECT_POST_FILE_LIMITS.maxBytes) throw new BindingError('attachment size is outside the bounded limit');
  if (!Number.isSafeInteger(seed.generation) || seed.generation < 1) throw new BindingError('generation is invalid');
  if (!Number.isInteger(seed.ownerPid) || seed.ownerPid < 1) throw new BindingError('preparation owner identity is invalid');
  if (stagedDirectPostFilePath(seed.custodyRoot, seed.preparationId) !== seed.stagedPath) {
    throw new BindingError('direct post staged path does not match its custody root');
  }
}

function assertFileIdentity(existing: DirectPostReceiptDetail, incoming: Partial<DirectPostFilePreparationSeed> | DirectPostFileManifest, BindingError: DirectPostErrorConstructor): void {
  for (const key of ['requestId', 'custodyRoot', 'stagedPath', 'filename', 'size', 'caption', 'captionHash',
    'channelId', 'guildId', 'provider', 'nativeId', 'generation', 'operatorId', 'inReplyTo', 'conductorId', 'repoKey'] as const) {
    const incomingValue = (incoming as unknown as Record<string, unknown>)[key];
    if (existing[key] !== undefined && incomingValue !== undefined && existing[key] !== incomingValue) throw new BindingError(`direct post file preparation cannot override immutable ${key}`);
  }
}

function assertFilePreparationClaim(state: DirectPostState, meta: DirectPostPartMeta, BindingError: DirectPostErrorConstructor,
  kind: string, parseJson: DirectPostDependencies['parseJson'], StateCorruptError: DirectPostErrorConstructor): void {
  if (!meta.fileManifest) return;
  const preparationId = meta.fileManifest.preparationId;
  const existing = latestFilePreparation(state, kind, parseJson, StateCorruptError, preparationId);
  if (!existing || existing.detail.phase !== DIRECT_POST_FILE_PHASES.ADMITTED) {
    throw new BindingError('direct post file preparation is no longer admitted');
  }
  assertFileIdentity(existing.detail, {
    requestId: meta.requestId,
    stagedPath: meta.fileManifest.stagedPath,
    filename: meta.fileManifest.filename,
    size: meta.fileManifest.size,
    caption: meta.fileManifest.caption,
    captionHash: meta.fileManifest.captionHash
  }, BindingError);
  for (const key of ['requestId', 'channelId', 'guildId', 'provider', 'nativeId', 'generation', 'operatorId', 'inReplyTo'] as const) {
    const expected = existing.detail[key];
    const actual = (meta as unknown as Record<string, unknown>)[key];
    if ((expected ?? null) !== (actual ?? null)) throw new BindingError(`direct post file preparation cannot override immutable ${key}`);
  }
  for (const key of ['conductorId', 'repoKey'] as const) {
    if ((existing.detail[key] ?? null) !== ((meta as unknown as Record<string, unknown>)[key] ?? null)) {
      throw new BindingError(`direct post file preparation cannot override immutable ${key}`);
    }
  }
}

function validateMeta(meta: DirectPostPartMeta | null | undefined, BindingError: DirectPostErrorConstructor, assertText: DirectPostDependencies['assertText']): asserts meta is DirectPostPartMeta {
  if (!meta || typeof meta !== 'object') throw new BindingError('direct post metadata is required');
  assertText(meta.requestId, 'requestId', 256);
  assertText(meta.attemptId, 'attemptId', 128);
  if (!Number.isInteger(meta.partIndex) || meta.partIndex < 0 || !Number.isInteger(meta.partCount) || meta.partCount < 1 || meta.partIndex >= meta.partCount) {
    throw new BindingError('direct post part index is invalid');
  }
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
      for (const key of identityKeys) {
        if (!identityKeyValueMatches(key, existing[key], incoming[key])) {
          throw new BindingError('direct post request identity conflicts with existing custody');
        }
      }
    }
  }

  function inspectPart(state: DirectPostState, meta: DirectPostPartMeta): DirectPostInspection | null {
    const rows = state.directPostRows(meta.requestId);
    assertRequestIdentity(rows, meta);
    const attempts = rows.filter(row => row.kind === DIRECT_POST_ATTEMPT && row.detail.partIndex === meta.partIndex).sort((a, b) => a.id - b.id);
    const preflights = rows.filter(row => row.kind === DIRECT_POST_OUTCOME && row.detail.partIndex === meta.partIndex &&
      row.detail.phase === 'preflight').sort((a, b) => a.id - b.id);
    const outcomes = new Map<unknown, DirectPostReceiptRow>(rows.filter(row => row.kind === DIRECT_POST_OUTCOME && row.detail.attemptId)
      .map(row => [row.detail.attemptId, row]));
    const latest = attempts.at(-1);
    const latestAttemptOutcome = latest ? outcomes.get(latest.detail.attemptId) : undefined;
    const latestConfirmedOutcome = Array.from(outcomes.values()).filter(row => row.detail.partIndex === meta.partIndex && row.detail.phase !== 'preflight' &&
      ['sent', 'unknown'].includes(row.detail.outcome as string)).sort((a, b) => a.id - b.id).at(-1);
    const assertParentCurrent = (): void => {
      if (!state.directPostBindingCurrent(meta.binding, meta.operatorId)) throw new StaleGenerationError('direct post binding is stale');
    };
    const assertRouteCurrent = (): void => {
      if (!state.directPostBindingCurrent(meta.binding, meta.operatorId, meta.agentPacket?.source.channelId)) {
        throw new StaleGenerationError('direct post binding is stale');
      }
    };
    const latestPreflight = preflights.at(-1);
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
    const outcome = outcomes.get(latest.detail.attemptId);
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
    hasUnresolvedOrdinaryPost(state, channelId) {
      const rows = state.directPostRows(null, channelId);
      const outcomes = new Map<unknown, DirectPostReceiptRow>(rows.filter(row => row.kind === DIRECT_POST_OUTCOME && row.detail?.attemptId)
        .map(row => [row.detail.attemptId, row]));
      const requests = new Map<unknown, { partCount: number; parts: Map<number, DirectPostReceiptRow> }>();
      for (const row of rows) {
        if (row.kind !== DIRECT_POST_ATTEMPT || row.detail.channelId !== channelId ||
          row.detail.provider !== 'codex' || row.detail.conductorId || row.detail.repoKey) continue;
        const partCount = Number(row.detail.partCount || 1);
        const partIndex = Number.isInteger(row.detail.partIndex) ? row.detail.partIndex as number : 0;
        if (!Number.isSafeInteger(partCount) || partCount < 1 || !Number.isSafeInteger(partIndex) || partIndex < 0 || partIndex >= partCount) return true;
        const request = requests.get(row.detail.requestId) || { partCount, parts: new Map<number, DirectPostReceiptRow>() };
        if (request.partCount !== partCount) return true;
        request.parts.set(partIndex, row);
        requests.set(row.detail.requestId, request);
      }
      for (const request of requests.values()) {
        let definitiveFailure = false;
        for (const row of request.parts.values()) {
          const outcome = outcomes.get(row.detail.attemptId);
          if (!outcome || outcome.detail.outcome === 'unknown') return true;
          if (outcome.detail.outcome !== 'sent') definitiveFailure = true;
        }
        if (definitiveFailure) continue;
        for (let partIndex = 0; partIndex < request.partCount; partIndex += 1) {
          const row = request.parts.get(partIndex);
          const outcome = row && outcomes.get(row.detail.attemptId);
          if (!outcome || outcome.detail.outcome === 'unknown') return true;
        }
      }
      return false;
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
        const rows = state.directPostRows(canonicalMeta.requestId);
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

    findDirectPostFilePreparation(state, requestId) {
      assertText(requestId, 'requestId', 256);
      const rows = queryFilePreparationRows(state, DIRECT_POST_FILE_PREPARATION, parseJson, StateCorruptError, null, requestId);
      const latest = rows.at(-1);
      return latest ? latest.detail as unknown as DirectPostFilePreparation : null;
    },

    beginDirectPostFilePreparation(state, seed) {
      assertFileSeed(seed, BindingError, assertText);
      return state.transaction(() => {
        const rows = queryFilePreparationRows(state, DIRECT_POST_FILE_PREPARATION, parseJson, StateCorruptError);
        const latestByPreparation = new Map<string, { kind: string; detail: any }>();
        for (const row of rows) {
          const id = row.detail.preparationId;
          if (typeof id === 'string') latestByPreparation.set(`${DIRECT_POST_FILE_PREPARATION}\u0000${id}`, {
            kind: DIRECT_POST_FILE_PREPARATION,
            detail: row.detail
          });
        }
        const nativeRows = state.db.prepare('SELECT detail FROM receipts WHERE kind=? ORDER BY id').all(NATIVE_REPLY_FILE_PREPARATION);
        for (const row of nativeRows) {
          const detail = parseJson(row.detail, null);
          if (!detail || detail.journal !== NATIVE_REPLY_FILE_JOURNAL || typeof detail.preparationId !== 'string' || typeof detail.phase !== 'string') {
            throw new StateCorruptError('file preparation receipt is malformed');
          }
          latestByPreparation.set(`${NATIVE_REPLY_FILE_PREPARATION}\u0000${detail.preparationId}`, {
            kind: NATIVE_REPLY_FILE_PREPARATION,
            detail
          });
        }
        const existing = rows.filter(row => row.detail.requestId === seed.requestId).at(-1);
        if (existing && existing.detail.phase === DIRECT_POST_FILE_PHASES.RELEASED) {
          throw new BindingError('direct post file request key was already released');
        }
        if (existing && existing.detail.phase !== DIRECT_POST_FILE_PHASES.RELEASED) {
          assertFileIdentity(existing.detail, seed, BindingError);
          return existing.detail as unknown as DirectPostFilePreparation;
        }
        const active = typeof state.activeFilePreparationCount === 'function'
          ? state.activeFilePreparationCount()
          : [...latestByPreparation.values()].filter(({ detail }) => detail.reservesCapacity !== false &&
            detail.phase !== DIRECT_POST_FILE_PHASES.RELEASED).length;
        if (active >= DIRECT_POST_FILE_LIMITS.maxReservations) {
          const held = [...latestByPreparation.values()]
            .filter(({ detail }) => detail.reservesCapacity !== false && detail.phase !== DIRECT_POST_FILE_PHASES.RELEASED)
            .map(({ kind, detail }) => kind === DIRECT_POST_FILE_PREPARATION
              ? { preparationId: detail.preparationId, requestId: detail.requestId, phase: detail.phase }
              : { preparationId: detail.preparationId, messageId: detail.messageId, phase: detail.phase });
          throw new BindingError(`direct post file capacity is exhausted: ${JSON.stringify(held)}`);
        }
        const next = {
          journal: 'direct-post-v1',
          ...seed,
          phase: DIRECT_POST_FILE_PHASES.PREPARING,
          sha256: ''
        };
        state.receipt(null, DIRECT_POST_FILE_PREPARATION, next);
        return next as unknown as DirectPostFilePreparation;
      });
    },

    admitDirectPostFilePreparation(state, preparationId, manifest) {
      assertText(preparationId, 'preparationId', 128);
      if (!manifest || manifest.preparationId !== preparationId || manifest.size < 0 || manifest.size > DIRECT_POST_FILE_LIMITS.maxBytes) {
        throw new BindingError('direct post file manifest is invalid');
      }
      return state.transaction(() => {
        const existing = latestFilePreparation(state, DIRECT_POST_FILE_PREPARATION, parseJson, StateCorruptError, preparationId);
        if (!existing) throw new BindingError('direct post file preparation is unknown');
        if (existing.detail.phase === DIRECT_POST_FILE_PHASES.ADMITTED) {
          assertFileIdentity(existing.detail, manifest, BindingError);
          if (existing.detail.sha256 !== manifest.sha256) throw new BindingError('direct post file preparation hash cannot change');
          return existing.detail as unknown as DirectPostFilePreparation;
        }
        if (existing.detail.phase !== DIRECT_POST_FILE_PHASES.PREPARING) throw new BindingError('direct post file preparation is not open');
        assertFileIdentity(existing.detail, manifest, BindingError);
        const next = { ...existing.detail, ...manifest, phase: DIRECT_POST_FILE_PHASES.ADMITTED };
        state.receipt(null, DIRECT_POST_FILE_PREPARATION, next);
        return next as unknown as DirectPostFilePreparation;
      });
    },

    releaseDirectPostFilePreparation(state, preparationId, removeFile) {
      assertText(preparationId, 'preparationId', 128);
      return state.transaction(() => {
        const existing = latestFilePreparation(state, DIRECT_POST_FILE_PREPARATION, parseJson, StateCorruptError, preparationId);
        if (!existing) throw new BindingError('direct post file preparation is unknown');
        if (existing.detail.phase === DIRECT_POST_FILE_PHASES.RELEASED) return existing.detail as unknown as DirectPostFilePreparation;
        if (existing.detail.phase !== DIRECT_POST_FILE_PHASES.PREPARING && existing.detail.phase !== DIRECT_POST_FILE_PHASES.ADMITTED) {
          throw new BindingError('direct post file preparation cannot be cleaned up');
        }
        if (existing.detail.phase === DIRECT_POST_FILE_PHASES.PREPARING) {
          const ownerPid = Number(existing.detail.ownerPid);
          if (!Number.isInteger(ownerPid) || ownerPid < 1) throw new BindingError('preparing file cleanup requires an owner identity');
          const ownerIdentity = {
            ownerPid,
            ownerStartTime: typeof existing.detail.ownerStartTime === 'string' ? existing.detail.ownerStartTime : null,
            ownerCommand: typeof existing.detail.ownerCommand === 'string' ? existing.detail.ownerCommand : null
          };
          if (state.directPostOwnerAlive(ownerPid, ownerIdentity)) {
            throw new BindingError('direct post file preparation owner is still active');
          }
        }
        const requestId = typeof existing.detail.requestId === 'string' ? existing.detail.requestId : null;
        if (!requestId) throw new StateCorruptError('direct post file preparation request id is malformed');
        const attempts = state.directPostRows(requestId)
          .filter(row => row.kind === DIRECT_POST_ATTEMPT);
        const outcomes = new Map(state.directPostRows(requestId)
          .filter(row => row.kind === DIRECT_POST_OUTCOME && row.detail.attemptId)
          .map(row => [row.detail.attemptId, row.detail.outcome]));
        if (attempts.some(row => !outcomes.has(row.detail.attemptId) || outcomes.get(row.detail.attemptId) === 'unknown')) {
          throw new BindingError('direct post file cleanup requires a resolved network outcome');
        }
        removeFile(existing.detail as unknown as DirectPostFilePreparation);
        const next = { ...existing.detail, phase: DIRECT_POST_FILE_PHASES.RELEASED, releasedAt: now() };
        state.receipt(null, DIRECT_POST_FILE_PREPARATION, next);
        return next as unknown as DirectPostFilePreparation;
      });
    }
  };
  return handlers;
}
