const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { PROVIDERS, READINESS } = require('../state');
const { requireInstalled, readSecret } = require('../discord');
const {
  createOrdinaryClaudeRequest,
  createOrdinaryCodexRequestFromEnvironment,
  ordinaryBindingDecision,
  ORDINARY_BINDING_DECISIONS
} = require('../ordinary-codex');
const { sessionRoot: codexSessionRoot, validateClaudeSessionIdentity, validateCodexSessionIdentityAsync } = require('../native');
const { assertSameChannelSelection, resolveDiscordChannel } = require('./channel-resolution');
const { assertGatewayWakeCompatible } = require('./gateway-capability');
const { GATEWAY_CAPABILITIES } = require('./constants');
const { CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX } = require('../ordinary/constants');

const ORDINARY_NATIVE_PROOF_UNAVAILABLE_PREFIX = 'Codex transcript proof unavailable before event write:';
const ORDINARY_CODEX_RUNTIME_PID_ENV = 'DISCORD_SURFACE_ORDINARY_CODEX_RUNTIME_PID';
const ORDINARY_CLAUDE_RUNTIME_PID_ENV = 'DISCORD_SURFACE_ORDINARY_CLAUDE_RUNTIME_PID';

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

function serverDerivedChannelCutoff(channel) {
  return typeof channel?.id === 'string' && /^\d+$/.test(channel.id) ? channel.id : null;
}

function ordinaryBindingArgs(args, environment, channelId, guildId, workspace, sessionRoot) {
  return createOrdinaryCodexRequestFromEnvironment({
    channelId: channelId || required(args, 'channel-id'),
    guildId: guildId || required(args, 'guild-id'),
    nativeId: args['native-id'],
    workspace: workspace ?? (args.workspace ? path.resolve(args.workspace) : undefined),
    sessionRoot,
    environment
  });
}

async function ordinaryBind(args, dependencies = {}) {
  const { paths, state } = openState(args);
  const environment = dependencies.environment || process.env;
  const install = dependencies.requireInstalled || requireInstalled;
  const read = dependencies.readSecret || readSecret;
  const validate = dependencies.validateCodexSessionIdentity || validateCodexSessionIdentityAsync;
  const output = dependencies.print || print;
  let client;
  try {
    const config = state.requireConfig();
    const channelSelection = args.channel || args['channel-id'];
    if (!channelSelection || typeof channelSelection !== 'string') throw new Error('missing --channel or --channel-id');
    const invocation = require('../ordinary-codex').resolveInvocationIdentity(environment, args.workspace ? path.resolve(args.workspace) : undefined);
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
    const resolved = await resolveDiscordChannel(guild, channelSelection, config.guildId);
    const channel = resolved.channel;
    assertSameChannelSelection(channel, args['channel-id'], config.guildId, resolved.fetchedChannels);
    const discordChannel = resolved.discordChannel;
    const existing = state.getBinding(channel.id);
    if (existing && state.isOrdinaryBindingRecord(existing) && invocation.sessionId !== existing.nativeId) {
      throw new Error('channel is already bound to another owner; use explicit handoff');
    }
    const validationRoot = sessionRoot ?? existing?.sessionRoot ?? undefined;
    const effectiveSessionRoot = validationRoot ?? codexSessionRoot(environment);
    if (!sessionRoot) {
      const proof = await validateNativeProof(validationRoot);
      nativeProofDetail = proof.detail;
      nativeProofError = proof.error;
      resolvedWorkspace = proof.workspace;
    }
    const request = ordinaryBindingArgs(args, environment, channel.id, config.guildId, resolvedWorkspace, effectiveSessionRoot);
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
    const nativeProofEvidence = nativeProofDetail ? { ...nativeProofDetail, sessionRoot: effectiveSessionRoot } : null;
    let decision = ordinaryBindingDecision(existing, request, existing ? state.isOrdinaryBindingRecord(existing) : false, nativeProofEvidence);
    let adoptionCutoff = null;
    if (decision !== ORDINARY_BINDING_DECISIONS.REUSE && !existing?.active) {
      const cutoff = await latestChannelMessageId(discordChannel);
      adoptionCutoff = cutoff || serverDerivedChannelCutoff(discordChannel);
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
        if (racedDecision !== 'reuse') throw error;
        decision = ORDINARY_BINDING_DECISIONS.REUSE;
        binding = raced;
      }
    } else {
      try {
        binding = state.bindOrdinary(request, request.identity, adoptionCutoff, {
          beforeMutation: assertGatewayCompatible
        });
      } catch (error) {
        const raced = state.getBinding(request.channelId);
        const racedDecision = raced
          ? ordinaryBindingDecision(raced, request, state.isOrdinaryBindingRecord(raced), nativeProofEvidence)
          : null;
        if (racedDecision !== 'reuse') throw error;
        decision = ORDINARY_BINDING_DECISIONS.REUSE;
        binding = raced;
      }
    }
    let nativeProof = { status: 'pending', reason: 'Codex transcript proof is pending' };
    if (nativeProofError) {
      const detail = `${ORDINARY_NATIVE_PROOF_UNAVAILABLE_PREFIX} ${nativeProofError.message}`;
      const unavailable = state.setBindingReadiness(binding.channelId, READINESS.UNAVAILABLE, detail, binding);
      if (unavailable === null) throw new Error('ordinary binding changed before native proof was recorded');
      if (unavailable) binding = unavailable;
      nativeProof = { status: 'pending', reason: nativeProofError.message };
    } else if (state.hasOrdinaryPreflight(binding)) {
      nativeProof = { status: 'verified', reason: 'Codex transcript proof already recorded' };
    } else if (nativeProofDetail) {
      let recorded;
      try {
        recorded = state.recordOrdinaryPreflight(binding, {
          file: nativeProofDetail.file,
          sessionId: nativeProofDetail.sessionId,
          threadId: nativeProofDetail.threadId,
          workspace: nativeProofDetail.workspace
        });
        nativeProof = { status: 'verified', file: nativeProofDetail.file, workspace: nativeProofDetail.workspace };
      } catch (error) {
        nativeProof = { status: 'pending', reason: error.message };
      }
      if (recorded === null) throw new Error('ordinary binding changed before native proof was recorded');
    } else {
      nativeProof = { status: 'pending', reason: nativeProofError?.message || 'Codex transcript proof is pending' };
    }
    if (decision === ORDINARY_BINDING_DECISIONS.REUSE && nativeProof.status === 'verified' && nativeProofDetail && !nativeProofError) {
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
    output({ bound: true, reused: decision === ORDINARY_BINDING_DECISIONS.REUSE, binding: state.getBinding(binding.channelId), nativeProof, gatewayWake });
    return { binding: state.getBinding(binding.channelId), nativeProof, gatewayWake, reused: decision === ORDINARY_BINDING_DECISIONS.REUSE };
  } finally {
    try { await client?.destroy(); } finally { state.close(); }
  }
}

async function resolveCurrentClaudeCaller(dependencies = {}) {
  if (typeof dependencies.resolveClaudeCaller === 'function') return dependencies.resolveClaudeCaller();
  const resolverPath = path.join(os.homedir(), '.claude', 'hooks', 'session-chat-binding.mjs');
  let resolver;
  try { resolver = await import(pathToFileURL(resolverPath).href); }
  catch (error) { throw new Error(`Claude caller resolver is unavailable: ${error.message}`); }
  if (typeof resolver.resolveCurrentCallerSessionChatBinding !== 'function') {
    throw new Error('Claude caller resolver does not expose resolveCurrentCallerSessionChatBinding');
  }
  return resolver.resolveCurrentCallerSessionChatBinding();
}

async function ordinaryClaudeBind(args, dependencies = {}) {
  const { paths, state } = openState(args);
  const environment = dependencies.environment || process.env;
  const install = dependencies.requireInstalled || requireInstalled;
  const read = dependencies.readSecret || readSecret;
  const resolveCaller = dependencies.resolveClaudeCaller || (() => resolveCurrentClaudeCaller(dependencies));
  const validate = dependencies.validateClaudeSessionIdentity || validateClaudeSessionIdentity;
  const output = dependencies.print || print;
  let client;
  try {
    const config = state.requireConfig();
    const channelSelection = args.channel || args['channel-id'];
    if (!channelSelection || typeof channelSelection !== 'string') throw new Error('missing --channel or --channel-id');
    const endpoint = required(args, args.endpoint !== undefined ? 'endpoint' : 'socket');
    const socketAlias = args.socket === undefined ? undefined : required(args, 'socket');
    const transcript = required(args, 'transcript');
    if (!path.isAbsolute(endpoint)) throw new Error('Claude endpoint must be an absolute Unix socket path');
    if (socketAlias !== undefined && path.resolve(endpoint) !== path.resolve(socketAlias)) {
      throw new Error('--endpoint and --socket must identify the same socket');
    }
    if (!path.isAbsolute(transcript)) throw new Error('Claude transcript path must be absolute');
    const resolvedEndpoint = path.resolve(endpoint);
    const caller = await resolveCaller();
    if (!caller || caller.harness !== 'claude-code' || typeof caller.sessionId !== 'string') {
      throw new Error('ordinary Claude caller identity is unavailable or uses the wrong harness');
    }
    const sessionId = caller.sessionId;
    const requestedWorkspace = args.workspace === undefined ? undefined : required(args, 'workspace');
    if (requestedWorkspace !== undefined && !path.isAbsolute(requestedWorkspace)) throw new Error('Claude workspace must be absolute');
    const identityProof = validate(sessionId, transcript, requestedWorkspace);
    const request = createOrdinaryClaudeRequest({
      channelId: channelSelection,
      guildId: config.guildId,
      nativeId: args['native-id'],
      workspace: identityProof.workspace,
      endpoint: resolvedEndpoint,
      identity: { sessionId, threadId: sessionId, harness: 'claude-code' }
    });
    const { Client, GatewayIntentBits } = install('discord.js');
    client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(read(config.secretFile));
    const guild = await client.guilds.fetch(config.guildId);
    const resolved = await resolveDiscordChannel(guild, channelSelection, config.guildId);
    const channel = resolved.channel;
    assertSameChannelSelection(channel, args['channel-id'], config.guildId, resolved.fetchedChannels);
    const discordChannel = resolved.discordChannel;
    const boundRequest = { ...request, channelId: channel.id };
    const gatewayStatus = dependencies.gatewayProcessStatus || gatewayProcessStatus;
    const expectedRuntimePid = environment[ORDINARY_CLAUDE_RUNTIME_PID_ENV];
    const assertGatewayCompatible = runtime => {
      const snapshot = assertGatewayWakeCompatible(paths, gatewayStatus, runtime);
      if (expectedRuntimePid !== undefined &&
        (snapshot?.state !== 'running' || String(snapshot.pid) !== expectedRuntimePid ||
          !snapshot.capabilities?.includes(GATEWAY_CAPABILITIES.runtimeBindLock) ||
          !snapshot.capabilities?.includes(GATEWAY_CAPABILITIES.ordinaryClaudeBind))) {
        throw new Error('running Gateway changed while binding ordinary Claude session');
      }
      return snapshot;
    };
    assertGatewayCompatible();
    const existing = state.getBinding(channel.id);
    let decision = ordinaryBindingDecision(existing, boundRequest, existing ? state.isOrdinaryBindingRecord(existing) : false);
    let adoptionCutoff = null;
    if (decision !== ORDINARY_BINDING_DECISIONS.REUSE && !existing?.active) {
      const cutoff = await latestChannelMessageId(discordChannel);
      adoptionCutoff = cutoff || serverDerivedChannelCutoff(discordChannel);
    }
    let binding;
    if (decision === ORDINARY_BINDING_DECISIONS.REUSE) binding = existing;
    else if (decision === ORDINARY_BINDING_DECISIONS.REBIND) {
      try {
        binding = state.rebindOrdinaryClaude(boundRequest, boundRequest.identity, adoptionCutoff, {
          beforeMutation: assertGatewayCompatible
        });
      } catch (error) {
        const raced = state.getBinding(boundRequest.channelId);
        const racedDecision = raced ? ordinaryBindingDecision(raced, boundRequest, state.isOrdinaryBindingRecord(raced)) : null;
        if (racedDecision !== 'reuse') throw error;
        decision = ORDINARY_BINDING_DECISIONS.REUSE;
        binding = raced;
      }
    } else {
      try {
        binding = state.bindOrdinaryClaude(boundRequest, boundRequest.identity, adoptionCutoff, {
          beforeMutation: assertGatewayCompatible
        });
      } catch (error) {
        const raced = state.getBinding(boundRequest.channelId);
        const racedDecision = raced ? ordinaryBindingDecision(raced, boundRequest, state.isOrdinaryBindingRecord(raced)) : null;
        if (racedDecision !== 'reuse') throw error;
        decision = ORDINARY_BINDING_DECISIONS.REUSE;
        binding = raced;
      }
    }
    let nativeProof = { status: 'pending', reason: 'Claude Monitor capability is pending' };
    if (state.hasOrdinaryPreflight(binding)) {
      nativeProof = { status: 'verified', reason: 'Claude transcript proof already recorded' };
    } else {
      assertGatewayCompatible();
      const recorded = state.recordOrdinaryPreflight(binding, {
        file: identityProof.file,
        sessionId: identityProof.sessionId,
        threadId: identityProof.threadId,
        workspace: identityProof.workspace,
        endpoint: resolvedEndpoint,
        harness: 'claude-code'
      });
      if (!recorded) throw new Error('ordinary Claude binding changed before native proof was recorded');
      nativeProof = { status: 'verified', file: identityProof.file, workspace: identityProof.workspace };
    }
    if (decision === ORDINARY_BINDING_DECISIONS.REUSE && nativeProof.status === 'verified') {
      const watermark = state.getIntakeWatermark(binding.channelId);
      const endpointUnavailable = watermark?.state === READINESS.UNAVAILABLE &&
        typeof watermark.detail === 'string' && watermark.detail.startsWith(CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX);
      if (endpointUnavailable) {
        const reopened = state.reconcileIntake(binding.channelId, binding);
        if (reopened) binding = state.getBinding(binding.channelId);
      }
    }
    const gatewayWake = requestGatewayRecovery(paths, {
      status: gatewayStatus,
      kill: dependencies.killProcess || process.kill,
      expectedPid: expectedRuntimePid
    });
    output({ bound: true, reused: decision === ORDINARY_BINDING_DECISIONS.REUSE, binding: state.getBinding(binding.channelId), nativeProof, monitor: { status: 'pending' }, gatewayWake });
    return { binding: state.getBinding(binding.channelId), nativeProof, monitor: { status: 'pending' }, gatewayWake, reused: decision === ORDINARY_BINDING_DECISIONS.REUSE };
  } finally {
    try { await client?.destroy(); } finally { state.close(); }
  }
}

module.exports = { ordinaryBind, ordinaryClaudeBind, resolveCurrentClaudeCaller };
