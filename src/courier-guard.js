const fs = require('node:fs');

const MAX_HOOK_BYTES = 1024 * 1024;

function readHookEvent(fd) {
  const chunks = [];
  const buffer = Buffer.alloc(4096);
  let length = 0;
  for (;;) {
    const count = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (!count) break;
    length += count;
    if (length > MAX_HOOK_BYTES) throw new Error('courier hook input exceeds 1 MiB');
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function courierGuard(args, pathsFor) {
  let state;
  try {
    if (typeof args['courier-route-id'] !== 'string' || !args['courier-route-id']) {
      throw new Error('missing --courier-route-id');
    }
    const event = readHookEvent(0);
    const { db } = pathsFor(args);
    const stat = fs.statSync(db);
    if (!stat.isFile() || stat.size === 0) throw new Error('courier state database is missing');
    const { SurfaceState } = require('./state');
    state = new SurfaceState(db, { requireCurrentSchema: true });
    state.claimCourierForward(args['courier-route-id'], event);
    state.close();
    state = null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: reason
    } })}\n`);
    process.stderr.write(`${reason}\n`);
    process.exitCode = 2;
  } finally {
    if (state) {
      try { state.close(); } catch { process.exitCode = 2; }
    }
  }
}

module.exports = { courierGuard, MAX_HOOK_BYTES };
