import type { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CLAUDE_PICKUP_ACKNOWLEDGMENT } from '../acknowledgment/pickup';
import type { ClaudeDefaultMcp, ClaudeDefaultMcpState } from './channel-contracts';

const { recordNativeAcknowledgment } = require('../acknowledgment') as typeof import('../acknowledgment');
const requireInstalled = require;

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
      instructions: 'This channel is explicitly opted in by the native Claude session. For each event, call acknowledge at pickup. ' +
        `${CLAUDE_PICKUP_ACKNOWLEDGMENT} ` +
        "After the acknowledgment branch, follow the event's kind-specific instructions exactly. Do not assume a reply, completion, or consume action from this initialization text. Do not attach, resume, or start another session."
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
