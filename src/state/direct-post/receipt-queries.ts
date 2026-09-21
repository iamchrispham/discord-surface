import type { AgentMessage } from '../../agent-message';
import type {
  DirectPostState, DirectPostDependencies, DirectPostErrorConstructor,
  DirectPostReceiptRow, RawReceiptRow, DirectPostQueryDependencies,
  SentAgentResultRow, RawAgentResultRow
} from './contracts';

export function queryFilePreparationRows(state: DirectPostState, kind: string, parseJson: DirectPostDependencies['parseJson'], StateCorruptError: DirectPostErrorConstructor,
  preparationId: string | null = null, requestId: string | null = null): DirectPostReceiptRow[] {
  const clauses = ['discord_id IS NULL', 'kind=?'];
  const parameters: unknown[] = [kind];
  if (preparationId !== null) { clauses.push("json_extract(detail, '$.preparationId')=?"); parameters.push(preparationId); }
  if (requestId !== null) { clauses.push("json_extract(detail, '$.requestId')=?"); parameters.push(requestId); }
  const rows = state.db.prepare(`SELECT id, kind, detail, created_at FROM receipts WHERE ${clauses.join(' AND ')} ORDER BY id`)
    .all<RawReceiptRow>(...parameters);
  return rows.map(row => {
    const detail = parseJson(row.detail, null);
    if (!detail || detail.journal !== 'direct-post-v1' || typeof detail.phase !== 'string') {
      throw new StateCorruptError('direct post file preparation receipt is malformed');
    }
    return { id: Number(row.id), kind: row.kind, detail, createdAt: row.created_at };
  });
}

export function latestFilePreparation(state: DirectPostState, kind: string, parseJson: DirectPostDependencies['parseJson'], StateCorruptError: DirectPostErrorConstructor,
  preparationId: string): DirectPostReceiptRow | null {
  return queryFilePreparationRows(state, kind, parseJson, StateCorruptError, preparationId).at(-1) || null;
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
  limit = 64,
  allowLegacyChildSource = false,
  requestReceiptId = 0
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
  if (Number.isSafeInteger(requestReceiptId) && requestReceiptId > 0) {
    clauses.push('outcome.id > ?');
    parameters.push(requestReceiptId);
  }
  for (const [field, value] of packetFields) {
    if (allowLegacyChildSource && field === 'source.channelId') {
      const requestTargetFields = packetFields.filter(([key]) => key.startsWith('source.'));
      for (const receipt of ['attempt', 'outcome']) {
        const sourceChannel = `json_extract(${receipt}.detail, '$.agentPacket.source.channelId')`;
        const requestTarget = `json_extract(${receipt}.detail, '$.agentRequestTarget')`;
        const originalTarget = requestTargetFields.map(([key]) =>
          `json_extract(${receipt}.detail, '$.agentRequestTarget.${key.slice('source.'.length)}')=?`);
        clauses.push(`(${sourceChannel}=? OR (${sourceChannel}<>? AND (${requestTarget} IS NULL OR ${originalTarget.join(' AND ')})))`);
        parameters.push(value, value, ...requestTargetFields.map(([, targetValue]) => targetValue));
      }
      clauses.push("json_extract(attempt.detail, '$.agentPacket.source.channelId')=json_extract(outcome.detail, '$.agentPacket.source.channelId')");
      continue;
    }
    clauses.push(`json_extract(attempt.detail, '$.agentPacket.${field}')=?`);
    parameters.push(value);
    clauses.push(`json_extract(outcome.detail, '$.agentPacket.${field}')=?`);
    parameters.push(value);
  }
  const boundedLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 64) : 64;
  const query = `SELECT attempt.id AS attempt_receipt_id, outcome.id AS outcome_receipt_id,
      outcome.detail AS outcome_detail, attempt.detail AS attempt_detail
    FROM receipts AS attempt
    JOIN receipts AS outcome
      ON outcome.discord_id IS NULL
     AND outcome.kind=?
     AND json_extract(outcome.detail, '$.attemptId')=json_extract(attempt.detail, '$.attemptId')
    WHERE ${clauses.filter(clause => clause !== 'outcome.kind=?').join(' AND ')}
    ORDER BY outcome.id DESC LIMIT ? OFFSET ?`;
  const rows: RawAgentResultRow[] = [];
  let offset = 0;
  while (true) {
    const page = db.prepare(query).all(parameters[0], ...parameters.slice(1), boundedLimit, offset) as RawAgentResultRow[];
    rows.push(...page);
    if (!allowLegacyChildSource || page.length < boundedLimit) break;
    offset += page.length;
  }
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
