const fs = require('node:fs');
const path = require('node:path');
const { PROVIDERS } = require('../state');
const { resolveInvocationIdentity } = require('../ordinary-codex');
const { validateCodexSessionIdentityAsync } = require('../native');
const { GATEWAY_CAPABILITIES } = require('../ordinary-bind/constants');

function createNativeCompletionCommands({ required, openState, pathsFor, print, resolveCurrentClaudeCaller, gatewayProcessStatus, requestGatewayRecovery }) {
  function nativeReply(args, compatibilityProvider = null) {
    const { state } = openState(args);
    try {
      const provider = compatibilityProvider || required(args, 'provider');
      if (!['codex', 'claude'].includes(provider)) throw new Error('invalid agent provider');
      const generation = Number(required(args, 'generation'));
      if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('generation must be a positive integer');
      const textFile = path.resolve(required(args, 'text-file'));
      const stat = fs.statSync(textFile);
      if (!stat.isFile()) throw new Error('text file must be a regular file');
      const messageId = required(args, 'message-id');
      const nativeId = required(args, 'native-id');
      const text = fs.readFileSync(textFile, 'utf8');
      const fileManifest = Object.hasOwn(args, 'attachment-file')
        ? state.prepareNativeReplyFile({ provider, messageId, nativeId, generation, stateDir: pathsFor(args).stateDir,
          sourcePath: path.resolve(required(args, 'attachment-file')), caption: text })
        : null;
      const result = state.recordNativeReply({
        provider,
        messageId,
        nativeId,
        generation,
        text,
        ...(fileManifest ? { fileManifest } : {})
      });
      print({
        messageId,
        recorded: !result.duplicate,
        duplicate: Boolean(result.duplicate),
        state: result.message.state,
        ...(fileManifest ? { filePreparationId: fileManifest.preparationId } : {})
      });
    } finally { state.close(); }
  }

  function claudeReply(args) {
    return nativeReply(args, 'claude');
  }

  function agentComplete(args, dependencies = {}) {
    const { paths, state } = openState(args);
    const output = dependencies.print || print;
    const gatewayStatus = dependencies.gatewayProcessStatus || gatewayProcessStatus;
    const requestRecovery = dependencies.requestGatewayRecovery || requestGatewayRecovery;
    try {
      const runtime = gatewayStatus(paths);
      const requiredCapability = GATEWAY_CAPABILITIES.agentHandledWithoutPost;
      if (!runtime || !['running', 'stopped', 'stale'].includes(runtime.state)) {
        throw new Error('Gateway status is unknown; stop or restart it before agent completion');
      }
      const live = runtime.state === 'running' && Number.isSafeInteger(Number(runtime.pid)) && Number(runtime.pid) > 0;
      if (runtime.state === 'running' && !live) {
        throw new Error('Gateway status is unknown; stop or restart it before agent completion');
      }
      if (live && !runtime.capabilities?.includes(requiredCapability)) {
        throw new Error('running Gateway does not support agent handled-without-post completion; stop or restart it before completion');
      }
      const result = state.completeAgentHandledWithoutPost({
        messageId: required(args, 'message-id'),
        provider: required(args, 'provider'),
        nativeId: required(args, 'native-id'),
        generation: Number(required(args, 'generation')),
        channelId: args['channel-id'] || null
      });
      const gatewayWake = requestRecovery(paths, {
        status: gatewayStatus,
        kill: dependencies.killProcess || process.kill,
        ...(live ? { expectedPid: runtime.pid } : {}),
        requiredCapability
      });
      const response = { ...result, gatewayWake };
      output(response);
      return response;
    } finally {
      state.close();
    }
  }

  async function agentWithdraw(args, dependencies = {}) {
    const provider = required(args, 'provider');
    const nativeId = required(args, 'native-id');
    if (provider === PROVIDERS.CLAUDE) {
      const caller = await (dependencies.resolveClaudeCaller || (() => resolveCurrentClaudeCaller(dependencies)))();
      if (caller?.harness !== 'claude-code' || caller.sessionId !== nativeId ||
          (caller.threadId != null && caller.threadId !== nativeId)) {
        throw new Error('agent withdrawal requires the current Claude caller');
      }
    } else if (provider === PROVIDERS.CODEX) {
      const caller = (dependencies.resolveInvocationIdentity || resolveInvocationIdentity)(dependencies.environment || process.env);
      if (caller.sessionId !== nativeId || caller.threadId !== nativeId) {
        throw new Error('agent withdrawal requires the current Codex caller');
      }
    } else {
      throw new Error('invalid agent provider');
    }
    const { paths, state } = openState(args);
    try {
      if (provider === PROVIDERS.CODEX) {
        const sessionRoot = state.agentWithdrawalRequesterSessionRoot(required(args, 'message-id'), required(args, 'packet-id'));
        await (dependencies.validateCodexSessionIdentity || validateCodexSessionIdentityAsync)(nativeId, undefined, sessionRoot);
      }
      const gatewayStatus = dependencies.gatewayProcessStatus || gatewayProcessStatus;
      const runtime = gatewayStatus(paths);
      const requiredCapability = GATEWAY_CAPABILITIES.agentRequestWithdrawal;
      if (!runtime || !['running', 'stopped', 'stale'].includes(runtime.state) ||
          (runtime.state === 'running' && (!Number.isSafeInteger(Number(runtime.pid)) || Number(runtime.pid) <= 0))) {
        throw new Error('Gateway status is unknown; stop or restart it before agent withdrawal');
      }
      const live = runtime.state === 'running';
      if (live && !runtime.capabilities?.includes(requiredCapability)) {
        throw new Error('running Gateway does not support agent withdrawal; stop or restart it before withdrawal');
      }
      const result = state.withdrawAgentRequest({
        messageId: required(args, 'message-id'), packetId: required(args, 'packet-id'),
        provider, nativeId, generation: Number(required(args, 'generation'))
      });
      const gatewayWake = (dependencies.requestGatewayRecovery || requestGatewayRecovery)(paths, {
        status: gatewayStatus, kill: dependencies.killProcess || process.kill,
        ...(live ? { expectedPid: runtime.pid } : {}), requiredCapability
      });
      const response = { ...result, gatewayWake };
      (dependencies.print || print)(response);
      return response;
    } finally { state.close(); }
  }

  return { nativeReply, claudeReply, agentComplete, agentWithdraw };
}

module.exports = { createNativeCompletionCommands };
