import {
  createAgentCompletionHandlers,
  type AgentCompletionDependencies,
  type AgentCompletionInput
} from '../../src/state/agent-completion';
import { NATIVE_REPLY_FILE_PHASES } from '../../src/state/native-reply-file';

const dependencies = {
  AGENT_COMPLETION_RECEIPTS: {
    RESULT_CONSUMED: 'result-consumed',
    REQUEST_HANDLED_WITHOUT_POST: 'request-handled-without-post'
  },
  MESSAGE_STATES: {
    SUBMITTED: 'submitted',
    AGENT_HANDLED_WITHOUT_POST: 'agent_handled_without_post'
  },
  DIRECT_POST_ATTEMPT: 'direct-post-attempt',
  DIRECT_POST_OUTCOME: 'direct-post-outcome',
  NATIVE_REPLY_FILE_PHASES,
  assertText: (value: unknown, _name: string, _max?: number) => String(value),
  assertProvider: (value: unknown) => String(value),
  assertUuid: (value: unknown) => String(value),
  parseJson: (_value: unknown, _fallback: null) => null,
  now: () => new Date().toISOString(),
  AuthorizationError: Error,
  BindingError: Error,
  StaleGenerationError: Error,
  StateCorruptError: Error
} satisfies AgentCompletionDependencies;

const handlers = createAgentCompletionHandlers(dependencies);
const complete: typeof handlers.completeAgentHandledWithoutPost = handlers.completeAgentHandledWithoutPost;
const input: AgentCompletionInput = {
  messageId: 'message',
  provider: 'codex',
  nativeId: '9caa5d21-2169-429d-918b-5f08651b5dbd',
  generation: 1,
  channelId: 'channel'
};

void complete;
void input;
