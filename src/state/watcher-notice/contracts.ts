import type { WatcherAddress, WatcherNotice, WATCHER_NOTICE_PROVIDERS } from '../../watcher-notice';
import type { NativeReplyFilePhase } from '../native-reply-file';
import type { WATCHER_NOTICE_AUTHORITY } from '../watcher-notice';

export interface SqlRow {
  [key: string]: unknown;
}

export interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...parameters: unknown[]): T[];
  get<T extends SqlRow = SqlRow>(...parameters: unknown[]): T | undefined;
  run(...parameters: unknown[]): { changes?: number };
}

export interface WatcherDatabase {
  prepare(sql: string): SqlStatement;
}

export interface WatcherBinding extends WatcherAddress {
  active: boolean;
  workspace: string;
  endpoint?: string | null;
  sessionRoot?: string | null;
  conductorId?: string | null;
  repoKey?: string | null;
  readiness?: string;
}

export interface WatcherEnrollment {
  threadId: string;
  parentChannelId: string;
  guildId: string;
  active: boolean;
  state: string;
}

export interface WatcherRoute {
  binding: WatcherBinding;
  enrollment: WatcherEnrollment | null;
  deliveryChannelId: string;
  ready: boolean;
}

export interface WatcherNoticeArm {
  armKey: string;
  authority: typeof WATCHER_NOTICE_AUTHORITY.NOTICE_ONLY;
  provider: typeof WATCHER_NOTICE_PROVIDERS.CLAUDE;
  operatorId: string;
  source: WatcherAddress;
  target: WatcherAddress;
  workspace: string;
  endpoint: string | null;
  sessionRoot: string | null;
  conductorId: string | null;
  repoKey: string | null;
  generation: number;
  createdAt: string;
  receiptId?: number;
}

export interface WatcherNoticeCaller {
  harness?: unknown;
  sessionId?: unknown;
  threadId?: unknown;
}

export interface WatcherNoticeArmInput {
  armKey: string;
  parentChannelId: string;
  childChannelId: string;
  provider: string;
  nativeId: string;
  generation: number;
  caller: WatcherNoticeCaller;
}

export interface WatcherNoticeProvenance {
  packet: WatcherNotice;
  authorId: string;
  receiptId?: number;
  recordedAt?: string;
}

export interface FoundWatcherNotice {
  messageId: string;
  provenance: WatcherNoticeProvenance;
}

export interface WatcherMessage {
  id: string;
  guildId: string;
  channelId: string;
  deliveryChannelId?: string | null;
  authorId: string;
  provider: string;
  nativeId: string;
  generation: number;
  state: string;
  replyText?: string | null;
  replyNonce?: string | null;
  replyMessageId?: string | null;
  replyNextPart: number;
  watcherNotice?: WatcherNotice | null;
  decisionResult?: unknown;
}

export interface WatcherBindingCheck {
  binding: WatcherBinding | null;
  identity: boolean;
  current: boolean;
  deliveryChannelId: string;
  enrollment?: WatcherEnrollment | null;
}

export interface WatcherState {
  db: WatcherDatabase;
  transaction<T>(operation: () => T): T;
  requireConfig(): { operatorId: string; guildId: string };
  getBinding(channelId: string): WatcherBinding | null;
  getMessageRoute(deliveryChannelId: string): WatcherRoute | null;
  getWatcherNotice(messageId: string): WatcherNoticeProvenance | null;
  getMessage(messageId: string): WatcherMessage | null;
  nativeReplyFilePreparation(messageId: string): { phase: NativeReplyFilePhase } | null;
  currentMessageBinding(message: WatcherMessage): WatcherBindingCheck;
  hasNativeAcknowledgment(message: WatcherMessage): boolean;
  listReplyParts(messageId: string): unknown[];
  isInteractionMessage(messageId: string): boolean;
  receipt(discordId: string | null, kind: string, detail: Record<string, unknown>): void;
}

export interface ErrorConstructor {
  new (message: string): Error;
}

export interface WatcherNoticeDependencies {
  BindingError: ErrorConstructor;
  AuthorizationError: ErrorConstructor;
  StaleGenerationError: ErrorConstructor;
  StateCorruptError: ErrorConstructor;
  MESSAGE_STATES: Readonly<{
    SUBMITTED: string;
    AGENT_HANDLED_WITHOUT_POST: string;
  }>;
  NATIVE_REPLY_FILE_PHASES: typeof import('../native-reply-file').NATIVE_REPLY_FILE_PHASES;
  assertText(value: unknown, name: string, max?: number): string;
  assertUuid(value: unknown, name?: string): string;
  now(): string;
}

export interface WatcherNoticePublicationEvent {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  isBot: boolean;
}

export interface WatcherNoticeConsumeInput {
  messageId: string;
  provider: string;
  nativeId: string;
  generation: number;
  channelId?: string | null;
}
