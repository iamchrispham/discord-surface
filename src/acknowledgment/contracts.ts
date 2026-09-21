import type * as fs from 'node:fs';
import type { NativeProvider, MessageState } from '../acknowledgment';

interface SqlRow {
  [key: string]: unknown;
}

interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...parameters: unknown[]): T[];
  get<T extends SqlRow = SqlRow>(...parameters: unknown[]): T | undefined;
  run(...parameters: unknown[]): unknown;
}

interface AcknowledgmentDatabase {
  prepare(sql: string): SqlStatement;
}

export interface AcknowledgmentMessage {
  id: string;
  provider: NativeProvider;
  nativeId: string;
  generation: number;
  state: MessageState;
  channelId?: string;
  guildId?: string;
  channel?: unknown;
}

export interface AcknowledgmentBinding {
  current: boolean;
}

export interface AcknowledgmentState {
  db: AcknowledgmentDatabase;
  dbPath: string;
  transaction<T>(operation: () => T): T;
  getMessage(messageId: string): AcknowledgmentMessage | null | undefined;
  currentMessageBinding(message: AcknowledgmentMessage): AcknowledgmentBinding | null | undefined;
  receipt(discordId: string | null, kind: string, detail: unknown): void;
}

export interface NativeAcknowledgmentInput {
  provider: NativeProvider;
  messageId: string;
  nativeId: string;
  generation: number;
}

export interface AcknowledgmentCommandInput {
  id: string;
  provider: NativeProvider;
  nativeId: string;
  generation: number;
}

export interface NativeAcknowledgmentResult {
  recorded: boolean;
  duplicate: boolean;
  messageId: string;
}

export interface AcknowledgmentWaitStopped {
  outcome: 'stopped';
}

export interface AcknowledgmentWatch {
  drain(): Promise<void>;
  stop(): Promise<void>;
}

export type AcknowledgmentSend = (message: AcknowledgmentMessage, reaction: string) => Promise<unknown>;

export type AcknowledgmentDelivery = (messageId: string) => Promise<void> | null;

export interface AcknowledgmentWatchOptions {
  state: AcknowledgmentState;
  send: AcknowledgmentSend;
  deliver?: AcknowledgmentDelivery;
  onAcknowledged?: ((messageId: string) => unknown | Promise<unknown>) | null;
  logger?: (message: string) => void;
  watchFactory?: typeof fs.watch;
  rearmMs?: number;
}
