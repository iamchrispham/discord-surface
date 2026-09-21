const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { SurfaceState, THREAD_STATES } = require('../src/state');
const { gatewayProcessStatus, pathsFor, requestGatewayRecovery } = require('../src/cli');

for (const explicitDb of [false, true]) {
  test(`selected courier Gateway retains runtime identity, explicit database=${explicitDb}`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'courier identity '));
    const db = path.join(dir, explicitDb ? 'custom database.sqlite' : 'surface.sqlite');
    const paths = pathsFor({ 'state-dir': dir, db });
    const state = new SurfaceState(db);
    const nativeId = '11111111-1111-1111-1111-111111111111';
    const routeId = 'fixture route';
    state.setConfig({ guildId: '100', operatorId: 'operator', secretFile: path.join(dir, 'unused') });
    state.bind({ guildId: '100', channelId: '1000', provider: 'codex', nativeId, workspace: dir });
    const binding = state.getBinding('1000');
    state.enrollThread({ threadId: '2000', parentChannelId: '1000', guildId: '100' }, binding);
    state.setThreadBaseline('2000', null, binding);
    state.markThreadBoundary('2000', THREAD_STATES.READY, 'fixture', null, null, binding);
    state.registerCourierRoute({ routeId, routeGeneration: 1, guildId: '100', parentChannelId: '1000', deliveryChannelId: '2000',
      target: { guildId: '100', channelId: '2000', provider: 'codex', nativeId, generation: binding.generation },
      courier: { provider: 'codex', nativeId: '22222222-2222-2222-2222-222222222222', workspace: dir, recipientThreadId: nativeId } });
    state.close();
    const preload = path.join(dir, 'preload.cjs');
    fs.writeFileSync(preload, `
      setTimeout(() => process.exit(97), 10000).unref();
      const target = require.resolve(${JSON.stringify(path.resolve(__dirname, '../src/discord.js'))});
      const loaded = require(target);
      class FixtureGateway {
        constructor() { this.timer = setInterval(() => {}, 1000); }
        async start() {}
        async reconcilePending() {}
        async recoverTransport() { return { ready: true }; }
        async stop() { clearInterval(this.timer); }
      }
      require.cache[target].exports = { ...loaded, DiscordGateway: FixtureGateway };
    `);
    const cli = path.resolve(__dirname, '../src/cli.js');
    const child = spawn(process.execPath, [cli, 'run', '--state-dir', dir,
      ...(explicitDb ? ['--db', db, `--courier-route-id=${routeId}`] : ['--courier-route-id', routeId])], {
      env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, DISCORD_SURFACE_LOCK_HELD: '1' }, stdio: 'ignore' });
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(paths.pid) && Date.now() < deadline && child.exitCode === null) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(fs.existsSync(paths.pid), 'public run writes its PID record');
    const record = JSON.parse(fs.readFileSync(paths.pid, 'utf8'));
    assert.equal(gatewayProcessStatus(paths).state, 'running');
    assert.equal(record.courierRouteId, routeId);
    const signals = [];
    assert.equal(requestGatewayRecovery(paths, { kill: (...args) => signals.push(args) }).requested, true);
    assert.deepEqual(signals, [[child.pid, 'SIGUSR2']]);
    for (const change of [{ courierRouteId: 'foreign-route' }, { courierRouteId: null }, { db: path.join(dir, 'foreign.sqlite') }, { stateDir: dir + '-foreign' }]) {
      fs.writeFileSync(paths.pid, JSON.stringify({ ...record, ...change }));
      assert.equal(gatewayProcessStatus(paths).reason, 'pid-owner-mismatch');
    }
    fs.writeFileSync(paths.pid, JSON.stringify(record));
  });
}
