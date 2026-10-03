import * as fs from 'node:fs';
import { boardTextEquivalent } from './board-text';
import {
  BOARD_OUTCOMES,
  type BoardAdmission,
  type BoardBinding,
  type BoardProvenance,
  type BoardRefreshMeta,
  type BoardRefreshRecord,
  type BoardState,
  type BoardTarget,
  type BoardOutcome
} from './state/board-refresh';
import {
  fetchBoardChannel,
  fetchBoardInstallation,
  fetchBoardTarget,
  hashBoardText,
  patchBoardMessage,
  readBoardText,
  type BoardFetch,
  type BoardChannel,
  type BoardMessage
} from './discord/board-refresh';
import type { ProcessOwnerEvidence } from './state/process-owner-evidence';
import { OWNER_EVIDENCE, OWNER_EVIDENCE_REASON } from './state/process-owner-evidence';

type OwnerAliveResult = boolean | ProcessOwnerEvidence;

interface BoardStateRuntime extends BoardState {
  captureBoardRevision(target: BoardTarget): { target: BoardTarget; revision: number };
  inspectBoardRequest(requestId: string, target: BoardTarget): BoardAdmission | null;
  boardMessageProvenance(target: BoardTarget): BoardProvenance[];
  recoverBoardRefreshReceipts(ownerAlive?: (pid: number, identity: unknown) => OwnerAliveResult): number;
  beginBoardRefresh(meta: BoardRefreshMeta, capturedRevision: number): BoardAdmission;
  recordBoardRefreshOutcome(target: BoardTarget, attemptId: string, outcome: BoardOutcome, detail?: Record<string, unknown>): BoardRefreshRecord;
}

export interface BoardRefreshResult {
  requestId: string;
  targetMessageId: string;
  channelId: string;
  nativeId: string;
  generation: number;
  status: BoardOutcome;
  outcome?: BoardOutcome;
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

function transportOutcome(error: unknown): BoardOutcome {
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
  const status = admission.status === 'admitted'
    ? (admission.outcome || BOARD_OUTCOMES.IN_FLIGHT)
    : admission.status;
  return {
    ...admission,
    requestId: admission.requestId,
    targetMessageId: admission.targetMessageId,
    channelId,
    nativeId,
    generation,
    status,
    outcome: admission.outcome || status
  };
}

function channelMatches(channel: BoardChannel, expected: BoardTarget): void {
  if (channel.id !== expected.channelId || channel.guildId !== expected.guildId) {
    throw new Error('board target channel does not belong to the bound guild and channel');
  }
}

function targetMatches(target: BoardMessage, expected: BoardTarget): void {
  if (target.id !== expected.messageId || target.channelId !== expected.channelId) {
    throw new Error('board target message does not belong to the bound channel');
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
  resolveBinding,
  bindingCurrent = null,
  assertCallerCurrent = null
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
  bindingCurrent?: (() => boolean) | null;
  assertCallerCurrent?: ((signal?: AbortSignal) => Promise<void>) | null;
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
  const ownerAlive = (pid: number, identity: unknown): OwnerAliveResult => {
    if (typeof state.directPostOwnerEvidence === 'function') return state.directPostOwnerEvidence(pid, identity);
    return { status: OWNER_EVIDENCE.INDETERMINATE, reason: OWNER_EVIDENCE_REASON.INVALID_EVIDENCE };
  };
  state.recoverBoardRefreshReceipts(ownerAlive);
  // Peer caller revalidation for the shared board owner. The assertion is
  // optional so non-peer CLI consumers keep their current behavior, and a
  // refusal stays outside every transport classification path here.
  const revalidateCaller = async () => {
    if (typeof assertCallerCurrent !== 'function') return;
    await assertCallerCurrent(signal);
  };
  const existing = state.inspectBoardRequest(requestId, target);
  if (existing?.attempt?.payloadHash && existing.attempt.payloadHash !== payloadHash &&
      (typeof existing.attempt.content !== 'string' || !boardTextEquivalent(existing.attempt.content, content))) {
    throw new Error('dedupe key is already used for another board payload');
  }
  if (existing && (existing.historical || existing.duplicate)) {
    // A stored historical or duplicate result has no network effect, but the
    // authenticated caller must still be current before it is disclosed.
    await revalidateCaller();
    return resultFromAdmission(existing);
  }

  const binding = resolveBinding(state, { nativeId, generation: ownerGeneration, channelId });
  const isBindingCurrent = () => {
    if (typeof bindingCurrent !== 'function') return true;
    try { return bindingCurrent(); }
    catch { return false; }
  };

  // Capture before the asynchronous preflight GETs. Admission compares this value inside BEGIN IMMEDIATE.
  const prepared = state.captureBoardRevision(target);
  // Each preflight GET is bracketed separately: assert immediately before, then
  // again as soon as it settles, before any later request or admission. A
  // rejection is captured first, the assertion runs outside the transport path,
  // and a stable caller sees the original transport error unchanged.
  await revalidateCaller();
  let installation;
  let installationError: unknown = null;
  try {
    installation = await fetchBoardInstallation({ token, signal, timeoutMs, fetchImpl });
  } catch (error) {
    installationError = error;
  }
  await revalidateCaller();
  if (installationError !== null) throw installationError;
  await revalidateCaller();
  let remoteChannel;
  let channelError: unknown = null;
  try {
    remoteChannel = await fetchBoardChannel({ token, channelId, signal, timeoutMs, fetchImpl });
  } catch (error) {
    channelError = error;
  }
  await revalidateCaller();
  if (channelError !== null) throw channelError;
  channelMatches(remoteChannel!, target);
  await revalidateCaller();
  let remoteTarget;
  let targetError: unknown = null;
  try {
    remoteTarget = await fetchBoardTarget({ token, channelId, messageId, signal, timeoutMs, fetchImpl });
  } catch (error) {
    targetError = error;
  }
  await revalidateCaller();
  if (targetError !== null) throw targetError;
  const installationUser = installation!;
  const channel = remoteChannel!;
  const targetMessage = remoteTarget!;
  targetMatches(targetMessage, target);
  targetAuthorMatches(targetMessage, installationUser.id);
  const provenance = state.boardMessageProvenance(target);
  if (provenance.length === 0) throw new Error('board target has no sent-message provenance in this installation');
  if (!isBindingCurrent()) {
    return {
      requestId,
      targetMessageId: messageId,
      channelId,
      nativeId,
      generation: ownerGeneration,
      status: BOARD_OUTCOMES.STALE,
      outcome: BOARD_OUTCOMES.STALE,
      reason: 'binding readiness changed before board refresh admission'
    };
  }
  const meta: BoardRefreshMeta = {
    requestId,
    target,
    content,
    preEditContent: targetMessage.content,
    payloadHash,
    binding,
    targetAuthorId: targetMessage.authorId,
    provenance: provenance[0],
    ownerPid: process.pid,
    ownerIdentity: state.directPostOwnerIdentity?.(process.pid) || null
  };
  const admission = state.beginBoardRefresh(meta, prepared.revision);
  if (admission.status !== 'admitted') return resultFromAdmission(admission, binding);
  if (!admission.attemptId) throw new Error('board refresh admission lacks an attempt ID');
  if (!isBindingCurrent()) {
    const stale = state.recordBoardRefreshOutcome(target, admission.attemptId, BOARD_OUTCOMES.STALE, {
      reason: 'binding readiness changed before board update'
    });
    return {
      ...resultFromAdmission(admission, binding),
      status: stale.outcome,
      outcome: stale.outcome,
      reason: 'binding readiness changed before board update'
    };
  }
  // Assert immediately before the mutation, after admission and readiness. A
  // refusal records the existing stale known-unsent outcome for this claimed
  // attempt (retaining its request and revision identity) and escapes with no
  // network request.
  try {
    await revalidateCaller();
  } catch (error) {
    state.recordBoardRefreshOutcome(target, admission.attemptId, BOARD_OUTCOMES.STALE, {
      reason: 'native caller changed before board update'
    });
    throw error;
  }
  let mutationError: unknown = null;
  let applied: BoardRefreshRecord | null = null;
  try {
    const patched = await patchBoardMessage({ token, channelId, messageId, content, signal, timeoutMs, fetchImpl });
    targetMatches(patched, target);
    if (!boardTextEquivalent(patched.content, content)) {
      const mismatch = new Error('Discord board PATCH response did not confirm the desired content') as Error & { outcome: string };
      mismatch.outcome = BOARD_OUTCOMES.UNKNOWN;
      throw mismatch;
    }
    // Persist the exact applied evidence before any post-effect caller check.
    applied = state.recordBoardRefreshOutcome(target, admission.attemptId, BOARD_OUTCOMES.APPLIED, {
      responseMessageId: patched.id,
      observedContent: patched.content
    });
  } catch (error) {
    mutationError = error;
  }
  if (mutationError !== null) {
    const outcome = transportOutcome(mutationError);
    const recorded = state.recordBoardRefreshOutcome(target, admission.attemptId, outcome, {
      statusCode: Number((mutationError as { status?: unknown })?.status) || null,
      error: String((mutationError as Error)?.message || mutationError).slice(0, 300)
    });
    // The existing failure or unknown classification is saved. Revalidate after
    // the effect, outside that transport classification, then expose the result.
    await revalidateCaller();
    return {
      ...resultFromAdmission(admission, binding),
      status: recorded.outcome,
      outcome: recorded.outcome,
      error: String((mutationError as Error)?.message || mutationError).slice(0, 300)
    };
  }
  // Applied evidence is already persisted. A refusal here must not rewrite it
  // or trigger a resend.
  await revalidateCaller();
  return {
    ...resultFromAdmission(admission, binding),
    status: applied!.outcome,
    outcome: applied!.outcome
  };
}
