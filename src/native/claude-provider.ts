import * as http from 'node:http';
import { asNativeError } from './errors';
import { claudeEvent } from './prompts';
import { DISPATCH_STATUSES } from './contracts';
import type {
  DispatchOutcome,
  NativeMessage,
  NativeProvider,
  UnixJsonResponse,
  WaitForReplyOptions,
  WaitForReplyResult,
  ObserveOutcome,
  ObserveCodexOptions,
  NativeStateExports
} from './contracts';

const { validateNativeId } = require('../../src/state') as NativeStateExports;

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
