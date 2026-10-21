const path = require('node:path');
const { PROVIDERS, validateNativeId } = require('../state');
const { requireInstalled, readSecret } = require('../discord');
const { createOrdinaryClaudeRequest, resolveExistingChannel } = require('../ordinary-codex');
const { resolveCurrentClaudeCaller } = require('../ordinary-bind');
const { validateClaudeSessionIdentity } = require('../native');
const { assertGatewayWakeCompatible } = require('../ordinary-bind/gateway-capability');
const { GATEWAY_CAPABILITIES } = require('../ordinary-bind/constants');
const { completeCommandCleanup } = require('./command-cleanup');

function createOrdinaryClaudeHandoff({ required, openState, requestGatewayRecovery, print, gatewayProcessStatus, acquireHeldLockUntilAvailable }) {
  return async function ordinaryClaudeHandoffInternal(args, dependencies = {}) {
    if (required(args, 'provider') !== PROVIDERS.CLAUDE) throw new Error('ordinary Claude handoff requires --provider claude');
    const fromNativeId = required(args, 'from-native-id');
    const nativeId = required(args, 'native-id');
    validateNativeId(fromNativeId);
    validateNativeId(nativeId);
    const fromGeneration = Number(required(args, 'from-generation'));
    if (!Number.isInteger(fromGeneration) || fromGeneration < 1) throw new Error('from-generation must be a positive integer');
    const workspace = args.workspace === undefined ? undefined : required(args, 'workspace');
    const endpoint = required(args, 'endpoint');
    const transcript = required(args, 'transcript');
    const evidencePaths = [['endpoint', endpoint], ['transcript', transcript]];
    if (workspace !== undefined) evidencePaths.push(['workspace', workspace]);
    for (const [label, value] of evidencePaths) {
      if (!path.isAbsolute(value)) throw new Error(`Claude ${label} must be absolute`);
    }
    const resolvedEndpoint = path.resolve(endpoint);
    const channelId = required(args, 'channel-id');
    const handoffId = required(args, 'handoff-id');
    const { paths, state } = openState(args);
    const status = dependencies.gatewayProcessStatus || gatewayProcessStatus;
    const resolveCaller = dependencies.resolveClaudeCaller || resolveCurrentClaudeCaller;
    const validate = dependencies.validateClaudeSessionIdentity || validateClaudeSessionIdentity;
    const install = dependencies.requireInstalled || requireInstalled;
    const read = dependencies.readSecret || readSecret;
    const wake = dependencies.requestGatewayRecovery || requestGatewayRecovery;
    const output = dependencies.print || print;
    const acquire = dependencies.acquireHeldLockUntilAvailable || acquireHeldLockUntilAvailable;
    const signals = dependencies.signalSource || process;
    let stopping = false;
    let runtimeInterlock;
    let client;
    let hadBodyFailure = false;
    const handleSignal = () => { stopping = true; };
    const assertNotStopping = () => {
      if (stopping) throw new Error('ordinary Claude handoff was stopped');
    };
    signals.once('SIGINT', handleSignal);
    signals.once('SIGTERM', handleSignal);
    try {
      const runtime = assertGatewayWakeCompatible(paths, status);
      const running = runtime.state === 'running';
      const assertCapabilities = snapshot => {
        if (snapshot.state === 'running' && (!snapshot.pid ||
          !snapshot.capabilities?.includes(GATEWAY_CAPABILITIES.runtimeBindLock) ||
          !snapshot.capabilities?.includes(GATEWAY_CAPABILITIES.ordinaryClaudeBind) ||
          !snapshot.capabilities?.includes(GATEWAY_CAPABILITIES.ordinaryClaudeHandoff))) {
          throw new Error('running Gateway does not support ordinary Claude handoff');
        }
      };
      assertCapabilities(runtime);
      runtimeInterlock = await acquire(running ? paths.bindLock : paths.lock, () => stopping);
      assertNotStopping();
      if (!runtimeInterlock) throw new Error('ordinary Claude handoff stopped while waiting for the runtime bind lock');
      const assertGatewayCompatible = () => {
        assertNotStopping();
        const snapshot = assertGatewayWakeCompatible(paths, status);
        assertCapabilities(snapshot);
        if ((snapshot.state === 'running') !== running ||
          (running && String(snapshot.pid) !== String(runtime.pid))) {
          throw new Error('running Gateway changed while handing off ordinary Claude session');
        }
        return snapshot;
      };
      assertGatewayCompatible();
      const config = state.requireConfig();
      const current = state.getBinding(channelId);
      if (!current || current.provider !== PROVIDERS.CLAUDE || current.conductorId || current.repoKey ||
        !state.isOrdinaryBindingRecord(current)) {
        throw new Error('ordinary Claude handoff source is unavailable');
      }
      const caller = await resolveCaller();
      assertNotStopping();
      if (!caller || caller.harness !== 'claude-code' || caller.sessionId !== nativeId) {
        throw new Error('ordinary Claude handoff successor does not match the current Claude caller');
      }
      const proof = await validate(caller.sessionId, path.resolve(transcript), workspace);
      assertNotStopping();
      if (!proof || proof.sessionId !== nativeId || proof.threadId !== nativeId ||
        (workspace !== undefined && proof.workspace !== path.resolve(workspace)) || proof.file !== path.resolve(transcript)) {
        throw new Error('ordinary Claude handoff requires a matching successor transcript proof');
      }
      const request = createOrdinaryClaudeRequest({
        channelId, guildId: config.guildId, nativeId, workspace: proof.workspace,
        endpoint: resolvedEndpoint, identity: { sessionId: caller.sessionId, threadId: caller.sessionId, harness: 'claude-code' }
      });
      const previousHandoff = state.findOrdinaryHandoff(handoffId);
      if (!previousHandoff) {
        const { Client, GatewayIntentBits } = install('discord.js');
        client = new Client({ intents: [GatewayIntentBits.Guilds] });
        await client.login(read(config.secretFile));
        assertNotStopping();
        const guild = await client.guilds.fetch(config.guildId);
        assertNotStopping();
        const channel = await guild.channels.fetch(channelId);
        assertNotStopping();
        resolveExistingChannel(channelId, config.guildId, [{
          id: channel?.id, guildId: channel?.guildId,
          name: channel?.name || null,
          messageCapable: typeof channel?.isTextBased === 'function' && channel.isTextBased()
        }]);
      }
      assertGatewayCompatible();
      const binding = state.handoffOrdinary({
        channelId, provider: PROVIDERS.CLAUDE, fromNativeId, fromGeneration,
        nativeId: request.nativeId, workspace: request.workspace, endpoint: request.endpoint, handoffId,
        identity: request.identity,
        nativeProof: { ...proof, harness: 'claude-code', endpoint: request.endpoint },
        beforeMutation: assertGatewayCompatible
      });
      // A committed successor stays durable if the wake fails. Its exact handoff ID
      // can be retried without reverting the generation or advancing history.
      assertGatewayCompatible();
      const gatewayWake = wake(paths, {
        status, kill: dependencies.killProcess || process.kill,
        expectedPid: running ? runtime.pid : undefined
      });
      output({ handedOff: true, ordinary: true, channelId, handoffId,
        url: `https://discord.com/channels/${config.guildId}/${channelId}`, binding,
        readiness: binding.readiness, monitor: { status: 'pending' }, gatewayWake });
      return { binding, gatewayWake, monitor: { status: 'pending' }, handoffReconciled: Boolean(binding.handoffReconciled) };
    } catch (error) {
      hadBodyFailure = true;
      throw error;
    } finally {
      await completeCommandCleanup([
        () => signals.removeListener('SIGINT', handleSignal),
        () => signals.removeListener('SIGTERM', handleSignal),
        () => runtimeInterlock?.release(),
        () => client?.destroy(),
        () => state.close()
      ], hadBodyFailure);
    }
  };
}

module.exports = { createOrdinaryClaudeHandoff };
