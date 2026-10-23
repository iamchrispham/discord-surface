const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runFullGate, SCRATCH_ROOT } = require('./full-gate');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const RETAIN_ARTIFACT_FLAG = '--retain-artifact';

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

function parseRetainArtifactArgs(args) {
  if (!Array.isArray(args) || args.length === 0) return null;
  if (args.length !== 2 || args[0] !== RETAIN_ARTIFACT_FLAG) {
    throw new Error(`${RETAIN_ARTIFACT_FLAG} requires one absolute destination file`);
  }
  if (typeof args[1] !== 'string' || args[1].length === 0) {
    throw new Error(`${RETAIN_ARTIFACT_FLAG} requires one absolute destination file`);
  }
  if (!path.isAbsolute(args[1])) throw new Error(`${RETAIN_ARTIFACT_FLAG} destination must be absolute`);
  return path.resolve(args[1]);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveThroughExistingParent(destination) {
  const missing = [];
  let current = path.dirname(destination);
  while (true) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing, path.basename(destination));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function validateRetainArtifactDestination(destination, root, scratch) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) {
    throw new Error(`${RETAIN_ARTIFACT_FLAG} destination must be absolute`);
  }
  const resolved = path.resolve(destination);
  const realDestination = resolveThroughExistingParent(resolved);
  const roots = [fs.realpathSync.native(root), fs.realpathSync.native(scratch)];
  if (roots.some(parent => isWithin(parent, realDestination))) {
    throw new Error(`${RETAIN_ARTIFACT_FLAG} destination must be outside checkout and scratch`);
  }
  for (const candidate of new Set([resolved, realDestination])) {
    try {
      fs.lstatSync(candidate);
      throw new Error(`${RETAIN_ARTIFACT_FLAG} destination already exists`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const parent = path.dirname(realDestination);
  try {
    if (!fs.statSync(parent).isDirectory()) throw new Error(`${RETAIN_ARTIFACT_FLAG} destination parent must be a directory`);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${RETAIN_ARTIFACT_FLAG} destination parent must exist`);
    throw error;
  }
  return realDestination;
}

function sameFile(pathname, identity) {
  try {
    const stat = fs.lstatSync(pathname);
    return stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino;
  } catch {
    return false;
  }
}

function digestDescriptor(fd) {
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytes = 0;
  let offset = 0;
  while (true) {
    const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
    if (read === 0) break;
    digest.update(buffer.subarray(0, read));
    bytes += read;
    offset += read;
  }
  return { bytes, sha256: digest.digest('hex') };
}

function retainArtifact(source, destination, { afterWrite, afterPublish, publish = fs.linkSync } = {}) {
  let sourceFd;
  let stageFd;
  const stagePath = `${destination}.partial-${crypto.randomBytes(16).toString('hex')}`;
  let stageIdentity;
  let published = false;
  let completed = false;
  let bytes = 0;
  const sourceDigest = crypto.createHash('sha256');
  try {
    sourceFd = fs.openSync(source, 'r');
    stageFd = fs.openSync(stagePath, 'wx+', 0o600);
    stageIdentity = fs.fstatSync(stageFd);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const read = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      let written = 0;
      while (written < read) written += fs.writeSync(stageFd, buffer, written, read - written, null);
      sourceDigest.update(buffer.subarray(0, read));
      bytes += read;
    }
    fs.fsyncSync(stageFd);
    afterWrite?.({ fd: stageFd, path: stagePath });
    const sourceSha256 = sourceDigest.digest('hex');
    const staged = digestDescriptor(stageFd);
    if (staged.bytes !== bytes || staged.sha256 !== sourceSha256 || !sameFile(stagePath, stageIdentity)) {
      throw new Error('retained artifact verification failed');
    }
    fs.fchmodSync(stageFd, 0o400);
    fs.fsyncSync(stageFd);
    fs.closeSync(stageFd);
    stageFd = undefined;
    publish(stagePath, destination);
    published = true;
    afterPublish?.({ path: stagePath, destination });
    const final = fs.lstatSync(destination);
    if (!final.isFile() || final.size !== staged.bytes || (final.mode & 0o777) !== 0o400 || !sameFile(destination, stageIdentity)) {
      throw new Error('retained artifact verification failed');
    }
    fs.unlinkSync(stagePath);
    completed = true;
    return { path: destination, bytes: staged.bytes, sha256: staged.sha256, mode: 0o400, candidate: true };
  } catch (error) {
    if (error.code === 'EEXIST' && stageIdentity) {
      error = new Error(`${RETAIN_ARTIFACT_FLAG} destination already exists`);
      error.code = 'EEXIST';
    }
    if (!completed && stageIdentity) {
      if (sameFile(stagePath, stageIdentity)) {
        try { fs.unlinkSync(stagePath); } catch {}
      }
      if (published && sameFile(destination, stageIdentity)) {
        try { fs.unlinkSync(destination); } catch {}
      }
    }
    throw error;
  } finally {
    if (sourceFd !== undefined) {
      try { fs.closeSync(sourceFd); } catch {}
    }
    if (stageFd !== undefined) {
      try { fs.closeSync(stageFd); } catch {}
    }
  }
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

function main(args = process.argv.slice(2), dependencies = {}) {
  const execute = dependencies.run || run;
  const smoke = dependencies.runInstalledSmoke || runInstalledSmoke;
  const requestedArtifact = parseRetainArtifactArgs(args);
  if (packageJson.engines?.node !== '>=22.13.0 <23.0.0') {
    throw new Error(`unexpected Node engine range: ${packageJson.engines?.node}`);
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 22 || minor < 13) {
    throw new Error(`package-smoke requires Node 22.13.x or newer Node 22.x; got ${process.version}`);
  }

  const scratch = process.env[SCRATCH_ROOT]
    ? fs.mkdtempSync(path.join(process.env[SCRATCH_ROOT], 'package-'))
    : fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-package-smoke-'));
  try {
    const retainedDestination = requestedArtifact
      ? validateRetainArtifactDestination(requestedArtifact, root, scratch)
      : null;
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
    const packOutput = execute(npm, ['pack', '--json', '--pack-destination', scratch], { cwd: packRoot, env });
    const packJsonStart = packOutput.indexOf('[\n');
    if (packJsonStart < 0) throw new Error('npm pack did not return JSON metadata');
    const pack = JSON.parse(packOutput.slice(packJsonStart))[0];
    assert(fs.existsSync(path.join(packRoot, 'dist')), 'prepack did not restore scratch dist');
    const packagePath = path.join(scratch, pack.filename);
    const files = new Set(pack.files.map(file => file.path));
    assert(![...files].some(file => file.split('/').includes('__pycache__')), 'packed artifact contains Python bytecode cache');
    for (const required of ['package.json', 'src/topic.js', 'dist/topic.js', 'dist/topic.d.ts', 'src/attachments.js', 'dist/attachments.js', 'dist/attachments.d.ts']) {
      assert(files.has(required), `packed artifact is missing ${required}`);
    }
    for (const owner of ['state', 'discord']) {
      for (const required of [`src/${owner}/thread-enrollment.js`, `dist/${owner}/thread-enrollment.js`, `dist/${owner}/thread-enrollment.d.ts`]) {
        assert(files.has(required), `packed artifact is missing ${required}`);
      }
    }
    execute(npm, ['install', '--ignore-scripts', '--prefix', install, packagePath], { env });
    smoke(path.join(install, 'node_modules', packageJson.name), env);
    const retainedArtifact = retainedDestination ? retainArtifact(packagePath, retainedDestination) : null;
    process.stdout.write(JSON.stringify({ package: packageJson.name, version: packageJson.version, files: pack.files.length,
      ...(retainedArtifact ? { retainedArtifact } : {}) }));
    process.stdout.write('\n');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function runPackageSmokeEntry(args, gate = runFullGate) {
  parseRetainArtifactArgs(args);
  return gate(root, 'package-smoke', __filename, args);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  try {
    runPackageSmokeEntry(args)
      .then(code => { process.exitCode = code; })
      .catch(error => {
        process.stderr.write('package-smoke: ' + error.message + '\n');
        process.exitCode = 1;
      });
  } catch (error) {
    process.stderr.write('package-smoke: ' + error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { parseRetainArtifactArgs, retainArtifact, runBody: main, runPackageSmokeEntry, validateRetainArtifactDestination };
