import { observeCodexReply, readInitialCursor } from './native/observation';
export { observeCodexReply, readInitialCursor, waitForReply } from './native/observation';
import { asNativeError, errorCode } from './native/errors';
export { readClaudeSessionIdentity, validateClaudeSessionIdentity, probeUnixSocket, probeClaudeChannel } from './native/claude-identity';
import { DISPATCH_STATUSES } from './native/contracts';
import type {
  NativeStateExports,
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
import * as http from 'node:http';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import {
  CODEX_VALIDATION_KINDS,
  codexHomeForSessionRoot,
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
  messageRequest,
  watcherNoticeCompletionCommand
};

const { MESSAGE_STATES, PROVIDERS, validateNativeId } = require('../src/state') as NativeStateExports;

export function runCodex(command: string, args: readonly string[], options: CodexRunOptions = {}): Promise<CodexRunResult> {
  return new Promise<CodexRunResult>(resolve => {
    let spawned = false;
    const child = execFile(command, args, { cwd: options.cwd, env: options.env || process.env, signal: options.signal, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ status: DISPATCH_STATUSES.SUBMITTED, stdout, stderr });
      const text = `${error.message} ${stderr || ''}`;
      if (!spawned || errorCode(error) === 'ENOENT') return resolve({ status: DISPATCH_STATUSES.NOT_SUBMITTED, error: new Error(text) });
      if (/not found|does not exist|unknown thread|no such thread|missing thread|no rollout found for thread id/i.test(text)) {
        return resolve({ status: DISPATCH_STATUSES.NOT_SUBMITTED, error: new Error(text) });
      }
      resolve({ status: DISPATCH_STATUSES.UNCERTAIN, error: new Error(text) });
    });
    spawned = true;
    child.once('error', error => {
      const code = errorCode(error);
      const typed = asNativeError(error);
      if (code === 'ENOENT') resolve({ status: DISPATCH_STATUSES.NOT_SUBMITTED, error: typed });
      else resolve({ status: DISPATCH_STATUSES.UNCERTAIN, error: typed });
    });
  });
}

export class CodexProvider implements NativeProvider {
  private readonly command: string;
  private readonly root: string;
  private readonly run: (command: string, args: readonly string[], options?: CodexRunOptions) => Promise<CodexRunResult>;
  private readonly acknowledgmentFor: ((message: NativeMessage) => readonly string[] | null | undefined) | null;
  private readonly completionFor: ((message: NativeMessage) => readonly string[] | null | undefined) | null;

  constructor({
    command = 'codex',
    root = sessionRoot(),
    run = runCodex,
    acknowledgmentFor = null,
    completionFor = null
  }: {
    command?: string;
    root?: string;
    run?: (command: string, args: readonly string[], options?: CodexRunOptions) => Promise<CodexRunResult>;
    acknowledgmentFor?: ((message: NativeMessage) => readonly string[] | null | undefined) | null;
    completionFor?: ((message: NativeMessage) => readonly string[] | null | undefined) | null;
  } = {}) {
    this.command = command;
    this.root = root;
    this.run = run;
    this.acknowledgmentFor = acknowledgmentFor;
    this.completionFor = completionFor;
  }

  async dispatch(message: NativeMessage, { onCursor }: DispatchOptions = {}): Promise<DispatchOutcome> {
    try { validateNativeId(message.nativeId); } catch (error) {
      return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: asNativeError(error) };
    }
    const root = message.sessionRoot || this.root;
    let codexHome;
    try { codexHome = codexHomeForSessionRoot(root); } catch (error) {
      return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: asNativeError(error) };
    }
    const cursor = readInitialCursor(message.nativeId, root);
    onCursor?.(cursor);
    const args = ['queue', '--thread', message.nativeId, '--message', codexPrompt(message,
      this.acknowledgmentFor?.(message), this.completionFor?.(message)), '--cd', message.workspace];
    const result = await this.run(this.command, args, {
      cwd: message.workspace,
      env: { ...process.env, CODEX_HOME: codexHome }
    });
    return { ...result, cursor };
  }

  async dispatchCourier(envelope: CourierDispatchEnvelope, { signal }: CourierDispatchOptions = {}): Promise<DispatchOutcome> {
    if (signal?.aborted) return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: new Error('courier dispatch stopped before queue submission') };
    if (envelope?.courier?.provider !== 'codex') {
      return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: new Error('courier dispatch requires a Codex courier identity') };
    }
    try { validateNativeId(envelope.courier.nativeId); } catch (error) {
      return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: asNativeError(error) };
    }
    if (typeof envelope.courier.workspace !== 'string' || !path.isAbsolute(envelope.courier.workspace)) {
      return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: new Error('courier workspace must be absolute') };
    }
    let forwardingPrompt;
    try { forwardingPrompt = courierForwardingPrompt(envelope); } catch (error) {
      return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: asNativeError(error) };
    }
    const root = envelope.courier.sessionRoot || this.root;
    let codexHome;
    try { codexHome = codexHomeForSessionRoot(root); } catch (error) {
      return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: asNativeError(error) };
    }
    const args = ['queue', '--thread', envelope.courier.nativeId, '--message', forwardingPrompt, '--cd', envelope.courier.workspace];
    const result = await this.run(this.command, args, {
      cwd: envelope.courier.workspace,
      env: { ...process.env, CODEX_HOME: codexHome },
      signal
    });
    return result;
  }

  observe(message: NativeMessage, outcome: ObserveOutcome, options: ObserveCodexOptions = {}): Promise<CodexObservation> {
    return observeCodexReply(message.nativeId, outcome.cursor || message.observerCursor, {
      ...options,
      marker: `[[discord-surface:${message.id}]]`,
      root: message.sessionRoot || this.root,
      resolveRoot: typeof options.resolveRoot === 'function' ? () => (options.resolveRoot as () => string | null | undefined)() || this.root : undefined
    });
  }
}

export function postUnixJson(socketPath: string, body: unknown, { timeoutMs = 10000 }: { timeoutMs?: number } = {}): Promise<UnixJsonResponse> {
  return new Promise<UnixJsonResponse>((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(body));
    let wrote = false;
    const request = http.request({ agent: false, socketPath, path: '/event', method: 'POST', timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': encoded.length } }, response => {
      let output = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { output += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body: output, wrote }));
    });
    request.on('timeout', () => request.destroy(new Error('native channel request timed out')));
    request.on('error', error => {
      const typed = asNativeError(error);
      typed.wrote = wrote;
      reject(typed);
    });
    request.write(encoded, () => { wrote = true; });
    request.end();
  });
}

export class ClaudeProvider implements NativeProvider {
  private readonly post: (socketPath: string, body: unknown) => Promise<UnixJsonResponse>;
  private readonly waitForReply?: (messageId: string, options?: WaitForReplyOptions) => Promise<WaitForReplyResult> | WaitForReplyResult | null;
  private readonly completionFor: ((message: NativeMessage) => readonly string[] | null | undefined) | null;

  constructor({
    post = postUnixJson,
    waitForReply,
    completionFor = null
  }: {
    post?: (socketPath: string, body: unknown) => Promise<UnixJsonResponse>;
    waitForReply?: (messageId: string, options?: WaitForReplyOptions) => Promise<WaitForReplyResult> | WaitForReplyResult | null;
    completionFor?: ((message: NativeMessage) => readonly string[] | null | undefined) | null;
  } = {}) {
    this.post = post;
    this.waitForReply = waitForReply;
    this.completionFor = completionFor;
  }

  async dispatch(message: NativeMessage): Promise<DispatchOutcome> {
    try { validateNativeId(message.nativeId); } catch (error) {
      return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: asNativeError(error) };
    }
    if (!message.endpoint) return { status: DISPATCH_STATUSES.NOT_SUBMITTED, endpointUnavailable: true, error: new Error('Claude binding has no native channel endpoint') };
    try {
      const result = await this.post(message.endpoint, claudeEvent(message, this.completionFor?.(message)));
      if (result.statusCode === 202) return { status: DISPATCH_STATUSES.SUBMITTED };
      if (result.statusCode !== undefined && result.statusCode >= 400 && result.statusCode < 500) return { status: DISPATCH_STATUSES.NOT_SUBMITTED, error: new Error(`Claude channel rejected event: ${result.statusCode}`) };
      return { status: DISPATCH_STATUSES.UNCERTAIN, error: new Error(`Claude channel returned ${result.statusCode}`) };
    } catch (error) {
      const typed = asNativeError(error);
      return { status: typed.wrote ? DISPATCH_STATUSES.UNCERTAIN : DISPATCH_STATUSES.NOT_SUBMITTED, endpointUnavailable: !typed.wrote, error: typed };
    }
  }

  observe(_message: NativeMessage, _outcome: ObserveOutcome, options?: ObserveCodexOptions): Promise<WaitForReplyResult> | WaitForReplyResult | null {
    if (!this.waitForReply) return null;
    return this.waitForReply(_message.id, options);
  }
}

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
    outcome = options.dispatch
      ? await options.dispatch(dispatchMessage, provider, dispatchOptions)
      : await provider.dispatch(dispatchMessage, dispatchOptions);
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
