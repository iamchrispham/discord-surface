const os = require('node:os');
const path = require('node:path');
const { ClaudeChannel } = require('../claude-channel');
const { createClaudeMonitor } = require('../claude-monitor');
const { PROVIDERS, READINESS } = require('../state');
const { CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX } = require('../ordinary/constants');

function createClaudeListeners({ openState, required, requestGatewayRecovery, cliPath }) {
// A listener may wake intake only for the binding whose socket it opened.
function servedClaudeBinding(state, identity) {
  const binding = identity ? state.getBinding(identity.channelId) : null;
  return binding?.active && binding.provider === PROVIDERS.CLAUDE &&
    binding.channelId === identity.channelId && binding.guildId === identity.guildId &&
    binding.provider === identity.provider && binding.nativeId === identity.nativeId &&
    binding.workspace === identity.workspace && binding.endpoint === identity.endpoint &&
    binding.generation === identity.generation ? binding : null;
}

function servedOrdinaryBinding(state, identity) {
  const binding = servedClaudeBinding(state, identity);
  return binding && state.isOrdinaryBinding(binding) ? binding : null;
}

// Both binding kinds need an attach wake. Only ordinary listeners own readiness revocation.
function attachOrdinaryListener({ state, paths, startupBinding, identity, label, requestRecovery = requestGatewayRecovery, stderr = process.stderr }) {
  const binding = servedClaudeBinding(state, identity);
  if (!binding || (startupBinding && !servedOrdinaryBinding(state, identity))) {
    throw new Error(`${label} binding changed during startup`);
  }
  const watermark = startupBinding ? state.getIntakeWatermark(startupBinding.channelId) : null;
  const endpointUnavailable = watermark?.state === READINESS.UNAVAILABLE &&
    typeof watermark.detail === 'string' &&
    watermark.detail.startsWith(CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX);
  if (endpointUnavailable) {
    state.reconcileIntake(startupBinding.channelId, startupBinding, {
      states: [READINESS.UNAVAILABLE],
      detailPrefix: CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX
    });
  }
  const gatewayWake = requestRecovery(paths);
  if (!gatewayWake.requested) {
    stderr.write(`discord-surface: ${label} startup could not wake Gateway (${gatewayWake.reason})\n`);
    if (startupBinding && gatewayWake.reason === 'gateway-wake-unsupported') {
      // The reconcile above already moved the binding to pending. Nothing will ever
      // resolve that, so the owner puts readiness back before the caller unwinds.
      detachOrdinaryListener({ state, startupBinding, reason: `${label} unavailable` });
      throw new Error(`${label} startup could not wake Gateway (${gatewayWake.reason})`);
    }
  }
  return gatewayWake;
}

// Declines when the binding it revokes is no longer the one it attached to. A successor
// generation owns its own readiness, so a departing listener must not demote it.
function detachOrdinaryListener({ state, startupBinding, reason }) {
  if (!startupBinding) return false;
  const current = state.getBinding(startupBinding.channelId);
  if (!current || !current.active || current.provider !== PROVIDERS.CLAUDE || current.nativeId !== startupBinding.nativeId ||
    current.workspace !== startupBinding.workspace || current.endpoint !== startupBinding.endpoint) return false;
  return Boolean(state.setBindingReadiness(startupBinding.channelId, READINESS.UNAVAILABLE, reason, startupBinding));
}

function createRetryableListenerStop({ revoke, stopTransport, closeState }) {
  let stopPromise;
  return () => {
    if (stopPromise) return stopPromise;
    let transportStopped = false;
    let stateClosed = false;
    const attempt = Promise.resolve().then(async () => {
      let revokeError;
      try { revoke(); } catch (error) { revokeError = error; }
      await stopTransport();
      transportStopped = true;
      closeState();
      stateClosed = true;
      if (revokeError) throw revokeError;
    });
    stopPromise = attempt.catch(error => {
      if (!transportStopped || !stateClosed) stopPromise = null;
      throw error;
    });
    return stopPromise;
  };
}

async function claudeChannel(args) {
  const { paths, state } = openState(args);
  let channel;
  let ordinaryListenerAttached = false;
  let ordinaryStartupBinding = null;
  let revokeFailureReported = false;
  const reportRevokeFailure = error => {
    if (revokeFailureReported) return;
    revokeFailureReported = true;
    process.stderr.write(`discord-surface: Claude channel readiness revoke failed: ${error.message}\n`);
  };
  const detach = () => {
    if (!ordinaryListenerAttached) return false;
    try {
      const revoked = detachOrdinaryListener({ state, startupBinding: ordinaryStartupBinding, reason: 'Claude channel unavailable' });
      ordinaryListenerAttached = false;
      return revoked;
    } catch (error) {
      reportRevokeFailure(error);
      throw error;
    }
  };
  const stop = createRetryableListenerStop({
    revoke: detach,
    stopTransport: () => channel?.stop(),
    closeState: () => state.close()
  });
  // Readiness revoke and channel teardown both run inside stop, so an exit path must report
  // a stop failure rather than leaving it as an unhandled rejection.
  const handleStopFailure = error => {
    process.stderr.write(`discord-surface: Claude channel stop failed: ${error.message}\n`);
    process.exitCode = 1;
  };
  const exit = () => stop().then(() => process.exit(0)).catch(error => {
    handleStopFailure(error);
    process.exit(1);
  });
  process.once('SIGINT', exit);
  process.once('SIGTERM', exit);
  process.stdin.once('end', exit);
  process.stdin.once('close', exit);
  try {
    channel = new ClaudeChannel({
      state,
      nativeId: required(args, 'native-id'),
      socketPath: path.resolve(required(args, 'socket')),
      beforeTransportClose: detach,
      onTransportClose: () => { stop().catch(handleStopFailure); }
    });
    ordinaryStartupBinding = servedOrdinaryBinding(state, channel.bindingIdentity);
    await channel.start();
    attachOrdinaryListener({ state, paths, startupBinding: ordinaryStartupBinding, identity: channel.bindingIdentity, label: 'Claude channel' });
    ordinaryListenerAttached = Boolean(ordinaryStartupBinding);
  }
  catch (error) { await stop(); throw error; }
}

async function claudeMonitor(args) {
  const { paths, state } = openState(args);
  const nativeId = required(args, 'native-id');
  const socketPath = path.resolve(required(args, 'socket'));
  let ordinaryStartupBinding = null;
  let monitor;
  let monitorStarted = false;
  let detachStdoutTransport = () => {};
  const revokeOrdinaryReadiness = () => {
    if (!monitorStarted) return;
    detachOrdinaryListener({ state, startupBinding: ordinaryStartupBinding, reason: 'Claude Monitor unavailable' });
  };
  const stop = createRetryableListenerStop({
    revoke: () => {
      detachStdoutTransport();
      revokeOrdinaryReadiness();
    },
    stopTransport: () => monitor?.stop(),
    closeState: () => state.close()
  });
  const handleStopFailure = error => {
    process.stderr.write(`discord-surface: Claude Monitor stop failed: ${error.message}\n`);
    process.exitCode = 1;
  };
  const onStdoutTransportFailure = () => { stop().catch(handleStopFailure); };
  detachStdoutTransport = () => {
    process.stdout.removeListener?.('error', onStdoutTransportFailure);
    process.stdout.removeListener?.('close', onStdoutTransportFailure);
  };
  process.stdout.once?.('error', onStdoutTransportFailure);
  process.stdout.once?.('close', onStdoutTransportFailure);
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
      cliPath,
      onTransportClose: stop
    });
    ordinaryStartupBinding = servedOrdinaryBinding(state, monitor?.bindingIdentity);
    await monitor.start();
    monitorStarted = true;
    attachOrdinaryListener({ state, paths, startupBinding: ordinaryStartupBinding, identity: monitor?.bindingIdentity, label: 'Claude Monitor' });
  } catch (error) {
    await stop();
    throw error;
  }
}

return { servedOrdinaryBinding, attachOrdinaryListener, detachOrdinaryListener, claudeChannel, claudeMonitor };
}

module.exports = createClaudeListeners;
