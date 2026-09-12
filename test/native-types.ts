import {
  ClaudeProvider,
  CodexProvider,
  dispatchAndObserve,
  finalText,
  messageRequest,
  type DispatchOutcome,
  type NativeMessage,
  type NativeProvider,
  type NativeState
} from '../src/native';

const message: NativeMessage = {
  id: 'discord-message-1',
  channelId: 'channel-1',
  guildId: 'guild-1',
  provider: 'codex',
  nativeId: '9caa5d21-2169-429d-918b-5f08651b5dbd',
  generation: 1,
  workspace: '/tmp/workspace',
  sessionRoot: '/tmp/sessions',
  endpoint: null,
  content: 'Inspect the reported failure.',
  state: 'accepted',
  replyText: null,
  observerCursor: null
};

const state: NativeState = {
  getMessage: () => message,
  claimDispatch: () => ({ claimed: true, message }),
  markSubmitted: () => message,
  markNotSubmitted: () => message,
  markUncertain: () => message,
  markObservationUnavailable: () => message,
  recordNativeReply: () => message,
  setObserverCursor: () => message,
  currentMessageBinding: () => ({ current: true, binding: { sessionRoot: message.sessionRoot } })
};

const submitted: DispatchOutcome = { status: 'submitted', cursor: null };
const provider: NativeProvider = new CodexProvider();
const claudeProvider: NativeProvider = new ClaudeProvider({ waitForReply: async () => ({ stopped: true }) });

if (submitted.status === 'submitted') {
  const cursor = submitted.cursor;
  void cursor;
}

const request: string = messageRequest(message);
const final: string | null = finalText({ type: 'response_item', payload: null }, '[[discord-surface:discord-message-1]]');
void request;
void final;
void claudeProvider;

void dispatchAndObserve(state, message.id, { codex: provider }).then(report => {
  const status: string = report.status;
  void status;
});

// @ts-expect-error Message states are a finite domain.
const invalidState: NativeMessage = { ...message, state: 'typo' };
void invalidState;
