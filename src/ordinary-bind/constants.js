const GATEWAY_CAPABILITIES = Object.freeze({
  ordinaryBindWake: 'ordinary-bind-wake-v1',
  threadEnrollmentRecoveryWake: 'thread-enrollment-recovery-wake-v1',
  runtimeBindLock: 'runtime-bind-lock-v1',
  ordinaryClaudeBind: 'ordinary-claude-bind-v1',
  agentHandledWithoutPost: 'agent-handled-without-post-v1',
  agentRequestWithdrawal: 'agent-request-withdrawal-v1',
  watcherNoticeIngress: 'watcher-notice-ingress-v1'
});

module.exports = { GATEWAY_CAPABILITIES };
