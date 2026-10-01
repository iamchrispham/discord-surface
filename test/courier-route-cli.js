const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { encodeAgentMessage, KINDS } = require('../src/agent-message');
const { acknowledgmentCommand } = require('../src/acknowledgment');
const { agentCompletionCommand, codexPrompt, readInitialCursor, CodexProvider } = require('../src/native');
const { parseArgs, resolveCourierRoute, start } = require('../src/cli');
const {
  COURIER_OUTCOMES,
  COURIER_SOURCE_KINDS,
  MESSAGE_STATES,
  SurfaceState,
  THREAD_STATES
} = require('../src/state');
const { createSurfaceConsumer } = require('../src/discord');
const { persistGuardRefusal } = require('../src/courier-guard');
const { TOKEN, PARENT_NATIVE, SOURCE_NATIVE, COURIER_NATIVE, RECIPIENT_THREAD, WRONG_RECIPIENT_THREAD, fixture, humanMessage, interactionMessage, materializedDecisionMessage, parentPrompt, preparedInput, consumerFor } = require('./courier-route-fixture');
test('public start forwards only an existing explicit courier route', t => {
  const f = fixture(t);
  const parsed = parseArgs(['start', '--state-dir', f.dir, '--db', f.dbPath, '--courier-route-id', f.route.routeId]);
  const calls = [];
  const priorExitCode = process.exitCode;
  try {
    start(parsed.args, {
      spawnSync(command, args, options) {
        calls.push({ command, args, options });
        return { status: 0 };
      }
    });
  } finally {
    if (priorExitCode === undefined) delete process.exitCode;
    else process.exitCode = priorExitCode;
  }
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes(`--courier-route-id=${f.route.routeId}`));
  assert.throws(() => start(parseArgs(['start', '--state-dir', f.dir, '--courier-route-id', 'missing']).args, {
    spawnSync() { throw new Error('start must reject before spawning'); }
  }), /courier route is unknown: missing/);
  assert.throws(() => start(parseArgs(['start', '--state-dir', f.dir, '--courier-route-id']).args, {
    spawnSync() { throw new Error('start must reject before spawning'); }
  }), /missing --courier-route-id/);
});

test('public start reparses route IDs containing equals from the captured child argv', t => {
  for (const routeId of ['route=one', '--route=one']) {
    const f = fixture(t);
    f.state.registerCourierRoute({ ...f.route, routeId });
    const parsed = parseArgs(['start', '--state-dir', f.dir, '--db', f.dbPath, `--courier-route-id=${routeId}`]);
    const calls = [];
    const priorExitCode = process.exitCode;
    try {
      start(parsed.args, {
        spawnSync(command, args) {
          calls.push({ command, args });
          return { status: 0 };
        }
      });
    } finally {
      if (priorExitCode === undefined) delete process.exitCode;
      else process.exitCode = priorExitCode;
    }
    assert.equal(calls.length, 1);
    const childStart = calls[0].args.lastIndexOf(process.execPath);
    const child = parseArgs(calls[0].args.slice(childStart + 2));
    assert.deepEqual(resolveCourierRoute(f.state, child.args), { routeId });
  }
});

test('public run passes explicit courier route into Gateway construction', t => {
  const f = fixture(t);
  const capturePath = path.join(f.dir, 'gateway-options.json');
  const preloadPath = path.join(f.dir, 'capture-gateway.cjs');
  fs.writeFileSync(preloadPath, String.raw`
const fs = require('node:fs');
const discord = require(process.env.TEST_DISCORD_PATH);
const hardStop = setTimeout(() => process.exit(70), 4000);
hardStop.unref();
discord.DiscordGateway = class CapturingGateway {
  constructor(options) {
    fs.writeFileSync(process.env.TEST_CAPTURE_PATH, JSON.stringify({ courierRoute: options.courierRoute }), { mode: 0o600 });
    this.ready = true;
    this.transportReady = true;
    this.recoveryPromise = null;
  }
  async start() { setImmediate(() => process.kill(process.pid, 'SIGTERM')); }
  async reconcilePending() { return []; }
  async stop() {}
};
`);
  f.state.close();
  f.replaceState(new SurfaceState(f.dbPath));
  const result = spawnSync(process.execPath, [
    '-r', preloadPath,
    'src/cli.js', 'run',
    '--state-dir', f.dir,
    '--db', f.dbPath,
    '--courier-route-id', f.route.routeId
  ], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      DISCORD_SURFACE_LOCK_HELD: '1',
      TEST_CAPTURE_PATH: capturePath,
      TEST_DISCORD_PATH: path.resolve(__dirname, '../src/discord.js')
    }
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(fs.readFileSync(capturePath, 'utf8')), {
    courierRoute: { routeId: f.route.routeId }
  });
});

test('CLI courier route validation fails closed and keeps omission disabled', () => {
  const state = { getCourierRoute: routeId => routeId === 'route-1' ? { routeId } : null };
  assert.equal(resolveCourierRoute(state, parseArgs(['run']).args), null);
  assert.deepEqual(resolveCourierRoute(state, parseArgs(['run', '--courier-route-id', 'route-1']).args), { routeId: 'route-1' });
  assert.throws(() => resolveCourierRoute(state, parseArgs(['run', '--courier-route-id']).args), /missing --courier-route-id/);
  assert.throws(() => resolveCourierRoute(state, parseArgs(['run', '--courier-route-id', 'missing']).args), /courier route is unknown: missing/);
});
