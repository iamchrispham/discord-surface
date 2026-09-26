'use strict';

// Issue 119 test-only fixture publication owner. CommonJS so generated CJS
// children can require the same absolute module and generated ESM children can
// default-import it. This module owns fixture file I/O only: it never reads or
// writes production state, and it never observes a pathname before its writer
// has finished writing complete bytes.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TEMP_MARKER = '.fixture-pub-';
const TIMEOUT_MESSAGE = 'timed out waiting for a complete fixture PID record';

function temporaryPathFor(file) {
  const unique = `${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
  return path.join(path.dirname(file), `${path.basename(file)}${TEMP_MARKER}${unique}`);
}

// Publish complete text at `file` through a unique exclusive same-directory
// temporary pathname, then rename over the destination. A prior complete
// payload stays in place until the rename succeeds.
function publishFixtureFile(file, text) {
  const temporary = temporaryPathFor(file);
  let staged = false;
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    staged = true;
    fs.renameSync(temporary, file);
  } catch (error) {
    // A 'wx' EEXIST at the write step means a foreign file owns the stage path;
    // never delete it. Every other failure (including a rename-step EEXIST) may
    // have left this invocation's own stage, so remove only our own stage.
    if (!(error && error.code === 'EEXIST' && !staged)) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Abrupt-kill residue stays owned by fixture teardown.
      }
    }
    throw error;
  }
}

function completePidRecord(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return undefined;
  return parsed;
}

// Observe an existing record pathname until it holds a complete runtime PID
// record. The parent directory is watched before the first read, so a writer
// that publishes right after admission is observed rather than missed.
function waitForFixturePidRecord(file, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(signal.reason);
      return;
    }

    let settled = false;
    let watcher;
    let timer;
    let onAbort;

    const cleanup = () => {
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // A watcher that already failed has nothing left to release.
        }
        watcher = undefined;
      }
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };

    const finish = (outcome, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (outcome === 'resolve') resolve(value);
      else reject(value);
    };

    // Returns a complete record, undefined while pending, or null once an
    // unreadable-resource error has already settled the wait.
    const readNow = () => {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (error) {
        if (error && error.code === 'ENOENT') return undefined;
        finish('reject', error);
        return null;
      }
      return completePidRecord(text);
    };

    // Directory watchers on some platforms replay the destination's prior
    // creation event right after registration. Compare the observable file
    // identity so only a real change to the record triggers a content read.
    const signatureNow = () => {
      try {
        const stats = fs.statSync(file, { bigint: true });
        return `${stats.ino}:${stats.mtimeNs}:${stats.size}`;
      } catch {
        return null;
      }
    };

    const watchedName = path.basename(file);
    let baselineSignature;
    const onEvent = (_eventType, filename) => {
      if (settled) return;
      // Directory watchers can report unrelated events (including the parent
      // directory itself). Only a string filename naming the record is a
      // relevant publication signal; a missing filename cannot be filtered.
      if (typeof filename === 'string' && filename.length > 0 && filename !== watchedName) return;
      const current = signatureNow();
      if (current !== null && current === baselineSignature) return;
      const record = readNow();
      if (record) finish('resolve', record);
    };

    const onExpiry = () => {
      if (settled) return;
      const record = readNow();
      if (record) finish('resolve', record);
      else finish('reject', new Error(`${TIMEOUT_MESSAGE}: ${file}`));
    };

    onAbort = () => finish('reject', signal.reason);

    try {
      watcher = fs.watch(path.dirname(file), onEvent);
    } catch (error) {
      finish('reject', error);
      return;
    }

    watcher.on('error', error => finish('reject', error));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(onExpiry, timeoutMs);

    baselineSignature = signatureNow();
    const immediate = readNow();
    if (immediate) finish('resolve', immediate);
  });
}

module.exports = { publishFixtureFile, waitForFixturePidRecord };
