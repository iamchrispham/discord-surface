import {
  createOrdinaryBindingHandlers,
  hasOrdinaryBindingReceipt,
  hasOrdinaryPreflightReceipt,
  type OrdinaryBindingDependencies,
  type OrdinaryBindingRecord,
  type OrdinaryBindingState,
  type OrdinaryHandoffInput
} from '../src/state/ordinary-binding';
import { ORDINARY_RECEIPT_KINDS, type OrdinaryReceiptKind } from '../src/ordinary/constants';
import type { AgentProvider } from '../src/agent-message';
import type { MessageState } from '../src/acknowledgment';
import type { Readiness } from '../src/topic';

const nativeId = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const messageStates = {
  DISPATCHING: 'dispatching',
  UNCERTAIN: 'uncertain',
  SUBMITTED: 'submitted'
} satisfies OrdinaryBindingDependencies['MESSAGE_STATES'];
const providers = { CODEX: 'codex' } satisfies OrdinaryBindingDependencies['PROVIDERS'];
const readinessValues = { PENDING: 'pending' } satisfies OrdinaryBindingDependencies['READINESS'];

const validMessageState: MessageState = messageStates.DISPATCHING;
const validProvider: AgentProvider = providers.CODEX;
const validReadiness: Readiness = readinessValues.PENDING;
const validReceiptKind: typeof ORDINARY_RECEIPT_KINDS.BOUND = ORDINARY_RECEIPT_KINDS.BOUND;
const validReceiptKindAlias: OrdinaryReceiptKind = ORDINARY_RECEIPT_KINDS.HANDOFF;

const swappedMessageStates = {
  DISPATCHING: 'uncertain',
  UNCERTAIN: 'dispatching',
  SUBMITTED: 'submitted'
} as const;
// @ts-expect-error message-state keys retain their exact values
const invalidMessageStates: OrdinaryBindingDependencies['MESSAGE_STATES'] = swappedMessageStates;
const invalidProviderMap = { CODEX: 'claude' } as const;
// @ts-expect-error ordinary provider map only accepts the Codex value
const invalidProviderMapValue: OrdinaryBindingDependencies['PROVIDERS'] = invalidProviderMap;
const invalidReadinessMap = { PENDING: 'ready' } as const;
// @ts-expect-error ordinary readiness map only accepts the pending value
const invalidReadinessMapValue: OrdinaryBindingDependencies['READINESS'] = invalidReadinessMap;

const binding: OrdinaryBindingRecord = {
  active: true,
  channelId: 'channel',
  guildId: 'guild',
  provider: 'codex',
  nativeId,
  workspace: '/tmp/workspace',
  generation: 1,
  sessionRoot: null,
  conductorId: null,
  repoKey: null
};

const state: OrdinaryBindingState = {
  db: {
    prepare: () => ({
      all: <T extends Record<string, unknown> = Record<string, unknown>>(..._parameters: unknown[]) => [] as T[],
      get: <T extends Record<string, unknown> = Record<string, unknown>>(..._parameters: unknown[]) => undefined as T | undefined,
      run: (..._parameters: unknown[]) => undefined
    })
  },
  ordinaryHandoffPauses: { delete: () => true },
  ordinaryHandoffPauseSnapshots: { delete: () => true },
  bind: value => ({ ...binding, ...value }),
  rebind: value => ({ ...binding, ...value }),
  getBinding: () => binding,
  isOrdinaryBindingRecord: (_value): _value is OrdinaryBindingRecord => true,
  isOrdinaryBinding: (_value): _value is OrdinaryBindingRecord => true,
  transaction: operation => operation(),
  hasUnresolved: () => false,
  hasUnresolvedOrdinaryPost: () => false,
  bindingInput: value => value,
  assertLegacyMigrationSafe: () => undefined,
  receipt: () => undefined,
  _findOrdinaryHandoff: () => null,
  hasUnboundReceipt: () => true,
  assertNativeOwnerFree: () => undefined,
  setIntakeCutoffInTransaction: () => undefined
};

const handlers = createOrdinaryBindingHandlers({
  BindingError: class extends Error {},
  StaleGenerationError: class extends Error {},
  UnresolvedWorkError: class extends Error {},
  MESSAGE_STATES: messageStates,
  PROVIDERS: providers,
  READINESS: readinessValues,
  assertText: value => String(value),
  assertUuid: value => String(value),
  bindingMatchesExpected: () => true,
  now: () => '2026-09-13T00:00:00.000Z'
});

const identity = { sessionId: nativeId, threadId: nativeId };
const handoff: OrdinaryHandoffInput = {
  channelId: binding.channelId,
  provider: 'codex',
  fromNativeId: binding.nativeId,
  fromGeneration: binding.generation,
  nativeId,
  workspace: binding.workspace,
  sessionRoot: null,
  handoffId: 'handoff',
  identity,
  nativeProof: {
    file: '/tmp/session.jsonl',
    sessionId: nativeId,
    threadId: nativeId,
    workspace: binding.workspace,
    sessionRoot: null
  },
  intakeCutoff: null
};

// @ts-expect-error ordinary handoffs accept the Codex provider only
const invalidHandoffProvider: OrdinaryHandoffInput = { ...handoff, provider: 'claude' };

const bound = handlers.bindOrdinary(state, { ...binding, provider: 'codex' }, identity);
const rebound = handlers.rebindOrdinary(state, { ...binding, provider: 'codex' }, identity);
const preflight = handlers.recordOrdinaryPreflight(state, binding, {
  file: '/tmp/session.jsonl', sessionId: nativeId, threadId: nativeId, workspace: binding.workspace
});
// @ts-expect-error ordinary bind requests accept the Codex provider only
handlers.bindOrdinary(state, { ...binding, provider: 'claude' }, identity);
// @ts-expect-error ordinary rebind requests accept the Codex provider only
handlers.rebindOrdinary(state, { ...binding, provider: 'claude' }, identity);
// @ts-expect-error ordinary bind handlers require a validated identity
handlers.bindOrdinary(state, { ...binding }, null);
// @ts-expect-error ordinary rebind handlers require a validated identity
handlers.rebindOrdinary(state, { ...binding }, undefined);
// @ts-expect-error ordinary preflight requires a native proof
handlers.recordOrdinaryPreflight(state, binding, {});
// @ts-expect-error rebind handler options expose only the mutation hook
handlers.rebindOrdinary(state, { ...binding }, identity, null, null, { intakeCutoff: 'cutoff' });
const transferred = handlers.handoffOrdinary(state, { ...handoff, nativeId: 'b8f0d4f6-b26a-4f96-8d37-6d7df4f1d4a0' });
const preflightViaHandler: boolean = handlers.hasOrdinaryPreflight(state, binding);
const bindingReceipt: boolean = hasOrdinaryBindingReceipt(state, binding);
const preflightReceipt: boolean = hasOrdinaryPreflightReceipt(state, binding);
state.receipt(null, ORDINARY_RECEIPT_KINDS.BOUND, { channelId: binding.channelId });
// @ts-expect-error receipt kinds reject typos
state.receipt(null, 'ordinary-boundd', {});
// @ts-expect-error receipt kinds reject nonordinary domains
state.receipt(null, 'conductor-handoff', {});

const rawHandoff = state._findOrdinaryHandoff('handoff');
if (rawHandoff) {
  // @ts-expect-error parsed journal provider remains unknown until validated
  const invalidHistoryProvider: AgentProvider = rawHandoff.provider;
  void invalidHistoryProvider;
}

const detachedPreflight = handlers.hasOrdinaryPreflight;
// @ts-expect-error hasOrdinaryPreflight requires its owning handler receiver
detachedPreflight(state, binding);

bound?.generation satisfies number | undefined;
rebound?.provider satisfies AgentProvider | undefined;
preflight?.active satisfies boolean | undefined;
transferred?.workspace satisfies string | undefined;
transferred?.handoffReconciled satisfies boolean | undefined;
validMessageState satisfies MessageState;
validProvider satisfies AgentProvider;
validReadiness satisfies Readiness;
validReceiptKind satisfies typeof ORDINARY_RECEIPT_KINDS.BOUND;
validReceiptKindAlias satisfies OrdinaryReceiptKind;
// @ts-expect-error ordinary binding records reject invalid provider values
const invalidRecordProvider: OrdinaryBindingRecord['provider'] = 'provider';
// @ts-expect-error ordinary binding records reject invalid readiness values
const invalidRecordReadiness: NonNullable<OrdinaryBindingRecord['readiness']> = 'waiting';
// @ts-expect-error native-owner checks accept only finite provider values
state.assertNativeOwnerFree('provider', nativeId);
void bindingReceipt;
void preflightReceipt;
void preflightViaHandler;
