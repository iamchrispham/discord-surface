export const {
  AuthorizationError,
  MESSAGE_STATES,
  NATIVE_ACK_RECEIPT,
  StaleGenerationError,
  validateNativeId
} = require('../../src/state') as {
  AuthorizationError: typeof Error;
  MESSAGE_STATES: {
    ACCEPTED: 'accepted';
    DISPATCHING: 'dispatching';
    UNCERTAIN: 'uncertain';
    SUBMITTED: 'submitted';
    REPLY_READY: 'reply_ready';
    REPLYING: 'replying';
    REPLIED: 'replied';
    DISPATCH_FAILED: 'dispatch_failed';
    REPLY_FAILED: 'reply_failed';
    REPLY_UNKNOWN: 'reply_unknown';
    AGENT_HANDLED_WITHOUT_POST: 'agent_handled_without_post';
    REJECTED: 'rejected';
  };
  NATIVE_ACK_RECEIPT: string;
  StaleGenerationError: typeof Error;
  validateNativeId: (value: unknown) => unknown;
};

export const NATIVE_PROVIDERS = Object.freeze({ CODEX: 'codex', CLAUDE: 'claude' } as const);
export type NativeProvider = typeof NATIVE_PROVIDERS[keyof typeof NATIVE_PROVIDERS];
export type MessageState = typeof MESSAGE_STATES[keyof typeof MESSAGE_STATES];
export const ACK_OUTCOMES = Object.freeze({ SENT: 'sent', STALE: 'stale', FAILED: 'failed', UNKNOWN: 'unknown' } as const);
export type AcknowledgmentOutcome = typeof ACK_OUTCOMES[keyof typeof ACK_OUTCOMES];

export const ACK = Object.freeze({ RECEIVED: NATIVE_ACK_RECEIPT, OUTCOME: 'native-ack-reaction' } as const);
export const ACK_WAITING = Symbol('native-acknowledgment-waiting');
export const REACTION = Object.freeze({ SAVED: '📥', ACKNOWLEDGED: '👀' } as const);
export const REPLY_READY_RECEIPTS = Object.freeze({
  REPLY: 'native-reply',
  BEFORE_SUBMIT: 'native-reply-before-submit'
} as const);
