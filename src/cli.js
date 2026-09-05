#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { SurfaceState, PROVIDERS, READINESS, validateNativeId } = require('./state');
const { DiscordGateway, readSecret, requireInstalled, topicPublicationOutcome } = require('./discord');
const { ClaudeChannel } = require('./claude-channel');
const { conductorMarkerMatches: matchesTopicMarker, topicPresentation } = require('./topic');

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
  return { command: positional[0], args };
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

function unbind(args) {
  const { state } = openState(args);
  try { print({ unbound: state.unbind(required(args, 'channel-id')) }); }
  finally { state.close(); }
}

function status(args) {
  const { state } = openState(args);
  try { print({ config: state.getConfig(), readiness: state.getReadiness(), bindings: state.listBindings(), messages: state.listMessages(), receipts: state.listReceipts() }); }
  finally { state.close(); }
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
  const marker = `discord-surface:v2 conductor=${encodeURIComponent(conductorId)} provider=${provider} repo=${encodeURIComponent(repoKey)} native=${nativeId} generation=${generation} readiness=${readiness}`;
  if (marker.length > 1024) throw new Error('conductor channel topic marker exceeds Discord topic limit');
  return marker;
}

function legacyAdoptionTopic(topic, provider, nativeId) {
  const base = topicPresentation(topic).base;
  return base === provisionMarker(provider, nativeId) || base === `Conductor task: ${provider}/${nativeId}`;
}

function conductorMarkerMatches(topic, expected) {
  return matchesTopicMarker(topic, expected);
}

async function setChannelTopic(channel, topic) {
  if (channel.topic === topic) return channel;
  if (typeof channel.setTopic === 'function') await channel.setTopic(topic);
  else if (typeof channel.edit === 'function') await channel.edit({ topic });
  else channel.topic = topic;
  if (channel.topic !== topic) throw new Error('Discord channel topic readback mismatch');
  return channel;
}

async function publishHandoffTopic(state, channel, topic, binding) {
  if (channel.topic === topic) return null;
  const custody = state.beginTopicPublication(binding.channelId, {
    desiredReadiness: binding.readiness,
    desiredTopic: topic
  }, binding);
  if (!custody) throw new Error('handoff topic binding changed before publication');
  try {
    await setChannelTopic(channel, topic);
    state.recordTopicPublication(binding.channelId, {
      requestId: custody.requestId,
      desiredReadiness: binding.readiness,
      outcome: 'published',
      publishedReadiness: binding.readiness,
      observedTopic: channel.topic,
      remoteTerminal: true
    }, binding);
    return custody;
  } catch (error) {
    const outcome = topicPublicationOutcome(error);
    state.recordTopicPublication(binding.channelId, {
      requestId: custody.requestId,
      desiredReadiness: binding.readiness,
      outcome,
      publicationUnknown: outcome === 'unknown',
      remoteTerminal: outcome === 'rate_limited' || outcome === 'rejected',
      observedTopic: channel.topic,
      error: error.message
    }, binding);
    throw error;
  }
}

async function ensureProvisionedChannel({ guild, provider, nativeId, categoryId, taskName, conductorId, repoKey, generation = 1, readiness = READINESS.PENDING, channelId = null, allowCreate = true }) {
  if (provider !== PROVIDERS.CODEX && provider !== PROVIDERS.CLAUDE) throw new Error('unsupported provider');
  validateNativeId(nativeId);
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
      const v2Match = conductorMarkerMatches(channel.topic, { provider, nativeId, conductorId, repoKey, generation });
      const legacyMatch = legacyAdoptionTopic(channel.topic, provider, nativeId);
      if (!v2Match && !legacyMatch) throw new Error('requested adoption channel metadata does not match the native identity');
      adopted = legacyMatch;
      if (v2Match) return { channel, created: false, adopted, marker };
    }
    await setChannelTopic(channel, marker);
    return { channel, created: false, adopted, marker };
  }
  marked = channels.filter(channel => channel.topic === marker || conductorMarkerMatches(channel.topic, { provider, nativeId, conductorId, repoKey, generation }));
  if (marked.length > 1) throw new Error('duplicate provision markers require reconciliation');
  const existingMarker = marked[0];
  if (existingMarker && existingMarker.parentId !== categoryId) throw new Error('provision marker exists under the wrong category');
  const existing = existingMarker;
  if (existing) return { channel: existing, created: false, marker: existing.topic };
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
      state.assertTopicPublicationSettled(existingBinding.channelId);
      if (existingBinding.repoKey !== repoKey || existingBinding.nativeId !== nativeId || existingBinding.workspace !== workspace || existingBinding.endpoint !== (endpoint || null)) {
        throw new Error('existing conductor binding does not match requested identity; use explicit handoff for a successor');
      }
      const marker = conductorMarker({ provider, nativeId, conductorId, repoKey, generation: existingBinding.generation, readiness: existingBinding.readiness });
      const { Client, GatewayIntentBits } = requireInstalled('discord.js');
      client = new Client({ intents: [GatewayIntentBits.Guilds] });
      await client.login(readSecret(config.secretFile));
      const guild = await client.guilds.fetch(config.guildId);
      const boundChannel = await guild.channels.fetch(existingBinding.channelId);
      if (!boundChannel || boundChannel.parentId !== categoryId || !conductorMarkerMatches(boundChannel.topic, { provider, nativeId, conductorId, repoKey, generation: existingBinding.generation })) {
        throw new Error('existing conductor channel does not match requested metadata');
      }
      print({ created: false, adopted: false, bound: true, marker, conductorId, repoKey, channelId: existingBinding.channelId, url: `https://discord.com/channels/${config.guildId}/${existingBinding.channelId}`, binding: existingBinding });
      return;
    }
    const marker = conductorMarker({ provider, nativeId, conductorId, repoKey });
    const intent = state.beginProvisionIntent({ provider, nativeId, conductorId, repoKey, guildId: config.guildId, categoryId, workspace, endpoint, marker, taskName });
    const { Client, GatewayIntentBits } = requireInstalled('discord.js');
    client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(readSecret(config.secretFile));
    const guild = await client.guilds.fetch(config.guildId);
    const result = await ensureProvisionedChannel({ guild, provider, nativeId, categoryId, taskName, conductorId, repoKey, channelId: args['channel-id'] || intent.channel_id, allowCreate: intent.fresh });
    const existingNativeBinding = state.findNativeBinding(nativeId, provider);
    if (existingNativeBinding) {
      if (!existingNativeBinding.active || existingNativeBinding.provider !== provider || existingNativeBinding.workspace !== workspace || existingNativeBinding.endpoint !== (endpoint || null) || existingNativeBinding.conductorId !== conductorId || existingNativeBinding.repoKey !== repoKey) {
        throw new Error('existing native binding does not match requested provision identity');
      }
      if (existingNativeBinding.channelId !== result.channel.id) {
        throw new Error('native session is already bound to another conductor channel');
      }
      state.completeProvisionIntent(provider, nativeId, existingNativeBinding.channelId, conductorId);
      print({ created: false, adopted: result.adopted, bound: true, marker, conductorId, repoKey, channelId: existingNativeBinding.channelId, url: `https://discord.com/channels/${config.guildId}/${existingNativeBinding.channelId}`, binding: existingNativeBinding, intent });
      return;
    }
    const binding = state.bind({ channelId: result.channel.id, guildId: config.guildId, provider, nativeId, workspace, endpoint, categoryId, conductorId, repoKey });
    state.completeProvisionIntent(provider, nativeId, result.channel.id, conductorId);
    print({ created: result.created, adopted: result.adopted, bound: true, marker: result.marker, conductorId, repoKey, channelId: result.channel.id,
      url: `https://discord.com/channels/${config.guildId}/${result.channel.id}`, binding, intent });
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

async function handoffInternal(args) {
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
    const oldTopicMatches = conductorMarkerMatches(channel.topic, { provider, nativeId: fromNativeId, conductorId, repoKey, generation: fromGeneration }) || legacyAdoptionTopic(channel.topic, provider, fromNativeId);
    const successorTopicMatches = current && current.generation === fromGeneration + 1 && current.nativeId === nativeId &&
      conductorMarkerMatches(channel.topic, { provider, nativeId, conductorId, repoKey, generation: current.generation });
    if (!oldTopicMatches && !successorTopicMatches) throw new Error('handoff channel topic does not match the requested source or exact successor');
    let binding;
    try {
      binding = state.handoffConductor({ channelId, provider, conductorId, repoKey, fromNativeId, fromGeneration, nativeId, workspace, endpoint, handoffId });
      const marker = conductorMarker({ provider, nativeId, conductorId, repoKey, generation: binding.generation, readiness: binding.readiness });
      await publishHandoffTopic(state, channel, marker, binding);
    } catch (error) {
      if (binding) state.auditReceipt(null, 'handoff-topic-failed', { channelId, conductorId, provider, handoffId, nativeId, error: error.message });
      throw error;
    }
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

function writePid(pidFile, guildId, stateDir) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, guildId, stateDir, command: 'run', startedAt: new Date().toISOString() }), { mode: 0o600 });
  fs.chmodSync(pidFile, 0o600);
}

async function runRuntime(args) {
  const { paths, state } = openState(args);
  const config = state.requireConfig();
  const recoveryCutoff = new Date().toISOString();
  state.recoverAfterRestart();
  writePid(paths.pid, config.guildId, paths.stateDir);
  let gateway;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await gateway?.stop(); } finally {
      try { fs.unlinkSync(paths.pid); } catch {}
      state.close();
    }
  };
  process.once('SIGINT', () => stop().then(() => process.exit(0)));
  process.once('SIGTERM', () => stop().then(() => process.exit(0)));
  try {
    gateway = new DiscordGateway({ state, observeOptions: { timeoutMs: Number(args['reply-timeout-ms'] || 120000) } });
    await gateway.start(config.secretFile);
    await gateway.reconcilePending(recoveryCutoff);
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

function pidMatches(value, stateDir) {
  if (!value || value.command !== 'run' || value.stateDir !== stateDir) return false;
  try {
    const command = execFileSync('ps', ['-p', String(value.pid), '-o', 'command='], { encoding: 'utf8' });
    return command.includes(__filename) && command.includes(' run ') && command.includes(stateDir);
  } catch { return false; }
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
  const { command, args } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'configure': return configure(args);
    case 'bind': return bind(args);
    case 'rebind': return bind(args, true);
    case 'unbind': return unbind(args);
    case 'status': return status(args);
    case 'recover': return recover(args);
    case 'provision': return provision(args);
    case 'provision-run':
      if (process.env.DISCORD_SURFACE_PROVISION_LOCK_HELD !== '1') throw new Error('provision-run is internal; use provision so the singleton lock is held');
      return provisionInternal(args);
    case 'handoff': return handoff(args);
    case 'handoff-run':
      if (process.env.DISCORD_SURFACE_PROVISION_LOCK_HELD !== '1') throw new Error('handoff-run is internal; use handoff so the singleton lock is held');
      return handoffInternal(args);
    case 'start': return start(args);
    case 'run':
      if (process.env.DISCORD_SURFACE_LOCK_HELD !== '1') throw new Error('run is internal; use start so the singleton lock is held');
      return runRuntime(args);
    case 'stop': return stop(args);
    case 'claude-channel': return claudeChannel(args);
    default: throw new Error('usage: configure, bind, rebind, unbind, status, recover, provision, handoff, start, stop, claude-channel');
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`discord-surface: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { bindingArgs, conductorMarker, ensureProvisionedChannel, handoffInternal, main, parseArgs, pathsFor, provisionMarker, publishHandoffTopic, setChannelTopic };
