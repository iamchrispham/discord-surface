import type { DecisionResult } from '../decision/types';
import type { INTERACTION_TRANSPORT } from './constants';

interface SqlRow {
  [key: string]: unknown;
}

interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...parameters: unknown[]): T[];
  get<T extends SqlRow = SqlRow>(...parameters: unknown[]): T | undefined;
  run(...parameters: unknown[]): unknown;
}

interface InteractionDatabase {
  prepare(sql: string): SqlStatement;
}

export interface InteractionBinding {
  active: boolean;
  channelId: string;
  guildId: string;
  provider: string;
  nativeId: string;
  workspace: string;
  sessionRoot?: string | null;
  endpoint?: string | null;
  conductorId?: string | null;
  repoKey?: string | null;
  generation: number;
  readiness: string | null;
}

export interface InteractionMessage {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  content: string;
  provider: string;
  nativeId: string;
  workspace: string;
  endpoint: string | null;
  conductorId: string | null;
  repoKey: string | null;
  generation: number;
  state: string;
  decisionResult?: DecisionResult;
}

export interface InteractionState {
  db: InteractionDatabase;
  interactionVocabulary: {
    acceptedMessageState: string;
    readyReadiness: string;
  };
  transaction<T>(operation: () => T): T;
  requireConfig(): { guildId: string; operatorId: string };
  getBinding(channelId: string): InteractionBinding | null;
  getMessage(messageId: string): InteractionMessage | null;
  getIntakeWatermark?(channelId: string): { detail?: string | null } | null;
  currentMessageBinding(message: InteractionMessage): { current: boolean; binding?: InteractionBinding | null };
  getTransportReceipt(messageId: string, transport?: string | null): InteractionTransportRecord | null;
  beginTransportReceipt(messageId: string, options: {
    transport: typeof INTERACTION_TRANSPORT;
    ownerPid: number;
    ownerIdentity: unknown;
    inTransaction?: boolean;
  }): InteractionTransportRecord & { started: boolean };
  recordTransportReceiptOutcome(messageId: string, outcome: string, detail: Record<string, unknown>, transport?: string | null): InteractionTransportRecord | null;
  receipt(discordId: string | null, kind: string, detail: unknown): void;
  directPostOwnerIdentity?(pid: number): unknown;
  directPostOwnerAlive?(pid: number, expectedIdentity: unknown): boolean;
  ordinaryHandoffPauses?: Set<string>;
}

export interface InteractionTransportRecord {
  messageId: string;
  attempt?: Record<string, unknown> | null;
  outcome?: Record<string, unknown> | null;
  started?: boolean;
  reason?: string;
  nonce?: string;
}

export interface InteractionInput {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  content: '/cs' | '/cs full';
  full: boolean;
}

export interface InteractionAcceptance {
  accepted: boolean;
  duplicate?: boolean;
  stale?: boolean;
  reason?: string;
  message?: InteractionMessage | null;
  callback?: InteractionTransportRecord & { started: boolean };
}

export interface InteractionAcceptanceOptions {
  claimCallback?: boolean;
  ownerPid?: number;
  ownerIdentity?: unknown;
}
