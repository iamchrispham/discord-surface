import type { Attachment } from '../attachments';
import type { AgentMessage } from '../agent-message';
import type { WatcherNotice } from '../watcher-notice';
import type { DecisionResult } from '../state/decision';
import type { ENVELOPE_TYPE } from '../state/courier-route/constants';

export type NativeStateExports = {
  MESSAGE_STATES: {
    ACCEPTED: 'accepted';
    DISPATCHING: 'dispatching';
    UNCERTAIN: 'uncertain';
    SUBMITTED: 'submitted';
    REPLY_READY: 'reply_ready';
    REPLYING: 'replying';
    REPLIED: 'replied';
    DISPATCH_FAILED: 'dispatch_failed';
    REPLY_FAILED: 'reply_failed';
    REPLY_UNKNOWN: 'reply_unknown';
    AGENT_HANDLED_WITHOUT_POST: 'agent_handled_without_post';
    REJECTED: 'rejected';
  };
  PROVIDERS: {
    CODEX: 'codex';
    CLAUDE: 'claude';
  };
  validateNativeId: (value: unknown) => unknown;
};

export type NativeProviderName = NativeStateExports['PROVIDERS'][keyof NativeStateExports['PROVIDERS']];
export type MessageState = NativeStateExports['MESSAGE_STATES'][keyof NativeStateExports['MESSAGE_STATES']];

export interface PersistedObserverCursor {
  file: string | null;
  offset: number;
  since?: number;
  tail?: string;
  tailBytes?: string;
}

export interface ObserverCursor extends PersistedObserverCursor {
  since: number;
  tail: string;
}

export interface NativeMessage {
  id: string;
  channelId: string;
  guildId: string;
  provider: NativeProviderName;
  nativeId: string;
  generation: number;
  workspace: string;
  sessionRoot?: string | null;
  endpoint?: string | null;
  content: string;
  attachments?: readonly Attachment[] | null;
  agentMessage?: AgentMessage | null;
  watcherNotice?: WatcherNotice | null;
  watcherNoticeProvenance?: unknown;
  decisionResult?: DecisionResult | null;
  state: MessageState;
  replyText?: string | null;
  observerCursor?: PersistedObserverCursor | null;
}

export interface NativeBinding {
  sessionRoot?: string | null;
}

export interface CurrentBinding {
  current: boolean;
  identity?: boolean;
  binding?: NativeBinding | null;
}

export interface DispatchClaim {
  claimed?: boolean;
  message?: NativeMessage | null;
  reason?: string;
}

export interface NativeReplyInput {
  provider: NativeProviderName;
  messageId: string;
  nativeId: string;
  generation: number;
  text: string;
  parts?: readonly string[];
}

export interface NativeState {
  getMessage: (messageId: string) => NativeMessage | null | undefined;
  claimDispatch: (messageId: string) => DispatchClaim;
  markSubmitted: (messageId: string, cursor?: PersistedObserverCursor | null, marker?: string | null) => NativeMessage | null | undefined;
  markNotSubmitted: (messageId: string, error?: unknown) => NativeMessage | null | undefined;
  markUncertain: (messageId: string, error?: unknown) => NativeMessage | null | undefined;
  markObservationUnavailable: (messageId: string, detail?: unknown) => NativeMessage | null | undefined;
  recordNativeReply: (input: NativeReplyInput) => NativeReplyReceipt;
  setObserverCursor: (messageId: string, cursor: PersistedObserverCursor, marker?: string | null) => NativeMessage | null | undefined;
  currentMessageBinding?: (message: NativeMessage) => CurrentBinding | null | undefined;
}

export interface NativeReplyReceipt {
  duplicate: boolean;
  message: NativeMessage | null | undefined;
}

export const DISPATCH_STATUSES = {
  SUBMITTED: 'submitted',
  NOT_SUBMITTED: 'not_submitted',
  UNCERTAIN: 'uncertain'
} as const;

export type DispatchStatus = typeof DISPATCH_STATUSES[keyof typeof DISPATCH_STATUSES];

export interface DispatchOutcome {
  status: DispatchStatus;
  error?: Error;
  cursor?: PersistedObserverCursor | null;
  endpointUnavailable?: boolean;
}

export interface DispatchOptions {
  onCursor?: (cursor: ObserverCursor) => void;
  signal?: AbortSignal;
}

export interface CourierDispatchEnvelope {
  type: typeof ENVELOPE_TYPE;
  attemptId: string;
  messageId: string;
  prompt: string;
  route: { routeId: string; routeGeneration: number };
  parent: {
    guildId: string;
    channelId: string;
    provider: NativeProviderName;
    nativeId: string;
    generation: number;
  };
  deliveryChannelId: string;
  sourceDestination: { guildId: string; channelId: string };
  source: Record<string, unknown>;
  packet: AgentMessage | null;
  wire: string;
  payloadHash: string;
  observerCursor: PersistedObserverCursor | null;
  recipient: {
    threadId: string;
    hostId: string | null;
  };
  courier: {
    provider: NativeProviderName;
    nativeId: string;
    workspace: string;
    sessionRoot: string | null;
    recipientThreadId: string;
    hostId: string | null;
  };
}

export interface CourierDispatchOptions {
  signal?: AbortSignal;
}

export interface CodexRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export type CodexRunResult =
  | { status: typeof DISPATCH_STATUSES.SUBMITTED; stdout?: string; stderr?: string }
  | { status: typeof DISPATCH_STATUSES.NOT_SUBMITTED | typeof DISPATCH_STATUSES.UNCERTAIN; error: Error };

export interface ObserveCodexOptions {
  marker?: string;
  timeoutMs?: number;
  root?: string;
  resolveRoot?: () => string | null | undefined;
  pollMs?: number;
  signal?: AbortSignal;
  onCursor?: (cursor: ObserverCursor) => void;
  continueUntilFinal?: boolean;
  isCurrent?: () => boolean;
}

export interface CodexObservation {
  text?: string;
  parts?: readonly string[];
  stopped?: boolean;
  cursor: ObserverCursor;
}

export interface WaitForReplyOptions {
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  continueUntilFinal?: boolean;
  isCurrent?: () => boolean;
}

export interface WaitForReplyResult {
  text?: string | null;
  stopped?: boolean;
  cursor?: PersistedObserverCursor | null;
}

export interface ObserveOutcome {
  cursor?: PersistedObserverCursor | null;
  status?: DispatchStatus;
}

export interface ProviderObservation {
  text?: string | null;
  parts?: readonly string[];
  stopped?: boolean;
  cursor?: PersistedObserverCursor | null;
}

export interface NativeProvider {
  dispatch: (message: NativeMessage, options?: DispatchOptions) => Promise<DispatchOutcome>;
  dispatchCourier?: (envelope: CourierDispatchEnvelope, options?: CourierDispatchOptions) => Promise<DispatchOutcome>;
  observe?: (message: NativeMessage, outcome: ObserveOutcome, options?: ObserveCodexOptions) => Promise<ProviderObservation | null> | ProviderObservation | null;
}

export interface ClaudeSessionIdentity {
  file: string;
  sessionId: string;
  threadId: string;
  workspace: string;
}

export interface ClaudeMetadataRow {
  sessionId?: unknown;
  payload?: { session_id?: unknown } | null;
  entrypoint?: unknown;
  version?: unknown;
  cwd?: unknown;
}

export interface ClaudeBindingExpectation {
  nativeId: string;
  generation: number;
  endpoint: string;
  workspace: string;
}

export interface ClaudeChannelIdentity extends ClaudeSessionIdentity {
  endpoint: string;
  harness: 'claude-code';
  generation: number;
  channelReady: true;
}

export interface UnixJsonResponse {
  statusCode?: number;
  body: string;
  wrote: boolean;
}

export interface NativeError extends Error {
  code?: string | number;
  wrote?: boolean;
}

export interface DispatchReport {
  status: string;
  message: NativeMessage | null | undefined;
  error?: unknown;
}

