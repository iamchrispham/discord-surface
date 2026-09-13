import {
  ClaudeChannel,
  type ClaudeChannelEvent,
  type ClaudeChannelMcp,
  type ClaudeChannelNotification,
  type ClaudeChannelState,
  type ClaudeAcknowledgmentState,
  type ClaudeChannelReadState,
  type ClaudeChannelOptions,
  type ClaudeDefaultMcp,
  parseBody,
  createDefaultMcp
} from '../src/claude-channel';
import type { AcknowledgmentState, NativeAcknowledgmentInput } from '../src/acknowledgment';
import { Readable } from 'node:stream';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ListToolsRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

declare const state: ClaudeChannelReadState;
declare const richChannelState: ClaudeChannelState;

type NarrowNotification = ClaudeChannelNotification & { requiredField: string };

const narrowedNotificationMcp: ClaudeChannelMcp = {
  // @ts-expect-error notification callback must accept every channel notification
  notification: (notification: NarrowNotification) => notification.requiredField
};

const mcp: ClaudeChannelMcp = {
  notification: async notification => {
    notification.method satisfies 'notifications/claude/channel';
    notification.params.content satisfies string;
  }
};

const synchronousAssertionState: ClaudeChannelReadState = {
  findNativeBinding: () => undefined,
  getBinding: () => undefined,
  getMessage: () => undefined,
  assertMessageCurrent: () => undefined
};
const asyncAssertionState = {
  ...synchronousAssertionState,
  assertMessageCurrent: async () => {}
};
// @ts-expect-error read-state assertions are synchronous because handleEvent does not await them
const invalidAsyncAssertionState: ClaudeChannelReadState = asyncAssertionState;
void invalidAsyncAssertionState;

const literalPhaseReadState: ClaudeChannelReadState = {
  ...synchronousAssertionState,
  assertMessageCurrent: (_messageId: string, phase: 'native-dispatch') => {
    phase satisfies 'native-dispatch';
  }
};
void literalPhaseReadState;

const literalPhaseRichAssertion: ClaudeChannelState['assertMessageCurrent'] = (_messageId, phase: 'native-dispatch') => {
  phase satisfies 'native-dispatch';
  throw new Error('type fixture');
};
void literalPhaseRichAssertion;

const arbitraryStringReadState: ClaudeChannelReadState = {
  findNativeBinding: (nativeId: string, provider: 'claude') => {
    nativeId satisfies string;
    provider satisfies 'claude';
    return undefined;
  },
  getBinding: (channelId: string) => {
    channelId satisfies string;
    return undefined;
  },
  getMessage: (messageId: string) => {
    messageId satisfies string;
    return undefined;
  },
  assertMessageCurrent: () => undefined
};
void arbitraryStringReadState;

const broadProviderFindNativeBinding: ClaudeChannelReadState['findNativeBinding'] = (
  _nativeId: string,
  _provider: NativeAcknowledgmentInput['provider']
) => undefined;
void broadProviderFindNativeBinding;

const narrowedFindNativeBinding = (_nativeId: 'fixed', _provider: NativeAcknowledgmentInput['provider']) => undefined;
const narrowedGetBinding = (_channelId: 'fixed') => undefined;
const narrowedGetMessage = (_messageId: 'fixed') => undefined;
const invalidNarrowedReadState: ClaudeChannelReadState = {
  ...synchronousAssertionState,
  // @ts-expect-error read-state binding callbacks must accept arbitrary native IDs
  findNativeBinding: narrowedFindNativeBinding,
  // @ts-expect-error read-state binding callbacks must accept arbitrary channel IDs
  getBinding: narrowedGetBinding,
  // @ts-expect-error read-state message callbacks must accept arbitrary message IDs
  getMessage: narrowedGetMessage
};
void invalidNarrowedReadState;

const arbitraryStringRichGetMessage: ClaudeChannelState['getMessage'] = (messageId: string) => {
  messageId satisfies string;
  return undefined;
};
void arbitraryStringRichGetMessage;
const invalidNarrowedRichState: ClaudeChannelState = {
  ...richChannelState,
  // @ts-expect-error rich message callbacks must accept arbitrary message IDs
  getMessage: narrowedGetMessage
};
void invalidNarrowedRichState;

const injectedMcpWithOwnHandler = {
  notification: async () => {},
  setRequestHandler: (
    schema: { kind: 'narrow' },
    handler: (request: { params: { name: string } }) => void
  ) => {
    schema.kind satisfies 'narrow';
    void handler;
  }
};
const injectedMcpWithOwnHandlerContract: ClaudeChannelMcp = injectedMcpWithOwnHandler;

const event: ClaudeChannelEvent = {
  nativeId: '11111111-1111-1111-1111-111111111111',
  messageId: 'discord-message',
  generation: 1,
  content: 'event'
};

const channel = new ClaudeChannel({
  state,
  nativeId: event.nativeId,
  socketPath: '/tmp/claude-channel.sock',
  mcp
});

richChannelState.assertMessageCurrent('id', 'native-dispatch').channelId satisfies string;

void channel.handleEvent(event);
void channel.stop();

// @ts-expect-error injected MCPs do not expose the default SDK surface
void channel.mcp.ping();

type CustomTransport = { marker: string };
const concreteTransportMcp: ClaudeChannelMcp<CustomTransport> = {
  notification: async notification => {
    notification.params.content satisfies string;
  },
  connect: transport => {
    transport.marker satisfies string;
  },
  transportFactory: () => ({ marker: 'transport' })
};
const concreteTransportChannel = new ClaudeChannel({
  state,
  nativeId: event.nativeId,
  socketPath: '/tmp/claude-channel-concrete.sock',
  mcp: concreteTransportMcp
});
const concreteTransport = concreteTransportChannel.mcp.transportFactory!();
concreteTransport.marker satisfies string;
const concreteResolvedMcp: ClaudeChannelMcp<CustomTransport> = concreteTransportChannel.mcp;
void concreteResolvedMcp;
void concreteTransportChannel;

const ignoredSynchronousResultMcp: ClaudeChannelMcp<{ marker: string }> = {
  notification: async () => {},
  connect: transport => ({ connected: transport.marker }),
  close: () => ({ closed: true }),
  transportFactory: () => ({ marker: 'sync-result' })
};
new ClaudeChannel({
  state,
  nativeId: event.nativeId,
  socketPath: '/tmp/claude-channel-sync-result.sock',
  mcp: ignoredSynchronousResultMcp
});

const ignoredThenableResult: PromiseLike<{ closed: boolean }> = Promise.resolve({ closed: true });
const ignoredPromiseResultMcp: ClaudeChannelMcp<{ marker: string }> = {
  notification: async () => {},
  connect: async transport => ({ connected: transport.marker }),
  close: () => ignoredThenableResult,
  transportFactory: () => ({ marker: 'promise-result' })
};
new ClaudeChannel({
  state,
  nativeId: event.nativeId,
  socketPath: '/tmp/claude-channel-promise-result.sock',
  mcp: ignoredPromiseResultMcp
});

const inferredValidMcp = {
  notification: () => {},
  connect: (transport: { marker: string }) => {
    transport.marker satisfies string;
  },
  transportFactory: () => ({ marker: 'transport' })
};
new ClaudeChannel({
  state,
  nativeId: event.nativeId,
  socketPath: '/tmp/claude-channel-inferred.sock',
  mcp: inferredValidMcp
});

const inferredWiderConnectMcp = {
  notification: () => {},
  connect: (transport: { marker?: string }) => {
    transport.marker satisfies string | undefined;
  },
  transportFactory: () => ({ marker: 'transport' })
};
new ClaudeChannel({
  state,
  nativeId: event.nativeId,
  socketPath: '/tmp/claude-channel-inferred-wider-connect.sock',
  mcp: inferredWiderConnectMcp
});

new ClaudeChannel({
  state,
  nativeId: event.nativeId,
  socketPath: '/tmp/claude-channel-own-handler.sock',
  mcp: injectedMcpWithOwnHandlerContract
});

const inferredStringNumberMcp = {
  notification: () => {},
  connect: (transport: number) => {
    transport satisfies number;
  },
  transportFactory: () => 'transport'
};
new ClaudeChannel({
  state,
  nativeId: event.nativeId,
  socketPath: '/tmp/claude-channel-mismatch-a.sock',
  // @ts-expect-error inferred factory/connect transport types must match
  mcp: inferredStringNumberMcp
});

const inferredNumberStringMcp = {
  notification: () => {},
  connect: (transport: string) => {
    transport satisfies string;
  },
  transportFactory: () => 1
};
declare const acknowledgmentState: ClaudeAcknowledgmentState;

type NarrowReplyInput = NativeAcknowledgmentInput & { text: string; requiredField: string };
const exactRichReply: ClaudeAcknowledgmentState['recordNativeReply'] = () => ({
  duplicate: false,
  message: undefined
});
void exactRichReply;
const broadRichReply = (_input: NativeAcknowledgmentInput & { text: string }) => ({ duplicate: false, message: undefined });
const broadRichReplyState: ClaudeAcknowledgmentState = {
  ...acknowledgmentState,
  recordNativeReply: broadRichReply
};
void broadRichReplyState;
const narrowedRichReply = (_input: NarrowReplyInput) => ({ duplicate: false, message: undefined });
const invalidRichReplyState: ClaudeAcknowledgmentState = {
  ...acknowledgmentState,
  // @ts-expect-error narrowed reply callbacks must be rejected under strictFunctionTypes
  recordNativeReply: narrowedRichReply
};
void invalidRichReplyState;

type ClaudeReplyInput = NativeAcknowledgmentInput & { provider: 'claude'; text: string };
const claudeOnlyRichReply = (_input: ClaudeReplyInput) => ({ duplicate: false, message: undefined });
const claudeOnlyRichReplyState: ClaudeAcknowledgmentState = {
  ...acknowledgmentState,
  recordNativeReply: claudeOnlyRichReply
};
void claudeOnlyRichReplyState;

const optionalCustomMcp: ClaudeChannelMcp<CustomTransport> | undefined = Math.random() > 0.5 ? concreteTransportMcp : undefined;
const optionalCustomChannel = new ClaudeChannel({
  state: acknowledgmentState,
  nativeId: event.nativeId,
  socketPath: '/tmp/claude-channel-optional-custom-mcp.sock',
  mcp: optionalCustomMcp
});
const optionalCustomResolvedMcp: ClaudeChannelMcp<CustomTransport> | ClaudeDefaultMcp<StdioServerTransport> = optionalCustomChannel.mcp;
void optionalCustomResolvedMcp;
// @ts-expect-error optional MCP output cannot be treated as custom-only
const optionalCustomOnlyMcp: ClaudeChannelMcp<CustomTransport> = optionalCustomChannel.mcp;
void optionalCustomOnlyMcp;
// @ts-expect-error optional MCP output cannot be treated as default-only
const optionalDefaultOnlyMcp: ClaudeDefaultMcp<StdioServerTransport> = optionalCustomChannel.mcp;
void optionalDefaultOnlyMcp;

const errorAwareMcp: ClaudeChannelMcp<StdioServerTransport> = {
  notification: async () => {},
  onerror: error => {
    error.message satisfies string;
  }
};
const optionalMcp: ClaudeChannelMcp<StdioServerTransport> | undefined = Math.random() > 0.5 ? errorAwareMcp : undefined;
const optionalAcknowledgmentOptions: ClaudeChannelOptions<typeof optionalMcp> = {
  state: acknowledgmentState,
  nativeId: event.nativeId,
  socketPath: '/tmp/claude-channel-optional-options.sock',
  mcp: optionalMcp
};
new ClaudeChannel(optionalAcknowledgmentOptions);
new ClaudeChannel({
  state: acknowledgmentState,
  nativeId: event.nativeId,
  socketPath: '/tmp/claude-channel-optional-mcp.sock',
  mcp: optionalMcp
});

const defaultTransportChannel = new ClaudeChannel({
  state: acknowledgmentState,
  nativeId: event.nativeId,
  socketPath: '/tmp/claude-channel-default-transport.sock'
});
const defaultChannelMcp: ClaudeDefaultMcp<StdioServerTransport> = defaultTransportChannel.mcp;
void defaultChannelMcp.ping();
void defaultChannelMcp.close();
defaultChannelMcp.setRequestHandler(ListToolsRequestSchema, async (request: ListToolsRequest) => {
  void request.params?.cursor;
  return { tools: [] };
});
const defaultTransport = defaultTransportChannel.mcp.transportFactory!();
defaultTransport satisfies StdioServerTransport;
void defaultTransportChannel;

type MinimalDefaultMcpState = AcknowledgmentState & {
  recordNativeReply: (input: NativeAcknowledgmentInput & { provider: 'claude'; text: string }) => { duplicate: boolean };
};

const minimalDefaultState: MinimalDefaultMcpState = {
  db: {
    prepare: () => ({
      all: () => [],
      get: () => undefined,
      run: () => undefined
    })
  },
  dbPath: '/tmp/discord-surface-ack.db',
  transaction: <T>(operation: () => T): T => operation(),
  getMessage: () => undefined,
  currentMessageBinding: () => undefined,
  receipt: () => {},
  recordNativeReply: () => ({ duplicate: false })
};
const claudeOnlyDefaultState: MinimalDefaultMcpState = {
  ...minimalDefaultState,
  recordNativeReply: claudeOnlyRichReply
};
void createDefaultMcp({ nativeId: event.nativeId, state: claudeOnlyDefaultState });
const broadDefaultReply = (_input: NativeAcknowledgmentInput & { text: string }) => ({ duplicate: false });
const broadDefaultState: MinimalDefaultMcpState = {
  ...minimalDefaultState,
  recordNativeReply: broadDefaultReply
};
void createDefaultMcp({ nativeId: event.nativeId, state: broadDefaultState });
const defaultMcp = createDefaultMcp({ nativeId: event.nativeId, state: minimalDefaultState });
void defaultMcp.connect(defaultMcp.transportFactory());
void defaultMcp.close();
const customNotificationResult: ReturnType<Server['notification']> = defaultMcp.notification({
  method: 'notifications/claude/channel',
  params: {
    content: 'reply',
    meta: { messageId: event.messageId, generation: String(event.generation), nativeId: event.nativeId }
  }
});
void customNotificationResult;
const sdkNotification: Parameters<Server['notification']>[0] = {
  method: 'notifications/cancelled',
  params: { requestId: event.messageId, reason: 'superseded' }
};
const sdkNotificationResult: ReturnType<Server['notification']> = defaultMcp.notification(sdkNotification, {
  relatedRequestId: event.messageId
});
void sdkNotificationResult;
const pingResult: ReturnType<Server['ping']> = defaultMcp.ping();
void pingResult;
defaultMcp.setRequestHandler(ListToolsRequestSchema, async (request: ListToolsRequest) => {
  void request.params?.cursor;
  return { tools: [] };
});
// @ts-expect-error request handlers accept only installed SDK schemas
defaultMcp.setRequestHandler({ kind: 'invalid-schema' }, async () => ({ tools: [] }));
// @ts-expect-error the default helper always creates a StdioServerTransport
void defaultMcp.connect({});
const narrowedDefaultState = {
  ...minimalDefaultState,
  recordNativeReply: narrowedRichReply
};
createDefaultMcp({
  nativeId: event.nativeId,
  // @ts-expect-error the default state callback must accept the runtime reply input
  state: narrowedDefaultState
});

void parseBody(Readable.from(['{}']));
const parsedBodyDouble: Parameters<typeof parseBody>[0] = {
  setEncoding: () => {},
  on: () => {},
  destroy: () => {}
};
void parseBody(parsedBodyDouble);
const incompleteBodyDouble = {
  setEncoding: () => {},
  on: () => {}
};
// @ts-expect-error parseBody requires every consumed request capability
void parseBody(incompleteBodyDouble);

declare const injectedMinimalMcp: ClaudeChannelMcp;
// @ts-expect-error injected MCPs expose only the channel notification shape
void injectedMinimalMcp.notification(sdkNotification, { relatedRequestId: event.messageId });

const minimalDefaultChannelState: ClaudeChannelReadState & MinimalDefaultMcpState = {
  ...minimalDefaultState,
  findNativeBinding: () => undefined,
  getBinding: () => undefined,
  getMessage: () => undefined,
  assertMessageCurrent: () => undefined
};
new ClaudeChannel({
  state: minimalDefaultChannelState,
  nativeId: event.nativeId,
  socketPath: '/tmp/claude-channel-minimal-default.sock'
});

new ClaudeChannel({
  state: acknowledgmentState,
  nativeId: event.nativeId,
  socketPath: '/tmp/claude-channel-default.sock'
});

new ClaudeChannel({
  // @ts-expect-error notification-only state cannot select the default acknowledgment path
  state,
  nativeId: event.nativeId,
  socketPath: '/tmp/claude-channel-default-invalid.sock'
});

new ClaudeChannel({
  state,
  nativeId: event.nativeId,
  socketPath: '/tmp/claude-channel-mismatch-b.sock',
  // @ts-expect-error inferred factory/connect transport types must match
  mcp: inferredNumberStringMcp
});

acknowledgmentState.recordNativeReply({
  // @ts-expect-error provider identity is finite
  provider: 'other',
  messageId: 'id',
  nativeId: event.nativeId,
  generation: 1,
  text: 'reply'
});
acknowledgmentState.recordNativeReply({
  provider: 'claude',
  messageId: 'id',
  nativeId: event.nativeId,
  // @ts-expect-error generation is numeric at the typed boundary
  generation: '1',
  text: 'reply'
});
