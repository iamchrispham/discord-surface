import { createOrdinaryClaudeRequest, OrdinaryClaudeRequest } from '../src/ordinary-codex';

const session = '9caa5d21-2169-429d-918b-5f08651b5dbd';

const request: OrdinaryClaudeRequest = createOrdinaryClaudeRequest({
  channelId: 'channel',
  guildId: 'guild',
  nativeId: session,
  workspace: '/tmp/workspace',
  endpoint: '/tmp/claude.sock',
  identity: { sessionId: session, threadId: session, harness: 'claude-code' }
});

request.provider satisfies 'claude';
request.endpoint satisfies string;

createOrdinaryClaudeRequest({
  channelId: 'channel',
  guildId: 'guild',
  workspace: '/tmp/workspace',
  endpoint: '/tmp/claude.sock',
  identity: { sessionId: session, threadId: session, // @ts-expect-error ordinary Claude requests require the Claude harness
    harness: 'codex' }
});
