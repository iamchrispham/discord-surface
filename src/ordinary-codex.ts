const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OrdinaryProvider = 'codex';

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
  provider: OrdinaryProvider;
  channelId: string;
  guildId: string;
  nativeId: string;
  workspace: string;
  identity: OrdinaryCodexIdentity;
}

export interface ExistingOrdinaryBinding {
  active: boolean;
  channelId: string;
  guildId: string;
  provider: string;
  nativeId: string;
  workspace: string;
  conductorId?: string | null;
  repoKey?: string | null;
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

function absoluteWorkspace(value: unknown): string {
  const workspace = requiredText(value, 'workspace');
  if (!workspace.startsWith('/')) throw new Error('workspace must be absolute');
  return workspace;
}

function normalizedWorkspace(value: string): string {
  if (value === '/') return value;
  return value.replace(/\/+$/, '');
}

export function resolveInvocationIdentity(environment: InvocationEnvironment, workspace?: string): OrdinaryCodexIdentity & { workspace: string } {
  const sessionId = uuid(environment.CODEX_SESSION_ID, 'CODEX_SESSION_ID');
  const threadId = uuid(environment.CODEX_THREAD_ID, 'CODEX_THREAD_ID');
  if (sessionId !== threadId) throw new Error('CODEX_SESSION_ID and CODEX_THREAD_ID conflict');
  const suppliedWorkspace = absoluteWorkspace(workspace ?? environment.PWD);
  if (environment.PWD && normalizedWorkspace(suppliedWorkspace) !== normalizedWorkspace(absoluteWorkspace(environment.PWD))) {
    throw new Error('workspace conflicts with PWD');
  }
  return { sessionId, threadId, workspace: suppliedWorkspace };
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

export function ordinaryBindingDecision(existing: ExistingOrdinaryBinding | null, request: OrdinaryCodexRequest, ordinaryMarker = false): 'bind' | 'reuse' {
  if (!existing) return 'bind';
  const sameOwner = existing.active && ordinaryMarker && existing.provider === request.provider &&
    existing.channelId === request.channelId && existing.guildId === request.guildId &&
    existing.nativeId === request.nativeId && existing.workspace === request.workspace &&
    !existing.conductorId && !existing.repoKey;
  if (sameOwner) return 'reuse';
  throw new Error('channel is already bound to another owner; use explicit handoff');
}

export function createOrdinaryCodexRequest(input: {
  channelId: unknown;
  guildId: unknown;
  nativeId?: unknown;
  workspace: unknown;
  identity: OrdinaryCodexIdentity;
}): OrdinaryCodexRequest {
  const channelId = requiredText(input.channelId, 'channelId', 128);
  const guildId = requiredText(input.guildId, 'guildId', 128);
  const sessionId = uuid(input.identity?.sessionId, 'sessionId');
  const threadId = uuid(input.identity?.threadId, 'threadId');
  if (sessionId !== threadId) throw new Error('sessionId and threadId conflict');
  const nativeId = uuid(input.nativeId ?? sessionId, 'nativeId');
  if (nativeId !== sessionId) throw new Error('nativeId conflicts with the Codex invocation identity');
  return {
    provider: 'codex',
    channelId,
    guildId,
    nativeId,
    workspace: absoluteWorkspace(input.workspace),
    identity: { sessionId, threadId }
  };
}

export function createOrdinaryCodexRequestFromEnvironment(input: {
  channelId: unknown;
  guildId: unknown;
  nativeId?: unknown;
  workspace?: unknown;
  environment: InvocationEnvironment;
}): OrdinaryCodexRequest {
  const identity = resolveInvocationIdentity(input.environment, input.workspace as string | undefined);
  return createOrdinaryCodexRequest({ ...input, workspace: identity.workspace, identity });
}
