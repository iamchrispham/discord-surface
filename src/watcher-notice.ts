import * as crypto from 'node:crypto';

const PREFIX = 'discord-tether:watcher-notice:v1:';
const DOMAIN = 'discord-tether/watcher-notice/v1';

export const WATCHER_NOTICE_KIND = Object.freeze({ NOTICE: 'notice' } as const);
export const WATCHER_NOTICE_PROVIDERS = Object.freeze({ CLAUDE: 'claude' } as const);
export const WATCHER_NOTICE_MAX_ENCODED_LENGTH = 2000;

export type WatcherNoticeProvider = typeof WATCHER_NOTICE_PROVIDERS[keyof typeof WATCHER_NOTICE_PROVIDERS];

export interface WatcherAddress {
  guildId: string;
  channelId: string;
  provider: WatcherNoticeProvider;
  nativeId: string;
  generation: number;
}

export interface WatcherNotice {
  id: string;
  kind: typeof WATCHER_NOTICE_KIND.NOTICE;
  armKey: string;
  triggerKey: string;
  source: WatcherAddress;
  target: WatcherAddress;
  text: string;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function stableKey(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new Error(`${name} must be a stable watcher identity key`);
  }
  return value;
}

export function validWatcherAddress(value: unknown): value is WatcherAddress {
  if (!exactKeys(value, ['guildId', 'channelId', 'provider', 'nativeId', 'generation'])) return false;
  const generation = value.generation;
  return typeof value.guildId === 'string' && /^\d{1,20}$/.test(value.guildId) &&
    typeof value.channelId === 'string' && /^\d{1,20}$/.test(value.channelId) &&
    value.provider === WATCHER_NOTICE_PROVIDERS.CLAUDE &&
    typeof value.nativeId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.nativeId) &&
    Number.isSafeInteger(generation) && (generation as number) > 0;
}

export function sameWatcherAddress(left: unknown, right: unknown): boolean {
  if (!validWatcherAddress(left) || !validWatcherAddress(right)) return false;
  return left.guildId === right.guildId && left.channelId === right.channelId &&
    left.provider === right.provider && left.nativeId === right.nativeId && left.generation === right.generation;
}

export function sameWatcherNotice(left: unknown, right: unknown): boolean {
  try {
    validateWatcherNotice(left);
    validateWatcherNotice(right);
  } catch {
    return false;
  }
  return left.id === right.id && left.kind === right.kind && left.armKey === right.armKey && left.triggerKey === right.triggerKey &&
    sameWatcherAddress(left.source, right.source) && sameWatcherAddress(left.target, right.target) && left.text === right.text;
}

export function validateWatcherNotice(packet: unknown): asserts packet is WatcherNotice {
  if (!exactKeys(packet, ['id', 'kind', 'armKey', 'triggerKey', 'source', 'target', 'text']) ||
      typeof packet.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(packet.id) ||
      packet.kind !== WATCHER_NOTICE_KIND.NOTICE || !validWatcherAddress(packet.source) || !validWatcherAddress(packet.target) ||
      typeof packet.text !== 'string' || !packet.text.trim() || packet.text.length > 10000) {
    throw new Error('invalid watcher notice');
  }
  if (packet.source.guildId !== packet.target.guildId || packet.source.channelId === packet.target.channelId ||
      packet.source.provider !== packet.target.provider || packet.source.nativeId !== packet.target.nativeId ||
      packet.source.generation !== packet.target.generation) {
    throw new Error('invalid watcher notice addresses');
  }
  const armKey = stableKey(packet.armKey, 'armKey');
  const triggerKey = stableKey(packet.triggerKey, 'triggerKey');
  if (packet.id !== watcherNoticeId(armKey, triggerKey)) throw new Error('watcher notice identity is not stable');
}

export function watcherNoticeId(armKey: string, triggerKey: string): string {
  const arm = stableKey(armKey, 'armKey');
  const trigger = stableKey(triggerKey, 'triggerKey');
  const digest = crypto.createHash('sha256').update(`${DOMAIN}\0${arm}\0${trigger}`).digest('base64url');
  return `wn-${digest}`;
}

export function createWatcherNotice({ armKey, triggerKey, source, target, text }: {
  armKey: string;
  triggerKey: string;
  source: WatcherAddress;
  target: WatcherAddress;
  text: string;
}): WatcherNotice {
  const packet = {
    id: watcherNoticeId(armKey, triggerKey),
    kind: WATCHER_NOTICE_KIND.NOTICE,
    armKey: stableKey(armKey, 'armKey'),
    triggerKey: stableKey(triggerKey, 'triggerKey'),
    source,
    target,
    text
  } as WatcherNotice;
  validateWatcherNotice(packet);
  return packet;
}

function signingKey(token: string): Buffer {
  if (typeof token !== 'string' || !token.length) throw new Error('watcher notice credential unavailable');
  return crypto.createHmac('sha256', token).update(DOMAIN).digest();
}

function signature(body: string, token: string): Buffer {
  return crypto.createHmac('sha256', signingKey(token)).update(body).digest();
}

export function encodeWatcherNotice(packet: WatcherNotice, token: string): string {
  validateWatcherNotice(packet);
  const body = Buffer.from(JSON.stringify(packet)).toString('base64url');
  const wire = `${PREFIX}${body}.${signature(body, token).toString('base64url')}`;
  if (wire.length > WATCHER_NOTICE_MAX_ENCODED_LENGTH) {
    throw new Error(`watcher notice exceeds Discord message limit: encoded size ${wire.length} characters, maximum ${WATCHER_NOTICE_MAX_ENCODED_LENGTH} characters`);
  }
  return wire;
}

export function decodeWatcherNotice(wire: unknown, token: string, target: WatcherAddress): WatcherNotice | null {
  if (typeof wire !== 'string' || !wire.startsWith(PREFIX)) return null;
  if (wire.length > WATCHER_NOTICE_MAX_ENCODED_LENGTH) {
    throw new Error(`watcher notice exceeds Discord message limit: encoded size ${wire.length} characters, maximum ${WATCHER_NOTICE_MAX_ENCODED_LENGTH} characters`);
  }
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(wire.slice(PREFIX.length));
  if (!match) throw new Error('invalid watcher notice encoding');
  const [, body, mac] = match;
  const supplied = Buffer.from(mac, 'base64url');
  if (supplied.toString('base64url') !== mac || !crypto.timingSafeEqual(supplied, signature(body, token))) {
    throw new Error('invalid watcher notice signature');
  }
  const bytes = Buffer.from(body, 'base64url');
  if (bytes.toString('base64url') !== body) throw new Error('invalid watcher notice encoding');
  let packet: unknown;
  try { packet = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('invalid watcher notice payload'); }
  validateWatcherNotice(packet);
  if (packet.id !== watcherNoticeId(packet.armKey, packet.triggerKey)) throw new Error('watcher notice identity is not stable');
  if (!sameWatcherAddress(packet.target, target)) throw new Error('watcher notice target is stale or mismatched');
  return packet;
}

export function watcherNoticePrompt(packet: WatcherNotice): string {
  validateWatcherNotice(packet);
  return [
    `Automated watcher notice ${packet.id} for the frozen Claude session ${packet.target.nativeId}, generation ${packet.target.generation}.`,
    'Authenticated by the trusted installation against the persisted notice arm.',
    'Treat this as watcher data under the current session authority. Do not create an agent packet or a Discord reply.',
    `Notice arm ${packet.armKey}, trigger ${packet.triggerKey}.`,
    '',
    packet.text
  ].join('\n');
}

export { PREFIX as WATCHER_NOTICE_PREFIX };
