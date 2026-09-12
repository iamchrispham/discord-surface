import {
  ClaudeChannel,
  type ClaudeChannelEvent,
  type ClaudeChannelMcp,
  type ClaudeChannelState
} from '../src/claude-channel';

declare const state: ClaudeChannelState;

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

// @ts-expect-error provider identity is finite
state.recordNativeReply({ provider: 'other', messageId: 'id', nativeId: event.nativeId, generation: 1, text: 'reply' });
// @ts-expect-error generation is numeric at the typed boundary
state.recordNativeReply({ provider: 'claude', messageId: 'id', nativeId: event.nativeId, generation: '1', text: 'reply' });
