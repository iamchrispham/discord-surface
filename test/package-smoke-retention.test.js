'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT = path.resolve(__dirname, '..');

test('package smoke retains only requested archives and rejects parent changes', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(PROJECT, 'scripts/package-smoke.js'), 'utf8');
  const destination = '/fixture/evidence/archive.tgz';
  const requested = ['--retain-artifact', destination];
  const members = [
    'package.json', 'INSTALL.md', 'src/topic.js', 'dist/topic.js', 'dist/topic.d.ts',
    'src/attachments.js', 'dist/attachments.js', 'dist/attachments.d.ts',
    'src/state/thread-enrollment.js', 'dist/state/thread-enrollment.js', 'dist/state/thread-enrollment.d.ts',
    'src/discord/thread-enrollment.js', 'dist/discord/thread-enrollment.js', 'dist/discord/thread-enrollment.d.ts'
  ];
  const controls = {
    parent: ["    let destinationParent;\n    if (retainedParents.length > 0) {\n      destinationParent = retainedParents[retainedParents.length - 1].observed;\n    } else {\n      destinationParent = fs.lstatSync(parent, { bigint: true });\n      retainedParents.push({ path: parent, observed: destinationParent });\n    }", "    const destinationParent = fs.lstatSync(path.dirname(retainPath), { bigint: true });"],
    leaf: ["    const retained = fs.lstatSync(retainPath, { bigint: true });\n    assert(retained.isFile() && !retained.isSymbolicLink(), 'retained archive is not a regular file after cleanup');\n    for (const key of [...parentKeys, 'size', 'mtimeNs']) {\n      assert(retained[key] === archiveBefore[key], 'retained archive changed after cleanup');\n    }\n    assert(retained.nlink === archiveBefore.nlink, 'retained archive link changed after cleanup');\n", '']
  };
  for (const scenario of [
    { name: 'ordinary', args: [] },
    { name: 'requested null', args: ['--retain-artifact', null], fails: true, noWork: true },
    { name: 'requested empty', args: ['--retain-artifact', ''], fails: true, noWork: true },
    { name: 'retained', args: requested, retains: true },
    { name: 'symlink ancestor', args: requested, fails: true, noWork: true,
      badEntry: ['/fixture', 0o120777n], error: /retained archive parent must have no symlink/ },
    { name: 'non-directory destination parent', args: requested, fails: true, noWork: true,
      badEntry: ['/fixture/evidence', 0o100700n], error: /retained archive parent must have no symlink/ },
    { name: 'symlink packed archive', args: requested, fails: true,
      badEntry: ['/fixture/gate/package-1/archive.tgz', 0o120777n], error: /tested archive must be an owned regular file/,
      expectedActions: ['scratch', 'pack', 'cleanup'] },
    { name: 'FIFO packed archive', args: requested, fails: true,
      badEntry: ['/fixture/gate/package-1/archive.tgz', 0o010600n], error: /tested archive must be an owned regular file/,
      expectedActions: ['scratch', 'pack', 'cleanup'] },
    { name: 'temporary install failure', args: requested, fails: true, installFailure: true,
      error: /failed with status 23\nfixture npm install failed/,
      expectedActions: ['scratch', 'pack', 'open', 'install', 'close', 'cleanup'] },
    { name: 'mixed parent observations', args: requested, mixedParent: true, fails: true, noWork: true },
    { name: 'mixed parent old-owner control', args: requested, mixedParent: true, control: 'parent', retains: true },
    { name: 'filesystem-root parent', args: ['--retain-artifact', '/archive.tgz'], rootParent: true, retains: true },
    { name: 'cleanup leaf missing', args: requested, cleanupLeaf: 'missing', fails: true, linked: true },
    { name: 'cleanup leaf replaced', args: requested, cleanupLeaf: 'replaced', fails: true, linked: true },
    { name: 'close leaf missing', args: requested, closeLeaf: 'missing', fails: true, linked: true },
    { name: 'close leaf replaced', args: requested, closeLeaf: 'replaced', fails: true, linked: true },
    { name: 'cleanup missing old-owner control', args: requested, cleanupLeaf: 'missing', control: 'leaf', retains: true },
    { name: 'cleanup replaced old-owner control', args: requested, cleanupLeaf: 'replaced', control: 'leaf', retains: true },
    { name: 'missing INSTALL', args: requested, missingInstall: true, fails: true },
    { name: 'collision', args: requested, collision: true, fails: true, noWork: true },
    { name: 'link mode change', args: requested, tamper: 'link-mode', fails: true, linked: true },
    { name: 'link inode change', args: requested, tamper: 'link-inode', fails: true, linked: true },
    { name: 'close mode change', args: requested, tamper: 'close-mode', fails: true, linked: true },
    { name: 'cleanup mode change', args: requested, tamper: 'cleanup-mode', fails: true, linked: true },
    { name: 'cleanup inode change', args: requested, tamper: 'cleanup-inode', fails: true, linked: true },
    { name: 'cross-device link', args: requested, linkError: true, fails: true },
    { name: 'smoke failure', args: requested, smokeFailure: true, fails: true },
    { name: 'cleanup failure', args: requested, cleanupFailure: true, fails: true, linked: true },
    { name: 'CLI ordinary forwarding', args: [], cli: true },
    { name: 'CLI retention forwarding', args: requested, cli: true }
  ]) {
    const target = scenario.rootParent ? '/archive.tgz' : destination;
    let fixtureSource = source;
    if (scenario.control) {
      const [from, to] = controls[scenario.control];
      assert.equal(fixtureSource.split(from).length, 2, 'one guard selected for the behavior control');
      fixtureSource = fixtureSource.replace(from, to);
    }
    const actions = [];
    const copied = [];
    const writes = [];
    const forwarded = [];
    let linked = false;
    let parentMode = 0o40700n;
    let parentInode = 9007199254740993n;
    let linkCount = 1n;
    let archiveCtime = 11n;
    let badEntryObserved = false;
    let parentReads = 0;
    let retainedInode = 30n;
    let retainedMissing = false;
    const changeRetainedLeaf = kind => {
      linkCount -= 1n;
      archiveCtime += 1n;
      if (kind === 'missing') retainedMissing = true;
      else retainedInode += 1n;
    };
    const moduleFixture = { exports: {} };
    const fsFixture = {
      constants: fs.constants,
      readFileSync(file) {
        assert.equal(file, '/fixture/repo/package.json');
        return JSON.stringify({ name: 'discord-surface', version: '0.1.0', engines: { node: '>=22.13.0 <23.0.0' } });
      },
      mkdtempSync(prefix) {
        assert.equal(prefix, '/fixture/gate/package-');
        actions.push('scratch');
        return '/fixture/gate/package-1';
      },
      mkdirSync(file) { assert(file.startsWith('/fixture/gate/package-1/')); },
      cpSync(from, to) {
        assert(from.startsWith('/fixture/repo/'));
        assert(to.startsWith('/fixture/gate/package-1/pack/'));
        copied.push(path.basename(from));
      },
      symlinkSync(from, to) { assert.equal(from, '/fixture/repo/node_modules'); assert.equal(to, '/fixture/gate/package-1/pack/node_modules'); },
      existsSync(file) { assert.equal(file, '/fixture/gate/package-1/pack/dist'); return true; },
      lstatSync(file) {
        if (file === target && (retainedMissing || (!linked && !scenario.collision))) {
          const error = new Error('absent');
          error.code = 'ENOENT';
          throw error;
        }
        assert(['/', '/fixture', '/fixture/evidence', '/fixture/gate/package-1/archive.tgz', target].includes(file));
        const archive = file === '/fixture/gate/package-1/archive.tgz' || file === target;
        const finalParent = file === path.dirname(target);
        let observedMode = parentMode;
        if (finalParent && scenario.mixedParent) {
          parentReads += 1;
          observedMode = parentReads === 2 ? 0o40700n : 0o40755n;
        }
        const replaced = file === target && retainedInode !== 30n;
        let mode = archive ? 0o100644n : finalParent ? observedMode : 0o40755n;
        if (scenario.badEntry?.[0] === file) {
          badEntryObserved = true;
          mode = scenario.badEntry[1];
        }
        return {
          dev: 1n,
          ino: archive ? (scenario.collision && !linked ? 99n : file === target ? retainedInode : 30n) : finalParent ? parentInode : 10n,
          mode,
          uid: 501n, gid: 20n, size: archive ? 17n : 1n, mtimeNs: 10n,
          ctimeNs: archive ? replaced ? 20n : archiveCtime : 10n, nlink: archive ? replaced ? 1n : linkCount : 1n,
          isFile() { return (this.mode & 0o170000n) === 0o100000n; },
          isDirectory() { return (this.mode & 0o170000n) === 0o40000n; },
          isSymbolicLink() { return (this.mode & 0o170000n) === 0o120000n; }
        };
      },
      openSync(file, flags) {
        assert.equal(file, '/fixture/gate/package-1/archive.tgz');
        assert.equal(flags, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        actions.push('open');
        return 101;
      },
      fstatSync(fd) {
        assert.equal(fd, 101);
        return { dev: 1n, ino: 30n, mode: 0o100644n, uid: 501n, gid: 20n, size: 17n, mtimeNs: 10n, ctimeNs: archiveCtime, nlink: linkCount };
      },
      linkSync(from, to) {
        assert.equal(from, '/fixture/gate/package-1/archive.tgz');
        assert.equal(to, target);
        assert.equal(linked, false);
        actions.push('link');
        if (scenario.linkError) {
          const error = new Error('different device');
          error.code = 'EXDEV';
          throw error;
        }
        linked = true;
        linkCount += 1n;
        archiveCtime += 1n;
        if (scenario.tamper === 'link-mode') parentMode = 0o40777n;
        if (scenario.tamper === 'link-inode') parentInode += 1n;
      },
      closeSync(fd) {
        assert.equal(fd, 101);
        actions.push('close');
        if (scenario.tamper === 'close-mode') parentMode = 0o40777n;
        if (scenario.closeLeaf) changeRetainedLeaf(scenario.closeLeaf);
      },
      rmSync(file) {
        assert.equal(file, '/fixture/gate/package-1');
        actions.push('cleanup');
        if (scenario.tamper === 'cleanup-mode') parentMode = 0o40777n;
        if (scenario.tamper === 'cleanup-inode') parentInode += 1n;
        if (scenario.cleanupFailure) throw new Error('cleanup refused');
        if (linked) { linkCount -= 1n; archiveCtime += 1n; }
        if (scenario.cleanupLeaf) changeRetainedLeaf(scenario.cleanupLeaf);
      }
    };
    const context = {
      module: moduleFixture,
      __dirname: '/fixture/repo/scripts',
      __filename: '/fixture/repo/scripts/package-smoke.js',
      process: {
        platform: 'darwin', versions: { node: '22.23.2' }, version: 'v22.23.2',
        execPath: '/fixture/node', argv: ['/fixture/node', '/fixture/repo/scripts/package-smoke.js', ...scenario.args],
        env: { DISCORD_SURFACE_GATE_SCRATCH: '/fixture/gate' },
        getuid() { return 501; },
        stdout: { write(value) { actions.push('output'); writes.push(value); } },
        stderr: { write() { assert.fail('unexpected fixture stderr'); } }
      },
      require(name) {
        if (name === 'node:assert/strict') return assert;
        if (name === 'node:fs') return fsFixture;
        if (name === 'node:path') return path;
        if (name === 'node:os') return { tmpdir() { return '/fixture/tmp'; } };
        if (name === './full-gate') return {
          SCRATCH_ROOT: 'DISCORD_SURFACE_GATE_SCRATCH',
          runFullGate(root, label, entry, args) {
            assert.equal(root, '/fixture/repo');
            assert.equal(label, 'package-smoke');
            assert.equal(entry, '/fixture/repo/scripts/package-smoke.js');
            forwarded.push({ args });
            return { then(callback) { callback(0); return { catch() {} }; } };
          }
        };
        if (name === 'node:child_process') return {
          spawnSync(command, args) {
            if (command === 'npm' && args[0] === 'pack') {
              actions.push('pack');
              return { status: 0, stdout: JSON.stringify([{ filename: 'archive.tgz', files: members.filter(file => !scenario.missingInstall || file !== 'INSTALL.md').map(file => ({ path: file })) }], null, 2) };
            }
            if (command === 'npm' && args[0] === 'install') {
              actions.push('install');
              if (scenario.installFailure) {
                assert.deepEqual(Array.from(args), ['install', '--ignore-scripts', '--prefix',
                  '/fixture/gate/package-1/install', '/fixture/gate/package-1/archive.tgz']);
                return { status: 23, stdout: '', stderr: 'fixture npm install failed' };
              }
              return { status: 0, stdout: '' };
            }
            assert.equal(command, '/fixture/node');
            assert.equal(args[0], '-e');
            actions.push('smoke');
            return { status: scenario.smokeFailure ? 1 : 0, stdout: '', stderr: scenario.smokeFailure ? 'refused' : '' };
          }
        };
        assert.fail('unexpected package fixture dependency: ' + name);
      }
    };
    context.require.main = scenario.cli ? moduleFixture : {};
    const sandbox = vm.createContext(context);
    vm.runInContext(fixtureSource, sandbox, { timeout: 1000 });
    if (scenario.cli) {
      assert.equal(forwarded.length, 1, scenario.name);
      assert.deepEqual(JSON.parse(JSON.stringify(forwarded[0].args)), scenario.args, scenario.name);
      assert.deepEqual(actions, [], scenario.name);
      continue;
    }
    let failure;
    sandbox.contextArgs = scenario.args;
    try { vm.runInContext('module.exports.runBody(contextArgs)', sandbox, { timeout: 1000 }); } catch (error) { failure = error; }
    assert.equal(Boolean(failure), Boolean(scenario.fails), scenario.name);
    if (scenario.badEntry) assert.equal(badEntryObserved, true, scenario.name);
    if (scenario.error) assert.match(failure.message, scenario.error, scenario.name);
    if (scenario.noWork) {
      assert.deepEqual(actions, [], scenario.name);
      assert.deepEqual(copied, [], scenario.name);
      assert.equal(linked, false, scenario.name);
    } else {
      assert.equal(copied.filter(name => name === 'INSTALL.md').length, 1, scenario.name);
      if (scenario.expectedActions) assert.deepEqual(actions, scenario.expectedActions, scenario.name);
      else assert.deepEqual(actions.filter(action => ['pack', 'install', 'smoke'].includes(action)),
        scenario.missingInstall ? ['pack'] : ['pack', 'install', 'smoke'], scenario.name);
      if (scenario.missingInstall) assert.equal(actions.includes('link'), false, scenario.name);
      assert(actions.includes('cleanup'), scenario.name);
    }
    assert.equal(linked, Boolean(scenario.retains || scenario.linked), scenario.name);
    if (scenario.fails) {
      assert.deepEqual(writes, [], scenario.name);
    } else {
      const result = JSON.parse(writes.join(''));
      assert.equal(result.package, 'discord-surface');
      assert.equal(result.version, '0.1.0');
      assert.equal(result.files, members.length);
      if (scenario.retains) {
        assert.deepEqual(result.retainedArtifact, { path: target, accepted: false });
        if (scenario.control !== 'leaf') {
          assert.equal(retainedMissing, false, scenario.name);
          assert.equal(retainedInode, 30n, scenario.name);
          assert.equal(linkCount, 1n, 'scratch removal drops exactly the original archive link');
          assert.equal(archiveCtime, 13n, 'link and unlink both change ctime');
        }
        assert(actions.indexOf('smoke') < actions.indexOf('link'));
        assert(actions.indexOf('link') < actions.indexOf('close'));
        assert(actions.indexOf('close') < actions.indexOf('cleanup'));
        assert(actions.indexOf('cleanup') < actions.indexOf('output'));
      } else {
        assert.deepEqual(Object.keys(result).sort(), ['files', 'package', 'version']);
        assert.equal(actions.includes('link'), false);
      }
    }
  }
});
