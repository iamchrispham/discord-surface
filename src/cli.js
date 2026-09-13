#!/usr/bin/env node
const { issueAgentAddress, verifyAgentAddress } = require('./agent-message');

const fs = require('node:fs');
const { resolveDedupeKey, resolveDirectBinding, runDirectPost } = require('./direct-post');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { SurfaceState, PROVIDERS, READINESS, RECOVERY_LIMITS, validateNativeId } = require('./state');
const { DiscordGateway, discordIdAfter, readSecret, requireInstalled } = require('./discord');
const {
  assertOrdinaryIntakeRange,
  createHandoffFence,
  deleteHandoffFence,
  serverDerivedChannelCutoff
} = require('./discord/handoff-fence');
const {
  createOrdinaryClaudeRequest,
  createOrdinaryCodexRequestFromEnvironment,
  ordinaryBindingDecision,
  ORDINARY_BINDING_DECISIONS,
  resolveExistingChannel,
  resolveInvocationIdentity
} = require('./ordinary-codex');
const { CODEX_VALIDATION_KINDS, sessionRoot: codexSessionRoot, validateClaudeSessionIdentity, validateCodexSessionIdentity, validateCodexSessionIdentityAsync } = require('./native');
const { ClaudeChannel } = require('./claude-channel');
const { createClaudeMonitor } = require('./claude-monitor');
const { ordinaryBind: runOrdinaryBind, ordinaryClaudeBind: runOrdinaryClaudeBind } = require('./ordinary-bind');
const { assertGatewayWakeCompatible } = require('./ordinary-bind/gateway-capability');
const { GATEWAY_CAPABILITIES } = require('./ordinary-bind/constants');
const { CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX } = require('./ordinary/constants');

const ORDINARY_CLAUDE_RUNTIME_PID_ENV = 'DISCORD_SURFACE_ORDINARY_CLAUDE_RUNTIME_PID';
const ORDINARY_CODEX_RUNTIME_PID_ENV = 'DISCORD_SURFACE_ORDINARY_CODEX_RUNTIME_PID';
const LOCK_CONTENTION_EXIT = 75;
const ORDINARY_NATIVE_PROOF_UNAVAILABLE_PREFIX = 'Codex transcript proof unavailable before event write:';
const NATIVE_PROOF_STATUSES = Object.freeze({
  PENDING: 'pending',
  VERIFIED: 'verified'
});
const { runLiaisonDraft } = require('./liaison');
const { recordNativeAcknowledgment } = require('./acknowledgment');
const { conductorMarkerMatches: matchesTopicMarker, parseLegacyConductorMarker, staticConductorMarker, topicPresentation } = require('./topic');

function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const [key, inline] = value.slice(2).split('=', 2);
    if (inline !== undefined) args[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
    else args[key] = true;
  }
  return { command: positional[0], subcommand: positional[1], args };
}

function pathsFor(args) {
  const stateDir = path.resolve(args['state-dir'] || process.env.DISCORD_SURFACE_DIR || path.join(os.homedir(), '.config', 'discord-surface'));
  const db = path.resolve(args.db || path.join(stateDir, 'surface.sqlite'));
  return {
    stateDir,
    db,
    lock: path.join(stateDir, 'runtime.lock'),
    // The Gateway keeps runtime.lock for its lifetime, so this interlock is released after startup.
    bindLock: path.join(stateDir, 'runtime-bind.lock'),
    provisionLock: path.join(stateDir, 'provision.lock'),
    pid: path.join(stateDir, 'runtime.pid')
  };
}

function required(args, key) {
  if (!args[key] || typeof args[key] !== 'string') throw new Error(`missing --${key}`);
  return args[key];
}

function openState(args) {
  const paths = pathsFor(args);
  return { paths, state: new SurfaceState(paths.db) };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function configure(args) {
  const { state } = openState(args);
  try {
    const secretFile = path.resolve(required(args, 'secret-file'));
    print(state.setConfig({
      operatorId: required(args, 'operator-id'),
      guildId: required(args, 'guild-id'),
      secretFile,
      codexCategoryId: args['codex-category-id'],
      claudeCategoryId: args['claude-category-id']
    }));
  } finally { state.close(); }
}

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

function bind(args, rebind = false) {
  const { state } = openState(args);
  try { print(rebind ? state.rebind(bindingArgs(args)) : state.bind(bindingArgs(args))); }
  finally { state.close(); }
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

async function latestChannelMessageId(channel) {
  const cached = typeof channel?.lastMessageId === 'string' && channel.lastMessageId.length > 0 ? channel.lastMessageId : null;
  if (typeof channel?.messages?.fetch !== 'function') return cached;
  const fetched = await channel.messages.fetch({ limit: 1 });
  let message = null;
  if (Array.isArray(fetched)) message = fetched[0];
  else if (typeof fetched?.first === 'function') message = fetched.first();
  else if (typeof fetched?.values === 'function') message = fetched.values().next().value;
  return typeof message?.id === 'string' && message.id.length > 0 ? message.id : cached;
}

function requestGatewayRecovery(paths, { status = gatewayProcessStatus, kill = process.kill, expectedPid } = {}) {
  const runtime = status(paths);
  if (runtime?.state !== 'running' || !runtime.pid) {
    return { requested: false, state: runtime?.state || 'unknown', reason: 'gateway-not-running' };
  }
  if (expectedPid !== undefined && String(runtime.pid) !== String(expectedPid)) {
    return { requested: false, pid: runtime.pid, state: runtime.state, reason: 'gateway-changed' };
  }
  if (!runtime.capabilities?.includes(GATEWAY_CAPABILITIES.ordinaryBindWake)) {
    return {
      requested: false,
      pid: runtime.pid,
      state: runtime.state,
      reason: 'gateway-wake-unsupported',
      capability: GATEWAY_CAPABILITIES.ordinaryBindWake
    };
  }
  try {
    kill(runtime.pid, 'SIGUSR2');
    return { requested: true, pid: runtime.pid, signal: 'SIGUSR2' };
  } catch (error) {
    return { requested: false, pid: runtime.pid, state: runtime.state, reason: 'gateway-wake-failed', error: error.message };
  }
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
    let validationRoot = sessionRoot ?? existing?.sessionRoot ?? (dependencies.codexSessionRoot || codexSessionRoot)();
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
        adoptionFence = await createHandoffFence(discordChannel, 'ordinary binding adoption');
        adoptionCutoff = adoptionFence.id;
      } else {
        const cutoff = await latestChannelMessageId(discordChannel);
        adoptionCutoff = cutoff || serverDerivedChannelCutoff(discordChannel);
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
    if (decision === ORDINARY_BINDING_DECISIONS.REUSE && nativeProof.status === NATIVE_PROOF_STATUSES.VERIFIED && nativeProofDetail && !nativeProofError) {
      const watermark = state.getIntakeWatermark(binding.channelId);
      const nativeProofUnavailable = watermark && watermark.state === READINESS.UNAVAILABLE &&
        typeof watermark.detail === 'string' && watermark.detail.startsWith(ORDINARY_NATIVE_PROOF_UNAVAILABLE_PREFIX);
      if (nativeProofUnavailable) {
        const reopened = state.reconcileIntake(binding.channelId, binding);
        if (reopened) binding = state.getBinding(binding.channelId);
      }
    }
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
  } finally {
    await deleteHandoffFence(adoptionFence);
    try { await client?.destroy(); } finally { state.close(); }
  }
}

function runLockedOrdinaryCommand(args, { command, environmentKey, lockPath, environment = {} }) {
  const paths = pathsFor(args);
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const forwarded = Object.entries(args).flatMap(([key, value]) => value === true ? [`--${key}`] : [`--${key}`, String(value)]);
  const result = spawnSync('lockf', ['-t', '0', '-k', lockPath, process.execPath, __filename, command, ...forwarded], {
    stdio: 'inherit',
    env: { ...process.env, ...environment, [environmentKey]: '1' }
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

function ordinaryBindCommand(args) {
  const paths = pathsFor(args);
  const runtime = gatewayProcessStatus(paths);
  const supportsBindLock = runtime?.state === 'running' && runtime.pid && runtime.capabilities?.includes(GATEWAY_CAPABILITIES.runtimeBindLock);
  const lockPath = supportsBindLock ? paths.bindLock : paths.lock;
  runLockedOrdinaryCommand(args, {
    command: 'ordinary-bind-run',
    environmentKey: 'DISCORD_SURFACE_ORDINARY_BIND_LOCK_HELD',
    lockPath,
    environment: supportsBindLock ? { [ORDINARY_CODEX_RUNTIME_PID_ENV]: String(runtime.pid) } : {}
  });
}

function ordinaryClaudeBindCommand(args) {
  const paths = pathsFor(args);
  const runtime = gatewayProcessStatus(paths);
  const supportsBindLock = runtime?.state === 'running' && runtime.pid &&
    runtime.capabilities?.includes(GATEWAY_CAPABILITIES.runtimeBindLock) &&
    runtime.capabilities?.includes(GATEWAY_CAPABILITIES.ordinaryClaudeBind);
  const lockPath = supportsBindLock ? paths.bindLock : paths.lock;
  runLockedOrdinaryCommand(args, {
    command: 'ordinary-claude-bind-run',
    environmentKey: 'DISCORD_SURFACE_ORDINARY_CLAUDE_BIND_LOCK_HELD',
    lockPath,
    environment: supportsBindLock ? { [ORDINARY_CLAUDE_RUNTIME_PID_ENV]: String(runtime.pid) } : {}
  });
}

async function resolveCurrentClaudeCaller(dependencies = {}) {
  if (typeof dependencies.resolveClaudeCaller === 'function') return dependencies.resolveClaudeCaller();
  const resolverPath = path.join(os.homedir(), '.claude', 'hooks', 'session-chat-binding.mjs');
  let resolver;
  try {
    resolver = await import(pathToFileURL(resolverPath).href);
  } catch (error) {
    throw new Error(`Claude caller resolver is unavailable: ${error.message}`);
  }
  if (typeof resolver.resolveCurrentCallerSessionChatBinding !== 'function') {
    throw new Error('Claude caller resolver does not expose resolveCurrentCallerSessionChatBinding');
  }
  return resolver.resolveCurrentCallerSessionChatBinding();
}

async function ordinaryClaudeBind(args, dependencies = {}) {
  return runOrdinaryClaudeBind(args, dependencies);
}

async function unbind(args, dependencies = {}) {
  const { paths, state } = openState(args);
  const channelId = required(args, 'channel-id');
  const install = dependencies.requireInstalled || requireInstalled;
  const read = dependencies.readSecret || readSecret;
  const wake = dependencies.requestGatewayRecovery || requestGatewayRecovery;
  const output = dependencies.print || print;
  let client;
  let fence;
  let intakePaused = false;
  let binding = null;
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
  } finally {
    if (intakePaused) {
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
    }
    await deleteHandoffFence(fence);
    try { await client?.destroy(); } finally { state.close(); }
  }
}

function status(args) {
  const { state } = openState(args);
  try { print({ config: state.getConfig(), gateway: gatewayProcessStatus(pathsFor(args)), readiness: state.getReadiness(), bindings: state.listBindings(), messages: state.listMessages(), receipts: state.listReceipts() }); }
  finally { state.close(); }
}

async function liaisonDraft(args) {
  const { state } = openState(args);
  const controller = new AbortController();
  let receivedSignal = null;
  const abort = signal => {
    if (receivedSignal) return;
    receivedSignal = signal;
    controller.abort();
  };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const result = await runLiaisonDraft({ state, receiptId: required(args, 'receipt-id'), signal: controller.signal });
    print(result);
    if (receivedSignal) process.exitCode = 128 + (os.constants.signals?.[receivedSignal] || 1);
    return result;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    state.close();
  }
}

function recover(args) {
  const { state } = openState(args);
  try {
    if (args['topic-channel-id']) {
      const resolution = required(args, 'resolution');
      if (!['published', 'not_published'].includes(resolution)) throw new Error('--resolution must be published or not_published for topic reconciliation');
      print(state.reconcileTopicPublication(
        required(args, 'topic-channel-id'),
        required(args, 'topic-request-id'),
        resolution,
        required(args, 'evidence-scope'),
        { topic: required(args, 'topic-readback'), observedAt: required(args, 'topic-readback-at') }
      ));
    } else if (args['intake-channel-id']) {
      print(state.reconcileIntake(required(args, 'intake-channel-id')));
    } else if (args['message-id'] && ['reply_sent', 'reply_not_sent'].includes(args.resolution)) {
      print(state.reconcileReplyDelivery(required(args, 'message-id'), args.resolution === 'reply_sent' ? 'sent' : 'not_sent', {
        partIndex: args['part-index'] === undefined ? null : Number(args['part-index']),
        replyMessageId: args['reply-message-id']
      }));
    } else if (args['direct-post-request-id']) {
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
    } else if (args['message-id'] && args.resolution) print(state.reconcileUncertain(required(args, 'message-id'), args.resolution));
    else print(state.recoverAfterRestart());
  }
  finally { state.close(); }
}

function provisionMarker(provider, nativeId) {
  return `discord-surface:v1 provider=${provider} native=${nativeId}`;
}

function conductorMarker({ provider, nativeId, conductorId, repoKey, generation = 1, readiness = READINESS.PENDING }) {
  if (!conductorId || !repoKey) return provisionMarker(provider, nativeId);
  return staticConductorMarker({ provider, conductorId, repoKey });
}

function legacyAdoptionTopic(topic, provider, nativeId) {
  const base = topicPresentation(topic).base;
  return base === provisionMarker(provider, nativeId) || base === `Conductor task: ${provider}/${nativeId}`;
}

function conductorMarkerMatches(topic, expected) {
  return matchesTopicMarker(topic, expected);
}

function migrationRequested(args) {
  return args['migrate-legacy-topic'] === true || args['migrate-legacy-topic'] === 'true';
}

function validateLegacyMetadata(topic, expected) {
  const parsed = parseLegacyConductorMarker(topic);
  if (parsed) {
    const matches = conductorMarkerMatches(topic, {
      provider: expected.provider,
      nativeId: expected.nativeId,
      conductorId: expected.conductorId,
      repoKey: expected.repoKey,
      generation: parsed.generation
    });
    if (!matches || (expected.generation != null && parsed.generation !== expected.generation)) {
      throw new Error('legacy channel topic does not match the requested provider, conductor, repository, native UUID, or generation');
    }
    return parsed;
  }
  if (legacyAdoptionTopic(topic, expected.provider, expected.nativeId)) {
    return { version: 'v1', provider: expected.provider, nativeId: expected.nativeId, conductorId: expected.conductorId, repoKey: expected.repoKey, generation: null };
  }
  throw new Error('channel topic is not a recognized legacy marker');
}

function legacyMarkerMatches(topic, expected) {
  const parsed = parseLegacyConductorMarker(topic);
  if (parsed) {
    return conductorMarkerMatches(topic, {
      provider: expected.provider,
      nativeId: expected.nativeId,
      conductorId: expected.conductorId,
      repoKey: expected.repoKey,
      generation: parsed.generation
    });
  }
  return legacyAdoptionTopic(topic, expected.provider, expected.nativeId);
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {}
}

function topicPatchOutcome(error) {
  if (error?.status === 429 || error?.code === 429) return 'rate_limited';
  if ([400, 401, 403, 404].includes(error?.status) || error?.code === 50013) return 'rejected';
  return 'unknown';
}

async function patchDiscordTopic({ token, channelId, topic, signal }) {
  if (typeof globalThis.fetch !== 'function') throw new Error('Discord topic migration fetch is unavailable');
  const response = await globalThis.fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${token}`,
      'User-Agent': 'DiscordBot (discord-surface, 0.1.0)',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ topic }),
    signal
  });
  if (!response.ok) {
    await cancelResponseBody(response);
    const error = new Error('Discord legacy topic migration was rejected');
    error.status = response.status;
    throw error;
  }
  try { return await response.json(); }
  catch (error) {
    await cancelResponseBody(response);
    throw error;
  }
}

async function migrateLegacyTopic({ state, channel, binding, token, request = patchDiscordTopic, timeoutMs = RECOVERY_LIMITS.timeoutMs }) {
  const desiredTopic = staticConductorMarker({ provider: binding.provider, conductorId: binding.conductorId, repoKey: binding.repoKey });
  if (channel.topic === desiredTopic) return { migrated: false, topic: desiredTopic, binding };
  const custody = state.beginTopicPublication(channel.id, {
    desiredReadiness: binding.readiness,
    desiredTopic
  }, binding);
  if (!custody) throw new Error('legacy topic migration binding changed before custody started');
  const controller = new AbortController();
  const boundedMs = Math.max(1, Number(timeoutMs || RECOVERY_LIMITS.timeoutMs));
  let timer;
  let settled = false;
  try {
    const operation = Promise.resolve().then(() => request({ token, channelId: channel.id, topic: desiredTopic, signal: controller.signal }));
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error('Discord legacy topic migration deadline exceeded');
        error.publicationUnknown = true;
        reject(error);
      }, boundedMs);
    });
    const response = await Promise.race([operation, deadline]);
    if (!response || response.topic !== desiredTopic) {
      const error = new Error('Discord legacy topic migration response did not confirm the static marker');
      error.publicationUnknown = true;
      throw error;
    }
    const recorded = state.recordTopicPublication(channel.id, {
      requestId: custody.requestId,
      desiredReadiness: binding.readiness,
      outcome: 'published',
      publishedReadiness: binding.readiness,
      observedTopic: response.topic,
      remoteTerminal: true
    }, binding);
    settled = true;
    channel.topic = response.topic;
    return { migrated: true, topic: response.topic, custody: recorded, binding };
  } catch (error) {
    const outcome = topicPatchOutcome(error);
    if (!settled) {
      state.recordTopicPublication(channel.id, {
        requestId: custody.requestId,
        desiredReadiness: binding.readiness,
        outcome,
        publicationUnknown: outcome === 'unknown',
        observedTopic: channel.topic,
        error: error.message,
        remoteTerminal: outcome !== 'unknown'
      }, binding);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function ensureProvisionedChannel({ guild, provider, nativeId, categoryId, taskName, conductorId, repoKey, generation = 1, readiness = READINESS.PENDING, channelId = null, allowCreate = true, allowLegacy = false }) {
  if (provider !== PROVIDERS.CODEX && provider !== PROVIDERS.CLAUDE) throw new Error('unsupported provider');
  validateNativeId(nativeId);
  if (typeof conductorId !== 'string' || !conductorId || typeof repoKey !== 'string' || !repoKey) throw new Error('conductor identity is required for channel provisioning');
  if (typeof categoryId !== 'string' || !categoryId) throw new Error('categoryId is required');
  const marker = conductorMarker({ provider, nativeId, conductorId, repoKey, generation, readiness });
  if (typeof guild.channels?.fetch === 'function') await guild.channels.fetch();
  const channels = guild.channels?.cache ? [...guild.channels.cache.values()] : [];
  let adopted = false;
  let marked;
  if (channelId) {
    const channel = typeof guild.channels.fetch === 'function' ? await guild.channels.fetch(channelId) : channels.find(item => item.id === channelId);
    if (!channel) throw new Error('requested adoption channel was not found');
    if (channel.parentId !== categoryId) throw new Error('requested adoption channel is outside the configured vendor category');
    if (channel.topic !== marker) {
      const legacy = parseLegacyConductorMarker(channel.topic);
      const v2Match = legacy && conductorMarkerMatches(channel.topic, { provider, nativeId, conductorId, repoKey, generation: legacy.generation });
      const legacyMatch = legacyAdoptionTopic(channel.topic, provider, nativeId);
      if (!v2Match && !legacyMatch) throw new Error('requested adoption channel metadata does not match the native identity');
      if (!allowLegacy) throw new Error('legacy channel topic requires explicit --migrate-legacy-topic --channel-id');
      adopted = legacyMatch;
      return { channel, created: false, adopted, legacy: true, legacyMetadata: legacy || { version: 'v1', provider, nativeId, generation: null }, marker: channel.topic };
    }
    return { channel, created: false, adopted, marker };
  }
  marked = channels.filter(channel => channel.topic === marker);
  if (marked.length > 1) throw new Error('duplicate provision markers require reconciliation');
  const existingMarker = marked[0];
  if (existingMarker && existingMarker.parentId !== categoryId) throw new Error('provision marker exists under the wrong category');
  const existing = existingMarker;
  const legacyMarkers = channels.filter(channel => legacyMarkerMatches(channel.topic, { provider, nativeId, conductorId, repoKey }));
  if (legacyMarkers.length > 1) throw new Error('duplicate legacy provision markers require explicit reconciliation');
  if (legacyMarkers[0] && legacyMarkers[0].parentId !== categoryId) throw new Error('legacy provision marker exists under the wrong category');
  if (existing) throw new Error('existing static conductor marker requires explicit --channel-id adoption');
  if (legacyMarkers[0]) throw new Error('existing legacy conductor marker requires explicit --channel-id adoption');
  if (!allowCreate) throw new Error('provision intent is unresolved and has no reconciled Discord channel; use explicit --channel-id adoption before retrying');
  const type = requireInstalled('discord.js').ChannelType.GuildText;
  const presentationName = typeof taskName === 'string' && taskName ? taskName : `${provider}-${nativeId.slice(0, 8)}`;
  const channel = await guild.channels.create({
    name: presentationName.slice(0, 100),
    type,
    parent: categoryId,
    topic: marker,
    reason: 'Create an explicitly bound native Discord surface'
  });
  return { channel, created: true, adopted: false, marker };
}

function categoryFor(provider, args, config) {
  const configured = config[`${provider}CategoryId`];
  if (configured) {
    if (args['category-id'] && args['category-id'] !== configured) throw new Error(`--category-id does not match configured ${provider} category`);
    return configured;
  }
  return required(args, 'category-id');
}

async function provisionInternal(args) {
  const provider = required(args, 'provider');
  const nativeId = required(args, 'native-id');
  validateNativeId(nativeId);
  const conductorId = required(args, 'conductor-id');
  const repoKey = required(args, 'repo-key');
  const migrate = migrationRequested(args);
  if (migrate && !args['channel-id']) throw new Error('--migrate-legacy-topic requires --channel-id');
  if (provider === PROVIDERS.CLAUDE && !args.endpoint) throw new Error('Claude provisioning requires --endpoint');
  const workspace = path.resolve(required(args, 'workspace'));
  const endpoint = args.endpoint ? path.resolve(args.endpoint) : undefined;
  const { state } = openState(args);
  let client;
  try {
    const config = state.requireConfig();
    const categoryId = categoryFor(provider, args, config);
    const taskName = args['task-name'];
    if (taskName !== undefined && (typeof taskName !== 'string' || !taskName || taskName.length > 100)) throw new Error('--task-name must be 1 to 100 characters');
    const existingBinding = state.findConductorBinding(conductorId, provider);
    if (existingBinding) {
      if (existingBinding.repoKey !== repoKey || existingBinding.nativeId !== nativeId || existingBinding.workspace !== workspace || existingBinding.endpoint !== (endpoint || null)) {
        throw new Error('existing conductor binding does not match requested identity; use explicit handoff for a successor');
      }
      if (migrate && args['channel-id'] !== existingBinding.channelId) throw new Error('--channel-id must identify the locally bound conductor channel');
      const marker = staticConductorMarker({ provider, conductorId, repoKey });
      const { Client, GatewayIntentBits } = requireInstalled('discord.js');
      client = new Client({ intents: [GatewayIntentBits.Guilds] });
      const token = readSecret(config.secretFile);
      await client.login(token);
      const guild = await client.guilds.fetch(config.guildId);
      const boundChannel = await guild.channels.fetch(existingBinding.channelId);
      const markerMatches = boundChannel && boundChannel.topic === marker;
      let legacyMetadata = null;
      if (boundChannel && !markerMatches) {
        try {
          legacyMetadata = validateLegacyMetadata(boundChannel.topic, { provider, nativeId, conductorId, repoKey, generation: existingBinding.generation });
        } catch {
          legacyMetadata = null;
        }
      }
      if (!boundChannel || boundChannel.parentId !== categoryId || (!markerMatches && !legacyMetadata)) {
        throw new Error('existing conductor channel does not match requested metadata');
      }
      if (legacyMetadata) {
        if (!migrate) throw new Error('legacy channel topic requires explicit --migrate-legacy-topic --channel-id');
        state.assertLegacyMigrationSafe(existingBinding.channelId);
        await migrateLegacyTopic({ state, channel: boundChannel, binding: existingBinding, token });
      }
      print({ created: false, adopted: false, legacy: Boolean(legacyMetadata), migrated: Boolean(legacyMetadata), bound: true, marker: boundChannel.topic, conductorId, repoKey, channelId: existingBinding.channelId, url: `https://discord.com/channels/${config.guildId}/${existingBinding.channelId}`, binding: state.getBinding(existingBinding.channelId) });
      return;
    }
    const marker = staticConductorMarker({ provider, conductorId, repoKey });
    const intent = state.beginProvisionIntent({ provider, nativeId, conductorId, repoKey, guildId: config.guildId, categoryId, workspace, endpoint, marker, taskName });
    const { Client, GatewayIntentBits } = requireInstalled('discord.js');
    client = new Client({ intents: [GatewayIntentBits.Guilds] });
    const token = readSecret(config.secretFile);
    await client.login(token);
    const guild = await client.guilds.fetch(config.guildId);
    const result = await ensureProvisionedChannel({ guild, provider, nativeId, categoryId, taskName, conductorId, repoKey, channelId: args['channel-id'] || intent.channel_id, allowCreate: intent.fresh, allowLegacy: migrate });
    let legacyMetadata = null;
    if (result.legacy) {
      if (!migrate) throw new Error('legacy channel topic requires explicit --migrate-legacy-topic --channel-id');
      legacyMetadata = validateLegacyMetadata(result.channel.topic, { provider, nativeId, conductorId, repoKey, generation: result.legacyMetadata?.generation ?? null });
      state.assertLegacyMigrationSafe(result.channel.id);
    }
    const existingNativeBinding = state.findNativeBinding(nativeId, provider);
    if (existingNativeBinding) {
      if (!existingNativeBinding.active || existingNativeBinding.provider !== provider || existingNativeBinding.workspace !== workspace || existingNativeBinding.endpoint !== (endpoint || null) || existingNativeBinding.conductorId !== conductorId || existingNativeBinding.repoKey !== repoKey) {
        throw new Error('existing native binding does not match requested provision identity');
      }
      if (existingNativeBinding.channelId !== result.channel.id) {
        throw new Error('native session is already bound to another conductor channel');
      }
      state.completeProvisionIntent(provider, nativeId, existingNativeBinding.channelId, conductorId);
      print({ created: false, adopted: result.adopted, legacy: Boolean(legacyMetadata), migrated: false, bound: true, marker: result.channel.topic, conductorId, repoKey, channelId: existingNativeBinding.channelId, url: `https://discord.com/channels/${config.guildId}/${existingNativeBinding.channelId}`, binding: existingNativeBinding, intent });
      return;
    }
    const binding = state.bind({ channelId: result.channel.id, guildId: config.guildId, provider, nativeId, workspace, endpoint, categoryId, conductorId, repoKey, generation: legacyMetadata?.generation ?? undefined });
    state.completeProvisionIntent(provider, nativeId, result.channel.id, conductorId);
    if (legacyMetadata) await migrateLegacyTopic({ state, channel: result.channel, binding, token });
    print({ created: result.created, adopted: result.adopted, legacy: Boolean(legacyMetadata), migrated: Boolean(legacyMetadata), bound: true, marker: result.channel.topic, conductorId, repoKey, channelId: result.channel.id,
      url: `https://discord.com/channels/${config.guildId}/${result.channel.id}`, binding: state.getBinding(result.channel.id), intent });
  } finally {
    await client?.destroy();
    state.close();
  }
}

function provision(args) {
  const { stateDir, provisionLock } = pathsFor(args);
  if (process.env.DISCORD_SURFACE_PROVISION_LOCK_HELD === '1') return provisionInternal(args);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const forwarded = Object.entries(args).flatMap(([key, value]) => value === true ? [`--${key}`] : [`--${key}`, String(value)]);
  const result = spawnSync('lockf', ['-t', '0', '-k', provisionLock, process.execPath, __filename, 'provision-run', ...forwarded], {
    stdio: 'inherit',
    env: { ...process.env, DISCORD_SURFACE_PROVISION_LOCK_HELD: '1' }
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

async function ordinaryHandoffInternal(args, dependencies = {}) {
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
      if (current.active) {
        await assertOrdinaryIntakeRange(channel, state, current, recoveredThrough, handoffFence.id, 'ordinary handoff');
      }
      handoffCutoff = handoffFence.id;
    }
    const binding = state.handoffOrdinary({
      channelId, provider, fromNativeId, fromGeneration, nativeId, workspace,
      sessionRoot: validationRoot, handoffId, intakeCutoff: handoffCutoff,
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
}

async function handoffInternal(args, dependencies = {}) {
  const ordinaryRequested = args.ordinary === true || args.ordinary === 'true';
  if (fromLockRequested(args)) {
    if (ordinaryRequested) throw new Error('ordinary handoff cannot use --from-lock');
    return handoffFromLockInternal(args);
  }
  if (ordinaryRequested) return ordinaryHandoffInternal(args, dependencies);
  const provider = required(args, 'provider');
  const conductorId = required(args, 'conductor-id');
  const repoKey = required(args, 'repo-key');
  const fromNativeId = required(args, 'from-native-id');
  const nativeId = required(args, 'native-id');
  validateNativeId(fromNativeId);
  validateNativeId(nativeId);
  const fromGeneration = Number(required(args, 'from-generation'));
  const endpoint = args.endpoint ? path.resolve(args.endpoint) : undefined;
  if (provider === PROVIDERS.CLAUDE && !endpoint) throw new Error('Claude handoff requires --endpoint');
  const workspace = path.resolve(required(args, 'workspace'));
  const channelId = required(args, 'channel-id');
  const handoffId = required(args, 'handoff-id');
  const { state } = openState(args);
  let client;
  try {
    const config = state.requireConfig();
    const categoryId = categoryFor(provider, args, config);
    const { Client, GatewayIntentBits } = requireInstalled('discord.js');
    client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(readSecret(config.secretFile));
    const guild = await client.guilds.fetch(config.guildId);
    const channel = await guild.channels.fetch(channelId);
    if (!channel || channel.parentId !== categoryId) throw new Error('handoff channel is outside the configured vendor category');
    const current = state.getBinding(channelId);
    const expectedMarker = current && staticConductorMarker({ provider, conductorId, repoKey });
    const legacy = current && (parseLegacyConductorMarker(channel.topic) || legacyAdoptionTopic(channel.topic, provider, current.nativeId));
    if (legacy) throw new Error('legacy channel topic requires explicit --migrate-legacy-topic --channel-id before handoff');
    if (!current || current.provider !== provider || current.conductorId !== conductorId || current.repoKey !== repoKey || channel.topic !== expectedMarker) {
      throw new Error('handoff channel topic does not match the locally bound conductor address');
    }
    const binding = state.handoffConductor({ channelId, provider, conductorId, repoKey, fromNativeId, fromGeneration, nativeId, workspace, endpoint, handoffId });
    print({ handedOff: true, conductorId, repoKey, channelId, url: `https://discord.com/channels/${config.guildId}/${channelId}`, binding, readiness: binding.readiness });
  } finally {
    await client?.destroy();
    state.close();
  }
}

function handoff(args) {
  const { stateDir, provisionLock } = pathsFor(args);
  if (process.env.DISCORD_SURFACE_PROVISION_LOCK_HELD === '1') return handoffInternal(args);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const forwarded = Object.entries(args).flatMap(([key, value]) => value === true ? [`--${key}`] : [`--${key}`, String(value)]);
  const result = spawnSync('lockf', ['-t', '0', '-k', provisionLock, process.execPath, __filename, 'handoff-run', ...forwarded], {
    stdio: 'inherit',
    env: { ...process.env, DISCORD_SURFACE_PROVISION_LOCK_HELD: '1' }
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

function fromLockRequested(args) {
  return args['from-lock'] === true || args['from-lock'] === 'true';
}

function conductorLockScript() {
  return path.resolve(process.env.DISCORD_SURFACE_LOCK_SCRIPT || path.join(os.homedir(), '.claude', 'skills', 'conductor-handoff', 'scripts', 'conductor-lock.sh'));
}

function localHandoff(args) {
  if (process.env.DISCORD_SURFACE_HANDOFF_GATE_HELD !== '1') throw new Error('handoff-local is internal; use handoff --from-lock');
  const provider = required(args, 'provider');
  const conductorId = required(args, 'conductor-id');
  const repoKey = required(args, 'repo-key');
  const channelId = required(args, 'channel-id');
  const nativeId = required(args, 'native-id');
  validateNativeId(nativeId);
  const fromNativeId = required(args, 'from-native-id');
  validateNativeId(fromNativeId);
  const fromGeneration = Number(required(args, 'from-generation'));
  const workspace = path.resolve(required(args, 'workspace'));
  const endpoint = args.endpoint ? path.resolve(args.endpoint) : undefined;
  if (provider === PROVIDERS.CLAUDE && !endpoint) throw new Error('Claude handoff requires --endpoint');
  const reuse = args.reuse === true || args.reuse === 'true';
  const handoffId = reuse ? null : required(args, 'handoff-id');
  const { state } = openState(args);
  try {
    const config = state.requireConfig();
    const current = state.findConductorBinding(conductorId, provider);
    if (!current || !current.active || current.channelId !== channelId || current.repoKey !== repoKey) throw new Error('local handoff binding no longer matches the verified conductor');
    if (reuse) {
      if (current.nativeId !== nativeId || current.generation !== fromGeneration || current.workspace !== workspace || current.endpoint !== (endpoint || null)) throw new Error('local handoff reuse target no longer matches the verified native binding');
      print({ handedOff: false, reused: true, conductorId, repoKey, channelId, url: `https://discord.com/channels/${config.guildId}/${channelId}`, binding: current, readiness: current.readiness });
      return;
    }
    const binding = state.handoffConductor({ channelId, provider, conductorId, repoKey, fromNativeId, fromGeneration, nativeId, workspace, endpoint, handoffId });
    print({ handedOff: true, reused: false, conductorId, repoKey, channelId, handoffId, url: `https://discord.com/channels/${config.guildId}/${channelId}`, binding, readiness: binding.readiness });
  } finally { state.close(); }
}

function handoffGate(args, current, { reuse, sessionFile, workerFile, workspace, endpoint }) {
  const paths = pathsFor(args);
  const helperArgs = [
    path.join(__dirname, 'conductor-lock-gate.py'),
    '--lock-script', conductorLockScript(), '--repo', required(args, 'repo'), '--repo-key', required(args, 'repo-key'),
    '--provider', current.provider, '--conductor-id', current.conductorId, '--channel-id', current.channelId,
    '--from-native-id', current.nativeId, '--from-generation', String(current.generation), '--native-id', required(args, 'native-id'),
    '--from-workspace', current.workspace, '--workspace', workspace, '--session-file', sessionFile, '--worker-file', workerFile,
    '--node-path', process.execPath, '--cli-path', __filename, '--state-dir', paths.stateDir, '--db', paths.db
  ];
  if (current.endpoint) helperArgs.push('--from-endpoint', current.endpoint);
  if (endpoint) helperArgs.push('--endpoint', endpoint);
  if (reuse) helperArgs.push('--reuse');
  const result = spawnSync(process.env.DISCORD_SURFACE_PYTHON || 'python3', helperArgs, {
    encoding: 'utf8', timeout: 35000, env: { ...process.env }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'lock-gated handoff failed').trim());
  if (result.stdout) process.stdout.write(result.stdout);
  return result.stdout;
}

async function handoffFromLockInternal(args) {
  const provider = required(args, 'provider');
  const conductorId = required(args, 'conductor-id');
  const repoKey = required(args, 'repo-key');
  const repo = required(args, 'repo');
  const nativeId = required(args, 'native-id');
  validateNativeId(nativeId);
  const endpoint = args.endpoint ? path.resolve(args.endpoint) : undefined;
  if (provider === PROVIDERS.CLAUDE && !endpoint) throw new Error('Claude handoff requires --endpoint');
  const workspace = path.resolve(required(args, 'workspace'));
  const sessionFile = path.resolve(required(args, 'session-file'));
  const workerFile = path.resolve(required(args, 'worker-file'));
  if (args['channel-id'] || args['from-native-id'] || args['from-generation'] || args['handoff-id']) throw new Error('--from-lock derives the existing binding and handoff authority');
  let state = openState(args).state;
  let client;
  try {
    const config = state.requireConfig();
    const current = state.findConductorBinding(conductorId, provider);
    if (!current || !current.active || current.repoKey !== repoKey) throw new Error('no active local binding matches the requested conductor and repository');
    const categoryId = categoryFor(provider, args, config);
    const { Client, GatewayIntentBits } = requireInstalled('discord.js');
    client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(readSecret(config.secretFile));
    const guild = await client.guilds.fetch(config.guildId);
    const channel = await guild.channels.fetch(current.channelId);
    const marker = staticConductorMarker({ provider, conductorId, repoKey });
    if (!channel || channel.id !== current.channelId || channel.parentId !== categoryId || channel.topic !== marker) throw new Error('handoff channel does not match the static conductor address');
    const reuse = current.nativeId === nativeId;
    await client.destroy();
    client = null;
    state.close();
    state = null;
    handoffGate({ ...args, repo }, current, { reuse, sessionFile, workerFile, workspace, endpoint });
    return;
  } finally {
    await client?.destroy();
    state?.close();
  }
}

function writePid(pidFile, guildId, stateDir, db) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pidFile, JSON.stringify({
    pid: process.pid,
    guildId,
    stateDir,
    db,
    command: 'run',
    startedAt: new Date().toISOString(),
    capabilities: [
      GATEWAY_CAPABILITIES.ordinaryBindWake,
      GATEWAY_CAPABILITIES.runtimeBindLock,
      GATEWAY_CAPABILITIES.ordinaryClaudeBind
    ]
  }), { mode: 0o600 });
  fs.chmodSync(pidFile, 0o600);
}

function acquireHeldLock(lockPath) {
  const parentPid = String(process.pid);
  const holderScript = [
    "const parentPid = Number(process.env.DISCORD_SURFACE_LOCK_PARENT_PID);",
    "process.stdout.write('locked\\n');",
    "process.stdin.resume();",
    "process.stdin.once('end', () => process.exit(0));",
    "setInterval(() => { try { process.kill(parentPid, 0); } catch { process.exit(0); } }, 100);"
  ].join('');
  const holder = spawn('lockf', ['-t', '1', '-k', lockPath, process.execPath, '-e', holderScript], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, DISCORD_SURFACE_LOCK_PARENT_PID: parentPid }
  });
  let ready = false;
  let settled = false;
  let output = '';
  const acquired = new Promise((resolve, reject) => {
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    holder.stdout.setEncoding('utf8');
    holder.stdout.on('data', chunk => {
      if (ready) return;
      output += String(chunk);
      if (!output.includes('locked')) return;
      ready = true;
      settled = true;
      resolve();
    });
    holder.once('error', fail);
    holder.once('exit', (code, signal) => {
      if (ready) return;
      const error = new Error(`could not acquire runtime bind lock${signal ? ` (${signal})` : ` (exit ${code})`}`);
      if (!signal && code === LOCK_CONTENTION_EXIT) error.code = 'RUNTIME_BIND_LOCK_BUSY';
      fail(error);
    });
  });
  return acquired.then(() => {
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        try { holder.stdin.end(); } catch {}
        if (holder.exitCode === null && holder.signalCode === null) await once(holder, 'exit');
      }
    };
  });
}

async function acquireHeldLockUntilAvailable(lockPath, isStopping) {
  let reportedContention = false;
  while (!isStopping?.()) {
    try {
      const lock = await acquireHeldLock(lockPath);
      const stopping = isStopping?.();
      if (stopping) {
        await lock.release();
        return null;
      }
      return lock;
    }
    catch (error) {
      if (error.code !== 'RUNTIME_BIND_LOCK_BUSY') throw error;
      if (!reportedContention) {
        reportedContention = true;
        process.stderr.write('discord-surface: runtime bind lock is busy; waiting for the holder to release it\n');
      }
      if (isStopping?.()) return null;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  return null;
}

function createBindingWakeController({ getGateway, isReady, isTransportReady = isReady, isStopping,
  logger = error => process.stderr.write(`discord-surface: ordinary binding recovery failed: ${error.message}\n`) } = {}) {
  let wakePromise = null;
  let wakeRequested = false;
  const request = () => {
    wakeRequested = true;
    const gateway = getGateway?.();
    if (isStopping?.() || !gateway || !isTransportReady?.() || wakePromise) return;
    wakePromise = (async () => {
      while (wakeRequested && !isStopping?.()) {
        wakeRequested = false;
        const currentGateway = getGateway?.();
        if (!currentGateway || !isTransportReady?.()) return;
        const joinedRecovery = Boolean(currentGateway.recoveryPromise);
        currentGateway.pauseLiveDispatch?.();
        const recovery = await currentGateway.recoverTransport('ordinary-bind');
        if (joinedRecovery) {
          wakeRequested = true;
          continue;
        }
        if (!isStopping?.()) {
          if (isReady?.()) {
            if (recovery?.ready) await currentGateway.reconcilePending();
            else await currentGateway.reconcilePending(undefined, { readyOnly: true });
          }
          else if (['gap', 'unavailable'].includes(recovery?.state)) {
            await currentGateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
          }
        }
      }
    })().catch(logger).finally(() => {
      wakePromise = null;
      if (wakeRequested && !isStopping?.()) request();
    });
  };
  const start = () => {
    if (wakeRequested) request();
  };
  const wait = async () => {
    while (wakePromise) {
      const current = wakePromise;
      await current;
    }
  };
  return { request, start, wait };
}

async function runRuntime(args) {
  const { paths, state } = openState(args);
  const config = state.requireConfig();
  const recoveryCutoff = new Date().toISOString();
  let gateway;
  let gatewayReady = false;
  let stopping = false;
  let startupLock = null;
  const bindingWake = createBindingWakeController({
    getGateway: () => gateway,
    isReady: () => gatewayReady && gateway?.ready === true,
    isTransportReady: () => gatewayReady && gateway?.transportReady === true,
    isStopping: () => stopping
  });
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const pendingBindingWake = bindingWake.wait();
    try { await gateway?.stop(); } finally {
      await pendingBindingWake;
      await startupLock?.release();
      startupLock = null;
      try { fs.unlinkSync(paths.pid); } catch {}
      process.removeListener('SIGUSR2', bindingWake.request);
      state.close();
    }
  };
  process.once('SIGINT', () => stop().then(() => process.exit(0)));
  process.once('SIGTERM', () => stop().then(() => process.exit(0)));
  process.on('SIGUSR2', bindingWake.request);
  try {
    startupLock = await acquireHeldLockUntilAvailable(paths.bindLock, () => stopping);
    if (stopping || !startupLock) return;
    state.recoverAfterRestart();
    writePid(paths.pid, config.guildId, paths.stateDir, paths.db);
    gateway = new DiscordGateway({
      state,
      observeOptions: { timeoutMs: Number(args['reply-timeout-ms'] || 120000) },
      onReady: () => bindingWake.start()
    });
    await gateway.start(config.secretFile);
    await gateway.reconcilePending(recoveryCutoff);
    gatewayReady = true;
    bindingWake.start();
  } catch (error) {
    await stop();
    throw error;
  } finally {
    await startupLock?.release();
    startupLock = null;
  }
  await new Promise(() => {});
}

function start(args) {
  const { stateDir, lock } = pathsFor(args);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const state = new SurfaceState(pathsFor(args).db);
  const config = state.requireConfig();
  state.close();
  const runtimeDir = path.join(os.tmpdir(), 'discord-surface-runtime');
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(runtimeDir, 0o700); } catch {}
  const guildLock = path.join(runtimeDir, `guild-${config.guildId}.lock`);
  const runArgs = [process.execPath, __filename, 'run', '--state-dir', stateDir, ...(args.db ? ['--db', path.resolve(args.db)] : [])];
  const result = spawnSync('lockf', ['-t', '0', '-k', guildLock, 'lockf', '-t', '0', '-k', lock, ...runArgs], {
    stdio: 'inherit',
    env: { ...process.env, DISCORD_SURFACE_LOCK_HELD: '1' }
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

async function claudeChannel(args) {
  const { state } = openState(args);
  let channel;
  let stopPromise;
  const stop = async () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      try { await channel?.stop(); } finally { state.close(); }
    })();
    return stopPromise;
  };
  process.once('SIGINT', () => stop().then(() => process.exit(0)));
  process.once('SIGTERM', () => stop().then(() => process.exit(0)));
  process.stdin.once('end', () => stop().then(() => process.exit(0)));
  process.stdin.once('close', () => stop().then(() => process.exit(0)));
  try {
    channel = new ClaudeChannel({
      state,
      nativeId: required(args, 'native-id'),
      socketPath: path.resolve(required(args, 'socket')),
      onTransportClose: stop
    });
    await channel.start();
  }
  catch (error) { await stop(); throw error; }
}

async function claudeMonitor(args) {
  const { paths, state } = openState(args);
  const nativeId = required(args, 'native-id');
  const socketPath = path.resolve(required(args, 'socket'));
  let ordinaryStartupBinding = null;
  let monitor;
  let monitorStarted = false;
  let stopPromise;
  let detachStdoutTransport = () => {};
  const revokeOrdinaryReadiness = () => {
    if (!monitorStarted || !ordinaryStartupBinding) return;
    const current = state.getBinding(ordinaryStartupBinding.channelId);
    if (!current || !current.active || current.provider !== PROVIDERS.CLAUDE || current.nativeId !== ordinaryStartupBinding.nativeId ||
      current.workspace !== ordinaryStartupBinding.workspace || current.endpoint !== ordinaryStartupBinding.endpoint) return;
    state.setBindingReadiness(ordinaryStartupBinding.channelId, READINESS.UNAVAILABLE, 'Claude Monitor unavailable', ordinaryStartupBinding);
  };
  const stop = async () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      try {
        detachStdoutTransport();
        revokeOrdinaryReadiness();
      } finally {
        try { await monitor?.stop(); }
        finally { state.close(); }
      }
    })();
    return stopPromise;
  };
  const handleStopFailure = error => {
    process.stderr.write(`discord-surface: Claude Monitor stop failed: ${error.message}\n`);
    process.exitCode = 1;
  };
  const onStdoutTransportFailure = () => { stop().catch(handleStopFailure); };
  detachStdoutTransport = () => {
    process.stdout.removeListener?.('error', onStdoutTransportFailure);
    process.stdout.removeListener?.('close', onStdoutTransportFailure);
  };
  process.stdout.once?.('error', onStdoutTransportFailure);
  process.stdout.once?.('close', onStdoutTransportFailure);
  const handleSignal = signal => {
    stop().then(() => {
      process.exitCode = 128 + (os.constants.signals?.[signal] || 1);
    }).catch(error => {
      process.stderr.write(`discord-surface: Claude Monitor stop failed: ${error.message}\n`);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  try {
    monitor = createClaudeMonitor({
      state,
      nativeId,
      socketPath,
      stateDir: paths.stateDir,
      dbPath: paths.db,
      cliPath: __filename,
      onTransportClose: stop
    });
    const servedIdentity = monitor?.bindingIdentity;
    const servedBinding = servedIdentity ? state.getBinding(servedIdentity.channelId) : null;
    ordinaryStartupBinding = servedBinding?.active && state.isOrdinaryBinding(servedBinding) &&
      servedBinding.channelId === servedIdentity.channelId && servedBinding.guildId === servedIdentity.guildId &&
      servedBinding.provider === servedIdentity.provider && servedBinding.nativeId === servedIdentity.nativeId &&
      servedBinding.workspace === servedIdentity.workspace && servedBinding.endpoint === servedIdentity.endpoint &&
      servedBinding.generation === servedIdentity.generation ? servedBinding : null;
    await monitor.start();
    monitorStarted = true;
    if (ordinaryStartupBinding) {
      const startedIdentity = monitor?.bindingIdentity;
      const startedBinding = startedIdentity ? state.getBinding(startedIdentity.channelId) : null;
      const bindingStillCurrent = startedBinding?.active && state.isOrdinaryBinding(startedBinding) &&
        startedBinding.channelId === startedIdentity?.channelId && startedBinding.guildId === startedIdentity?.guildId &&
        startedBinding.provider === startedIdentity?.provider && startedBinding.nativeId === startedIdentity?.nativeId &&
        startedBinding.workspace === startedIdentity?.workspace && startedBinding.endpoint === startedIdentity?.endpoint &&
        startedBinding.generation === startedIdentity?.generation;
      if (!bindingStillCurrent) throw new Error('Claude Monitor binding changed during startup');
      const watermark = state.getIntakeWatermark(ordinaryStartupBinding.channelId);
      const endpointUnavailable = watermark?.state === READINESS.UNAVAILABLE &&
        typeof watermark.detail === 'string' &&
        watermark.detail.startsWith(CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX);
      if (endpointUnavailable) {
        state.reconcileIntake(ordinaryStartupBinding.channelId, ordinaryStartupBinding);
      }
      const gatewayWake = requestGatewayRecovery(paths);
      if (!gatewayWake.requested) {
        process.stderr.write(`discord-surface: Claude Monitor startup could not wake Gateway (${gatewayWake.reason})\n`);
      }
    }
  } catch (error) {
    await stop();
    throw error;
  }
}

function claudeReply(args) {
  const { state } = openState(args);
  try {
    const generation = Number(required(args, 'generation'));
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('generation must be a positive integer');
    const textFile = path.resolve(required(args, 'text-file'));
    const stat = fs.statSync(textFile);
    if (!stat.isFile()) throw new Error('text file must be a regular file');
    const result = state.recordNativeReply({
      provider: 'claude',
      messageId: required(args, 'message-id'),
      nativeId: required(args, 'native-id'),
      generation,
      text: fs.readFileSync(textFile, 'utf8')
    });
    print({
      messageId: required(args, 'message-id'),
      recorded: !result.duplicate,
      duplicate: Boolean(result.duplicate),
      state: result.message.state
    });
  } finally { state.close(); }
}

async function agentSend(args) {
  const provider = required(args, 'provider');
  if (!['codex', 'claude'].includes(provider)) throw new Error('invalid agent provider');
  const { state } = openState(args);
  let ordinary;
  let agentCredential;
  try {
    ordinary = state.isOrdinaryBindingRecord(state.getBinding(required(args, 'channel-id')));
    agentCredential = readSecret(state.requireConfig().secretFile);
  }
  finally { state.close(); }
  const isReply = Object.hasOwn(args, 'agent-reply-to');
  const targetPath = Object.hasOwn(args, 'target-file') ? required(args, 'target-file') : null;
  let agentTarget = null;
  if (targetPath !== null) {
    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) throw new Error('agent target file must be a regular file');
    const fd = fs.openSync(targetPath, 'r');
    const chunks = [];
    let bytesRead = 0;
    try {
      const buffer = Buffer.alloc(1024);
      while (bytesRead <= 2048) {
        const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, 2049 - bytesRead), bytesRead);
        if (length === 0) break;
        chunks.push(Buffer.from(buffer.subarray(0, length)));
        bytesRead += length;
        if (bytesRead > 2048) throw new Error('agent target file is too large');
      }
    } finally { fs.closeSync(fd); }
    agentTarget = JSON.parse(Buffer.concat(chunks, bytesRead).toString('utf8'));
    if (!isReply) verifyAgentAddress(agentTarget, agentCredential);
  } else if (!isReply) {
    required(args, 'target-file');
  }
  return directPost(args, provider, ordinary, {
    agentTarget,
    agentPresentation: args['agent-presentation']
  });
}

async function directPost(args, provider = null, ordinary = false, dependencies = {}) {
  const { state } = openState(args);
  const controller = new AbortController();
  let receivedSignal = null;
  const handleSignal = signal => {
    if (receivedSignal) return;
    receivedSignal = signal;
    controller.abort();
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  try {
    const config = state.requireConfig();
    const dedupeKey = resolveDedupeKey({ dedupeKey: args['dedupe-key'], requestId: args['request-id'] }, { required: !dependencies.exportAddress });
    const hasAgentReplyTo = Object.hasOwn(args, 'agent-reply-to');
    if (hasAgentReplyTo && !args['agent-reply-to']) throw new Error('agent reply correlation must not be empty');
    const nativeId = required(args, 'native-id');
    const generation = required(args, 'generation');
    const channelId = ordinary ? required(args, 'channel-id') : (args['channel-id'] || null);
    if (ordinary) {
      const invocation = provider === PROVIDERS.CLAUDE
        ? await (dependencies.resolveClaudeCaller || (() => resolveCurrentClaudeCaller(dependencies)))()
        : (dependencies.resolveInvocationIdentity || resolveInvocationIdentity)(dependencies.environment || process.env);
      if (provider === PROVIDERS.CLAUDE &&
        (!invocation || invocation.harness !== 'claude-code' || typeof invocation.sessionId !== 'string')) {
        throw new Error('ordinary Claude caller identity is unavailable or uses the wrong harness');
      }
      const invocationSessionId = invocation.sessionId;
      const invocationThreadId = provider === PROVIDERS.CLAUDE ? invocationSessionId : invocation.threadId;
      const binding = state.getBinding(channelId);
      if (nativeId !== invocationSessionId || invocationThreadId !== invocationSessionId ||
        !binding?.active || binding.provider !== provider || !state.isOrdinaryBindingRecord(binding) || binding.nativeId !== invocationSessionId ||
        Number(binding.generation) !== Number(generation)) {
        throw new Error(`ordinary post identity does not match the active ${provider === PROVIDERS.CLAUDE ? 'Claude' : 'Codex'} binding`);
      }
    }
    if (dependencies.exportAddress) {
      const binding = resolveDirectBinding(state, { nativeId, generation: Number(generation), channelId, provider, ordinary });
      const envelope = issueAgentAddress(binding, readSecret(config.secretFile));
      print(envelope);
      return envelope;
    }
    const result = await runDirectPost({
      state,
      token: readSecret(config.secretFile),
      nativeId,
      generation,
      channelId,
      provider,
      textFile: required(args, 'text-file'),
      agentTarget: dependencies.agentTarget ?? null,
      agentPresentation: dependencies.agentPresentation,
      agentKind: hasAgentReplyTo ? 'result' : 'request',
      agentReplyTo: hasAgentReplyTo ? args['agent-reply-to'] : null,
      dedupeKey,
      inReplyTo: args['in-reply-to'] === undefined ? null : args['in-reply-to'],
      signal: controller.signal,
      ordinary
    });
    print(result);
    if (result.status !== 'sent') process.exitCode = 1;
    if (receivedSignal) process.exitCode = 128 + (os.constants.signals?.[receivedSignal] || 1);
    return result;
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    state.close();
  }
}

function readProcessCommand(pid) {
  return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
}

function pidMatches(value, stateDir, db, command) {
  if (!value || value.command !== 'run' || value.stateDir !== stateDir) return false;
  try {
    const actualCommand = (command ?? readProcessCommand(value.pid)).trim();
    const expectedPrefix = `${process.execPath} ${__filename} run --state-dir ${stateDir}`;
    if (actualCommand === expectedPrefix) {
      return (value.db == null || value.db === db) && db === path.join(stateDir, 'surface.sqlite');
    }
    const suffix = actualCommand.startsWith(expectedPrefix) ? actualCommand.slice(expectedPrefix.length).trim() : '';
    const commandDb = suffix.startsWith('--db=') ? suffix.slice('--db='.length) : suffix.startsWith('--db ') ? suffix.slice('--db '.length).trim() : null;
    if (!commandDb) return false;
    if (value.db != null && value.db !== db) return false;
    const unquotedDb = commandDb.length >= 2 && ((commandDb.startsWith('"') && commandDb.endsWith('"')) || (commandDb.startsWith("'") && commandDb.endsWith("'")))
      ? commandDb.slice(1, -1)
      : commandDb;
    return path.resolve(unquotedDb) === db;
  } catch { return false; }
}

function gatewayProcessStatus(paths) {
  if (!fs.existsSync(paths.pid)) {
    return { state: 'stopped', pid: null, connection: 'unavailable', reason: 'pid-file-missing' };
  }

  let value;
  try { value = JSON.parse(fs.readFileSync(paths.pid, 'utf8')); }
  catch { return { state: 'unknown', pid: null, connection: 'unknown', reason: 'pid-file-corrupt' }; }

  const runtimePid = Number(value?.pid);
  if (!Number.isSafeInteger(runtimePid) || runtimePid < 1) {
    return { state: 'unknown', pid: null, connection: 'unknown', reason: 'pid-file-invalid' };
  }

  try { process.kill(runtimePid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return { state: 'stale', pid: runtimePid, connection: 'unavailable', reason: 'pid-not-running' };
    return { state: 'unknown', pid: runtimePid, connection: 'unknown', reason: 'process-probe-failed' };
  }

  let command;
  try { command = readProcessCommand(runtimePid); }
  catch { return { state: 'unknown', pid: runtimePid, connection: 'unknown', reason: 'process-inspection-failed' }; }
  if (!pidMatches(value, paths.stateDir, paths.db, command)) {
    return { state: 'unknown', pid: runtimePid, connection: 'unknown', reason: 'pid-owner-mismatch' };
  }
  return {
    state: 'running',
    pid: runtimePid,
    connection: 'unverified-live',
    guildId: value.guildId,
    stateDir: value.stateDir,
    db: value.db,
    startedAt: value.startedAt,
    capabilities: Array.isArray(value.capabilities) ? value.capabilities : []
  };
}

function waitForExit(pid, timeoutMs = 10000) {
  const started = Date.now();
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() - started < timeoutMs) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    Atomics.wait(waiter, 0, 0, 100);
  }
  return false;
}

function stop(args) {
  const { stateDir, db, pid } = pathsFor(args);
  if (!fs.existsSync(pid)) return print({ stopped: false, reason: 'not-running' });
  let value;
  try { value = JSON.parse(fs.readFileSync(pid, 'utf8')); } catch { throw new Error('runtime pid file is corrupt'); }
  const runtimePid = Number(value.pid);
  if (!Number.isInteger(runtimePid) || runtimePid < 1) throw new Error('runtime pid file has an invalid owner');
  if (!pidMatches(value, stateDir, db)) {
    try { process.kill(runtimePid, 0); } catch (error) {
      if (error.code === 'ESRCH') { fs.unlinkSync(pid); print({ stopped: false, reason: 'stale-pid' }); return; }
    }
    throw new Error('runtime pid owner does not match this state directory');
  }
  process.kill(runtimePid, 'SIGTERM');
  if (!waitForExit(runtimePid)) throw new Error('runtime did not exit after SIGTERM');
  try { fs.unlinkSync(pid); } catch {}
  print({ stopped: true, pid: runtimePid });
}

async function main() {
  const { command, subcommand, args } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'configure': return configure(args);
    case 'bind': return bind(args);
    case 'ordinary-bind':
      if (process.env.DISCORD_SURFACE_ORDINARY_BIND_LOCK_HELD !== '1') return ordinaryBindCommand(args);
      return ordinaryBind(args);
    case 'ordinary-bind-run':
      if (process.env.DISCORD_SURFACE_ORDINARY_BIND_LOCK_HELD !== '1') throw new Error('ordinary-bind-run is internal; use ordinary-bind');
      return ordinaryBind(args);
    case 'ordinary-claude-bind':
      if (process.env.DISCORD_SURFACE_ORDINARY_CLAUDE_BIND_LOCK_HELD !== '1') return ordinaryClaudeBindCommand(args);
      return ordinaryClaudeBind(args);
    case 'ordinary-claude-bind-run':
      if (process.env.DISCORD_SURFACE_ORDINARY_CLAUDE_BIND_LOCK_HELD !== '1') throw new Error('ordinary-claude-bind-run is internal; use ordinary-claude-bind');
      return ordinaryClaudeBind(args);
    case 'rebind': return bind(args, true);
    case 'unbind': return unbind(args);
    case 'status': return status(args);
    case 'recover': return recover(args);
    case 'provision': return provision(args);
    case 'provision-run':
      if (process.env.DISCORD_SURFACE_PROVISION_LOCK_HELD !== '1') throw new Error('provision-run is internal; use provision so the singleton lock is held');
      return provisionInternal(args);
    case 'handoff': return handoff(args);
    case 'handoff-local': return localHandoff(args);
    case 'handoff-run':
      if (process.env.DISCORD_SURFACE_PROVISION_LOCK_HELD !== '1') throw new Error('handoff-run is internal; use handoff so the singleton lock is held');
      return handoffInternal(args);
    case 'start': return start(args);
    case 'run':
      if (process.env.DISCORD_SURFACE_LOCK_HELD !== '1') throw new Error('run is internal; use start so the singleton lock is held');
      return runRuntime(args);
    case 'stop': return stop(args);
    case 'claude-channel': return claudeChannel(args);
    case 'claude-monitor': return claudeMonitor(args);
    case 'native-ack': {
      const { state } = openState(args);
      try {
        return print(recordNativeAcknowledgment(state, {
          provider: required(args, 'provider'),
          messageId: required(args, 'message-id'),
          nativeId: required(args, 'native-id'),
          generation: Number(required(args, 'generation'))
        }));
      } finally { state.close(); }
    }
    case 'claude-reply': return claudeReply(args);
    case 'agent-address': {
      const provider = required(args, 'provider');
      if (!['codex', 'claude'].includes(provider)) throw new Error('invalid agent provider');
      const { state } = openState(args);
      let ordinary;
      try { ordinary = state.isOrdinaryBindingRecord(state.getBinding(required(args, 'channel-id'))); }
      finally { state.close(); }
      return directPost(args, provider, ordinary, { exportAddress: true });
    }
    case 'agent-send': return agentSend(args);
    case 'post': return directPost(args);
    case 'ordinary-post': return directPost(args, 'codex', true);
    case 'ordinary-claude-post': return directPost(args, 'claude', true);
    case 'claude-post': return directPost(args, 'claude');
    case 'liaison':
      if (subcommand !== 'draft') throw new Error('usage: liaison draft --receipt-id RECEIPT_ID');
      return liaisonDraft(args);
    default: throw new Error('usage: configure, bind, ordinary-bind, ordinary-claude-bind, rebind, unbind, status, recover, provision, handoff, start, stop, claude-channel, claude-monitor, native-ack, claude-reply, agent-address, agent-send, post, ordinary-post, ordinary-claude-post, claude-post, liaison draft');
  }
}

module.exports = { bindingArgs, claudeMonitor, claudeReply, conductorMarker, createBindingWakeController, directPost, ensureProvisionedChannel, GATEWAY_CAPABILITIES, gatewayProcessStatus, handoffInternal, liaisonDraft, main, migrateLegacyTopic, NATIVE_PROOF_STATUSES, ordinaryBind, ordinaryClaudeBind, ordinaryBindingArgs, ordinaryHandoffInternal, openState, parseArgs, pathsFor, provisionMarker, requestGatewayRecovery, resolveCurrentClaudeCaller, unbind };

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`discord-surface: ${error.message}\n`);
    process.exitCode = 1;
  });
}
