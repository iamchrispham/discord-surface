import { AGENT_ROUTING_VERSION } from '../agent-routing';
import type { DirectPostPartMeta, DirectPostCustodyKey, DirectPostErrorConstructor } from './contracts';

export function samePeerAgentPacket(left: unknown, right: unknown, parentChannelId: string): boolean {
  if (!left || typeof left !== 'object' || Array.isArray(left) || !right || typeof right !== 'object' || Array.isArray(right)) return false;
  const leftPacket = left as Record<string, unknown>;
  const rightPacket = right as Record<string, unknown>;
  if (leftPacket.routingVersion !== AGENT_ROUTING_VERSION || rightPacket.routingVersion !== AGENT_ROUTING_VERSION) return false;
  const leftSource = leftPacket.source;
  const rightSource = rightPacket.source;
  if (!leftSource || typeof leftSource !== 'object' || Array.isArray(leftSource) ||
      !rightSource || typeof rightSource !== 'object' || Array.isArray(rightSource)) return false;
  const normalize = (packet: Record<string, unknown>, source: Record<string, unknown>) => ({
    ...packet,
    source: { ...source, channelId: parentChannelId }
  });
  return identityValueMatches(normalize(leftPacket, leftSource as Record<string, unknown>),
    normalize(rightPacket, rightSource as Record<string, unknown>));
}

export function identityKeyValueMatches(key: string, left: unknown, right: unknown, parentChannelId: string | null = null,
  allowPeerRoute = false): boolean {
  if (key === 'agentPacket' && allowPeerRoute && parentChannelId !== null && samePeerAgentPacket(left, right, parentChannelId)) return true;
  if (key === 'agentPacket' && (left === undefined || left === null || right === undefined || right === null)) return true;
  return identityValueMatches(left, right);
}

export function identityValueMatches(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

const immutableDetailKeys: Record<DirectPostCustodyKey, true> = {
  requestId: true,
  inReplyTo: true,
  attemptId: true,
  sourcePath: true,
  textHash: true,
  operatorId: true,
  partHash: true,
  channelId: true,
  guildId: true,
  provider: true,
  nativeId: true,
  generation: true,
  conductorId: true,
  repoKey: true,
  partIndex: true,
  partCount: true,
  nonce: true,
  binding: true,
  deliveryChannelId: true,
  agentPacket: true,
  legacyAgentPacket: true,
  agentRequestTarget: true,
  peerRouting: true,
  routingVersion: true,
  presentation: true,
  watcherNotice: true,
  caption: true,
  fileManifest: true,
  ownerPid: true,
  ownerStartTime: true,
  ownerCommand: true,
  journal: true,
};

export function validatedOutcomeDetail(expected: DirectPostPartMeta, input: Record<string, unknown>, BindingError: DirectPostErrorConstructor, snapshots = new WeakMap<object, unknown>()): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BindingError('direct post outcome detail is invalid');
  const expectedSnapshot = snapshotCustodyFields(expected, snapshots);
  const detail = snapshotCustodyFields(input, snapshots);
  if (Object.hasOwn(detail, 'toJSON')) throw new BindingError('direct post outcome detail cannot define toJSON');
  const serializedDetail = assertSerializableOutcomeDetail(detail, BindingError);
  for (const key of Object.keys(immutableDetailKeys)) {
    if (!Object.hasOwn(detail, key)) continue;
    const expectedValue = key === 'journal' ? 'direct-post-v1' : (expectedSnapshot as unknown as Record<string, unknown>)[key];
    const hasSerializedValue = Object.hasOwn(serializedDetail, key);
    if ((!hasSerializedValue && (detail[key] !== undefined || expectedValue !== undefined))
      || (hasSerializedValue && !identityValueMatches(serializedDetail[key], expectedValue))) {
      throw new BindingError(`direct post outcome cannot override immutable ${key}`);
    }
  }
  if (Object.hasOwn(detail, 'outcome')) throw new BindingError('direct post outcome cannot override immutable outcome');
  return serializedDetail;
}

function snapshotCustodyValue(value: unknown, snapshots: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (snapshots.has(value)) return snapshots.get(value);
  const serialized = JSON.stringify(value);
  const snapshot = serialized === undefined ? undefined : JSON.parse(serialized);
  snapshots.set(value, snapshot);
  return snapshot;
}

export function snapshotCustodyFields<T>(input: T, snapshots = new WeakMap<object, unknown>()): T {
  const snapshot = { ...(input as object) } as Record<string, unknown>;
  for (const key of Object.keys(immutableDetailKeys)) {
    if (Object.hasOwn(snapshot, key)) snapshot[key] = snapshotCustodyValue(snapshot[key], snapshots);
  }
  return snapshot as T;
}

function assertSerializableOutcomeDetail(detail: Record<string, unknown>, BindingError: DirectPostErrorConstructor): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(detail);
    if (serialized === undefined) throw new Error('detail serialization returned no value');
    const snapshot = JSON.parse(serialized) as unknown;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('detail serialization returned a non-object');
    return snapshot as Record<string, unknown>;
  } catch {
    throw new BindingError('direct post outcome detail is unserializable');
  }
}
