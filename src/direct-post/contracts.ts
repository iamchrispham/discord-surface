type AgentAddress = import('../agent-message').AgentAddress;
type AgentAddressEnvelope = import('../agent-message').AgentAddressEnvelope;
type LegacyAgentAddressEnvelope = import('../agent-message').LegacyAgentAddressEnvelope;
type AgentMessage = import('../agent-message').AgentMessage;
type AgentMessageKind = import('../agent-message').AgentMessageKind;
type AgentProvider = import('../agent-message').AgentProvider;
type AgentPresentation = import('../agent-presentation').AgentPresentation;
type DirectPostFileManifest = import('../direct-post-file').DirectPostFileManifest;
type DirectPostFilePreparation = import('../direct-post-file').DirectPostFilePreparation;
type WatcherNotice = import('../watcher-notice').WatcherNotice;
type WatcherAddress = import('../watcher-notice').WatcherAddress;

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

export interface DirectPostConfig {
  guildId: string;
  operatorId: string;
}

export interface DirectPostReceiptRow {
  id?: number;
  kind: string;
  detail: string;
  discord_id: string | null;
  created_at?: string;
}

export interface DirectPostReceiptDetail {
  [key: string]: unknown;
  outcome: DirectPostOutcome;
  messageId?: string;
}

export interface DirectPostPartMeta {
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
  legacyAgentPacket?: AgentMessage;
  agentRequestTarget?: AgentAddress;
  watcherNotice?: WatcherNotice;
  presentation: AgentPresentation;
  caption?: string;
  fileManifest?: DirectPostFileManifest;
}

export interface DirectPostInspection {
  claimed: false;
  status: DirectPostPartStatus;
  attemptId: string;
  nonce: string;
  outcome?: DirectPostReceiptDetail;
}

export interface DirectPostClaim {
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
  directPostRows(requestId?: string | null, channelId?: string | null): DirectPostReceiptRow[];
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

export interface DirectPostInputBase {
  state: DirectPostState;
  token: string;
  nativeId: unknown;
  generation: unknown;
  channelId?: string | null;
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
  agentDestinationCurrent?: ((target: AgentAddress) => boolean) | null;
  watcherNotice?: { packet: WatcherNotice; binding: DirectPostBinding } | null;
}

export interface OrdinaryDirectPostInput extends DirectPostInputBase {
  agentMode?: false;
  agentThreadId?: never;
  agentKind?: Extract<AgentMessageKind, 'request'>;
  agentTarget?: null;
  agentReplyTo?: null;
  agentPresentation?: Extract<AgentPresentation, 'legacy'>;
}

export interface AgentRequestDirectPostInput extends DirectPostInputBase {
  agentMode?: boolean;
  agentThreadId: string;
  agentKind?: Extract<AgentMessageKind, 'request'>;
  agentTarget: AgentAddressEnvelope;
  agentReplyTo?: null;
  agentPresentation?: AgentPresentation;
}

export interface LegacyAgentRequestDirectPostInput extends DirectPostInputBase {
  agentMode?: boolean;
  agentThreadId: string | null;
  agentKind?: Extract<AgentMessageKind, 'request'>;
  agentTarget: LegacyAgentAddressEnvelope;
  agentReplyTo?: null;
  agentPresentation?: AgentPresentation;
}

export interface AgentResultDirectPostInput extends DirectPostInputBase {
  agentMode?: boolean;
  agentThreadId: string;
  agentKind: Extract<AgentMessageKind, 'result'>;
  agentTarget?: AgentAddress | AgentAddressEnvelope | null;
  agentReplyTo: string;
  agentPresentation?: AgentPresentation;
}

export interface LegacyAgentResultDirectPostInput extends DirectPostInputBase {
  agentMode?: boolean;
  // Null only recovers terminal legacy custody. A new send still requires a child.
  agentThreadId: string | null;
  agentKind: Extract<AgentMessageKind, 'result'>;
  agentTarget?: LegacyAgentAddressEnvelope | null;
  agentReplyTo: string;
  agentPresentation?: AgentPresentation;
}

export type DirectPostInput =
  | OrdinaryDirectPostInput
  | AgentRequestDirectPostInput
  | LegacyAgentRequestDirectPostInput
  | AgentResultDirectPostInput
  | LegacyAgentResultDirectPostInput;

export interface DiscordChannel {
  id: string;
  guild_id: string;
}

export interface DiscordMessage {
  id: string | number;
}

export interface DirectPostRoute {
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
