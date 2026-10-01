'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { resolveInvocationIdentity } = require('./ordinary-codex');

const REQUIRED_FLAGS = ['db', 'courier-route-id', 'message-id', 'attempt-id', 'native-id'];

function required(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing --${key}`);
  return value;
}

function canonicalNativeId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : value;
}

// Reads the exact persisted tool input for one admitted courier attempt and
// prints it as JSON so a native host can forward the parsed object instead of a
// model-transcribed copy. This command never claims forwarding permission and
// never writes a receipt: the public hook remains the only custody writer.
function courierInput(args, dependencies = {}) {
  const options = args || {};
  const requiredFlag = dependencies.required || required;
  const workspace = dependencies.workspace || process.cwd;
  const stdout = dependencies.stdout || process.stdout;
  const State = dependencies.SurfaceState || require('./state').SurfaceState;
  const environment = dependencies.environment || process.env;
  const resolveIdentity = dependencies.resolveInvocationIdentity || resolveInvocationIdentity;

  // Validate every flag before any filesystem or database work, so a malformed
  // invocation can never create a database file.
  const db = requiredFlag(options, 'db');
  const routeId = requiredFlag(options, 'courier-route-id');
  const messageId = requiredFlag(options, 'message-id');
  const attemptId = requiredFlag(options, 'attempt-id');
  const nativeId = requiredFlag(options, 'native-id');
  const invocation = resolveIdentity(environment);
  if (canonicalNativeId(nativeId) !== canonicalNativeId(invocation.sessionId)) {
    throw new Error('courier native id does not match the invocation identity');
  }

  // A relative database path would silently depend on the caller's cwd; refuse it
  // rather than resolving it.
  if (!path.isAbsolute(db)) throw new Error('--db must be an absolute path');
  const stat = fs.statSync(db);
  if (!stat.isFile() || stat.size === 0) throw new Error('courier state database is missing');

  let state;
  try {
    state = new State(db, { requireCurrentSchema: true, readOnly: true });
    const result = state.readCourierInput(routeId, messageId, attemptId, nativeId, workspace());
    stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    if (state) state.close();
  }
}

module.exports = { courierInput, REQUIRED_FLAGS };
