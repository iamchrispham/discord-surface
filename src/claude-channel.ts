import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type {
  AcknowledgmentState,
  MessageState,
  NativeAcknowledgmentInput
} from './acknowledgment';
import type { Attachment } from './attachments';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const { recordNativeAcknowledgment } = require('./acknowledgment') as typeof import('./acknowledgment');

const { MESSAGE_STATES, normalizeAttachments, validateNativeId } = require('../src/state') as {
  MESSAGE_STATES: {
    DISPATCHING: MessageState;
    SUBMITTED: MessageState;
  };
  normalizeAttachments: (value: unknown) => Attachment[];
  validateNativeId: (value: unknown) => unknown;
};

const requireInstalled = require;

export interface ClaudeBinding {
  channelId: string;
  guildId: string;
  provider: NativeAcknowledgmentInput['provider'];
  nativeId: string;
  workspace: string;
  endpoint: string | null;
  generation: number;
  active: boolean;
}

export interface ClaudeMessage {
  id: string;
  channelId: string;
  guildId: string;
  provider: NativeAcknowledgmentInput['provider'];
  nativeId: string;
  generation: number;
  state: MessageState;
  channel?: unknown;
}

export type ClaudeChannelReadMessage = Pick<ClaudeMessage, 'provider' | 'nativeId' | 'generation' | 'state'>;

export interface ClaudeChannelReadState {
  findNativeBinding(nativeId: string, provider: NativeAcknowledgmentInput['provider']): ClaudeBinding | null | undefined;
  getBinding(channelId: string): ClaudeBinding | null | undefined;
  getMessage(messageId: string): ClaudeChannelReadMessage | null | undefined;
  assertMessageCurrent: (messageId: string, phase: 'native-dispatch') => ClaudeChannelReadMessage | void;
}

export interface ClaudeChannelState extends ClaudeChannelReadState {
  getMessage(messageId: string): ClaudeMessage | null | undefined;
  assertMessageCurrent: (messageId: string, phase: 'native-dispatch') => ClaudeMessage;
}

export type ClaudeAcknowledgmentState = ClaudeChannelState & AcknowledgmentState & {
  recordNativeReply(input: NativeAcknowledgmentInput & { text: string }): {
    duplicate: boolean;
    message: ClaudeMessage | null | undefined;
  };
};

type ClaudeDefaultMcpState = AcknowledgmentState & {
  recordNativeReply(input: NativeAcknowledgmentInput & { text: string }): {
    duplicate: boolean;
  };
};

export interface ClaudeChannelEvent {
  nativeId: string;
  messageId: string;
  generation: number;
  content: string;
  attachments?: unknown;
}

export interface ClaudeChannelNotification {
  method: 'notifications/claude/channel';
  params: {
    content: string;
    meta: {
      messageId: string;
      generation: string;
      nativeId: string;
    };
    attachments?: Attachment[];
  };
}

interface ClaudeChannelMcpBase {
  notification: (notification: ClaudeChannelNotification) => Promise<unknown> | unknown;
  close?: () => unknown;
  onclose?: (() => void) | null;
  onerror?: ((error: Error) => void) | null;
}

export interface ClaudeDefaultMcp<TTransport = unknown> extends Omit<ClaudeChannelMcpBase, 'close'> {
  close: Server['close'];
  setRequestHandler: Server['setRequestHandler'];
  connect: (transport: TTransport) => Promise<void>;
  transportFactory: () => TTransport;
}

export type ClaudeChannelMcp<TTransport = unknown> =
  | (ClaudeChannelMcpBase & {
      connect: (transport: TTransport) => unknown;
      transportFactory: () => TTransport;
    })
  | (ClaudeChannelMcpBase & {
      connect?: undefined;
      transportFactory?: () => TTransport;
    });

interface ClaudeChannelOptionsBase {
  nativeId: string;
  socketPath: string;
  onTransportClose?: (() => void) | null;
  logger?: (message: string) => void;
}

export type ClaudeChannelOptions<TTransport = unknown> =
  | (ClaudeChannelOptionsBase & {
      state: ClaudeChannelReadState & ClaudeDefaultMcpState;
      mcp?: ClaudeChannelMcp<TTransport>;
    })
  | (ClaudeChannelOptionsBase & {
      state: ClaudeChannelReadState;
      mcp: ClaudeChannelMcp<TTransport>;
    });

interface ClaudeBindingIdentity {
  channelId: string;
  guildId: string;
  provider: 'claude';
  nativeId: string;
  workspace: string;
  endpoint: string;
  generation: number;
}

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown }).message);
}

function markPotentiallyDelivered(error: unknown): void {
  const deliveryError = error as { potentiallyDelivered?: unknown };
  if (deliveryError.potentiallyDelivered === undefined) deliveryError.potentiallyDelivered = true;
}

function potentiallyDelivered(error: unknown): unknown {
  return (error as { potentiallyDelivered?: unknown }).potentiallyDelivered;
}

export function parseBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 20000) request.destroy(new Error('request too large'));
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid JSON')); }
    });
    request.on('error', reject);
  });
}

export function assertSocketPath(socketPath: string): void {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) throw new Error('Claude channel socket must be an absolute path');
  if (socketPath.length > 90) throw new Error('Claude channel socket path is too long for macOS');
}

export function prepareSocket(socketPath: string): void {
  assertSocketPath(socketPath);
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const mode = fs.statSync(path.dirname(socketPath)).mode & 0o777;
  if (mode & 0o077) throw new Error('Claude channel socket directory must be owner-only');
  if (fs.existsSync(socketPath)) {
    if (!fs.lstatSync(socketPath).isSocket()) throw new Error('Claude channel path exists and is not a socket');
    throw new Error('Claude channel socket already exists; stop its owner first');
  }
}

export function createDefaultMcp({ nativeId, state }: { nativeId: string; state: ClaudeDefaultMcpState }): ClaudeDefaultMcp<StdioServerTransport> {
  const { Server } = requireInstalled('@modelcontextprotocol/sdk/server/index.js') as {
    Server: new (...args: ConstructorParameters<typeof import('@modelcontextprotocol/sdk/server/index.js').Server>) => ClaudeDefaultMcp<StdioServerTransport>;
  };
  const { StdioServerTransport } = requireInstalled('@modelcontextprotocol/sdk/server/stdio.js') as {
    StdioServerTransport: new () => StdioServerTransport;
  };
  const { ListToolsRequestSchema, CallToolRequestSchema } = requireInstalled('@modelcontextprotocol/sdk/types.js') as {
    ListToolsRequestSchema: typeof import('@modelcontextprotocol/sdk/types.js').ListToolsRequestSchema;
    CallToolRequestSchema: typeof import('@modelcontextprotocol/sdk/types.js').CallToolRequestSchema;
  };
  const mcp = new Server(
    { name: 'discord-surface-claude-channel', version: '0.1.0' },
    {
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
      instructions: 'This channel is explicitly opted in by the native Claude session. For each event, call acknowledge at pickup, then answer the user and call reply with the exact messageId and generation from the event. Do not attach, resume, or start another session.'
    }
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'acknowledge',
      description: 'Record that this native owner received the exact Discord message, without claiming completion.',
      inputSchema: { type: 'object', properties: { messageId: { type: 'string' }, generation: { type: 'integer', minimum: 1 } },
        required: ['messageId', 'generation'], additionalProperties: false }
    }, {
      name: 'reply',
      description: 'Persist the final answer for the exact Discord message and ownership generation.',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string' },
          generation: { type: 'integer', minimum: 1 },
          text: { type: 'string', minLength: 1, maxLength: 10000 }
        },
        required: ['messageId', 'generation', 'text'],
        additionalProperties: false
      }
    }]
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const args = params.arguments || {};
    if (params.name === 'acknowledge') {
      const result = recordNativeAcknowledgment(state, {
        provider: 'claude',
        messageId: args.messageId as string,
        nativeId,
        generation: args.generation as number
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (params.name !== 'reply') throw new Error('unknown Claude channel tool');
    const result = state.recordNativeReply({
      provider: 'claude',
      messageId: args.messageId as string,
      nativeId,
      generation: args.generation as number,
      text: args.text as string
    });
    return { content: [{ type: 'text', text: result.duplicate ? 'Already recorded.' : 'Recorded.' }] };
  });
  mcp.transportFactory = () => new StdioServerTransport();
  return mcp;
}

export class ClaudeChannel<TTransport = unknown> {
  declare bindingIdentity: ClaudeBindingIdentity;
  declare state: ClaudeChannelReadState;
  declare nativeId: string;
  declare socketPath: string;
  declare mcp: ClaudeChannelMcp<TTransport>;
  declare server: http.Server | null;
  declare ownsSocket: boolean;
  declare started: boolean;
  declare stopping: boolean;
  declare stopPromise: Promise<void> | null;
  declare ready: boolean;
  declare transportClosed: boolean;
  declare onTransportClose: (() => void) | null;
  declare logger: (message: string) => void;

  constructor(options: ClaudeChannelOptions<TTransport>) {
    const { state, nativeId, socketPath, mcp, onTransportClose, logger = () => {} } = options || {} as ClaudeChannelOptions<TTransport>;
    if (!state) throw new TypeError('state is required');
    validateNativeId(nativeId);
    assertSocketPath(socketPath);
    const binding = state.findNativeBinding(nativeId, 'claude');
    if (!binding || !binding.active || binding.provider !== 'claude' || binding.endpoint !== socketPath) {
      throw new Error('Claude channel requires a pre-bound, opted-in native session');
    }
    this.bindingIdentity = {
      channelId: binding.channelId,
      guildId: binding.guildId,
      provider: 'claude',
      nativeId: binding.nativeId,
      workspace: binding.workspace,
      endpoint: socketPath,
      generation: binding.generation
    };
    this.state = state;
    this.nativeId = nativeId;
    this.socketPath = socketPath;
    this.mcp = mcp || createDefaultMcp({ nativeId, state: state as ClaudeDefaultMcpState }) as unknown as ClaudeChannelMcp<TTransport>;
    this.server = null;
    this.ownsSocket = false;
    this.started = false;
    this.stopping = false;
    this.stopPromise = null;
    this.ready = false;
    this.transportClosed = false;
    this.onTransportClose = typeof onTransportClose === 'function' ? onTransportClose : null;
    this.logger = logger;
    this.mcp.onclose = () => {
      this.transportClosed = true;
      if (this.started && !this.stopPromise) this.stop().catch(() => {}).finally(() => this.onTransportClose?.());
    };
    this.mcp.onerror = () => {
      this.transportClosed = true;
      if (this.started && !this.stopPromise) this.stop().catch(() => {}).finally(() => this.onTransportClose?.());
    };
  }

  async handleEvent(body: ClaudeChannelEvent): Promise<void> {
    if (!this.ready) throw new Error('native Claude channel is not ready');
    validateNativeId(body.nativeId);
    if (body.nativeId !== this.nativeId) throw new Error('native session mismatch');
    if (typeof body.messageId !== 'string' || !body.messageId || !Number.isInteger(body.generation) || body.generation < 1 || typeof body.content !== 'string') {
      throw new Error('invalid Claude channel event');
    }
    const binding = this.state.findNativeBinding(this.nativeId, 'claude');
    const message = this.state.getMessage(body.messageId);
    if (!binding || !binding.active || binding.endpoint !== this.socketPath) throw new Error('stale Claude channel binding');
    if (binding.generation !== body.generation) throw new Error('stale Claude channel generation');
    if (!message || message.provider !== 'claude' || message.nativeId !== body.nativeId || message.generation !== body.generation ||
      ![MESSAGE_STATES.DISPATCHING, MESSAGE_STATES.SUBMITTED].includes(message.state)) {
      throw new Error('Claude channel event has no accepted custody');
    }
    this.state.assertMessageCurrent(body.messageId, 'native-dispatch');
    const attachments = normalizeAttachments(body.attachments);
    try {
      const params: ClaudeChannelNotification['params'] = {
        content: body.content,
        meta: { messageId: body.messageId, generation: String(body.generation), nativeId: body.nativeId }
      };
      if (attachments.length) params.attachments = attachments;
      await this.mcp.notification({ method: 'notifications/claude/channel', params });
    } catch (error) {
      markPotentiallyDelivered(error);
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.stopPromise) await this.stopPromise;
    this.transportClosed = false;
    prepareSocket(this.socketPath);
    try {
      if (typeof this.mcp.connect === 'function') await this.mcp.connect(this.mcp.transportFactory!());
      this.server = http.createServer(async (request, response) => {
        if (request.method === 'GET' && request.url === '/identity') {
          let current: ClaudeBinding | null | undefined;
          try {
            current = this.state.getBinding(this.bindingIdentity.channelId);
          } catch (error) {
            this.logger(`Claude identity read failed: ${errorMessage(error)}`);
            response.writeHead(503, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ provider: 'claude', nativeId: this.nativeId, generation: this.bindingIdentity.generation, endpoint: this.socketPath, channelReady: false }));
            return;
          }
          const currentIdentity = current && current.active && current.channelId === this.bindingIdentity.channelId &&
            current.guildId === this.bindingIdentity.guildId && current.provider === this.bindingIdentity.provider &&
            current.nativeId === this.bindingIdentity.nativeId && current.workspace === this.bindingIdentity.workspace &&
            current.endpoint === this.bindingIdentity.endpoint && current.generation === this.bindingIdentity.generation;
          if (!this.ready || !currentIdentity) {
            response.writeHead(currentIdentity ? 503 : 409, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ provider: 'claude', nativeId: this.nativeId, generation: this.bindingIdentity.generation, endpoint: this.socketPath, channelReady: false }));
            return;
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            provider: 'claude',
            nativeId: this.nativeId,
            generation: this.bindingIdentity.generation,
            endpoint: this.socketPath,
            workspace: this.bindingIdentity.workspace,
            channelReady: true
          }));
          return;
        }
        if (request.method !== 'POST' || request.url !== '/event') {
          response.writeHead(404);
          response.end();
          return;
        }
        try {
          const body = await parseBody(request) as ClaudeChannelEvent;
          await this.handleEvent(body);
          response.writeHead(202);
          response.end('accepted');
        } catch (error) {
          const delivery = potentiallyDelivered(error);
          const isCustodyConflict = /custody|stale|mismatch|generation|authorization/i.test(errorMessage(error));
          let status: number;
          if (delivery === false) {
            status = isCustodyConflict ? 409 : 400;
          } else if (!this.ready || delivery) {
            status = 503;
          } else {
            status = isCustodyConflict ? 409 : 400;
          }
          response.writeHead(status);
          response.end(status === 503 ? 'uncertain' : 'rejected');
        }
      });
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(this.socketPath, () => {
          this.server!.off('error', reject);
          try { fs.chmodSync(this.socketPath, 0o600); } catch {}
          this.ownsSocket = true;
          resolve();
        });
      });
      if (this.transportClosed) throw new Error('Claude channel transport closed during startup');
      this.ready = true;
      this.started = true;
    } catch (error) {
      this.ready = false;
      try { await this.mcp.close?.(); } catch {}
      try { this.server?.close(); } catch {}
      this.server = null;
      if (this.ownsSocket) {
        try { fs.unlinkSync(this.socketPath); } catch {}
        this.ownsSocket = false;
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      this.ready = false;
      const errors: unknown[] = [];
      try { await this.mcp.close?.(); } catch (error) { errors.push(error); }
      try {
        if (this.server) await new Promise<void>((resolve, reject) => {
          this.server!.close(error => error ? reject(error) : resolve());
        });
      } catch (error) { errors.push(error); }
      this.server = null;
      if (this.ownsSocket) {
        try { fs.unlinkSync(this.socketPath); } catch (error) {
          if ((error as { code?: unknown }).code !== 'ENOENT') errors.push(error);
        }
        this.ownsSocket = false;
      }
      this.started = false;
      this.stopping = false;
      if (errors.length) throw new AggregateError(errors, 'Claude channel stop failed');
    })();
    try { await this.stopPromise; } finally { this.stopPromise = null; }
  }
}
