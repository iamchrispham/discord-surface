import * as crypto from 'node:crypto';

const PREFIX = 'discord-tether:agent:v1:';
const DOMAIN = 'discord-tether/agent-message/v1';

export const KINDS = Object.freeze({ REQUEST: 'request', RESULT: 'result' } as const);
export type AgentMessageKind = typeof KINDS[keyof typeof KINDS];

const LIMIT = 2000;

export type AgentProvider = 'codex' | 'claude';

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

export type AgentMessage =
  | (AgentMessageFields & { kind: typeof KINDS.REQUEST; replyTo: null })
  | (AgentMessageFields & { kind: typeof KINDS.RESULT; replyTo: string });

export interface AgentAddressEnvelope {
  address: AgentAddress;
  proof: string;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function validAddress(value: unknown): value is AgentAddress {
  if (!exactKeys(value, ['guildId', 'channelId', 'provider', 'nativeId', 'generation'])) return false;
  return /^\d{1,20}$/.test(value.guildId as string) && typeof value.guildId === 'string' &&
    /^\d{1,20}$/.test(value.channelId as string) && typeof value.channelId === 'string' &&
    ['codex', 'claude'].includes(value.provider as string) &&
    typeof value.nativeId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.nativeId as string) &&
    Number.isSafeInteger(value.generation) && value.generation as number > 0;
}

export function sameAddress(left: unknown, right: unknown): boolean {
  if (!validAddress(left) || !validAddress(right)) return false;
  return Object.keys(left).every(key => left[key as keyof AgentAddress] === right[key as keyof AgentAddress]);
}

function validate(packet: unknown): asserts packet is AgentMessage {
  if (!exactKeys(packet, ['id', 'kind', 'source', 'target', 'replyTo', 'text'])) {
    throw new Error('invalid agent message');
  }
  if (typeof packet.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(packet.id) ||
      !Object.values(KINDS).includes(packet.kind as AgentMessageKind) || !validAddress(packet.source) || !validAddress(packet.target)) {
    throw new Error('invalid agent message');
  }
  const source = packet.source;
  const target = packet.target;
  if (source.guildId !== target.guildId ||
      (source.provider === target.provider && source.nativeId === target.nativeId) ||
      typeof packet.text !== 'string' || !packet.text.trim() ||
      ((packet.kind as AgentMessageKind) === KINDS.REQUEST ? packet.replyTo !== null :
        typeof packet.replyTo !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(packet.replyTo as string))) {
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
  validate(packet);
  const body = Buffer.from(JSON.stringify(packet)).toString('base64url');
  const wire = `${PREFIX}${body}.${signature(body, token).toString('base64url')}`;
  if (wire.length > LIMIT) throw new Error('agent message exceeds Discord message limit');
  return wire;
}

export function decodeAgentMessage(wire: unknown, token: string, target: AgentAddress): AgentMessage | null {
  if (typeof wire !== 'string' || !wire.startsWith(PREFIX)) return null;
  if (wire.length > LIMIT) throw new Error('agent message exceeds Discord message limit');
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
  validate(packet);
  if (!sameAddress(packet.target, target)) throw new Error('agent message target is stale or mismatched');
  return packet;
}

export function issueAgentAddress(binding: AgentAddress, token: string): AgentAddressEnvelope {
  const address = Object.fromEntries(['guildId', 'channelId', 'provider', 'nativeId', 'generation'].map(key => [key, binding[key as keyof AgentAddress]]));
  if (!validAddress(address)) throw new Error('invalid agent address');
  const proof = crypto.createHmac('sha256', signingKey(token)).update('address/v1\0' + JSON.stringify(address)).digest('base64url');
  return { address, proof };
}

export function verifyAgentAddress(envelope: unknown, token: string): AgentAddress {
  if (!exactKeys(envelope, ['address', 'proof'])) {
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

export { PREFIX };
