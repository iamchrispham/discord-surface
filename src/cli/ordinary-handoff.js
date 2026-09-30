const path = require('node:path');
const { PROVIDERS, READINESS, validateNativeId } = require('../state');
const { requireInstalled, readSecret } = require('../discord');
const { createHandoffFence, assertHandoffIntakeCoverage, deleteHandoffFence, serverDerivedChannelCutoff } = require('../discord/handoff-fence');
const { resolveInvocationIdentity, resolveExistingChannel } = require('../ordinary-codex');
const { sessionRoot: codexSessionRoot, validateCodexSessionIdentityAsync } = require('../native');
const { assertGatewayWakeCompatible } = require('../ordinary-bind/gateway-capability');
const { GATEWAY_CAPABILITIES } = require('../ordinary-bind/constants');

function createOrdinaryHandoff({ required, openState, requestGatewayRecovery, print, gatewayProcessStatus, acquireHeldLockUntilAvailable }) {
  return async function ordinaryHandoffInternal(args, dependencies = {}) {
    const environment = dependencies.environment || process.env;
    const install = dependencies.requireInstalled || requireInstalled;
    const read = dependencies.readSecret || readSecret;
    const validate = dependencies.validateCodexSessionIdentity || validateCodexSessionIdentityAsync;
    const wake = dependencies.requestGatewayRecovery || requestGatewayRecovery;
    const output = dependencies.print || print;
    const provider = required(args, 'provider');
    if (provider !== PROVIDERS.CODEX) throw new Error('ordinary handoff requires --provider codex');
    const fromNativeId = required(args, 'from-native-id');
    const nativeId = required(args, 'native-id');
    validateNativeId(fromNativeId);
    validateNativeId(nativeId);
    const fromGeneration = Number(required(args, 'from-generation'));
    if (!Number.isInteger(fromGeneration) || fromGeneration < 1) throw new Error('from-generation must be a positive integer');
    const workspace = path.resolve(required(args, 'workspace'));
    const channelId = required(args, 'channel-id');
    const handoffId = required(args, 'handoff-id');
    const requestedSessionRoot = args['session-root'] ? path.resolve(args['session-root']) : undefined;
    const { paths, state } = openState(args);
    const gatewayStatus = dependencies.gatewayProcessStatus || gatewayProcessStatus;
    let stopping = false;
    const handleSignal = () => { stopping = true; };
    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);
    let client;
    let runtimeInterlock;
    let handoffFence;
    let enrollmentProof = null;
    let sourceBinding = null;
    let handoffCommitted = false;
    try {
      const runtime = gatewayStatus(paths);
      const supportsBindLock = runtime?.state === 'running' && runtime.pid && runtime.capabilities?.includes(GATEWAY_CAPABILITIES.runtimeBindLock);
      const lockPath = supportsBindLock ? paths.bindLock : paths.lock;
      runtimeInterlock = await acquireHeldLockUntilAvailable(lockPath, () => stopping);
      if (stopping || !runtimeInterlock) throw new Error('ordinary handoff stopped while waiting for the runtime bind lock');
      const assertGatewayCompatible = () => {
        const snapshot = assertGatewayWakeCompatible(paths, gatewayStatus);
        if (supportsBindLock && (snapshot?.state !== 'running' || String(snapshot.pid) !== String(runtime.pid) ||
          !snapshot.capabilities?.includes(GATEWAY_CAPABILITIES.runtimeBindLock))) {
          throw new Error('running Gateway changed while handing off ordinary session');
        }
        return snapshot;
      };
      assertGatewayCompatible();
      const config = state.requireConfig();
      const current = state.getBinding(channelId);
      sourceBinding = current;
      if (!current || current.provider !== PROVIDERS.CODEX || current.conductorId || current.repoKey) {
        throw new Error('ordinary handoff source is unavailable');
      }
      const validationRoot = requestedSessionRoot || (current.sessionRoot ? path.resolve(current.sessionRoot) : (dependencies.codexSessionRoot || codexSessionRoot)());
      const invocation = resolveInvocationIdentity(environment, workspace);
      if (invocation.sessionId !== nativeId || invocation.threadId !== nativeId) {
        throw new Error('ordinary handoff successor identity does not match the native UUID');
      }
      const previousHandoff = state.findOrdinaryHandoff(handoffId);
      const handoffRetry = previousHandoff && previousHandoff.channelId === channelId &&
        previousHandoff.provider === provider && previousHandoff.fromNativeId === fromNativeId &&
        previousHandoff.fromGeneration === fromGeneration && previousHandoff.nativeId === nativeId &&
        previousHandoff.generation === current.generation && current.active &&
        current.nativeId === nativeId && current.generation === fromGeneration + 1 &&
        current.workspace === workspace && (current.sessionRoot || null) === (validationRoot || null);
      if (handoffRetry) {
        const binding = state.handoffOrdinary({
          channelId, provider, fromNativeId, fromGeneration, nativeId, workspace,
          sessionRoot: validationRoot, handoffId,
          identity: { sessionId: nativeId, threadId: nativeId },
          nativeProof: {
            file: previousHandoff.transcriptFile,
            sessionId: nativeId,
            threadId: nativeId,
            workspace,
            sessionRoot: validationRoot
          }
        });
        handoffCommitted = true;
        const gatewayWake = wake(paths, {
          status: dependencies.gatewayProcessStatus || gatewayProcessStatus,
          kill: dependencies.killProcess || process.kill
        });
        output({ handedOff: true, ordinary: true, channelId, handoffId,
          url: `https://discord.com/channels/${config.guildId}/${channelId}`, binding,
          readiness: binding.readiness, gatewayWake });
        return { binding, gatewayWake, handoffReconciled: Boolean(binding.handoffReconciled) };
      }
      const nativeProof = await validate(nativeId, workspace, validationRoot);
      const { Client, GatewayIntentBits } = install('discord.js');
      client = new Client({ intents: [GatewayIntentBits.Guilds] });
      await client.login(read(config.secretFile));
      const guild = await client.guilds.fetch(config.guildId);
      const channel = await guild.channels.fetch(channelId);
      const channelInfo = resolveExistingChannel(channelId, config.guildId, [{
        id: channel?.id || channelId,
        guildId: channel?.guildId || config.guildId,
        name: channel?.name || null,
        messageCapable: typeof channel?.isTextBased === 'function' && channel.isTextBased()
      }]);
      if (channelInfo.id !== current.channelId) throw new Error('handoff channel does not match the ordinary binding');
      let recoveredThrough = null;
      if (current.active) {
        state.recoverInterruptedOrdinaryHandoffIntake(channelId, current);
        const watermark = state.getIntakeWatermark(channelId);
        recoveredThrough = watermark?.recovered_through_id || null;
        if (!handoffRetry && (watermark?.state !== READINESS.READY || !recoveredThrough)) {
          throw new Error('ordinary handoff requires Discord intake to be durably drained');
        }
        if (!handoffRetry && typeof channel?.send !== 'function') {
          throw new Error('ordinary handoff requires Discord intake to be durably drained');
        }
      }
      let handoffCutoff = (current.active ? recoveredThrough : null) ||
        serverDerivedChannelCutoff(channel);
      if (current.active) {
        const paused = state.pauseOrdinaryHandoffIntake(channelId, current);
        if (!paused) throw new Error('ordinary handoff source binding changed while pausing intake');
      }
      handoffFence = await createHandoffFence(channel);
      if (handoffFence) {
        if (current.active) enrollmentProof = await assertHandoffIntakeCoverage(channel, client, state, current, handoffFence.id, 'ordinary handoff');
        handoffCutoff = handoffFence.id;
      }
      const binding = state.handoffOrdinary({
        channelId, provider, fromNativeId, fromGeneration, nativeId, workspace,
        sessionRoot: validationRoot, handoffId, intakeCutoff: handoffCutoff,
        enrollmentProof,
        identity: { sessionId: nativeProof.sessionId, threadId: nativeProof.threadId },
        nativeProof: { ...nativeProof, sessionRoot: validationRoot },
        beforeMutation: assertGatewayCompatible
      });
      handoffCommitted = true;
      const gatewayWake = wake(paths, {
        status: gatewayStatus,
        kill: dependencies.killProcess || process.kill,
        expectedPid: supportsBindLock ? runtime.pid : undefined
      });
      output({ handedOff: true, ordinary: true, channelId, handoffId,
        url: `https://discord.com/channels/${config.guildId}/${channelId}`, binding,
        readiness: binding.readiness, gatewayWake });
      return { binding, gatewayWake, handoffReconciled: Boolean(binding.handoffReconciled) };
    } finally {
      process.removeListener('SIGINT', handleSignal);
      process.removeListener('SIGTERM', handleSignal);
      if (!handoffCommitted && sourceBinding) {
        try {
          const restored = state.restoreOrdinaryHandoffIntake(channelId, sourceBinding);
          if (restored) {
            wake(paths, {
              status: dependencies.gatewayProcessStatus || gatewayProcessStatus,
              kill: dependencies.killProcess || process.kill
            });
          }
        } catch (error) {
          state.auditReceipt(null, 'ordinary-handoff-intake-restore-failed', {
            channelId, generation: sourceBinding.generation, error: error.message
          });
        }
      }
      await deleteHandoffFence(handoffFence);
      await runtimeInterlock?.release();
      await client?.destroy();
      state.close();
    }
  };
}

module.exports = { createOrdinaryHandoff };
