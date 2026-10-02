const os = require('node:os');
const { readSecret } = require('../discord');
const { GATEWAY_CAPABILITIES } = require('../ordinary-bind/constants');
const { runWatcherNoticePost } = require('../direct-post');

const { WATCHER_NOTICE_PROVIDERS, isWatcherNoticeProvider } = require('../watcher-notice');

function hasMatchingCodexCourierRoute(state, runtime, arm) {
  if (arm?.provider !== WATCHER_NOTICE_PROVIDERS.CODEX || runtime?.state !== 'running' || !runtime.pid ||
      typeof runtime.courierRouteId !== 'string' || runtime.courierRouteId.length === 0 ||
      typeof state.getCourierRoute !== 'function') return false;
  const route = state.getCourierRoute(runtime.courierRouteId);
  return route?.status === 'active' && route.guildId === arm.source.guildId &&
    route.parentChannelId === arm.source.channelId && route.deliveryChannelId === arm.target.channelId &&
    route.target?.provider === WATCHER_NOTICE_PROVIDERS.CODEX &&
    route.target?.nativeId === arm.target.nativeId && route.target?.generation === arm.target.generation &&
    route.courier?.provider === WATCHER_NOTICE_PROVIDERS.CODEX &&
    route.courier?.recipientThreadId === arm.source.nativeId;
}

function createWatcherCommands({ openState, required, print, resolveCurrentClaudeCaller, resolveCurrentCodexWatcherCaller, gatewayProcessStatus, requestGatewayRecovery }) {
async function watcherArm(args, dependencies = {}) {
  const { state } = openState(args);
  const output = dependencies.print || print;
  try {
    const provider = required(args, 'provider');
    const parentChannelId = required(args, 'channel-id');
    const nativeId = required(args, 'native-id');
    if (!isWatcherNoticeProvider(provider)) throw new Error('watcher notices require a supported owner provider');
    const ownerBinding = typeof state.getBinding === 'function' ? state.getBinding(parentChannelId) : null;
    const callerOptions = provider === WATCHER_NOTICE_PROVIDERS.CODEX && ownerBinding?.sessionRoot
      ? { sessionRoot: ownerBinding.sessionRoot }
      : null;
    const resolveCaller = provider === WATCHER_NOTICE_PROVIDERS.CODEX
      ? () => callerOptions
        ? resolveCurrentCodexWatcherCaller(nativeId, callerOptions)
        : resolveCurrentCodexWatcherCaller(nativeId)
      : dependencies.resolveClaudeCaller || (() => resolveCurrentClaudeCaller(dependencies));
    const caller = await resolveCaller();
    const result = state.armWatcherNotice({
      armKey: required(args, 'arm-key'),
      parentChannelId,
      childChannelId: required(args, 'agent-thread-id'),
      provider,
      nativeId,
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
    const arm = typeof state.getWatcherNoticeArm === 'function'
      ? state.getWatcherNoticeArm(required(args, 'arm-key'))
      : null;
    const requiredCapability = arm?.provider === WATCHER_NOTICE_PROVIDERS.CODEX
      ? GATEWAY_CAPABILITIES.codexWatcherNoticeIngress
      : GATEWAY_CAPABILITIES.watcherNoticeIngress;
    if (arm?.provider === WATCHER_NOTICE_PROVIDERS.CODEX && !hasMatchingCodexCourierRoute(state, runtime, arm)) {
      throw new Error('Codex watcher notice ingress requires a running Gateway with the matching courier route');
    }
    if (runtime.state === 'running' && (!runtime.pid || !runtime.capabilities?.includes(requiredCapability))) {
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

  return { watcherArm, watcherSend, watcherConsume };
}

module.exports = { createWatcherCommands };
