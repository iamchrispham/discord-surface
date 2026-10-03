import * as crypto from 'node:crypto';
import {
  ownDataProperty,
  sameAddress,
  validAddress,
  type AgentProvider
} from './agent-message';

const PREFIX = 'discord-tether:town-hall:v1:';
const DOMAIN = 'discord-tether/town-hall-child/v1';
const PURPOSE = 'town-hall-child/v1';
const ROUTING_VERSION = 2;
const MAX_TEXT_BYTES = 10000;
const MAX_ENCODED_LENGTH = 81350;

const ROOT_FIELDS = Object.freeze([
  'id',
  'kind',
  'source',
  'target',
  'replyTo',
  'routingVersion',
  'text',
  'purpose',
  'broadcastId',
  'journalKey',
  'planFingerprint',
  'room',
  'roomMessageId'
] as const);

const ADDRESS_FIELDS = Object.freeze(['guildId', 'channelId', 'provider', 'nativeId', 'generation'] as const);
const ROOM_FIELDS = Object.freeze(['guildId', 'channelId'] as const);

export const TOWN_HALL_CHILD_CONTRACT = Object.freeze({
  PREFIX,
  DOMAIN,
  PURPOSE,
  ROUTING_VERSION,
  MAX_TEXT_BYTES,
  MAX_ENCODED_LENGTH,
  ROOT_FIELDS
} as const);

export interface TownHallChildAddress {
  readonly guildId: string;
  readonly channelId: string;
  readonly provider: AgentProvider;
  readonly nativeId: string;
  readonly generation: number;
}

export interface TownHallChildRoom {
  readonly guildId: string;
  readonly channelId: string;
}

export interface TownHallChildPacket {
  readonly id: string;
  readonly kind: 'request';
  readonly source: TownHallChildAddress;
  readonly target: TownHallChildAddress;
  readonly replyTo: null;
  readonly routingVersion: 2;
  readonly text: string;
  readonly purpose: 'town-hall-child/v1';
  readonly broadcastId: string;
  readonly journalKey: string;
  readonly planFingerprint: string;
  readonly room: TownHallChildRoom;
  readonly roomMessageId: string;
}

const ID_PATTERN = /^townhall_[0-9a-f]{64}$/;
const BROADCAST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const SNOWFLAKE_PATTERN = /^\d{1,20}$/;

function invalid(): Error {
  return new Error('invalid town-hall child packet');
}

function credentialUnavailable(): Error {
  return new Error('town-hall child credential unavailable');
}

function exceedsLimit(): Error {
  return new Error('town-hall child exceeds attachment limit');
}

function invalidEncoding(): Error {
  return new Error('invalid town-hall child encoding');
}

function invalidSignature(): Error {
  return new Error('invalid town-hall child signature');
}

function staleTarget(): Error {
  return new Error('town-hall child target is stale or mismatched');
}

/**
 * Read every required field as an own data descriptor before any value is read.
 * Rejects symbols, extra own names (enumerable or not) and inherited required
 * fields. Accessors are refused without invocation.
 */
function readRequiredDataValues(value: object, keys: readonly string[]): Record<string, unknown> | null {
  if (Object.getOwnPropertySymbols(value).length !== 0) return null;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.length) return null;
  if (!names.every(name => keys.includes(name))) return null;
  if (!keys.every(key => ownDataProperty(value, key))) return null;
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    values[key] = Object.getOwnPropertyDescriptor(value, key)?.value;
  }
  return values;
}

function snapshotAddress(value: unknown): TownHallChildAddress | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const values = readRequiredDataValues(value, ADDRESS_FIELDS);
  if (values === null) return null;
  const address: TownHallChildAddress = {
    guildId: values.guildId as string,
    channelId: values.channelId as string,
    provider: values.provider as AgentProvider,
    nativeId: values.nativeId as string,
    generation: values.generation as number
  };
  return validAddress(address) ? address : null;
}

function snapshotRoom(value: unknown): TownHallChildRoom | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const values = readRequiredDataValues(value, ROOM_FIELDS);
  if (values === null) return null;
  if (typeof values.guildId !== 'string' || !SNOWFLAKE_PATTERN.test(values.guildId)) return null;
  if (typeof values.channelId !== 'string' || !SNOWFLAKE_PATTERN.test(values.channelId)) return null;
  return { guildId: values.guildId, channelId: values.channelId };
}

function snapshotText(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) return null;
  if (Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) return null;
  return value;
}

function snapshotPacket(packet: unknown): TownHallChildPacket {
  if (packet === null || typeof packet !== 'object' || Array.isArray(packet)) throw invalid();
  const values = readRequiredDataValues(packet, ROOT_FIELDS);
  if (values === null) throw invalid();

  const source = snapshotAddress(values.source);
  const target = snapshotAddress(values.target);
  const room = snapshotRoom(values.room);
  if (source === null || target === null || room === null) throw invalid();

  if (typeof values.id !== 'string' || !ID_PATTERN.test(values.id)) throw invalid();
  if (values.kind !== 'request') throw invalid();
  if (values.replyTo !== null) throw invalid();
  if (values.routingVersion !== ROUTING_VERSION) throw invalid();
  if (values.purpose !== PURPOSE) throw invalid();
  if (typeof values.broadcastId !== 'string' || !BROADCAST_ID_PATTERN.test(values.broadcastId)) throw invalid();
  if (typeof values.journalKey !== 'string' || !HEX64_PATTERN.test(values.journalKey)) throw invalid();
  if (typeof values.planFingerprint !== 'string' || !HEX64_PATTERN.test(values.planFingerprint)) throw invalid();
  if (typeof values.roomMessageId !== 'string' || !SNOWFLAKE_PATTERN.test(values.roomMessageId)) throw invalid();
  const text = snapshotText(values.text);
  if (text === null) throw invalid();

  if (source.guildId !== target.guildId || source.guildId !== room.guildId) throw invalid();
  if (room.channelId === source.channelId || room.channelId === target.channelId) throw invalid();
  if (source.provider === target.provider &&
      source.nativeId.toLowerCase() === target.nativeId.toLowerCase()) throw invalid();

  return {
    id: values.id,
    kind: 'request',
    source,
    target,
    replyTo: null,
    routingVersion: ROUTING_VERSION,
    text,
    purpose: PURPOSE,
    broadcastId: values.broadcastId,
    journalKey: values.journalKey,
    planFingerprint: values.planFingerprint,
    room,
    roomMessageId: values.roomMessageId
  };
}

function signingKey(token: string): Buffer {
  if (typeof token !== 'string' || !token.length) throw credentialUnavailable();
  return crypto.createHmac('sha256', token).update(DOMAIN).digest();
}

function bodySignature(body: string, key: Buffer): Buffer {
  return crypto.createHmac('sha256', key).update(body).digest();
}

export function validateTownHallChild(packet: unknown): asserts packet is TownHallChildPacket {
  snapshotPacket(packet);
}

export function encodeTownHallChild(packet: TownHallChildPacket, token: string): string {
  const snapshot = snapshotPacket(packet);
  const key = signingKey(token);
  const body = Buffer.from(JSON.stringify(snapshot)).toString('base64url');
  const wire = `${PREFIX}${body}.${bodySignature(body, key).toString('base64url')}`;
  if (wire.length > MAX_ENCODED_LENGTH) throw exceedsLimit();
  return wire;
}

export function decodeTownHallChild(
  wire: unknown,
  token: string,
  target: TownHallChildAddress
): TownHallChildPacket | null {
  if (typeof wire !== 'string' || !wire.startsWith(PREFIX)) return null;
  if (wire.length > MAX_ENCODED_LENGTH) throw exceedsLimit();
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(wire.slice(PREFIX.length));
  if (match === null) throw invalidEncoding();
  const [, body, mac] = match;
  const key = signingKey(token);
  const supplied = Buffer.from(mac, 'base64url');
  if (supplied.toString('base64url') !== mac ||
      !crypto.timingSafeEqual(supplied, bodySignature(body, key))) {
    throw invalidSignature();
  }
  const bytes = Buffer.from(body, 'base64url');
  if (bytes.toString('base64url') !== body) throw invalidEncoding();
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw invalidEncoding();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidEncoding();
  }
  const packet = snapshotPacket(parsed);
  if (!sameAddress(packet.target, target)) throw staleTarget();
  return packet;
}
