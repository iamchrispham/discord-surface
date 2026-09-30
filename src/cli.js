#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Hook startup failures must block the tool, including a missing runtime build.
let startup;
try { startup = parseArgs(process.argv.slice(2)); }
catch (error) { startup = { command: error.command, args: {}, error }; }
if (require.main === module && startup.command === 'courier-guard' && startup.args.help !== true) {
  try {
    require('./courier-guard').courierGuard(startup.args, pathsFor, startup.error);
  } catch (error) {
    process.stderr.write(`discord-surface courier guard: ${error.message}\n`);
    process.exitCode = 2;
  }
  return;
}

const { createGatewayProcessInspection } = require('./cli/gateway-process');
const { createOrdinaryHandoff } = require('./cli/ordinary-handoff');
const { createConductorHandoff } = require('./cli/conductor-handoff');
const { gatewayProcessStatus, pidMatches, waitForExit } = createGatewayProcessInspection(__filename);
const createClaudeListeners = require('./cli/claude-listeners');
const { AGENT_MESSAGE_MAX_ENCODED_LENGTH, issueAgentAddress } = require('./agent-message');
const { resolveAgentAddress, resolveDedupeKey, resolveDirectBinding, runDirectPost, runWatcherNoticePost } = require('./direct-post');
const { runBoardRefresh } = require('./board-refresh');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { SurfaceState, BindingError, PROVIDERS, READINESS, RECOVERY_LIMITS, BOARD_OUTCOMES, validateNativeId } = require('./state');
const { DiscordGateway, discordIdAfter, readSecret, requireInstalled, waitForRecoveryOperation } = require('./discord');
const { enrollPublicThread } = require('./discord/thread-enrollment');
const { readAdoptionCutoff } = require('./discord/history-access');
const {
  assertOrdinaryIntakeRange,
  assertHandoffIntakeCoverage,
  createHandoffFence,
  deleteHandoffFence
} = require('./discord/handoff-fence');
const {
  createOrdinaryClaudeRequest,
  resolveExistingChannel,
  resolveInvocationIdentity
} = require('./ordinary-codex');
const { validateClaudeSessionIdentity, validateCodexSessionIdentity, validateCodexSessionIdentityAsync } = require('./native');
const { ordinaryBind, ordinaryBindingArgs, NATIVE_PROOF_STATUSES, ORDINARY_CODEX_RUNTIME_PID_ENV } = require('./ordinary-bind/codex');
const { ordinaryClaudeBind: runOrdinaryClaudeBind } = require('./ordinary-bind');
const { GATEWAY_CAPABILITIES } = require('./ordinary-bind/constants');

const ORDINARY_CLAUDE_RUNTIME_PID_ENV = 'DISCORD_SURFACE_ORDINARY_CLAUDE_RUNTIME_PID';
const LOCK_CONTENTION_EXIT = 75;
const { runLiaisonDraft } = require('./liaison');
const { recordNativeAcknowledgment } = require('./acknowledgment');
const { parseLegacyConductorMarker, staticConductorMarker } = require('./topic');
const { provisionMarker, conductorMarker, legacyAdoptionTopic, validateLegacyMetadata, migrateLegacyTopic, ensureProvisionedChannel } = require('./discord/channel-provisioning');

function parseArgs(argv) {
  const args = {};
  const positional = [];
  let repeated = null;
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const raw = value.slice(2);
    const equalsIndex = raw.indexOf('=');
    const key = equalsIndex === -1 ? raw : raw.slice(0, equalsIndex);
    const inline = equalsIndex === -1 ? undefined : raw.slice(equalsIndex + 1);
    if (repeated === null && Object.hasOwn(args, key)) repeated = key;
    let parsedValue;
    if (inline !== undefined) parsedValue = inline;
    // Keep single-dash tokens visible to the positional-option guard; use --flag=-value when a dash-prefixed value is intentional.
    else if (argv[i + 1] && !argv[i + 1].startsWith('--') && !/^-[^-]/.test(argv[i + 1])) parsedValue = argv[++i];
    else parsedValue = true;
    // Keep --__proto__ enumerable so the command policy can reject it.
    Object.defineProperty(args, key, { value: parsedValue, enumerable: true, configurable: true, writable: true });
  }
  // Every flag is single-valued, so a repeat is refused rather than letting the last one win.
  // The scan finishes first so the refusal still names the command, wherever the repeat sits.
  if (repeated !== null) {
    throw Object.assign(new Error(`--${repeated} was given more than once; each flag takes one value`), { command: positional[0] });
  }
  const command = positional[0];
  const optionLikePositional = positional.find(token => /^-[^-]/.test(token));
  if (optionLikePositional !== undefined) {
    throw Object.assign(new Error(`unknown option ${optionLikePositional} for ${command}`), { command });
  }

  // Reject flags the selected command does not consume here, before state, custody,
  // or network work. `help`/`--help` is read-only and bypasses this after the repeat
  // check. The error carries .command so the courier-guard startup path keeps its
  // existing deny JSON and exit code 2. The policy module is loaded lazily so the hook
  // entrypoint can still emit its own startup denial from a degraded checkout that is
  // missing build companions; if the policy module itself is absent there, the hook
  // still fails closed by only accepting its own flags.
  let policy;
  try {
    policy = require('./cli/flag-policy');
  } catch (error) {
    if (command !== 'courier-guard') throw error;
    policy = {
      validateFlags: ({ args }) => {
        const unknown = Object.keys(args).find(key => !['courier-route-id', 'state-dir', 'db', 'help'].includes(key));
        if (unknown !== undefined) {
          throw Object.assign(new Error(`unknown --${unknown} for courier-guard`), { command: 'courier-guard' });
        }
        if (Object.hasOwn(args, 'help') && args.help !== true) {
          throw Object.assign(new Error('--help takes no value'), { command: 'courier-guard' });
        }
      }
    };
  }
  if (policy) policy.validateFlags({ command, subcommand: positional[1], args });
  return { command, subcommand: positional[1], args };
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

function resolveCourierRoute(state, args) {
  if (!Object.hasOwn(args, 'courier-route-id')) return null;
  const routeId = required(args, 'courier-route-id');
  const route = state.getCourierRoute(routeId);
  if (!route) throw new Error(`courier route is unknown: ${routeId}`);
  return { routeId };
}

function openState(args) {
  const paths = pathsFor(args);
  return { paths, state: new SurfaceState(paths.db) };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const ordinaryHandoffInternal = createOrdinaryHandoff({ required, openState, requestGatewayRecovery, print, gatewayProcessStatus, acquireHeldLockUntilAvailable });

const GENERAL_USAGE = `Usage: discord-surface <command> [options]

Commands: mcp, configure, bind, ordinary-bind, ordinary-claude-bind, rebind, unbind,
status, recover, board-refresh, thread-enroll, provision, handoff, start, stop,
claude-channel, claude-monitor, native-ack, native-reply, claude-reply, agent-address,
agent-send, agent-complete, agent-withdraw, watcher-arm, watcher-send, watcher-consume, post, ordinary-post, ordinary-claude-post, claude-post,
post-file-cleanup,
native-reply-file-cleanup,
decision-present, courier-guard, liaison draft

Start options: --state-dir DIR [--courier-route-id ROUTE_ID]

Use \"discord-surface agent-send --help\" for addressed agent-message options.
`;

const AGENT_SEND_USAGE = `Usage: discord-surface agent-send --provider PROVIDER --channel-id CHANNEL_ID \\
  --native-id NATIVE_UUID --generation GENERATION --target-file ADDRESS_FILE \\
  --text-file TEXT_FILE --dedupe-key KEY --agent-thread-id THREAD_ID \\
  [--agent-presentation MODE]

For an agent result, use --agent-reply-to REQUEST_ID instead of --target-file.
Agent requests and results require an actively enrolled child route.
MODE must be legacy or attachment-v1.
Agent packets must fit in one Discord message. The limit is ${AGENT_MESSAGE_MAX_ENCODED_LENGTH} encoded characters, including the envelope and signature.
Usable text varies with envelope metadata, UTF-8 width, and JSON escaping.
`;

const AGENT_COMPLETE_USAGE = `Usage: discord-surface agent-complete --provider PROVIDER --message-id MESSAGE_ID \\
  --native-id NATIVE_UUID --generation GENERATION [--channel-id CHANNEL_ID]

Consumes one authenticated agent request or result without posting a reply. A live Gateway must advertise the completion wake capability.
`;

const AGENT_WITHDRAW_USAGE = `Usage: discord-surface agent-withdraw --provider PROVIDER --message-id MESSAGE_ID \\
  --packet-id PACKET_ID --native-id NATIVE_UUID --generation GENERATION

Withdraws one acknowledged outstanding agent request from its current requester session. Preserves the signed request and acknowledgment, and records a distinct withdrawal receipt.
`;

const WATCHER_ARM_USAGE = `Usage: discord-surface watcher-arm --arm-key ARM_KEY --provider claude --channel-id PARENT_CHANNEL_ID \\
  --agent-thread-id CHILD_CHANNEL_ID --native-id NATIVE_UUID --generation GENERATION

Arms a notice-only Claude owner after checking the current Claude caller and enrolled child route.
`;

const WATCHER_SEND_USAGE = `Usage: discord-surface watcher-send --arm-key ARM_KEY --trigger-key TRIGGER_KEY \\
  --text-file TEXT_FILE

Publishes one signed notice using the frozen arm and deterministic trigger identity.
`;

const WATCHER_CONSUME_USAGE = `Usage: discord-surface watcher-consume --message-id MESSAGE_ID --provider claude \\
  --native-id NATIVE_UUID --generation GENERATION [--channel-id CHANNEL_ID]

Consumes an acknowledged watcher notice without posting a Discord reply.
`;

const RECOVER_USAGE = `Usage: discord-surface recover [options]

Courier recovery:
  recover --courier-message-id <id> --courier-attempt-id <id>

Explicitly retires one queue-admitted courier attempt whose queue submission was
recorded but that was never forwarding-claimed and never natively acknowledged.
Both flags are required together and cannot combine with another recover mode.

Retirement means only that this attempt can no longer gain forwarding permission.
It is NOT native completion and implies no native execution, retry, or reply.
A stopped or stale Gateway leaves the durable retirement for the next startup.
`;

function printUsage(command) {
  let usage = GENERAL_USAGE;
  if (command === 'mcp') usage = 'Usage: discord-surface mcp --provider codex|claude [--state-dir DIR] [--db FILE]\n\nRuns authenticated peer tools over stdio. Native caller identity must be available.\n';
  if (command === 'agent-send') usage = AGENT_SEND_USAGE;
  if (command === 'agent-complete') usage = AGENT_COMPLETE_USAGE;
  if (command === 'agent-withdraw') usage = AGENT_WITHDRAW_USAGE;
  if (command === 'watcher-arm') usage = WATCHER_ARM_USAGE;
  if (command === 'watcher-send') usage = WATCHER_SEND_USAGE;
  if (command === 'watcher-consume') usage = WATCHER_CONSUME_USAGE;
  if (command === 'recover') usage = RECOVER_USAGE;
  process.stdout.write(usage);
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

async function bind(args, rebind = false) {
  const { state } = openState(args);
  let client;
  let handoffFence;
  let enrollmentProof = null;
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
  } finally {
    await deleteHandoffFence(handoffFence);
    await client?.destroy();
    state.close();
  }
}

async function threadEnroll(args, dependencies = {}) {
  const { paths, state } = openState(args);
  const install = dependencies.requireInstalled || requireInstalled;
  const controller = new AbortController();
  const stop = () => controller.abort();
  let client;
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
  } finally {
    controller.abort();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    try { await client?.destroy(); } finally { state.close(); }
  }
}

function requestGatewayRecovery(paths, {
  status = gatewayProcessStatus,
  kill = process.kill,
  expectedPid,
  requiredCapability = GATEWAY_CAPABILITIES.ordinaryBindWake
} = {}) {
  const runtime = status(paths);
  if (runtime?.state !== 'running' || !runtime.pid) {
    return { requested: false, state: runtime?.state || 'unknown', reason: 'gateway-not-running' };
  }
  if (expectedPid !== undefined && String(runtime.pid) !== String(expectedPid)) {
    return { requested: false, pid: runtime.pid, state: runtime.state, reason: 'gateway-changed' };
  }
  if (!runtime.capabilities?.includes(requiredCapability)) {
    return {
      requested: false,
      pid: runtime.pid,
      state: runtime.state,
      reason: 'gateway-wake-unsupported',
      capability: requiredCapability
    };
  }
  try {
    kill(runtime.pid, 'SIGUSR2');
    return { requested: true, pid: runtime.pid, signal: 'SIGUSR2' };
  } catch (error) {
    return { requested: false, pid: runtime.pid, state: runtime.state, reason: 'gateway-wake-failed', error: error.message };
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
  try {
    const messages = state.listMessages();
    const courierDeliveries = messages
      .filter(message => state.getCourierAttempt(message.id))
      .flatMap(message => state.getCourierDeliveryStatus(message.id));
    print({ config: state.getConfig(), gateway: gatewayProcessStatus(pathsFor(args)), readiness: state.getReadiness(), bindings: state.listBindings(), messages, receipts: state.listReceipts(), courierDeliveries });
  }
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

function recoverCourier(args, dependencies = {}) {
  const messageId = required(args, 'courier-message-id');
  const attemptId = required(args, 'courier-attempt-id');
  const { paths, state } = openState(args);
  try {
    const gatewayStatus = dependencies.gatewayProcessStatus || gatewayProcessStatus;
    const runtime = gatewayStatus(paths);
    const requiredCapability = GATEWAY_CAPABILITIES.courierRecovery;
    // Unknown or malformed runtime evidence refuses before any mutation. A
    // running Gateway must name a safe-integer positive pid and a string-only
    // capability list; a boolean or string pid, or a non-array/mixed-type
    // capabilities container, is malformed rather than "supported".
    const malformedPid = runtime?.state === 'running' &&
      !(typeof runtime.pid === 'number' && Number.isSafeInteger(runtime.pid) && runtime.pid > 0);
    const malformedCapabilities = runtime?.state === 'running' &&
      !(Array.isArray(runtime.capabilities) && runtime.capabilities.every(capability => typeof capability === 'string'));
    if (!runtime || !['running', 'stopped', 'stale'].includes(runtime.state) || malformedPid || malformedCapabilities) {
      throw new Error('Gateway status is unknown; stop or restart it before courier recovery');
    }
    const live = runtime.state === 'running';
    if (live && !runtime.capabilities.includes(requiredCapability)) {
      throw new Error('running Gateway does not support courier recovery; stop or restart it before recovery');
    }
    // The retirement transaction is authoritative. The wake below never rolls it
    // back and never claims a retry happened.
    const result = state.recoverCourierAttempt(messageId, attemptId);
    const gatewayWake = (dependencies.requestGatewayRecovery || requestGatewayRecovery)(paths, {
      status: gatewayStatus, kill: dependencies.killProcess || process.kill,
      ...(live ? { expectedPid: runtime.pid } : {}), requiredCapability
    });
    const response = { ...result, gatewayWake };
    (dependencies.print || print)(response);
    return response;
  } finally { state.close(); }
}

function recover(args) {
  const mode = require('./cli/flag-policy').recoverMode(args);
  // Courier mode is exclusive and owns its own Gateway preflight before mutation.
  if (mode === 'courier') return recoverCourier(args);
  const { paths, state } = openState(args);
  try {
    if (mode === 'board') {
      const boardTarget = {
        guildId: required(args, 'board-guild-id'),
        channelId: required(args, 'board-channel-id'),
        messageId: required(args, 'board-message-id')
      };
      const boardAttemptId = required(args, 'board-attempt-id');
      state.recoverBoardRefreshAttempt(boardTarget, boardAttemptId);
      print(state.reconcileBoardRefresh(
        boardTarget,
        boardAttemptId,
        required(args, 'board-resolution'),
        {
          evidenceScope: required(args, 'board-evidence-scope'),
          observedAt: required(args, 'board-readback-at'),
          readbackContent: required(args, 'board-readback'),
          soleWriter: args['board-sole-writer'] === true || args['board-sole-writer'] === 'true',
          singleAttempt: args['board-single-attempt'] === true || args['board-single-attempt'] === 'true',
          noHiddenRetry: args['board-no-hidden-retry'] === true || args['board-no-hidden-retry'] === 'true'
        }
      ));
    } else if (mode === 'topic') {
      const resolution = required(args, 'resolution');
      if (!['published', 'not_published'].includes(resolution)) throw new Error('--resolution must be published or not_published for topic reconciliation');
      print(state.reconcileTopicPublication(
        required(args, 'topic-channel-id'),
        required(args, 'topic-request-id'),
        resolution,
        required(args, 'evidence-scope'),
        { topic: required(args, 'topic-readback'), observedAt: required(args, 'topic-readback-at') }
      ));
    } else if (mode === 'intake') {
      const channelId = required(args, 'intake-channel-id');
      const thread = state.getThreadEnrollment(channelId);
      const activeThread = thread?.active ? thread : null;
      const recovered = state.reconcileIntake(channelId);
      if (activeThread && !recovered) throw new Error('Thread recovery requires the current active parent binding');
      print(activeThread ? {
        enrollment: recovered,
        gatewayWake: requestGatewayRecovery(paths, {
          requiredCapability: GATEWAY_CAPABILITIES.threadEnrollmentRecoveryWake
        })
      } : recovered);
    } else if (mode === 'reply') {
      print(state.reconcileReplyDelivery(required(args, 'message-id'), args.resolution === 'reply_sent' ? 'sent' : 'not_sent', {
        partIndex: args['part-index'] === undefined ? null : Number(args['part-index']),
        replyMessageId: args['reply-message-id']
      }));
    } else if (mode === 'directPost') {
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
    } else if (mode === 'message') print(state.reconcileUncertain(required(args, 'message-id'), args.resolution));
    else print(state.recoverAfterRestart());
  }
  finally { state.close(); }
}

async function boardRefresh(args) {
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
    const result = await runBoardRefresh({
      state,
      token: readSecret(config.secretFile),
      nativeId: required(args, 'native-id'),
      generation: required(args, 'generation'),
      channelId: required(args, 'channel-id'),
      messageId: required(args, 'message-id'),
      textFile: required(args, 'text-file'),
      dedupeKey: resolveDedupeKey({ dedupeKey: args['dedupe-key'], requestId: args['request-id'] }, { required: true }),
      signal: controller.signal,
      resolveBinding: (surfaceState, input) => resolveDirectBinding(surfaceState, {
        nativeId: input.nativeId,
        generation: input.generation,
        channelId: input.channelId,
        provider: null,
        ordinary: false
      })
    });
    print(result);
    if (![BOARD_OUTCOMES.APPLIED, BOARD_OUTCOMES.NO_OP].includes(result.status)) process.exitCode = 1;
    if (receivedSignal) process.exitCode = 128 + (os.constants.signals?.[receivedSignal] || 1);
    return result;
  } catch (error) {
    if (!receivedSignal || !controller.signal.aborted) throw error;
    process.exitCode = 128 + (os.constants.signals?.[receivedSignal] || 1);
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    state.close();
  }
}

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

const { handoffInternal, handoff, localHandoff } = createConductorHandoff({ required, openState, print, pathsFor, categoryFor, ordinaryHandoffInternal, cliPath: __filename });

function writePid(pidFile, guildId, stateDir, db, courierRouteId = null) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pidFile, JSON.stringify({
    pid: process.pid,
    guildId,
    stateDir,
    db,
    command: 'run',
    courierRouteId,
    startedAt: new Date().toISOString(),
    capabilities: [
      GATEWAY_CAPABILITIES.ordinaryBindWake,
      GATEWAY_CAPABILITIES.threadEnrollmentRecoveryWake,
      GATEWAY_CAPABILITIES.runtimeBindLock,
      GATEWAY_CAPABILITIES.ordinaryClaudeBind,
      GATEWAY_CAPABILITIES.agentHandledWithoutPost,
      GATEWAY_CAPABILITIES.agentRequestWithdrawal,
      GATEWAY_CAPABILITIES.watcherNoticeIngress,
      GATEWAY_CAPABILITIES.courierRecovery
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
    const courierRoute = resolveCourierRoute(state, args);
    state.recoverAfterRestart();
    writePid(paths.pid, config.guildId, paths.stateDir, paths.db, courierRoute?.routeId || null);
    gateway = new DiscordGateway({
      state,
      stateDir: paths.stateDir,
      observeOptions: { timeoutMs: Number(args['reply-timeout-ms'] || 120000) },
      onReady: () => bindingWake.start(),
      courierRoute
    });
    await gateway.start(config.secretFile);
    const recoveryCutoff = new Date().toISOString();
    // Ready-only reconciliation still drains durable submitted and reply-ready custody.
    await gateway.reconcilePending(recoveryCutoff, { allowPaused: true, readyOnly: true });
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

function start(args, dependencies = {}) {
  const { stateDir, lock } = pathsFor(args);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const state = new SurfaceState(pathsFor(args).db);
  let config;
  let courierRoute;
  try {
    config = state.requireConfig();
    courierRoute = resolveCourierRoute(state, args);
  } finally { state.close(); }
  const runtimeDir = path.join(os.tmpdir(), 'discord-surface-runtime');
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(runtimeDir, 0o700); } catch {}
  const guildLock = path.join(runtimeDir, `guild-${config.guildId}.lock`);
  const runArgs = [process.execPath, __filename, 'run', '--state-dir', stateDir,
    ...(args.db ? ['--db', path.resolve(args.db)] : []),
    ...(courierRoute ? [`--courier-route-id=${courierRoute.routeId}`] : [])];
  const result = (dependencies.spawnSync || spawnSync)('lockf', ['-t', '0', '-k', guildLock, 'lockf', '-t', '0', '-k', lock, ...runArgs], {
    stdio: 'inherit',
    env: { ...process.env, DISCORD_SURFACE_LOCK_HELD: '1' }
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

const {
  servedOrdinaryBinding,
  attachOrdinaryListener,
  detachOrdinaryListener,
  claudeChannel,
  claudeMonitor
} = createClaudeListeners({ openState, required, requestGatewayRecovery, cliPath: __filename });

function nativeReply(args, compatibilityProvider = null) {
  const { state } = openState(args);
  try {
    const provider = compatibilityProvider || required(args, 'provider');
    if (!['codex', 'claude'].includes(provider)) throw new Error('invalid agent provider');
    const generation = Number(required(args, 'generation'));
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('generation must be a positive integer');
    const textFile = path.resolve(required(args, 'text-file'));
    const stat = fs.statSync(textFile);
    if (!stat.isFile()) throw new Error('text file must be a regular file');
    const messageId = required(args, 'message-id');
    const nativeId = required(args, 'native-id');
    const text = fs.readFileSync(textFile, 'utf8');
    const fileManifest = Object.hasOwn(args, 'attachment-file')
      ? state.prepareNativeReplyFile({ provider, messageId, nativeId, generation, stateDir: pathsFor(args).stateDir,
        sourcePath: path.resolve(required(args, 'attachment-file')), caption: text })
      : null;
    const result = state.recordNativeReply({
      provider,
      messageId,
      nativeId,
      generation,
      text,
      ...(fileManifest ? { fileManifest } : {})
    });
    print({
      messageId,
      recorded: !result.duplicate,
      duplicate: Boolean(result.duplicate),
      state: result.message.state,
      ...(fileManifest ? { filePreparationId: fileManifest.preparationId } : {})
    });
  } finally { state.close(); }
}

function claudeReply(args) {
  return nativeReply(args, 'claude');
}

async function agentSend(args, dependencies = {}) {
  const provider = required(args, 'provider');
  if (!['codex', 'claude'].includes(provider)) throw new Error('invalid agent provider');
  const { state } = openState(args);
  let ordinary;
  try {
    ordinary = state.isOrdinaryBindingRecord(state.getBinding(required(args, 'channel-id')));
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
  } else if (!isReply) {
    required(args, 'target-file');
  }
  return directPost(args, provider, ordinary, {
    agentTarget,
    agentMode: true,
    agentThreadId: Object.hasOwn(args, 'agent-thread-id') ? args['agent-thread-id'] : null,
    agentPresentation: args['agent-presentation'],
    fetchImpl: dependencies.fetchImpl,
    print: dependencies.print
  });
}

async function assertOrdinaryPostCaller(state, { provider, nativeId, generation, channelId }, dependencies = {}) {
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

async function directPost(args, provider = null, ordinary = false, dependencies = {}) {
  const output = dependencies.print || print;
  const { paths, state } = openState(args);
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
    const resume = args.resume === true || args.resume === 'true';
    if (hasAgentReplyTo && !args['agent-reply-to']) throw new Error('agent reply correlation must not be empty');
    const nativeId = required(args, 'native-id');
    const generation = required(args, 'generation');
    const channelId = ordinary ? required(args, 'channel-id') : (args['channel-id'] || null);
    if (ordinary) await assertOrdinaryPostCaller(state, { provider, nativeId, generation, channelId }, dependencies);
    if (dependencies.exportAddress) {
      const binding = resolveDirectBinding(state, { nativeId, generation: Number(generation), channelId, provider, ordinary });
      const address = resolveAgentAddress(state, binding, dependencies.agentThreadId ?? null);
      const envelope = issueAgentAddress(address, readSecret(config.secretFile));
      output(envelope);
      return envelope;
    }
    const result = await runDirectPost({
      state,
      token: readSecret(config.secretFile),
      nativeId,
      generation,
      channelId,
      provider,
      agentThreadId: dependencies.agentThreadId ?? null,
      textFile: Object.hasOwn(args, 'text-file') ? required(args, 'text-file') : undefined,
      attachmentFile: Object.hasOwn(args, 'attachment-file') ? required(args, 'attachment-file') : undefined,
      resume,
      stateDir: paths.stateDir,
      agentTarget: dependencies.agentTarget ?? null,
      agentMode: dependencies.agentMode === true,
      agentPresentation: dependencies.agentPresentation,
      agentKind: hasAgentReplyTo ? 'result' : 'request',
      agentReplyTo: hasAgentReplyTo ? args['agent-reply-to'] : null,
      dedupeKey,
      inReplyTo: args['in-reply-to'],
      signal: controller.signal,
      fetchImpl: dependencies.fetchImpl,
      ordinary
    });
    output(result);
    if (result.status !== 'sent') process.exitCode = 1;
    if (receivedSignal) process.exitCode = 128 + (os.constants.signals?.[receivedSignal] || 1);
    return result;
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    state.close();
  }
}

function directPostFileCleanup(args) {
  const { state } = openState(args);
  try {
    const result = state.releaseDirectPostFilePreparation(required(args, 'preparation-id'));
    print(result);
    return result;
  } finally { state.close(); }
}

function agentComplete(args, dependencies = {}) {
  const { paths, state } = openState(args);
  const output = dependencies.print || print;
  const gatewayStatus = dependencies.gatewayProcessStatus || gatewayProcessStatus;
  const requestRecovery = dependencies.requestGatewayRecovery || requestGatewayRecovery;
  try {
    const runtime = gatewayStatus(paths);
    const requiredCapability = GATEWAY_CAPABILITIES.agentHandledWithoutPost;
    if (!runtime || !['running', 'stopped', 'stale'].includes(runtime.state)) {
      throw new Error('Gateway status is unknown; stop or restart it before agent completion');
    }
    const live = runtime.state === 'running' && Number.isSafeInteger(Number(runtime.pid)) && Number(runtime.pid) > 0;
    if (runtime.state === 'running' && !live) {
      throw new Error('Gateway status is unknown; stop or restart it before agent completion');
    }
    if (live && !runtime.capabilities?.includes(requiredCapability)) {
      throw new Error('running Gateway does not support agent handled-without-post completion; stop or restart it before completion');
    }
    const result = state.completeAgentHandledWithoutPost({
      messageId: required(args, 'message-id'),
      provider: required(args, 'provider'),
      nativeId: required(args, 'native-id'),
      generation: Number(required(args, 'generation')),
      channelId: args['channel-id'] || null
    });
    const gatewayWake = requestRecovery(paths, {
      status: gatewayStatus,
      kill: dependencies.killProcess || process.kill,
      ...(live ? { expectedPid: runtime.pid } : {}),
      requiredCapability
    });
    const response = { ...result, gatewayWake };
    output(response);
    return response;
  } finally {
    state.close();
  }
}

async function agentWithdraw(args, dependencies = {}) {
  const provider = required(args, 'provider');
  const nativeId = required(args, 'native-id');
  if (provider === PROVIDERS.CLAUDE) {
    const caller = await (dependencies.resolveClaudeCaller || (() => resolveCurrentClaudeCaller(dependencies)))();
    if (caller?.harness !== 'claude-code' || caller.sessionId !== nativeId ||
        (caller.threadId != null && caller.threadId !== nativeId)) {
      throw new Error('agent withdrawal requires the current Claude caller');
    }
  } else if (provider === PROVIDERS.CODEX) {
    const caller = (dependencies.resolveInvocationIdentity || resolveInvocationIdentity)(dependencies.environment || process.env);
    if (caller.sessionId !== nativeId || caller.threadId !== nativeId) {
      throw new Error('agent withdrawal requires the current Codex caller');
    }
  } else {
    throw new Error('invalid agent provider');
  }
  const { paths, state } = openState(args);
  try {
    if (provider === PROVIDERS.CODEX) {
      const sessionRoot = state.agentWithdrawalRequesterSessionRoot(required(args, 'message-id'), required(args, 'packet-id'));
      await (dependencies.validateCodexSessionIdentity || validateCodexSessionIdentityAsync)(nativeId, undefined, sessionRoot);
    }
    const gatewayStatus = dependencies.gatewayProcessStatus || gatewayProcessStatus;
    const runtime = gatewayStatus(paths);
    const requiredCapability = GATEWAY_CAPABILITIES.agentRequestWithdrawal;
    if (!runtime || !['running', 'stopped', 'stale'].includes(runtime.state) ||
        (runtime.state === 'running' && (!Number.isSafeInteger(Number(runtime.pid)) || Number(runtime.pid) <= 0))) {
      throw new Error('Gateway status is unknown; stop or restart it before agent withdrawal');
    }
    const live = runtime.state === 'running';
    if (live && !runtime.capabilities?.includes(requiredCapability)) {
      throw new Error('running Gateway does not support agent withdrawal; stop or restart it before withdrawal');
    }
    const result = state.withdrawAgentRequest({
      messageId: required(args, 'message-id'), packetId: required(args, 'packet-id'),
      provider, nativeId, generation: Number(required(args, 'generation'))
    });
    const gatewayWake = (dependencies.requestGatewayRecovery || requestGatewayRecovery)(paths, {
      status: gatewayStatus, kill: dependencies.killProcess || process.kill,
      ...(live ? { expectedPid: runtime.pid } : {}), requiredCapability
    });
    const response = { ...result, gatewayWake };
    (dependencies.print || print)(response);
    return response;
  } finally { state.close(); }
}

async function watcherArm(args, dependencies = {}) {
  const { state } = openState(args);
  const output = dependencies.print || print;
  try {
    const resolveCaller = dependencies.resolveClaudeCaller || (() => resolveCurrentClaudeCaller(dependencies));
    const caller = await resolveCaller();
    const result = state.armWatcherNotice({
      armKey: required(args, 'arm-key'),
      parentChannelId: required(args, 'channel-id'),
      childChannelId: required(args, 'agent-thread-id'),
      provider: required(args, 'provider'),
      nativeId: required(args, 'native-id'),
      generation: Number(required(args, 'generation')),
      caller
    });
    output(result);
    return result;
  } finally { state.close(); }
}

async function watcherSend(args, dependencies = {}) {
  const { paths, state } = openState(args);
  const gatewayStatus = dependencies.gatewayProcessStatus || gatewayProcessStatus;
  const controller = new AbortController();
  let receivedSignal = null;
  const handleSignal = signal => {
    if (receivedSignal) return;
    receivedSignal = signal;
    controller.abort();
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  const output = dependencies.print || print;
  try {
    const runtime = gatewayStatus(paths);
    if (!runtime || !['running', 'stopped', 'stale'].includes(runtime.state)) {
      throw new Error('Gateway status is unknown; stop or upgrade it before watcher notice send');
    }
    if (runtime.state === 'running' && (!runtime.pid || !runtime.capabilities?.includes(GATEWAY_CAPABILITIES.watcherNoticeIngress))) {
      throw new Error('running Gateway does not support watcher notice ingress; stop or upgrade it before watcher notice send');
    }
    const config = state.requireConfig();
    const result = await runWatcherNoticePost({
      state,
      token: readSecret(config.secretFile),
      armKey: required(args, 'arm-key'),
      triggerKey: required(args, 'trigger-key'),
      textFile: required(args, 'text-file'),
      stateDir: paths.stateDir,
      signal: controller.signal,
      fetchImpl: dependencies.fetchImpl
    });
    output(result);
    if (result.status !== 'sent') process.exitCode = 1;
    if (receivedSignal) process.exitCode = 128 + (os.constants.signals?.[receivedSignal] || 1);
    return result;
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    state.close();
  }
}

function watcherConsume(args, dependencies = {}) {
  const { paths, state } = openState(args);
  const output = dependencies.print || print;
  const gatewayStatus = dependencies.gatewayProcessStatus || gatewayProcessStatus;
  const requestRecovery = dependencies.requestGatewayRecovery || requestGatewayRecovery;
  try {
    const runtime = gatewayStatus(paths);
    const requiredCapability = GATEWAY_CAPABILITIES.agentHandledWithoutPost;
    if (!runtime || !['running', 'stopped', 'stale'].includes(runtime.state)) {
      throw new Error('Gateway status is unknown; stop or restart it before watcher notice consumption');
    }
    const live = runtime.state === 'running' && Number.isSafeInteger(Number(runtime.pid)) && Number(runtime.pid) > 0;
    if (runtime.state === 'running' && !live) {
      throw new Error('Gateway status is unknown; stop or restart it before watcher notice consumption');
    }
    if (live && !runtime.capabilities?.includes(requiredCapability)) {
      throw new Error('running Gateway does not support watcher notice consumption; stop or restart it before completion');
    }
    const result = state.consumeWatcherNotice({
      messageId: required(args, 'message-id'),
      provider: required(args, 'provider'),
      nativeId: required(args, 'native-id'),
      generation: Number(required(args, 'generation')),
      channelId: args['channel-id'] || null
    });
    const gatewayWake = requestRecovery(paths, {
      status: gatewayStatus,
      kill: dependencies.killProcess || process.kill,
      ...(live ? { expectedPid: runtime.pid } : {}),
      requiredCapability
    });
    const response = { ...result, gatewayWake };
    output(response);
    return response;
  } finally { state.close(); }
}

async function decisionPresent(args, dependencies = {}) {
  const { readDecisionRequest, presentDecision } = require('./decision-present');
  const { DECISION_TRANSPORT_OUTCOMES } = require('./state/decision');
  const request = readDecisionRequest(required(args, 'request-file'));
  const { state } = openState(args);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const config = state.requireConfig();
    const result = await presentDecision({
      state, request, token: readSecret(config.secretFile), signal: controller.signal,
      canonical: {
        ...(args['canonical-cli'] ? { executable: required(args, 'canonical-cli') } : {}),
        ...(args['canonical-state-root'] ? { stateRoot: required(args, 'canonical-state-root') } : {}),
        environment: dependencies.environment || process.env
      },
      fetchImpl: dependencies.fetchImpl,
      authorizeOrdinary: binding => assertOrdinaryPostCaller(state, binding, dependencies)
    });
    print(result);
    if (result.presentationOutcome !== DECISION_TRANSPORT_OUTCOMES.SENT) process.exitCode = 1;
    return result;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    state.close();
  }
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
  if (command === 'help' || args.help === true) return printUsage(command === 'help' ? subcommand : command);
  switch (command) {
    case 'courier-guard': return require('./courier-guard').courierGuard(args, pathsFor);
    case 'mcp': return require('./peer/server').startPeerMcp(args);
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
    case 'board-refresh': return boardRefresh(args);
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
    case 'native-reply': return nativeReply(args);
    case 'claude-reply': return claudeReply(args);
    case 'agent-address': {
      const provider = required(args, 'provider');
      if (!['codex', 'claude'].includes(provider)) throw new Error('invalid agent provider');
      const { state } = openState(args);
      let ordinary;
      try { ordinary = state.isOrdinaryBindingRecord(state.getBinding(required(args, 'channel-id'))); }
      finally { state.close(); }
      return directPost(args, provider, ordinary, { exportAddress: true,
        agentThreadId: Object.hasOwn(args, 'agent-thread-id') ? args['agent-thread-id'] : null });
    }
    case 'agent-send': return agentSend(args);
    case 'agent-complete': return agentComplete(args);
    case 'agent-withdraw': return agentWithdraw(args);
    case 'watcher-arm': return watcherArm(args);
    case 'watcher-send': return watcherSend(args);
    case 'watcher-consume': return watcherConsume(args);
    case 'decision-present': return decisionPresent(args);
    case 'thread-enroll': return threadEnroll(args);
    case 'post': return directPost(args);
    case 'ordinary-post': return directPost(args, 'codex', true);
    case 'ordinary-claude-post': return directPost(args, 'claude', true);
    case 'claude-post': return directPost(args, 'claude');
    case 'post-file-cleanup': return directPostFileCleanup(args);
    case 'native-reply-file-cleanup': {
      const { state } = openState(args);
      try {
        const result = state.releaseNativeReplyFilePreparation(required(args, 'message-id'), required(args, 'preparation-id'), Number(args['part-index'] || 0));
        print(result);
        return result;
      } finally { state.close(); }
    }
    case 'liaison':
      if (subcommand !== 'draft') throw new Error('usage: liaison draft --receipt-id RECEIPT_ID');
      return liaisonDraft(args);
    default: throw new Error('usage: mcp, configure, bind, ordinary-bind, ordinary-claude-bind, rebind, unbind, status, recover, board-refresh, thread-enroll, provision, handoff, start, stop, claude-channel, claude-monitor, native-ack, native-reply, claude-reply, agent-address, agent-send, agent-complete, agent-withdraw, post, ordinary-post, ordinary-claude-post, claude-post, native-reply-file-cleanup, decision-present, liaison draft');
  }
}

module.exports = { agentComplete, agentSend, agentWithdraw, attachOrdinaryListener, bindingArgs, boardRefresh, claudeChannel, claudeMonitor, claudeReply, conductorMarker, createBindingWakeController, decisionPresent, detachOrdinaryListener, directPost, directPostFileCleanup, ensureProvisionedChannel, GATEWAY_CAPABILITIES, gatewayProcessStatus, handoffInternal, liaisonDraft, main, migrateLegacyTopic, nativeReply, NATIVE_PROOF_STATUSES, ordinaryBind, ordinaryClaudeBind, ordinaryBindingArgs, ordinaryHandoffInternal, openState, parseArgs, pathsFor, provisionMarker, recoverCourier, requestGatewayRecovery, resolveCourierRoute, resolveCurrentClaudeCaller, servedOrdinaryBinding, start, threadEnroll, unbind, watcherArm, watcherConsume, watcherSend };

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`discord-surface: ${error.message}\n`);
    process.exitCode = 1;
  });
}
