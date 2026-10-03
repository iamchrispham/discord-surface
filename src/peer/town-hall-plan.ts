import { createHash } from 'node:crypto';
import { sameAgentSession, validAddress, type AgentAddress, type AgentProvider } from '../agent-message';

const CHILD_DOMAIN = 'discord-surface/town-hall-child/v1' as const;
const PLAN_DOMAIN = 'discord-surface/town-hall-plan/v1' as const;
const PACKET_PREFIX = 'townhall_' as const;
const MAX_TEXT_BYTES = 10000;
const ADDRESS_KEYS = ['guildId', 'channelId', 'provider', 'nativeId', 'generation'] as const;
const ROOM_KEYS = ['guildId', 'channelId'] as const;
const ROOT_KEYS = ['broadcastId', 'townHall', 'source', 'recipients', 'text'] as const;

export interface TownHallAddress {
  readonly guildId: string;
  readonly channelId: string;
  readonly provider: AgentProvider;
  readonly nativeId: string;
  readonly generation: number;
}

export interface TownHallRoom {
  readonly guildId: string;
  readonly channelId: string;
}

export function isTownHallRoom(value: unknown): value is TownHallRoom {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const guildId = ownDataProperty(value, 'guildId');
    const channelId = ownDataProperty(value, 'channelId');
    return typeof guildId === 'string' && /^\d{1,20}$/.test(guildId) &&
      typeof channelId === 'string' && /^\d{1,20}$/.test(channelId);
  } catch {
    return false;
  }
}

export interface TownHallRecipient {
  readonly target: TownHallAddress;
  readonly packetId: string;
}

export interface TownHallBroadcastInput {
  readonly broadcastId: string;
  readonly townHall: TownHallRoom;
  readonly source: TownHallAddress;
  readonly recipients: readonly TownHallAddress[];
  readonly text: string;
}

export interface TownHallPlan {
  readonly version: 1;
  readonly broadcastId: string;
  readonly townHall: TownHallRoom;
  readonly source: TownHallAddress;
  readonly text: string;
  readonly recipients: readonly TownHallRecipient[];
  readonly fingerprint: string;
}

function invalid(): Error {
  return new Error('invalid town-hall broadcast plan');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hasExactOwnKeys(value: object, keys: readonly string[]): boolean {
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value);
  return names.length === keys.length && names.every(name => keys.includes(name));
}

function ownDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor)) throw invalid();
  return descriptor.value;
}

function copyAddress(value: unknown): AgentAddress {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  if (!hasExactOwnKeys(record, ADDRESS_KEYS)) throw invalid();
  const address: AgentAddress = {
    guildId: ownDataProperty(record, 'guildId') as string,
    channelId: ownDataProperty(record, 'channelId') as string,
    provider: ownDataProperty(record, 'provider') as AgentProvider,
    nativeId: ownDataProperty(record, 'nativeId') as string,
    generation: ownDataProperty(record, 'generation') as number
  };
  if (!validAddress(address)) throw invalid();
  address.nativeId = address.nativeId.toLowerCase();
  return address;
}

function copyRoom(value: unknown): TownHallRoom {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  if (!hasExactOwnKeys(record, ROOM_KEYS)) throw invalid();
  const room = { guildId: ownDataProperty(record, 'guildId'), channelId: ownDataProperty(record, 'channelId') };
  if (!isTownHallRoom(room)) throw invalid();
  return room;
}

function copyBroadcastId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw invalid();
  return value;
}

function copyText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid();
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) throw invalid();
  if (Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) throw invalid();
  return value;
}

function compareAddresses(left: AgentAddress, right: AgentAddress): number {
  const a = JSON.stringify([left.guildId, left.channelId, left.provider, left.nativeId, left.generation]);
  const b = JSON.stringify([right.guildId, right.channelId, right.provider, right.nativeId, right.generation]);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function planTownHallBroadcast(input: unknown): TownHallPlan {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const record = input as Record<string, unknown>;
  if (!hasExactOwnKeys(record, ROOT_KEYS)) throw invalid();

  const broadcastId = copyBroadcastId(ownDataProperty(record, 'broadcastId'));
  const townHall = copyRoom(ownDataProperty(record, 'townHall'));
  const source = copyAddress(ownDataProperty(record, 'source'));
  const text = copyText(ownDataProperty(record, 'text'));

  const recipients = ownDataProperty(record, 'recipients');
  if (!Array.isArray(recipients) || recipients.length < 1) throw invalid();
  const targets: AgentAddress[] = [];
  for (let index = 0; index < recipients.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(recipients, String(index));
    if (!descriptor || !('value' in descriptor)) throw invalid();
    targets.push(copyAddress(descriptor.value));
  }

  if (townHall.guildId !== source.guildId || townHall.channelId === source.channelId) throw invalid();
  const seen = new Set<string>();
  for (const target of targets) {
    if (target.guildId !== source.guildId || target.channelId === townHall.channelId) throw invalid();
    const identity = `${target.provider}\u0000${target.nativeId}`;
    if (sameAgentSession(source, target) || seen.has(identity)) throw invalid();
    seen.add(identity);
  }

  targets.sort(compareAddresses);
  const fingerprint = sha256Hex(JSON.stringify([PLAN_DOMAIN, broadcastId, townHall, source, text, targets]));

  Object.freeze(townHall);
  Object.freeze(source);
  for (const target of targets) Object.freeze(target);
  const frozenRecipients = targets.map(target => Object.freeze({
    target,
    packetId: PACKET_PREFIX + sha256Hex(JSON.stringify([CHILD_DOMAIN, source, broadcastId, target]))
  }));
  Object.freeze(frozenRecipients);

  const plan: TownHallPlan = {
    version: 1,
    broadcastId,
    townHall,
    source,
    text,
    recipients: frozenRecipients,
    fingerprint
  };
  Object.freeze(plan);
  return plan;
}
