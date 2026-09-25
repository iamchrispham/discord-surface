import type { DirectPostBinding } from '../direct-post/contracts';
import { THREAD_STATES, type ThreadState } from '../state/thread-enrollment';
import { READINESS, type Readiness } from '../topic';

export type PeerBinding = DirectPostBinding & { readiness: Readiness };

export type PeerSelector = { repoKey: string; provider: 'codex' | 'claude' } |
  { conductorId: string } | { channelId: string } | { channelName: string };
export interface PeerChannel { id: string; guildId: string; name: string }
interface Enrollment { threadId: string; parentChannelId: string; guildId: string; active: boolean; state: ThreadState; detail?: string | null }
interface PeerState {
  requireConfig(): { guildId: string };
  listBindings(): PeerBinding[];
  listThreadEnrollments(parentChannelId: string): Enrollment[];
  getIntakeWatermark(channelId: string): { state: Readiness; detail?: string | null } | null;
  getBindingReadinessReceipt(channelId: string): Record<string, unknown> | null;
}

function selectorValues(selector: PeerSelector): [string, string][] {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) throw new Error('peer selector must be an object');
  const entries = Object.entries(selector);
  const keys = entries.map(([key]) => key).sort().join(',');
  if (!['provider,repoKey', 'conductorId', 'channelId', 'channelName'].includes(keys) ||
      entries.some(([, value]) => typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) ||
      ('provider' in selector && !['codex', 'claude'].includes(selector.provider))) {
    throw new Error('peer selector requires exactly repoKey and provider, conductorId, channelId, or channelName');
  }
  return entries;
}

export function resolvePeerBinding(state: PeerState, selector: PeerSelector, channels: readonly PeerChannel[] = []): PeerBinding {
  selectorValues(selector);
  const { guildId } = state.requireConfig();
  const bindings = state.listBindings().filter(binding => binding.active && binding.guildId === guildId);
  let candidates: PeerBinding[];
  if ('channelName' in selector) {
    const matches = channels.filter(channel =>
      channel.guildId === guildId &&
      channel.name === selector.channelName &&
      bindings.some(binding => binding.channelId === channel.id));
    if (matches.length !== 1) throw new Error(matches.length ? 'peer channel name is ambiguous' : 'peer channel name is unknown');
    candidates = bindings.filter(binding => binding.channelId === matches[0].id);
  } else if ('conductorId' in selector) {
    candidates = bindings.filter(binding => binding.conductorId === selector.conductorId);
  } else if ('channelId' in selector) {
    candidates = bindings.filter(binding => binding.channelId === selector.channelId);
  } else {
    candidates = bindings.filter(binding => binding.repoKey === selector.repoKey && binding.provider === selector.provider);
  }
  if (candidates.length !== 1) throw new Error(candidates.length ? 'peer binding is ambiguous' : 'peer has no active binding');
  return candidates[0];
}

export function requireReadyBinding(state: PeerState, binding: PeerBinding): void {
  const watermark = state.getIntakeWatermark(binding.channelId);
  if (watermark && watermark.state !== READINESS.READY) {
    throw new Error(`peer is not ready: ${watermark.detail || watermark.state}`);
  }
  if (binding.readiness !== READINESS.READY) {
    const receipt = state.getBindingReadinessReceipt(binding.channelId);
    const current = receipt && ['guildId', 'provider', 'nativeId', 'generation', 'conductorId', 'readiness']
      .every(key => receipt[key] === binding[key as keyof PeerBinding]);
    const reason = current && typeof receipt.detail === 'string' && receipt.detail.trim() ? receipt.detail : binding.readiness;
    throw new Error(`peer is not ready: ${reason}`);
  }
}

export function requireReadyPeer(state: PeerState, binding: PeerBinding): { binding: PeerBinding; childId: string } {
  requireReadyBinding(state, binding);
  const children = state.listThreadEnrollments(binding.channelId).filter(child =>
    child.active && child.parentChannelId === binding.channelId && child.guildId === binding.guildId);
  if (children.length !== 1) throw new Error(children.length ? 'peer child route is ambiguous' : 'peer has no enrolled child route');
  if (children[0].state !== THREAD_STATES.READY) throw new Error(`peer child is not ready: ${children[0].detail || children[0].state}`);
  return { binding, childId: children[0].threadId };
}
