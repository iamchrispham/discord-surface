export { observeCodexReply, readInitialCursor, waitForReply } from './native/observation';
export { readClaudeSessionIdentity, validateClaudeSessionIdentity, probeUnixSocket, probeClaudeChannel } from './native/claude-identity';
import { DISPATCH_STATUSES } from './native/contracts';
import type {
  NativeStateExports,
  NativeProviderName,
  ObserverCursor,
  NativeMessage,
  DispatchClaim,
  NativeReplyInput,
  NativeState,
  DispatchOutcome,
  DispatchOptions,
  ObserveCodexOptions,
  ObserveOutcome,
  ProviderObservation,
  NativeProvider,
  DispatchReport
} from './native/contracts';
export { DISPATCH_STATUSES } from './native/contracts';
export type {
  NativeProviderName,
  MessageState,
  PersistedObserverCursor,
  ObserverCursor,
  NativeMessage,
  NativeBinding,
  CurrentBinding,
  DispatchClaim,
  NativeReplyInput,
  NativeState,
  NativeReplyReceipt,
  DispatchStatus,
  DispatchOutcome,
  DispatchOptions,
  CourierDispatchEnvelope,
  CourierDispatchOptions,
  CodexRunOptions,
  CodexRunResult,
  ObserveCodexOptions,
  CodexObservation,
  WaitForReplyOptions,
  WaitForReplyResult,
  ObserveOutcome,
  ProviderObservation,
  NativeProvider,
  ClaudeSessionIdentity,
  ClaudeBindingExpectation,
  ClaudeChannelIdentity,
  UnixJsonResponse,
  DispatchReport
} from './native/contracts';
export { finalText } from './native/final-answer';
export type { TranscriptPart, TranscriptItem, TranscriptPayload, TranscriptRow } from './native/final-answer';
import {
  CODEX_VALIDATION_KINDS,
  findCodexSessionFile,
  readCodexSessionIdentity,
  readCodexSessionIdentityAsync,
  sessionRoot,
  validateCodexSessionIdentity,
  validateCodexSessionIdentityAsync,
  walk,
  walkAsync
} from './native-transcript';
import {
  agentCompletionCommand,
  attachmentPrompt,
  claudeEvent,
  codexPrompt,
  courierForwardingPrompt,
  isCodexWatcherNotice,
  messageRequest,
  watcherNoticeCompletionCommand
} from './native/prompts';

export {
  CODEX_VALIDATION_KINDS,
  findCodexSessionFile,
  readCodexSessionIdentity,
  readCodexSessionIdentityAsync,
  sessionRoot,
  validateCodexSessionIdentity,
  validateCodexSessionIdentityAsync,
  walk,
  walkAsync
};

export {
  agentCompletionCommand,
  attachmentPrompt,
  claudeEvent,
  codexPrompt,
  courierForwardingPrompt,
  isCodexWatcherNotice,
  messageRequest,
  watcherNoticeCompletionCommand
};

const { MESSAGE_STATES, PROVIDERS } = require('../src/state') as NativeStateExports;

export { runCodex, CodexProvider } from './native/codex-provider';
export { postUnixJson, ClaudeProvider } from './native/claude-provider';

export async function observeSubmitted(
  state: NativeState,
  message: NativeMessage,
  provider: NativeProvider,
  options: ObserveCodexOptions = {}
): Promise<DispatchReport> {
  if (message.state === MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST) {
    return { status: message.state, message: state.getMessage(message.id) };
  }
  if (!provider?.observe) {
    const unavailable = state.markObservationUnavailable(message.id, 'native observer is unavailable');
    return { status: unavailable?.state || message.state, message: unavailable || state.getMessage(message.id) };
  }
  const marker = `[[discord-surface:${message.id}]]`;
  const outcome: ObserveOutcome = { cursor: message.observerCursor };
  let observedCursor: ObserverCursor | null = null;
  let reply: ProviderObservation | null = null;
  const isCurrent = () => {
    try {
      const currentMessage = state.getMessage(message.id);
      if (!currentMessage || currentMessage.state !== MESSAGE_STATES.SUBMITTED) return false;
      const check = state.currentMessageBinding?.(currentMessage);
      if (!check) return false;
      return check.current && currentMessage.provider === message.provider && currentMessage.nativeId === message.nativeId && currentMessage.generation === message.generation;
    } catch {
      return false;
    }
  };
  try {
    reply = await provider.observe(providerMessageForBinding(state, message), outcome, {
      ...options,
      isCurrent,
      resolveRoot: () => {
        const currentMessage = state.getMessage(message.id);
        if (!currentMessage) return undefined;
        return state.currentMessageBinding?.(currentMessage)?.binding?.sessionRoot || undefined;
      },
      onCursor: cursor => { observedCursor = cursor; }
    });
  } catch (error) {
    state.markObservationUnavailable(message.id, error);
    return { status: state.getMessage(message.id)?.state || message.state, message: state.getMessage(message.id), error };
  }
  if (reply && typeof reply.text === 'string') {
    try {
      const nativeReply: NativeReplyInput = { provider: message.provider, messageId: message.id, nativeId: message.nativeId, generation: message.generation, text: reply.text };
      if (reply.parts) nativeReply.parts = reply.parts;
      state.recordNativeReply(nativeReply);
      const cursor = reply.cursor || observedCursor;
      if (cursor) state.setObserverCursor(message.id, cursor, marker);
    } catch (error) {
      return { status: 'stale-reply', message: state.getMessage(message.id), error };
    }
  } else if (reply?.cursor || observedCursor) {
    const cursor = reply?.cursor || observedCursor;
    if (cursor) state.setObserverCursor(message.id, cursor, marker);
  } else if (!reply?.stopped) {
    state.markObservationUnavailable(message.id, 'native reply was not observed before the bounded window');
  }
  return { status: state.getMessage(message.id)?.state || message.state, message: state.getMessage(message.id) };
}

function providerMessageForBinding(state: NativeState, message: NativeMessage): NativeMessage {
  if (typeof state?.currentMessageBinding !== 'function') return message;
  try {
    const binding = state.currentMessageBinding(message)?.binding;
    if (!binding || binding.sessionRoot == null) return message;
    return { ...message, sessionRoot: binding.sessionRoot };
  } catch {
    return message;
  }
}

function isDispatchOutcome(value: unknown): value is DispatchOutcome {
  const status = value && typeof value === 'object' ? (value as { status?: unknown }).status : undefined;
  return typeof status === 'string' && (Object.values(DISPATCH_STATUSES) as readonly string[]).includes(status);
}

export async function dispatchAndObserve(
  state: NativeState,
  messageId: string,
  providers: Partial<Record<NativeProviderName, NativeProvider>>,
  options: ObserveCodexOptions & {
    dispatch?: (message: NativeMessage, provider: NativeProvider, options: DispatchOptions) => Promise<DispatchOutcome>;
    onDispatchOutcome?: (outcome: unknown) => void;
    onNativeUnavailable?: (message: NativeMessage, error: unknown, outcome: DispatchOutcome) => void;
    onSubmitted?: (message: NativeMessage | null | undefined) => void;
  } = {}
): Promise<DispatchReport> {
  const reportOutcome = (outcome: DispatchReport): DispatchReport => {
    try { options.onDispatchOutcome?.(outcome); } catch {}
    return outcome;
  };
  let claimed: DispatchClaim;
  try {
    claimed = state.claimDispatch(messageId);
  } catch (error) {
    return reportOutcome({ status: 'rejected', message: state.getMessage(messageId), error });
  }
  if (!claimed.claimed) return reportOutcome({ status: claimed.reason || claimed.message?.state || 'ignored', message: claimed.message });
  const message = claimed.message as NativeMessage;
  const provider = providers[message.provider];
  if (!provider) {
    const error = new Error(`provider is not configured: ${message.provider}`);
    state.markUncertain(message.id, error);
    return reportOutcome({ status: DISPATCH_STATUSES.UNCERTAIN, message: state.getMessage(message.id), error });
  }
  const marker = `[[discord-surface:${message.id}]]`;
  let outcome: unknown;
  try {
    const dispatchMessage = providerMessageForBinding(state, message);
    const dispatchOptions = {
      signal: options.signal,
      onCursor: (cursor: ObserverCursor) => state.setObserverCursor(message.id, cursor, marker)
    };
    if (options.dispatch) {
      outcome = await options.dispatch(dispatchMessage, provider, dispatchOptions);
    } else if (isCodexWatcherNotice(dispatchMessage)) {
      outcome = {
        status: DISPATCH_STATUSES.NOT_SUBMITTED,
        error: new Error('Codex watcher notice requires a matching courier route')
      };
    } else {
      outcome = await provider.dispatch(dispatchMessage, dispatchOptions);
    }
  } catch (error) {
    state.markUncertain(message.id, error);
    return reportOutcome({ status: DISPATCH_STATUSES.UNCERTAIN, message: state.getMessage(message.id), error });
  }
  if (!isDispatchOutcome(outcome)) {
    const error = new Error('native dispatcher returned an invalid outcome');
    state.markUncertain(message.id, error);
    return reportOutcome({ status: DISPATCH_STATUSES.UNCERTAIN, message: state.getMessage(message.id), error });
  }
  if (outcome.status === DISPATCH_STATUSES.NOT_SUBMITTED) {
    try { options.onNativeUnavailable?.(message, outcome.error, outcome); } catch {}
    state.markNotSubmitted(message.id, outcome.error);
    return reportOutcome({ status: DISPATCH_STATUSES.NOT_SUBMITTED, message: state.getMessage(message.id), error: outcome.error });
  }
  if (outcome.status === DISPATCH_STATUSES.UNCERTAIN) {
    state.markUncertain(message.id, outcome.error);
    return reportOutcome({ status: DISPATCH_STATUSES.UNCERTAIN, message: state.getMessage(message.id), error: outcome.error });
  }
  state.markSubmitted(message.id, outcome.cursor || null, marker);
  reportOutcome({ status: DISPATCH_STATUSES.SUBMITTED, message: state.getMessage(message.id) });
  try { options.onSubmitted?.(state.getMessage(message.id)); } catch {}
  const observation = await observeSubmitted(state, state.getMessage(message.id) as NativeMessage, provider, options);
  return observation;
}
