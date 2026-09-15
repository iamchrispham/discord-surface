import type { Attachment } from '../../attachments';
import type { AgentAddress, AgentMessage, AgentProvider } from '../../agent-message';
import type {
  COURIER_ATTEMPT_STATES,
  COURIER_OUTCOMES,
  COURIER_RESULT_STATUSES,
  COURIER_ROUTE_STATES,
  COURIER_SOURCE_KINDS,
  ENVELOPE_TYPE
} from './constants';

export interface CourierRoute {
  schema: `${typeof ENVELOPE_TYPE}:route`;
  routeId: string;
  routeGeneration: number;
  status: typeof COURIER_ROUTE_STATES[keyof typeof COURIER_ROUTE_STATES];
  guildId: string;
  parentChannelId: string;
  deliveryChannelId: string;
  target: AgentAddress;
  courier: CourierIdentity;
  receiptId?: number;
  createdAt?: string;
  reason?: string;
}

export interface CourierIdentity {
  provider: AgentProvider;
  nativeId: string;
  workspace: string;
  sessionRoot: string | null;
  recipientThreadId: string;
  hostId: string | null;
}

export interface CourierObserverCursor {
  file: string | null;
  offset: number;
  since?: number;
  tail?: string;
  tailBytes?: string;
}

export interface CourierAgentSource {
  kind: typeof COURIER_SOURCE_KINDS.AGENT;
  authorId: string | null;
  packet: AgentMessage;
  wire: string;
}

export interface CourierHumanSource {
  kind: typeof COURIER_SOURCE_KINDS.HUMAN;
  authorId: string;
  isBot: false;
  content: string;
  attachments: readonly Attachment[];
}

export type CourierSource = CourierAgentSource | CourierHumanSource;

export interface CourierMessage {
  id: string;
  guildId: string;
  channelId: string;
  deliveryChannelId: string;
  provider: AgentProvider;
  nativeId: string;
  generation: number;
  content: string;
  attachments?: readonly Attachment[] | null;
  agentMessage?: AgentMessage | null;
  state: string;
  authorId?: string;
  decisionResult?: unknown;
}

export interface CourierDispatchInput {
  routeId?: string | null;
  prompt: string;
  observerCursor?: CourierObserverCursor | null;
}

export interface CourierEnvelope {
  type: typeof ENVELOPE_TYPE;
  attemptId: string;
  messageId: string;
  route: { routeId: string; routeGeneration: number };
  recipient: { threadId: string; hostId: string | null };
  courier: CourierIdentity;
  parent: {
    guildId: string;
    channelId: string;
    provider: AgentProvider;
    nativeId: string;
    generation: number;
  };
  deliveryChannelId: string;
  sourceDestination: { guildId: string; channelId: string };
  source: CourierSource;
  packet: AgentMessage | null;
  wire: string;
  payloadHash: string;
  prompt: string;
  observerCursor: CourierObserverCursor | null;
}

export interface CourierAttempt {
  attemptId: string;
  attemptKey: string;
  state: typeof COURIER_ATTEMPT_STATES[keyof typeof COURIER_ATTEMPT_STATES];
  messageId: string;
  route: { routeId: string; routeGeneration: number };
  payloadHash: string;
  courier: CourierIdentity;
  recipient: { threadId: string; hostId: string | null };
  parent: CourierEnvelope['parent'];
  deliveryChannelId: string;
  sourceDestination: CourierEnvelope['sourceDestination'];
  source: CourierSource;
  packet: AgentMessage | null;
  wire: string;
  prompt: string;
  observerCursor: CourierObserverCursor | null;
  envelope: CourierEnvelope;
  receiptId?: number;
  createdAt?: string;
}

export type CourierOutcome = typeof COURIER_OUTCOMES[keyof typeof COURIER_OUTCOMES];
export type CourierResultStatus = typeof COURIER_RESULT_STATUSES[keyof typeof COURIER_RESULT_STATUSES];
export type CourierRouteState = typeof COURIER_ROUTE_STATES[keyof typeof COURIER_ROUTE_STATES];

export interface CourierOutcomeRecord {
  attemptId: string;
  outcome: CourierOutcome;
  receiptId?: number;
  createdAt?: string;
  [key: string]: unknown;
}

export interface CourierAttemptRecord {
  attempt: CourierAttempt;
  outcome: CourierOutcomeRecord | null;
}

export interface SqlRow {
  [key: string]: unknown;
}

export interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...parameters: unknown[]): T[];
  get<T extends SqlRow = SqlRow>(...parameters: unknown[]): T | undefined;
}

export interface CourierState {
  db: { prepare(sql: string): SqlStatement };
  transaction<T>(operation: () => T): T;
  receipt(discordId: string | null, kind: string, detail: Record<string, unknown>): void;
  getBinding(channelId: string): any;
  getThreadEnrollment(threadId: string): any;
  getMessage(messageId: string): CourierMessage | null;
  getMessageRoute(deliveryChannelId: string): any;
  currentMessageBinding(message: CourierMessage): any;
  isInteractionMessage(messageId: string): boolean;
  requireConfig(): Record<string, string>;
}

export interface CourierDependencies {
  BindingError: new (message: string) => Error;
  MESSAGE_STATES: { ACCEPTED: string; DISPATCHING: string };
  PROVIDERS: Record<string, AgentProvider>;
  READINESS: { READY: string };
  THREAD_STATES: { READY: string };
  assertText(value: unknown, name: string, max?: number): string;
  assertUuid(value: unknown, name?: string): string;
  assertProvider(value: unknown): AgentProvider;
  parseJson(value: unknown, fallback: null): Record<string, any> | null;
  now(): string;
}
