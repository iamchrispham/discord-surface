import * as path from 'node:path';
import { ORDINARY_RECEIPT_KINDS } from '../ordinary/constants';
import { hasOrdinaryBindingReceipt, hasOrdinaryPreflightReceipt } from './ordinary-binding';
import type {
  OrdinaryBindingDependencies,
  OrdinaryBindingIdentity,
  OrdinaryBindingInput,
  OrdinaryBindingRecord,
  OrdinaryBindingState,
  OrdinaryBindOptions,
  OrdinaryNativeProof,
  OrdinaryRebindHandlerOptions
} from './ordinary-binding/contracts';

export type ClaudeOrdinaryBindingIdentity = OrdinaryBindingIdentity & { harness: 'claude-code' };

// OrdinaryBindingInput declares a string index signature, so Omit<..., 'provider'>
// collapses its named keys to unknown; intersect the narrowed provider instead.
export type ClaudeOrdinaryBindingInput = OrdinaryBindingInput & {
  provider: 'claude';
  endpoint?: string | null;
};

export type ClaudeOrdinaryBindingRecord = OrdinaryBindingRecord & {
  provider: 'claude';
  endpoint?: string | null;
};

export type ClaudeOrdinaryPreflightDetail = OrdinaryNativeProof & {
  harness: 'claude-code';
  endpoint?: string | null;
};

export type ClaudeOrdinaryBindingState = Pick<
  OrdinaryBindingState,
  'db' | 'bind' | 'rebind' | 'getBinding' | 'transaction' | 'receipt'
>;

export interface ClaudeOrdinaryBindingDependencies {
  BindingError: OrdinaryBindingDependencies['BindingError'];
  PROVIDERS: { CLAUDE: 'claude' };
  READINESS: { PENDING: 'pending' };
  assertOrdinaryIdentity(provider: string, identity: ClaudeOrdinaryBindingIdentity): ClaudeOrdinaryBindingIdentity;
  assertOrdinaryNativeIdentity(provider: string, nativeId: string, identity: ClaudeOrdinaryBindingIdentity): void;
  bindingMatchesExpected(
    binding: OrdinaryBindingRecord | null,
    expectedBinding: OrdinaryBindingRecord | null
  ): boolean;
}

export interface ClaudeOrdinaryBindingHandlers {
  bindOrdinaryClaude(
    state: ClaudeOrdinaryBindingState,
    binding: ClaudeOrdinaryBindingInput,
    identity: ClaudeOrdinaryBindingIdentity,
    adoptionCutoff?: string | null,
    options?: OrdinaryBindOptions
  ): OrdinaryBindingRecord | null;
  rebindOrdinaryClaude(
    state: ClaudeOrdinaryBindingState,
    binding: ClaudeOrdinaryBindingInput,
    identity: ClaudeOrdinaryBindingIdentity,
    intakeCutoff?: string | null,
    options?: OrdinaryRebindHandlerOptions
  ): OrdinaryBindingRecord | null;
  isOrdinaryBindingRecord(
    state: ClaudeOrdinaryBindingState,
    binding: OrdinaryBindingRecord | null
  ): binding is ClaudeOrdinaryBindingRecord;
  isOrdinaryBinding(
    state: ClaudeOrdinaryBindingState,
    binding: OrdinaryBindingRecord | null
  ): binding is ClaudeOrdinaryBindingRecord;
  hasOrdinaryPreflight(state: ClaudeOrdinaryBindingState, binding: OrdinaryBindingRecord | null): boolean;
  recordOrdinaryPreflight(
    state: ClaudeOrdinaryBindingState,
    binding: OrdinaryBindingRecord | null,
    detail: ClaudeOrdinaryPreflightDetail
  ): OrdinaryBindingRecord | null;
}

export function createOrdinaryClaudeBindingHandlers(
  {
    BindingError,
    PROVIDERS,
    READINESS,
    assertOrdinaryIdentity,
    assertOrdinaryNativeIdentity,
    bindingMatchesExpected
  }: ClaudeOrdinaryBindingDependencies
): ClaudeOrdinaryBindingHandlers {
  const handlers: ClaudeOrdinaryBindingHandlers = {
    bindOrdinaryClaude(state, binding, identity, adoptionCutoff = null, options = {}) {
      if (binding.conductorId != null || binding.repoKey != null) throw new BindingError('ordinary bindings cannot carry conductor identity');
      assertOrdinaryIdentity(PROVIDERS.CLAUDE, identity);
      assertOrdinaryNativeIdentity(PROVIDERS.CLAUDE, binding.nativeId, identity);
      return state.bind({ ...binding, provider: PROVIDERS.CLAUDE, conductorId: null, repoKey: null, readiness: READINESS.PENDING, ordinaryIdentity: identity }, {
        intakeCutoff: adoptionCutoff,
        intakeCutoffDetail: 'ordinary binding adoption cutoff',
        beforeMutation: options.beforeMutation
      });
    },

    rebindOrdinaryClaude(state, binding, identity, intakeCutoff = null, options = {}) {
      if (binding.conductorId != null || binding.repoKey != null) throw new BindingError('ordinary bindings cannot carry conductor identity');
      assertOrdinaryIdentity(PROVIDERS.CLAUDE, identity);
      const existing = state.getBinding(binding.channelId);
      if (!existing || existing.active || !handlers.isOrdinaryBindingRecord(state, existing)) {
        throw new BindingError('ordinary binding tombstone is unavailable for reuse');
      }
      if (existing.guildId !== binding.guildId || existing.provider !== PROVIDERS.CLAUDE ||
        existing.nativeId !== binding.nativeId || existing.workspace !== binding.workspace || existing.endpoint !== binding.endpoint ||
        identity.sessionId !== existing.nativeId || identity.threadId !== existing.nativeId) {
        throw new BindingError('ordinary binding owner changed; use explicit handoff');
      }
      return state.rebind({ ...binding, provider: PROVIDERS.CLAUDE, conductorId: null, repoKey: null, readiness: READINESS.PENDING, ordinaryIdentity: identity }, {
        intakeCutoff,
        beforeMutation: options.beforeMutation
      });
    },

    isOrdinaryBindingRecord(state, binding): binding is ClaudeOrdinaryBindingRecord {
      if (!binding || binding.provider !== PROVIDERS.CLAUDE || binding.conductorId || binding.repoKey) return false;
      return hasOrdinaryBindingReceipt(state, binding);
    },

    isOrdinaryBinding(state, binding): binding is ClaudeOrdinaryBindingRecord {
      if (!binding?.active) return false;
      return handlers.isOrdinaryBindingRecord(state, binding);
    },

    hasOrdinaryPreflight(state, binding) {
      if (!handlers.isOrdinaryBinding(state, binding)) return false;
      return hasOrdinaryPreflightReceipt(state, binding);
    },

    recordOrdinaryPreflight(state, binding, detail) {
      return state.transaction(() => {
        const current = state.getBinding(binding?.channelId);
        if (!bindingMatchesExpected(current, binding)) return null;
        if (!handlers.isOrdinaryBinding(state, current)) throw new BindingError(`binding is not an ordinary ${current?.provider || 'native'} binding`);
        if (!detail || typeof detail !== 'object' || typeof detail.file !== 'string' || !path.isAbsolute(detail.file) ||
          detail.sessionId !== current.nativeId ||
          detail.threadId !== current.nativeId ||
          detail.workspace !== current.workspace) {
          throw new BindingError(`ordinary ${current.provider} native preflight proof does not match the binding`);
        }
        if (detail.harness !== 'claude-code' || detail.endpoint !== current.endpoint) {
          throw new BindingError('ordinary Claude native preflight proof does not match the binding');
        }
        state.receipt(null, ORDINARY_RECEIPT_KINDS.NATIVE_PREFLIGHT, {
          ...detail,
          channelId: current.channelId, guildId: current.guildId,
          provider: current.provider,
          nativeId: current.nativeId, workspace: current.workspace,
          generation: current.generation,
          sessionRoot: current.sessionRoot || null,
          outcome: 'verified'
        });
        return current;
      });
    }
  };
  return handlers;
}
