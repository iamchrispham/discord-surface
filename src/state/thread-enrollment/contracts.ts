import type { AgentProvider } from '../../agent-message';
import type { Readiness } from '../../topic';

export const THREAD_STATES = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  GAP: 'gap',
  UNAVAILABLE: 'unavailable'
} as const);

export type ThreadState = typeof THREAD_STATES[keyof typeof THREAD_STATES];

export const THREAD_DEACTIVATION_DETAILS = Object.freeze({
  UNBOUND: 'parent binding was unbound',
  GENERATION_CHANGED: 'parent binding generation changed'
} as const);

export type ThreadDeactivationDetail = typeof THREAD_DEACTIVATION_DETAILS[keyof typeof THREAD_DEACTIVATION_DETAILS];

export const THREAD_RECEIPT_KINDS = Object.freeze({
  ENROLLED: 'thread-enrolled',
  BASELINE: 'thread-baseline',
  BOUNDARY: 'thread-boundary',
  CHECKPOINT: 'thread-checkpoint',
  RECONCILED: 'thread-reconcile-requested'
} as const);

export type ThreadReceiptKind = typeof THREAD_RECEIPT_KINDS[keyof typeof THREAD_RECEIPT_KINDS];

export const THREAD_INTAKE_REASONS = Object.freeze({
  GAP: 'thread-gap',
  UNAVAILABLE: 'thread-unavailable'
} as const);

export type ThreadIntakeReason = typeof THREAD_INTAKE_REASONS[keyof typeof THREAD_INTAKE_REASONS];

export interface ThreadBinding {
  channelId: string;
  guildId: string;
  provider: AgentProvider;
  nativeId: string;
  workspace: string;
  sessionRoot?: string | null;
  endpoint?: string | null;
  categoryId?: string | null;
  conductorId?: string | null;
  repoKey?: string | null;
  readiness: Readiness;
  generation: number;
  active: boolean;
  updatedAt?: string;
}

export interface ThreadEnrollment {
  threadId: string;
  parentChannelId: string;
  guildId: string;
  state: ThreadState;
  active: boolean;
  adoptedThroughId: string | null;
  adoptedAt: string | null;
  lastSeenId: string | null;
  recoveredThroughId: string | null;
  lastAcceptedId: string | null;
  gapFrom: string | null;
  gapTo: string | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadRoute {
  binding: ThreadBinding;
  enrollment: ThreadEnrollment | null;
  deliveryChannelId: string;
  ready: boolean;
  handoffCutoffId: string | null;
}

export interface ThreadEnrollmentInput {
  threadId: string;
  parentChannelId: string;
  guildId: string;
  adoptionCutoff?: string | null;
}

export interface ThreadEnrollmentCoverageProof {
  parentChannelId: string;
  enrollments: Array<Pick<ThreadEnrollment, 'threadId' | 'active' | 'recoveredThroughId' | 'updatedAt'>>;
}

export interface SqlRow {
  [key: string]: unknown;
}

interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...parameters: unknown[]): T[];
  get<T extends SqlRow = SqlRow>(...parameters: unknown[]): T | undefined;
  run(...parameters: unknown[]): unknown;
}

export interface ThreadEnrollmentDatabase {
  prepare(sql: string): SqlStatement;
}

export interface ThreadEnrollmentState {
  db: ThreadEnrollmentDatabase;
  transaction<T>(operation: () => T): T;
  getBinding(channelId: string): ThreadBinding | null;
  receipt(discordId: string | null, kind: ThreadReceiptKind, detail: Record<string, unknown>): void;
}

interface ErrorConstructor {
  new (message: string): Error;
}

export interface ThreadEnrollmentDependencies {
  BindingError: ErrorConstructor;
  THREAD_STATES: typeof THREAD_STATES;
  READINESS: { READY: Readiness };
  assertText(value: unknown, name: string, max?: number): string;
  bindingMatchesExpected(binding: ThreadBinding | null, expected: ThreadBinding | null): boolean;
  compareDiscordIds(left: string | null, right: string | null): number;
  now(): string;
}

export interface ThreadEnrollmentHandlers {
  getMessageRoute(state: ThreadEnrollmentState, deliveryChannelId: string): ThreadRoute | null;
  enrollThread(state: ThreadEnrollmentState, input: ThreadEnrollmentInput, expectedBinding?: ThreadBinding | null): ThreadEnrollment | null;
  getThreadEnrollment(state: ThreadEnrollmentState, threadId: string): ThreadEnrollment | null;
  listThreadEnrollments(state: ThreadEnrollmentState, parentChannelId?: string | null): ThreadEnrollment[];
  assertEnrollmentCoverage(state: ThreadEnrollmentState, parentChannelId: string, proof: ThreadEnrollmentCoverageProof): void;
  deactivateThreadEnrollments(state: ThreadEnrollmentState, parentChannelId: string, expectedBinding?: ThreadBinding | null, detail?: ThreadDeactivationDetail): number;
  setThreadBaseline(state: ThreadEnrollmentState, threadId: string, latestId: string | null, expectedBinding?: ThreadBinding | null, expectedEnrollment?: ThreadEnrollment | null): ThreadEnrollment | null;
  markThreadBoundary(
    state: ThreadEnrollmentState,
    threadId: string,
    nextState: ThreadState,
    detail?: string | null,
    gapFrom?: string | null,
    gapTo?: string | null,
    expectedBinding?: ThreadBinding | null,
    coverageId?: string | null,
    lastSeenBaselineId?: string | null,
    expectedEnrollment?: ThreadEnrollment | null
  ): ThreadEnrollment | null;
  checkpointThread(state: ThreadEnrollmentState, threadId: string, coverageId: string, expectedBinding?: ThreadBinding | null, expectedEnrollment?: ThreadEnrollment | null): ThreadEnrollment | null;
  reconcileThread(state: ThreadEnrollmentState, threadId: string, expectedBinding?: ThreadBinding | null): ThreadEnrollment | null;
  noteThreadMessage(state: ThreadEnrollmentState, threadId: string, messageId: string, accepted?: boolean, coverageId?: string | null): ThreadEnrollment | null;
}
