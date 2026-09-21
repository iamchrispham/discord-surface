import type { MessageState } from '../../acknowledgment';
import type { AgentProvider } from '../../agent-message';
import type { Readiness } from '../../topic';
import type { ThreadEnrollment, ThreadEnrollmentCoverageProof } from '../thread-enrollment';
import type { OrdinaryReceiptKind } from '../../ordinary/constants';

export interface OrdinaryBindingSqlStatement {
  all<T extends Record<string, unknown> = Record<string, unknown>>(...parameters: unknown[]): T[];
  get<T extends Record<string, unknown> = Record<string, unknown>>(...parameters: unknown[]): T | undefined;
  run(...parameters: unknown[]): unknown;
}

export interface OrdinaryBindingDatabase {
  prepare(sql: string): OrdinaryBindingSqlStatement;
}

export interface OrdinaryBindingIdentity {
  sessionId: string;
  threadId: string;
  [key: string]: unknown;
}

export interface OrdinaryNativeProof {
  file: string;
  sessionId: string;
  threadId: string;
  workspace: string;
  sessionRoot?: string | null;
  [key: string]: unknown;
}

export type OrdinaryMessageState = Extract<MessageState, 'dispatching' | 'uncertain' | 'submitted'>;
export type OrdinaryProvider = Extract<AgentProvider, 'codex'>;
export type OrdinaryReadiness = Extract<Readiness, 'pending'>;

type OrdinaryMessageStates = {
  DISPATCHING: Extract<MessageState, 'dispatching'>;
  UNCERTAIN: Extract<MessageState, 'uncertain'>;
  SUBMITTED: Extract<MessageState, 'submitted'>;
};

type OrdinaryProviders = {
  CODEX: OrdinaryProvider;
};

type OrdinaryReadinessValues = {
  PENDING: OrdinaryReadiness;
};

type OrdinaryHandoffHistory = Record<string, unknown>;

export interface OrdinaryBindingInput {
  channelId: string;
  guildId: string;
  nativeId: string;
  workspace: string;
  provider?: AgentProvider;
  sessionRoot?: string | null;
  conductorId?: string | null;
  repoKey?: string | null;
  readiness?: Readiness;
  ordinaryIdentity?: OrdinaryBindingIdentity | null;
  [key: string]: unknown;
}

export interface OrdinaryBindingHandlerInput {
  channelId: string;
  guildId: string;
  nativeId: string;
  workspace: string;
  provider?: OrdinaryProvider;
  sessionRoot?: string | null;
  conductorId?: string | null;
  repoKey?: string | null;
  readiness?: Readiness;
  ordinaryIdentity?: OrdinaryBindingIdentity | null;
  [key: string]: unknown;
}

export interface OrdinaryBindingRecord extends OrdinaryBindingInput {
  active: boolean;
  generation: number;
  provider: AgentProvider;
}

export interface OrdinaryHandoffRecord {
  channelId: string;
  provider: AgentProvider;
  fromNativeId: string;
  fromGeneration: number;
  nativeId: string;
  generation: number;
  workspace: string;
  sessionRoot?: string | null;
}

export interface OrdinaryBindOptions {
  intakeCutoff?: string | null;
  intakeCutoffDetail?: string | null;
  beforeMutation?: (() => void) | undefined;
}

export interface OrdinaryRebindOptions {
  resetIntake?: boolean;
  sessionRootOverride?: string | null;
  intakeCutoff?: string | null;
  enrollmentProof?: ThreadEnrollmentCoverageProof | null;
  beforeMutation?: (() => void) | undefined;
}

export type OrdinaryRebindHandlerOptions = Pick<OrdinaryRebindOptions, 'beforeMutation'>;

export interface OrdinaryBindingState {
  db: OrdinaryBindingDatabase;
  ordinaryHandoffPauses: { delete(channelId: string): unknown };
  ordinaryHandoffPauseSnapshots?: { delete(channelId: string): unknown };
  bind(binding: OrdinaryBindingInput, options?: OrdinaryBindOptions): OrdinaryBindingRecord | null;
  rebind(binding: OrdinaryBindingInput, options?: OrdinaryRebindOptions): OrdinaryBindingRecord | null;
  getBinding(channelId: string | undefined): OrdinaryBindingRecord | null;
  isOrdinaryBindingRecord(binding: OrdinaryBindingRecord | null): binding is OrdinaryBindingRecord;
  isOrdinaryBinding(binding: OrdinaryBindingRecord | null): binding is OrdinaryBindingRecord;
  transaction<T>(operation: () => T): T;
  hasUnresolved(channelId: string): boolean;
  hasUnresolvedOrdinaryPost(channelId: string): boolean;
  listThreadEnrollments(parentChannelId?: string | null): ThreadEnrollment[];
  assertThreadEnrollmentCoverage?(parentChannelId: string, proof: ThreadEnrollmentCoverageProof): void;
  bindingInput(binding: OrdinaryBindingInput, existing?: OrdinaryBindingRecord | null): OrdinaryBindingInput;
  assertLegacyMigrationSafe(channelId: string): void;
  receipt(discordId: string | null, kind: OrdinaryReceiptKind, detail: Record<string, unknown>): void;
  _findOrdinaryHandoff(handoffId: string): OrdinaryHandoffHistory | null;
  hasUnboundReceipt(channelId: string, generation: number): boolean;
  assertNativeOwnerFree(provider: AgentProvider, nativeId: string, channelId?: string): void;
  setIntakeCutoffInTransaction(
    channelId: string,
    guildId: string,
    intakeCutoff: string,
    detail: string,
    expectedBinding?: OrdinaryBindingRecord
  ): unknown;
}

interface OrdinaryErrorConstructor {
  new (message: string): Error;
}

export interface OrdinaryBindingDependencies {
  BindingError: OrdinaryErrorConstructor;
  StaleGenerationError: OrdinaryErrorConstructor;
  MESSAGE_STATES: OrdinaryMessageStates;
  PROVIDERS: OrdinaryProviders;
  READINESS: OrdinaryReadinessValues;
  UnresolvedWorkError: OrdinaryErrorConstructor;
  assertText(value: unknown, name: string, max?: number): string;
  assertUuid(value: unknown, name?: string): string;
  compareDiscordIds(left: string, right: string): number;
  bindingMatchesExpected(
    binding: OrdinaryBindingRecord | null,
    expectedBinding: OrdinaryBindingRecord | null
  ): boolean;
  now(): string;
}

export interface OrdinaryHandoffInput {
  channelId: string;
  provider: OrdinaryProvider;
  fromNativeId: string;
  fromGeneration: number;
  nativeId: string;
  workspace: string;
  sessionRoot?: string | null;
  handoffId: string;
  identity: OrdinaryBindingIdentity;
  nativeProof: OrdinaryNativeProof;
  intakeCutoff?: string | null;
  enrollmentProof?: ThreadEnrollmentCoverageProof | null;
  beforeMutation?: () => void;
}

export interface OrdinaryHandoffResult extends OrdinaryBindingRecord {
  handoffReconciled?: boolean;
}

export interface OrdinaryBindingHandlers {
  advanceEnrolledThreadCutoffs(
    state: OrdinaryBindingState,
    parentChannelId: string,
    intakeCutoff: string,
    updatedAt: string
  ): void;
  bindOrdinary(
    state: OrdinaryBindingState,
    binding: OrdinaryBindingHandlerInput,
    identity: OrdinaryBindingIdentity,
    adoptionCutoff?: string | null,
    options?: OrdinaryBindOptions
  ): OrdinaryBindingRecord | null;
  rebindOrdinary(
    state: OrdinaryBindingState,
    binding: OrdinaryBindingHandlerInput,
    identity: OrdinaryBindingIdentity,
    nativeProof?: OrdinaryNativeProof | null,
    intakeCutoff?: string | null,
    options?: OrdinaryRebindHandlerOptions
  ): OrdinaryBindingRecord | null;
  isOrdinaryBindingRecord(state: OrdinaryBindingState, binding: OrdinaryBindingRecord | null): binding is OrdinaryBindingRecord;
  isOrdinaryBinding(state: OrdinaryBindingState, binding: OrdinaryBindingRecord | null): binding is OrdinaryBindingRecord;
  hasOrdinaryPreflight(this: OrdinaryBindingHandlers, state: OrdinaryBindingState, binding: OrdinaryBindingRecord | null): boolean;
  recordOrdinaryPreflight(
    state: OrdinaryBindingState,
    binding: OrdinaryBindingRecord | null,
    detail: OrdinaryNativeProof
  ): OrdinaryBindingRecord | null;
  handoffOrdinary(state: OrdinaryBindingState, input: OrdinaryHandoffInput): OrdinaryHandoffResult | null;
}
