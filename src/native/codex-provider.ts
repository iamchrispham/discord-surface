import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { observeCodexReply, readInitialCursor } from './observation';
import { asNativeError, errorCode } from './errors';
import { DISPATCH_STATUSES } from './contracts';
import type {
  CodexRunOptions,
  CodexRunResult,
  NativeProvider,
  NativeMessage,
  DispatchOptions,
  DispatchOutcome,
  CourierDispatchEnvelope,
  CourierDispatchOptions,
  ObserveOutcome,
  ObserveCodexOptions,
  CodexObservation,
  NativeStateExports
} from './contracts';
import { codexHomeForSessionRoot, sessionRoot } from '../native-transcript';
import { codexPrompt, courierForwardingPrompt } from './prompts';

const { validateNativeId } = require('../../src/state') as NativeStateExports;

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
  private readonly courierInputFor: ((envelope: CourierDispatchEnvelope) => readonly string[] | null | undefined) | null;

  constructor({
    command = 'codex',
    root = sessionRoot(),
    run = runCodex,
    acknowledgmentFor = null,
    completionFor = null,
    courierInputFor = null
  }: {
    command?: string;
    root?: string;
    run?: (command: string, args: readonly string[], options?: CodexRunOptions) => Promise<CodexRunResult>;
    acknowledgmentFor?: ((message: NativeMessage) => readonly string[] | null | undefined) | null;
    completionFor?: ((message: NativeMessage) => readonly string[] | null | undefined) | null;
    courierInputFor?: ((envelope: CourierDispatchEnvelope) => readonly string[] | null | undefined) | null;
  } = {}) {
    this.command = command;
    this.root = root;
    this.run = run;
    this.acknowledgmentFor = acknowledgmentFor;
    this.completionFor = completionFor;
    this.courierInputFor = courierInputFor;
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
    try {
      const courierInput = this.courierInputFor ? this.courierInputFor(envelope) : null;
      forwardingPrompt = courierInput ? courierForwardingPrompt(envelope, courierInput) : courierForwardingPrompt(envelope);
    } catch (error) {
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
