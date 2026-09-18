type AgentAddress = import('./agent-message').AgentAddress;
type AgentAddressEnvelope = import('./agent-message').AgentAddressEnvelope;
type AgentMessage = import('./agent-message').AgentMessage;
type AgentMessageKind = import('./agent-message').AgentMessageKind;
type AgentProvider = import('./agent-message').AgentProvider;
type AgentPresentation = import('./agent-presentation').AgentPresentation;
type DirectPostFileManifest = import('./direct-post-file').DirectPostFileManifest;
type DirectPostFilePreparation = import('./direct-post-file').DirectPostFilePreparation;
type WatcherNotice = import('./watcher-notice').WatcherNotice;
type WatcherAddress = import('./watcher-notice').WatcherAddress;

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
  agentPacket?: AgentMessage;
  watcherNotice?: WatcherNotice;
  presentation: AgentPresentation;
  caption?: string;
  fileManifest?: DirectPostFileManifest;
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
  getMessageRoute?(deliveryChannelId: string): DirectPostRoute | null;
  listReceipts(): DirectPostReceiptRow[];
  recoverDirectPostReceipts(): void;
  inspectDirectPostPart(meta: DirectPostPartMeta): DirectPostInspection | null;
  recordDirectPostPreflight(meta: DirectPostPartMeta, outcome: DirectPostOutcome, detail?: Record<string, unknown>): DirectPostReceiptDetail;
  beginDirectPostPart(meta: DirectPostPartMeta): DirectPostClaim;
  directPostBindingCurrent(binding: DirectPostBinding, operatorId: string, deliveryChannelId?: string | null): boolean;
  directPostOwnerIdentity(pid: number): { ownerPid: number; ownerStartTime: string | null; ownerCommand: string | null } | null;
  recordDirectPostOutcome(requestId: string, attemptId: string, outcome: DirectPostOutcome, detail?: Record<string, unknown>): DirectPostReceiptDetail;
  directPostFilePreparation?(requestId: string): DirectPostFilePreparation | null;
  beginDirectPostFilePreparation?(seed: Record<string, unknown>): DirectPostFilePreparation;
  admitDirectPostFilePreparation?(preparationId: string, manifest: DirectPostFileManifest): DirectPostFilePreparation;
  getWatcherNoticeArm?(armKey: string): {
    armKey: string;
    provider: 'claude';
    source: WatcherAddress;
    target: WatcherAddress;
    workspace: string;
    endpoint: string | null;
    conductorId: string | null;
    repoKey: string | null;
    generation: number;
  } | null;
  authorizeWatcherNoticeSend?(packet: WatcherNotice): { arm: unknown; binding: DirectPostBinding; route: DirectPostRoute };
  recordWatcherNoticeTrigger?(packet: WatcherNotice): { duplicate: boolean; packet: WatcherNotice; receiptId?: number };
}

export interface DirectPostSource {
  sourcePath: string;
  text: string;
  textHash: string;
  parts: string[];
  displayParts?: string[];
  fileManifest?: DirectPostFileManifest;
  filePreparation?: DirectPostFilePreparation;
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
  filePreparationId?: string;
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
  method?: string;
  headers?: Record<string, string>;
  body?: string | FormData;
  signal?: AbortSignal;
  [key: string]: unknown;
}

export type FetchImplementation = (url: string, options: FetchOptions) => Promise<FetchResponse>;

interface DirectPostInputBase {
  state: DirectPostState;
  token: string;
  nativeId: unknown;
  generation: unknown;
  channelId?: string | null;
  agentThreadId?: string | null;
  provider?: AgentProvider | null;
  textFile?: unknown;
  attachmentFile?: unknown;
  resume?: boolean;
  stateDir?: string;
  dedupeKey?: unknown;
  requestId?: unknown;
  inReplyTo?: unknown;
  signal?: AbortSignal;
  fetchImpl?: FetchImplementation;
  timeoutMs?: number;
  ordinary?: boolean;
  watcherNotice?: { packet: WatcherNotice; binding: DirectPostBinding } | null;
}

interface OrdinaryDirectPostInput extends DirectPostInputBase {
  agentKind?: Extract<AgentMessageKind, 'request'>;
  agentTarget?: null;
  agentReplyTo?: null;
  agentPresentation?: Extract<AgentPresentation, 'legacy'>;
}

interface AgentRequestDirectPostInput extends DirectPostInputBase {
  agentKind?: Extract<AgentMessageKind, 'request'>;
  agentTarget: AgentAddressEnvelope;
  agentReplyTo?: null;
  agentPresentation?: AgentPresentation;
}

interface AgentResultDirectPostInput extends DirectPostInputBase {
  agentKind: Extract<AgentMessageKind, 'result'>;
  agentTarget?: AgentAddress | AgentAddressEnvelope | null;
  agentReplyTo: string;
  agentPresentation?: AgentPresentation;
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

interface DirectPostRoute {
  binding: DirectPostBinding;
  enrollment: {
    threadId: string;
    parentChannelId: string;
    guildId: string;
    active: boolean;
  } | null;
  deliveryChannelId: string;
  ready: boolean;
}

const { encodeAgentMessage, sameAddress, verifyAgentAddress, KINDS } = require('../src/agent-message') as {
  encodeAgentMessage: (packet: AgentMessage, token: string) => string;
  sameAddress: (left: unknown, right: unknown) => boolean;
  verifyAgentAddress: (envelope: unknown, token: string) => AgentAddress;
  KINDS: Readonly<{ REQUEST: 'request'; RESULT: 'result' }>;
};
const { createWatcherNotice, encodeWatcherNotice, sameWatcherAddress, WATCHER_NOTICE_PROVIDERS } = require('../src/watcher-notice') as {
  createWatcherNotice: (input: { armKey: string; triggerKey: string; source: WatcherAddress; target: WatcherAddress; text: string }) => WatcherNotice;
  encodeWatcherNotice: (packet: WatcherNotice, token: string) => string;
  sameWatcherAddress: (left: unknown, right: unknown) => boolean;
  WATCHER_NOTICE_PROVIDERS: Readonly<{ CLAUDE: 'claude' }>;
};
const { AGENT_PRESENTATIONS, agentMessagePreview } = require('../src/agent-presentation') as {
  AGENT_PRESENTATIONS: Readonly<{ LEGACY: 'legacy'; ATTACHMENT: 'attachment-v1' }>;
  agentMessagePreview: (packet: AgentMessage) => string;
};
const {
  DIRECT_POST_FILE_PHASES,
  DirectPostFileSnapshotError,
  hashDirectPostFile,
  inspectDirectPostFile,
  readDirectPostFileSnapshot,
  stageDirectPostFile,
  stagedDirectPostFilePath
} = require('../src/direct-post-file') as {
  DIRECT_POST_FILE_PHASES: Readonly<{ PREPARING: 'preparing'; ADMITTED: 'admitted'; RELEASED: 'released' }>;
  DirectPostFileSnapshotError: new (message: string, options?: { cause?: unknown }) => Error;
  hashDirectPostFile: (sourcePath: unknown) => { sourcePath: string; filename: string; size: number; sha256: string };
  inspectDirectPostFile: (sourcePath: unknown) => { sourcePath: string; filename: string; size: number };
  readDirectPostFileSnapshot: (manifest: DirectPostFileManifest) => Buffer;
  stageDirectPostFile: (input: { sourcePath: unknown; stateDir: string; preparationId: string; caption: string; captionHash: string }) => DirectPostFileManifest;
  stagedDirectPostFilePath: (stateDir: string, preparationId: string) => string;
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
    agentAttachment?: Buffer | null;
    fileAttachment?: { bytes: Buffer; filename: string } | null;
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

function receiptDetail(row: DirectPostReceiptRow): Record<string, unknown> | null {
  const raw: unknown = row.detail;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  try {
    const detail: unknown = JSON.parse(raw);
    return detail && typeof detail === 'object' && !Array.isArray(detail)
      ? detail as Record<string, unknown>
      : null;
  } catch { return null; }
}

function legacyParentSourcedResult(state: DirectPostState, binding: DirectPostBinding, requestId: string): DirectPostResult | null {
  const rows = state.listReceipts();
  const attempts = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (row.kind !== 'direct-post-attempt') continue;
    const detail = receiptDetail(row);
    const attemptId = detail?.attemptId;
    if (detail?.requestId !== requestId || typeof attemptId !== 'string') continue;
    attempts.set(attemptId, detail);
  }
  const parent = canonicalAddress(binding);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || row.kind !== 'direct-post-outcome') continue;
    const detail = receiptDetail(row);
    const outcome = detail?.outcome;
    const attemptId = detail?.attemptId;
    if (detail?.requestId !== requestId || typeof attemptId !== 'string' ||
        outcome !== DIRECT_POST_OUTCOMES.SENT && outcome !== DIRECT_POST_OUTCOMES.UNKNOWN) continue;
    const attempt = attempts.get(attemptId);
    const attemptPacket = attempt?.agentPacket;
    const packet = detail.agentPacket;
    if (!attempt || !attemptPacket || !packet || typeof attemptPacket !== 'object' || typeof packet !== 'object' ||
        !sameAddress((attemptPacket as Record<string, unknown>).source, parent) ||
        !sameAddress((packet as Record<string, unknown>).source, parent) ||
        !sameAddress((packet as Record<string, unknown>).target, (attemptPacket as Record<string, unknown>).target)) continue;
    const target = (packet as Record<string, unknown>).target as AgentAddress;
    const partIndex = Number.isSafeInteger(detail.partIndex) ? detail.partIndex as number : 0;
    const messageId = typeof detail.messageId === 'string' && detail.messageId.length > 0 ? detail.messageId : null;
    const status = outcome as DirectPostPartStatus;
    return {
      requestId,
      dedupeKey: requestId,
      inReplyTo: typeof detail.inReplyTo === 'string' ? detail.inReplyTo : null,
      channelId: target.channelId,
      provider: binding.provider,
      nativeId: binding.nativeId,
      generation: binding.generation,
      status,
      state: status,
      recorded: false,
      duplicate: status === 'sent',
      messageIds: messageId ? [messageId] : [],
      parts: [{ index: partIndex, status, messageId }]
    };
  }
  return null;
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

function resolveAgentAddress(state: DirectPostState, binding: DirectPostBinding, agentThreadId: string | null = null): AgentAddress {
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

function resolveAgentReplyRequest(state: DirectPostState, replyTo: string, source: AgentAddress, target: AgentAddress | null = null,
  legacyParent: AgentAddress | null = null): AgentMessage {
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
      (target === null || sameAddress(candidate.packet.source, target)) &&
      (sameAddress(candidate.packet.target, source) || (legacyParent !== null && sameAddress(candidate.packet.target, legacyParent))));
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
  sourcePath: string, textHash: string, parts: readonly string[], partIndex: number, sourceAddress: AgentAddress,
  agentTarget: AgentAddress | null = null,
  presentation: AgentPresentation = AGENT_PRESENTATIONS.LEGACY,
  agentPacket: AgentMessage | null = null,
  fileManifest: DirectPostFileManifest | null = null,
  watcherNotice: WatcherNotice | null = null): DirectPostPartMeta {
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
    ...(watcherNotice ? { watcherNotice } : {})
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

function directPostStateDir(state: DirectPostState, requested: string | undefined): string {
  if (requested !== undefined) return path.resolve(requiredString(requested, 'state-dir'));
  const dbPath = (state as unknown as { dbPath?: unknown }).dbPath;
  return typeof dbPath === 'string' ? path.dirname(dbPath) : process.cwd();
}

function assertFilePreparationAuthority(existing: DirectPostFilePreparation, binding: DirectPostBinding, operatorId: string,
  inReplyTo: unknown, resume = false): void {
  if (resume && inReplyTo !== undefined) throw new BindingError('direct post resume does not accept a replacement reply reference');
  const effectiveReplyTarget = inReplyTo === undefined ? existing.inReplyTo : inReplyToValue(inReplyTo);
  if (effectiveReplyTarget !== existing.inReplyTo) throw new BindingError('direct post file request cannot override immutable inReplyTo');
  for (const [key, expected, actual] of [
    ['channelId', existing.channelId, binding.channelId],
    ['guildId', existing.guildId, binding.guildId],
    ['provider', existing.provider, binding.provider],
    ['nativeId', existing.nativeId, binding.nativeId],
    ['generation', existing.generation, binding.generation],
    ['operatorId', existing.operatorId, operatorId],
    ['conductorId', existing.conductorId ?? null, binding.conductorId ?? null],
    ['repoKey', existing.repoKey ?? null, binding.repoKey ?? null]
  ] as const) {
    if (expected !== actual) throw new BindingError(`direct post resume cannot override immutable ${key}`);
  }
}

function prepareFileSource({ state, requestId, textFile, attachmentFile, resume, stateDir, binding, operatorId, inReplyTo }:
  { state: DirectPostState; requestId: string; textFile: unknown; attachmentFile: unknown; resume: boolean; stateDir?: string;
    binding: DirectPostBinding; operatorId: string; inReplyTo: unknown }): DirectPostSource {
  if (!state.directPostFilePreparation || !state.beginDirectPostFilePreparation || !state.admitDirectPostFilePreparation) {
    throw new BindingError('direct post file custody is unavailable');
  }
  const existing = state.directPostFilePreparation(requestId);
  if (resume) {
    if (attachmentFile !== undefined || textFile !== undefined) throw new BindingError('direct post resume does not accept replacement files');
    if (!existing || existing.phase !== DIRECT_POST_FILE_PHASES.ADMITTED) throw new BindingError('direct post resume requires an admitted file preparation');
    assertFilePreparationAuthority(existing, binding, operatorId, inReplyTo, true);
    return { sourcePath: existing.sourcePath, text: existing.caption, textHash: existing.captionHash,
      parts: [existing.caption], fileManifest: existing, filePreparation: existing };
  }
  if (attachmentFile === undefined) throw new BindingError('attachment-file is required for a file post');
  const captionSource = readTextFile(textFile);
  if (captionSource.parts.length !== 1) throw new BindingError('file posts require one Discord message caption');
  let inspected;
  try { inspected = inspectDirectPostFile(attachmentFile); }
  catch (error) { throw new BindingError(errorMessage(error)); }
  const captionHash = captionSource.textHash;
  if (existing && existing.phase === DIRECT_POST_FILE_PHASES.ADMITTED) {
    assertFilePreparationAuthority(existing, binding, operatorId, inReplyTo);
    let descriptor;
    try { descriptor = hashDirectPostFile(attachmentFile); }
    catch (error) { throw new BindingError(errorMessage(error)); }
    if (descriptor.filename !== existing.filename || descriptor.size !== existing.size || descriptor.sha256 !== existing.sha256 || captionHash !== existing.captionHash) {
      throw new BindingError('direct post file request identity conflicts with its admitted custody');
    }
    return { sourcePath: existing.sourcePath, text: existing.caption, textHash: existing.captionHash,
      parts: [existing.caption], fileManifest: existing, filePreparation: existing };
  }
  if (existing && existing.phase === DIRECT_POST_FILE_PHASES.PREPARING) throw new BindingError('direct post file preparation is already in progress');
  const preparationId = crypto.randomUUID();
  const root = directPostStateDir(state, stateDir);
  const ownerIdentity = state.directPostOwnerIdentity(process.pid);
  if (!ownerIdentity) throw new BindingError('direct post file preparation owner identity is unavailable');
  const seed = {
    preparationId,
    requestId,
    custodyRoot: root,
    sourcePath: inspected.sourcePath,
    stagedPath: stagedDirectPostFilePath(root, preparationId),
    filename: inspected.filename,
    size: inspected.size,
    caption: captionSource.text,
    captionHash,
    channelId: binding.channelId,
    guildId: binding.guildId,
    provider: binding.provider,
    nativeId: binding.nativeId,
    generation: binding.generation,
    operatorId,
    inReplyTo: inReplyToValue(inReplyTo),
    ...(binding.conductorId ? { conductorId: binding.conductorId } : {}),
    ...(binding.repoKey ? { repoKey: binding.repoKey } : {}),
    ...ownerIdentity
  };
  const admittedSeed = state.beginDirectPostFilePreparation(seed);
  if (admittedSeed.phase === DIRECT_POST_FILE_PHASES.ADMITTED) {
    return { sourcePath: admittedSeed.sourcePath, text: admittedSeed.caption, textHash: admittedSeed.captionHash,
      parts: [admittedSeed.caption], fileManifest: admittedSeed, filePreparation: admittedSeed };
  }
  if (admittedSeed.phase !== DIRECT_POST_FILE_PHASES.PREPARING) throw new BindingError('direct post file preparation is unavailable');
  let manifest;
  try { manifest = stageDirectPostFile({ sourcePath: attachmentFile, stateDir: root, preparationId, caption: captionSource.text, captionHash }); }
  catch (error) { throw new BindingError(`direct post file preparation ${preparationId} is not admitted: ${errorMessage(error)}`); }
  let admitted;
  try { admitted = state.admitDirectPostFilePreparation(preparationId, manifest); }
  catch (error) { throw new BindingError(`direct post file preparation ${preparationId} could not be admitted: ${errorMessage(error)}`); }
  return { sourcePath: admitted.sourcePath, text: admitted.caption, textHash: admitted.captionHash,
    parts: [admitted.caption], fileManifest: admitted, filePreparation: admitted };
}

async function runDirectPost({ state, token, nativeId, generation, channelId = null, provider = null, textFile,
  agentThreadId = null,
  dedupeKey, requestId: legacyRequestId, inReplyTo, signal, fetchImpl, timeoutMs, ordinary = false,
  agentTarget = null, agentKind = KINDS.REQUEST, agentReplyTo = null,
  agentPresentation = AGENT_PRESENTATIONS.LEGACY, attachmentFile, resume = false, stateDir, watcherNotice = null }: DirectPostInput): Promise<DirectPostResult> {
  const binding = watcherNotice
    ? watcherNotice.binding
    : resolveDirectBinding(state, { nativeId, generation: generationValue(generation), channelId, provider, ordinary });
  if (watcherNotice) {
    if (provider !== null && provider !== WATCHER_NOTICE_PROVIDERS.CLAUDE) throw new BindingError('watcher notice provider is fixed to Claude');
    if (nativeId !== binding.nativeId || Number(generation) !== binding.generation ||
        !sameWatcherAddress(watcherNotice.packet.source, canonicalAddress(binding))) {
      throw new BindingError('watcher notice does not match its frozen arm');
    }
    if (typeof state.authorizeWatcherNoticeSend !== 'function') throw new BindingError('watcher notice custody is unavailable');
    state.authorizeWatcherNoticeSend(watcherNotice.packet);
  }
  const operatorId = state.requireConfig().operatorId;
  const replyTarget = inReplyToValue(inReplyTo);
  const isAgentMessage = watcherNotice !== null || agentThreadId !== null || agentTarget !== null || agentKind === KINDS.RESULT;
  const fileRequested = attachmentFile !== undefined || resume;
  if (!Object.values(AGENT_PRESENTATIONS).includes(agentPresentation)) {
    throw new BindingError(`unsupported agent presentation: ${agentPresentation}`);
  }
  if (fileRequested && isAgentMessage) throw new BindingError('local file posts are only supported for ordinary direct posts');
  if (!isAgentMessage && agentPresentation !== AGENT_PRESENTATIONS.LEGACY) {
    throw new BindingError('attachment presentation is only supported for agent messages');
  }
  const requestedRequestId = watcherNotice
    ? resolveDedupeKey({ dedupeKey, requestId: legacyRequestId }, { required: false })
    : resolveDedupeKey({ dedupeKey, requestId: legacyRequestId }, { required: isAgentMessage });
  const explicitRequestId = watcherNotice ? requestedRequestId || watcherNotice.packet.id : requestedRequestId;
  if (watcherNotice && explicitRequestId !== watcherNotice.packet.id) {
    throw new BindingError('watcher notice dedupe key must match its frozen identity');
  }
  if (fileRequested && explicitRequestId === undefined) throw new BindingError('file posts require an explicit dedupe-key');
  if (!watcherNotice && isAgentMessage && explicitRequestId !== undefined) {
    const legacy = legacyParentSourcedResult(state, binding, explicitRequestId);
    if (legacy) return legacy;
  }
  let source = fileRequested
    ? prepareFileSource({ state, requestId: explicitRequestId as string, textFile, attachmentFile, resume, stateDir,
      binding, operatorId, inReplyTo })
    : readTextFile(textFile);
  const effectiveReplyTarget = source.filePreparation?.inReplyTo ?? replyTarget;
  let deliveryTarget: AgentAddress | null = null;
  let agentPacket: AgentMessage | null = null;
  let address = canonicalAddress(binding);
  if (!watcherNotice && isAgentMessage) address = resolveAgentAddress(state, binding, agentThreadId);
  if (watcherNotice) {
    if (agentThreadId !== null || agentTarget !== null || agentKind === KINDS.RESULT || agentReplyTo !== null) {
      throw new BindingError('watcher notices do not accept agent message options');
    }
    deliveryTarget = watcherNotice.packet.target as unknown as AgentAddress;
    if (source.text !== watcherNotice.packet.text) throw new BindingError('watcher notice content changed while reading custody');
    if (typeof state.recordWatcherNoticeTrigger !== 'function') throw new BindingError('watcher notice trigger custody is unavailable');
    state.recordWatcherNoticeTrigger(watcherNotice.packet);
    const wire = encodeWatcherNotice(watcherNotice.packet, token);
    source = {
      ...source,
      textHash: hash(JSON.stringify(watcherNotice.packet)),
      parts: [wire],
      displayParts: [wire]
    };
  } else if (isAgentMessage) {
    if (replyTarget !== null) throw new BindingError('agent messages use agent reply correlation, not Discord reply targets');
    if (agentKind === KINDS.RESULT) {
      const replyTo = requiredString(agentReplyTo, 'agent-reply-to', 128);
      const hasProof = agentTarget !== null && typeof agentTarget === 'object' && Object.hasOwn(agentTarget, 'proof');
      if (hasProof) agentTarget = verifyAgentAddress(agentTarget, token);
      const request = resolveAgentReplyRequest(state, replyTo, address,
        agentTarget as AgentAddress | null, canonicalAddress(binding));
      deliveryTarget = request.source;
      agentTarget = deliveryTarget;
      agentReplyTo = request.id;
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
    agentPacket = packet;
    const wire = encodeAgentMessage(packet, token);
    source = {
      ...source,
      textHash: hash(JSON.stringify(packet)),
      parts: [wire],
      displayParts: [agentPresentation === AGENT_PRESENTATIONS.ATTACHMENT ? agentMessagePreview(packet) : wire]
    };
  }
  const requestId = requestIdFor(binding, operatorId, source.sourcePath, source.textHash, explicitRequestId, effectiveReplyTarget);
  state.recoverDirectPostReceipts();
  const parts: DirectPostPartResult[] = [];
  let claimedAny = false;
  let recorded = false;
  const currentBinding = () => {
    if (!watcherNotice) return state.directPostBindingCurrent(binding, operatorId, address.channelId);
    try {
      state.authorizeWatcherNoticeSend?.(watcherNotice.packet);
      return true;
    } catch {
      return false;
    }
  };
  for (let partIndex = 0; partIndex < source.parts.length; partIndex += 1) {
    if (signal?.aborted) {
      parts.push({ index: partIndex, status: 'not_sent', messageId: null });
      break;
    }
    const meta = partMeta(binding, operatorId, requestId, effectiveReplyTarget, source.sourcePath, source.textHash, source.parts, partIndex, address, deliveryTarget, agentPresentation, agentPacket, source.fileManifest || null, watcherNotice?.packet || null);
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
        if (!currentBinding()) {
          const stale = state.recordDirectPostPreflight(meta, 'stale', { reason: 'binding changed during destination lookup' });
          parts.push({ index: partIndex, status: stale.outcome, messageId: null });
          break;
        }
        const preflight = state.recordDirectPostPreflight(meta, outcomeFor(error), {
          status: errorStatus(error) || null, error: errorMessage(error).slice(0, 300)
        });
        parts.push({ index: partIndex, status: preflight.outcome, messageId: null });
        break;
      }
      if (!currentBinding()) {
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
    if (!currentBinding()) {
      const stale = state.recordDirectPostOutcome(requestId, claim.attemptId, 'stale', { reason: 'binding changed before network' });
      parts.push({ index: partIndex, status: stale.outcome });
      break;
    }
    try {
      if (!currentBinding()) {
        const stale = state.recordDirectPostOutcome(requestId, claim.attemptId, 'stale', { reason: 'binding changed before send' });
        parts.push({ index: partIndex, status: stale.outcome });
        break;
      }
      const sent = await sendDiscordMessage({ token, channelId: deliveryTarget?.channelId || binding.channelId,
        content: source.displayParts?.[partIndex] ?? source.parts[partIndex],
        agentAttachment: isAgentMessage && agentPresentation === AGENT_PRESENTATIONS.ATTACHMENT
          ? Buffer.from(source.parts[partIndex], 'utf8')
          : null,
        fileAttachment: source.fileManifest ? { bytes: readDirectPostFileSnapshot(source.fileManifest), filename: source.fileManifest.filename } : null,
        nonce: claim.nonce,
        messageReference: effectiveReplyTarget === null ? null : { message_id: effectiveReplyTarget, channel_id: binding.channelId, fail_if_not_exists: true },
        signal, fetchImpl, timeoutMs });
      const outcome = state.recordDirectPostOutcome(requestId, claim.attemptId, 'sent', { messageId: String(sent.id), status: 200 });
      parts.push({ index: partIndex, status: outcome.outcome, messageId: outcome.messageId });
      recorded = true;
    } catch (error) {
      const outcome = source.fileManifest && error instanceof DirectPostFileSnapshotError ? 'not_sent' : outcomeFor(error);
      const recorded = state.recordDirectPostOutcome(requestId, claim.attemptId, outcome, { status: errorStatus(error) || null, error: errorMessage(error).slice(0, 300) });
      parts.push({ index: partIndex, status: recorded.outcome, messageId: recorded.messageId || null });
      break;
    }
  }
  const status = parts.every(part => part.status === 'sent') ? 'sent' : parts.find(part => part.status !== 'sent')?.status || 'not_sent';
  const duplicate = !claimedAny && parts.length > 0 && parts.every(part => part.status === 'sent');
  return { requestId, dedupeKey: requestId, inReplyTo: effectiveReplyTarget, channelId: deliveryTarget?.channelId || binding.channelId, provider: binding.provider,
    nativeId: binding.nativeId, generation: binding.generation, status, state: status, recorded, duplicate,
    ...(source.fileManifest ? { filePreparationId: source.fileManifest.preparationId } : {}),
    messageIds: parts.filter((part): part is DirectPostPartResult & { messageId: string } => typeof part.messageId === 'string')
      .map(part => part.messageId), parts };
}

export async function runWatcherNoticePost({ state, token, armKey, triggerKey, textFile, signal, fetchImpl, timeoutMs, stateDir }: {
  state: DirectPostState;
  token: string;
  armKey: string;
  triggerKey: string;
  textFile: unknown;
  signal?: AbortSignal;
  fetchImpl?: FetchImplementation;
  timeoutMs?: number;
  stateDir?: string;
}): Promise<DirectPostResult> {
  if (typeof state.getWatcherNoticeArm !== 'function') throw new BindingError('watcher notice arm custody is unavailable');
  const arm = state.getWatcherNoticeArm(armKey);
  if (!arm) throw new BindingError('watcher notice arm is unknown');
  const source = readTextFile(textFile);
  const packet = createWatcherNotice({ armKey, triggerKey, source: arm.source, target: arm.target, text: source.text });
  const binding: DirectPostBinding = {
    active: true,
    guildId: arm.source.guildId,
    channelId: arm.source.channelId,
    provider: arm.provider,
    nativeId: arm.source.nativeId,
    generation: arm.generation,
    conductorId: arm.conductorId,
    repoKey: arm.repoKey
  };
  return runDirectPost({
    state,
    token,
    nativeId: arm.source.nativeId,
    generation: arm.generation,
    channelId: arm.source.channelId,
    provider: arm.provider,
    textFile,
    dedupeKey: packet.id,
    signal,
    fetchImpl,
    timeoutMs,
    stateDir,
    watcherNotice: { packet, binding }
  });
}

export { readTextFile, resolveAgentAddress, resolveDedupeKey, resolveDirectBinding, requestIdFor, runDirectPost };
