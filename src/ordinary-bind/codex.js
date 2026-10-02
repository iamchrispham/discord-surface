const path = require('node:path');
const { READINESS } = require('../state');
const { requireInstalled, readSecret } = require('../discord');
const { createHandoffFence, deleteHandoffFence } = require('../discord/handoff-fence');
const { readAdoptionCutoff } = require('../discord/history-access');
const {
  createOrdinaryCodexRequestFromEnvironment,
  ordinaryBindingDecision,
  ORDINARY_BINDING_DECISIONS,
  resolveExistingChannel,
  resolveInvocationIdentity
} = require('../ordinary-codex');
const { CODEX_VALIDATION_KINDS, sessionRoot: codexSessionRoot, validateCodexSessionIdentityAsync } = require('../native');
const { assertGatewayWakeCompatible } = require('./gateway-capability');
const { GATEWAY_CAPABILITIES } = require('./constants');
const { reconcileProofUnavailableIntake } = require('./proof-recovery');
const { completeCommandCleanup } = require('../cli/command-cleanup');

const ORDINARY_NATIVE_PROOF_UNAVAILABLE_PREFIX = 'Codex transcript proof unavailable before event write:';
const ORDINARY_CODEX_RUNTIME_PID_ENV = 'DISCORD_SURFACE_ORDINARY_CODEX_RUNTIME_PID';
const NATIVE_PROOF_STATUSES = Object.freeze({
  PENDING: 'pending',
  VERIFIED: 'verified'
});

function required(args, key) {
  if (!args[key] || typeof args[key] !== 'string') throw new Error(`missing --${key}`);
  return args[key];
}

function openState(args) {
  return require('../cli').openState(args);
}

function gatewayProcessStatus(paths) {
  return require('../cli').gatewayProcessStatus(paths);
}

function requestGatewayRecovery(paths, options) {
  return require('../cli').requestGatewayRecovery(paths, options);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function ordinaryBindingArgs(args, environment = process.env, channelId = null, guildId = null, workspace = undefined, sessionRoot = undefined) {
  return createOrdinaryCodexRequestFromEnvironment({
    channelId: channelId || required(args, 'channel-id'),
    guildId: guildId || required(args, 'guild-id'),
    nativeId: args['native-id'],
    workspace: workspace ?? (args.workspace ? path.resolve(args.workspace) : undefined),
    sessionRoot,
    environment
  });
}

function bindingIdentityMatches(binding, expected) {
  return Boolean(binding) && Boolean(expected) && binding.active === expected.active &&
    binding.channelId === expected.channelId && binding.guildId === expected.guildId &&
    binding.provider === expected.provider && binding.nativeId === expected.nativeId &&
    binding.generation === expected.generation &&
    (binding.sessionRoot || null) === (expected.sessionRoot || null) &&
    binding.conductorId === expected.conductorId && binding.repoKey === expected.repoKey;
}

async function ordinaryBind(args, dependencies = {}) {
  const { paths, state } = openState(args);
  const environment = dependencies.environment || process.env;
  const install = dependencies.requireInstalled || requireInstalled;
  const read = dependencies.readSecret || readSecret;
  const validate = dependencies.validateCodexSessionIdentity || validateCodexSessionIdentityAsync;
  const output = dependencies.print || print;
  let client;
  let adoptionFence;
  let hadBodyFailure = false;
  try {
    const config = state.requireConfig();
    const channelSelection = args.channel || args['channel-id'];
    if (!channelSelection || typeof channelSelection !== 'string') throw new Error('missing --channel or --channel-id');
    const invocation = resolveInvocationIdentity(environment, args.workspace ? path.resolve(args.workspace) : undefined);
    const sessionRoot = args['session-root'] ? path.resolve(args['session-root']) : undefined;
    let nativeProofDetail = null;
    let nativeProofError = null;
    let resolvedWorkspace = invocation.workspace;
    const validateNativeProof = async root => {
      let detail = null;
      let error = null;
      try {
        detail = await validate(invocation.sessionId, undefined, root);
        if (!detail || typeof detail.workspace !== 'string' || !path.isAbsolute(detail.workspace)) {
          throw new Error('Codex transcript workspace is unavailable');
        }
      } catch (caught) {
        if (caught?.recoveryKind === CODEX_VALIDATION_KINDS.UNSUPPORTED_ROOT) throw caught;
        error = caught;
        if (!invocation.workspace) throw new Error(`Codex transcript workspace is required: ${caught.message}`);
      }
      if (detail && invocation.workspace && path.resolve(detail.workspace) !== invocation.workspace) {
        throw new Error('Codex transcript workspace does not match the supplied workspace');
      }
      return { detail, error, workspace: detail?.workspace || invocation.workspace };
    };
    if (sessionRoot) {
      const proof = await validateNativeProof(sessionRoot);
      nativeProofDetail = proof.detail;
      nativeProofError = proof.error;
      resolvedWorkspace = proof.workspace;
    }
    const { Client, GatewayIntentBits } = install('discord.js');
    client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(read(config.secretFile));
    const guild = await client.guilds.fetch(config.guildId);
    const mentionId = channelSelection.match(/^<#([^>]+)>$/)?.[1] || (/^\d+$/.test(channelSelection) ? channelSelection : null);
    let fetchedChannels;
    let fetchedChannelObjects;
    if (mentionId) {
      const channel = await guild.channels.fetch(mentionId);
      fetchedChannelObjects = channel ? [channel] : [];
      fetchedChannels = channel ? [{ id: channel.id, guildId: channel.guildId || '', name: channel.name || null,
        messageCapable: typeof channel.isTextBased === 'function' && channel.isTextBased() }] : [];
    } else {
      const fetched = await guild.channels.fetch();
      const values = Array.isArray(fetched) ? fetched : typeof fetched?.values === 'function' ? [...fetched.values()] : [];
      fetchedChannelObjects = values;
      fetchedChannels = values.map(channel => ({ id: channel.id, guildId: channel.guildId || '', name: channel.name || null,
        messageCapable: typeof channel.isTextBased === 'function' && channel.isTextBased() }));
    }
    const channel = resolveExistingChannel(channelSelection, config.guildId, fetchedChannels);
    if (args.channel && args['channel-id']) {
      const namedChannel = resolveExistingChannel(args.channel, config.guildId, fetchedChannels);
      const idChannel = resolveExistingChannel(args['channel-id'], config.guildId, fetchedChannels);
      if (namedChannel.id !== idChannel.id) throw new Error('--channel and --channel-id must identify the same channel');
    }
    const discordChannel = fetchedChannelObjects.find(candidate => candidate?.id === channel.id);
    const existing = state.getBinding(channel.id);
    if (existing && state.isOrdinaryBindingRecord(existing) && invocation.sessionId !== existing.nativeId) {
      throw new Error('channel is already bound to another owner; use explicit handoff');
    }
    let validationRoot = sessionRoot ?? existing?.sessionRoot ?? (dependencies.codexSessionRoot || codexSessionRoot)(environment);
    if (!sessionRoot) {
      const proof = await validateNativeProof(validationRoot);
      nativeProofDetail = proof.detail;
      nativeProofError = proof.error;
      resolvedWorkspace = proof.workspace;
    }
    const request = ordinaryBindingArgs(args, environment, channel.id, config.guildId, resolvedWorkspace, validationRoot);
    if (request.guildId !== config.guildId) throw new Error('ordinary binding guild is not the configured guild');
    const gatewayStatus = dependencies.gatewayProcessStatus || gatewayProcessStatus;
    const expectedRuntimePid = environment[ORDINARY_CODEX_RUNTIME_PID_ENV];
    const assertGatewayCompatible = runtime => {
      const snapshot = assertGatewayWakeCompatible(paths, gatewayStatus, runtime);
      if (expectedRuntimePid !== undefined &&
        (snapshot?.state !== 'running' || String(snapshot.pid) !== expectedRuntimePid ||
          !snapshot.capabilities?.includes(GATEWAY_CAPABILITIES.runtimeBindLock))) {
        throw new Error('running Gateway changed while binding ordinary Codex session');
      }
      return snapshot;
    };
    assertGatewayCompatible();
    const nativeProofEvidence = nativeProofDetail ? { ...nativeProofDetail, sessionRoot: validationRoot } : null;
    let decision = ordinaryBindingDecision(existing, request, existing ? state.isOrdinaryBindingRecord(existing) : false, nativeProofEvidence);
    let adoptionCutoff = null;
    if (decision !== ORDINARY_BINDING_DECISIONS.REUSE && !existing?.active) {
      if (typeof discordChannel?.send === 'function') {
        // The server fence message is real evidence (case 11's accepted producer).
        adoptionFence = await createHandoffFence(discordChannel, 'ordinary binding adoption');
        adoptionCutoff = adoptionFence.id;
      } else {
        // No fence channel available: acquire the boundary from a permission-qualified
        // history read. A channel-id-derived value is never a coverage producer.
        adoptionCutoff = await readAdoptionCutoff(discordChannel, channel.id, client.user);
      }
    }
    let binding;
    if (decision === ORDINARY_BINDING_DECISIONS.REUSE) binding = existing;
    else if (decision === ORDINARY_BINDING_DECISIONS.REBIND) {
      try {
        binding = state.rebindOrdinary(request, request.identity, nativeProofEvidence, adoptionCutoff, {
          beforeMutation: assertGatewayCompatible
        });
      } catch (error) {
        const raced = state.getBinding(request.channelId);
        const racedDecision = raced
          ? ordinaryBindingDecision(raced, request, state.isOrdinaryBindingRecord(raced), nativeProofEvidence)
          : null;
        if (racedDecision !== ORDINARY_BINDING_DECISIONS.REUSE) throw error;
        decision = ORDINARY_BINDING_DECISIONS.REUSE;
        binding = raced;
      }
    }
    else {
      try {
        binding = state.bindOrdinary(request, request.identity, adoptionCutoff, {
          beforeMutation: assertGatewayCompatible
        });
      } catch (error) {
        const raced = state.getBinding(request.channelId);
        const racedDecision = raced
          ? ordinaryBindingDecision(raced, request, state.isOrdinaryBindingRecord(raced), nativeProofEvidence)
          : null;
        if (racedDecision !== ORDINARY_BINDING_DECISIONS.REUSE) throw error;
        decision = ORDINARY_BINDING_DECISIONS.REUSE;
        binding = raced;
      }
    }
    let nativeProof = { status: NATIVE_PROOF_STATUSES.PENDING, reason: 'Codex transcript proof is pending' };
    if (nativeProofError) {
      const detail = `${ORDINARY_NATIVE_PROOF_UNAVAILABLE_PREFIX} ${nativeProofError.message}`;
      const unavailable = state.setBindingReadiness(binding.channelId, READINESS.UNAVAILABLE, detail, binding);
      if (unavailable) binding = unavailable;
      nativeProof = { status: NATIVE_PROOF_STATUSES.PENDING, reason: nativeProofError.message };
    } else if (state.hasOrdinaryPreflight(binding)) {
      const verifiedBinding = state.transaction(() => {
        const current = state.getBinding(binding.channelId);
        if (!bindingIdentityMatches(current, binding) || !state.hasOrdinaryPreflight(current)) return null;
        return current;
      });
      if (!verifiedBinding) throw new Error('ordinary binding changed before native preflight proof was reused');
      binding = verifiedBinding;
      nativeProof = { status: NATIVE_PROOF_STATUSES.VERIFIED, reason: 'Codex transcript proof already recorded' };
    } else if (nativeProofDetail) {
      let recordedBinding;
      let preflightError;
      try {
        recordedBinding = state.recordOrdinaryPreflight(binding, {
          file: nativeProofDetail.file,
          sessionId: nativeProofDetail.sessionId,
          threadId: nativeProofDetail.threadId,
          workspace: nativeProofDetail.workspace
        });
      } catch (error) {
        preflightError = error;
      }
      if (preflightError) {
        nativeProof = { status: NATIVE_PROOF_STATUSES.PENDING, reason: preflightError.message };
      } else if (!recordedBinding) {
        throw new Error('ordinary binding changed before native proof was recorded');
      } else {
        binding = recordedBinding;
        nativeProof = { status: NATIVE_PROOF_STATUSES.VERIFIED, file: nativeProofDetail.file, workspace: nativeProofDetail.workspace };
      }
    } else {
      nativeProof = { status: NATIVE_PROOF_STATUSES.PENDING, reason: nativeProofError?.message || 'Codex transcript proof is pending' };
    }
    binding = reconcileProofUnavailableIntake(state, binding, {
      reused: decision === ORDINARY_BINDING_DECISIONS.REUSE,
      nativeProofVerified: nativeProof.status === NATIVE_PROOF_STATUSES.VERIFIED,
      nativeProofDetail,
      nativeProofError
    });
    const gatewayWake = requestGatewayRecovery(paths, {
      status: gatewayStatus,
      kill: dependencies.killProcess || process.kill,
      expectedPid: expectedRuntimePid
    });
    const resultBinding = state.transaction(() => {
      const current = state.getBinding(binding.channelId);
      return bindingIdentityMatches(current, binding) ? current : null;
    });
    if (!resultBinding) throw new Error('ordinary binding changed before bind result was returned');
    output({ bound: true, reused: decision === ORDINARY_BINDING_DECISIONS.REUSE, binding: resultBinding, nativeProof, gatewayWake });
    return { binding: resultBinding, nativeProof, gatewayWake, reused: decision === ORDINARY_BINDING_DECISIONS.REUSE };
  } catch (error) {
    hadBodyFailure = true;
    throw error;
  } finally {
    await completeCommandCleanup([
      () => deleteHandoffFence(adoptionFence),
      () => client?.destroy(),
      () => state.close()
    ], hadBodyFailure);
  }
}

module.exports = { ordinaryBind, ordinaryBindingArgs, NATIVE_PROOF_STATUSES, ORDINARY_CODEX_RUNTIME_PID_ENV };
