import {
  ClaudeChannel,
  type ClaudeChannelEvent,
  type ClaudeChannelMcp,
  type ClaudeChannelNotification,
  type ClaudeAcknowledgmentState,
  type ClaudeChannelReadState,
  type ClaudeChannelOptions,
  createDefaultMcp
} from '../src/claude-channel';
import type { AcknowledgmentState } from '../src/acknowledgment';

declare const state: ClaudeChannelReadState;

type NarrowNotification = ClaudeChannelNotification & { requiredField: string };

const narrowedNotificationMcp: ClaudeChannelMcp = {
  // @ts-expect-error notification callback must accept every channel notification
  notification: (notification: NarrowNotification) => notification.requiredField
};

const mcp: ClaudeChannelMcp = {
  setRequestHandler: () => {},
  notification: async notification => {
    notification.method satisfies 'notifications/claude/channel';
    notification.params.content satisfies string;
  }
};

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

void channel.handleEvent(event);
void channel.stop();

const concreteTransportMcp: ClaudeChannelMcp<{ marker: string }> = {
  notification: async notification => {
    notification.params.content satisfies string;
  },
  connect: transport => {
    transport.marker satisfies string;
  },
  transportFactory: () => ({ marker: 'transport' })
};
new ClaudeChannel({
  state,
  nativeId: event.nativeId,
  socketPath: '/tmp/claude-channel-concrete.sock',
  mcp: concreteTransportMcp
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

const errorAwareMcp: ClaudeChannelMcp = {
  notification: async () => {},
  onerror: error => {
    error.message satisfies string;
  }
};
const optionalMcp: ClaudeChannelMcp | undefined = Math.random() > 0.5 ? errorAwareMcp : undefined;
type AcknowledgmentOptions = Extract<ClaudeChannelOptions, { state: ClaudeAcknowledgmentState }>;
const optionalAcknowledgmentOptions: AcknowledgmentOptions = {
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

const minimalDefaultState: AcknowledgmentState & Pick<ClaudeAcknowledgmentState, 'recordNativeReply'> = {
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
  recordNativeReply: () => ({ duplicate: false, message: undefined })
};
createDefaultMcp({ nativeId: event.nativeId, state: minimalDefaultState });

new ClaudeChannel({
  state: acknowledgmentState,
  nativeId: event.nativeId,
  socketPath: '/tmp/claude-channel-default.sock'
});

// @ts-expect-error notification-only state cannot select the default acknowledgment path
new ClaudeChannel({
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
