#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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
  return { stateDir, db, lock: path.join(stateDir, 'runtime.lock'), pid: path.join(stateDir, 'runtime.pid') };
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
    print(state.setConfig({ operatorId: required(args, 'operator-id'), guildId: required(args, 'guild-id'), secretFile }));
  } finally { state.close(); }
}

function bindingArgs(args) {
  return {
    channelId: required(args, 'channel-id'),
    guildId: required(args, 'guild-id'),
    provider: required(args, 'provider'),
    nativeId: required(args, 'native-id'),
    workspace: path.resolve(required(args, 'workspace')),
    endpoint: args.endpoint ? path.resolve(args.endpoint) : undefined
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
  try { print({ config: state.getConfig(), bindings: state.listBindings(), messages: state.listMessages(), receipts: state.listReceipts() }); }
  finally { state.close(); }
}

function recover(args) {
  const { state } = openState(args);
  try { print(state.recoverAfterRestart()); }
  finally { state.close(); }
}

function provisionMarker(provider, nativeId) {
  return `discord-surface:v1 provider=${provider} native=${nativeId}`;
}

async function ensureProvisionedChannel({ guild, provider, nativeId, categoryId }) {
  if (provider !== PROVIDERS.CODEX && provider !== PROVIDERS.CLAUDE) throw new Error('unsupported provider');
  validateNativeId(nativeId);
  if (typeof categoryId !== 'string' || !categoryId) throw new Error('categoryId is required');
  const marker = provisionMarker(provider, nativeId);
  if (typeof guild.channels?.fetch === 'function') await guild.channels.fetch();
  const channels = guild.channels?.cache ? [...guild.channels.cache.values()] : [];
  const existing = channels.find(channel => channel.parentId === categoryId && channel.topic === marker);
  if (existing) return { channel: existing, created: false, marker };
  const type = requireInstalled('discord.js').ChannelType.GuildText;
  const channel = await guild.channels.create({
    name: `${provider}-${nativeId.slice(0, 8)}`,
    type,
    parent: categoryId,
    topic: marker,
    reason: 'Create an explicitly bound native Discord surface'
  });
  return { channel, created: true, marker };
}

async function provision(args) {
  const { state } = openState(args);
  const provider = required(args, 'provider');
  const nativeId = required(args, 'native-id');
  validateNativeId(nativeId);
  if (provider === PROVIDERS.CLAUDE && !args.endpoint) throw new Error('Claude provisioning requires --endpoint');
  const workspace = path.resolve(required(args, 'workspace'));
  const endpoint = args.endpoint ? path.resolve(args.endpoint) : undefined;
  const existingBinding = state.findNativeBinding(nativeId);
  if (existingBinding) {
    try {
      if (existingBinding.provider !== provider) throw new Error('native session is already bound to another provider');
      print({ created: false, bound: true, binding: existingBinding });
      return;
    } finally { state.close(); }
  }
  let config;
  try { config = state.requireConfig(); } catch (error) { state.close(); throw error; }
  const { Client, GatewayIntentBits } = requireInstalled('discord.js');
  let client;
  try {
    client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(readSecret(config.secretFile));
    const guild = await client.guilds.fetch(config.guildId);
    const result = await ensureProvisionedChannel({ guild, provider, nativeId, categoryId: required(args, 'category-id') });
    const binding = state.bind({
      channelId: result.channel.id,
      guildId: config.guildId,
      provider,
      nativeId,
      workspace,
      endpoint
    });
    print({ created: result.created, bound: true, marker: result.marker, channelId: result.channel.id,
      url: `https://discord.com/channels/${config.guildId}/${result.channel.id}`, binding });
  } finally {
    await client?.destroy();
    state.close();
  }
}

function writePid(pidFile) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  fs.chmodSync(pidFile, 0o600);
}

async function runRuntime(args) {
  const { paths, state } = openState(args);
  const config = state.requireConfig();
  state.recoverAfterRestart();
  writePid(paths.pid);
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
  } catch (error) {
    await stop();
    throw error;
  }
  await new Promise(() => {});
}

function start(args) {
  const { stateDir, lock } = pathsFor(args);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const result = spawnSync('lockf', ['-n', lock, process.execPath, __filename, 'run', '--state-dir', stateDir, ...(args.db ? ['--db', path.resolve(args.db)] : [])], {
    stdio: 'inherit',
    env: { ...process.env, DISCORD_SURFACE_LOCK_HELD: '1' }
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

async function claudeChannel(args) {
  const { state } = openState(args);
  let channel;
  const stop = async () => {
    try { await channel?.stop(); } finally { state.close(); }
  };
  process.once('SIGINT', () => stop().then(() => process.exit(0)));
  process.once('SIGTERM', () => stop().then(() => process.exit(0)));
  try {
    channel = new ClaudeChannel({ state, nativeId: required(args, 'native-id'), socketPath: path.resolve(required(args, 'socket')) });
    await channel.start();
  }
  catch (error) { await stop(); throw error; }
}

function stop(args) {
  const { pid } = pathsFor(args);
  if (!fs.existsSync(pid)) return print({ stopped: false, reason: 'not-running' });
  const value = JSON.parse(fs.readFileSync(pid, 'utf8'));
  try { process.kill(Number(value.pid), 'SIGTERM'); print({ stopped: true, pid: Number(value.pid) }); }
  catch (error) {
    if (error.code === 'ESRCH') { fs.unlinkSync(pid); print({ stopped: false, reason: 'stale-pid' }); return; }
    throw error;
  }
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
    case 'start': return start(args);
    case 'run': return runRuntime(args);
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
