import {
  UNRESOLVED_OUTCOMES,
  OUTCOME_VALUES,
  parseDetail,
  readReceipts,
  targetMatches,
  revisionOf,
  latestOutcome,
  rowRecord,
  currentRevision,
  unresolvedAttempt,
  duplicateRecord
} from './board-refresh/receipt-projection';
import * as crypto from 'node:crypto';
import { boardTextEquivalent } from '../board-text';
import {
  BOARD_RECEIPT_KINDS,
  BOARD_OUTCOMES,
  type BoardOutcome,
  type BoardTerminalOutcome,
  type BoardBinding,
  type BoardConfig,
  type BoardState,
  type BoardTarget,
  type BoardProvenance,
  type BoardOwner,
  type BoardRefreshMeta,
  type BoardRefreshAttempt,
  type BoardRefreshRecord,
  type BoardRevisionSnapshot,
  type BoardAdmission,
  type BoardRecoveryEvidence,
  type ReceiptRow
} from './board-refresh/contracts';
export { BOARD_RECEIPT_KINDS, BOARD_OUTCOMES } from './board-refresh/contracts';
export type { BoardOutcome, BoardTerminalOutcome, BoardBinding, BoardConfig, BoardState, BoardTarget, BoardProvenance, BoardOwner, BoardRefreshMeta, BoardRefreshAttempt, BoardRefreshRecord, BoardRevisionSnapshot, BoardAdmission, BoardRecoveryEvidence } from './board-refresh/contracts';

function text(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function messageId(value: unknown, name = 'messageId'): string {
  return text(value, name, 128);
}

function generation(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('generation must be a positive integer');
  return parsed;
}

function assertTarget(target: BoardTarget): BoardTarget {
  return {
    guildId: text(target?.guildId, 'guildId', 128),
    channelId: text(target?.channelId, 'channelId', 128),
    messageId: messageId(target?.messageId, 'messageId')
  };
}

function assertBinding(binding: BoardBinding): BoardBinding {
  if (!binding?.active) throw new Error('board refresh requires an active binding');
  text(binding.channelId, 'binding.channelId', 128);
  text(binding.guildId, 'binding.guildId', 128);
  text(binding.provider, 'binding.provider', 32);
  text(binding.nativeId, 'binding.nativeId', 128);
  generation(binding.generation);
  return binding;
}

function bindingMatches(left: BoardBinding | null, right: BoardBinding): boolean {
  if (!left?.active) return false;
  return left.channelId === right.channelId && left.guildId === right.guildId &&
    left.provider === right.provider && left.nativeId === right.nativeId && left.generation === right.generation &&
    (left.sessionRoot || null) === (right.sessionRoot || null) &&
    (left.conductorId || null) === (right.conductorId || null) &&
    (left.repoKey || null) === (right.repoKey || null);
}

function ownerFor(binding: BoardBinding): BoardOwner {
  return {
    guildId: binding.guildId,
    channelId: binding.channelId,
    provider: binding.provider,
    nativeId: binding.nativeId,
    generation: binding.generation,
    conductorId: binding.conductorId || null,
    repoKey: binding.repoKey || null
  };
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function validateOutcome(value: unknown): BoardOutcome {
  const outcome = text(value, 'outcome', 32);
  if (!OUTCOME_VALUES.has(outcome)) throw new Error('invalid board refresh outcome');
  return outcome as BoardOutcome;
}

function boardContent(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 2000) throw new Error(`${field} is invalid`);
  return value;
}

function operationEndedAt(value: unknown): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : new Date().toISOString();
}

function readbackInstant(value: unknown): string {
  const input = text(value, 'observedAt', 64).replace('t', 'T').replace(/z$/, 'Z');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|([+-])(\d{2}):?(\d{2}))$/.exec(input);
  if (!match || /-00:?00$/.test(input)) throw new Error('observedAt must be a timezone-qualified ISO timestamp');
  const hours = Number(match[5] || 0);
  const minutes = Number(match[6] || 0);
  const instant = Date.parse(input.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  const offsetMinutes = (match[4] === '-' ? -1 : 1) * (hours * 60 + minutes);
  if (hours > 23 || minutes > 59 || !Number.isFinite(instant)) {
    throw new Error('observedAt must be a timezone-qualified ISO timestamp');
  }
  const localInstant = instant + offsetMinutes * 60_000;
  const localTime = new Date(localInstant).toISOString().slice(0, 19);
  const endOfDay = /T24:00(?::00(?:\.0{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(input) &&
    new Date(localInstant - 86_400_000).toISOString().slice(0, 19) === `${match[1].slice(0, 10)}T00:00:00`;
  if (localTime !== `${match[1]}:${match[2] || '00'}` && !endOfDay) {
    throw new Error('observedAt must be a timezone-qualified ISO timestamp');
  }
  return new Date(instant).toISOString();
}

function validateMeta(meta: BoardRefreshMeta): BoardRefreshMeta {
  text(meta?.requestId, 'requestId', 256);
  const target = assertTarget(meta?.target);
  const binding = assertBinding(meta?.binding);
  if (binding.channelId !== target.channelId || binding.guildId !== target.guildId) throw new Error('board target does not match the bound guild and channel');
  const content = boardContent(meta.content, 'content');
  if (!content.trim()) throw new Error('content must contain non-whitespace text');
  if (typeof meta.preEditContent !== 'string' || meta.preEditContent.length > 2000) throw new Error('preEditContent is invalid');
  text(meta.payloadHash, 'payloadHash', 128);
  text(meta.targetAuthorId, 'targetAuthorId', 128);
  if (!meta.provenance || meta.provenance.messageId !== target.messageId || meta.provenance.channelId !== target.channelId || meta.provenance.guildId !== target.guildId) {
    throw new Error('board target provenance does not match the explicit target');
  }
  return { ...meta, target, binding };
}

function captureBoardRevision(state: BoardState, rawTarget: BoardTarget): BoardRevisionSnapshot {
  const target = assertTarget(rawTarget);
  const rows = readReceipts(state);
  return { target, revision: currentRevision(rows, target) };
}

function inspectBoardRequest(state: BoardState, requestId: string, rawTarget: BoardTarget): BoardAdmission | null {
  const target = assertTarget(rawTarget);
  text(requestId, 'requestId', 256);
  return duplicateRecord(readReceipts(state), requestId, target);
}

function boardMessageProvenance(state: BoardState, rawTarget: BoardTarget): BoardProvenance[] {
  const target = assertTarget(rawTarget);
  const direct = state.db.prepare(`SELECT detail, created_at FROM receipts
    WHERE kind='direct-post-outcome' AND json_extract(detail, '$.messageId')=?
      AND json_extract(detail, '$.outcome')='sent' ORDER BY id`).all(target.messageId);
  const directProvenance: BoardProvenance[] = direct.flatMap(row => {
    const detail = parseDetail(row.detail);
    const destinationChannel = typeof detail.deliveryChannelId === 'string' ? detail.deliveryChannelId : detail.channelId;
    if (detail.guildId !== target.guildId || destinationChannel !== target.channelId) return [];
    return [{
      source: 'direct-post',
      messageId: target.messageId,
      channelId: target.channelId,
      guildId: target.guildId,
      requestId: typeof detail.requestId === 'string' ? detail.requestId : undefined,
      attemptId: typeof detail.attemptId === 'string' ? detail.attemptId : undefined,
      generation: Number.isSafeInteger(Number(detail.generation)) ? Number(detail.generation) : undefined,
      provider: typeof detail.provider === 'string' ? detail.provider : undefined
    }];
  });
  const replies = state.db.prepare(`SELECT rp.discord_id AS source_message_id, m.guild_id, m.channel_id,
      m.provider, m.generation, rp.message_id
    FROM reply_parts rp JOIN messages m ON m.discord_id=rp.discord_id
    WHERE rp.message_id=? AND rp.state='sent'`).all(target.messageId);
  const replyProvenance: BoardProvenance[] = replies.flatMap(row => {
    if (row.guild_id !== target.guildId || row.channel_id !== target.channelId) return [];
    return [{
      source: 'reply',
      messageId: target.messageId,
      channelId: target.channelId,
      guildId: target.guildId,
      sourceMessageId: String(row.source_message_id),
      generation: Number(row.generation),
      provider: typeof row.provider === 'string' ? row.provider : undefined
    }];
  });
  return [...directProvenance, ...replyProvenance];
}

function recoverOrphanBoardRefreshAttempt(state: BoardState, attempt: ReceiptRow, ownerAlive: ((pid: number, identity: unknown) => boolean) | null): number {
  const pid = Number(attempt.detail.ownerPid);
  const identity = attempt.detail.ownerIdentity;
  if (ownerAlive && Number.isInteger(pid) && pid > 0 && ownerAlive(pid, identity)) return 0;
  const ended = new Date().toISOString();
  state.receipt(null, BOARD_RECEIPT_KINDS.OUTCOME, {
    ...attempt.detail,
    outcome: BOARD_OUTCOMES.UNKNOWN,
    status: BOARD_OUTCOMES.UNKNOWN,
    operationEndedAt: ended,
    reason: 'process stopped before board refresh outcome'
  });
  return 1;
}

function recoverBoardRefreshReceipts(state: BoardState, ownerAlive: ((pid: number, identity: unknown) => boolean) | null = null, inTransaction = false): number {
  const recover = (): number => {
    const rows = readReceipts(state, [BOARD_RECEIPT_KINDS.ATTEMPT, BOARD_RECEIPT_KINDS.OUTCOME]);
    let count = 0;
    for (const attempt of rows.filter(row => row.kind === BOARD_RECEIPT_KINDS.ATTEMPT)) {
      const attemptId = String(attempt.detail.attemptId || '');
      if (!attemptId || latestOutcome(rows, attemptId)) continue;
      count += recoverOrphanBoardRefreshAttempt(state, attempt, ownerAlive);
    }
    return count;
  };
  return inTransaction ? recover() : state.transaction(recover);
}

function recoverBoardRefreshAttempt(state: BoardState, targetInput: BoardTarget, attemptIdInput: string, ownerAlive: ((pid: number, identity: unknown) => boolean) | null = null): number {
  const target = assertTarget(targetInput);
  const attemptId = text(attemptIdInput, 'attemptId', 128);
  return state.transaction(() => {
    const rows = readReceipts(state, [BOARD_RECEIPT_KINDS.ATTEMPT, BOARD_RECEIPT_KINDS.OUTCOME]);
    const attempt = rows.find(row => row.kind === BOARD_RECEIPT_KINDS.ATTEMPT && String(row.detail.attemptId) === attemptId && targetMatches(row.detail, target));
    if (!attempt || latestOutcome(rows, attemptId)) return 0;
    return recoverOrphanBoardRefreshAttempt(state, attempt, ownerAlive);
  });
}

function beginBoardRefresh(state: BoardState, metaInput: BoardRefreshMeta, capturedRevision: number): BoardAdmission {
  const meta = validateMeta(metaInput);
  if (!Number.isSafeInteger(capturedRevision) || capturedRevision < 0) throw new Error('captured board revision must be a non-negative integer');
  return state.transaction(() => {
    const config = state.requireConfig();
    const binding = state.getBinding(meta.target.channelId);
    if (config.guildId !== meta.target.guildId || !bindingMatches(binding, meta.binding)) {
      return {
        status: BOARD_OUTCOMES.STALE,
        requestId: meta.requestId,
        targetMessageId: meta.target.messageId,
        reason: 'binding changed before board refresh admission'
      };
    }
    const rows = readReceipts(state);
    const duplicate = duplicateRecord(rows, meta.requestId, meta.target);
    if (duplicate) {
      if (duplicate.attempt && duplicate.attempt.payloadHash !== meta.payloadHash &&
          (typeof duplicate.attempt.content !== 'string' || !boardTextEquivalent(duplicate.attempt.content, meta.content))) {
        throw new Error('dedupe key is already used for another board payload');
      }
      return duplicate;
    }
    const revision = currentRevision(rows, meta.target);
    if (revision !== capturedRevision) {
      return {
        status: BOARD_OUTCOMES.STALE,
        requestId: meta.requestId,
        targetMessageId: meta.target.messageId,
        revision,
        reason: 'board revision changed before admission'
      };
    }
    const unresolved = unresolvedAttempt(rows, meta.target);
    if (unresolved) {
      const unresolvedOutcome = latestOutcome(rows, String(unresolved.detail.attemptId));
      const status = unresolvedOutcome ? validateOutcome(unresolvedOutcome.detail.outcome) : BOARD_OUTCOMES.IN_FLIGHT;
      return {
        status,
        requestId: meta.requestId,
        targetMessageId: meta.target.messageId,
        revision: revisionOf(unresolved.detail),
        attemptId: String(unresolved.detail.attemptId),
        attempt: unresolved.detail as unknown as BoardRefreshAttempt,
        outcome: status,
        reason: 'another board refresh for this target is unresolved'
      };
    }
    const nextRevision = revision + 1;
    const attempt: BoardRefreshAttempt = {
      journal: 'board-refresh-v1',
      board: 'compact-status-board',
      operation: 'message.patch',
      requestId: meta.requestId,
      dedupeKey: meta.requestId,
      attemptId: crypto.randomUUID(),
      guildId: meta.target.guildId,
      channelId: meta.target.channelId,
      targetMessageId: meta.target.messageId,
      provider: meta.binding.provider,
      nativeId: meta.binding.nativeId,
      generation: meta.binding.generation,
      conductorId: meta.binding.conductorId || null,
      repoKey: meta.binding.repoKey || null,
      content: meta.content,
      preEditContent: meta.preEditContent,
      payloadHash: meta.payloadHash || hashContent(meta.content),
      baseRevision: revision,
      revision: nextRevision,
      targetAuthorId: meta.targetAuthorId,
      provenance: meta.provenance,
      originalOwner: ownerFor(meta.binding),
      ...(meta.ownerPid === undefined ? {} : { ownerPid: meta.ownerPid }),
      ...(meta.ownerIdentity === undefined ? {} : { ownerIdentity: meta.ownerIdentity }),
      status: BOARD_OUTCOMES.IN_FLIGHT,
      outcome: BOARD_OUTCOMES.IN_FLIGHT
    };
    const designation = rows.find(row => row.kind === BOARD_RECEIPT_KINDS.DESIGNATION && targetMatches(row.detail, meta.target));
    if (!designation) {
      state.receipt(null, BOARD_RECEIPT_KINDS.DESIGNATION, {
        journal: 'board-refresh-v1',
        board: 'compact-status-board',
        designation: 'explicit-target',
        guildId: meta.target.guildId,
        channelId: meta.target.channelId,
        targetMessageId: meta.target.messageId,
        targetAuthorId: meta.targetAuthorId,
        provenance: meta.provenance,
        originalOwner: attempt.originalOwner,
        revision: nextRevision
      });
    }
    state.receipt(null, BOARD_RECEIPT_KINDS.ATTEMPT, attempt);
    if (boardTextEquivalent(meta.content, meta.preEditContent)) {
      const ended = new Date().toISOString();
      state.receipt(null, BOARD_RECEIPT_KINDS.OUTCOME, {
        ...attempt,
        outcome: BOARD_OUTCOMES.NO_OP,
        status: BOARD_OUTCOMES.NO_OP,
        observedContent: meta.preEditContent,
        targetAuthorId: meta.targetAuthorId,
        operationEndedAt: ended
      });
      return {
        status: BOARD_OUTCOMES.NO_OP,
        requestId: meta.requestId,
        targetMessageId: meta.target.messageId,
        revision: nextRevision,
        attemptId: attempt.attemptId,
        attempt,
        outcome: BOARD_OUTCOMES.NO_OP,
        noOp: true
      };
    }
    return {
      status: 'admitted',
      requestId: meta.requestId,
      targetMessageId: meta.target.messageId,
      revision: nextRevision,
      attemptId: attempt.attemptId,
      attempt
    };
  });
}

function persistBoardOutcome(state: BoardState, attemptId: string, detail: Record<string, unknown>): BoardRefreshRecord {
  state.receipt(null, BOARD_RECEIPT_KINDS.OUTCOME, detail);
  const persisted = latestOutcome(readReceipts(state, [BOARD_RECEIPT_KINDS.OUTCOME]), attemptId);
  if (!persisted) throw new Error('board refresh outcome receipt was not persisted');
  return { ...(detail as unknown as BoardRefreshRecord), recordedAt: persisted.createdAt };
}

function recordBoardRefreshOutcome(state: BoardState, targetInput: BoardTarget, attemptIdInput: string, outcomeInput: unknown, detail: Record<string, unknown> = {}): BoardRefreshRecord {
  const target = assertTarget(targetInput);
  const attemptId = text(attemptIdInput, 'attemptId', 128);
  const outcome = validateOutcome(outcomeInput);
  if (outcome === BOARD_OUTCOMES.IN_FLIGHT) throw new Error('board refresh outcome must be terminal or unknown');
  return state.transaction(() => {
    const rows = readReceipts(state);
    const attempts = rows.filter(row => row.kind === BOARD_RECEIPT_KINDS.ATTEMPT && row.detail.attemptId === attemptId);
    const attempt = attempts.at(-1);
    if (!attempt || !targetMatches(attempt.detail, target)) throw new Error('board refresh attempt is unknown');
    const existing = latestOutcome(rows, attemptId);
    if (existing) return rowRecord(existing, true);
    const ended = operationEndedAt(detail.operationEndedAt);
    const next = {
      ...attempt.detail,
      ...detail,
      outcome,
      status: outcome,
      operationEndedAt: ended
    };
    return persistBoardOutcome(state, attemptId, next);
  });
}

function reconcileBoardRefresh(state: BoardState, targetInput: BoardTarget, attemptIdInput: string, resolution: unknown, evidence: BoardRecoveryEvidence): BoardRefreshRecord {
  const target = assertTarget(targetInput);
  const attemptId = text(attemptIdInput, 'attemptId', 128);
  if (resolution !== BOARD_OUTCOMES.APPLIED) throw new Error('board refresh reconciliation only accepts applied evidence');
  const scope = text(evidence?.evidenceScope, 'evidenceScope', 2000);
  const observedAt = readbackInstant(evidence?.observedAt);
  const readbackContent = boardContent(evidence?.readbackContent, 'readbackContent');
  if (!evidence.soleWriter || !evidence.singleAttempt || !evidence.noHiddenRetry) {
    throw new Error('positive board readback requires sole-writer, single-attempt, and no-hidden-retry evidence');
  }
  return state.transaction(() => {
    const rows = readReceipts(state);
    const attempt = rows.filter(row => row.kind === BOARD_RECEIPT_KINDS.ATTEMPT && row.detail.attemptId === attemptId).at(-1);
    if (!attempt || !targetMatches(attempt.detail, target)) throw new Error('board refresh attempt is unknown');
    const existing = latestOutcome(rows, attemptId);
    if (!existing) throw new Error('board refresh attempt has no outcome to reconcile');
    const current = validateOutcome(existing.detail.outcome);
    if (current === BOARD_OUTCOMES.APPLIED) return rowRecord(existing, true);
    if (!UNRESOLVED_OUTCOMES.has(current)) throw new Error(`board refresh attempt has terminal outcome ${current}`);
    const endedAt = typeof existing.detail.operationEndedAt === 'string' ? existing.detail.operationEndedAt : null;
    if (!endedAt) throw new Error('board refresh operation end is unknown');
    if (Date.parse(observedAt) < Date.parse(endedAt)) throw new Error('board readback predates operation termination');
    const desiredContent = attempt.detail.content;
    const preEditContent = attempt.detail.preEditContent;
    if (typeof desiredContent !== 'string' || typeof preEditContent !== 'string' || boardTextEquivalent(desiredContent, preEditContent)) {
      throw new Error('positive board readback requires desired content different from the pre-edit content');
    }
    if (!boardTextEquivalent(readbackContent, desiredContent)) throw new Error('board readback does not confirm the desired content');
    const next = {
      ...attempt.detail,
      outcome: BOARD_OUTCOMES.APPLIED,
      status: BOARD_OUTCOMES.APPLIED,
      reconciledFrom: current,
      evidenceScope: scope,
      readbackAt: observedAt,
      readbackContent,
      soleWriter: true,
      singleAttempt: true,
      noHiddenRetry: true,
      operationEndedAt: endedAt
    };
    return persistBoardOutcome(state, attemptId, next);
  });
}

export function createBoardRefreshHandlers() {
  return {
    captureBoardRevision,
    inspectBoardRequest,
    boardMessageProvenance,
    recoverBoardRefreshReceipts,
    recoverBoardRefreshAttempt,
    beginBoardRefresh,
    recordBoardRefreshOutcome,
    reconcileBoardRefresh
  };
}

export { hashContent };
