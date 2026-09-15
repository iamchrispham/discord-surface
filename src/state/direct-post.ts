import type { AgentMessage, AgentProvider } from '../agent-message';

export const DIRECT_POST_OUTCOMES = Object.freeze([
  'sent',
  'not_sent',
  'rejected',
  'rate_limited',
  'unknown',
  'stale'
] as const);

export type DirectPostOutcome = typeof DIRECT_POST_OUTCOMES[number];

export type DirectPostPartStatus = DirectPostOutcome | 'claimed' | 'in_flight';

export interface DirectPostBinding {
  active: boolean;
  channelId: string;
  guildId: string;
  provider: AgentProvider;
  nativeId: string;
  generation: number;
  conductorId?: string | null;
  repoKey?: string | null;
}

export interface DirectPostPartMeta {
  requestId: string;
  inReplyTo: string | null;
  attemptId: string;
  sourcePath: string;
  textHash: string;
  operatorId: string;
  partHash: string;
  channelId: string;
  guildId: string;
  provider: AgentProvider;
  nativeId: string;
  generation: number;
  conductorId?: string | null;
  repoKey?: string | null;
  partIndex: number;
  partCount: number;
  nonce: string;
  binding: DirectPostBinding;
  deliveryChannelId?: string;
  agentPacket?: AgentMessage;
}

export interface DirectPostReceiptDetail {
  [key: string]: unknown;
  journal?: string;
  attemptId?: string;
  inReplyTo?: string | null;
  outcome?: string;
  messageId?: string;
  nonce?: string;
}

export interface DirectPostReceiptRow {
  id: number;
  kind: string;
  detail: DirectPostReceiptDetail;
  createdAt: string;
}

export interface DirectPostState {
  db: DirectPostDatabase;
  transaction<T>(operation: () => T): T;
  directPostRows(requestId?: string | null, channelId?: string | null): DirectPostReceiptRow[];
  directPostBindingCurrent(binding: DirectPostBinding, operatorId?: string | null): boolean;
  directPostOwnerIdentity(pid: number): DirectPostOwnerIdentity | null;
  receipt(discordId: string | null, kind: string, detail: Record<string, unknown>): void;
}

export interface SentAgentResultRow {
  attemptReceiptId: number;
  outcomeReceiptId: number;
  messageId?: string;
  nonce?: string;
  attemptDetail: DirectPostReceiptDetail;
  outcomeDetail: DirectPostReceiptDetail;
}

export interface DirectPostOwnerIdentity {
  ownerPid: number;
  ownerStartTime: string | null;
  ownerCommand: string | null;
}

export interface DirectPostInspection {
  claimed: false;
  status: string;
  attemptId: string;
  nonce: string;
  outcome?: DirectPostReceiptDetail;
}

export interface DirectPostClaim {
  claimed: true;
  status: 'claimed';
  attemptId: string;
  nonce: string;
}

export interface DirectPostEvent {
  id?: unknown;
  channelId?: unknown;
  guildId?: unknown;
  isBot?: unknown;
  nonce?: unknown;
}

type DirectPostOutcomeKey = 'messageId' | 'nonce';
type DirectPostReconciliationResolution = 'sent' | 'not_sent';
type DirectPostMatchEvent = Omit<DirectPostEvent, 'channelId' | 'guildId'> & {
  channelId: string;
  guildId: string;
};
type DirectPostCustodyKey = keyof DirectPostPartMeta | keyof DirectPostOwnerIdentity | 'journal';
type DirectPostOutcomeDetail = Record<string, unknown> & {
  [key in DirectPostCustodyKey]?: never;
};

export interface DirectPostOutcomeRecord extends DirectPostReceiptDetail {
  outcome: DirectPostOutcome;
}

export interface DirectPostHandlers {
  hasUnresolvedOrdinaryPost(state: DirectPostState, channelId: string): boolean;
  inspectDirectPostPart(state: DirectPostState, meta: DirectPostPartMeta): DirectPostInspection | null;
  recordDirectPostPreflight(state: DirectPostState, meta: DirectPostPartMeta, outcome: DirectPostOutcome, detail?: Record<string, unknown>): DirectPostOutcomeRecord;
  beginDirectPostPart(state: DirectPostState, meta: DirectPostPartMeta): DirectPostClaim | DirectPostInspection;
  recordDirectPostOutcome(state: DirectPostState, requestId: string, attemptId: string, outcome: DirectPostOutcome, detail?: DirectPostOutcomeDetail): DirectPostOutcomeRecord;
  reconcileDirectPostOutcome(state: DirectPostState, requestId: string, attemptId: string, resolution: DirectPostReconciliationResolution, evidence: Record<string, unknown>): DirectPostOutcomeRecord;
  directPostOutcomeMatches(state: DirectPostState, event: DirectPostMatchEvent, key: DirectPostOutcomeKey, value: string): boolean;
  excludeDirectPost(this: DirectPostHandlers, state: DirectPostState, event: DirectPostEvent | null | undefined): boolean;
}

interface SqlRow {
  [key: string]: unknown;
}

interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...parameters: unknown[]): T[];
}

interface DirectPostDatabase {
  prepare(sql: string): SqlStatement;
}

interface RawReceiptRow extends SqlRow {
  id: number;
  kind: string;
  detail: unknown;
  created_at: string;
}

interface RawOutcomeRow extends SqlRow {
  detail: unknown;
}

interface RawAgentResultRow extends SqlRow {
  attempt_receipt_id: number;
  outcome_receipt_id: number;
  attempt_detail: unknown;
  outcome_detail: unknown;
}

interface DirectPostErrorConstructor {
  new (message: string): Error;
}

interface DirectPostQueryDependencies {
  db: DirectPostDatabase;
  assertText(value: unknown, name: string, max?: number): string;
  parseJson(value: unknown, fallback: null): DirectPostReceiptDetail | null;
  StateCorruptError: DirectPostErrorConstructor;
  attemptKind: string;
  outcomeKind: string;
}

interface DirectPostDependencies {
  BindingError: DirectPostErrorConstructor;
  StaleGenerationError: DirectPostErrorConstructor;
  StateCorruptError: DirectPostErrorConstructor;
  DIRECT_POST_ATTEMPT: string;
  DIRECT_POST_OUTCOME: string;
  assertText(value: unknown, name: string, max?: number): string;
  bindingMatchesExpected(binding: DirectPostBinding | null, expected: DirectPostBinding | null): boolean;
  parseJson(value: unknown, fallback: null): DirectPostReceiptDetail | null;
  now(): string;
  DIRECT_POST_OUTCOMES?: typeof DIRECT_POST_OUTCOMES;
}

const identityKeys: readonly (keyof DirectPostPartMeta)[] = [
  'textHash', 'inReplyTo', 'channelId', 'guildId', 'provider', 'nativeId', 'generation',
  'conductorId', 'repoKey', 'partCount', 'deliveryChannelId', 'agentPacket'
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

function assertImmutableDetail(expected: DirectPostPartMeta, detail: Record<string, unknown>, BindingError: DirectPostErrorConstructor): void {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw new BindingError('direct post outcome detail is invalid');
  const keys: readonly string[] = [...identityKeys, 'attemptId', 'ownerPid', 'ownerStartTime', 'ownerCommand', 'journal'];
  for (const key of keys) {
    if (!Object.hasOwn(detail, key)) continue;
    const expectedValue = key === 'journal' ? 'direct-post-v1' : (expected as unknown as Record<string, unknown>)[key];
    const missingAgentPacket = key === 'agentPacket' && expectedValue !== undefined && expectedValue !== null &&
      (detail[key] === undefined || detail[key] === null);
    if (missingAgentPacket || !identityKeyValueMatches(key, detail[key], expectedValue)) {
      throw new BindingError(`direct post outcome cannot override immutable ${key}`);
    }
  }
  if (Object.hasOwn(detail, 'outcome')) throw new BindingError('direct post outcome cannot override immutable outcome');
}

export function queryDirectPostRows(
  { db, assertText, parseJson, StateCorruptError, attemptKind, outcomeKind }: DirectPostQueryDependencies,
  requestId: string | null = null,
  channelId: string | null = null
): DirectPostReceiptRow[] {
  if (requestId !== null) assertText(requestId, 'requestId', 256);
  if (channelId !== null) assertText(channelId, 'channelId', 128);
  const clauses = ['discord_id IS NULL', 'kind IN (?, ?)'];
  const parameters: unknown[] = [attemptKind, outcomeKind];
  if (requestId !== null) {
    clauses.push("json_extract(detail, '$.requestId')=?");
    parameters.push(requestId);
  }
  if (channelId !== null) {
    clauses.push("json_extract(detail, '$.channelId')=?");
    parameters.push(channelId);
  }
  const rows = db.prepare(`SELECT id, kind, detail, created_at FROM receipts
    WHERE ${clauses.join(' AND ')} ORDER BY id`).all<RawReceiptRow>(...parameters);
  return rows.map(row => {
    const detail = parseJson(row.detail, null);
    if (!detail || detail.journal !== 'direct-post-v1') throw new StateCorruptError('direct post receipt is malformed');
    if (detail.inReplyTo === undefined) detail.inReplyTo = null;
    return { id: Number(row.id), kind: row.kind, detail, createdAt: row.created_at };
  });
}

export function querySentAgentResultRows(
  { db, parseJson, attemptKind, outcomeKind }: DirectPostQueryDependencies,
  request: AgentMessage,
  channelId: string,
  limit = 64
): SentAgentResultRow[] {
  const source = request.target;
  const target = request.source;
  const packetFields = [
    ['kind', 'result'],
    ['replyTo', request.id],
    ['source.guildId', source.guildId],
    ['source.channelId', source.channelId],
    ['source.provider', source.provider],
    ['source.nativeId', source.nativeId],
    ['source.generation', source.generation],
    ['target.guildId', target.guildId],
    ['target.channelId', target.channelId],
    ['target.provider', target.provider],
    ['target.nativeId', target.nativeId],
    ['target.generation', target.generation]
  ] as const;
  const clauses = [
    'attempt.discord_id IS NULL',
    'outcome.discord_id IS NULL',
    'attempt.kind=?',
    'outcome.kind=?',
    "json_extract(attempt.detail, '$.journal')='direct-post-v1'",
    "json_extract(outcome.detail, '$.journal')='direct-post-v1'",
    "json_extract(outcome.detail, '$.attemptId')=json_extract(attempt.detail, '$.attemptId')",
    "json_extract(outcome.detail, '$.outcome')='sent'",
    "((typeof(json_extract(outcome.detail, '$.messageId'))='text' AND json_extract(outcome.detail, '$.messageId')<>'') OR (typeof(json_extract(outcome.detail, '$.nonce'))='text' AND json_extract(outcome.detail, '$.nonce')<>'' AND json_extract(outcome.detail, '$.nonce')=json_extract(attempt.detail, '$.nonce')))",
    "json_extract(attempt.detail, '$.channelId')=?"
  ];
  const parameters: unknown[] = [outcomeKind, attemptKind, channelId];
  for (const [field, value] of packetFields) {
    clauses.push(`json_extract(attempt.detail, '$.agentPacket.${field}')=?`);
    parameters.push(value);
    clauses.push(`json_extract(outcome.detail, '$.agentPacket.${field}')=?`);
    parameters.push(value);
  }
  const boundedLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 64) : 64;
  const rows = db.prepare(`SELECT attempt.id AS attempt_receipt_id, outcome.id AS outcome_receipt_id,
      outcome.detail AS outcome_detail, attempt.detail AS attempt_detail
    FROM receipts AS attempt
    JOIN receipts AS outcome
      ON outcome.discord_id IS NULL
     AND outcome.kind=?
     AND json_extract(outcome.detail, '$.attemptId')=json_extract(attempt.detail, '$.attemptId')
    WHERE ${clauses.filter(clause => clause !== 'outcome.kind=?').join(' AND ')}
    ORDER BY outcome.id DESC LIMIT ?`).all(parameters[0], ...parameters.slice(1), boundedLimit) as RawAgentResultRow[];
  return rows.flatMap(row => {
    const attemptDetail = parseJson(row.attempt_detail, null);
    const outcomeDetail = parseJson(row.outcome_detail, null);
    const messageId = typeof outcomeDetail?.messageId === 'string' && outcomeDetail.messageId ? outcomeDetail.messageId : null;
    const nonce = typeof outcomeDetail?.nonce === 'string' && outcomeDetail.nonce && outcomeDetail.nonce === attemptDetail?.nonce
      ? outcomeDetail.nonce
      : null;
    if (!attemptDetail || !outcomeDetail || (!messageId && !nonce)) return [];
    return [{
      attemptReceiptId: Number(row.attempt_receipt_id),
      outcomeReceiptId: Number(row.outcome_receipt_id),
      ...(messageId ? { messageId } : {}),
      ...(nonce ? { nonce } : {}),
      attemptDetail,
      outcomeDetail
    }];
  });
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
    assertText,
    bindingMatchesExpected,
    parseJson,
    now
  } = dependencies;

  function inspectPart(state: DirectPostState, meta: DirectPostPartMeta): DirectPostInspection | null {
    const rows = state.directPostRows(meta.requestId);
    for (const row of rows) {
      for (const key of identityKeys) {
        if (!identityKeyValueMatches(key, row.detail[key], meta[key])) throw new BindingError('direct post request identity conflicts with existing custody');
      }
    }
    if (!state.directPostBindingCurrent(meta.binding, meta.operatorId)) throw new StaleGenerationError('direct post binding is stale');
    const attempts = rows.filter(row => row.kind === DIRECT_POST_ATTEMPT && row.detail.partIndex === meta.partIndex).sort((a, b) => a.id - b.id);
    const outcomes = new Map<unknown, DirectPostReceiptRow>(rows.filter(row => row.kind === DIRECT_POST_OUTCOME && row.detail.attemptId)
      .map(row => [row.detail.attemptId, row]));
    const latest = attempts.at(-1);
    if (!latest) return null;
    const outcome = outcomes.get(latest.detail.attemptId);
    if (!outcome) return { claimed: false, status: 'in_flight', attemptId: latest.detail.attemptId as string, nonce: latest.detail.nonce as string };
    const status = outcome.detail.outcome as string;
    if (status === 'sent' || status === 'unknown') {
      return { claimed: false, status, attemptId: latest.detail.attemptId as string, nonce: latest.detail.nonce as string, outcome: outcome.detail };
    }
    if (!['not_sent', 'rejected', 'rate_limited', 'stale'].includes(status)) {
      return { claimed: false, status, attemptId: latest.detail.attemptId as string, nonce: latest.detail.nonce as string, outcome: outcome.detail };
    }
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
      assertImmutableDetail(meta, detail, BindingError);
      return state.transaction(() => {
        const rows = state.directPostRows(meta.requestId);
        for (const row of rows) {
          for (const key of identityKeys) {
            if (!identityKeyValueMatches(key, row.detail[key], meta[key])) throw new BindingError('direct post request identity conflicts with existing custody');
          }
        }
        const { attemptId: _attemptId, ...preflightMeta } = meta;
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
        assertImmutableDetail(attempt.detail as unknown as DirectPostPartMeta, detail, BindingError);
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
    }
  };
  return handlers;
}
