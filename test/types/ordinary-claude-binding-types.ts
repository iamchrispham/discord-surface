import {
  createOrdinaryClaudeBindingHandlers,
  type ClaudeOrdinaryBindingDependencies,
  type ClaudeOrdinaryBindingState,
  type ClaudeOrdinaryBindingIdentity,
  type ClaudeOrdinaryBindingInput,
  type ClaudeOrdinaryBindingRecord,
  type ClaudeOrdinaryPreflightDetail
} from '../../src/state/ordinary-binding-claude';
import type { AgentProvider } from '../../src/agent-message';

const nativeId = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const providers = { CLAUDE: 'claude' } satisfies ClaudeOrdinaryBindingDependencies['PROVIDERS'];
const readinessValues = { PENDING: 'pending' } satisfies ClaudeOrdinaryBindingDependencies['READINESS'];
const validProvider: ClaudeOrdinaryBindingInput['provider'] = providers.CLAUDE;

const binding: ClaudeOrdinaryBindingRecord = {
  active: true,
  channelId: 'channel',
  guildId: 'guild',
  provider: 'claude',
  nativeId,
  workspace: '/tmp/workspace',
  endpoint: '/tmp/claude.sock',
  generation: 1,
  sessionRoot: null,
  conductorId: null,
  repoKey: null
};

const identity: ClaudeOrdinaryBindingIdentity = { sessionId: nativeId, threadId: nativeId, harness: 'claude-code' };

const state: ClaudeOrdinaryBindingState = {
  db: {
    prepare: () => ({
      all: <T extends Record<string, unknown> = Record<string, unknown>>(..._parameters: unknown[]) => [] as T[],
      get: <T extends Record<string, unknown> = Record<string, unknown>>(..._parameters: unknown[]) => undefined as T | undefined,
      run: (..._parameters: unknown[]) => undefined
    })
  },
  bind: value => ({ ...binding, ...value }),
  rebind: value => ({ ...binding, ...value }),
  getBinding: () => binding,
  transaction: operation => operation(),
  receipt: () => undefined,
  _isOrdinaryBindingRecord: (value): value is typeof binding => value !== null,
  _isOrdinaryBinding: (value): value is typeof binding => value !== null && Boolean(value.active)
};

const handlers = createOrdinaryClaudeBindingHandlers({
  BindingError: class extends Error {},
  PROVIDERS: providers,
  READINESS: readinessValues,
  assertOrdinaryIdentity: (_provider, value) => value,
  assertOrdinaryNativeIdentity: () => undefined,
  bindingMatchesExpected: () => true
});

const detail: ClaudeOrdinaryPreflightDetail = {
  file: '/tmp/session.jsonl',
  sessionId: nativeId,
  threadId: nativeId,
  workspace: '/tmp/workspace',
  endpoint: '/tmp/claude.sock',
  harness: 'claude-code'
};

const bound = handlers.bindOrdinaryClaude(state, { ...binding, provider: 'claude' }, identity);
const rebound = handlers.rebindOrdinaryClaude(state, { ...binding, provider: 'claude' }, identity);
const classifiedRecord = handlers.isOrdinaryBindingRecord(state, binding);
const classified = handlers.isOrdinaryBinding(state, binding);
const preflight = handlers.hasOrdinaryPreflight(state, binding);
const recorded = handlers.recordOrdinaryPreflight(state, binding, detail);

// @ts-expect-error the Claude handle rejects a Codex provider binding
const invalidProviderBinding: ClaudeOrdinaryBindingInput = { ...binding, provider: 'codex' };
// @ts-expect-error the Claude handler rejects a Codex identity harness
const invalidIdentityHarness: ClaudeOrdinaryBindingIdentity = { sessionId: nativeId, threadId: nativeId, harness: 'codex' };
// @ts-expect-error the Claude preflight rejects a Codex proof harness
const invalidProofHarness: ClaudeOrdinaryPreflightDetail = { ...detail, harness: 'codex' };
// @ts-expect-error the Claude handle requires the claude-code harness
handlers.bindOrdinaryClaude(state, { ...binding, provider: 'claude' }, { sessionId: nativeId, threadId: nativeId, harness: 'codex' });
// @ts-expect-error the Claude preflight detail is required
handlers.recordOrdinaryPreflight(state, binding, {});

bound?.generation satisfies number | undefined;
rebound?.provider satisfies AgentProvider | undefined;
classifiedRecord satisfies boolean;
classified satisfies boolean;
preflight satisfies boolean;
recorded?.channelId satisfies string | undefined;
validProvider satisfies 'claude';
void invalidProviderBinding;
void invalidIdentityHarness;
void invalidProofHarness;
