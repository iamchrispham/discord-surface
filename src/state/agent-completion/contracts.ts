import type { AgentAddress } from '../../agent-message';
import type { NativeReplyFilePhase } from '../native-reply-file';

export interface SqlRow {
  [key: string]: unknown;
}

export interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...parameters: unknown[]): T[];
  get<T extends SqlRow = SqlRow>(...parameters: unknown[]): T | undefined;
  run(...parameters: unknown[]): { changes?: number };
}

export interface CompletionDatabase {
  prepare(sql: string): SqlStatement;
}

export interface CompletionMessage {
  id: string;
  guildId: string;
  channelId: string;
  deliveryChannelId?: string | null;
  provider: string;
  nativeId: string;
  generation: number;
  state: string;
  replyText?: string | null;
  replyNonce?: string | null;
  replyMessageId?: string | null;
  replyNextPart: number;
  decisionResult?: unknown;
}

export interface CompletionBinding extends AgentAddress {
  active: boolean;
}

export interface MessageBindingCheck {
  binding: CompletionBinding | null;
  identity: boolean;
  current: boolean;
  deliveryChannelId: string;
}

export interface AgentMessageProvenance {
  routingVersion?: unknown;
  packet?: unknown;
}

export interface CompletionState {
  db: CompletionDatabase;
  transaction<T>(operation: () => T): T;
  getMessage(messageId: string): CompletionMessage | null;
  nativeReplyFilePreparation(messageId: string): { phase: NativeReplyFilePhase } | null;
  isInteractionMessage(messageId: string): boolean;
  getAgentMessage(messageId: string): AgentMessageProvenance | null;
  currentMessageBinding(message: CompletionMessage): MessageBindingCheck;
  hasNativeAcknowledgment(message: CompletionMessage): boolean;
  listReplyParts(messageId: string): unknown[];
  receipt(discordId: string, kind: string, detail: Record<string, unknown>): void;
}

export interface ErrorConstructor {
  new (message: string): Error;
}

export interface AgentCompletionDependencies {
  AGENT_COMPLETION_RECEIPTS: Readonly<{
    RESULT_CONSUMED: string;
    REQUEST_HANDLED_WITHOUT_POST: string;
  }>;
  MESSAGE_STATES: Readonly<{
    SUBMITTED: string;
    AGENT_HANDLED_WITHOUT_POST: string;
  }>;
  DIRECT_POST_ATTEMPT: string;
  DIRECT_POST_OUTCOME: string;
  NATIVE_REPLY_FILE_PHASES: typeof import('../native-reply-file').NATIVE_REPLY_FILE_PHASES;
  assertText(value: unknown, name: string, max?: number): string;
  assertProvider(value: unknown): string;
  assertUuid(value: unknown, name?: string): string;
  parseJson(value: unknown, fallback: null): Record<string, unknown> | null;
  now(): string;
  AuthorizationError: ErrorConstructor;
  BindingError: ErrorConstructor;
  StaleGenerationError: ErrorConstructor;
  StateCorruptError: ErrorConstructor;
}

export interface AgentCompletionInput {
  messageId: string;
  provider: string;
  nativeId: string;
  generation: number;
  channelId?: string | null;
}

export interface CompletionReceiptRow extends SqlRow {
  id: number;
  kind: string;
  detail: unknown;
}
