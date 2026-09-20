import * as crypto from 'node:crypto';

const PREFIX = 'discord-tether:agent:v1:';
const DOMAIN = 'discord-tether/agent-message/v1';

export const KINDS = Object.freeze({ REQUEST: 'request', RESULT: 'result' } as const);
export const PROVIDERS = Object.freeze({ CODEX: 'codex', CLAUDE: 'claude' } as const);
export type AgentMessageKind = typeof KINDS[keyof typeof KINDS];

export const AGENT_MESSAGE_MAX_ENCODED_LENGTH = 2000;

export type AgentProvider = typeof PROVIDERS[keyof typeof PROVIDERS];

export interface AgentAddress {
  guildId: string;
  channelId: string;
  provider: AgentProvider;
  nativeId: string;
  generation: number;
}

interface AgentMessageFields {
  id: string;
  source: AgentAddress;
  target: AgentAddress;
  text: string;
}

type AgentRoutingFields =
  | { routingVersion?: never; sourceParentChannelId?: never }
  | { routingVersion: 2; sourceParentChannelId?: string };

export type AgentMessage =
  | (AgentMessageFields & AgentRoutingFields & { kind: typeof KINDS.REQUEST; replyTo: null })
  | (AgentMessageFields & AgentRoutingFields & { kind: typeof KINDS.RESULT; replyTo: string });

export interface AgentAddressEnvelope {
  version: 2;
  address: AgentAddress;
  proof: string;
}

export interface LegacyAgentAddressEnvelope {
  address: AgentAddress;
  proof: string;
  version?: 1;
}

function messageLimitError(encodedLength: number): Error {
  return new Error(
    `agent message exceeds Discord message limit: encoded size ${encodedLength} characters, maximum ${AGENT_MESSAGE_MAX_ENCODED_LENGTH} characters`
  );
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function validAddress(value: unknown): value is AgentAddress {
  if (!exactKeys(value, ['guildId', 'channelId', 'provider', 'nativeId', 'generation'])) return false;
  return /^\d{1,20}$/.test(value.guildId as string) && typeof value.guildId === 'string' &&
    /^\d{1,20}$/.test(value.channelId as string) && typeof value.channelId === 'string' &&
    Object.values(PROVIDERS).includes(value.provider as AgentProvider) &&
    typeof value.nativeId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.nativeId as string) &&
    Number.isSafeInteger(value.generation) && value.generation as number > 0;
}

export function sameAddress(left: unknown, right: unknown): boolean {
  if (!validAddress(left) || !validAddress(right)) return false;
  return Object.keys(left).every(key => left[key as keyof AgentAddress] === right[key as keyof AgentAddress]);
}

export function validateAgentMessage(packet: unknown): asserts packet is AgentMessage {
  if (packet === null || typeof packet !== 'object' || Array.isArray(packet)) {
    throw new Error('invalid agent message');
  }
  const value = packet as Record<string, unknown>;
  const keys = Object.keys(value);
  const required = ['id', 'kind', 'source', 'target', 'replyTo', 'text'];
  if (!required.every(key => Object.hasOwn(value, key)) ||
      keys.some(key => ![...required, 'routingVersion', 'sourceParentChannelId'].includes(key)) ||
      (Object.hasOwn(value, 'routingVersion') && value.routingVersion !== 2) ||
      (Object.hasOwn(value, 'sourceParentChannelId') &&
        (value.routingVersion !== 2 || typeof value.sourceParentChannelId !== 'string' ||
          !/^\d{1,20}$/.test(value.sourceParentChannelId)))) {
    throw new Error('invalid agent message');
  }
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id) ||
      !Object.values(KINDS).includes(value.kind as AgentMessageKind) || !validAddress(value.source) || !validAddress(value.target)) {
    throw new Error('invalid agent message');
  }
  const source = value.source as AgentAddress;
  const target = value.target as AgentAddress;
  if (value.sourceParentChannelId === source.channelId || source.guildId !== target.guildId ||
      (source.provider === target.provider && source.nativeId === target.nativeId) ||
      typeof value.text !== 'string' || !value.text.trim() ||
      ((value.kind as AgentMessageKind) === KINDS.REQUEST ? value.replyTo !== null :
        typeof value.replyTo !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.replyTo as string))) {
    throw new Error('invalid agent message');
  }
}

function signingKey(token: string): Buffer {
  if (typeof token !== 'string' || !token.length) throw new Error('agent message credential unavailable');
  return crypto.createHmac('sha256', token).update(DOMAIN).digest();
}

function signature(body: string, token: string): Buffer {
  return crypto.createHmac('sha256', signingKey(token)).update(body).digest();
}

export function encodeAgentMessage(packet: AgentMessage, token: string): string {
  validateAgentMessage(packet);
  const body = Buffer.from(JSON.stringify(packet)).toString('base64url');
  const wire = `${PREFIX}${body}.${signature(body, token).toString('base64url')}`;
  if (wire.length > AGENT_MESSAGE_MAX_ENCODED_LENGTH) throw messageLimitError(wire.length);
  return wire;
}

export function decodeAgentMessage(wire: unknown, token: string, target: AgentAddress): AgentMessage | null {
  if (typeof wire !== 'string' || !wire.startsWith(PREFIX)) return null;
  if (wire.length > AGENT_MESSAGE_MAX_ENCODED_LENGTH) throw messageLimitError(wire.length);
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(wire.slice(PREFIX.length));
  if (!match) throw new Error('invalid agent message encoding');
  const [, body, mac] = match;
  const supplied = Buffer.from(mac, 'base64url');
  if (supplied.toString('base64url') !== mac || !crypto.timingSafeEqual(supplied, signature(body, token))) {
    throw new Error('invalid agent message signature');
  }
  const bytes = Buffer.from(body, 'base64url');
  if (bytes.toString('base64url') !== body) throw new Error('invalid agent message encoding');
  const packet: unknown = JSON.parse(bytes.toString('utf8'));
  validateAgentMessage(packet);
  if (!sameAddress(packet.target, target)) throw new Error('agent message target is stale or mismatched');
  return packet;
}

export function issueAgentAddress(binding: AgentAddress, token: string): AgentAddressEnvelope {
  const address = Object.fromEntries(['guildId', 'channelId', 'provider', 'nativeId', 'generation'].map(key => [key, binding[key as keyof AgentAddress]]));
  if (!validAddress(address)) throw new Error('invalid agent address');
  const proof = crypto.createHmac('sha256', signingKey(token)).update('address/v2\0' + JSON.stringify(address)).digest('base64url');
  return { version: 2, address, proof };
}

export function isLegacyAgentAddressEnvelope(value: unknown): value is LegacyAgentAddressEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  const hasVersion = Object.hasOwn(envelope, 'version');
  if (Object.keys(envelope).length !== (hasVersion ? 3 : 2) ||
      !Object.hasOwn(envelope, 'address') || !Object.hasOwn(envelope, 'proof') ||
      (hasVersion && envelope.version !== 1)) return false;
  return validAddress(envelope.address) && typeof envelope.proof === 'string' && /^[A-Za-z0-9_-]{43}$/.test(envelope.proof);
}

export function verifyAgentAddress(envelope: unknown, token: string): AgentAddress {
  if (!exactKeys(envelope, ['version', 'address', 'proof']) || envelope.version !== 2) {
    throw new Error('agent target file must contain a complete binding address and proof');
  }
  if (!validAddress(envelope.address) ||
      typeof envelope.proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(envelope.proof)) {
    throw new Error('agent target file must contain a complete binding address and proof');
  }
  const expected = issueAgentAddress(envelope.address, token);
  if (!crypto.timingSafeEqual(Buffer.from(envelope.proof), Buffer.from(expected.proof))) throw new Error('invalid agent address signature');
  return expected.address;
}

export function verifyLegacyAgentAddress(envelope: unknown, token: string): AgentAddress {
  if (!isLegacyAgentAddressEnvelope(envelope)) {
    throw new Error('agent target file must contain a complete binding address and proof');
  }
  const address = {
    guildId: envelope.address.guildId,
    channelId: envelope.address.channelId,
    provider: envelope.address.provider,
    nativeId: envelope.address.nativeId,
    generation: envelope.address.generation
  };
  const expected = crypto.createHmac('sha256', signingKey(token))
    .update('address/v1\0' + JSON.stringify(address)).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(envelope.proof), Buffer.from(expected))) {
    throw new Error('invalid agent address signature');
  }
  return address;
}

export { PREFIX };
