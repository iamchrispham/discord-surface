const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DiscordGateway, RECOVERY_POLICIES } = require('../discord');
const { createClaudeSubmittedReoffer } = require('./claude-submitted-reoffer');

// Owns the long-running Gateway runtime lifecycle: transport wake/recovery, the
// foreground run loop, and the start/stop process contract.
function createRuntimeLifecycle({ openState, pathsFor, SurfaceState, resolveCourierRoute, print, pidMatches, waitForExit, acquireHeldLockUntilAvailable, writePid, cliPath }) {
  function createBindingWakeController({ getGateway, isReady, isTransportReady = isReady, isStopping, probeClaudeChannel = require('../native').probeClaudeChannel,
    logger = error => process.stderr.write(`discord-surface: ordinary binding recovery failed: ${error.message}\n`) } = {}) {
    let wakePromise = null;
    let wakeRequested = false;
    const reoffer = createClaudeSubmittedReoffer({
      probeClaudeChannel,
      logger: error => logger(new Error(`Claude re-offer failed: ${error.message}`, { cause: error }))
    });
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
          const recovery = await currentGateway.recoverTransport('ordinary-bind', undefined, undefined, undefined, {
            recoveryPolicy: RECOVERY_POLICIES.UNRESOLVED
          });
          if (joinedRecovery) {
            wakeRequested = true;
            continue;
          }
          if (!isStopping?.()) {
            if (isReady?.() && isTransportReady?.()) {
              if (recovery?.ready) await currentGateway.reconcilePending();
              else await currentGateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
            }
            else if (isTransportReady?.() && ['gap', 'unavailable'].includes(recovery?.state)) {
              await currentGateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
            }
          }
          if (!isStopping?.() && isTransportReady?.()) await reoffer.run({ gateway: currentGateway, isStopping });
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
    const runArgs = [process.execPath, cliPath, 'run', '--state-dir', stateDir,
      ...(args.db ? ['--db', path.resolve(args.db)] : []),
      ...(courierRoute ? [`--courier-route-id=${courierRoute.routeId}`] : [])];
    const result = (dependencies.spawnSync || spawnSync)('lockf', ['-t', '0', '-k', guildLock, 'lockf', '-t', '0', '-k', lock, ...runArgs], {
      stdio: 'inherit',
      env: { ...process.env, DISCORD_SURFACE_LOCK_HELD: '1' }
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
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

  return { createBindingWakeController, runRuntime, start, stop };
}

module.exports = { createRuntimeLifecycle };
