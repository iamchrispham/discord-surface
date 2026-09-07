#!/usr/bin/env node

const fs = require('node:fs');
const { resolveDedupeKey, runDirectPost } = require('./direct-post');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { SurfaceState, PROVIDERS, READINESS, RECOVERY_LIMITS, validateNativeId } = require('./state');
const { DiscordGateway, readSecret, requireInstalled } = require('./discord');
const { createOrdinaryClaudeRequest, createOrdinaryCodexRequestFromEnvironment, ordinaryBindingDecision, resolveExistingChannel, resolveInvocationIdentity } = require('./ordinary-codex');
const { sessionRoot: codexSessionRoot, validateClaudeSessionIdentity, validateCodexSessionIdentity, validateCodexSessionIdentityAsync } = require('./native');
const { ClaudeChannel } = require('./claude-channel');
const { createClaudeMonitor } = require('./claude-monitor');

const GATEWAY_CAPABILITIES = Object.freeze({
  ordinaryBindWake: 'ordinary-bind-wake-v1'
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
  return { stateDir, db, lock: path.join(stateDir, 'runtime.lock'), provisionLock: path.join(stateDir, 'provision.lock'), pid: path.join(stateDir, 'runtime.pid') };
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

function requestGatewayRecovery(paths, { status = gatewayProcessStatus, kill = process.kill } = {}) {
  const runtime = status(paths);
  if (runtime?.state !== 'running' || !runtime.pid) {
    return { requested: false, state: runtime?.state || 'unknown', reason: 'gateway-not-running' };
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
    const validationRoot = sessionRoot ?? existing?.sessionRoot ?? undefined;
    if (!sessionRoot) {
      const proof = await validateNativeProof(validationRoot);
      nativeProofDetail = proof.detail;
      nativeProofError = proof.error;
      resolvedWorkspace = proof.workspace;
    }
    const request = ordinaryBindingArgs(args, environment, channel.id, config.guildId, resolvedWorkspace, sessionRoot);
    if (request.guildId !== config.guildId) throw new Error('ordinary binding guild is not the configured guild');
    const nativeProofEvidence = nativeProofDetail ? { ...nativeProofDetail, sessionRoot: validationRoot } : null;
    let decision = ordinaryBindingDecision(existing, request, existing ? state.isOrdinaryBindingRecord(existing) : false, nativeProofEvidence);
    let adoptionCutoff = null;
    if (decision !== 'reuse' && !existing?.active) {
      const cutoff = await latestChannelMessageId(discordChannel);
      adoptionCutoff = cutoff || serverDerivedChannelCutoff(discordChannel);
    }
    let binding;
    if (decision === 'reuse') binding = existing;
    else if (decision === 'rebind') {
      try {
        binding = state.rebindOrdinary(request, request.identity, nativeProofEvidence, adoptionCutoff);
      } catch (error) {
        const raced = state.getBinding(request.channelId);
        const racedDecision = raced
          ? ordinaryBindingDecision(raced, request, state.isOrdinaryBindingRecord(raced), nativeProofEvidence)
          : null;
        if (racedDecision !== 'reuse') throw error;
        decision = 'reuse';
        binding = raced;
      }
    }
    else {
      try {
        binding = state.bindOrdinary(request, request.identity, adoptionCutoff);
      } catch (error) {
        const raced = state.getBinding(request.channelId);
        const racedDecision = raced
          ? ordinaryBindingDecision(raced, request, state.isOrdinaryBindingRecord(raced), nativeProofEvidence)
          : null;
        if (racedDecision !== 'reuse') throw error;
        decision = 'reuse';
        binding = raced;
      }
    }
    let nativeProof = { status: 'pending', reason: 'Codex transcript proof is pending' };
    if (nativeProofError) {
      const unavailable = state.setBindingReadiness(binding.channelId, READINESS.UNAVAILABLE, nativeProofError.message, binding);
      if (unavailable) binding = unavailable;
      nativeProof = { status: 'pending', reason: nativeProofError.message };
    } else if (state.hasOrdinaryPreflight(binding)) {
      nativeProof = { status: 'verified', reason: 'Codex transcript proof already recorded' };
    } else if (nativeProofDetail) {
      try {
        state.recordOrdinaryPreflight(binding, {
          file: nativeProofDetail.file,
          sessionId: nativeProofDetail.sessionId,
          threadId: nativeProofDetail.threadId,
          workspace: nativeProofDetail.workspace
        });
        nativeProof = { status: 'verified', file: nativeProofDetail.file, workspace: nativeProofDetail.workspace };
      } catch (error) {
        nativeProof = { status: 'pending', reason: error.message };
      }
    } else {
      nativeProof = { status: 'pending', reason: nativeProofError?.message || 'Codex transcript proof is pending' };
    }
    if (decision === 'reuse' && nativeProof.status === 'verified' && nativeProofDetail && !nativeProofError) {
      const watermark = state.getIntakeWatermark(binding.channelId);
      if (watermark && [READINESS.GAP, READINESS.UNAVAILABLE].includes(watermark.state)) {
        const reopened = state.reconcileIntake(binding.channelId, binding);
        if (reopened) binding = state.getBinding(binding.channelId);
      }
    }
    const gatewayWake = requestGatewayRecovery(paths, {
      status: dependencies.gatewayProcessStatus || gatewayProcessStatus,
      kill: dependencies.killProcess || process.kill
    });
    output({ bound: true, reused: decision === 'reuse', binding: state.getBinding(binding.channelId), nativeProof, gatewayWake });
    return { binding: state.getBinding(binding.channelId), nativeProof, gatewayWake, reused: decision === 'reuse' };
  } finally {
    try { await client?.destroy(); } finally { state.close(); }
  }
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
  const { paths, state } = openState(args);
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
    if (args.channel && args['channel-id'] && args.channel !== args['channel-id']) throw new Error('--channel and --channel-id must identify the same channel');
    const endpoint = required(args, args.endpoint ? 'endpoint' : 'socket');
    const transcript = required(args, 'transcript');
    if (!path.isAbsolute(endpoint)) throw new Error('Claude endpoint must be an absolute Unix socket path');
    if (!path.isAbsolute(transcript)) throw new Error('Claude transcript path must be absolute');
    const caller = await resolveCaller();
    if (!caller || caller.harness !== 'claude-code' || typeof caller.sessionId !== 'string') {
      throw new Error('ordinary Claude caller identity is unavailable or uses the wrong harness');
    }
    const sessionId = caller.sessionId;
    const requestedWorkspace = args.workspace === undefined ? undefined : required(args, 'workspace');
    if (requestedWorkspace !== undefined && !path.isAbsolute(requestedWorkspace)) {
      throw new Error('Claude workspace must be absolute');
    }
    const identityProof = validate(sessionId, transcript, requestedWorkspace);
    const request = createOrdinaryClaudeRequest({
      channelId: channelSelection,
      guildId: config.guildId,
      nativeId: args['native-id'],
      workspace: identityProof.workspace,
      endpoint,
      identity: { sessionId, threadId: sessionId, harness: 'claude-code' }
    });
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
    const discordChannel = fetchedChannelObjects.find(candidate => candidate?.id === channel.id);
    const boundRequest = { ...request, channelId: channel.id };
    const existing = state.getBinding(channel.id);
    const decision = ordinaryBindingDecision(existing, boundRequest, existing ? state.isOrdinaryBindingRecord(existing) : false);
    let adoptionCutoff = null;
    if (decision !== 'reuse' && !existing?.active) {
      const cutoff = await latestChannelMessageId(discordChannel);
      adoptionCutoff = cutoff || serverDerivedChannelCutoff(discordChannel);
    }
    let binding;
    if (decision === 'reuse') binding = existing;
    else if (decision === 'rebind') binding = state.rebindOrdinaryClaude(boundRequest, boundRequest.identity, adoptionCutoff);
    else binding = state.bindOrdinaryClaude(boundRequest, boundRequest.identity, adoptionCutoff);
    let nativeProof = { status: 'pending', reason: 'Claude Monitor capability is pending' };
    if (state.hasOrdinaryPreflight(binding)) {
      nativeProof = { status: 'verified', reason: 'Claude transcript proof already recorded' };
    } else {
      state.recordOrdinaryPreflight(binding, {
        file: identityProof.file,
        sessionId: identityProof.sessionId,
        threadId: identityProof.threadId,
        workspace: identityProof.workspace,
        endpoint,
        harness: 'claude-code'
      });
      nativeProof = { status: 'verified', file: identityProof.file, workspace: identityProof.workspace };
    }
    const gatewayWake = requestGatewayRecovery(paths, {
      status: dependencies.gatewayProcessStatus || gatewayProcessStatus,
      kill: dependencies.killProcess || process.kill
    });
    output({ bound: true, reused: decision === 'reuse', binding: state.getBinding(binding.channelId), nativeProof, monitor: { status: 'pending' }, gatewayWake });
    return { binding: state.getBinding(binding.channelId), nativeProof, monitor: { status: 'pending' }, gatewayWake, reused: decision === 'reuse' };
  } finally {
    try { await client?.destroy(); } finally { state.close(); }
  }
}

function unbind(args) {
  const { state } = openState(args);
  try { print({ unbound: state.unbind(required(args, 'channel-id')) }); }
  finally { state.close(); }
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
  const validationRoot = requestedSessionRoot || (dependencies.codexSessionRoot || codexSessionRoot)();
  const { paths, state } = openState(args);
  let client;
  try {
    const config = state.requireConfig();
    const current = state.getBinding(channelId);
    if (!current || current.provider !== PROVIDERS.CODEX || current.conductorId || current.repoKey) {
      throw new Error('ordinary handoff source is unavailable');
    }
    const invocation = resolveInvocationIdentity(environment, workspace);
    if (invocation.sessionId !== nativeId || invocation.threadId !== nativeId) {
      throw new Error('ordinary handoff successor identity does not match the native UUID');
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
    let adoptionCutoff = null;
    if (!current.active) {
      const cutoff = await latestChannelMessageId(channel);
      adoptionCutoff = cutoff || serverDerivedChannelCutoff(channel);
    }
    const binding = state.handoffOrdinary({
      channelId, provider, fromNativeId, fromGeneration, nativeId, workspace,
      sessionRoot: validationRoot, handoffId, intakeCutoff: adoptionCutoff,
      identity: { sessionId: nativeProof.sessionId, threadId: nativeProof.threadId },
      nativeProof: { ...nativeProof, sessionRoot: validationRoot }
    });
    const gatewayWake = wake(paths, {
      status: dependencies.gatewayProcessStatus || gatewayProcessStatus,
      kill: dependencies.killProcess || process.kill
    });
    output({ handedOff: true, ordinary: true, channelId, handoffId,
      url: `https://discord.com/channels/${config.guildId}/${channelId}`, binding,
      readiness: binding.readiness, gatewayWake });
    return { binding, gatewayWake, handoffReconciled: Boolean(binding.handoffReconciled) };
  } finally {
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

function writePid(pidFile, guildId, stateDir) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pidFile, JSON.stringify({
    pid: process.pid,
    guildId,
    stateDir,
    command: 'run',
    startedAt: new Date().toISOString(),
    capabilities: [GATEWAY_CAPABILITIES.ordinaryBindWake]
  }), { mode: 0o600 });
  fs.chmodSync(pidFile, 0o600);
}

function createBindingWakeController({ getGateway, isReady, isStopping, logger = error => process.stderr.write(`discord-surface: ordinary binding recovery failed: ${error.message}\n`) } = {}) {
  let wakePromise = null;
  let wakeRequested = false;
  const request = () => {
    wakeRequested = true;
    const gateway = getGateway?.();
    if (isStopping?.() || !gateway || !isReady?.() || wakePromise) return;
    wakePromise = (async () => {
      while (wakeRequested && !isStopping?.()) {
        wakeRequested = false;
        const currentGateway = getGateway?.();
        if (!currentGateway || !isReady?.()) return;
        const joinedRecovery = Boolean(currentGateway.recoveryPromise);
        const recovery = await currentGateway.recoverTransport('ordinary-bind');
        if (joinedRecovery) {
          wakeRequested = true;
          continue;
        }
        if (!isStopping?.() && isReady?.()) await currentGateway.reconcilePending();
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
  state.recoverAfterRestart();
  let gateway;
  let gatewayReady = false;
  let stopping = false;
  const bindingWake = createBindingWakeController({
    getGateway: () => gateway,
    isReady: () => gatewayReady,
    isStopping: () => stopping
  });
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const pendingBindingWake = bindingWake.wait();
    try { await gateway?.stop(); } finally {
      await pendingBindingWake;
      try { fs.unlinkSync(paths.pid); } catch {}
      process.removeListener('SIGUSR2', bindingWake.request);
      state.close();
    }
  };
  process.once('SIGINT', () => stop().then(() => process.exit(0)));
  process.once('SIGTERM', () => stop().then(() => process.exit(0)));
  process.on('SIGUSR2', bindingWake.request);
  try {
    writePid(paths.pid, config.guildId, paths.stateDir);
    gateway = new DiscordGateway({ state, observeOptions: { timeoutMs: Number(args['reply-timeout-ms'] || 120000) } });
    await gateway.start(config.secretFile);
    await gateway.reconcilePending(recoveryCutoff);
    gatewayReady = true;
    bindingWake.start();
  } catch (error) {
    await stop();
    throw error;
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
  const startupBinding = state.findNativeBinding(nativeId, PROVIDERS.CLAUDE);
  const ordinaryStartupBinding = startupBinding?.active && state.isOrdinaryBinding(startupBinding) ? startupBinding : null;
  let monitor;
  let stopPromise;
  const revokeOrdinaryReadiness = () => {
    if (!ordinaryStartupBinding) return;
    const current = state.getBinding(ordinaryStartupBinding.channelId);
    if (!current || !current.active || current.provider !== PROVIDERS.CLAUDE || current.nativeId !== ordinaryStartupBinding.nativeId ||
      current.workspace !== ordinaryStartupBinding.workspace || current.endpoint !== ordinaryStartupBinding.endpoint) return;
    state.setBindingReadiness(ordinaryStartupBinding.channelId, READINESS.UNAVAILABLE, 'Claude Monitor unavailable', ordinaryStartupBinding);
  };
  const stop = async () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      try {
        revokeOrdinaryReadiness();
        await monitor?.stop();
      } finally { state.close(); }
    })();
    return stopPromise;
  };
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
    await monitor.start();
    if (ordinaryStartupBinding) requestGatewayRecovery(paths);
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

async function directPost(args, provider = null, ordinary = false) {
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
    const dedupeKey = resolveDedupeKey({ dedupeKey: args['dedupe-key'], requestId: args['request-id'] }, { required: true });
    const nativeId = required(args, 'native-id');
    const generation = required(args, 'generation');
    const channelId = ordinary ? required(args, 'channel-id') : (args['channel-id'] || null);
    if (ordinary) {
      const invocation = resolveInvocationIdentity(process.env);
      const binding = state.getBinding(channelId);
      if (nativeId !== invocation.sessionId || invocation.threadId !== invocation.sessionId ||
        !binding?.active || !state.isOrdinaryBindingRecord(binding) || binding.nativeId !== invocation.sessionId ||
        Number(binding.generation) !== Number(generation)) {
        throw new Error('ordinary post identity does not match the active Codex binding');
      }
    }
    const result = await runDirectPost({
      state,
      token: readSecret(config.secretFile),
      nativeId,
      generation,
      channelId,
      provider,
      textFile: required(args, 'text-file'),
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

function pidMatches(value, stateDir, command) {
  if (!value || value.command !== 'run' || value.stateDir !== stateDir) return false;
  try {
    const actualCommand = (command ?? readProcessCommand(value.pid)).trim();
    const expectedPrefix = `${process.execPath} ${__filename} run --state-dir ${stateDir}`;
    return actualCommand === expectedPrefix || actualCommand.startsWith(`${expectedPrefix} --db `);
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
  if (!pidMatches(value, paths.stateDir, command)) {
    return { state: 'unknown', pid: runtimePid, connection: 'unknown', reason: 'pid-owner-mismatch' };
  }
  return {
    state: 'running',
    pid: runtimePid,
    connection: 'unverified-live',
    guildId: value.guildId,
    stateDir: value.stateDir,
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
  const { stateDir, pid } = pathsFor(args);
  if (!fs.existsSync(pid)) return print({ stopped: false, reason: 'not-running' });
  let value;
  try { value = JSON.parse(fs.readFileSync(pid, 'utf8')); } catch { throw new Error('runtime pid file is corrupt'); }
  const runtimePid = Number(value.pid);
  if (!Number.isInteger(runtimePid) || runtimePid < 1) throw new Error('runtime pid file has an invalid owner');
  if (!pidMatches(value, stateDir)) {
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
    case 'ordinary-bind': return ordinaryBind(args);
    case 'ordinary-claude-bind': return ordinaryClaudeBind(args);
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
    case 'post': return directPost(args);
    case 'ordinary-post': return directPost(args, 'codex', true);
    case 'ordinary-claude-post': return directPost(args, 'claude', true);
    case 'claude-post': return directPost(args, 'claude');
    case 'liaison':
      if (subcommand !== 'draft') throw new Error('usage: liaison draft --receipt-id RECEIPT_ID');
      return liaisonDraft(args);
    default: throw new Error('usage: configure, bind, ordinary-bind, ordinary-claude-bind, rebind, unbind, status, recover, provision, handoff, start, stop, claude-channel, claude-monitor, native-ack, claude-reply, post, ordinary-post, ordinary-claude-post, claude-post, liaison draft');
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`discord-surface: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { bindingArgs, claudeMonitor, claudeReply, conductorMarker, createBindingWakeController, directPost, ensureProvisionedChannel, GATEWAY_CAPABILITIES, gatewayProcessStatus, handoffInternal, liaisonDraft, main, migrateLegacyTopic, ordinaryBind, ordinaryClaudeBind, ordinaryBindingArgs, parseArgs, pathsFor, provisionMarker, requestGatewayRecovery, resolveCurrentClaudeCaller };
