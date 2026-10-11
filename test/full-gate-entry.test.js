'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const { PassThrough } = require('node:stream');
const { relay, revision, noVerdict, MESSAGES, NO_VERDICT } = require('../scripts/full-gate');

const PROJECT = path.resolve(__dirname, '..');
const GATE = path.join(PROJECT, 'scripts/full-gate.js');
const BODY_LABEL = 'DISCORD_SURFACE_GATE_BODY';
const BODY_TOKEN = 'DISCORD_SURFACE_GATE_BODY_TOKEN';
const BODY_AUTH_REQUEST = 'body-auth-request';

function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-entry-fixture-'));
  const root = path.join(scratch, 'repo');
  fs.mkdirSync(root);
  const env = { ...process.env };
  env.NODE_OPTIONS = '';
  const local = spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' });
  for (const key of local.stdout.trim().split('\n')) delete env[key];
  const git = args => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '--initial-branch=main']);
  fs.writeFileSync(path.join(root, 'input'), 'source\n');
  git(['add', 'input']);
  git(['-c', 'user.name=Gate fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  const marker = path.join(scratch, 'body.json');
  const protocol = path.join(scratch, 'admission.json');
  const leaseFile = path.join(scratch, 'admission-lease.json');
  const emergencyRelease = path.join(scratch, 'process-table-release');
  const admit = path.join(scratch, 'admit');
  fs.writeFileSync(admit, '#!' + process.execPath + '\n' + [
    "const fs = require('node:fs');",
    "const cp = require('node:child_process');",
    "setTimeout(() => process.exit(3), 120000).unref();",
    "fs.writeFileSync(process.env.FIXTURE_PROTOCOL, JSON.stringify(process.argv.slice(2)));",
    "if (process.env.FIXTURE_LEASE_ENFORCE) {",
    "  const args=process.argv.slice(2);const holders=[];for(let i=0;i<args.length-1;i++)if(args[i]==='--holder')holders.push(Number(args[++i]));",
    "  const start=pid=>{const check=cp.spawnSync('/bin/ps',['-p',String(pid),'-o','lstart=,stat='],{encoding:'utf8',timeout:1000});if(check.status!==0)return null;const fields=check.stdout.trim().split(/\\s+/);const state=fields.pop();return state&&!state.startsWith('Z')?fields.join(' '):null;};",
    "  if(fs.existsSync(process.env.FIXTURE_LEASE_FILE)){const lease=JSON.parse(fs.readFileSync(process.env.FIXTURE_LEASE_FILE,'utf8'));if(lease.holders.some(holder=>start(holder.pid)===holder.start))process.exit(3);}",
    "  const owned=holders.map(pid=>({pid,start:start(pid)}));if(owned.some(holder=>!holder.start))process.exit(4);fs.writeFileSync(process.env.FIXTURE_LEASE_FILE,JSON.stringify({holders:owned}));",
    "}",
    "if (process.env.FIXTURE_CHANGE) fs.writeFileSync(process.env.FIXTURE_CHANGE, 'changed');",
    "if (process.env.FIXTURE_MOVE_TARGET_WAIT) require('node:child_process').spawnSync('git',['-C',process.env.FIXTURE_ROOT,'update-ref','-d','refs/remotes/origin/main']);",
    "if (process.env.FIXTURE_SWITCH_BRANCH) require('node:child_process').spawnSync('git',['-C',process.env.FIXTURE_ROOT,'switch','-c',process.env.FIXTURE_SWITCH_BRANCH]);",
    "if (process.env.FIXTURE_ADMISSION_SIGNAL) process.kill(process.pid, process.env.FIXTURE_ADMISSION_SIGNAL);",
    "if (process.env.FIXTURE_HOLD_ADMISSION) {",
    "  const argv=process.argv.slice(2);const first=argv.indexOf('--holder');const second=argv.indexOf('--holder',first+1);const holder=Number(argv[first+1]);const guardian=Number(argv[second+1]);",
    "  fs.writeFileSync(process.env.FIXTURE_MARKER,JSON.stringify({pid:process.pid,holder,guardian,scratch:process.env.DISCORD_SURFACE_GATE_SCRATCH}));",
    "  process.on('SIGTERM',()=>{if(!process.env.FIXTURE_KILL_HOLDER)process.exit(3);}); process.stdout.write('ADMISSION_READY\\n');",
    "  if(process.env.FIXTURE_KILL_HOLDER)process.kill(holder,'SIGKILL');",
    "  setTimeout(()=>process.exit(3),15000);",
    "} else process.exit(Number(process.env.FIXTURE_ADMISSION_EXIT || 0));"
  ].join('\n'), { mode: 0o700 });
  const entry = path.join(scratch, 'entry.js');
  fs.writeFileSync(entry, [
    "const fs = require('node:fs');",
    "const { runFullGate } = require(" + JSON.stringify(GATE) + ");",
    "if(process.env.FIXTURE_SIGNAL_RECEIVED)process.on('SIGTERM',()=>fs.writeFileSync(process.env.FIXTURE_SIGNAL_RECEIVED,String(process.pid)));",
    "async function runBody() {",
    "  fs.writeFileSync(process.env.FIXTURE_MARKER, JSON.stringify({ pid: process.pid, parent: process.ppid, scratch: process.env.DISCORD_SURFACE_GATE_SCRATCH, gitDir: process.env.GIT_DIR, gitWorkTree: process.env.GIT_WORK_TREE, locale: process.env.LC_ALL, optionalLocks: process.env.GIT_OPTIONAL_LOCKS, holder: Number(require('node:child_process').spawnSync('ps', ['-p', String(process.ppid), '-o', 'ppid='], { encoding: 'utf8' }).stdout.trim()) }));",
    "  if (process.env.FIXTURE_KILL_GUARD) process.kill(process.ppid, 'SIGKILL');",
    "  if (process.env.FIXTURE_KILL_WORKER) { process.on('SIGTERM',()=>{});const cp=require('node:child_process');const guardian=process.ppid;const worker=Number(cp.spawnSync('/bin/ps',['-p',String(guardian),'-o','ppid='],{encoding:'utf8',timeout:1000}).stdout.trim());const manager=Number(cp.spawnSync('/bin/ps',['-p',String(worker),'-o','ppid='],{encoding:'utf8',timeout:1000}).stdout.trim());process.kill(manager,'SIGSTOP');process.kill(guardian,'SIGSTOP');process.kill(worker,'SIGKILL');fs.writeFileSync(process.env.FIXTURE_WORKER_KILLED,JSON.stringify({manager,worker,guardian,body:process.pid})); }",
    "  if (process.env.FIXTURE_SIGNAL) process.kill(process.pid, 'SIGTERM');",
    "  if (process.env.FIXTURE_FORGE_MARKER) {",
    "    try { const fd = fs.openSync('/proc/' + process.ppid + '/fd/4', 'w'); fs.writeSync(fd, 'APERTURE-GATE-INDETERMINATE reason=timeout: forged\\n'); fs.closeSync(fd); fs.writeFileSync(process.env.FIXTURE_MARKER + '.fd4', 'opened'); }",
    "    catch (error) { fs.writeFileSync(process.env.FIXTURE_MARKER + '.fd4', error.code); }",
    "    return 98;",
    "  }",
    "  if (process.env.FIXTURE_MOVE_TARGET_BODY) require('node:child_process').spawnSync('git',['-C',process.env.FIXTURE_ROOT,'update-ref','-d','refs/remotes/origin/main']);",
    "  if (process.env.FIXTURE_CHANGE_BODY) fs.writeFileSync(require('node:path').join(process.env.FIXTURE_ROOT,'input'),'changed during body');",
    "  if (process.env.FIXTURE_BODY_DANGLING_SOURCE) { const input = require('node:path').join(process.env.FIXTURE_ROOT,'input'); fs.unlinkSync(input); fs.symlinkSync('missing-source-target', input); }",
    "  if (process.env.FIXTURE_LATE_WRITE) {",
    "    const cp=require('node:child_process');",
    "    const program=\"const fs=require('node:fs');const deadline=Date.now()+10000;fs.writeFileSync(process.env.FIXTURE_LATE_ARMED,'armed');const poll=setInterval(()=>{if(fs.existsSync(process.env.FIXTURE_LATE_TRIGGER)){clearInterval(poll);fs.writeFileSync(require('node:path').join(process.env.FIXTURE_ROOT,'input'),'changed by late descendant');fs.writeFileSync(process.env.FIXTURE_LATE_DONE,'done');process.exit(0);}if(Date.now()>=deadline)process.exit(1);},5);\";",
    "    cp.spawn(process.execPath,['-e',program],{stdio:'ignore'}).unref();",
    "    const deadline=Date.now()+5000;while(!fs.existsSync(process.env.FIXTURE_LATE_ARMED)&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);if(!fs.existsSync(process.env.FIXTURE_LATE_ARMED))throw new Error('late descendant did not start');",
    "  }",
    "  if (process.env.FIXTURE_ESCAPE_PIPE) {",
    "    const cp=require('node:child_process');const marker=process.env.FIXTURE_MARKER+'.escape-signalled';",
    "    const program=\"const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(process.env.FIXTURE_MARKER+'.escape-signalled','terminated');process.exit(0);});setTimeout(()=>process.exit(0),90000);\";",
    "    const escape=cp.spawn(process.execPath,['-e',program],{detached:true,stdio:'inherit'});escape.unref();",
    "    const info=JSON.parse(fs.readFileSync(process.env.FIXTURE_MARKER,'utf8'));info.escapePid=escape.pid;info.escapeStart=cp.spawnSync('ps',['-p',String(escape.pid),'-o','lstart='],{encoding:'utf8',timeout:10000}).stdout.trim();fs.writeFileSync(process.env.FIXTURE_MARKER+'.part',JSON.stringify(info));fs.renameSync(process.env.FIXTURE_MARKER+'.part',process.env.FIXTURE_MARKER);",
    "  }",
    "  if (process.env.FIXTURE_READ_ONLY_SCRATCH) { const ro=require('node:path').join(process.env.DISCORD_SURFACE_GATE_SCRATCH,'ro');fs.mkdirSync(ro);fs.writeFileSync(require('node:path').join(ro,'f'),'x');fs.chmodSync(ro,0o500); }",
    "  if (process.env.FIXTURE_GROUP_SIGNAL) process.kill(0,'SIGTERM');",
    "  if (process.env.FIXTURE_LEFTOVER) require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),15000)'], { stdio: 'ignore' }).unref();",
    "  if (process.env.FIXTURE_HANG) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('BODY_READY\\n'); return new Promise(() => {}); }",
    "  return Number(process.env.FIXTURE_BODY_EXIT || 0);",
    "}",
    "module.exports = { runBody };",
    "if (require.main === module) {",
    "  setTimeout(() => process.exit(98), 120000).unref();",
    "  runFullGate(process.env.FIXTURE_ROOT, 'fixture', __filename, []).then(code => { process.exitCode = code; });",
    "}"
  ].join('\n'));
  const processes = [];
  t.after(() => {
    try { fs.writeFileSync(emergencyRelease, 'release'); } catch {}
    try {
      const stopped = JSON.parse(fs.readFileSync(path.join(scratch, 'worker-killed'), 'utf8'));
      process.kill(stopped.manager, 'SIGCONT');
      process.kill(stopped.guardian, 'SIGCONT');
    } catch {}
    for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  function launch(extra = {}) {
    const child = spawn(process.execPath, [entry], {
      env: {
        ...env, APERTURE_GATE_ADMISSION_COMMAND: admit,
        APERTURE_GATE_TIME_LEFT_S: '120', APERTURE_GATE_SLOWEST_RUN_S: '60',
        FIXTURE_ROOT: root, FIXTURE_MARKER: marker, FIXTURE_PROTOCOL: protocol,
        FIXTURE_LEASE_FILE: leaseFile, ...extra
      }, stdio: ['ignore', 'pipe', 'pipe']
    });
    processes.push(child);
    let output = '';
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('BODY_READY\n') || output.includes('ADMISSION_READY\n')) resolveReady();
    });
    const done = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, output })));
    return { child, ready, done };
  }
  return { root, marker, protocol, launch, git, env, scratch, leaseFile, emergencyRelease };
}

function filesUnder(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return filesUnder(absolute);
    return entry.isFile() ? [absolute] : [];
  });
}

function publicEntry(t, file, authorization, extraEnv = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-public-entry-'));
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin);
  const admission = path.join(scratch, 'admit');
  const admissionMarker = path.join(scratch, 'admission-started');
  const releaseMarker = path.join(scratch, 'admission-release');
  const bodyMarker = path.join(scratch, 'body-started');
  const npm = path.join(bin, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  fs.writeFileSync(admission, '#!' + process.execPath + '\n' + [
    "const fs=require('node:fs');fs.writeFileSync(process.env.FIXTURE_PUBLIC_ADMISSION,'started');",
    "if(process.env.FIXTURE_PUBLIC_HOLD_ADMISSION){const stop=setTimeout(()=>process.exit(124),20000);const poll=setInterval(()=>{if(fs.existsSync(process.env.FIXTURE_PUBLIC_RELEASE)){clearInterval(poll);clearTimeout(stop);process.exit(0);}},10);}else process.exit(0);"
  ].join('\n') + '\n', { mode: 0o700 });
  fs.writeFileSync(npm, '#!/usr/bin/env node\n' + [
    "const fs=require('node:fs');",
    "fs.writeFileSync(process.env.FIXTURE_PUBLIC_BODY,JSON.stringify({admitted:fs.existsSync(process.env.FIXTURE_PUBLIC_ADMISSION),secretPresent:Boolean(process.env.DISCORD_SURFACE_GATE_NO_VERDICT_SECRET)}));",
    "process.exit(7);"
  ].join('\n') + '\n', { mode: 0o700 });
  const label = file === 'scripts/test-gate.js' ? 'test' : 'package-smoke';
  const env = {
    ...process.env,
    [BODY_LABEL]: label,
    [BODY_TOKEN]: authorization === 'empty' ? '' : 'caller-owned-token',
    APERTURE_GATE_ADMISSION_COMMAND: admission,
    APERTURE_GATE_TIME_LEFT_S: authorization === 'silence' ? '8' : '60',
    APERTURE_GATE_SLOWEST_RUN_S: authorization === 'silence' ? '1' : '5',
    FIXTURE_PUBLIC_HOLD_ADMISSION: ['silence', 'disconnect', 'reply'].includes(authorization) ? '1' : '',
    FIXTURE_PUBLIC_ADMISSION: admissionMarker,
    FIXTURE_PUBLIC_RELEASE: releaseMarker,
    FIXTURE_PUBLIC_BODY: bodyMarker,
    PATH: bin + path.delimiter + (process.env.PATH || ''),
    NODE_OPTIONS: '',
    ...extraEnv
  };
  delete env.NODE_TEST_CONTEXT;
  const registered = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf8')).scripts.test.split(/\s+/).slice(2);
  const args = file === 'scripts/test-gate.js' ? registered : [];
  const child = spawn(process.execPath, [path.join(PROJECT, file), ...args], {
    cwd: PROJECT,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let output = '';
  let requests = 0;
  let forgedReplySent = false;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); });
  if (authorization === 'reply') {
    child.once('spawn', () => {
      child.send({ kind: 'body-authorized', label, authorized: true, token: env[BODY_TOKEN] }, error => {
        forgedReplySent = !error;
      });
    });
  }
  child.on('message', message => {
    if (message?.kind !== BODY_AUTH_REQUEST) return;
    requests += 1;
    if (authorization === 'reply') child.send({ kind: 'body-authorized', label: message.label, authorized: true, token: env[BODY_TOKEN] });
    if (authorization === 'false') child.send({ kind: 'body-authorized', label: message.label, authorized: false, token: 'caller-owned-token' });
    if (authorization === 'disconnect') child.disconnect();
  });
  if (authorization === 'disconnect') {
    const poll = setInterval(() => {
      if (!fs.existsSync(admissionMarker)) return;
      clearInterval(poll);
      if (child.connected) child.disconnect();
    }, 10);
    poll.unref();
  }
  const done = new Promise(resolve => {
    if (authorization !== 'disconnect') {
      child.once('close', (code, signal) => resolve({ code, signal, output }));
      return;
    }
    child.once('exit', (code, signal) => setImmediate(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code, signal, output });
    }));
  });
  const bound = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 12000);
  t.after(() => {
    clearTimeout(bound);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  return {
    done,
    requests: () => requests,
    forgedReplySent: () => forgedReplySent,
    admissionMarker,
    bodyMarker,
    releaseAdmission: () => fs.writeFileSync(releaseMarker, 'release')
  };
}

test('both public full entries decline before starting work without admission', () => {
  const env = { ...process.env };
  env.NODE_OPTIONS = '';
  delete env.APERTURE_GATE_ADMISSION_COMMAND;
  delete env.DISCORD_SURFACE_GATE_BODY;
  for (const file of ['scripts/test-gate.js', 'scripts/package-smoke.js']) {
    const registered = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf8')).scripts.test.split(/\s+/).slice(2);
    const args = file === 'scripts/test-gate.js' ? registered : [];
    const result = spawnSync(process.execPath, [path.join(PROJECT, file), ...args], { env, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 98);
    assert.match(result.stderr, /APERTURE-GATE-INDETERMINATE reason=queue-missing/);
    assert.match(result.stderr, /nothing ran/);
  }
});

test('source fingerprint and bypass decisions stay at their owners', () => {
  const scripts = filesUnder(path.join(PROJECT, 'scripts')).filter(file => file.endsWith('.js'));
  const relative = files => files.map(file => path.relative(PROJECT, file).split(path.sep).join('/')).sort();
  const contents = new Map(scripts.map(file => [file, fs.readFileSync(file, 'utf8')]));
  const digestOwners = scripts.filter(file => /crypto\.createHash\(['"]sha256['"]\)/.test(contents.get(file)));
  const bypassOwners = scripts.filter(file => /\bBODY_LABEL\b/.test(contents.get(file)));
  const gateEntrypoints = scripts.filter(file => file !== path.join(PROJECT, 'scripts/full-gate.js') && /runFullGate\(root,/.test(contents.get(file)));
  const bodyDispatchers = scripts.filter(file => /body-runner\.js/.test(contents.get(file)));
  const nodeOptionOwners = scripts.filter(file => /\bNODE_OPTIONS\b/.test(contents.get(file)));
  assert.deepEqual(relative(digestOwners), ['scripts/full-gate.js']);
  assert.deepEqual(relative(bypassOwners), []);
  assert.deepEqual(relative(gateEntrypoints), ['scripts/package-smoke.js', 'scripts/test-gate.js']);
  assert.deepEqual(relative(bodyDispatchers), ['scripts/full-gate-watchdog.js']);
  assert.deepEqual(relative(nodeOptionOwners), ['scripts/full-gate.js', 'scripts/package-smoke.js', 'scripts/test-gate.js']);
});

test('recovery guidance covers every no-verdict action', () => {
  for (const file of ['README.md', 'INSTALL.md', 'AGENTS.md']) {
    const content = fs.readFileSync(path.join(PROJECT, file), 'utf8');
    for (const reason of ['queue-missing', 'setup', 'capacity', 'cleanup']) assert.ok(content.includes(reason), file + ' omits ' + reason);
    assert.match(content, /same ticket/i);
    assert.match(content, /raw body exit 98/i);
  }
});

test('a body-created no-verdict file cannot suppress the gate marker', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-declined-sentinel-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const output = path.join(scratch, 'stderr');
  fs.writeFileSync(path.join(scratch, 'declined'), 'caller-created');
  const descriptor = fs.openSync(output, 'w');
  try {
    assert.equal(noVerdict('timeout', 'body stopped', scratch, descriptor, 'gate-owned-secret'), NO_VERDICT);
    assert.equal(noVerdict('timeout', 'duplicate report', scratch, descriptor, 'gate-owned-secret'), NO_VERDICT);
  } finally {
    fs.closeSync(descriptor);
  }
  const lines = fs.readFileSync(output, 'utf8').trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^APERTURE-GATE-INDETERMINATE reason=timeout:/);
});

for (const file of ['scripts/test-gate.js', 'scripts/package-smoke.js']) {
  test('caller silence stays inside the deadline for ' + file, { timeout: 15000 }, async t => {
    const run = publicEntry(t, file, 'silence');
    const result = await run.done;
    assert.equal(result.code, 98, result.output);
    assert.match(result.output, /APERTURE-GATE-INDETERMINATE reason=timeout/);
    assert.equal(run.requests(), 0);
    assert.equal(fs.existsSync(run.admissionMarker), true);
    assert.equal(fs.existsSync(run.bodyMarker), false);
  });

  test('caller authorization cannot bypass admission for ' + file, { timeout: 30000 }, async t => {
    const run = publicEntry(t, file, 'reply');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(run.admissionMarker) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(run.admissionMarker), true, 'real admission did not start');
    assert.equal(fs.existsSync(run.bodyMarker), false, 'caller authorization dispatched the body before admission');
    run.releaseAdmission();
    const result = await run.done;
    assert.equal(run.forgedReplySent(), true);
    assert.equal(result.code, file === 'scripts/test-gate.js' ? 7 : 1, result.output);
    assert.equal(result.output.includes('APERTURE-GATE-INDETERMINATE'), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(run.bodyMarker, 'utf8')), { admitted: true, secretPresent: false });
  });

  test('false caller authorization cannot skip admission for ' + file, { timeout: 30000 }, async t => {
    const run = publicEntry(t, file, 'false');
    const result = await run.done;
    assert.notEqual(result.code, 98, result.output);
    assert.equal(run.requests(), 0);
    assert.equal(fs.existsSync(run.admissionMarker), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(run.bodyMarker, 'utf8')), { admitted: true, secretPresent: false });
  });

  test('an empty caller token still enters admission for ' + file, { timeout: 30000 }, async t => {
    const run = publicEntry(t, file, 'empty');
    const result = await run.done;
    assert.notEqual(result.code, 98, result.output);
    assert.equal(run.requests(), 0);
    assert.equal(fs.existsSync(run.admissionMarker), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(run.bodyMarker, 'utf8')), { admitted: true, secretPresent: false });
  });

  test('caller disconnect cannot restart admission for ' + file, { timeout: 15000 }, async t => {
    const run = publicEntry(t, file, 'disconnect');
    const result = await run.done;
    assert.equal(result.code, 98, result.output);
    assert.match(result.output, /APERTURE-GATE-INDETERMINATE reason=interrupted/);
    assert.equal(run.requests(), 0);
    assert.equal(fs.existsSync(run.admissionMarker), true);
    assert.equal(fs.existsSync(run.bodyMarker), false);
  });
}

test('an inherited body label cannot bypass missing admission', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const result = await f.launch({ DISCORD_SURFACE_GATE_BODY: 'fixture', APERTURE_GATE_ADMISSION_COMMAND: '' }).done;
  assert.equal(result.code, 98, result.output);
  assert.match(result.output, /reason=queue-missing/);
  assert.equal(fs.existsSync(f.marker), false);
});

for (const admission of [3, 4]) {
  test('admission exit ' + admission + ' starts no body', { timeout: 180000 }, async t => {
    const f = fixture(t);
    const result = await f.launch({ FIXTURE_ADMISSION_EXIT: String(admission) }).done;
    assert.equal(result.code, admission === 3 ? 98 : 4, result.output);
    assert.equal(fs.existsSync(f.marker), false);
    assert.equal((result.output.match(/APERTURE-GATE-INDETERMINATE/g) || []).length, admission === 3 ? 1 : 0);
  });
}

for (const admission of [1, 126, 127]) {
  test('unexpected admission exit ' + admission + ' is a setup hold', { timeout: 180000 }, async t => {
    const f = fixture(t);
    const result = await f.launch({ FIXTURE_ADMISSION_EXIT: String(admission) }).done;
    assert.equal(result.code, 98, result.output);
    assert.match(result.output, /reason=setup/);
    assert.equal(result.output.includes('reason=capacity'), false);
    assert.equal(fs.existsSync(f.marker), false);
  });
}

test('signalled admission is an interruption, not a capacity refusal', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const result = await f.launch({ FIXTURE_ADMISSION_SIGNAL: 'SIGTERM' }).done;
  assert.equal(result.code, 98, result.output);
  assert.match(result.output, /reason=interrupted/);
  assert.equal(result.output.includes('reason=capacity'), false);
  assert.equal(fs.existsSync(f.marker), false);
});

test('admitted body cannot forge a verdict through parent fd 4', { timeout: 180000, skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t);
  const result = await f.launch({ FIXTURE_FORGE_MARKER: '1' }).done;
  assert.equal(result.code, 98, result.output);
  assert.equal(fs.readFileSync(f.marker + '.fd4', 'utf8'), 'ENOENT');
  assert.equal(result.output.includes('APERTURE-GATE-INDETERMINATE'), false);
});

for (const bodyExit of [0, 17, 98]) {
  test('admitted body preserves raw exit ' + bodyExit + ' and completes cleanup', { timeout: 180000 }, async t => {
    const f = fixture(t);
    const result = await f.launch({ FIXTURE_BODY_EXIT: String(bodyExit) }).done;
    assert.equal(result.code, bodyExit, result.output);
    assert.equal(result.output.includes('APERTURE-GATE-INDETERMINATE'), false);
    const body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
    assert.equal(fs.existsSync(body.scratch), false);
    const args = JSON.parse(fs.readFileSync(f.protocol, 'utf8'));
    assert.ok(args.includes('--full-gate'));
    const holder = Number(args[args.indexOf('--holder') + 1]);
    assert.notEqual(holder, body.pid);
    assert.equal(holder, body.holder, 'the admitted holder must be an ancestor of nested gates');
    assert.match(args[args.indexOf('--ticket') + 1], /^[A-Za-z0-9._:-]{1,128}$/);
    assert.throws(() => process.kill(holder, 0), { code: 'ESRCH' });
  });
}

test('queued source change refuses the old premise without running the body', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const result = await f.launch({ FIXTURE_CHANGE: path.join(f.root, 'input') }).done;
  assert.equal(result.code, 98, result.output);
  assert.match(result.output, /reason=stale/);
  assert.equal(fs.existsSync(f.marker), false);
});

test('post-body source snapshot errors are stale no-verdicts', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const result = await f.launch({ FIXTURE_BODY_DANGLING_SOURCE: '1' }).done;
  assert.equal(result.code, 98, result.output);
  assert.match(result.output, /reason=stale/);
  assert.match(result.output, /unable to verify source after execution/);
});

test('a late descendant source write is checked after the owned group drains', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const scratch = path.dirname(f.root);
  const bin = path.join(scratch, 'late-write-bin');
  const realPath = f.env.PATH || process.env.PATH || '';
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ps'), [
    '#!/bin/sh',
    'if [ "$1" = "-A" ] && [ "$2" = "-o" ]; then',
    '  : > "$FIXTURE_LATE_TRIGGER"',
    '  attempts=0',
    '  while [ ! -e "$FIXTURE_LATE_DONE" ] && [ "$attempts" -lt 200 ]; do',
    '    sleep 0.01',
    '    attempts=$((attempts + 1))',
    '  done',
    'fi',
    'exec /bin/ps "$@"'
  ].join('\n'), { mode: 0o700 });
  const result = await f.launch({
    FIXTURE_LATE_WRITE: '1',
    FIXTURE_LATE_ARMED: path.join(scratch, 'late-write-armed'),
    FIXTURE_LATE_TRIGGER: path.join(scratch, 'late-write-trigger'),
    FIXTURE_LATE_DONE: path.join(scratch, 'late-write-done'),
    PATH: bin + path.delimiter + realPath
  }).done;
  assert.equal(result.code, 98, result.output);
  assert.match(result.output, /reason=stale/);
  assert.equal(fs.readFileSync(path.join(f.root, 'input'), 'utf8'), 'changed by late descendant');
});

test('interruption stops a body that ignores TERM before releasing its holder', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const run = f.launch({ FIXTURE_HANG: '1' });
  await Promise.race([run.ready, run.done.then(value => assert.fail(value.output))]);
  const body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
  run.child.kill('SIGTERM');
  const result = await run.done;
  assert.equal(result.code, 98, result.output);
  assert.match(result.output, /APERTURE-GATE-INDETERMINATE reason=interrupted/);
  assert.equal((result.output.match(/APERTURE-GATE-INDETERMINATE/g) || []).length, 1);
  assert.throws(() => process.kill(body.pid, 0), { code: 'ESRCH' });
  const args = JSON.parse(fs.readFileSync(f.protocol, 'utf8'));
  const holder = Number(args[args.indexOf('--holder') + 1]);
  assert.throws(() => process.kill(holder, 0), { code: 'ESRCH' });
});

test('child marker text cannot manufacture the enclosing gate verdict', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk.toString(); });
  relay(input, output);
  input.write('APERTURE-GATE-');
  input.end('INDETERMINATE reason=capacity\n');
  await new Promise(resolve => input.once('end', resolve));
  assert.equal(text, 'CHILD-GATE-INDETERMINATE reason=capacity\n');
});

test('the full runner retains every existing registration and its serial execution', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf8'));
  const nonFull = new Set(['build', 'typecheck', 'start', 'prepack']);
  assert.deepEqual(Object.keys(pkg.scripts).filter(name => !nonFull.has(name)).sort(), ['package-smoke', 'test']);
  const files = pkg.scripts.test.split(/\s+/).filter(token => token.startsWith('test/'));
  assert.equal(files.length, new Set(files).size);
  assert.equal(files.filter(file => file === 'test/full-gate-entry.test.js').length, 1);
  assert.equal(files.filter(file => file === 'test/ordinary-claude-scenarios/binding-owner.cjs').length, 1);
  assert.ok(pkg.scripts.test.startsWith('node scripts/test-gate.js '));
  const runner = fs.readFileSync(path.join(PROJECT, 'scripts/test-gate.js'), 'utf8');
  assert.match(runner, /'--test-concurrency=1'/);
});


test('inherited Git repository variables never reach the body', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const config = path.join(f.root, '.git', 'config');
  const before = fs.readFileSync(config);
  const result = await f.launch({ GIT_DIR: path.join(f.root, '.git'), GIT_WORK_TREE: f.root }).done;
  assert.equal(result.code, 0, result.output);
  const body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
  assert.equal(body.gitDir, undefined);
  assert.equal(body.gitWorkTree, undefined);
  assert.deepEqual(fs.readFileSync(config), before);
});

test('insufficient caller budget starts neither admission nor the body', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const result = await f.launch({ APERTURE_GATE_TIME_LEFT_S: '60', APERTURE_GATE_SLOWEST_RUN_S: '60' }).done;
  assert.equal(result.code, 98);
  assert.equal(fs.existsSync(f.protocol), false);
  assert.equal(fs.existsSync(f.marker), false);
});

test('final source snapshot timeout is a no-verdict result', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const bin = path.join(f.scratch, 'slow-git');
  fs.mkdirSync(bin);
  const realGit = (process.env.PATH || '').split(path.delimiter).map(directory => path.join(directory, 'git')).find(file => fs.existsSync(file));
  assert.ok(realGit, 'the test host must provide git');
  const wrapper = path.join(bin, 'git');
  fs.writeFileSync(wrapper, '#!' + process.execPath + '\n' + [
    "const fs=require('node:fs');",
    "const cp=require('node:child_process');",
    "if(fs.existsSync(process.env.FIXTURE_FINAL_SNAPSHOT_MARKER))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);",
    "const result=cp.spawnSync(process.env.FIXTURE_REAL_GIT,process.argv.slice(2),{encoding:'utf8',env:process.env});",
    "if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);",
    "if(result.error){process.stderr.write(result.error.message);process.exitCode=1;}else process.exitCode=result.status===null?1:result.status;"
  ].join('\n') + '\n', { mode: 0o700 });
  const result = await f.launch({
    PATH: bin + path.delimiter + process.env.PATH,
    FIXTURE_REAL_GIT: realGit,
    FIXTURE_FINAL_SNAPSHOT_MARKER: f.marker,
    APERTURE_GATE_TIME_LEFT_S: '12',
    APERTURE_GATE_SLOWEST_RUN_S: '1'
  }).done;
  assert.equal(result.code, 98, result.output);
  assert.match(result.output, /APERTURE-GATE-INDETERMINATE reason=timeout/);
  assert.equal((result.output.match(/APERTURE-GATE-INDETERMINATE/g) || []).length, 1);
});

test('watchdog cleans a TERM-resistant body after its supervisor is killed', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const run = f.launch({ FIXTURE_HANG: '1' });
  await Promise.race([run.ready, run.done.then(value => assert.fail(value.output))]);
  const body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
  const args = JSON.parse(fs.readFileSync(f.protocol, 'utf8'));
  const holder = Number(args[args.indexOf('--holder') + 1]);
  run.child.kill('SIGKILL');
  const result = await run.done;
  assert.equal(result.signal, 'SIGKILL');
  const active = pid => {
    const state = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
    return state.status === 0 && !state.stdout.trim().startsWith('Z');
  };
  const bound = Date.now() + 30000;
  while ((active(body.pid) || active(holder)) && Date.now() < bound) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(active(body.pid), false);
  assert.equal(active(holder), false);
  assert.equal(fs.existsSync(body.scratch), false);
});
const pipelineScenarios = [
  { name: 'success', exit: 0, stages: ['run build', 'run typecheck', 'test'] },
  { name: 'build failure', fail: 'build', value: 7, exit: 7, stages: ['run build'] },
  { name: 'typecheck failure', fail: 'typecheck', value: 9, exit: 9, stages: ['run build', 'run typecheck'] },
  { name: 'actual Node test failure', fail: 'test', value: 1, exit: 1, stages: ['run build', 'run typecheck', 'test'] },
  { name: 'Node options name filter', nodeOptions: '--test-name-pattern=^none$', exit: 4, stages: [] },
  { name: 'Node options skip filter', nodeOptions: '--test-skip-pattern=.', exit: 4, stages: [] },
  { name: 'Node options only filter', nodeOptions: '--test-only', exit: 4, stages: [] },
  { name: 'Node options shard filter', nodeOptions: '--test-shard=1/2', exit: 4, stages: [] },
  { name: 'Node options name filter alias', nodeOptions: '--test_name_pattern=^none$', exit: 4, stages: [] },
  { name: 'Node options skip filter alias', nodeOptions: '--test_skip_pattern=.', exit: 4, stages: [] },
  { name: 'Node options only filter alias', nodeOptions: '--test_only', exit: 4, stages: [] },
  { name: 'Node options shard filter alias', nodeOptions: '--test_shard=1/2', exit: 4, stages: [] },
  { name: 'Node options escaped name selector', nodeOptions: String.raw`"--test\-name-pattern=^none$"`, exit: 4, stages: [] },
  { name: 'Node options escaped only selector', nodeOptions: String.raw`"--te\st-only"`, exit: 4, stages: [] },
  { name: 'Node options concatenated skip selector', nodeOptions: '"--test-skip"-pattern=.', exit: 4, stages: [] },
  { name: 'Node options concatenated name selector', nodeOptions: '--test-name-"pattern"=^none$', exit: 4, stages: [] },
  { name: 'Node options quoted preload path', preload: true, exit: 98, noVerdict: true, stages: [] },
  { name: 'Node options compatible heap limit', nodeOptions: '--max-old-space-size=128', exit: 0, stages: ['run build', 'run typecheck', 'test'] },
  { name: 'argument selection filter', suites: ['test/selected.test.js', '--test-name-pattern=^none$'], exit: 4, stages: [] },
  { name: 'missing registered suite', suites: [], exit: 4, stages: [] },
  { name: 'registered selection option', registered: ['test/selected.test.js', '--test-only'], suites: ['test/selected.test.js', '--test-only'], exit: 4, stages: [] },
  { name: 'duplicate registered suite', registered: ['test/selected.test.js', 'test/selected.test.js'], suites: ['test/selected.test.js', 'test/selected.test.js'], exit: 4, stages: [] }
];
for (const scenario of pipelineScenarios) test('public pipeline ' + scenario.name, { timeout: 180000 }, t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-pipeline-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, 'repo'); const bin = path.join(scratch, 'bin');
  fs.mkdirSync(root); fs.mkdirSync(bin); fs.mkdirSync(path.join(root, 'scripts')); fs.mkdirSync(path.join(root, 'test'));
  for (const file of ['test-gate.js','full-gate.js','full-gate-worker.js','full-gate-watchdog.js']) fs.copyFileSync(path.join(PROJECT,'scripts',file),path.join(root,'scripts',file));
  fs.mkdirSync(path.join(root,'scripts','full-gate'));
  fs.copyFileSync(path.join(PROJECT,'scripts','full-gate','body-runner.js'),path.join(root,'scripts','full-gate','body-runner.js'));
  const log = path.join(scratch,'stages.log');
  const preload = path.join(scratch, 'preload --test-only');
  if (scenario.preload) fs.writeFileSync(preload, 'module.exports = {};\n');
  fs.writeFileSync(path.join(root,'package.json'), JSON.stringify({scripts:{test:'node scripts/test-gate.js '+(scenario.registered || ['test/selected.test.js']).join(' ')}}));
  const npm = path.join(bin,'npm');
  fs.writeFileSync(npm, '#!' + process.execPath + '\n' + "const fs=require('node:fs');setTimeout(()=>process.exit(98),120000).unref();fs.appendFileSync(process.env.PIPELINE_LOG,process.argv.slice(2).join(' ')+'\\n');process.exit(process.argv[3]===process.env.PIPELINE_FAIL?Number(process.env.PIPELINE_EXIT):0);", { mode: 0o700 });
  const admitMarker = path.join(scratch, 'admission-started');
  const admit = path.join(bin,'admit'); fs.writeFileSync(admit,'#!'+process.execPath+'\nrequire(\"node:fs\").writeFileSync('+JSON.stringify(admitMarker)+',\"started\");process.exit(0);\n',{mode:0o700});
  fs.writeFileSync(path.join(root,'test','selected.test.js'), "const test=require('node:test');const fs=require('node:fs');const assert=require('node:assert/strict');setTimeout(()=>process.exit(98),120000).unref();test('actual selected test executes',()=>{fs.appendFileSync(process.env.PIPELINE_LOG,'test\\n');assert.notEqual(process.env.PIPELINE_FAIL,'test');});\n");
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,APERTURE_GATE_ADMISSION_COMMAND:admit,APERTURE_GATE_TIME_LEFT_S:'120',APERTURE_GATE_SLOWEST_RUN_S:'60',PIPELINE_LOG:log,PIPELINE_FAIL:scenario.fail||'',PIPELINE_EXIT:String(scenario.value||0)};
  const nodeOptions = scenario.preload ? '--require ' + JSON.stringify(preload) : scenario.nodeOptions;
  if (nodeOptions) env.NODE_OPTIONS=nodeOptions; else delete env.NODE_OPTIONS;
  delete env.DISCORD_SURFACE_GATE_BODY;
  const names=spawnSync('git',['rev-parse','--local-env-vars'],{encoding:'utf8'});
  for(const name of names.stdout.trim().split('\n')) delete env[name];
  for(const args of [['init','--initial-branch=main'],['add','.'],['-c','user.name=Pipeline fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture'],['update-ref','refs/remotes/origin/main','HEAD']]) {
    const result=spawnSync('git',['-C',root,...args],{env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  }
  const result=spawnSync(process.execPath,[path.join(root,'scripts/test-gate.js'),...(scenario.suites || ['test/selected.test.js'])],{cwd:root,env,encoding:'utf8',timeout:150000});
  assert.equal(result.status,scenario.exit,result.stdout+'\n'+result.stderr);
  if (scenario.exit === 4) assert.equal(fs.existsSync(admitMarker), false, 'caller errors must precede admission');
  if (scenario.noVerdict) {
    assert.match(result.stderr,/APERTURE-GATE-INDETERMINATE reason=setup/);
    assert.equal(fs.existsSync(admitMarker), false, 'preloads must be refused before admission');
  }
  assert.deepEqual(fs.existsSync(log) ? fs.readFileSync(log,'utf8').trim().split('\n') : [],scenario.stages);
  assert.equal(result.stderr.includes('APERTURE-GATE-INDETERMINATE'),Boolean(scenario.noVerdict));
  if (scenario.stages.includes('test')) assert.match(result.stdout,/FULL_GATE_TEST_ARGUMENTS=\["test\/selected.test.js"\]/);
});


test('an interruption during final source verification is a no-verdict', { skip: process.platform === 'win32', timeout: 180000 }, async t => {
  const f = fixture(t);
  const bin = path.join(f.scratch, 'git-wrapper');
  fs.mkdirSync(bin);
  const counter = path.join(f.scratch, 'revision-count');
  const signalMarker = path.join(f.scratch, 'final-snapshot-signal');
  const receivedMarker = path.join(f.scratch, 'final-snapshot-signal-received');
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const wrapper = path.join(bin, 'git');
  fs.writeFileSync(wrapper, '#!' + process.execPath + '\n' + [
    "const fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);",
    "if(args.includes('--show-toplevel')){const file=process.env.FIXTURE_REVISION_COUNTER;const count=Number(fs.existsSync(file)?fs.readFileSync(file,'utf8'):0)+1;fs.writeFileSync(file,String(count));if(count===3){fs.writeFileSync(process.env.FIXTURE_SIGNAL_MARKER,JSON.stringify({manager:process.ppid,count}));const until=Date.now()+10000;while(!fs.existsSync(process.env.FIXTURE_FINAL_RELEASE)&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}",
    "const result=cp.spawnSync(process.env.FIXTURE_REAL_GIT,args,{cwd:process.cwd(),env:process.env,encoding:'buffer'});",
    "if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);process.exit(result.status===null?1:result.status);"
  ].join('\n') + '\n', { mode: 0o700 });
  const run = f.launch({
    PATH: bin + path.delimiter + process.env.PATH,
    FIXTURE_REAL_GIT: realGit,
    FIXTURE_REVISION_COUNTER: counter,
    FIXTURE_SIGNAL_MARKER: signalMarker,
    FIXTURE_SIGNAL_RECEIVED: receivedMarker,
    FIXTURE_FINAL_RELEASE: f.emergencyRelease
  });
  const signalDeadline = Date.now() + 10000;
  while (!fs.existsSync(signalMarker) && Date.now() < signalDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(signalMarker), true, 'final source verification did not start');
  const signal = JSON.parse(fs.readFileSync(signalMarker, 'utf8'));
  assert.equal(signal.manager, run.child.pid);
  process.kill(run.child.pid, 'SIGTERM');
  fs.writeFileSync(f.emergencyRelease, 'release');
  const result = await run.done;
  assert.equal(fs.readFileSync(counter, 'utf8'), '3');
  assert.equal(fs.readFileSync(receivedMarker, 'utf8'), String(run.child.pid));
  assert.equal(result.code, 98, result.output);
  assert.match(result.output, /APERTURE-GATE-INDETERMINATE reason=interrupted/);
  assert.equal((result.output.match(/APERTURE-GATE-INDETERMINATE/g) || []).length, 1);
});

for (const layout of ['detached', 'uncommitted', 'archive']) {
  test('source layout ' + layout + ' preserves admitted execution', { timeout: 180000 }, async t => {
    const f = fixture(t);
    if (layout === 'detached') f.git(['checkout', '--detach', 'HEAD']);
    if (layout === 'uncommitted') {
      f.git(['update-ref', '-d', 'refs/heads/main']);
      f.git(['update-ref', '-d', 'refs/remotes/origin/main']);
    }
    if (layout === 'archive') fs.rmSync(path.join(f.root, '.git'), { recursive: true, force: true });
    const result = await f.launch().done;
    assert.equal(result.code, 0, result.output);
    assert.equal(fs.existsSync(f.marker), true);
  });
}

for (const layout of ['git', 'archive']) test(`${layout} source symlink outside the fingerprinted root is rejected`, t => {
  const f = fixture(t);
  const target = path.join(path.dirname(f.root), 'external-source');
  fs.writeFileSync(target, 'first');
  fs.symlinkSync(target, path.join(f.root, 'source-link'));
  if (layout === 'archive') fs.rmSync(path.join(f.root, '.git'), { recursive: true, force: true });
  assert.throws(() => revision(f.root), /unsupported source symlink: source-link/);
  fs.writeFileSync(target, 'changed');
  assert.throws(() => revision(f.root), /unsupported source symlink: source-link/);
});

test('source digest frames adjacent binary file payloads', t => {
  const f = fixture(t);
  const firstFile = path.join(f.root, 'a');
  const secondFile = path.join(f.root, 'b');
  const mode = String(fs.statSync(path.join(f.root, 'input')).mode);
  fs.writeFileSync(firstFile, Buffer.from('b\0' + mode + '\0X'));
  fs.writeFileSync(secondFile, Buffer.from('Y'));
  const first = revision(f.root);
  fs.writeFileSync(firstFile, Buffer.alloc(0));
  fs.writeFileSync(secondFile, Buffer.from('Xb\0' + mode + '\0Y'));
  assert.notEqual(revision(f.root), first);
});

test('git revision hashes filenames with invalid UTF-8 bytes', { skip: process.platform !== 'linux' }, t => {
  const f = fixture(t);
  const name = Buffer.from([0x62, 0x61, 0x64, 0x2d, 0x80, 0x2e, 0x6a, 0x73]);
  const directory = Buffer.concat([Buffer.from(f.root + path.sep), name]);
  const file = Buffer.concat([directory, Buffer.from(path.sep), Buffer.from('source.js')]);
  fs.mkdirSync(directory);
  fs.writeFileSync(file, 'first');
  f.git(['add', '-A']);
  const first = revision(f.root);
  fs.writeFileSync(file, 'changed');
  assert.notEqual(revision(f.root), first);
});

for (const layout of ['git', 'archive']) test(`${layout} fingerprint ignores generated Python cache while retaining source edits`, t => {
  const f = fixture(t);
  fs.copyFileSync(path.join(PROJECT, '.gitignore'), path.join(f.root, '.gitignore'));
  const source = path.join(f.root, 'helper.py');
  fs.writeFileSync(source, 'value = 1\n');
  if (layout === 'git') f.git(['add', '.gitignore', 'helper.py']);
  else fs.rmSync(path.join(f.root, '.git'), { recursive: true, force: true });
  const first = revision(f.root);
  const cache = path.join(f.root, 'src', '__pycache__');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'helper.cpython.pyc'), 'generated bytecode');
  assert.equal(revision(f.root), first);
  fs.writeFileSync(source, 'value = 2\n');
  assert.notEqual(revision(f.root), first);
});

test('archive beneath an unrelated worktree is scanned directly', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, '.gitignore'), 'dist/\n');
  const archive = path.join(f.root, 'dist', 'archive');
  fs.mkdirSync(archive, { recursive: true });
  const source = path.join(archive, 'input');
  fs.writeFileSync(source, 'first\n');
  const first = JSON.parse(revision(archive));
  assert.equal(first.kind, 'archive');
  assert.equal(first.head, null);
  assert.equal(first.target, null);
  assert.equal(first.index, null);
  assert.equal(first.branch, null);
  assert.equal(first.repository, fs.realpathSync(archive));
  fs.writeFileSync(source, 'second\n');
  assert.notEqual(JSON.parse(revision(archive)).files, first.files);
});

test('queue ticket retains one head and changes for a new head', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const ticket = () => {
    const args = JSON.parse(fs.readFileSync(f.protocol, 'utf8'));
    return args[args.indexOf('--ticket') + 1];
  };
  assert.equal((await f.launch().done).code, 0);
  const first = ticket();
  assert.equal((await f.launch().done).code, 0);
  assert.equal(ticket(), first);
  fs.writeFileSync(path.join(f.root, 'input'), 'new head\n');
  f.git(['add', 'input']);
  f.git(['-c', 'user.name=Gate fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'new head']);
  assert.equal((await f.launch().done).code, 0);
  assert.notEqual(ticket(), first);
});

test('git inspection settings do not alter the body environment', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const result = await f.launch({ LC_ALL: 'en_US.UTF-8', GIT_OPTIONAL_LOCKS: '1' }).done;
  assert.equal(result.code, 0, result.output);
  const body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
  assert.equal(body.locale, 'en_US.UTF-8');
  assert.equal(body.optionalLocks, '1');
});

test('body signal crash remains a raw failure', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const result = await f.launch({ FIXTURE_SIGNAL: '1' }).done;
  assert.equal(result.code, 143, result.output);
  assert.equal(result.output.includes('APERTURE-GATE-INDETERMINATE'), false);
});

test('watchdog death cleans the body while its worker still owns admission', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const run = f.launch({ FIXTURE_KILL_GUARD: '1', FIXTURE_HANG: '1' });
  const result = await run.done;
  assert.equal(result.code, 98, result.output);
  assert.equal((result.output.match(/APERTURE-GATE-INDETERMINATE/g) || []).length, 1);
  const body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
  assert.throws(() => process.kill(body.pid, 0), { code: 'ESRCH' });
  assert.equal(fs.existsSync(body.scratch), false);
});

test('watchdog holds admission through cleanup after worker loss', { skip: process.platform === 'win32', timeout: 180000 }, async t => {
  const f = fixture(t);
  const workerKilled = path.join(f.scratch, 'worker-killed');
  const env = {
    FIXTURE_LEASE_ENFORCE: '1',
    FIXTURE_KILL_WORKER: '1',
    FIXTURE_HANG: '1',
    FIXTURE_WORKER_KILLED: workerKilled
  };
  const first = f.launch(env);
  const waitDeadline = Date.now() + 10000;
  while (!fs.existsSync(workerKilled) && Date.now() < waitDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(workerKilled), true, 'fixture did not stop the manager and watchdog after worker loss');
  const stopped = JSON.parse(fs.readFileSync(workerKilled, 'utf8'));
  const lease = JSON.parse(fs.readFileSync(f.leaseFile, 'utf8'));
  assert.equal(lease.holders.length, 2);
  assert.notEqual(lease.holders[0].pid, lease.holders[1].pid);

  const secondMarker = path.join(f.scratch, 'second-body.json');
  const second = f.launch({ ...env, FIXTURE_KILL_WORKER: '', FIXTURE_HANG: '', FIXTURE_MARKER: secondMarker });
  const secondResult = await second.done;
  assert.equal(secondResult.code, 98, secondResult.output);
  assert.match(secondResult.output, /reason=capacity/);
  assert.equal(fs.existsSync(secondMarker), false, 'a second body started before the first cleanup finished');

  process.kill(stopped.manager, 'SIGCONT');
  const firstResult = await first.done;
  assert.equal(firstResult.code, 98, firstResult.output);
  const body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
  assert.throws(() => process.kill(body.pid, 0), { code: 'ESRCH' });
  assert.equal(fs.existsSync(body.scratch), false);

  const resumedMarker = path.join(f.scratch, 'resumed-body.json');
  const resumed = await f.launch({ FIXTURE_LEASE_ENFORCE: '1', FIXTURE_MARKER: resumedMarker }).done;
  assert.equal(resumed.code, 0, resumed.output);
  assert.equal(fs.existsSync(resumedMarker), true, 'admission did not resume after cleanup finished');
});

test('manager process-group inspection uses its remaining deadline', () => {
  const vm = require('node:vm');
  const deadline = Date.now() + 5000;
  const inspections = [];
  const moduleFixture = { exports: {} };
  vm.runInNewContext(fs.readFileSync(GATE, 'utf8'), {
    Buffer,
    __dirname: path.join(PROJECT, 'scripts'),
    process,
    module: moduleFixture,
    exports: moduleFixture.exports,
    require: name => {
      if (name === 'node:child_process') return { fork: () => {}, spawnSync: (command, args, options) => {
        inspections.push({ command, args, options });
        return { status: 0, stdout: '', pid: 23457 };
      } };
      return require(name);
    }
  }, { timeout: 1000 });
  moduleFixture.exports.groupPeers(-1, deadline);
  assert.equal(inspections.length, 1);
  assert.ok(inspections[0].options.timeout > 0 && inspections[0].options.timeout <= 5000);
});

test('watchdog process-group inspection uses its remaining deadline', () => {
  const { EventEmitter } = require('node:events');
  const vm = require('node:vm');
  const deadline = Date.now() + 5000;
  const watchdogProcess = new EventEmitter();
  const inspections = [];
  const exits = [];
  Object.assign(watchdogProcess, {
    argv: ['node', 'watchdog', String(deadline), '12345', 'entry'],
    pid: 23456,
    connected: true,
    send: () => {},
    kill: () => {},
    exit: code => exits.push(code)
  });
  vm.runInNewContext(fs.readFileSync(path.join(PROJECT, 'scripts/full-gate-watchdog.js'), 'utf8'), {
    process: watchdogProcess,
    setTimeout: () => 1,
    require: name => {
      if (name === 'node:child_process') return { spawn: () => {}, spawnSync: (command, args, options) => {
        inspections.push({ command, args, options });
        return { status: 0, stdout: '', pid: 23457 };
      } };
      if (name === 'node:os') return { constants: { signals: {} } };
      if (name === 'node:path') return path;
      if (name === './full-gate') return { MESSAGES, NO_VERDICT, canFinish: () => true, releaseScratch: () => true, NO_VERDICT_SECRET: 'secret', SCRATCH_ROOT: 'scratch' };
      throw new Error('unexpected watchdog import ' + name);
    }
  }, { timeout: 1000 });
  watchdogProcess.emit('message', { kind: MESSAGES.DRAIN });
  assert.equal(inspections.length, 1);
  assert.ok(inspections[0].options.timeout > 0 && inspections[0].options.timeout <= 5000);
  assert.deepEqual(exits, [0]);
});

test('leftover owned child produces exactly one no-verdict line', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const result = await f.launch({ FIXTURE_LEFTOVER: '1' }).done;
  assert.equal(result.code, 98, result.output);
  assert.equal((result.output.match(/APERTURE-GATE-INDETERMINATE/g) || []).length, 1);
  const body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
  assert.equal(fs.existsSync(body.scratch), false);
});

test('missing admission executable is a setup hold, not a capacity retry', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const result = await f.launch({ APERTURE_GATE_ADMISSION_COMMAND: path.join(f.root, 'absent') }).done;
  assert.equal(result.code, 98, result.output);
  assert.match(result.output, /reason=queue-missing/);
  assert.equal(fs.existsSync(f.marker), false);
});


test('manager death during queued admission leaves no live admission or holder', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const run = f.launch({ FIXTURE_HOLD_ADMISSION: '1' });
  await Promise.race([run.ready, run.done.then(value => assert.fail(value.output))]);
  const queued = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
  run.child.kill('SIGKILL');
  const result = await run.done;
  assert.equal(result.signal, 'SIGKILL');
  process.stdout.write('QUEUED_CLEANUP_IDENTITIES=' + JSON.stringify(queued) + '\n');
  const active = pid => {
    const state = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', timeout: 1000 });
    return state.status === 0 && !state.stdout.trim().startsWith('Z');
  };
  const cleanupDeadline = Date.now() + 15000;
  while ([queued.pid, queued.holder, queued.guardian].some(active) && Date.now() < cleanupDeadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(active(queued.pid), false, 'admission subprocess outlived its supervisor');
  assert.equal(active(queued.holder), false);
  assert.equal(active(queued.guardian), false, 'watchdog outlived its cleanup lease');
  assert.equal(fs.existsSync(queued.scratch), false);
});


test('target movement while queued refuses the old premise', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const result = await f.launch({ FIXTURE_MOVE_TARGET_WAIT: '1' }).done;
  assert.equal(result.code, 98, result.output);
  assert.match(result.output, /reason=stale/);
  assert.equal(fs.existsSync(f.marker), false);
});

test('target-only movement during execution preserves captured source proof', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const result = await f.launch({ FIXTURE_MOVE_TARGET_BODY: '1' }).done;
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /FULL_GATE_SOURCE=/);
  assert.equal(result.output.includes('APERTURE-GATE-INDETERMINATE'), false);
});

test('source movement during execution still invalidates proof', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const result = await f.launch({ FIXTURE_CHANGE_BODY: '1' }).done;
  assert.equal(result.code, 98, result.output);
  assert.match(result.output, /reason=stale/);
});


test('archive tickets use the archive root and its source digest', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const firstRoot = path.join(f.root, 'dist', 'A-new');
  const secondRoot = path.join(f.root, 'dist', 'B-new');
  fs.mkdirSync(firstRoot, { recursive: true });
  fs.mkdirSync(secondRoot, { recursive: true });
  fs.writeFileSync(path.join(firstRoot, 'input'), 'same source\n');
  fs.writeFileSync(path.join(secondRoot, 'input'), 'same source\n');
  const ticket = async root => {
    const result = await f.launch({ FIXTURE_ROOT: root }).done;
    assert.equal(result.code, 0, result.output);
    const args = JSON.parse(fs.readFileSync(f.protocol, 'utf8'));
    return args[args.indexOf('--ticket') + 1];
  };
  const first = await ticket(firstRoot);
  const second = await ticket(secondRoot);
  assert.notEqual(second, first);
  assert.equal(await ticket(firstRoot), first);
});

test('branch switch at the same commit makes the admitted source stale', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const result = await f.launch({ FIXTURE_SWITCH_BRANCH: 'same-commit-other-branch' }).done;
  assert.equal(result.code, 98, result.output);
  assert.match(result.output, /APERTURE-GATE-INDETERMINATE reason=stale/);
  assert.equal(fs.existsSync(f.marker), false);
});

test('admission wait is recomputed after a slow source scan', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const scratch = path.dirname(f.root);
  const bin = path.join(scratch, 'slow-git-bin');
  const realPath = f.env.PATH || process.env.PATH || '';
  const realGit = realPath.split(path.delimiter).map(directory => path.join(directory, 'git')).find(file => fs.existsSync(file));
  assert.ok(realGit, 'git must be available to the test fixture');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *"rev-parse --show-toplevel"*)',
    '    if [ ! -e "$FIXTURE_GIT_DELAYED" ]; then',
    '      : > "$FIXTURE_GIT_DELAYED"',
    '      sleep 2.5',
    '    fi',
    '    ;;',
    'esac',
    'exec ' + JSON.stringify(realGit) + ' "$@"'
  ].join('\n'), { mode: 0o700 });
  const result = await f.launch({
    APERTURE_GATE_TIME_LEFT_S: '20',
    APERTURE_GATE_SLOWEST_RUN_S: '5',
    FIXTURE_GIT_DELAYED: path.join(scratch, 'slow-git-delayed'),
    PATH: bin + path.delimiter + realPath
  }).done;
  assert.equal(result.code, 0, result.output);
  const args = JSON.parse(fs.readFileSync(f.protocol, 'utf8'));
  const maxWait = Number(args[args.indexOf('--max-wait') + 1]);
  assert.ok(maxWait >= 1 && maxWait < 10, 'expected a recomputed wait, got ' + maxWait);
});

for (const file of ['scripts/test-gate.js', 'scripts/package-smoke.js']) {
  for (const option of [
    {
      flag: '--require',
      extension: 'cjs',
      source: "require('node:fs').appendFileSync(process.env.FIXTURE_PRELOAD_MARKER, process.pid + '\\n');"
    },
    {
      flag: '--import',
      extension: 'mjs',
      source: "import { appendFileSync } from 'node:fs'; appendFileSync(process.env.FIXTURE_PRELOAD_MARKER, process.pid + '\\n');"
    },
    {
      flag: '--experimental-loader',
      extension: 'mjs',
      source: "import { appendFileSync } from 'node:fs'; appendFileSync(process.env.FIXTURE_PRELOAD_MARKER, process.pid + '\\n'); export async function resolve(specifier, context, nextResolve) { return nextResolve(specifier, context); } export async function load(url, context, nextLoad) { return nextLoad(url, context); }"
    },
    {
      flag: '--loader',
      extension: 'mjs',
      source: "import { appendFileSync } from 'node:fs'; appendFileSync(process.env.FIXTURE_PRELOAD_MARKER, process.pid + '\\n'); export async function resolve(specifier, context, nextResolve) { return nextResolve(specifier, context); } export async function load(url, context, nextLoad) { return nextLoad(url, context); }"
    }
  ]) {
    test(option.flag + ' NODE_OPTIONS preload is rejected before admission for ' + file, { timeout: 180000 }, async t => {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-preload-fixture-'));
      t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
      const preload = path.join(scratch, 'preload.' + option.extension);
      const marker = path.join(scratch, 'preload-runs');
      fs.writeFileSync(preload, option.source);
      const run = publicEntry(t, file, 'reply', {
        NODE_OPTIONS: option.flag + '="' + preload + '"',
        FIXTURE_PRELOAD_MARKER: marker
      });
      const result = await run.done;
      assert.equal(result.code, 98, result.output);
      assert.match(result.output, /reason=setup/);
      assert.equal(run.requests(), 0);
      assert.equal(fs.existsSync(run.admissionMarker), false);
      assert.equal(fs.existsSync(run.bodyMarker), false);
      assert.equal(fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/).length, 1);
    });
  }
}

test('worker loss during admission is interruption, never capacity', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const result = await f.launch({ FIXTURE_HOLD_ADMISSION: '1', FIXTURE_KILL_HOLDER: '1' }).done;
  assert.equal(result.code, 98, result.output);
  assert.equal((result.output.match(/APERTURE-GATE-INDETERMINATE/g) || []).length, 1);
  assert.match(result.output, /reason=interrupted/);
  assert.equal(result.output.includes('reason=capacity'), false);
});


test('gate deadline bounds inherited output without signalling the escaped fixture', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const run = f.launch({ FIXTURE_ESCAPE_PIPE: '1', APERTURE_GATE_TIME_LEFT_S: '20', APERTURE_GATE_SLOWEST_RUN_S: '5' });
  let escaped;
  try {
    const result = await run.done;
    escaped = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
    assert.equal(result.code, 98, result.output);
    assert.equal((result.output.match(/APERTURE-GATE-INDETERMINATE/g) || []).length, 1);
    assert.match(result.output, /reason=timeout/);
    const state = spawnSync('ps', ['-p', String(escaped.escapePid), '-o', 'lstart='], { encoding: 'utf8', timeout: 10000 });
    assert.equal(state.stdout.trim(), escaped.escapeStart, 'the fixture outlives the gate deadline');
    assert.equal(fs.existsSync(f.marker + '.escape-signalled'), false, 'the gate must not signal another group');
    assert.equal(fs.existsSync(escaped.scratch), false);
  } finally {
    if (!escaped && fs.existsSync(f.marker)) escaped = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
    if (escaped?.escapePid) {
      const state = spawnSync('ps', ['-p', String(escaped.escapePid), '-o', 'lstart='], { encoding: 'utf8', timeout: 10000 });
      if (state.stdout.trim() === escaped.escapeStart) {
        process.kill(escaped.escapePid, 'SIGTERM');
        const cleanupDeadline = Date.now() + 10000;
        let currentStart;
        do {
          await new Promise(resolve => setTimeout(resolve, 100));
          currentStart = spawnSync('ps', ['-p', String(escaped.escapePid), '-o', 'lstart='], { encoding: 'utf8', timeout: 10000 }).stdout.trim();
        } while (currentStart === escaped.escapeStart && Date.now() < cleanupDeadline);
        assert.notEqual(currentStart, escaped.escapeStart, 'the test cleans up its escaped fixture');
      }
    }
  }
});

test('manager kill during output drain leaves no owned scratch', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const run = f.launch({ FIXTURE_ESCAPE_PIPE: '1', APERTURE_GATE_TIME_LEFT_S: '20', APERTURE_GATE_SLOWEST_RUN_S: '5' });
  let escaped;
  try {
    const workerDeadline = Date.now() + 60000;
    let workerAlive = true;
    while (workerAlive && Date.now() < workerDeadline) {
      if (fs.existsSync(f.marker)) {
        escaped = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
        if (escaped.escapePid) {
          try { process.kill(escaped.holder, 0); } catch (error) { if (error.code === 'ESRCH') workerAlive = false; else throw error; }
        }
      }
      if (workerAlive) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(workerAlive, false, 'wait for the actual worker exit');
    await new Promise(resolve => setTimeout(resolve, 300));
    const scratchAbsent = !fs.existsSync(escaped.scratch);
    run.child.kill('SIGKILL');
    assert.equal(scratchAbsent, true, 'scratch is released before output drain');
    const state = spawnSync('ps', ['-p', String(escaped.escapePid), '-o', 'lstart='], { encoding: 'utf8', timeout: 10000 });
    assert.equal(state.stdout.trim(), escaped.escapeStart, 'the fixture outlives the gate deadline');
    assert.equal(fs.existsSync(f.marker + '.escape-signalled'), false, 'the gate must not signal another group');

  } finally {
    if (!escaped && fs.existsSync(f.marker)) escaped = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
    if (escaped?.escapePid) {
      const state = spawnSync('ps', ['-p', String(escaped.escapePid), '-o', 'lstart='], { encoding: 'utf8', timeout: 10000 });
      if (state.stdout.trim() === escaped.escapeStart) {
        process.kill(escaped.escapePid, 'SIGTERM');
        const cleanupDeadline = Date.now() + 10000;
        let currentStart;
        do {
          await new Promise(resolve => setTimeout(resolve, 100));
          currentStart = spawnSync('ps', ['-p', String(escaped.escapePid), '-o', 'lstart='], { encoding: 'utf8', timeout: 10000 }).stdout.trim();
        } while (currentStart === escaped.escapeStart && Date.now() < cleanupDeadline);
        assert.notEqual(currentStart, escaped.escapeStart, 'the test cleans up its escaped fixture');
      }
    }
  }
});

for (const escape of [false, true]) {
  for (const mode of ['group-signal', 'read-only-scratch']) {
    test(mode + ' preserves one no-verdict with escaped output ' + escape, { timeout: 180000 }, async t => {
      const f = fixture(t);
      const extra = { APERTURE_GATE_TIME_LEFT_S: '20', APERTURE_GATE_SLOWEST_RUN_S: '5' };
      if (escape) extra.FIXTURE_ESCAPE_PIPE = '1';
      if (mode === 'group-signal') extra.FIXTURE_GROUP_SIGNAL = '1';
      else extra.FIXTURE_READ_ONLY_SCRATCH = '1';
      let body;
      try {
        const result = await f.launch(extra).done;
        body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
        assert.equal(result.code, 98, result.output);
        assert.equal((result.output.match(/APERTURE-GATE-INDETERMINATE/g) || []).length, 1, result.output);
        if (mode === 'read-only-scratch') assert.match(result.output, /GATE_SCRATCH_CLEANUP_FAILED/);
        if (escape) {
          const state = spawnSync('ps', ['-p', String(body.escapePid), '-o', 'lstart='], { encoding: 'utf8', timeout: 10000 });
          assert.equal(state.stdout.trim(), body.escapeStart, 'gate teardown leaves the other process group alone');
        }
      } finally {
        if (!body && fs.existsSync(f.marker)) body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
        if (body?.escapePid) {
          const state = spawnSync('ps', ['-p', String(body.escapePid), '-o', 'lstart='], { encoding: 'utf8', timeout: 10000 });
          if (state.stdout.trim() === body.escapeStart) {
            process.kill(body.escapePid, 'SIGTERM');
            const bound = Date.now() + 10000;
            let current;
            do {
              await new Promise(resolve => setTimeout(resolve, 100));
              current = spawnSync('ps', ['-p', String(body.escapePid), '-o', 'lstart='], { encoding: 'utf8', timeout: 10000 }).stdout.trim();
            } while (current === body.escapeStart && Date.now() < bound);
            assert.notEqual(current, body.escapeStart, 'test cleans its escaped fixture');
          }
        }
        if (body?.scratch && fs.existsSync(body.scratch)) {
          const ro = path.join(body.scratch, 'ro');
          if (fs.existsSync(ro)) fs.chmodSync(ro, 0o700);
          fs.rmSync(body.scratch, { recursive: true, force: true });
        }
      }
    });
  }
}

for (const connected of [true, false]) {
  test('stopping worker cannot report success when its guard exits, manager connected ' + connected, () => {
    const { EventEmitter } = require('node:events');
    const vm = require('node:vm');
    const gate = require('../scripts/full-gate');
    const guard = new EventEmitter();
    guard.connected = false;
    const processFixture = new EventEmitter();
    const exits = [];
    const signals = [];
    const timers = [];
    let declarations = 0;
    let releases = 0;
    Object.assign(processFixture, {
      pid: 12345, connected, argv: ['node', 'worker', 'deadline', 'entry'],
      env: { [gate.SCRATCH_ROOT]: 'owned-fixture' },
      exit: code => exits.push(code),
      kill: (pid, signal) => signals.push([pid, signal])
    });
    const source = fs.readFileSync(path.join(PROJECT, 'scripts/full-gate-worker.js'), 'utf8');
    vm.runInNewContext(source, {
      process: processFixture, __dirname: path.join(PROJECT, 'scripts'),
      setTimeout: callback => { timers.push(callback); },
      require: name => {
        if (name === 'node:path') return path;
        if (name === 'node:child_process') return { fork: () => guard };
        if (name === './full-gate') return { ...gate, noVerdict: () => { declarations++; return gate.NO_VERDICT; }, releaseScratch: () => { releases++; return false; } };
        throw new Error('unexpected fixture import ' + name);
      }
    }, { timeout: 1000 });
    processFixture.emit('SIGTERM');
    guard.emit('exit', 0);
    assert.deepEqual(exits, [], 'a stopping worker cannot finish0');
    assert.equal(declarations, 1);
    assert.equal(timers.length, 1);
    timers[0]();
    assert.deepEqual(exits, [98]);
    assert.deepEqual(signals, [[-12345, 'SIGTERM'], [-12345, 'SIGKILL']]);
    assert.equal(releases, connected ? 0 : 1, 'cleanup failure must not skip group termination');
  });
}
