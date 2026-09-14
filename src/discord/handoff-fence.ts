const { RECOVERY_LIMITS } = require('../../src/state') as {
  RECOVERY_LIMITS: {
    pageSize: number;
    maxPages: number;
    maxMessages: number;
  };
};
import type { ThreadEnrollmentCoverageProof } from '../state/thread-enrollment';

export interface HandoffFenceMessage {
  id: string;
  delete?: () => unknown;
}

export interface HandoffChannel {
  id?: unknown;
  send?: (payload: { content: string; allowedMentions: { parse: string[] } }) => Promise<unknown>;
  messages?: {
    fetch?: (options: { limit: number; after?: string }) => Promise<unknown>;
  };
}

export interface HandoffClient {
  channels?: { fetch: (id: string) => Promise<HandoffChannel | null> };
}

export interface HandoffEnrollment {
  threadId: string;
  active: boolean;
  recoveredThroughId: string | null;
  updatedAt: string;
}

export interface HandoffBinding {
  active: boolean;
  channelId: string;
  guildId: string;
  provider: string;
  nativeId: string;
  generation: number;
  sessionRoot: string | null;
  conductorId: string | null;
  repoKey: string | null;
}

export interface HandoffState {
  checkpointIntake: (channelId: string, coverageId: string, expectedBinding: HandoffBinding) => unknown;
  hasIntakeEvidence: (discordId: string) => unknown;
}

export interface HandoffCoverageState extends HandoffState {
  getIntakeWatermark: (channelId: string) => { recovered_through_id?: string | null } | null;
  listThreadEnrollments: (parentChannelId?: string | null) => HandoffEnrollment[];
}

interface HistoryMessage {
  id: string;
}

function compareDiscordIds(left: unknown, right: unknown): number {
  try {
    const a = BigInt(left as string | number | bigint);
    const b = BigInt(right as string | number | bigint);
    return a === b ? 0 : a > b ? 1 : -1;
  } catch {
    return String(left).localeCompare(String(right));
  }
}

function historyMessages(result: unknown): unknown[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  const iterableResult = result as {
    values?: unknown;
    [Symbol.iterator]?: unknown;
  };
  if (typeof iterableResult.values === 'function') {
    return [...(iterableResult.values as () => Iterable<unknown>)()];
  }
  if (typeof iterableResult[Symbol.iterator] === 'function') {
    return [...(result as Iterable<unknown>)];
  }
  return [];
}

function activeEnrollmentSnapshot(state: HandoffCoverageState, binding: HandoffBinding): HandoffEnrollment[] {
  return state.listThreadEnrollments(binding.channelId).filter(enrollment => enrollment.active);
}

function sameEnrollmentSnapshot(expected: HandoffEnrollment[], current: HandoffEnrollment[]): boolean {
  if (expected.length !== current.length) return false;
  const currentByThreadId = new Map(current.map(enrollment => [enrollment.threadId, enrollment]));
  return expected.every(enrollment => {
    const currentEnrollment = currentByThreadId.get(enrollment.threadId);
    if (!currentEnrollment) return false;
    return currentEnrollment.recoveredThroughId === enrollment.recoveredThroughId &&
      currentEnrollment.updatedAt === enrollment.updatedAt;
  });
}

export async function createHandoffFence(
  channel: HandoffChannel | null | undefined,
  operation = 'ordinary handoff'
): Promise<HandoffFenceMessage> {
  if (typeof channel?.send !== 'function') throw new Error(`${operation} requires a Discord server fence`);
  const message = await channel.send({
    content: '\u200b',
    allowedMentions: { parse: [] }
  });
  const candidate = message as { id?: unknown } | null | undefined;
  if (typeof candidate?.id !== 'string' || candidate.id.length === 0) {
    throw new Error('Discord handoff fence has no stable ID');
  }
  return message as HandoffFenceMessage;
}

export async function deleteHandoffFence(message: unknown): Promise<void> {
  const candidate = message as { delete?: unknown } | null | undefined;
  if (typeof candidate?.delete !== 'function') return;
  try { await candidate.delete(); } catch {}
}

export function serverDerivedChannelCutoff(channel: HandoffChannel | null | undefined): string | null {
  return typeof channel?.id === 'string' && /^\d+$/.test(channel.id) ? channel.id : null;
}

export async function assertOrdinaryIntakeRange(
  channel: HandoffChannel | null | undefined,
  state: HandoffState,
  binding: HandoffBinding,
  recoveredThrough: string | null | undefined,
  fenceId: unknown,
  operation: string
): Promise<void> {
  if (!recoveredThrough) throw new Error(`${operation} requires a confirmed Discord intake boundary`);
  if (typeof channel?.messages?.fetch !== 'function') throw new Error(`${operation} requires Discord history range access`);
  let after = recoveredThrough;
  let pages = 0;
  let total = 0;
  while (pages < RECOVERY_LIMITS.maxPages && total < RECOVERY_LIMITS.maxMessages) {
    const page = historyMessages(await channel.messages!.fetch!({
      limit: RECOVERY_LIMITS.pageSize,
      after
    }));
    pages += 1;
    if (!page.length) {
      if (after !== recoveredThrough && !state.checkpointIntake(binding.channelId, after, binding)) throw new Error(`${operation} source binding changed`);
      return;
    }
    if (page.some(message => {
      const candidate = message as { id?: unknown } | null | undefined;
      return typeof candidate?.id !== 'string' || candidate.id.length === 0;
    })) {
      throw new Error(`${operation} encountered a Discord message without a stable ID`);
    }
    const stablePage = page as HistoryMessage[];
    stablePage.sort((left, right) => compareDiscordIds(left.id, right.id));
    const reachedFence = stablePage.some(message => compareDiscordIds(message.id, fenceId) >= 0);
    const fresh = stablePage.filter(message => compareDiscordIds(message.id, after) > 0 && compareDiscordIds(message.id, fenceId) < 0);
    if (!fresh.length) {
      if (reachedFence || stablePage.length < RECOVERY_LIMITS.pageSize) {
        if (after !== recoveredThrough && !state.checkpointIntake(binding.channelId, after, binding)) throw new Error(`${operation} source binding changed`);
        return;
      }
      throw new Error(`${operation} requires Discord intake to be durably drained`);
    }
    for (const message of fresh) {
      if (total >= RECOVERY_LIMITS.maxMessages || !state.hasIntakeEvidence(message.id)) {
        throw new Error(`${operation} requires Discord intake to be durably drained`);
      }
      after = message.id;
      total += 1;
    }
    if (reachedFence || stablePage.length < RECOVERY_LIMITS.pageSize) {
      if (after !== recoveredThrough && !state.checkpointIntake(binding.channelId, after, binding)) throw new Error(`${operation} source binding changed`);
      return;
    }
  }
  throw new Error(`${operation} requires Discord intake to be durably drained`);
}

export async function assertEnrolledThreadIntakeRange(
  client: HandoffClient | null | undefined,
  state: HandoffCoverageState,
  binding: HandoffBinding,
  fenceId: unknown,
  operation: string
): Promise<ThreadEnrollmentCoverageProof> {
  const enrollments = activeEnrollmentSnapshot(state, binding);
  if (!enrollments.length) {
    return { parentChannelId: binding.channelId, enrollments: [] };
  }
  const fetchThreadChannel = client?.channels?.fetch?.bind(client.channels);
  if (typeof fetchThreadChannel !== 'function') {
    throw new Error(`${operation} requires Discord thread history access`);
  }
  for (const enrollment of enrollments) {
    const channel = await fetchThreadChannel(enrollment.threadId);
    if (!channel || channel.id !== enrollment.threadId || typeof channel.messages?.fetch !== 'function') {
      throw new Error(`${operation} requires Discord history range access for enrolled thread ${enrollment.threadId}`);
    }
    let after = enrollment.recoveredThroughId || null;
    let pages = 0;
    let total = 0;
    let complete = false;
    while (pages < RECOVERY_LIMITS.maxPages && total < RECOVERY_LIMITS.maxMessages) {
      const options: { limit: number; after?: string } = { limit: RECOVERY_LIMITS.pageSize };
      if (after) options.after = after;
      const page = historyMessages(await channel.messages.fetch(options));
      pages += 1;
      if (!page.length) {
        complete = true;
        break;
      }
      if (page.some(message => {
        const candidate = message as { id?: unknown } | null | undefined;
        return typeof candidate?.id !== 'string' || candidate.id.length === 0;
      })) {
        throw new Error(`${operation} encountered an enrolled thread message without a stable ID`);
      }
      const stablePage = page as HistoryMessage[];
      stablePage.sort((left, right) => compareDiscordIds(left.id, right.id));
      const reachedFence = stablePage.some(message => compareDiscordIds(message.id, fenceId) >= 0);
      const fresh = stablePage.filter(message => (!after || compareDiscordIds(message.id, after) > 0) &&
        compareDiscordIds(message.id, fenceId) < 0);
      if (!fresh.length) {
        if (reachedFence || stablePage.length < RECOVERY_LIMITS.pageSize) {
          complete = true;
          break;
        }
        throw new Error(`${operation} requires enrolled thread ${enrollment.threadId} intake to be durably drained`);
      }
      for (const message of fresh) {
        if (total >= RECOVERY_LIMITS.maxMessages || !state.hasIntakeEvidence(message.id)) {
          throw new Error(`${operation} requires enrolled thread ${enrollment.threadId} intake to be durably drained`);
        }
        after = message.id;
        total += 1;
      }
      if (!enrollment.recoveredThroughId && stablePage.length >= RECOVERY_LIMITS.pageSize && !reachedFence) {
        throw new Error(`${operation} requires a confirmed intake boundary for enrolled thread ${enrollment.threadId}`);
      }
      if (reachedFence || stablePage.length < RECOVERY_LIMITS.pageSize) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      throw new Error(`${operation} requires enrolled thread ${enrollment.threadId} intake to be durably drained`);
    }
  }
  if (!sameEnrollmentSnapshot(enrollments, activeEnrollmentSnapshot(state, binding))) {
    throw new Error(`${operation} active thread enrollments changed during history proof`);
  }
  return {
    parentChannelId: binding.channelId,
    enrollments: enrollments.map(({ threadId, active, recoveredThroughId, updatedAt }) => ({ threadId, active, recoveredThroughId, updatedAt }))
  };
}

export async function assertHandoffIntakeCoverage(
  channel: HandoffChannel | null | undefined,
  client: HandoffClient | null | undefined,
  state: HandoffCoverageState,
  binding: HandoffBinding,
  fenceId: unknown,
  operation: string
): Promise<ThreadEnrollmentCoverageProof> {
  const recoveredThrough = state.getIntakeWatermark(binding.channelId)?.recovered_through_id || null;
  await assertOrdinaryIntakeRange(channel, state, binding, recoveredThrough, fenceId, operation);
  return assertEnrolledThreadIntakeRange(client, state, binding, fenceId, operation);
}
