#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { SurfaceState, PROVIDERS, validateNativeId } = require('./state');
const { DiscordGateway, readSecret, requireInstalled } = require('./discord');
const { ClaudeChannel } = require('./claude-channel');

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
    categoryId: args['category-id']
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
    if (args['message-id'] && args.resolution) print(state.reconcileUncertain(required(args, 'message-id'), args.resolution));
    else print(state.recoverAfterRestart());
  }
  finally { state.close(); }
}

function provisionMarker(provider, nativeId) {
  return `discord-surface:v1 provider=${provider} native=${nativeId}`;
}

async function ensureProvisionedChannel({ guild, provider, nativeId, categoryId, taskName }) {
  if (provider !== PROVIDERS.CODEX && provider !== PROVIDERS.CLAUDE) throw new Error('unsupported provider');
  validateNativeId(nativeId);
  if (typeof categoryId !== 'string' || !categoryId) throw new Error('categoryId is required');
  const marker = provisionMarker(provider, nativeId);
  if (typeof guild.channels?.fetch === 'function') await guild.channels.fetch();
  const channels = guild.channels?.cache ? [...guild.channels.cache.values()] : [];
  const marked = channels.filter(channel => channel.topic === marker);
  if (marked.length > 1) throw new Error('duplicate provision markers require reconciliation');
  const existingMarker = marked[0];
  if (existingMarker && existingMarker.parentId !== categoryId) throw new Error('provision marker exists under the wrong category');
  const existing = existingMarker;
  if (existing) return { channel: existing, created: false, marker };
  const type = requireInstalled('discord.js').ChannelType.GuildText;
  const presentationName = typeof taskName === 'string' && taskName ? taskName : `${provider}-${nativeId.slice(0, 8)}`;
  const channel = await guild.channels.create({
    name: presentationName.slice(0, 100),
    type,
    parent: categoryId,
    topic: marker,
    reason: 'Create an explicitly bound native Discord surface'
  });
  return { channel, created: true, marker };
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
    const marker = provisionMarker(provider, nativeId);
    const intent = state.beginProvisionIntent({ provider, nativeId, guildId: config.guildId, categoryId, workspace, endpoint, marker, taskName });
    const { Client, GatewayIntentBits } = requireInstalled('discord.js');
    client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(readSecret(config.secretFile));
    const guild = await client.guilds.fetch(config.guildId);
    const result = await ensureProvisionedChannel({ guild, provider, nativeId, categoryId, taskName });
    const existingBinding = state.findNativeBinding(nativeId, provider);
    if (existingBinding) {
      if (!existingBinding.active || existingBinding.provider !== provider || existingBinding.workspace !== workspace || existingBinding.endpoint !== (endpoint || null)) {
        throw new Error('existing native binding does not match requested provision identity');
      }
      const boundChannel = await guild.channels.fetch(existingBinding.channelId);
      if (!boundChannel || boundChannel.parentId !== categoryId || boundChannel.topic !== marker) {
        throw new Error('existing bound channel does not match requested provider category marker');
      }
      state.completeProvisionIntent(provider, nativeId, existingBinding.channelId);
      print({ created: false, bound: true, marker, channelId: existingBinding.channelId, url: `https://discord.com/channels/${config.guildId}/${existingBinding.channelId}`, binding: existingBinding, intent });
      return;
    }
    const binding = state.bind({ channelId: result.channel.id, guildId: config.guildId, provider, nativeId, workspace, endpoint, categoryId });
    state.completeProvisionIntent(provider, nativeId, result.channel.id);
    print({ created: result.created, bound: true, marker: result.marker, channelId: result.channel.id,
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
  const result = spawnSync('lockf', ['-n', provisionLock, process.execPath, __filename, 'provision-run', ...forwarded], {
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
  const result = spawnSync('lockf', ['-n', guildLock, 'lockf', '-n', lock, ...runArgs], {
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
    case 'start': return start(args);
    case 'run':
      if (process.env.DISCORD_SURFACE_LOCK_HELD !== '1') throw new Error('run is internal; use start so the singleton lock is held');
      return runRuntime(args);
    case 'stop': return stop(args);
    case 'claude-channel': return claudeChannel(args);
    default: throw new Error('usage: configure, bind, rebind, unbind, status, recover, provision, start, stop, claude-channel');
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`discord-surface: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { bindingArgs, ensureProvisionedChannel, main, parseArgs, pathsFor, provisionMarker };
