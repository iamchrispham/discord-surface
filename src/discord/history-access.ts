const discord = () => require('discord.js') as typeof import('discord.js');

export interface HistoryPermissionChannel {
  permissionsFor?: (user: unknown) => { has: (permission: bigint) => boolean } | null;
  isThread?: () => boolean;
  locked?: boolean;
}

export function historyPermission(channel: HistoryPermissionChannel, user: unknown, requireSend = false, requireAttachFiles = false) {
  if (!user || typeof channel?.permissionsFor !== 'function') return { known: false, allowed: false };
  try {
    const { PermissionFlagsBits } = discord();
    const permissions = channel.permissionsFor(user);
    if (!permissions || typeof permissions.has !== 'function') return { known: false, allowed: false };
    const history = permissions.has(PermissionFlagsBits.ViewChannel) && permissions.has(PermissionFlagsBits.ReadMessageHistory);
    const attachments = !requireAttachFiles || permissions.has(PermissionFlagsBits.AttachFiles);
    if (!requireSend) return { known: true, allowed: history && attachments };
    const thread = channel.isThread?.() === true;
    const send = permissions.has(thread ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages);
    const locked = thread && channel.locked === true && !permissions.has(PermissionFlagsBits.ManageThreads) && !permissions.has(PermissionFlagsBits.Administrator);
    return { known: true, allowed: history && attachments && send && !locked };
  } catch { return { known: false, allowed: false }; }
}

export const ADOPTION_REFUSAL_DETAILS = Object.freeze({
  STOPPED: 'Adoption history acquisition stopped',
  CHANNEL: 'Adoption history channel does not match the requested channel',
  UNKNOWN_PERMISSION: 'Adoption history permissions are unavailable',
  DENIED_PERMISSION: 'Adoption requires view and history permissions',
  READER: 'Adoption history fetch is unavailable',
  COLLECTION: 'Adoption history result is unavailable',
  MESSAGE_ID: 'Adoption history message has no stable decimal ID',
  PARENT_CUTOFF: 'Fresh binding requires an explicit decimal adoption cutoff',
  CHILD_CUTOFF: 'Fresh or inactive thread enrollment requires an explicit decimal adoption cutoff'
} as const);

export type AdoptionRefusalDetail = typeof ADOPTION_REFUSAL_DETAILS[keyof typeof ADOPTION_REFUSAL_DETAILS];

export const PERSISTENCE_REFUSAL_DETAILS = Object.freeze({
  PARENT_COVERAGE: 'Parent baseline requires qualified historical coverage',
  CHILD_COVERAGE: 'Thread baseline requires qualified historical coverage'
} as const);

export type PersistenceRefusalDetail = typeof PERSISTENCE_REFUSAL_DETAILS[keyof typeof PERSISTENCE_REFUSAL_DETAILS];

export class AdoptionRefusalError extends Error {
  readonly detail: AdoptionRefusalDetail;

  constructor(detail: AdoptionRefusalDetail, options?: { cause?: unknown }) {
    super(detail, options);
    this.name = 'AdoptionRefusalError';
    this.detail = detail;
  }
}

export interface AdoptionChannel {
  id: string;
  permissionsFor?: (user: unknown) => { has: (permission: bigint) => boolean } | null;
  messages?: { fetch: (options: unknown, cacheOptions?: unknown) => Promise<unknown> };
}

function refusal(detail: AdoptionRefusalDetail): AdoptionRefusalError {
  return new AdoptionRefusalError(detail);
}

export async function readAdoptionCutoff(
  channel: AdoptionChannel,
  expectedChannelId: string,
  user: unknown,
  signal?: AbortSignal
): Promise<string> {
  if (signal?.aborted) throw refusal(ADOPTION_REFUSAL_DETAILS.STOPPED);
  if (!channel || channel.id !== expectedChannelId) throw refusal(ADOPTION_REFUSAL_DETAILS.CHANNEL);
  if (typeof channel.permissionsFor !== 'function') throw refusal(ADOPTION_REFUSAL_DETAILS.UNKNOWN_PERMISSION);
  let permissions: { has: (permission: bigint) => boolean } | null | undefined;
  try {
    permissions = channel.permissionsFor(user);
  } catch {
    throw refusal(ADOPTION_REFUSAL_DETAILS.UNKNOWN_PERMISSION);
  }
  if (!permissions || typeof permissions.has !== 'function') throw refusal(ADOPTION_REFUSAL_DETAILS.UNKNOWN_PERMISSION);
  const { PermissionFlagsBits } = discord();
  if (!permissions.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.ReadMessageHistory)) {
    throw refusal(ADOPTION_REFUSAL_DETAILS.DENIED_PERMISSION);
  }
  if (!channel.messages || typeof channel.messages.fetch !== 'function') throw refusal(ADOPTION_REFUSAL_DETAILS.READER);
  let collection: unknown;
  try {
    collection = await channel.messages.fetch({ limit: 1 }, { signal });
  } catch (error) {
    if (signal?.aborted) throw refusal(ADOPTION_REFUSAL_DETAILS.STOPPED);
    throw error;
  }
  if (signal?.aborted) throw refusal(ADOPTION_REFUSAL_DETAILS.STOPPED);
  let records: unknown[];
  if (Array.isArray(collection)) {
    records = collection;
  } else if (collection && typeof (collection as { values?: unknown }).values === 'function') {
    const iterator = (collection as { values: () => unknown }).values();
    if (!iterator || typeof (iterator as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') {
      throw refusal(ADOPTION_REFUSAL_DETAILS.COLLECTION);
    }
    records = Array.from(iterator as Iterable<unknown>);
  } else {
    throw refusal(ADOPTION_REFUSAL_DETAILS.COLLECTION);
  }
  let newest: string | null = null;
  for (const record of records) {
    const id = (record as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !/^[0-9]+$/.test(id)) throw refusal(ADOPTION_REFUSAL_DETAILS.MESSAGE_ID);
    if (newest === null || BigInt(id) > BigInt(newest)) newest = id;
  }
  return newest === null ? '0' : newest;
}
