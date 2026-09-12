type AgentAddress = import('./agent-message').AgentAddress;
type AgentAddressEnvelope = import('./agent-message').AgentAddressEnvelope;
type AgentMessage = import('./agent-message').AgentMessage;
type AgentMessageKind = import('./agent-message').AgentMessageKind;
type AgentProvider = import('./agent-message').AgentProvider;

export const DIRECT_POST_OUTCOMES = {
  SENT: 'sent',
  NOT_SENT: 'not_sent',
  REJECTED: 'rejected',
  RATE_LIMITED: 'rate_limited',
  UNKNOWN: 'unknown',
  STALE: 'stale'
} as const;

export type DirectPostOutcome = (typeof DIRECT_POST_OUTCOMES)[keyof typeof DIRECT_POST_OUTCOMES];

export const DIRECT_POST_PART_STATUSES = {
  ...DIRECT_POST_OUTCOMES,
  CLAIMED: 'claimed',
  IN_FLIGHT: 'in_flight'
} as const;

export type DirectPostPartStatus = (typeof DIRECT_POST_PART_STATUSES)[keyof typeof DIRECT_POST_PART_STATUSES];

export interface DirectPostBinding {
  active: boolean;
  guildId: string;
  channelId: string;
  provider: AgentProvider;
  nativeId: string;
  generation: number;
  conductorId?: string | null;
  repoKey?: string | null;
}

interface DirectPostConfig {
  guildId: string;
  operatorId: string;
}

interface DirectPostReceiptRow {
  kind: string;
  detail: string;
  discord_id: string | null;
}

interface DirectPostReceiptDetail {
  [key: string]: unknown;
  outcome: DirectPostOutcome;
  messageId?: string;
}

interface DirectPostPartMeta {
  requestId: string;
  inReplyTo: string | null;
  attemptId: string;
  sourcePath: string;
  textHash: string;
  operatorId: string;
  partHash: string;
  channelId: string;
  guildId: string;
  provider: AgentProvider;
  nativeId: string;
  generation: number;
  conductorId?: string | null;
  repoKey?: string | null;
  partIndex: number;
  partCount: number;
  nonce: string;
  binding: DirectPostBinding;
  deliveryChannelId?: string;
}

interface DirectPostInspection {
  claimed: false;
  status: DirectPostPartStatus;
  attemptId: string;
  nonce: string;
  outcome?: DirectPostReceiptDetail;
}

interface DirectPostClaim {
  claimed: boolean;
  status: DirectPostPartStatus;
  attemptId: string;
  nonce: string;
  outcome?: DirectPostReceiptDetail;
}

export interface DirectPostState {
  requireConfig(): DirectPostConfig;
  listBindings(): DirectPostBinding[];
  isOrdinaryBinding(binding: DirectPostBinding): boolean;
  listReceipts(): DirectPostReceiptRow[];
  recoverDirectPostReceipts(): void;
  inspectDirectPostPart(meta: DirectPostPartMeta): DirectPostInspection | null;
  recordDirectPostPreflight(meta: DirectPostPartMeta, outcome: DirectPostOutcome, detail?: Record<string, unknown>): DirectPostReceiptDetail;
  beginDirectPostPart(meta: DirectPostPartMeta): DirectPostClaim;
  directPostBindingCurrent(binding: DirectPostBinding, operatorId: string): boolean;
  recordDirectPostOutcome(requestId: string, attemptId: string, outcome: DirectPostOutcome, detail?: Record<string, unknown>): DirectPostReceiptDetail;
}

export interface DirectPostSource {
  sourcePath: string;
  text: string;
  textHash: string;
  parts: string[];
}

export interface DirectPostPartResult {
  index: number;
  status: DirectPostPartStatus;
  messageId?: string | null;
}

export interface DirectPostResult {
  requestId: string;
  dedupeKey: string;
  inReplyTo: string | null;
  channelId: string;
  provider: AgentProvider;
  nativeId: string;
  generation: number;
  status: DirectPostPartStatus;
  state: DirectPostPartStatus;
  recorded: boolean;
  duplicate: boolean;
  messageIds: string[];
  parts: DirectPostPartResult[];
}

export interface FetchSuccessResponse {
  ok: true;
  status?: number;
  json: () => Promise<unknown>;
}

export interface FetchFailureResponse {
  ok?: false;
  status?: number;
  json?: () => Promise<unknown>;
}

export type FetchResponse = FetchSuccessResponse | FetchFailureResponse;

export interface FetchOptions {
  [key: string]: unknown;
}

export type FetchImplementation = (url: string, options: FetchOptions) => Promise<FetchResponse>;

interface DirectPostInputBase {
  state: DirectPostState;
  token: string;
  nativeId: unknown;
  generation: unknown;
  channelId?: string | null;
  provider?: AgentProvider | null;
  textFile: unknown;
  dedupeKey?: unknown;
  requestId?: unknown;
  inReplyTo?: unknown;
  signal?: AbortSignal;
  fetchImpl?: FetchImplementation;
  timeoutMs?: number;
  ordinary?: boolean;
}

interface OrdinaryDirectPostInput extends DirectPostInputBase {
  agentKind?: Extract<AgentMessageKind, 'request'>;
  agentTarget?: null;
  agentReplyTo?: null;
}

interface AgentRequestDirectPostInput extends DirectPostInputBase {
  agentKind?: Extract<AgentMessageKind, 'request'>;
  agentTarget: AgentAddressEnvelope;
  agentReplyTo?: null;
}

interface AgentResultDirectPostInput extends DirectPostInputBase {
  agentKind: Extract<AgentMessageKind, 'result'>;
  agentTarget?: AgentAddress | AgentAddressEnvelope | null;
  agentReplyTo: string;
}

export type DirectPostInput =
  | OrdinaryDirectPostInput
  | AgentRequestDirectPostInput
  | AgentResultDirectPostInput;

interface DiscordChannel {
  id: string;
  guild_id: string;
}

interface DiscordMessage {
  id: string | number;
}

const { encodeAgentMessage, sameAddress, verifyAgentAddress, KINDS } = require('../src/agent-message') as {
  encodeAgentMessage: (packet: AgentMessage, token: string) => string;
  sameAddress: (left: unknown, right: unknown) => boolean;
  verifyAgentAddress: (envelope: unknown, token: string) => AgentAddress;
  KINDS: Readonly<{ REQUEST: 'request'; RESULT: 'result' }>;
};
const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');
const {
  BindingError,
  PROVIDERS,
  StaleGenerationError,
  discordNonce,
  splitReply,
  validateNativeId
} = require('../src/state') as {
  BindingError: new (message?: string) => Error;
  PROVIDERS: Readonly<Record<string, string>>;
  StaleGenerationError: new (message?: string) => Error;
  discordNonce: (scope: string) => string;
  splitReply: (text: string) => string[];
  validateNativeId: (value: unknown) => unknown;
};
const { fetchDiscordChannel, sendDiscordMessage } = require('../src/discord') as {
  fetchDiscordChannel: (options: {
    token: string;
    channelId: string;
    fetchImpl?: FetchImplementation;
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<DiscordChannel>;
  sendDiscordMessage: (options: {
    token: string;
    channelId: string;
    content: string;
    nonce: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    fetchImpl?: FetchImplementation;
    messageReference?: {
      message_id: string;
      channel_id: string;
      fail_if_not_exists: boolean;
    } | null;
  }) => Promise<DiscordMessage>;
};

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requiredString(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BindingError(`${name} must be a non-empty string`);
  }
  return value;
}

function generationValue(value: unknown): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new BindingError('generation must be a positive integer');
  return generation;
}

function readTextFile(textFile: unknown): DirectPostSource {
  const sourcePath = path.resolve(requiredString(textFile, 'text-file'));
  let stat;
  try { stat = fs.statSync(sourcePath); }
  catch (error) { throw new BindingError(`text file is unavailable: ${(error as { message?: unknown }).message}`); }
  if (!stat.isFile()) throw new BindingError('text file must be a regular file');
  if (stat.size > 40000) throw new BindingError('text file exceeds the 10000 character input limit');
  let text;
  try { text = fs.readFileSync(sourcePath, 'utf8'); }
  catch (error) { throw new BindingError(`text file is unreadable: ${(error as { message?: unknown }).message}`); }
  if (!text.length || !text.trim()) throw new BindingError('text file must contain non-empty text');
  if (text.length > 10000) throw new BindingError('text file must be at most 10000 characters');
  const parts = splitReply(text);
  if (parts.some(part => !part.trim())) throw new BindingError('text file would produce a blank Discord message; remove excess whitespace');
  if (parts.some(part => part.length > 2000)) throw new BindingError('direct post part exceeds Discord 2000 character limit');
  return { sourcePath, text, textHash: hash(text), parts };
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

function inReplyToValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, 'in-reply-to', 128);
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

function resolveAgentReplyRequest(state: DirectPostState, replyTo: string, source: AgentAddress, target: AgentAddress | null = null): AgentMessage {
  const candidates = state.listReceipts()
    .filter(row => row.kind === 'agent-message')
    .map(row => {
      try {
        const detail: unknown = JSON.parse(row.detail);
        const packet = detail && typeof detail === 'object' ? (detail as Record<string, unknown>).packet || null : null;
        return packet ? { packet: packet as Record<string, unknown>, discordId: row.discord_id } : null;
      } catch { return null; }
    })
    .filter((candidate): candidate is { packet: Record<string, unknown>; discordId: string | null } => candidate !== null &&
      candidate.packet.kind === KINDS.REQUEST &&
      (target === null || sameAddress(candidate.packet.source, target)) && sameAddress(candidate.packet.target, source));
  const matches = candidates.filter(candidate => candidate.discordId === replyTo || candidate.packet.id === replyTo);
  if (matches.length !== 1) throw new BindingError('agent reply target is unknown or does not match the active request');
  const match = matches[0];
  if (!match) throw new BindingError('agent reply target is unknown or does not match the active request');
  return match.packet as unknown as AgentMessage;
}

function agentNonceScope(source: DirectPostBinding | AgentAddress, destination: AgentAddress, requestId: string, partIndex: number): string {
  return hash(['agent-post-v1', canonicalAddress(source), canonicalAddress(destination), requestId, partIndex]);
}

function partMeta(binding: DirectPostBinding, operatorId: string, requestId: string, inReplyTo: string | null,
  sourcePath: string, textHash: string, parts: readonly string[], partIndex: number, agentTarget: AgentAddress | null = null): DirectPostPartMeta {
  const nonceScope = agentTarget === null
    ? `direct:${requestId}:${partIndex}`
    : agentNonceScope(binding, agentTarget, requestId, partIndex);
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
    binding
  };
}

function outcomeFor(error: unknown): DirectPostOutcome {
  const outcome = (error as { outcome?: unknown } | null | undefined)?.outcome;
  return typeof outcome === 'string' && Object.values(DIRECT_POST_OUTCOMES).includes(outcome as DirectPostOutcome)
    ? outcome as DirectPostOutcome
    : 'unknown';
}

function errorStatus(error: unknown): unknown {
  return (error as { status?: unknown }).status;
}

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown }).message || error);
}

async function runDirectPost({ state, token, nativeId, generation, channelId = null, provider = null, textFile,
  dedupeKey, requestId: legacyRequestId, inReplyTo = null, signal, fetchImpl, timeoutMs, ordinary = false,
  agentTarget = null, agentKind = KINDS.REQUEST, agentReplyTo = undefined }: DirectPostInput): Promise<DirectPostResult> {
  const binding = resolveDirectBinding(state, { nativeId, generation: generationValue(generation), channelId, provider, ordinary });
  const operatorId = state.requireConfig().operatorId;
  let source = readTextFile(textFile);
  const replyTarget = inReplyToValue(inReplyTo);
  const isAgentMessage = agentTarget !== null || agentKind === KINDS.RESULT;
  const explicitRequestId = resolveDedupeKey({ dedupeKey, requestId: legacyRequestId }, { required: isAgentMessage });
  let deliveryTarget: AgentAddress | null = null;
  if (isAgentMessage) {
    if (replyTarget !== null) throw new BindingError('agent messages use agent reply correlation, not Discord reply targets');
    const address = canonicalAddress(binding);
    if (agentKind === KINDS.RESULT) {
      const replyTo = requiredString(agentReplyTo, 'agent-reply-to', 128);
      const hasProof = agentTarget !== null && typeof agentTarget === 'object' && Object.hasOwn(agentTarget, 'proof');
      if (hasProof) agentTarget = verifyAgentAddress(agentTarget, token);
      deliveryTarget = resolveAgentReplyRequest(state, replyTo, address,
        agentTarget as AgentAddress | null).source;
      agentTarget = deliveryTarget;
      agentReplyTo = replyTo;
    } else {
      deliveryTarget = verifyAgentAddress(agentTarget, token);
      agentTarget = deliveryTarget;
    }
    const packetTarget = deliveryTarget as AgentAddress;
    const packet = {
      id: explicitRequestId as string,
      kind: agentKind,
      source: address,
      target: packetTarget,
      replyTo: (agentReplyTo ?? null) as string | null,
      text: source.text
    } as unknown as AgentMessage;
    const wire = encodeAgentMessage(packet, token);
    source = { ...source, textHash: hash(JSON.stringify(packet)), parts: [wire] };
  }
  const requestId = requestIdFor(binding, operatorId, source.sourcePath, source.textHash, explicitRequestId, replyTarget);
  state.recoverDirectPostReceipts();
  const parts: DirectPostPartResult[] = [];
  let claimedAny = false;
  let recorded = false;
  for (let partIndex = 0; partIndex < source.parts.length; partIndex += 1) {
    if (signal?.aborted) {
      parts.push({ index: partIndex, status: 'not_sent', messageId: null });
      break;
    }
    const meta = partMeta(binding, operatorId, requestId, replyTarget, source.sourcePath, source.textHash, source.parts, partIndex, deliveryTarget);
    if (deliveryTarget !== null) meta.deliveryChannelId = deliveryTarget.channelId;
    if (deliveryTarget !== null) {
      let existing;
      try { existing = state.inspectDirectPostPart(meta); }
      catch (error) {
        if (!(error instanceof StaleGenerationError)) throw error;
        parts.push({ index: partIndex, status: 'stale', messageId: null });
        break;
      }
      if (existing) {
        parts.push({ index: partIndex, status: existing.status, messageId: existing.outcome?.messageId || null });
        if (existing.status !== 'sent') break;
        continue;
      }
      try {
        await verifyAgentDestination({ token, agentTarget: deliveryTarget, fetchImpl, signal, timeoutMs });
      } catch (error) {
        const preflight = state.recordDirectPostPreflight(meta, outcomeFor(error), {
          status: errorStatus(error) || null, error: errorMessage(error).slice(0, 300)
        });
        parts.push({ index: partIndex, status: preflight.outcome, messageId: null });
        break;
      }
      if (!state.directPostBindingCurrent(binding, operatorId)) {
        const stale = state.recordDirectPostPreflight(meta, 'stale', { reason: 'binding changed during destination lookup' });
        parts.push({ index: partIndex, status: stale.outcome, messageId: null });
        break;
      }
      if (signal?.aborted) {
        const stopped = state.recordDirectPostPreflight(meta, 'not_sent', { reason: 'direct post stopped before custody' });
        parts.push({ index: partIndex, status: stopped.outcome, messageId: null });
        break;
      }
    }
    let claim;
    try { claim = state.beginDirectPostPart(meta); }
    catch (error) {
      if (!(error instanceof StaleGenerationError)) throw error;
      if (deliveryTarget !== null) {
        const stale = state.recordDirectPostPreflight(meta, 'stale', { reason: 'binding changed before custody' });
        parts.push({ index: partIndex, status: stale.outcome, messageId: null });
      } else {
        parts.push({ index: partIndex, status: 'stale', messageId: null });
      }
      break;
    }
    if (!claim.claimed) {
      parts.push({ index: partIndex, status: claim.status, messageId: claim.outcome?.messageId || null });
      if (claim.status !== 'sent') break;
      continue;
    }
    claimedAny = true;
    if (!state.directPostBindingCurrent(binding, operatorId)) {
      const stale = state.recordDirectPostOutcome(requestId, claim.attemptId, 'stale', { reason: 'binding changed before network' });
      parts.push({ index: partIndex, status: stale.outcome });
      break;
    }
    try {
      if (!state.directPostBindingCurrent(binding, operatorId)) {
        const stale = state.recordDirectPostOutcome(requestId, claim.attemptId, 'stale', { reason: 'binding changed before send' });
        parts.push({ index: partIndex, status: stale.outcome });
        break;
      }
      const sent = await sendDiscordMessage({ token, channelId: deliveryTarget?.channelId || binding.channelId, content: source.parts[partIndex], nonce: claim.nonce,
        messageReference: replyTarget === null ? null : { message_id: replyTarget, channel_id: binding.channelId, fail_if_not_exists: true },
        signal, fetchImpl, timeoutMs });
      const outcome = state.recordDirectPostOutcome(requestId, claim.attemptId, 'sent', { messageId: String(sent.id), status: 200 });
      parts.push({ index: partIndex, status: outcome.outcome, messageId: outcome.messageId });
      recorded = true;
    } catch (error) {
      const outcome = outcomeFor(error);
      const recorded = state.recordDirectPostOutcome(requestId, claim.attemptId, outcome, { status: errorStatus(error) || null, error: errorMessage(error).slice(0, 300) });
      parts.push({ index: partIndex, status: recorded.outcome, messageId: recorded.messageId || null });
      break;
    }
  }
  const status = parts.every(part => part.status === 'sent') ? 'sent' : parts.find(part => part.status !== 'sent')?.status || 'not_sent';
  const duplicate = !claimedAny && parts.length > 0 && parts.every(part => part.status === 'sent');
  return { requestId, dedupeKey: requestId, inReplyTo: replyTarget, channelId: deliveryTarget?.channelId || binding.channelId, provider: binding.provider,
    nativeId: binding.nativeId, generation: binding.generation, status, state: status, recorded, duplicate,
    messageIds: parts.filter((part): part is DirectPostPartResult & { messageId: string } => typeof part.messageId === 'string')
      .map(part => part.messageId), parts };
}

export { readTextFile, resolveDedupeKey, resolveDirectBinding, requestIdFor, runDirectPost };
