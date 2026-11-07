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
const { createDirectPostCommands } = require('./cli/direct-post-commands');
const { createProvisionCommands } = require('./cli/provision-commands');
const { completeCommandCleanup } = require('./cli/command-cleanup');
const { createNativeCompletionCommands } = require('./cli/native-completion-commands');
const { createRecoveryCommands } = require('./cli/recovery-commands');
const { createBoardRefreshCommands } = require('./cli/board-refresh-commands');
const { createWatcherCommands } = require('./cli/watcher-commands');
const { createBindingCommands } = require('./cli/binding-commands');
const { createPeerResultCommand } = require('./cli/peer-result');
const { resolveCurrentCodexWatcherCaller } = require('./cli/codex-watcher-caller');
const { writePid, acquireHeldLockUntilAvailable } = require('./cli/runtime-custody');
const { gatewayProcessStatus, pidMatches, waitForExit } = createGatewayProcessInspection(__filename);
const createClaudeListeners = require('./cli/claude-listeners');
const { createRuntimeLifecycle } = require('./cli/runtime-lifecycle');
const { AGENT_MESSAGE_MAX_ENCODED_LENGTH } = require('./agent-message');
const { execFileSync, spawnSync } = require('node:child_process');

const { pathToFileURL } = require('node:url');
const { SurfaceState, BindingError, PROVIDERS, READINESS, RECOVERY_LIMITS, validateNativeId } = require('./state');
const { discordIdAfter, readSecret, requireInstalled, waitForRecoveryOperation } = require('./discord');
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

function openState(args, options) {
  const paths = pathsFor(args);
  return { paths, state: new SurfaceState(paths.db, options) };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const ordinaryHandoffInternal = createOrdinaryHandoff({ required, openState, requestGatewayRecovery, print, gatewayProcessStatus, acquireHeldLockUntilAvailable });

const GENERAL_USAGE = `Usage: discord-surface <command> [options]

Commands: mcp, peer-result, configure, bind, ordinary-bind, ordinary-claude-bind, rebind, unbind,
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

const WATCHER_ARM_USAGE = `Usage: discord-surface watcher-arm --arm-key ARM_KEY --provider codex|claude --channel-id PARENT_CHANNEL_ID \\
  --agent-thread-id CHILD_CHANNEL_ID --native-id NATIVE_UUID --generation GENERATION

Arms a notice-only owner after checking the current caller and enrolled child route.
`;

const WATCHER_SEND_USAGE = `Usage: discord-surface watcher-send --arm-key ARM_KEY --trigger-key TRIGGER_KEY \\
  --text-file TEXT_FILE

Publishes one signed notice using the frozen arm and deterministic trigger identity.
`;

const WATCHER_CONSUME_USAGE = `Usage: discord-surface watcher-consume --message-id MESSAGE_ID --provider codex|claude \\
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
  if (command === 'peer-result') usage = 'Usage: discord-surface peer-result --provider codex|claude --correlation-id ID [--state-dir DIR] [--db FILE]\n\nInspect the current native caller\'s correlated replies without acknowledging or completing custody.\n';
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

const { boardRefresh } = createBoardRefreshCommands({ required, openState, print });

const { migrationRequested, categoryFor, provisionInternal, provision } = createProvisionCommands({ required, openState, pathsFor, print, cliPath: __filename });
const { handoffInternal, handoff, localHandoff } = createConductorHandoff({ required, openState, print, pathsFor, categoryFor, ordinaryHandoffInternal, cliPath: __filename });
const { agentSend, assertOrdinaryPostCaller, directPost, directPostFileCleanup } = createDirectPostCommands({ required, openState, print, resolveCurrentClaudeCaller });
const { nativeReply, claudeReply, agentComplete, agentWithdraw } = createNativeCompletionCommands({ required, openState, pathsFor, print, resolveCurrentClaudeCaller, gatewayProcessStatus, requestGatewayRecovery });
const { watcherArm, watcherSend, watcherConsume } = createWatcherCommands({ openState, required, print, resolveCurrentClaudeCaller, resolveCurrentCodexWatcherCaller, gatewayProcessStatus, requestGatewayRecovery });
const { recoverCourier, recover } = createRecoveryCommands({ required, openState, print, gatewayProcessStatus, requestGatewayRecovery, GATEWAY_CAPABILITIES });
const { bindingArgs, bind, threadEnroll, unbind } = createBindingCommands({ required, openState, print, requestGatewayRecovery, gatewayProcessStatus });
const peerResult = createPeerResultCommand({ required, openState, print, resolveCurrentClaudeCaller });

const { createBindingWakeController, runRuntime, start, stop } = createRuntimeLifecycle({ openState, pathsFor, SurfaceState, resolveCourierRoute, print, pidMatches, waitForExit, acquireHeldLockUntilAvailable, writePid, cliPath: __filename });

const {
  servedOrdinaryBinding,
  attachOrdinaryListener,
  detachOrdinaryListener,
  claudeChannel,
  claudeMonitor
} = createClaudeListeners({ openState, required, requestGatewayRecovery, cliPath: __filename });

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

async function main() {
  const { command, subcommand, args } = parseArgs(process.argv.slice(2));
  if (command === 'help' || args.help === true) return printUsage(command === 'help' ? subcommand : command);
  switch (command) {
    case 'courier-guard': return require('./courier-guard').courierGuard(args, pathsFor);
    case 'courier-input': return require('./courier-input').courierInput(args);
    case 'mcp': return require('./peer/server').startPeerMcp(args);
    case 'peer-result': return peerResult(args);
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
    default: throw new Error('usage: mcp, peer-result, configure, bind, ordinary-bind, ordinary-claude-bind, rebind, unbind, status, recover, board-refresh, thread-enroll, provision, handoff, start, stop, claude-channel, claude-monitor, native-ack, native-reply, claude-reply, agent-address, agent-send, agent-complete, agent-withdraw, watcher-arm, watcher-send, watcher-consume, post, ordinary-post, ordinary-claude-post, claude-post, post-file-cleanup, native-reply-file-cleanup, decision-present, courier-guard, liaison draft');
  }
}

module.exports = { agentComplete, agentSend, agentWithdraw, attachOrdinaryListener, bindingArgs, boardRefresh, claudeChannel, claudeMonitor, claudeReply, conductorMarker, createBindingWakeController, decisionPresent, detachOrdinaryListener, directPost, directPostFileCleanup, ensureProvisionedChannel, GATEWAY_CAPABILITIES, gatewayProcessStatus, handoffInternal, liaisonDraft, main, migrateLegacyTopic, nativeReply, NATIVE_PROOF_STATUSES, ordinaryBind, ordinaryClaudeBind, ordinaryBindingArgs, ordinaryHandoffInternal, openState, parseArgs, pathsFor, provisionMarker, recoverCourier, requestGatewayRecovery, resolveCourierRoute, resolveCurrentClaudeCaller, servedOrdinaryBinding, start, threadEnroll, unbind, watcherArm, watcherConsume, watcherSend };

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`discord-surface: ${error.message}\n`);
    process.exitCode = 1;
  });
}
