const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PROVIDERS, validateNativeId } = require('../state');
const { requireInstalled, readSecret } = require('../discord');
const { staticConductorMarker } = require('../topic');
const { validateLegacyMetadata, migrateLegacyTopic, ensureProvisionedChannel } = require('../discord/channel-provisioning');
const { readAdoptionCutoff } = require('../discord/history-access');
const { completeCommandCleanup } = require('./command-cleanup');

function createProvisionCommands({ required, openState, pathsFor, print, cliPath }) {
function migrationRequested(args) {
  return args['migrate-legacy-topic'] === true || args['migrate-legacy-topic'] === 'true';
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
  let hadBodyFailure = false;
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
    // A newly provisioned/adopted channel acquires its boundary from a
    // permission-qualified history read before the active binding is inserted. An
    // empty history legitimately yields "0"; a missing permission or failed request
    // refuses activation. Never inferred from the channel id or creation time.
    const intakeCutoff = await readAdoptionCutoff(result.channel, result.channel.id, client.user);
    const binding = state.bind({ channelId: result.channel.id, guildId: config.guildId, provider, nativeId, workspace, endpoint, categoryId, conductorId, repoKey, generation: legacyMetadata?.generation ?? undefined }, { intakeCutoff, intakeCutoffDetail: 'provisioned binding adoption cutoff' });
    state.completeProvisionIntent(provider, nativeId, result.channel.id, conductorId);
    if (legacyMetadata) await migrateLegacyTopic({ state, channel: result.channel, binding, token });
    print({ created: result.created, adopted: result.adopted, legacy: Boolean(legacyMetadata), migrated: Boolean(legacyMetadata), bound: true, marker: result.channel.topic, conductorId, repoKey, channelId: result.channel.id,
      url: `https://discord.com/channels/${config.guildId}/${result.channel.id}`, binding: state.getBinding(result.channel.id), intent });
  } catch (error) {
    hadBodyFailure = true;
    throw error;
  } finally {
    await completeCommandCleanup([
      () => client?.destroy(),
      () => state.close()
    ], hadBodyFailure);
  }
}

function provision(args) {
  const { stateDir, provisionLock } = pathsFor(args);
  if (process.env.DISCORD_SURFACE_PROVISION_LOCK_HELD === '1') return provisionInternal(args);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const forwarded = Object.entries(args).flatMap(([key, value]) => value === true ? [`--${key}`] : [`--${key}`, String(value)]);
  const result = spawnSync('lockf', ['-t', '0', '-k', provisionLock, process.execPath, cliPath, 'provision-run', ...forwarded], {
    stdio: 'inherit',
    env: { ...process.env, DISCORD_SURFACE_PROVISION_LOCK_HELD: '1' }
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
return { migrationRequested, categoryFor, provisionInternal, provision };
}

module.exports = { createProvisionCommands };
