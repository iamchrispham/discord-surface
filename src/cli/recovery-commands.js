function createRecoveryCommands({ required, openState, print, gatewayProcessStatus, requestGatewayRecovery, GATEWAY_CAPABILITIES }) {
  function recoverCourier(args, dependencies = {}) {
    const messageId = required(args, 'courier-message-id');
    const attemptId = required(args, 'courier-attempt-id');
    const { paths, state } = openState(args);
    try {
      const gatewayStatus = dependencies.gatewayProcessStatus || gatewayProcessStatus;
      const runtime = gatewayStatus(paths);
      const requiredCapability = GATEWAY_CAPABILITIES.courierRecovery;
      // Unknown or malformed runtime evidence refuses before any mutation. A
      // running Gateway must name a safe-integer positive pid and a string-only
      // capability list; a boolean or string pid, or a non-array/mixed-type
      // capabilities container, is malformed rather than "supported".
      const malformedPid = runtime?.state === 'running' &&
        !(typeof runtime.pid === 'number' && Number.isSafeInteger(runtime.pid) && runtime.pid > 0);
      const malformedCapabilities = runtime?.state === 'running' &&
        !(Array.isArray(runtime.capabilities) && runtime.capabilities.every(capability => typeof capability === 'string'));
      if (!runtime || !['running', 'stopped', 'stale'].includes(runtime.state) || malformedPid || malformedCapabilities) {
        throw new Error('Gateway status is unknown; stop or restart it before courier recovery');
      }
      const live = runtime.state === 'running';
      if (live && !runtime.capabilities.includes(requiredCapability)) {
        throw new Error('running Gateway does not support courier recovery; stop or restart it before recovery');
      }
      // The retirement transaction is authoritative. The wake below never rolls it
      // back and never claims a retry happened.
      const result = state.recoverCourierAttempt(messageId, attemptId);
      const gatewayWake = (dependencies.requestGatewayRecovery || requestGatewayRecovery)(paths, {
        status: gatewayStatus, kill: dependencies.killProcess || process.kill,
        ...(live ? { expectedPid: runtime.pid } : {}), requiredCapability
      });
      const response = { ...result, gatewayWake };
      (dependencies.print || print)(response);
      return response;
    } finally { state.close(); }
  }

  function recover(args) {
    const mode = require('./flag-policy').recoverMode(args);
    // Courier mode is exclusive and owns its own Gateway preflight before mutation.
    if (mode === 'courier') return recoverCourier(args);
    const { paths, state } = openState(args);
    try {
      if (mode === 'board') {
        const boardTarget = {
          guildId: required(args, 'board-guild-id'),
          channelId: required(args, 'board-channel-id'),
          messageId: required(args, 'board-message-id')
        };
        const boardAttemptId = required(args, 'board-attempt-id');
        state.recoverBoardRefreshAttempt(boardTarget, boardAttemptId);
        print(state.reconcileBoardRefresh(
          boardTarget,
          boardAttemptId,
          required(args, 'board-resolution'),
          {
            evidenceScope: required(args, 'board-evidence-scope'),
            observedAt: required(args, 'board-readback-at'),
            readbackContent: required(args, 'board-readback'),
            soleWriter: args['board-sole-writer'] === true || args['board-sole-writer'] === 'true',
            singleAttempt: args['board-single-attempt'] === true || args['board-single-attempt'] === 'true',
            noHiddenRetry: args['board-no-hidden-retry'] === true || args['board-no-hidden-retry'] === 'true'
          }
        ));
      } else if (mode === 'topic') {
        const resolution = required(args, 'resolution');
        if (!['published', 'not_published'].includes(resolution)) throw new Error('--resolution must be published or not_published for topic reconciliation');
        print(state.reconcileTopicPublication(
          required(args, 'topic-channel-id'),
          required(args, 'topic-request-id'),
          resolution,
          required(args, 'evidence-scope'),
          { topic: required(args, 'topic-readback'), observedAt: required(args, 'topic-readback-at') }
        ));
      } else if (mode === 'intake') {
        const channelId = required(args, 'intake-channel-id');
        const thread = state.getThreadEnrollment(channelId);
        const activeThread = thread?.active ? thread : null;
        const recovered = state.reconcileIntake(channelId);
        if (activeThread && !recovered) throw new Error('Thread recovery requires the current active parent binding');
        print(activeThread ? {
          enrollment: recovered,
          gatewayWake: requestGatewayRecovery(paths, {
            requiredCapability: GATEWAY_CAPABILITIES.threadEnrollmentRecoveryWake
          })
        } : recovered);
      } else if (mode === 'reply') {
        print(state.reconcileReplyDelivery(required(args, 'message-id'), args.resolution === 'reply_sent' ? 'sent' : 'not_sent', {
          partIndex: args['part-index'] === undefined ? null : Number(args['part-index']),
          replyMessageId: args['reply-message-id']
        }));
      } else if (mode === 'directPost') {
        const resolution = required(args, 'resolution');
        if (!['sent', 'not_sent'].includes(resolution)) throw new Error('--resolution must be sent or not_sent for direct-post reconciliation');
        print(state.reconcileDirectPostOutcome(
          required(args, 'direct-post-request-id'),
          required(args, 'direct-post-attempt-id'),
          resolution,
          {
            evidenceScope: required(args, 'evidence-scope'),
            messageId: args['direct-post-message-id'],
            nonce: args['direct-post-nonce']
          }
        ));
      } else if (mode === 'message') print(state.reconcileUncertain(required(args, 'message-id'), args.resolution));
      else print(state.recoverAfterRestart());
    }
    finally { state.close(); }
  }

  return { recoverCourier, recover };
}

module.exports = { createRecoveryCommands };
