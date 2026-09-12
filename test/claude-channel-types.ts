import {
  ClaudeChannel,
  type ClaudeChannelEvent,
  type ClaudeChannelMcp,
  type ClaudeAcknowledgmentState,
  type ClaudeChannelReadState
} from '../src/claude-channel';

declare const state: ClaudeChannelReadState;

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
