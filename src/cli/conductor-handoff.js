const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PROVIDERS, validateNativeId } = require('../state');
const { readSecret, requireInstalled } = require('../discord');
const { assertHandoffIntakeCoverage, createHandoffFence, deleteHandoffFence } = require('../discord/handoff-fence');
const { parseLegacyConductorMarker, staticConductorMarker } = require('../topic');
const { legacyAdoptionTopic } = require('../discord/channel-provisioning');

function createConductorHandoff({ required, openState, print, pathsFor, categoryFor, ordinaryHandoffInternal, cliPath }) {
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
    let handoffFence;
    let enrollmentProof = null;
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
      const previous = state.findConductorHandoff(handoffId);
      const hasActiveThreads = state.listThreadEnrollments(channelId).some(enrollment => enrollment.active);
      if (!previous && hasActiveThreads) {
        handoffFence = await createHandoffFence(channel, 'conductor handoff');
        enrollmentProof = await assertHandoffIntakeCoverage(channel, client, state, current, handoffFence.id, 'conductor handoff');
      }
      const binding = state.handoffConductor({ channelId, provider, conductorId, repoKey, fromNativeId, fromGeneration, nativeId, workspace, endpoint, handoffId,
        intakeCutoff: handoffFence?.id || null, enrollmentProof });
      print({ handedOff: true, conductorId, repoKey, channelId, url: `https://discord.com/channels/${config.guildId}/${channelId}`, binding, readiness: binding.readiness });
    } finally {
      await deleteHandoffFence(handoffFence);
      await client?.destroy();
      state.close();
    }
  }

  function handoff(args) {
    const { stateDir, provisionLock } = pathsFor(args);
    if (process.env.DISCORD_SURFACE_PROVISION_LOCK_HELD === '1') return handoffInternal(args);
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const forwarded = Object.entries(args).flatMap(([key, value]) => value === true ? [`--${key}`] : [`--${key}`, String(value)]);
    const result = spawnSync('lockf', ['-t', '0', '-k', provisionLock, process.execPath, cliPath, 'handoff-run', ...forwarded], {
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
    const intakeCutoff = args['intake-cutoff'] || null;
    let enrollmentProof = null;
    if (args['enrollment-proof']) {
      try { enrollmentProof = JSON.parse(args['enrollment-proof']); } catch { throw new Error('invalid --enrollment-proof JSON'); }
    }
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
      const carryAcceptedHuman = process.env.DISCORD_SURFACE_HANDOFF_CARRY_ACCEPTED_HUMAN === '1';
      const binding = state.handoffConductor({ channelId, provider, conductorId, repoKey, fromNativeId, fromGeneration, nativeId, workspace, endpoint, handoffId, intakeCutoff, enrollmentProof, carryAcceptedHuman });
      print({ handedOff: true, reused: false, conductorId, repoKey, channelId, handoffId, url: `https://discord.com/channels/${config.guildId}/${channelId}`, binding, readiness: binding.readiness });
    } finally { state.close(); }
  }

  function handoffGate(args, current, { reuse, sessionFile, workerFile, workspace, endpoint, intakeCutoff = null, enrollmentProof = null }) {
    const paths = pathsFor(args);
    const helperArgs = [
      path.join(path.dirname(cliPath), 'conductor-lock-gate.py'),
      '--lock-script', conductorLockScript(), '--repo', required(args, 'repo'), '--repo-key', required(args, 'repo-key'),
      '--provider', current.provider, '--conductor-id', current.conductorId, '--channel-id', current.channelId,
      '--from-native-id', current.nativeId, '--from-generation', String(current.generation), '--native-id', required(args, 'native-id'),
      '--from-workspace', current.workspace, '--workspace', workspace, '--session-file', sessionFile, '--worker-file', workerFile,
      '--node-path', process.execPath, '--cli-path', cliPath, '--state-dir', paths.stateDir, '--db', paths.db
    ];
    if (current.endpoint) helperArgs.push('--from-endpoint', current.endpoint);
    if (endpoint) helperArgs.push('--endpoint', endpoint);
    if (intakeCutoff) helperArgs.push('--intake-cutoff', intakeCutoff);
    if (enrollmentProof) helperArgs.push('--enrollment-proof', JSON.stringify(enrollmentProof));
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
    let handoffFence;
    let enrollmentProof = null;
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
      if (!reuse && state.listThreadEnrollments(current.channelId).some(enrollment => enrollment.active)) {
        handoffFence = await createHandoffFence(channel, 'conductor handoff');
        enrollmentProof = await assertHandoffIntakeCoverage(channel, client, state, current, handoffFence.id, 'conductor handoff');
      }
      state.close();
      state = null;
      handoffGate({ ...args, repo }, current, { reuse, sessionFile, workerFile, workspace, endpoint, intakeCutoff: handoffFence?.id || null, enrollmentProof });
      return;
    } finally {
      await deleteHandoffFence(handoffFence);
      await client?.destroy();
      state?.close();
    }
  }


  return { handoffInternal, handoff, localHandoff };
}

module.exports = { createConductorHandoff };
