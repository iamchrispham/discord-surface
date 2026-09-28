import type {
  AcknowledgmentState,
  MessageState,
  NativeAcknowledgmentInput
} from '../acknowledgment';
import type { Attachment } from '../attachments';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

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
  findNativeBinding: (nativeId: string, provider: 'claude') => ClaudeBinding | null | undefined;
  getBinding: (channelId: string) => ClaudeBinding | null | undefined;
  getMessage: (messageId: string) => ClaudeChannelReadMessage | null | undefined;
  assertMessageCurrent: (messageId: string, phase: 'native-dispatch') => ClaudeChannelReadMessage | void;
}

export interface ClaudeChannelState extends ClaudeChannelReadState {
  getMessage: (messageId: string) => ClaudeMessage | null | undefined;
  assertMessageCurrent: (messageId: string, phase: 'native-dispatch') => ClaudeMessage;
}

export type ClaudeNativeReplyInput = Omit<NativeAcknowledgmentInput, 'provider'> & {
  provider: 'claude';
};

export type ClaudeAcknowledgmentState = ClaudeChannelState & AcknowledgmentState & {
  recordNativeReply: (input: ClaudeNativeReplyInput & { text: string }) => {
    duplicate: boolean;
    message: ClaudeMessage | null | undefined;
  };
};

export type ClaudeDefaultMcpState = AcknowledgmentState & {
  recordNativeReply: (input: ClaudeNativeReplyInput & { text: string }) => {
    duplicate: boolean;
  };
};

export interface ClaudeChannelEvent {
  nativeId: string;
  messageId: string;
  generation: number;
  content: string;
  attachments?: unknown;
  completion?: readonly string[] | null;
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
    completion?: readonly string[];
  };
}

export interface ClaudeChannelMcpBase {
  notification: (notification: ClaudeChannelNotification) => Promise<unknown> | unknown;
  close?: () => unknown;
  onclose?: (() => void) | null;
  onerror?: ((error: Error) => void) | null;
}

export type ClaudeDefaultMcpNotification =
  Server['notification'] &
  ((notification: ClaudeChannelNotification, options?: Parameters<Server['notification']>[1]) => ReturnType<Server['notification']>);

export interface ClaudeDefaultMcp<TTransport = unknown> extends Omit<Server, 'connect' | 'notification'> {
  notification: ClaudeDefaultMcpNotification;
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

export type ClaudeMcpValidationMember<TProvidedMcp> =
  TProvidedMcp extends ClaudeDefaultMcp<StdioServerTransport>
    ? unknown
    : TProvidedMcp extends ClaudeChannelMcpBase
      ? TProvidedMcp extends {
          connect: (transport: infer TConnect) => unknown;
          transportFactory: () => infer TFactory;
        }
        ? [TFactory] extends [TConnect]
          ? unknown
          : never
        : TProvidedMcp extends {
            connect?: undefined;
            transportFactory?: (() => unknown) | undefined;
          }
          ? unknown
          : never
      : never;

export type ClaudeMcpInvalidMember<TProvidedMcp> = TProvidedMcp extends unknown
  ? ClaudeMcpValidationMember<TProvidedMcp> extends never ? TProvidedMcp : never
  : never;

export type ClaudeMcpValidation<TProvidedMcp> =
  [TProvidedMcp] extends [undefined]
    ? unknown
    : [ClaudeMcpInvalidMember<Exclude<TProvidedMcp, undefined>>] extends [never]
      ? unknown
      : never;

export type ClaudeResolvedMcp<TProvidedMcp> = NonNullable<[TProvidedMcp] extends [undefined]
  ? ClaudeDefaultMcp<StdioServerTransport>
  : undefined extends TProvidedMcp
    ? Exclude<TProvidedMcp, undefined> | ClaudeDefaultMcp<StdioServerTransport>
    : TProvidedMcp>;

export type ClaudeRuntimeMcp = ClaudeChannelMcpBase & {
  connect?: (transport: unknown) => unknown;
  transportFactory?: () => unknown;
};

export interface ClaudeChannelOptionsBase {
  nativeId: string;
  socketPath: string;
  beforeTransportClose?: (() => void | Promise<void>) | null;
  onTransportClose?: (() => void) | null;
  logger?: (message: string) => void;
}

export type ClaudeMcpInput<TProvidedMcp> =
  [TProvidedMcp] extends [undefined]
    ? { mcp?: undefined }
    : { mcp: TProvidedMcp & ClaudeMcpValidation<TProvidedMcp> };

export type ClaudeChannelOptions<
  TProvidedMcp = undefined,
  TState extends ClaudeChannelReadState = ClaudeChannelReadState
> = ClaudeChannelOptionsBase & {
  state: undefined extends TProvidedMcp ? TState & ClaudeDefaultMcpState : TState;
} & ClaudeMcpInput<TProvidedMcp>;
