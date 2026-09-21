import type { AgentAddress, AgentMessage } from '../agent-message';
import type { AgentPresentation } from '../agent-presentation';
import type { DirectPostFileManifest } from '../direct-post-file';
import type { WatcherNotice } from '../watcher-notice';
import type { DirectPostBinding, DirectPostPartMeta, DirectPostState, DirectPostRoute, FetchImplementation, DiscordChannel } from './contracts';
import { hash, requiredString } from './request-values';
const crypto = require('node:crypto') as typeof import('node:crypto');
const { sameAddress } = require('../../src/agent-message') as { sameAddress: (left: unknown, right: unknown) => boolean };
const { AGENT_PRESENTATIONS } = require('../../src/agent-presentation') as { AGENT_PRESENTATIONS: Readonly<{ LEGACY: 'legacy'; ATTACHMENT: 'attachment-v1' }> };
const { BindingError, PROVIDERS, StaleGenerationError, discordNonce, validateNativeId } = require('../../src/state') as {
  BindingError: new (message?: string) => Error;
  PROVIDERS: Readonly<Record<string, string>>;
  StaleGenerationError: new (message?: string) => Error;
  discordNonce: (scope: string) => string;
  validateNativeId: (value: unknown) => unknown;
};
const { fetchDiscordChannel } = require('../../src/discord') as {
  fetchDiscordChannel: (options: { token: string; channelId: string; fetchImpl?: FetchImplementation; signal?: AbortSignal; timeoutMs?: number }) => Promise<DiscordChannel>;
};

function generationValue(value: unknown): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new BindingError('generation must be a positive integer');
  return generation;
}

function bindingMatchesRequest(binding: DirectPostBinding, { nativeId, generation, channelId, provider, ordinary = false }: {
  nativeId: unknown;
  generation: unknown;
  channelId?: string | null;
  provider?: string | null;
  ordinary?: boolean;
}): boolean {
  const authorityMatches = ordinary
    ? !binding.conductorId && !binding.repoKey
    : Boolean(binding.conductorId && binding.repoKey);
  return binding.active && authorityMatches && binding.nativeId === nativeId &&
    binding.generation === generation && (!channelId || binding.channelId === channelId) && (!provider || binding.provider === provider);
}

function resolveDirectBinding(state: DirectPostState, { nativeId, generation, channelId = null, provider = null, ordinary = false }: {
  nativeId: unknown;
  generation: unknown;
  channelId?: string | null;
  provider?: string | null;
  ordinary?: boolean;
}): DirectPostBinding {
  validateNativeId(nativeId);
  if (ordinary && provider && !Object.values(PROVIDERS).includes(provider)) throw new BindingError(`ordinary post does not support provider: ${provider}`);
  const config = state.requireConfig();
  const candidates = state.listBindings().filter(binding => binding.guildId === config.guildId &&
    bindingMatchesRequest(binding, { nativeId, generation, channelId, provider, ordinary }) &&
    (!ordinary || state.isOrdinaryBinding(binding)));
  if (candidates.length === 0) throw new StaleGenerationError(`no active ${ordinary ? `ordinary ${provider || 'native'}` : 'conductor'} binding matches the requested native owner`);
  if (candidates.length !== 1) throw new BindingError(`${ordinary ? 'ordinary post' : 'direct post'} requires --channel-id when the native owner is ambiguous`);
  return candidates[0];
}

function resolveDedupeKey({ dedupeKey, requestId }: { dedupeKey?: unknown; requestId?: unknown } = {}, { required = false }: { required?: boolean } = {}): string | undefined {
  const canonical = dedupeKey === undefined ? undefined : requiredString(dedupeKey, 'dedupe-key', 256);
  const legacy = requestId === undefined ? undefined : requiredString(requestId, 'request-id', 256);
  if (canonical !== undefined && legacy !== undefined && canonical !== legacy) {
    throw new BindingError('dedupe-key and request-id must match');
  }
  const resolved = canonical ?? legacy;
  if (required && resolved === undefined) throw new BindingError('dedupe-key or request-id is required');
  return resolved;
}

function requestIdFor(binding: DirectPostBinding, _operatorId: unknown, sourcePath: string, textHash: string,
  explicitRequestId?: unknown, inReplyTo: string | null = null): string {
  if (explicitRequestId !== undefined) return requiredString(explicitRequestId, 'request-id', 256);
  const identity = ['direct-post-v1', binding.channelId, binding.guildId, binding.provider, binding.nativeId, binding.generation,
    binding.conductorId, binding.repoKey, sourcePath, textHash];
  if (inReplyTo !== null) return hash(['direct-post-v2', ...identity, inReplyTo]);
  return hash(identity);
}

const ADDRESS_KEYS = Object.freeze(['guildId', 'channelId', 'provider', 'nativeId', 'generation'] as const);

function canonicalAddress(address: DirectPostBinding | AgentAddress): AgentAddress {
  return Object.fromEntries(ADDRESS_KEYS.map(key => [key, address[key]])) as unknown as AgentAddress;
}

function resolveAgentAddress(state: DirectPostState, binding: DirectPostBinding, agentThreadId: string | null | undefined = null): AgentAddress {
  if (agentThreadId === null || agentThreadId === undefined) {
    throw new BindingError('agent messages require --agent-thread-id for an actively enrolled child route');
  }
  if (typeof agentThreadId !== 'string' || agentThreadId.length === 0 || agentThreadId.length > 128) {
    throw new BindingError('agent-thread-id must be a non-empty string');
  }
  const route = state.getMessageRoute?.(agentThreadId) as DirectPostRoute | null | undefined;
  const enrollment = route?.enrollment;
  if (!route || !enrollment || !enrollment.active || enrollment.threadId !== agentThreadId ||
      route.deliveryChannelId !== agentThreadId || enrollment.parentChannelId !== binding.channelId ||
      enrollment.guildId !== binding.guildId || !sameAddress(canonicalAddress(route.binding), canonicalAddress(binding))) {
    throw new BindingError('agent thread is not actively enrolled under the source binding');
  }
  return canonicalAddress({ ...binding, channelId: agentThreadId });
}

async function verifyAgentDestination({ token, agentTarget, fetchImpl, signal, timeoutMs }: {
  token: string;
  agentTarget: AgentAddress;
  fetchImpl?: FetchImplementation;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  const channel = await fetchDiscordChannel({ token, channelId: agentTarget.channelId, fetchImpl, signal, timeoutMs });
  if (channel.id !== agentTarget.channelId || channel.guild_id !== agentTarget.guildId) {
    throw Object.assign(new BindingError('agent target channel does not match its declared guild'), { outcome: 'not_sent' });
  }
}

function agentNonceScope(source: DirectPostBinding | AgentAddress, destination: AgentAddress, requestId: string, partIndex: number): string {
  return hash(['agent-post-v1', canonicalAddress(source), canonicalAddress(destination), requestId, partIndex]);
}

function partMeta(binding: DirectPostBinding, operatorId: string, requestId: string, inReplyTo: string | null,
  sourcePath: string, textHash: string, parts: readonly string[], partIndex: number, sourceAddress: AgentAddress,
  agentTarget: AgentAddress | null = null,
  presentation: AgentPresentation = AGENT_PRESENTATIONS.LEGACY,
  agentPacket: AgentMessage | null = null,
  fileManifest: DirectPostFileManifest | null = null,
  watcherNotice: WatcherNotice | null = null, legacyAgentPacket: AgentMessage | null = null,
  agentRequestTarget: AgentAddress | null = null, routingVersion: number | null = null): DirectPostPartMeta {
  const nonceScope = agentTarget === null
    ? `direct:${requestId}:${partIndex}`
    : agentNonceScope(sourceAddress, agentTarget, requestId, partIndex);
  return {
    requestId,
    inReplyTo,
    attemptId: crypto.randomUUID(),
    sourcePath,
    textHash,
    operatorId,
    partHash: hash(parts[partIndex]),
    channelId: binding.channelId,
    guildId: binding.guildId,
    provider: binding.provider,
    nativeId: binding.nativeId,
    generation: binding.generation,
    conductorId: binding.conductorId,
    repoKey: binding.repoKey,
    partIndex,
    partCount: parts.length,
    nonce: discordNonce(nonceScope),
    binding,
    presentation,
    ...(fileManifest ? { caption: fileManifest.caption, fileManifest } : {}),
    ...(agentPacket ? { agentPacket } : {}),
    ...(legacyAgentPacket ? { legacyAgentPacket } : {}),
    ...(agentRequestTarget ? { agentRequestTarget } : {}),
    ...(routingVersion !== null ? { routingVersion } : {}),
    ...(watcherNotice ? { watcherNotice } : {})
  };
}

export { generationValue, bindingMatchesRequest, resolveDirectBinding, resolveDedupeKey, requestIdFor, canonicalAddress, resolveAgentAddress, verifyAgentDestination, agentNonceScope, partMeta };
