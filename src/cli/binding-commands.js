const path = require('node:path');
const { BindingError, READINESS, RECOVERY_LIMITS } = require('../state');
const { readSecret, requireInstalled, waitForRecoveryOperation } = require('../discord');
const { enrollPublicThread } = require('../discord/thread-enrollment');
const { readAdoptionCutoff } = require('../discord/history-access');
const {
  assertOrdinaryIntakeRange,
  assertHandoffIntakeCoverage,
  createHandoffFence,
  deleteHandoffFence
} = require('../discord/handoff-fence');
const { resolveExistingChannel } = require('../ordinary-codex');
const { GATEWAY_CAPABILITIES } = require('../ordinary-bind/constants');
const { completeCommandCleanup } = require('./command-cleanup');

function createBindingCommands({ required, openState, print, requestGatewayRecovery, gatewayProcessStatus }) {
function bindingArgs(args) {
  return {
    channelId: required(args, 'channel-id'),
    guildId: required(args, 'guild-id'),
    provider: required(args, 'provider'),
    nativeId: required(args, 'native-id'),
    workspace: path.resolve(required(args, 'workspace')),
    endpoint: args.endpoint ? path.resolve(args.endpoint) : undefined,
    categoryId: args['category-id'],
    conductorId: required(args, 'conductor-id'),
    repoKey: required(args, 'repo-key')
  };
}

async function bind(args, rebind = false) {
  const { state } = openState(args);
  let client;
  let handoffFence;
  let enrollmentProof = null;
  let hadBodyFailure = false;
  try {
    const input = bindingArgs(args);
    if (!rebind && state.getBinding(input.channelId)) {
      throw new BindingError('channel is already bound; use rebind after work drains');
    }
    const hasActiveThreads = rebind && state.listThreadEnrollments(input.channelId).some(enrollment => enrollment.active);
    let intakeCutoff = null;
    if (hasActiveThreads) {
      const config = state.requireConfig();
      if (config.guildId !== input.guildId) throw new Error('rebind channel is outside the configured guild');
      const { Client, GatewayIntentBits } = requireInstalled('discord.js');
      client = new Client({ intents: [GatewayIntentBits.Guilds] });
      await client.login(readSecret(config.secretFile));
      const guild = await client.guilds.fetch(input.guildId);
      const channel = await guild.channels.fetch(input.channelId);
      handoffFence = await createHandoffFence(channel, 'parent rebind');
      const current = state.getBinding(input.channelId);
      if (current?.active) enrollmentProof = await assertHandoffIntakeCoverage(channel, client, state, current, handoffFence.id, 'parent rebind');
      intakeCutoff = handoffFence.id;
    } else if (!rebind) {
      // A genuinely new parent route acquires its boundary from a permission-qualified
      // history read before activation. The value is never inferred from the channel id,
      // channel creation time, wall clock, or a later retry.
      const config = state.requireConfig();
      if (config.guildId !== input.guildId) throw new Error('binding channel is outside the configured guild');
      const { Client, GatewayIntentBits } = requireInstalled('discord.js');
      client = new Client({ intents: [GatewayIntentBits.Guilds] });
      await client.login(readSecret(config.secretFile));
      const guild = await client.guilds.fetch(input.guildId);
      const channel = await guild.channels.fetch(input.channelId);
      intakeCutoff = await readAdoptionCutoff(channel, input.channelId, client.user);
    }
    print(rebind ? state.rebind(input, { intakeCutoff, enrollmentProof }) : state.bind(input, { intakeCutoff, intakeCutoffDetail: 'parent binding adoption cutoff' }));
  } catch (error) {
    hadBodyFailure = true;
    throw error;
  } finally {
    await completeCommandCleanup([
      () => deleteHandoffFence(handoffFence),
      () => client?.destroy(),
      () => state.close()
    ], hadBodyFailure);
  }
}

async function threadEnroll(args, dependencies = {}) {
  const { paths, state } = openState(args);
  const install = dependencies.requireInstalled || requireInstalled;
  const controller = new AbortController();
  const stop = () => controller.abort();
  let client;
  let hadBodyFailure = false;
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const parentId = required(args, 'channel-id');
    const threadId = required(args, 'thread-id');
    const config = state.requireConfig();
    if (state.getBinding(parentId)?.guildId !== config.guildId) throw new Error('Thread parent is outside the configured guild');
    const { Client, GatewayIntentBits } = install('discord.js');
    client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { timeout: RECOVERY_LIMITS.timeoutMs } });
    const deadline = Date.now() + RECOVERY_LIMITS.timeoutMs;
    await waitForRecoveryOperation(() => client.login((dependencies.readSecret || readSecret)(config.secretFile)), controller.signal, deadline, stop);
    const enrollment = await waitForRecoveryOperation(() => enrollPublicThread(state, client, parentId, threadId, controller.signal), controller.signal, deadline, stop);
    const requestRecovery = dependencies.requestGatewayRecovery || requestGatewayRecovery;
    const gatewayWake = requestRecovery(paths, {
      requiredCapability: GATEWAY_CAPABILITIES.threadEnrollmentRecoveryWake
    });
    const result = { enrollment, gatewayWake };
    (dependencies.print || print)(result);
    return result;
  } catch (error) {
    hadBodyFailure = true;
    throw error;
  } finally {
    await completeCommandCleanup([
      () => controller.abort(),
      () => process.off('SIGINT', stop),
      () => process.off('SIGTERM', stop),
      () => client?.destroy(),
      () => state.close()
    ], hadBodyFailure);
  }
}

async function unbind(args, dependencies = {}) {
  const channelId = required(args, 'channel-id');
  const { paths, state } = openState(args);
  const install = dependencies.requireInstalled || requireInstalled;
  const read = dependencies.readSecret || readSecret;
  const wake = dependencies.requestGatewayRecovery || requestGatewayRecovery;
  const output = dependencies.print || print;
  let client;
  let fence;
  let intakePaused = false;
  let binding = null;
  let hadBodyFailure = false;
  try {
    binding = state.getBinding(channelId);
    if (!binding || !binding.active || !state.isOrdinaryBindingRecord(binding)) {
      const result = state.unbind(channelId, { expectedBinding: binding || undefined });
      output({ unbound: result });
      return { unbound: result };
    }
    const config = state.requireConfig();
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
    if (channelInfo.id !== binding.channelId) throw new Error('unbind channel does not match the ordinary binding');
    const watermark = state.getIntakeWatermark(channelId);
    const recoveredThrough = watermark?.recovered_through_id || null;
    if (watermark?.state !== READINESS.READY || !recoveredThrough) {
      throw new Error('ordinary unbind requires Discord intake to be durably drained');
    }
    const paused = state.pauseOrdinaryHandoffIntake(channelId, binding);
    if (!paused) throw new Error('ordinary unbind source binding changed while pausing intake');
    intakePaused = true;
    fence = await createHandoffFence(channel, 'ordinary unbind');
    await assertOrdinaryIntakeRange(channel, state, binding, recoveredThrough, fence.id, 'ordinary unbind');
    const result = state.unbind(channelId, { expectedBinding: binding, intakeCutoff: fence.id });
    if (!result) throw new Error('ordinary binding changed before intake fence was committed');
    intakePaused = false;
    output({ unbound: result });
    return { unbound: result };
  } catch (error) {
    hadBodyFailure = true;
    throw error;
  } finally {
    await completeCommandCleanup([
      () => {
        if (!intakePaused) return;
        try {
          const restored = state.restoreOrdinaryHandoffIntake(channelId, binding);
          if (restored) {
            wake(paths, {
              status: dependencies.gatewayProcessStatus || gatewayProcessStatus,
              kill: dependencies.killProcess || process.kill
            });
          }
        } catch (error) {
          state.auditReceipt(null, 'ordinary-unbind-intake-restore-failed', {
            channelId, generation: binding?.generation, error: error.message
          });
        }
      },
      () => deleteHandoffFence(fence),
      () => client?.destroy(),
      () => state.close()
    ], hadBodyFailure);
  }
}

return { bindingArgs, bind, threadEnroll, unbind };
}

module.exports = { createBindingCommands };
