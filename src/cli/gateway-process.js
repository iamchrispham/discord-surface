const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function createGatewayProcessInspection(cliFilename) {
  function readProcessCommand(pid) {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  }

  function pidMatches(value, stateDir, db, command) {
    if (!value || value.command !== 'run' || value.stateDir !== stateDir) return false;
    try {
      // ps adds one newline; trailing route whitespace belongs to the argument.
      let actualCommand = (command ?? readProcessCommand(value.pid)).replace(/\n$/, '').trimStart();
      if (value.courierRouteId != null) {
        if (typeof value.courierRouteId !== 'string' || value.courierRouteId.length === 0) return false;
        const routeSuffix = [` --courier-route-id=${value.courierRouteId}`, ` --courier-route-id ${value.courierRouteId}`]
          .find(suffix => actualCommand.endsWith(suffix));
        if (!routeSuffix) return false;
        actualCommand = actualCommand.slice(0, -routeSuffix.length);
      }
      actualCommand = actualCommand.trim();
      const expectedPrefix = `${process.execPath} ${cliFilename} run --state-dir ${stateDir}`;
      if (actualCommand === expectedPrefix) {
        return (value.db == null || value.db === db) && db === path.join(stateDir, 'surface.sqlite');
      }
      const suffix = actualCommand.startsWith(expectedPrefix) ? actualCommand.slice(expectedPrefix.length).trim() : '';
      const commandDb = suffix.startsWith('--db=') ? suffix.slice('--db='.length) : suffix.startsWith('--db ') ? suffix.slice('--db '.length).trim() : null;
      if (!commandDb) return false;
      if (value.db != null && value.db !== db) return false;
      const unquotedDb = commandDb.length >= 2 && ((commandDb.startsWith('"') && commandDb.endsWith('"')) || (commandDb.startsWith("'") && commandDb.endsWith("'")))
        ? commandDb.slice(1, -1)
        : commandDb;
      return path.resolve(unquotedDb) === db;
    } catch { return false; }
  }

  function gatewayProcessStatus(paths) {
    if (!fs.existsSync(paths.pid)) {
      return { state: 'stopped', pid: null, connection: 'unavailable', reason: 'pid-file-missing' };
    }

    let value;
    try { value = JSON.parse(fs.readFileSync(paths.pid, 'utf8')); }
    catch { return { state: 'unknown', pid: null, connection: 'unknown', reason: 'pid-file-corrupt' }; }

    const runtimePid = Number(value?.pid);
    if (!Number.isSafeInteger(runtimePid) || runtimePid < 1) {
      return { state: 'unknown', pid: null, connection: 'unknown', reason: 'pid-file-invalid' };
    }

    try { process.kill(runtimePid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') return { state: 'stale', pid: runtimePid, connection: 'unavailable', reason: 'pid-not-running' };
      return { state: 'unknown', pid: runtimePid, connection: 'unknown', reason: 'process-probe-failed' };
    }

    let command;
    try { command = readProcessCommand(runtimePid); }
    catch { return { state: 'unknown', pid: runtimePid, connection: 'unknown', reason: 'process-inspection-failed' }; }
    if (!pidMatches(value, paths.stateDir, paths.db, command)) {
      return { state: 'unknown', pid: runtimePid, connection: 'unknown', reason: 'pid-owner-mismatch' };
    }
    return {
      state: 'running',
      pid: runtimePid,
      connection: 'unverified-live',
      guildId: value.guildId,
      stateDir: value.stateDir,
      db: value.db,
      startedAt: value.startedAt,
      capabilities: Array.isArray(value.capabilities) ? value.capabilities : []
    };
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

  return { gatewayProcessStatus, pidMatches, waitForExit };
}

module.exports = { createGatewayProcessInspection };
