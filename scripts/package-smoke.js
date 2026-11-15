const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runFullGate, SCRATCH_ROOT } = require('./full-gate');

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
    assert.equal(typeof cli.threadEnroll, 'function');
    const threadState = require(path.join(root, 'src/state/thread-enrollment.js'));
    const threadGateway = require(path.join(root, 'src/discord/thread-enrollment.js'));
    assert.equal(threadState, require(path.join(root, 'dist/state/thread-enrollment.js')));
    assert.equal(threadGateway, require(path.join(root, 'dist/discord/thread-enrollment.js')));
    assert.equal(typeof threadState.createThreadEnrollmentHandlers, 'function');
    assert.equal(typeof threadGateway.enrollPublicThread, 'function');
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

function main(args = []) {
  if (packageJson.engines?.node !== '>=22.13.0 <23.0.0') {
    throw new Error(`unexpected Node engine range: ${packageJson.engines?.node}`);
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 22 || minor < 13) {
    throw new Error(`package-smoke requires Node 22.13.x or newer Node 22.x; got ${process.version}`);
  }

  assert(Array.isArray(args), 'package-smoke arguments must be an array');
  assert(args.length === 0 || (args.length === 2 && args[0] === '--retain-artifact'),
    'usage: package-smoke [--retain-artifact ABSOLUTE_NEW_ARCHIVE_PATH]');
  const retainPath = args.length === 0 ? null : args[1];
  const retainedParents = [];
  const parentKeys = ['dev', 'ino', 'mode', 'uid', 'gid'];
  const archiveKeys = [...parentKeys, 'size', 'mtimeNs', 'ctimeNs', 'nlink'];
  if (args.length !== 0) {
    assert(typeof retainPath === 'string' && retainPath.length > 0
      && path.isAbsolute(retainPath) && path.resolve(retainPath) === retainPath,
    'retained archive path must be absolute and normalized');
    for (const protectedRoot of [root, process.env[SCRATCH_ROOT]]) {
      if (!protectedRoot) continue;
      const relative = path.relative(protectedRoot, retainPath);
      assert(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative),
        'retained archive must be outside source and gate scratch');
    }
    let parent = path.parse(retainPath).root;
    for (const part of path.relative(parent, path.dirname(retainPath)).split(path.sep)) {
      if (!part) continue;
      parent = path.join(parent, part);
      const observed = fs.lstatSync(parent, { bigint: true });
      assert(observed.isDirectory() && !observed.isSymbolicLink(),
        'retained archive parent must have no symlink');
      retainedParents.push({ path: parent, observed });
    }
    let destinationParent;
    if (retainedParents.length > 0) {
      destinationParent = retainedParents[retainedParents.length - 1].observed;
    } else {
      destinationParent = fs.lstatSync(parent, { bigint: true });
      retainedParents.push({ path: parent, observed: destinationParent });
    }
    assert(destinationParent.isDirectory() && !destinationParent.isSymbolicLink()
      && destinationParent.uid === BigInt(process.getuid())
      && (destinationParent.mode & 0o7777n) === 0o700n,
    'retained archive parent must be private and owned');
    try {
      fs.lstatSync(retainPath);
      assert.fail('retained archive destination already exists');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  const scratch = process.env[SCRATCH_ROOT]
    ? fs.mkdtempSync(path.join(process.env[SCRATCH_ROOT], 'package-'))
    : fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-package-smoke-'));
  let archiveFD;
  let archiveBefore;
  let retainedArtifact;
  let retainedCount;
  let retentionBodyError;
  try {
    if (retainPath !== null) {
      const relative = path.relative(scratch, retainPath);
      assert(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative),
        'retained archive must be outside package scratch');
    }
    const home = path.join(scratch, 'home');
    const install = path.join(scratch, 'install');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(install, { recursive: true });
    const env = isolatedEnvironment(home);
    const packRoot = path.join(scratch, 'pack');
    fs.mkdirSync(packRoot, { recursive: true });
    for (const entry of ['README.md', 'INSTALL.md', 'package.json', 'package-lock.json', 'src', 'tsconfig.json', 'tsconfig.typecheck.json']) {
      fs.cpSync(path.join(root, entry), path.join(packRoot, entry), { recursive: true });
    }
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(packRoot, 'node_modules'), 'junction');
    const packOutput = run(npm, ['pack', '--json', '--pack-destination', scratch], { cwd: packRoot, env });
    const packJsonStart = packOutput.indexOf('[\n');
    if (packJsonStart < 0) throw new Error('npm pack did not return JSON metadata');
    const pack = JSON.parse(packOutput.slice(packJsonStart))[0];
    assert(fs.existsSync(path.join(packRoot, 'dist')), 'prepack did not restore scratch dist');
    if (retainPath !== null) {
      assert(typeof pack.filename === 'string' && path.basename(pack.filename) === pack.filename,
        'retained archive filename must be a basename');
    }
    const packagePath = path.join(scratch, pack.filename);
    if (retainPath !== null) {
      const observed = fs.lstatSync(packagePath, { bigint: true });
      assert(observed.isFile() && !observed.isSymbolicLink()
        && observed.uid === BigInt(process.getuid()), 'tested archive must be an owned regular file');
      archiveFD = fs.openSync(packagePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      archiveBefore = fs.fstatSync(archiveFD, { bigint: true });
      for (const key of archiveKeys) assert(archiveBefore[key] === observed[key], 'tested archive changed');
    }
    const files = new Set(pack.files.map(file => file.path));
    assert(![...files].some(file => file.split('/').includes('__pycache__')), 'packed artifact contains Python bytecode cache');
    for (const required of ['package.json', 'INSTALL.md', 'src/topic.js', 'dist/topic.js', 'dist/topic.d.ts', 'src/attachments.js', 'dist/attachments.js', 'dist/attachments.d.ts']) {
      assert(files.has(required), `packed artifact is missing ${required}`);
    }
    for (const owner of ['state', 'discord']) {
      for (const required of [`src/${owner}/thread-enrollment.js`, `dist/${owner}/thread-enrollment.js`, `dist/${owner}/thread-enrollment.d.ts`]) {
        assert(files.has(required), `packed artifact is missing ${required}`);
      }
    }
    run(npm, ['install', '--ignore-scripts', '--prefix', install, packagePath], { env });
    runInstalledSmoke(path.join(install, 'node_modules', packageJson.name), env);
    if (retainPath === null) {
      process.stdout.write(JSON.stringify({ package: packageJson.name, version: packageJson.version, files: pack.files.length }));
      process.stdout.write('\n');
    } else {
      const beforeLink = fs.fstatSync(archiveFD, { bigint: true });
      const namedBeforeLink = fs.lstatSync(packagePath, { bigint: true });
      for (const key of archiveKeys) {
        assert(beforeLink[key] === archiveBefore[key] && namedBeforeLink[key] === archiveBefore[key],
          'tested archive changed during smoke');
      }
      for (const row of retainedParents) {
        const observed = fs.lstatSync(row.path, { bigint: true });
        for (const key of parentKeys) assert(observed[key] === row.observed[key], 'retained parent changed');
      }
      fs.linkSync(packagePath, retainPath);
      const retained = fs.lstatSync(retainPath, { bigint: true });
      const linked = fs.fstatSync(archiveFD, { bigint: true });
      for (const key of [...parentKeys, 'size', 'mtimeNs']) {
        assert(retained[key] === archiveBefore[key] && linked[key] === archiveBefore[key],
          'retained archive identity changed');
      }
      assert(retained.ctimeNs === linked.ctimeNs && retained.nlink === linked.nlink
        && linked.nlink === archiveBefore.nlink + 1n, 'retained archive link changed');
      for (const row of retainedParents) {
        const observed = fs.lstatSync(row.path, { bigint: true });
        for (const key of parentKeys) assert(observed[key] === row.observed[key], 'retained parent changed');
      }
      retainedCount = pack.files.length;
      retainedArtifact = { path: retainPath, accepted: false };
    }
  } catch (error) {
    if (retainPath !== null) retentionBodyError = error;
    throw error;
  } finally {
    let cleanupError;
    try {
      if (archiveFD !== undefined) fs.closeSync(archiveFD);
    } catch (error) {
      cleanupError = error;
    }
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch (error) {
      cleanupError = cleanupError
        ? new AggregateError([cleanupError, error], 'package scratch and archive descriptor cleanup failed')
        : error;
    }
    if (cleanupError) {
      if (retentionBodyError) throw new AggregateError([retentionBodyError, cleanupError], 'package retention and cleanup failed');
      throw cleanupError;
    }
  }
  if (retainPath !== null) {
    for (const row of retainedParents) {
      const observed = fs.lstatSync(row.path, { bigint: true });
      for (const key of parentKeys) assert(observed[key] === row.observed[key], 'retained parent changed');
    }
    const retained = fs.lstatSync(retainPath, { bigint: true });
    assert(retained.isFile() && !retained.isSymbolicLink(), 'retained archive is not a regular file after cleanup');
    for (const key of [...parentKeys, 'size', 'mtimeNs']) {
      assert(retained[key] === archiveBefore[key], 'retained archive changed after cleanup');
    }
    assert(retained.nlink === archiveBefore.nlink, 'retained archive link changed after cleanup');
    process.stdout.write(JSON.stringify({ package: packageJson.name, version: packageJson.version, files: retainedCount, retainedArtifact }));
    process.stdout.write('\n');
  }
}

if (require.main === module) {
  runFullGate(root, 'package-smoke', __filename, process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch(error => {
      process.stderr.write('package-smoke: ' + error.message + '\n');
      process.exitCode = 1;
    });
}

module.exports = { runBody: main };
