'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { GATEWAY_CAPABILITIES } = require('../ordinary-bind/constants');

const LOCK_CONTENTION_EXIT = 75;

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
      GATEWAY_CAPABILITIES.codexWatcherNoticeIngress,
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

module.exports = { writePid, acquireHeldLockUntilAvailable };
