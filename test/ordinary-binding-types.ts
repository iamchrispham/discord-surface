import {
  createOrdinaryBindingHandlers,
  hasOrdinaryBindingReceipt,
  hasOrdinaryPreflightReceipt,
  type OrdinaryBindingRecord,
  type OrdinaryBindingState,
  type OrdinaryHandoffInput
} from '../src/state/ordinary-binding';

const nativeId = '9caa5d21-2169-429d-918b-5f08651b5dbd';
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
      get: <T extends Record<string, unknown> = Record<string, unknown>>(..._parameters: unknown[]) => undefined as T | undefined,
      run: (..._parameters: unknown[]) => undefined
    })
  },
  ordinaryHandoffPauses: { delete: () => true },
  ordinaryHandoffPauseSnapshots: { delete: () => true },
  bind: value => ({ ...binding, ...value }),
  rebind: value => ({ ...binding, ...value }),
  getBinding: () => binding,
  isOrdinaryBindingRecord: () => true,
  isOrdinaryBinding: (_value: OrdinaryBindingRecord | null): boolean => true,
  transaction: operation => operation(),
  hasUnresolved: () => false,
  hasUnresolvedOrdinaryPost: () => false,
  bindingInput: value => value,
  assertLegacyMigrationSafe: () => undefined,
  receipt: () => undefined,
  findOrdinaryHandoff: () => null,
  hasUnboundReceipt: () => true,
  assertNativeOwnerFree: () => undefined,
  setIntakeCutoffInTransaction: () => undefined
};

const handlers = createOrdinaryBindingHandlers({
  BindingError: class extends Error {},
  StaleGenerationError: class extends Error {},
  UnresolvedWorkError: class extends Error {},
  MESSAGE_STATES: { DISPATCHING: 'dispatching', UNCERTAIN: 'uncertain', SUBMITTED: 'submitted' },
  PROVIDERS: { CODEX: 'codex' },
  READINESS: { PENDING: 'pending' },
  assertText: value => String(value),
  assertUuid: value => String(value),
  bindingMatchesExpected: () => true,
  now: () => '2026-09-13T00:00:00.000Z'
});

const identity = { sessionId: nativeId, threadId: nativeId };
const handoff: OrdinaryHandoffInput = {
  channelId: binding.channelId,
  provider: binding.provider,
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

const bound = handlers.bindOrdinary(state, { ...binding }, identity);
const rebound = handlers.rebindOrdinary(state, { ...binding }, identity);
const preflight = handlers.recordOrdinaryPreflight(state, binding, {
  file: '/tmp/session.jsonl', sessionId: nativeId, threadId: nativeId, workspace: binding.workspace
});
const transferred = handlers.handoffOrdinary(state, { ...handoff, nativeId: 'b8f0d4f6-b26a-4f96-8d37-6d7df4f1d4a0' });
const preflightViaHandler: boolean = handlers.hasOrdinaryPreflight(state, binding);
const bindingReceipt: boolean = hasOrdinaryBindingReceipt(state, binding);
const preflightReceipt: boolean = hasOrdinaryPreflightReceipt(state, binding);

const detachedPreflight = handlers.hasOrdinaryPreflight;
// @ts-expect-error hasOrdinaryPreflight requires its owning handler receiver
detachedPreflight(state, binding);

bound.generation satisfies number;
rebound.provider satisfies string;
preflight?.active satisfies boolean | undefined;
transferred.workspace satisfies string;
void bindingReceipt;
void preflightReceipt;
void preflightViaHandler;
