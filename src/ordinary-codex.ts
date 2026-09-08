const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OrdinaryProvider = 'codex' | 'claude';

export const ORDINARY_BINDING_DECISIONS = Object.freeze({
  BIND: 'bind',
  REUSE: 'reuse',
  REBIND: 'rebind'
} as const);

export type OrdinaryBindingDecision = typeof ORDINARY_BINDING_DECISIONS[keyof typeof ORDINARY_BINDING_DECISIONS];

export interface ExistingDiscordChannel {
  id: string;
  guildId: string;
  name?: string | null;
  messageCapable: boolean;
}

export interface OrdinaryCodexIdentity {
  sessionId: string;
  threadId: string;
}

export interface OrdinaryCodexRequest {
  provider: 'codex';
  channelId: string;
  guildId: string;
  nativeId: string;
  workspace: string;
  sessionRoot?: string;
  identity: OrdinaryCodexIdentity;
}

export interface OrdinaryClaudeIdentity {
  sessionId: string;
  threadId: string;
  harness: 'claude-code';
}

export interface OrdinaryClaudeRequest {
  provider: 'claude';
  channelId: string;
  guildId: string;
  nativeId: string;
  workspace: string;
  endpoint: string;
  identity: OrdinaryClaudeIdentity;
}

export type OrdinaryBindingRequest = OrdinaryCodexRequest | OrdinaryClaudeRequest;

export interface ExistingOrdinaryBinding {
  active: boolean;
  generation: number;
  channelId: string;
  guildId: string;
  provider: string;
  nativeId: string;
  workspace: string;
  sessionRoot?: string | null;
  endpoint?: string | null;
  conductorId?: string | null;
  repoKey?: string | null;
}

export interface OrdinaryCodexNativeProof {
  file: string;
  sessionId: string;
  threadId: string;
  workspace: string;
  sessionRoot: string;
}

export interface InvocationEnvironment {
  CODEX_SESSION_ID?: string;
  CODEX_THREAD_ID?: string;
  PWD?: string;
}

function requiredText(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function uuid(value: unknown, name: string): string {
  const result = requiredText(value, name, 128);
  if (!UUID_PATTERN.test(result)) throw new Error(`${name} must be a UUID`);
  return result;
}

function absolutePath(value: unknown, name: string): string {
  const result = requiredText(value, name);
  if (!result.startsWith('/')) throw new Error(`${name} must be absolute`);
  return result;
}

function absoluteWorkspace(value: unknown): string {
  return absolutePath(value, 'workspace');
}

function absoluteEndpoint(value: unknown): string {
  const endpoint = requiredText(value, 'endpoint', 180);
  if (!endpoint.startsWith('/') || endpoint.length > 90) throw new Error('endpoint must be a short absolute Unix socket path');
  return endpoint;
}

export function resolveInvocationIdentity(environment: InvocationEnvironment, workspace?: string): OrdinaryCodexIdentity & { workspace?: string } {
  const sessionId = uuid(environment.CODEX_SESSION_ID || environment.CODEX_THREAD_ID, 'CODEX_SESSION_ID');
  const threadId = uuid(environment.CODEX_THREAD_ID, 'CODEX_THREAD_ID');
  if (sessionId !== threadId) throw new Error('CODEX_SESSION_ID and CODEX_THREAD_ID conflict');
  return { sessionId, threadId, workspace: workspace === undefined ? undefined : absoluteWorkspace(workspace) };
}

export function resolveExistingChannel(selection: unknown, guildId: unknown, channels: readonly ExistingDiscordChannel[]): ExistingDiscordChannel {
  const requested = requiredText(selection, 'channel selection', 256).trim();
  if (!requested) throw new Error('channel selection is empty');
  const configuredGuild = requiredText(guildId, 'guildId', 128);
  const mention = requested.match(/^<#([^>]+)>$/)?.[1] || null;
  const idSelection = mention || (/^\d+$/.test(requested) ? requested : null);
  const allIdMatches = idSelection ? channels.filter(channel => channel?.id === idSelection) : [];
  const inGuild = channels.filter(channel => channel?.guildId === configuredGuild);
  if (idSelection) {
    const match = inGuild.find(channel => channel.id === idSelection);
    if (match) {
      if (!match.messageCapable) throw new Error('channel selection is not message-capable');
      return match;
    }
    if (allIdMatches.length > 0) throw new Error('channel selection is outside the configured guild');
    throw new Error('channel selection is unknown');
  }
  const nameSelection = requested.startsWith('#') ? requested.slice(1) : requested;
  if (!nameSelection) throw new Error('channel selection is empty');
  const matches = inGuild.filter(channel => channel.name === nameSelection);
  if (matches.length > 1) throw new Error('channel name is ambiguous in the configured guild');
  if (matches.length === 1 && !matches[0].messageCapable) throw new Error('channel selection is not message-capable');
  if (matches.length === 1) return matches[0];
  if (channels.some(channel => channel.name === nameSelection)) throw new Error('channel selection is outside the configured guild');
  throw new Error('channel selection is unknown');
}

export function ordinaryBindingDecision(
  existing: ExistingOrdinaryBinding | null,
  request: OrdinaryBindingRequest,
  ordinaryMarker = false,
  nativeProof: OrdinaryCodexNativeProof | null = null
): OrdinaryBindingDecision {
  if (!existing) return ORDINARY_BINDING_DECISIONS.BIND;
  const sessionRootMatches = request.provider !== 'codex' || request.sessionRoot === undefined || (existing.sessionRoot || null) === request.sessionRoot;
  const verifiedRootRelocation = request.provider === 'codex' && !sessionRootMatches && typeof nativeProof?.file === 'string' && nativeProof.file.startsWith('/') &&
    nativeProof.sessionId === request.nativeId && nativeProof.threadId === request.nativeId &&
    nativeProof.workspace === request.workspace && nativeProof.sessionRoot === request.sessionRoot;
  const sameOwner = ordinaryMarker && existing.provider === request.provider &&
    existing.channelId === request.channelId && existing.guildId === request.guildId &&
    existing.nativeId === request.nativeId && existing.workspace === request.workspace &&
    (request.provider !== 'claude' || existing.endpoint === request.endpoint) &&
    (sessionRootMatches || verifiedRootRelocation) &&
    !existing.conductorId && !existing.repoKey;
  if (sameOwner) return existing.active && sessionRootMatches ? ORDINARY_BINDING_DECISIONS.REUSE : ORDINARY_BINDING_DECISIONS.REBIND;
  if (request.provider === 'claude') {
    throw new Error('channel is already bound to another owner; Claude owner replacement requires an explicit supported handoff');
  }
  const handoffCommand = [
    'handoff --ordinary --provider codex',
    `--channel-id ${request.channelId}`,
    `--from-native-id ${existing.nativeId}`,
    `--from-generation ${existing.generation}`,
    `--native-id ${request.nativeId}`,
    `--workspace ${request.workspace}`
  ].join(' ');
  throw new Error(`channel is already bound to another owner; run ${handoffCommand} --handoff-id <unique-id>`);
}

export function createOrdinaryCodexRequest(input: {
  channelId: unknown;
  guildId: unknown;
  nativeId?: unknown;
  workspace: unknown;
  sessionRoot?: unknown;
  identity: OrdinaryCodexIdentity;
}): OrdinaryCodexRequest {
  const channelId = requiredText(input.channelId, 'channelId', 128);
  const guildId = requiredText(input.guildId, 'guildId', 128);
  const sessionId = uuid(input.identity?.sessionId, 'sessionId');
  const threadId = uuid(input.identity?.threadId, 'threadId');
  if (sessionId !== threadId) throw new Error('sessionId and threadId conflict');
  const nativeId = uuid(input.nativeId ?? sessionId, 'nativeId');
  if (nativeId !== sessionId) throw new Error('nativeId conflicts with the Codex invocation identity');
  const sessionRoot = input.sessionRoot == null ? undefined : absolutePath(input.sessionRoot, 'sessionRoot');
  return {
    provider: 'codex',
    channelId,
    guildId,
    nativeId,
    workspace: absoluteWorkspace(input.workspace),
    ...(sessionRoot === undefined ? {} : { sessionRoot }),
    identity: { sessionId, threadId }
  };
}

export function createOrdinaryCodexRequestFromEnvironment(input: {
  channelId: unknown;
  guildId: unknown;
  nativeId?: unknown;
  workspace?: unknown;
  sessionRoot?: unknown;
  environment: InvocationEnvironment;
}): OrdinaryCodexRequest {
  const identity = resolveInvocationIdentity(input.environment, input.workspace as string | undefined);
  const workspace = input.workspace ?? identity.workspace;
  if (workspace === undefined) throw new Error('workspace must come from exact Codex session metadata');
  return createOrdinaryCodexRequest({ ...input, workspace, identity });
}

export function createOrdinaryClaudeRequest(input: {
  channelId: unknown;
  guildId: unknown;
  nativeId?: unknown;
  workspace: unknown;
  endpoint: unknown;
  identity: OrdinaryClaudeIdentity;
}): OrdinaryClaudeRequest {
  const channelId = requiredText(input.channelId, 'channelId', 128);
  const guildId = requiredText(input.guildId, 'guildId', 128);
  const sessionId = uuid(input.identity?.sessionId, 'sessionId');
  const threadId = uuid(input.identity?.threadId, 'threadId');
  if (sessionId !== threadId) throw new Error('sessionId and threadId conflict');
  if (input.identity?.harness !== 'claude-code') throw new Error('ordinary Claude identity requires the claude-code harness');
  const nativeId = uuid(input.nativeId ?? sessionId, 'nativeId');
  if (nativeId !== sessionId) throw new Error('nativeId conflicts with the Claude invocation identity');
  return {
    provider: 'claude',
    channelId,
    guildId,
    nativeId,
    workspace: absoluteWorkspace(input.workspace),
    endpoint: absoluteEndpoint(input.endpoint),
    identity: { sessionId, threadId, harness: 'claude-code' }
  };
}
