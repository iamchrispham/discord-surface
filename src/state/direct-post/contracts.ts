import type { AgentAddress, AgentMessage, AgentProvider } from '../../agent-message';
import type { WatcherNotice } from '../../watcher-notice';
import type { DirectPostFileManifest, DirectPostFilePreparation } from '../../direct-post-file';

export const DIRECT_POST_OUTCOMES = Object.freeze([
  'sent',
  'not_sent',
  'rejected',
  'rate_limited',
  'unknown',
  'stale'
] as const);

export type DirectPostOutcome = typeof DIRECT_POST_OUTCOMES[number];

export type DirectPostPartStatus = DirectPostOutcome | 'claimed' | 'in_flight';

export interface DirectPostBinding {
  active: boolean;
  channelId: string;
  guildId: string;
  provider: AgentProvider;
  nativeId: string;
  generation: number;
  conductorId?: string | null;
  repoKey?: string | null;
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
  routingVersion?: number;
  presentation?: string;
  watcherNotice?: WatcherNotice;
  caption?: string;
  fileManifest?: DirectPostFileManifest;
}

export interface DirectPostReceiptDetail {
  [key: string]: unknown;
  journal?: string;
  attemptId?: string;
  inReplyTo?: string | null;
  outcome?: string;
  messageId?: string;
  nonce?: string;
}

export interface DirectPostReceiptRow {
  id: number;
  kind: string;
  detail: DirectPostReceiptDetail;
  createdAt: string;
}

export interface DirectPostState {
  db: DirectPostDatabase;
  isAgentResultForWithdrawnRequest(packet: AgentMessage): boolean;
  activeFilePreparationCount?(): number;
  transaction<T>(operation: () => T): T;
  directPostRows(requestId?: string | null, channelId?: string | null): DirectPostReceiptRow[];
  directPostBindingCurrent(binding: DirectPostBinding, operatorId?: string | null, deliveryChannelId?: string | null): boolean;
  directPostOwnerIdentity(pid: number): DirectPostOwnerIdentity | null;
  directPostOwnerAlive(pid: number, expectedIdentity: DirectPostOwnerIdentity): boolean;
  receipt(discordId: string | null, kind: string, detail: Record<string, unknown>): void;
}

export interface DirectPostFilePreparationSeed {
  preparationId: string;
  requestId: string;
  custodyRoot: string;
  sourcePath: string;
  stagedPath: string;
  filename: string;
  size: number;
  caption: string;
  captionHash: string;
  channelId: string;
  guildId: string;
  provider: AgentProvider;
  nativeId: string;
  generation: number;
  operatorId: string;
  inReplyTo: string | null;
  conductorId?: string | null;
  repoKey?: string | null;
  ownerPid: number;
  ownerStartTime: string | null;
  ownerCommand: string | null;
}

export interface SentAgentResultRow {
  attemptReceiptId: number;
  outcomeReceiptId: number;
  messageId?: string;
  nonce?: string;
  attemptDetail: DirectPostReceiptDetail;
  outcomeDetail: DirectPostReceiptDetail;
}

export interface DirectPostOwnerIdentity {
  ownerPid: number;
  ownerStartTime: string | null;
  ownerCommand: string | null;
}

export interface DirectPostInspection {
  claimed: false;
  status: string;
  attemptId: string;
  nonce: string;
  outcome?: DirectPostReceiptDetail;
}

export interface DirectPostClaim {
  claimed: true;
  status: 'claimed';
  attemptId: string;
  nonce: string;
}

export interface DirectPostEvent {
  id?: unknown;
  channelId?: unknown;
  guildId?: unknown;
  isBot?: unknown;
  nonce?: unknown;
}

export type DirectPostOutcomeKey = 'messageId' | 'nonce';
export type DirectPostReconciliationResolution = 'sent' | 'not_sent';
export type DirectPostMatchEvent = Omit<DirectPostEvent, 'channelId' | 'guildId'> & {
  channelId: string;
  guildId: string;
};
export type DirectPostCustodyKey = keyof DirectPostPartMeta | keyof DirectPostOwnerIdentity | 'journal';
export type DirectPostOutcomeDetail = Record<string, unknown> & {
  [key in DirectPostCustodyKey]?: never;
};

export interface DirectPostOutcomeRecord extends DirectPostReceiptDetail {
  outcome: DirectPostOutcome;
}

export interface DirectPostHandlers {
  hasUnresolvedBindingPost(state: DirectPostState, channelId: string): boolean;
  hasUnresolvedOrdinaryPost(state: DirectPostState, channelId: string): boolean;
  inspectDirectPostPart(state: DirectPostState, meta: DirectPostPartMeta): DirectPostInspection | null;
  recordDirectPostPreflight(state: DirectPostState, meta: DirectPostPartMeta, outcome: DirectPostOutcome, detail?: Record<string, unknown>): DirectPostOutcomeRecord;
  beginDirectPostPart(state: DirectPostState, meta: DirectPostPartMeta): DirectPostClaim | DirectPostInspection;
  recordDirectPostOutcome(state: DirectPostState, requestId: string, attemptId: string, outcome: DirectPostOutcome, detail?: DirectPostOutcomeDetail): DirectPostOutcomeRecord;
  reconcileDirectPostOutcome(state: DirectPostState, requestId: string, attemptId: string, resolution: DirectPostReconciliationResolution, evidence: Record<string, unknown>): DirectPostOutcomeRecord;
  directPostOutcomeMatches(state: DirectPostState, event: DirectPostMatchEvent, key: DirectPostOutcomeKey, value: string): boolean;
  excludeDirectPost(this: DirectPostHandlers, state: DirectPostState, event: DirectPostEvent | null | undefined): boolean;
  findDirectPostFilePreparation(state: DirectPostState, requestId: string): DirectPostFilePreparation | null;
  beginDirectPostFilePreparation(state: DirectPostState, seed: DirectPostFilePreparationSeed): DirectPostFilePreparation;
  admitDirectPostFilePreparation(state: DirectPostState, preparationId: string, manifest: DirectPostFileManifest): DirectPostFilePreparation;
  releaseDirectPostFilePreparation(state: DirectPostState, preparationId: string, removeFile: (preparation: DirectPostFilePreparation) => void): DirectPostFilePreparation;
}

export interface SqlRow {
  [key: string]: unknown;
}

export interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...parameters: unknown[]): T[];
}

export interface DirectPostDatabase {
  prepare(sql: string): SqlStatement;
}

export interface RawReceiptRow extends SqlRow {
  id: number;
  kind: string;
  detail: unknown;
  created_at: string;
}

export interface RawOutcomeRow extends SqlRow {
  detail: unknown;
}

export interface RawAgentResultRow extends SqlRow {
  attempt_receipt_id: number;
  outcome_receipt_id: number;
  attempt_detail: unknown;
  outcome_detail: unknown;
}

export interface DirectPostErrorConstructor {
  new (message: string): Error;
}

export interface DirectPostQueryDependencies {
  db: DirectPostDatabase;
  assertText(value: unknown, name: string, max?: number): string;
  parseJson(value: unknown, fallback: null): DirectPostReceiptDetail | null;
  StateCorruptError: DirectPostErrorConstructor;
  attemptKind: string;
  outcomeKind: string;
}

export interface DirectPostDependencies {
  BindingError: DirectPostErrorConstructor;
  StaleGenerationError: DirectPostErrorConstructor;
  StateCorruptError: DirectPostErrorConstructor;
  DIRECT_POST_ATTEMPT: string;
  DIRECT_POST_OUTCOME: string;
  DIRECT_POST_FILE_PREPARATION: string;
  assertText(value: unknown, name: string, max?: number): string;
  bindingMatchesExpected(binding: DirectPostBinding | null, expected: DirectPostBinding | null): boolean;
  parseJson(value: unknown, fallback: null): DirectPostReceiptDetail | null;
  now(): string;
  DIRECT_POST_OUTCOMES?: typeof DIRECT_POST_OUTCOMES;
}
