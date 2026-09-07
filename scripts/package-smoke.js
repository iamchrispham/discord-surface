const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout;
}

function isolatedEnvironment(home) {
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: path.join(home, 'codex'),
    NODE_PATH: '',
    npm_config_cache: path.join(home, 'npm-cache'),
    npm_config_userconfig: path.join(home, 'npmrc'),
  };
  delete env.DISCORD_TOKEN;
  delete env.NPM_TOKEN;
  delete env.NODE_AUTH_TOKEN;
  delete env.NODE_OPTIONS;
  return env;
}

function runInstalledSmoke(installedRoot, env) {
  const script = String.raw`
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const root = process.argv[1];
    const cli = require(path.join(root, 'src/cli.js'));
    const discord = require(path.join(root, 'src/discord.js'));
    const claude = require(path.join(root, 'src/claude-channel.js'));
    const facade = require(path.join(root, 'src/topic.js'));
    const emitted = require(path.join(root, 'dist/topic.js'));
    const attachmentFacade = require(path.join(root, 'src/attachments.js'));
    const attachmentEmitted = require(path.join(root, 'dist/attachments.js'));
    assert.equal(typeof cli.main, 'function');
    assert.equal(typeof discord.DiscordGateway, 'function');
    assert.equal(typeof claude.ClaudeChannel, 'function');
    assert.equal(typeof discord.requireInstalled('discord.js').Client, 'function');
    assert.equal(typeof discord.requireInstalled('@modelcontextprotocol/sdk/server/index.js').Server, 'function');
    assert.equal(typeof discord.requireInstalled('@modelcontextprotocol/sdk/types.js').NotificationSchema.parse, 'function');
    assert.equal(typeof discord.requireInstalled('zod').object, 'function');
    const mcp = claude.createDefaultMcp({ nativeId: '79e3da8e-94b4-4aff-8f88-b45b3a451dd1', state: {} });
    assert.equal(typeof mcp.setRequestHandler, 'function');
    for (const name of ['topicPresentation', 'conductorMarkerMatches', 'parseLegacyConductorMarker', 'staticConductorMarker', 'topicWithReadiness']) {
      assert.equal(typeof facade[name], 'function');
      assert.equal(facade[name], emitted[name]);
    }
    const marker = emitted.staticConductorMarker({ provider: 'codex', conductorId: 'smoke-conductor', repoKey: 'repo:smoke' });
    assert.equal(emitted.conductorMarkerMatches(marker, { provider: 'codex', conductorId: 'smoke-conductor', repoKey: 'repo:smoke' }), true);
    assert.equal(emitted.topicPresentation(marker).base, marker);
    assert.match(emitted.topicWithReadiness(marker, 'ready', '2026-09-07T00:00:00.000Z'), /readiness=ready/);
    assert.equal(typeof attachmentFacade.normalizeAttachments, 'function');
    assert.equal(typeof attachmentEmitted.normalizeAttachments, 'function');
    const attachment = { url: 'https://example.test/file.txt', filename: 'file.txt', size: 3 };
    assert.deepEqual(attachmentFacade.normalizeAttachments([attachment]), [{ ...attachment, contentType: null }]);
    assert.equal(attachmentFacade.normalizeAttachments, attachmentEmitted.normalizeAttachments);
    process.stdout.write(JSON.stringify({ cli: true, discordSdk: true, mcpSdk: true, zod: true, emitted: true }));
  `;
  run(process.execPath, ['-e', script, installedRoot], { env });
}

function main() {
  if (packageJson.engines?.node !== '>=22.13.0 <23.0.0') {
    throw new Error(`unexpected Node engine range: ${packageJson.engines?.node}`);
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 22 || minor < 13) {
    throw new Error(`package-smoke requires Node 22.13.x or newer Node 22.x; got ${process.version}`);
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-package-smoke-'));
  try {
    const home = path.join(scratch, 'home');
    const install = path.join(scratch, 'install');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(install, { recursive: true });
    const env = isolatedEnvironment(home);
    const packRoot = path.join(scratch, 'pack');
    fs.mkdirSync(packRoot, { recursive: true });
    for (const entry of ['README.md', 'package.json', 'package-lock.json', 'src', 'tsconfig.json', 'tsconfig.typecheck.json']) {
      fs.cpSync(path.join(root, entry), path.join(packRoot, entry), { recursive: true });
    }
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(packRoot, 'node_modules'), 'junction');
    const packOutput = run(npm, ['pack', '--json', '--pack-destination', scratch], { cwd: packRoot, env });
    const packJsonStart = packOutput.indexOf('[\n');
    if (packJsonStart < 0) throw new Error('npm pack did not return JSON metadata');
    const pack = JSON.parse(packOutput.slice(packJsonStart))[0];
    assert(fs.existsSync(path.join(packRoot, 'dist')), 'prepack did not restore scratch dist');
    const packagePath = path.join(scratch, pack.filename);
    const files = new Set(pack.files.map(file => file.path));
    for (const required of ['package.json', 'src/topic.js', 'dist/topic.js', 'dist/topic.d.ts', 'src/attachments.js', 'dist/attachments.js', 'dist/attachments.d.ts']) {
      assert(files.has(required), `packed artifact is missing ${required}`);
    }
    run(npm, ['install', '--ignore-scripts', '--prefix', install, packagePath], { env });
    runInstalledSmoke(path.join(install, 'node_modules', packageJson.name), env);
    process.stdout.write(JSON.stringify({ package: packageJson.name, version: packageJson.version, files: pack.files.length }));
    process.stdout.write('\n');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`package-smoke: ${error.message}\n`);
  process.exitCode = 1;
}
