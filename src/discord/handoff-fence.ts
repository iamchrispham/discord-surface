const { RECOVERY_LIMITS } = require('../../src/state') as {
  RECOVERY_LIMITS: {
    pageSize: number;
    maxPages: number;
    maxMessages: number;
  };
};

export interface HandoffFenceMessage {
  id: string;
  delete?: () => unknown;
}

export interface HandoffChannel {
  id?: unknown;
  send?: (payload: { content: string; allowedMentions: { parse: string[] } }) => Promise<unknown>;
  messages?: {
    fetch?: (options: { limit: number; after: string }) => Promise<unknown>;
  };
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
