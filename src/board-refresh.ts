import * as fs from 'node:fs';
import {
  BOARD_OUTCOMES,
  type BoardAdmission,
  type BoardBinding,
  type BoardProvenance,
  type BoardRefreshMeta,
  type BoardRefreshRecord,
  type BoardState,
  type BoardTarget
} from './state/board-refresh';
import {
  fetchBoardInstallation,
  fetchBoardTarget,
  hashBoardText,
  patchBoardMessage,
  readBoardText,
  type BoardFetch,
  type BoardMessage
} from './discord/board-refresh';

interface BoardStateRuntime extends BoardState {
  captureBoardRevision(target: BoardTarget): { target: BoardTarget; revision: number };
  inspectBoardRequest(requestId: string, target: BoardTarget): BoardAdmission | null;
  boardMessageProvenance(target: BoardTarget): BoardProvenance[];
  recoverBoardRefreshReceipts(ownerAlive?: (pid: number, identity: unknown) => boolean): number;
  beginBoardRefresh(meta: BoardRefreshMeta, capturedRevision: number): BoardAdmission;
  recordBoardRefreshOutcome(target: BoardTarget, attemptId: string, outcome: string, detail?: Record<string, unknown>): BoardRefreshRecord;
}

export interface BoardRefreshResult {
  requestId: string;
  targetMessageId: string;
  channelId: string;
  nativeId: string;
  generation: number;
  status: string;
  outcome?: string;
  revision?: number;
  attemptId?: string;
  duplicate?: boolean;
  historical?: boolean;
  reason?: string;
  [key: string]: unknown;
}

interface BoardBindingResolver {
  (state: BoardStateRuntime, input: { nativeId: string; generation: number; channelId: string }): BoardBinding;
}

function text(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function generation(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('generation must be a positive integer');
  return parsed;
}

function readBoardFile(file: unknown): string {
  const sourcePath = text(file, 'textFile', 4096);
  let stat: fs.Stats;
  try { stat = fs.statSync(sourcePath); } catch (error) { throw new Error(`board text file is unavailable: ${(error as Error).message}`); }
  if (!stat.isFile()) throw new Error('board text file must be a regular file');
  if (stat.size > 12000) throw new Error('board text file exceeds the compact board input limit');
  let content: string;
  try { content = fs.readFileSync(sourcePath, 'utf8'); } catch (error) { throw new Error(`board text file is unreadable: ${(error as Error).message}`); }
  return readBoardText(content);
}

function transportOutcome(error: unknown): string {
  const candidate = error as { outcome?: unknown; status?: unknown } | null;
  if (candidate?.outcome === 'rate_limited') return BOARD_OUTCOMES.RATE_LIMITED;
  if (candidate?.outcome === 'rejected') return BOARD_OUTCOMES.REJECTED;
  if (candidate?.outcome === 'not_sent') return BOARD_OUTCOMES.NOT_SENT;
  if (candidate?.status === 429) return BOARD_OUTCOMES.RATE_LIMITED;
  if (typeof candidate?.status === 'number' && candidate.status >= 400 && candidate.status < 500) return BOARD_OUTCOMES.REJECTED;
  return BOARD_OUTCOMES.UNKNOWN;
}

function resultFromAdmission(admission: BoardAdmission, binding?: BoardBinding): BoardRefreshResult {
  const historicalAttempt = admission.attempt;
  const channelId = binding?.channelId || String(historicalAttempt?.channelId || '');
  const nativeId = binding?.nativeId || String(historicalAttempt?.nativeId || '');
  const generation = binding?.generation || Number(historicalAttempt?.generation || 0);
  return {
    ...admission,
    requestId: admission.requestId,
    targetMessageId: admission.targetMessageId,
    channelId,
    nativeId,
    generation,
    status: admission.status,
    outcome: admission.outcome || admission.status
  };
}

function targetMatches(target: BoardMessage, expected: BoardTarget): void {
  if (target.id !== expected.messageId || target.guildId !== expected.guildId || target.channelId !== expected.channelId) {
    throw new Error('board target message does not belong to the bound guild and channel');
  }
}

function targetAuthorMatches(target: BoardMessage, installationId: string): void {
  if (!target.authorIsBot || target.authorId !== installationId) throw new Error('board target message was not authored by this Discord installation');
}

export async function runBoardRefresh({
  state,
  token,
  nativeId: rawNativeId,
  generation: rawGeneration,
  channelId: rawChannelId,
  messageId: rawMessageId,
  textFile,
  dedupeKey: rawDedupeKey,
  signal,
  fetchImpl = globalThis.fetch as unknown as BoardFetch,
  timeoutMs = 30000,
  resolveBinding
}: {
  state: BoardStateRuntime;
  token: string;
  nativeId: string;
  generation: unknown;
  channelId: string;
  messageId: string;
  textFile: string;
  dedupeKey: string;
  signal?: AbortSignal;
  fetchImpl?: BoardFetch;
  timeoutMs?: number;
  resolveBinding: BoardBindingResolver;
}): Promise<BoardRefreshResult> {
  const nativeId = text(rawNativeId, 'nativeId', 128);
  const ownerGeneration = generation(rawGeneration);
  const channelId = text(rawChannelId, 'channelId', 128);
  const messageId = text(rawMessageId, 'messageId', 128);
  const requestId = text(rawDedupeKey, 'dedupeKey', 256);
  const content = readBoardFile(textFile);
  const payloadHash = hashBoardText(content);
  const config = state.requireConfig();
  const target: BoardTarget = { guildId: config.guildId, channelId, messageId };
  const ownerAlive = (pid: number, identity: unknown) => state.directPostOwnerAlive?.(pid, identity) || false;
  state.recoverBoardRefreshReceipts(ownerAlive);
  const existing = state.inspectBoardRequest(requestId, target);
  if (existing?.attempt?.payloadHash && existing.attempt.payloadHash !== payloadHash) {
    throw new Error('dedupe key is already used for another board payload');
  }
  if (existing && (existing.historical || existing.duplicate)) return resultFromAdmission(existing);

  const binding = resolveBinding(state, { nativeId, generation: ownerGeneration, channelId });

  // Capture before the two asynchronous GETs. Admission compares this value inside BEGIN IMMEDIATE.
  const prepared = state.captureBoardRevision(target);
  const [installation, remoteTarget] = await Promise.all([
    fetchBoardInstallation({ token, signal, timeoutMs, fetchImpl }),
    fetchBoardTarget({ token, channelId, messageId, signal, timeoutMs, fetchImpl })
  ]);
  targetMatches(remoteTarget, target);
  targetAuthorMatches(remoteTarget, installation.id);
  const provenance = state.boardMessageProvenance(target);
  if (provenance.length === 0) throw new Error('board target has no sent-message provenance in this installation');
  const meta: BoardRefreshMeta = {
    requestId,
    target,
    content,
    preEditContent: remoteTarget.content,
    payloadHash,
    binding,
    targetAuthorId: remoteTarget.authorId,
    provenance: provenance[0],
    ownerPid: process.pid,
    ownerIdentity: state.directPostOwnerIdentity?.(process.pid) || null
  };
  const admission = state.beginBoardRefresh(meta, prepared.revision);
  if (admission.status !== 'admitted') return resultFromAdmission(admission, binding);
  if (!admission.attemptId) throw new Error('board refresh admission lacks an attempt ID');
  if (remoteTarget.content === content) {
    const noOp = state.recordBoardRefreshOutcome(target, admission.attemptId, BOARD_OUTCOMES.NO_OP, {
      observedContent: remoteTarget.content,
      targetAuthorId: remoteTarget.authorId
    });
    return {
      ...resultFromAdmission(admission, binding),
      status: noOp.outcome,
      outcome: noOp.outcome,
      noOp: true
    };
  }
  try {
    const patched = await patchBoardMessage({ token, channelId, messageId, content, signal, timeoutMs, fetchImpl });
    targetMatches(patched, target);
    if (patched.content !== content) {
      const mismatch = new Error('Discord board PATCH response did not confirm the desired content') as Error & { outcome: string };
      mismatch.outcome = BOARD_OUTCOMES.UNKNOWN;
      throw mismatch;
    }
    const applied = state.recordBoardRefreshOutcome(target, admission.attemptId, BOARD_OUTCOMES.APPLIED, {
      responseMessageId: patched.id,
      observedContent: patched.content
    });
    return {
      ...resultFromAdmission(admission, binding),
      status: applied.outcome,
      outcome: applied.outcome
    };
  } catch (error) {
    const outcome = transportOutcome(error);
    const recorded = state.recordBoardRefreshOutcome(target, admission.attemptId, outcome, {
      statusCode: Number((error as { status?: unknown })?.status) || null,
      error: String((error as Error)?.message || error).slice(0, 300)
    });
    return {
      ...resultFromAdmission(admission, binding),
      status: recorded.outcome,
      outcome: recorded.outcome,
      error: String((error as Error)?.message || error).slice(0, 300)
    };
  }
}
