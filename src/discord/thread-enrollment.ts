const discord = () => require('discord.js') as typeof import('discord.js');
import { CODEX_VALIDATION_KINDS } from '../native-transcript';
import { THREAD_STATES, type ThreadBinding, type ThreadEnrollment, type ThreadRoute, type ThreadState } from '../state/thread-enrollment';

export interface ThreadChannel {
  id: string;
  guildId?: string;
  parentId?: string | null;
  type?: number;
  locked?: boolean;
  isThread?: () => boolean;
  permissionsFor?: (user: unknown) => { has: (permission: bigint) => boolean } | null;
  messages?: { fetch: (options: unknown) => Promise<unknown> };
}

export function historyPermission(channel: ThreadChannel, user: unknown, requireSend = false) {
  if (!user || typeof channel?.permissionsFor !== 'function') return { known: false, allowed: false };
  try {
    const { PermissionFlagsBits } = discord();
    const permissions = channel.permissionsFor(user);
    if (!permissions || typeof permissions.has !== 'function') return { known: false, allowed: false };
    const history = permissions.has(PermissionFlagsBits.ViewChannel) && permissions.has(PermissionFlagsBits.ReadMessageHistory);
    if (!requireSend) return { known: true, allowed: history };
    const thread = channel.isThread?.() === true;
    const send = permissions.has(thread ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages);
    const locked = thread && channel.locked === true && !permissions.has(PermissionFlagsBits.ManageThreads) && !permissions.has(PermissionFlagsBits.Administrator);
    return { known: true, allowed: history && (!requireSend || (send && !locked)) };
  } catch { return { known: false, allowed: false }; }
}

export function assertPublicThread(channel: ThreadChannel | null, binding: ThreadBinding, threadId: string, user: unknown): asserts channel is ThreadChannel {
  const { ChannelType } = discord();
  if (!channel || channel.id !== threadId || channel.type !== ChannelType.PublicThread ||
      channel.guildId !== binding.guildId || channel.parentId !== binding.channelId) {
    throw new Error('Thread must be a public thread under the bound parent in the configured guild');
  }
  if (channel.locked === true) throw new Error('Thread is locked');
  const permission = historyPermission(channel, user, true);
  if (!permission.known || !permission.allowed) throw new Error('Thread requires view, history and thread-send permissions');
}

interface ThreadStateOwner {
  getBinding(id: string): ThreadBinding | null;
  getMessageRoute(id: string): ThreadRoute | null;
  getThreadEnrollment(id: string): ThreadEnrollment | null;
  enrollThread(input: { threadId: string; parentChannelId: string; guildId: string }, binding: ThreadBinding): unknown;
  setThreadBaseline(id: string, latestId: string | null, binding: ThreadBinding): unknown;
  markThreadBoundary(id: string, state: ThreadState, detail: string, from: string | null, to: string | null, binding: ThreadBinding, coverageId?: string | null, lastSeenBaselineId?: string | null): ThreadEnrollment | null;
  checkpointThread(id: string, coverage: string, binding: ThreadBinding): unknown;
  hasIntakeEvidence(id: string): boolean;
}

interface HistoryMessage { id: string; [key: string]: unknown }
interface ThreadGateway {
  state: ThreadStateOwner;
  client: { user: unknown; channels: { fetch(id: string): Promise<ThreadChannel | null> } };
  recoveryTimeoutMs: number;
  historyMaxPages: number;
  historyMaxMessages: number;
  historyPageLimit: number;
  fetchHistoryInjected: boolean;
  isCurrentLifecycle(epoch: number): boolean;
  isCurrentBinding(binding: ThreadBinding): boolean;
  fetchHistory(channel: ThreadChannel, options: { limit: number; after?: string; signal: AbortSignal }): Promise<unknown>;
  historyMessages(value: unknown): HistoryMessage[];
  normalizeFetchedMessage(message: HistoryMessage, channel: ThreadChannel): unknown;
  consumer: {
    intakeMessage(message: unknown, ready: boolean, coverage: string | null, binding: ThreadBinding,
      emitReceipt?: boolean, signal?: AbortSignal | null, deadline?: number | null, bypassBarrier?: boolean): Promise<{ stale?: boolean }>;
  };
}

type WaitOperation = <T>(operation: () => Promise<T>, signal: AbortSignal, deadline: number) => Promise<T>;
const compareIds = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;

export async function enrollPublicThread(state: ThreadStateOwner, client: ThreadGateway['client'], parentId: string, threadId: string, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Thread enrollment stopped');
  const binding = state.getBinding(parentId);
  if (!binding?.active) throw new Error('Thread parent requires an active binding');
  const { ChannelType } = discord();
  const parent = await client.channels.fetch(parentId);
  if (parent?.type !== ChannelType.GuildText || parent.guildId !== binding.guildId) {
    throw new Error('Thread parent must be the bound public text channel');
  }
  const thread = await client.channels.fetch(threadId);
  assertPublicThread(thread, binding, threadId, client.user);
  if (signal?.aborted) throw new Error('Thread enrollment stopped');
  const enrollment = state.enrollThread({ threadId, parentChannelId: parentId, guildId: binding.guildId }, binding);
  if (!enrollment) throw new Error('Thread parent binding changed during enrollment');
  return enrollment;
}

export async function recoverThread(gateway: ThreadGateway, enrollment: ThreadEnrollment, signal: AbortSignal,
  epoch: number, wait: WaitOperation, checkpointOnly = false, deadline = Date.now() + gateway.recoveryTimeoutMs): Promise<boolean> {
  const parent = gateway.state.getMessageRoute(enrollment.parentChannelId);
  if (!parent?.ready) return false;
  const binding = parent.binding;
  if (!checkpointOnly && [THREAD_STATES.GAP, THREAD_STATES.UNAVAILABLE].some(state => state === enrollment.state)) return false;
  const current = () => !signal.aborted && gateway.isCurrentLifecycle(epoch) && gateway.isCurrentBinding(binding);
  const boundary = (
    state: ThreadState,
    detail: string,
    after: string | null,
    coverageId: string | null | undefined = undefined,
    lastSeenBaselineId: string | null | undefined = undefined
  ) => {
    if (!current()) return null;
    return gateway.state.markThreadBoundary(
      enrollment.threadId,
      state,
      detail,
      enrollment.recoveredThroughId,
      after,
      binding,
      coverageId,
      lastSeenBaselineId
    );
  };
  if (!current()) return false;
  if (!checkpointOnly) boundary(THREAD_STATES.PENDING, 'Thread history recovery in progress', null);
  let after = enrollment.recoveredThroughId;
  const startingAfter = after;
  const startingLastSeenId = enrollment.lastSeenId;
  let recoveryAttempted = false;
  try {
    const channel = await wait(() => {
      recoveryAttempted = true;
      return gateway.client.channels.fetch(enrollment.threadId);
    }, signal, deadline);
    if (!current()) return false;
    assertPublicThread(channel, binding, enrollment.threadId, gateway.client.user);
    if (!gateway.fetchHistoryInjected && typeof channel.messages?.fetch !== 'function') throw new Error('Thread history fetch is unavailable');
    const readHistory = async (options: { limit: number; after?: string; signal: AbortSignal }) => {
      const result = await wait(() => gateway.fetchHistory(channel, options), signal, deadline);
      if (!result || (!Array.isArray(result) && typeof (result as { values?: unknown }).values !== 'function')) {
        throw new Error('Thread history result is unavailable');
      }
      return gateway.historyMessages(result);
    };
    if (!enrollment.adoptedAt) {
      if (checkpointOnly) return false;
      const baseline = await readHistory({ limit: 1, signal });
      if (!current()) return false;
      if (baseline.some(message => !/^\d+$/.test(message.id))) throw new Error('Thread history message has no stable ID');
      const fetchedNewest = baseline.sort((a, b) => compareIds(b.id, a.id))[0]?.id || null;
      const liveLastSeenId = gateway.state.getThreadEnrollment(enrollment.threadId)?.lastSeenId || null;
      let newest = fetchedNewest || liveLastSeenId;
      if (fetchedNewest && liveLastSeenId && compareIds(liveLastSeenId, fetchedNewest) > 0) newest = liveLastSeenId;
      if (!gateway.state.setThreadBaseline(enrollment.threadId, newest, binding)) return false;
      after = gateway.state.getThreadEnrollment(enrollment.threadId)?.recoveredThroughId || null;
    }
    let pages = 0;
    let total = 0;
    let complete = false;
    while (pages < gateway.historyMaxPages && total < gateway.historyMaxMessages) {
      if (!current()) return false;
      const options = { limit: gateway.historyPageLimit, signal, ...(after ? { after } : {}) };
      const page = await readHistory(options);
      if (!current()) return false;
      pages += 1;
      if (!page.length) { complete = true; break; }
      if (page.some(message => !/^\d+$/.test(message.id))) throw new Error('Thread history message has no stable ID');
      page.sort((a, b) => compareIds(a.id, b.id));
      const fresh = after ? page.filter(message => compareIds(message.id, after!) > 0) : page;
      if (!fresh.length) { complete = true; break; }
      for (const message of fresh) {
        if (!current()) return false;
        if (total >= gateway.historyMaxMessages) break;
        if (checkpointOnly) {
          if (!gateway.state.hasIntakeEvidence(message.id)) {
            const fenced = boundary(THREAD_STATES.PENDING, 'Thread history custody gap detected', message.id);
            return fenced ? recoverThread(gateway, fenced, signal, epoch, wait, false, deadline) : false;
          }
        } else {
          const intake = await gateway.consumer.intakeMessage(
            gateway.normalizeFetchedMessage(message, channel), false, message.id, binding, false, signal, deadline, true
          );
          if (intake?.stale || !current()) return false;
        }
        after = message.id;
        total += 1;
      }
      if (total >= gateway.historyMaxMessages) {
        const consumedPage = after === fresh[fresh.length - 1].id;
        if (page.length < gateway.historyPageLimit && consumedPage) complete = true;
        break;
      }
      if (fresh.length < page.length && page.length === gateway.historyPageLimit) throw new Error('Thread history overlapped cursor without complete coverage');
      if (page.length < gateway.historyPageLimit) { complete = true; break; }
    }
    if (!current()) return false;
    if (!complete) {
      if (checkpointOnly) {
        const advanced = Boolean(after && (!startingAfter || compareIds(after, startingAfter) > 0));
        const checkpointed = advanced ? gateway.state.checkpointThread(enrollment.threadId, after!, binding) as ThreadEnrollment | null : null;
        if (!checkpointed || checkpointed.recoveredThroughId !== after) {
          boundary(THREAD_STATES.GAP, 'Thread history recovery bound reached', after);
        }
      } else {
        boundary(THREAD_STATES.GAP, 'Thread history recovery bound reached', after);
      }
      return false;
    }
    if (checkpointOnly) {
      const advanced = Boolean(after && (!startingAfter || compareIds(after, startingAfter) > 0));
      const checkpointed = advanced ? gateway.state.checkpointThread(enrollment.threadId, after!, binding) as ThreadEnrollment | null : null;
      return Boolean(checkpointed?.recoveredThroughId === after && checkpointed.recoveredThroughId !== startingAfter);
    }
    const currentEnrollment = gateway.state.getThreadEnrollment(enrollment.threadId);
    if (!currentEnrollment?.active) return false;
    const liveCustodyAhead = Boolean(currentEnrollment.lastSeenId &&
      (!after || compareIds(currentEnrollment.lastSeenId, after) > 0));
    if (liveCustodyAhead) {
      gateway.state.markThreadBoundary(
        enrollment.threadId,
        THREAD_STATES.GAP,
        'live Discord custody arrived while thread recovery was closing',
        currentEnrollment.recoveredThroughId,
        currentEnrollment.lastSeenId,
        binding
      );
      return false;
    }
    const readyBoundary = boundary(THREAD_STATES.READY, 'Thread history recovered', null, after, startingLastSeenId);
    return readyBoundary?.state === THREAD_STATES.READY;
  } catch (error) {
    if (!current()) return false;
    if (!checkpointOnly) {
      const deadlineReached = (error as { recoveryKind?: string }).recoveryKind === CODEX_VALIDATION_KINDS.DEADLINE;
      if (deadlineReached && !recoveryAttempted) return false;
      boundary(deadlineReached ? THREAD_STATES.GAP : THREAD_STATES.UNAVAILABLE, error instanceof Error ? error.message : String(error), after);
    }
    return false;
  }
}
