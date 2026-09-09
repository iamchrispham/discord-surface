const CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX = 'Claude endpoint unavailable before event write:';

const ORDINARY_RECEIPT_KINDS = Object.freeze({
  BOUND: 'ordinary-bound',
  NATIVE_PREFLIGHT: 'ordinary-native-preflight',
  HANDOFF: 'ordinary-handoff',
  HANDOFF_RETRY: 'ordinary-handoff-retry',
  ROOT_RELOCATED: 'ordinary-root-relocated'
});

module.exports = { CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX, ORDINARY_RECEIPT_KINDS };
