'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const { PassThrough } = require('node:stream');
const { relay, revision, noVerdict, MESSAGES, NO_VERDICT, SUPERVISOR, SCRATCH_ROOT } = require('../scripts/full-gate');
const { parseRetainArtifactArgs, retainArtifact, runBody, runPackageSmokeEntry, validateRetainArtifactDestination } = require('../scripts/package-smoke');
const { pythonTestEnvironment } = require('../scripts/test-gate');
const roleFixture = require('./successor-authority/process-identity');

const PROJECT = path.resolve(__dirname, '..');
const GATE = path.join(PROJECT, 'scripts/full-gate.js');
const SUPERVISOR_SCRIPT = path.join(PROJECT, 'scripts/full-gate/supervisor.py');
const ROLE_FIXTURE = path.join(PROJECT, 'test/successor-authority/process-identity.js');

function createSupervisorReceipt(directory) {
  const token = crypto.randomBytes(32).toString('hex');
  const receipt = path.join(directory, 'supervisor.receipt');
  fs.writeFileSync(receipt, token + '\n', { flag: 'wx', mode: 0o600 });
  return { receipt, token };
}

function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-entry-fixture-'));
  const root = path.join(scratch, 'repo');
  fs.mkdirSync(root);
  const supervisor = createSupervisorReceipt(scratch);
  const env = { ...process.env };
  env.NODE_OPTIONS = '';
  env[SUPERVISOR.ENVIRONMENT] = SUPERVISOR.LINUX_SUBREAPER;
  env[SUPERVISOR.RECEIPT] = supervisor.receipt;
  env[SUPERVISOR.TOKEN] = supervisor.token;
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
  const roleFile = path.join(scratch, 'starter-roles.json');
  const admit = path.join(scratch, 'admit');
  fs.writeFileSync(admit, '#!' + process.execPath + '\n' + [
    "const fs = require('node:fs');",
    "const cp = require('node:child_process');",
    "const roles = require(" + JSON.stringify(ROLE_FIXTURE) + ");",
    "setTimeout(() => process.exit(3), 120000).unref();",
    "fs.writeFileSync(process.env.FIXTURE_PROTOCOL, JSON.stringify(process.argv.slice(2)));",
    "const admittedRoles=roles.rolesFromAdmission(process.argv.slice(2));if(!admittedRoles)process.exit(4);fs.writeFileSync(process.env.FIXTURE_PROTOCOL+'.roles',JSON.stringify(admittedRoles));",
    "if (process.env.FIXTURE_KILL_WORKER||process.env.FIXTURE_KILL_GUARD) { const deadline=Date.now()+5000;while(!fs.existsSync(process.env.FIXTURE_ROLE_FILE)&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);if(!fs.existsSync(process.env.FIXTURE_ROLE_FILE))process.exit(4);const starter=JSON.parse(fs.readFileSync(process.env.FIXTURE_ROLE_FILE,'utf8'));const gateRoles=roles.rolesFromAdmission(process.argv.slice(2));const admission=roles.captureIdentity(process.pid);if(!gateRoles||admission.kind!=='present')process.exit(4);fs.writeFileSync(process.env.FIXTURE_ROLE_FILE,JSON.stringify({...starter,...gateRoles,admission})); }",
    "if (process.env.FIXTURE_LEASE_ENFORCE) {",
    "  const args=process.argv.slice(2);const holders=[];for(let i=0;i<args.length-1;i++)if(args[i]==='--holder'&&holders.length<2)holders.push(Number(args[++i]));",
    "  if(fs.existsSync(process.env.FIXTURE_LEASE_FILE)){const lease=JSON.parse(fs.readFileSync(process.env.FIXTURE_LEASE_FILE,'utf8'));if(lease.holders.some(holder=>!roles.identityGone(holder,roles.captureIdentity(holder.pid))))process.exit(3);}",
    "  const owned=holders.map(pid=>roles.captureIdentity(pid));if(owned.some(holder=>holder.kind!=='present'))process.exit(4);fs.writeFileSync(process.env.FIXTURE_LEASE_FILE,JSON.stringify({holders:owned}));",
    "}",
    "if (process.env.FIXTURE_CHANGE) fs.writeFileSync(process.env.FIXTURE_CHANGE, 'changed');",
    "if (process.env.FIXTURE_MOVE_TARGET_WAIT) require('node:child_process').spawnSync('git',['-C',process.env.FIXTURE_ROOT,'update-ref','-d','refs/remotes/origin/main']);",
    "if (process.env.FIXTURE_SWITCH_BRANCH) require('node:child_process').spawnSync('git',['-C',process.env.FIXTURE_ROOT,'switch','-c',process.env.FIXTURE_SWITCH_BRANCH]);",
    "if (process.env.FIXTURE_ADMISSION_SIGNAL) process.kill(process.pid, process.env.FIXTURE_ADMISSION_SIGNAL);",
    "if (process.env.FIXTURE_HOLD_ADMISSION) {",
    "  const args=process.argv.slice(2);const gateRoles=roles.rolesFromAdmission(args);const admission=roles.captureIdentity(process.pid);if(!gateRoles||admission.kind!=='present')process.exit(4);const holder=gateRoles.worker;const guardian=gateRoles.guardian;",
    "  fs.writeFileSync(process.env.FIXTURE_MARKER,JSON.stringify({pid:process.pid,admission,holder:holder.pid,holderIdentity:holder,guardian:guardian.pid,guardianIdentity:guardian,scratch:process.env.DISCORD_SURFACE_GATE_SCRATCH}));",
    "  process.on('SIGTERM',()=>{if(!process.env.FIXTURE_KILL_HOLDER)process.exit(3);}); process.stdout.write('ADMISSION_READY\\n');",
    "  setInterval(() => { if (fs.existsSync(" + JSON.stringify(emergencyRelease) + ")) process.exit(3); }, 25);",
    "  if(process.env.FIXTURE_KILL_HOLDER&&!roles.signalOwned(holder,'SIGKILL'))process.exit(4);",
    "  setTimeout(()=>process.exit(3),15000);",
    "} else process.exit(Number(process.env.FIXTURE_ADMISSION_EXIT || 0));"
  ].join('\n'), { mode: 0o700 });
  const reparentedChildProgram = [
    "const fs=require('node:fs');",
    "const roles=require(" + JSON.stringify(ROLE_FIXTURE) + ");",
    "if(Number(process.env.FIXTURE_GENERATION)!==2)process.exit(2);",
    "const deadline=setTimeout(()=>process.exit(7),8000);",
    "const identity=roles.captureIdentity(process.pid);if(identity.kind!=='present')process.exit(4);fs.writeFileSync(process.env.FIXTURE_REPARENTED_CHILD,JSON.stringify({pid:process.pid,identity}));",
    "setTimeout(()=>{fs.writeFileSync(require('node:path').join(process.env.FIXTURE_ROOT,'input'),'changed after verdict');fs.writeFileSync(process.env.FIXTURE_REPARENTED_DONE,'late write');clearTimeout(deadline);process.exit(0);},3000);"
  ].join('\n');
  const reparentedHelperProgram = [
    "const cp=require('node:child_process');const fs=require('node:fs');",
    "if(Number(process.env.FIXTURE_GENERATION)!==1)process.exit(2);",
    "const deadline=setTimeout(()=>process.exit(8),5000);",
    "const code=" + JSON.stringify(reparentedChildProgram) + ";",
    "const child=cp.spawn(process.execPath,['-e',code],{env:{...process.env,FIXTURE_GENERATION:'2'},detached:true,stdio:'ignore'});child.unref();",
    "const poll=setInterval(()=>{if(fs.existsSync(process.env.FIXTURE_REPARENTED_CHILD)){clearInterval(poll);clearTimeout(deadline);process.exit(0);}},5);"
  ].join('\n');
  const entry = path.join(scratch, 'entry.js');
  fs.writeFileSync(entry, [
    "const fs = require('node:fs');",
    "const roles = require(" + JSON.stringify(ROLE_FIXTURE) + ");",
    "const { runFullGate } = require(" + JSON.stringify(GATE) + ");",
    "if(process.env.FIXTURE_SIGNAL_RECEIVED)process.on('SIGTERM',()=>fs.writeFileSync(process.env.FIXTURE_SIGNAL_RECEIVED,String(process.pid)));",
    "async function runBody() {",
    "  const watchdogEnvironment = process.platform === 'linux' ? fs.readFileSync('/proc/' + process.ppid + '/environ') : Buffer.alloc(0);",
    "  const bodyIdentity=roles.captureIdentity(process.pid);if(bodyIdentity.kind!=='present')throw new Error('body identity could not be established');fs.writeFileSync(process.env.FIXTURE_MARKER, JSON.stringify({ pid: process.pid, identity: bodyIdentity, scratch: process.env.DISCORD_SURFACE_GATE_SCRATCH, gitDir: process.env.GIT_DIR, gitWorkTree: process.env.GIT_WORK_TREE, locale: process.env.LC_ALL, optionalLocks: process.env.GIT_OPTIONAL_LOCKS, secretPresent: Object.prototype.hasOwnProperty.call(process.env, 'DISCORD_SURFACE_GATE_NO_VERDICT_SECRET'), parentSecretPresent: watchdogEnvironment.includes(Buffer.from('DISCORD_SURFACE_GATE_NO_VERDICT_SECRET=')) }));",
    "  if (process.env.FIXTURE_KILL_GUARD) { const actors=JSON.parse(fs.readFileSync(process.env.FIXTURE_ROLE_FILE,'utf8'));const body=roles.captureIdentity(process.pid);if(body.kind!=='present')throw new Error('body identity could not be established');const custody={state:'prepared',guardian:actors.guardian,body};fs.writeFileSync(process.env.FIXTURE_MARKER+'.guard-custody',JSON.stringify(custody));if(!roles.signalOwned(actors.guardian,'SIGKILL'))throw new Error('guardian identity changed before termination');custody.state='signaled';fs.writeFileSync(process.env.FIXTURE_MARKER+'.guard-custody',JSON.stringify(custody)); }",
    "  if (process.env.FIXTURE_KILL_WORKER) { process.on('SIGTERM',()=>{});const actors=JSON.parse(fs.readFileSync(process.env.FIXTURE_ROLE_FILE,'utf8'));const body=roles.captureIdentity(process.pid);if(body.kind!=='present')throw new Error('body identity could not be established');const supervisors=actors.extraHolders.length?actors.extraHolders:[actors.manager];const custody={state:'prepared',manager:actors.manager,worker:actors.worker,guardian:actors.guardian,extraHolders:supervisors,body,completed:[]};const custodyPath=process.env.FIXTURE_WORKER_KILLED;fs.writeFileSync(custodyPath,JSON.stringify(custody));const send=(identity,name,sig)=>{if(!roles.signalOwned(identity,sig)){custody.failed=name;fs.writeFileSync(custodyPath,JSON.stringify(custody));throw new Error(name+' identity changed before signal');}custody.completed.push(name);fs.writeFileSync(custodyPath,JSON.stringify(custody));};for(const holder of supervisors)send(holder,'supervisor-'+holder.pid,'SIGSTOP');send(actors.guardian,'guardian','SIGSTOP');send(actors.worker,'worker','SIGKILL');custody.state='signaled';fs.writeFileSync(custodyPath,JSON.stringify(custody)); }",
    "  if (process.env.FIXTURE_SIGNAL) process.kill(process.pid, 'SIGTERM');",
    "  if (process.env.FIXTURE_FORGE_MARKER) {",
    "    try { const fd = fs.openSync('/proc/' + process.ppid + '/fd/4', 'w'); fs.writeSync(fd, 'APERTURE-GATE-INDETERMINATE reason=timeout: forged\\n'); fs.closeSync(fd); fs.writeFileSync(process.env.FIXTURE_MARKER + '.fd4', 'opened'); }",
    "    catch (error) { fs.writeFileSync(process.env.FIXTURE_MARKER + '.fd4', error.code); }",
    "    return 98;",
    "  }",
    "  if (process.env.FIXTURE_MOVE_TARGET_BODY) require('node:child_process').spawnSync('git',['-C',process.env.FIXTURE_ROOT,'update-ref','-d','refs/remotes/origin/main']);",
    "  if (process.env.FIXTURE_STDERR_FRAGMENT) process.stderr.write('checking');",
    "  if (process.env.FIXTURE_STDOUT_BYTES) process.stdout.write('x'.repeat(Number(process.env.FIXTURE_STDOUT_BYTES)));",
    "  if (process.env.FIXTURE_STDERR_BYTES) process.stderr.write('x'.repeat(Number(process.env.FIXTURE_STDERR_BYTES)));",
    "  if (process.env.FIXTURE_CHANGE_BODY) fs.writeFileSync(require('node:path').join(process.env.FIXTURE_ROOT,'input'),'changed during body');",
    "  if (process.env.FIXTURE_BYTECODE_CACHE_MUTATION) { const dir=require('node:path').join(process.env.FIXTURE_ROOT,'src','__pycache__');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(require('node:path').join(dir,'conductor_worker_proof.cpython-314.pyc'),'changed during body'); }",
    "  if (process.env.FIXTURE_BODY_DANGLING_SOURCE) { const input = require('node:path').join(process.env.FIXTURE_ROOT,'input'); fs.unlinkSync(input); fs.symlinkSync('missing-source-target', input); }",
    "  if (process.env.FIXTURE_LATE_WRITE) {",
    "    const cp=require('node:child_process');",
    "    const program=\"const fs=require('node:fs');const deadline=Date.now()+10000;fs.writeFileSync(process.env.FIXTURE_LATE_ARMED,'armed');const poll=setInterval(()=>{if(fs.existsSync(process.env.FIXTURE_LATE_TRIGGER)){clearInterval(poll);fs.writeFileSync(require('node:path').join(process.env.FIXTURE_ROOT,'input'),'changed by late descendant');fs.writeFileSync(process.env.FIXTURE_LATE_DONE,'done');process.exit(0);}if(Date.now()>=deadline)process.exit(1);},5);\";",
    "    cp.spawn(process.execPath,['-e',program],{detached:true,stdio:'ignore'}).unref();",
    "    const deadline=Date.now()+5000;while(!fs.existsSync(process.env.FIXTURE_LATE_ARMED)&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);if(!fs.existsSync(process.env.FIXTURE_LATE_ARMED))throw new Error('late descendant did not start');",
    "  }",
    "  if (process.env.FIXTURE_DETACHED_LATE_WRITE) {",
    "    const cp=require('node:child_process');",
    "    const program=\"const fs=require('node:fs');const path=require('node:path');fs.writeFileSync(process.env.FIXTURE_DETACHED_ARMED,'armed');setTimeout(()=>{fs.writeFileSync(path.join(process.env.FIXTURE_ROOT,'input'),'changed after gate');fs.writeFileSync(process.env.FIXTURE_DETACHED_DONE,'done');},1000);setTimeout(()=>process.exit(0),5000);\";",
    "    const child=cp.spawn(process.execPath,['-e',program],{detached:true,stdio:'ignore'});child.unref();",
    "    const until=Date.now()+5000;while(!fs.existsSync(process.env.FIXTURE_DETACHED_ARMED)&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);if(!fs.existsSync(process.env.FIXTURE_DETACHED_ARMED))throw new Error('detached descendant did not start');",
    "    const identity=roles.captureIdentity(child.pid);if(identity.kind!=='present')throw new Error('detached child identity could not be established');fs.writeFileSync(process.env.FIXTURE_DETACHED_PID,JSON.stringify({pid:child.pid,identity}));",
    "  }",
    "  if (process.env.FIXTURE_REPARENTED_DESCENDANT) {",
    "    fs.writeFileSync(process.env.FIXTURE_REPARENTED_BODY_READY, 'body-ready');",
    "    const releaseDeadline=Date.now()+10000;while(!fs.existsSync(process.env.FIXTURE_REPARENTED_RELEASE)&&Date.now()<releaseDeadline)await new Promise(resolve=>setTimeout(resolve,10));",
    "    if(!fs.existsSync(process.env.FIXTURE_REPARENTED_RELEASE))throw new Error('reparented fixture release timed out');",
    "    const cp=require('node:child_process');const helper=cp.spawn(process.execPath,['-e'," + JSON.stringify(reparentedHelperProgram) + "],{env:{...process.env,FIXTURE_GENERATION:'1'},stdio:'ignore'});",
    "    const code=await new Promise(resolve=>helper.once('exit',(status,signal)=>resolve(signal?128:status)));if(code!==0)throw new Error('bounded helper exited ' + code);",
    "    fs.writeFileSync(process.env.FIXTURE_REPARENTED_ORPHANED, 'helper-exited');",
    "  }",
    "  if (process.env.FIXTURE_ESCAPE_PIPE) {",
    "    const cp=require('node:child_process');const marker=process.env.FIXTURE_MARKER+'.escape-signalled';",
    "    const program=\"const fs=require('node:fs');const path=require('node:path');process.on('SIGTERM',()=>{fs.writeFileSync(process.env.FIXTURE_MARKER+'.escape-signalled','terminated');if(process.env.FIXTURE_RECREATE_SCRATCH){const scratch=process.env.DISCORD_SURFACE_GATE_SCRATCH;setInterval(()=>{fs.mkdirSync(scratch,{recursive:true});fs.writeFileSync(path.join(scratch,'writer'),'active');},5);}else process.exit(0);});setTimeout(()=>process.exit(0),90000);\";",
    "    const escape=cp.spawn(process.execPath,['-e',program],{detached:true,stdio:'inherit'});escape.unref();",
    "    const info=JSON.parse(fs.readFileSync(process.env.FIXTURE_MARKER,'utf8'));const escapeIdentity=roles.captureIdentity(escape.pid);if(escapeIdentity.kind!=='present')throw new Error('escaped child identity could not be established');info.escapePid=escape.pid;info.escapeIdentity=escapeIdentity;fs.writeFileSync(process.env.FIXTURE_MARKER+'.part',JSON.stringify(info));fs.renameSync(process.env.FIXTURE_MARKER+'.part',process.env.FIXTURE_MARKER);",
    "  }",
    "  if (process.env.FIXTURE_READ_ONLY_SCRATCH) { const ro=require('node:path').join(process.env.DISCORD_SURFACE_GATE_SCRATCH,'ro');fs.mkdirSync(ro);fs.writeFileSync(require('node:path').join(ro,'f'),'x');fs.chmodSync(ro,0o500); }",
    "  if (process.env.FIXTURE_LEFTOVER) require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),15000)'], { stdio: 'ignore' }).unref();",
    "  if (process.env.FIXTURE_HANG) { process.on('SIGTERM', () => { if (process.env.FIXTURE_RECREATE_SCRATCH) { const scratch=process.env.DISCORD_SURFACE_GATE_SCRATCH;setInterval(()=>{fs.mkdirSync(scratch,{recursive:true});fs.writeFileSync(require('node:path').join(scratch,'writer'),'active');},5); } }); setInterval(() => {}, 1000); process.stdout.write('BODY_READY\\n'); return new Promise(() => {}); }",
    "  return Number(process.env.FIXTURE_BODY_EXIT || 0);",
    "}",
    "setTimeout(() => process.exit(98), 120000).unref();",
    "module.exports = { runBody };",
    "if (require.main === module) {",
    "  runFullGate(process.env.FIXTURE_ROOT, 'fixture', __filename, []).then(code => { process.exitCode = code; });",
    "}"
  ].join('\n'));
  const processes = [];
  t.after(async () => {
    const unresolved = [];
    const identities = new Map();
    const remember = value => {
      if (Array.isArray(value)) {
        for (const item of value) remember(item);
      } else if (value && typeof value === 'object') {
        if (value.kind === 'present' && Number.isSafeInteger(value.pid)) {
          const start = value.platform === 'darwin'
            ? value.start_sec + ':' + value.start_usec + ':' + value.unique_id
            : value.boot_id + ':' + value.start;
          identities.set(value.pid + ':' + start, value);
        } else {
          for (const item of Object.values(value)) remember(item);
        }
      }
    };
    const resume = identity => {
      const current = roleFixture.captureIdentity(identity.pid);
      if (roleFixture.identityGone(identity, current)) return true;
      if (!roleFixture.sameProcessIdentity(identity, current)) return false;
      return roleFixture.signalOwned(identity, 'SIGCONT');
    };
    try { fs.writeFileSync(emergencyRelease, 'release'); }
    catch { unresolved.push('admission-release'); }
    for (const custodyPath of [
      roleFile, protocol + '.roles', path.join(scratch, 'worker-killed'),
      marker, marker + '.guard-custody'
    ]) {
      if (!fs.existsSync(custodyPath)) continue;
      try { remember(JSON.parse(fs.readFileSync(custodyPath, 'utf8'))); }
      catch { unresolved.push('unreadable-custody:' + path.basename(custodyPath)); }
    }
    try {
      const stopped = JSON.parse(fs.readFileSync(path.join(scratch, 'worker-killed'), 'utf8'));
      for (const holder of stopped.extraHolders?.length ? stopped.extraHolders : [stopped.manager]) {
        if (!resume(holder)) unresolved.push('resume:' + holder.pid);
      }
      if (!resume(stopped.guardian)) unresolved.push('resume:' + stopped.guardian.pid);
    } catch (error) {
      if (fs.existsSync(path.join(scratch, 'worker-killed'))) unresolved.push('worker-custody-read');
    }
    for (const owned of processes) {
      const { child, identity } = owned;
      if (child.exitCode !== null || child.signalCode !== null) continue;
      if (identity?.kind !== 'present') {
        unresolved.push('unknown-child:' + child.pid);
        continue;
      }
      const current = roleFixture.captureIdentity(identity.pid);
      if (roleFixture.identityGone(identity, current)) continue;
      if (!roleFixture.sameProcessIdentity(identity, current)
          || !roleFixture.signalOwned(identity, 'SIGTERM')) {
        unresolved.push('child-signal:' + identity.pid);
      }
    }
    const deadline = Date.now() + 8000;
    while (processes.some(({ child }) => child.exitCode === null && child.signalCode === null)
      && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    for (const { child } of processes) {
      if (child.exitCode === null && child.signalCode === null) unresolved.push('child-drain:' + child.pid);
    }
    while (identities.size && Date.now() < deadline) {
      const live = [...identities.values()].filter(identity =>
        !roleFixture.identityGone(identity, roleFixture.captureIdentity(identity.pid)));
      if (!live.length) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (const identity of identities.values()) {
      if (!roleFixture.identityGone(identity, roleFixture.captureIdentity(identity.pid))) {
        unresolved.push('actor-drain:' + identity.pid);
      }
    }
    if (unresolved.length) {
      const custodyPath = path.join(scratch, 'cleanup-obligation.json');
      try {
        fs.writeFileSync(custodyPath, JSON.stringify({
          state: 'unresolved', reasons: unresolved, identities: [...identities.values()]
        }), { mode: 0o600 });
      } catch {}
      throw new Error('fixture cleanup is unresolved; custody retained at ' + scratch);
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  function launch(extra = {}, supervised = false) {
    const launchEnv = {
      ...env, APERTURE_GATE_ADMISSION_COMMAND: admit,
      APERTURE_GATE_TIME_LEFT_S: '120', APERTURE_GATE_SLOWEST_RUN_S: '60',
      FIXTURE_ROOT: root, FIXTURE_MARKER: marker, FIXTURE_PROTOCOL: protocol,
      FIXTURE_LEASE_FILE: leaseFile, FIXTURE_ROLE_FILE: roleFile, ...extra
    };
    if (supervised) {
      delete launchEnv[SUPERVISOR.ENVIRONMENT];
      delete launchEnv[SUPERVISOR.RECEIPT];
      delete launchEnv[SUPERVISOR.TOKEN];
      launchEnv.NODE_OPTIONS = '';
    }
    const options = {
      env: launchEnv,
      stdio: ['ignore', 'pipe', 'pipe', ...(!supervised && extra.FIXTURE_IPC ? ['ipc'] : [])]
    };
    const command = supervised ? 'python3' : process.execPath;
    const args = supervised
      ? ['-I', SUPERVISOR_SCRIPT, '--', process.execPath, entry]
      : [entry];
    const child = !supervised && extra.FIXTURE_IPC ? fork(entry, [], options) : spawn(command, args, options);
    const identity = roleFixture.captureIdentity(child.pid);
    processes.push({ child, identity });
    if (extra.FIXTURE_KILL_WORKER || extra.FIXTURE_KILL_GUARD) {
      const manager = identity;
      assert.equal(manager.kind, 'present', 'starter could not capture the manager identity');
      fs.writeFileSync(roleFile, JSON.stringify({ manager }), { mode: 0o600 });
    }
    let output = '';
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === child.stderr && extra.FIXTURE_NO_STDERR_DRAIN) continue;
      stream.on('data', chunk => {
        output += chunk.toString();
        if (output.includes('BODY_READY\n') || output.includes('ADMISSION_READY\n')) resolveReady();
      });
    }
    const done = new Promise(resolve => {
      if (extra.FIXTURE_IPC) {
        child.once('exit', (code, signal) => setImmediate(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          resolve({ code, signal, output });
        }));
      } else child.once('close', (code, signal) => {
        if (extra.FIXTURE_NO_STDERR_DRAIN) output += child.stderr.read()?.toString() || '';
        resolve({ code, signal, output });
      });
    });
    return { child, identity, ready, done };
  }
  const launchSupervised = (extra = {}) => launch(extra, true);
  return { root, marker, protocol, launch, launchSupervised, git, env, scratch, leaseFile, emergencyRelease };
}

function filesUnder(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return filesUnder(absolute);
    return entry.isFile() ? [absolute] : [];
  });
}

async function waitForIdentityGone(identity, deadline) {
  while (Date.now() < deadline) {
    if (roleFixture.identityGone(identity, roleFixture.captureIdentity(identity.pid))) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return roleFixture.identityGone(identity, roleFixture.captureIdentity(identity.pid));
}

function publicEntry(t, file, mode, extraEnv = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-public-entry-'));
  const admission = path.join(scratch, 'admit');
  const admissionMarker = path.join(scratch, 'admission-started');
  const releaseMarker = path.join(scratch, 'admission-release');
  const bodyMarker = path.join(scratch, 'body-started');
  const source = [
    '#!' + process.execPath,
    "const fs=require('node:fs');",
    "const args=process.argv.slice(2);const wait=args.indexOf('--max-wait');const seconds=Math.max(1,Number(args[wait+1])||1);",
    "fs.writeFileSync(process.env.FIXTURE_PUBLIC_ADMISSION,JSON.stringify({pid:process.pid,args}));",
    "process.stdout.write('ADMISSION_READY'+String.fromCharCode(10));",
    "if(process.env.FIXTURE_PUBLIC_HOLD){const end=Date.now()+seconds*1000;const poll=setInterval(()=>{if(fs.existsSync(process.env.FIXTURE_PUBLIC_RELEASE)){clearInterval(poll);process.exit(0);}if(Date.now()>=end){clearInterval(poll);process.exit(3);}},10);}else process.exit(0);"
  ].join(String.fromCharCode(10)) + String.fromCharCode(10);
  fs.writeFileSync(admission, source, { mode: 0o700 });
  const env = {
    ...process.env,
    APERTURE_GATE_ADMISSION_COMMAND: admission,
    APERTURE_GATE_TIME_LEFT_S: '40',
    APERTURE_GATE_SLOWEST_RUN_S: '20',
    FIXTURE_PUBLIC_HOLD: mode === 'preload' ? '' : '1',
    FIXTURE_PUBLIC_ADMISSION: admissionMarker,
    FIXTURE_PUBLIC_RELEASE: releaseMarker,
    FIXTURE_PUBLIC_BODY: bodyMarker,
    DISCORD_SURFACE_GATE_BODY: 'caller-selected-body',
    DISCORD_SURFACE_GATE_BODY_TOKEN: 'caller-owned-token',
    NODE_OPTIONS: '',
    ...extraEnv
  };
  delete env.NODE_TEST_CONTEXT;
  const registered = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf8')).scripts.test.split(/\s+/).slice(2);
  const entryArgs = file === 'scripts/test-gate.js' ? registered : [];
  const child = spawn('python3', [
    '-I', SUPERVISOR_SCRIPT, '--', process.execPath, path.join(PROJECT, file), ...entryArgs
  ], { cwd: PROJECT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const childIdentity = roleFixture.captureIdentity(child.pid);
  let output = '';
  let ready = false;
  let resolveReady;
  const readyPromise = new Promise(resolve => { resolveReady = resolve; });
  const onOutput = chunk => {
    output += chunk.toString();
    if (!ready && output.includes('ADMISSION_READY' + String.fromCharCode(10))) {
      ready = true;
      resolveReady(true);
    }
  };
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  const done = new Promise(resolve => child.once('close', (code, signal) => {
    if (!ready) resolveReady(false);
    resolve({ code, signal, output });
  }));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      if (childIdentity.kind !== 'present' || !roleFixture.signalOwned(childIdentity, 'SIGTERM')) {
        throw new Error('public-entry child identity is unresolved; custody retained at ' + scratch);
      }
      await Promise.race([done, new Promise(resolve => setTimeout(resolve, 8000))]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      throw new Error('public-entry child did not drain; custody retained at ' + scratch);
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  return {
    child, identity: childIdentity, ready: readyPromise, done, admissionMarker, bodyMarker, output: () => output,
    requests: () => 0,
    releaseAdmission: () => fs.writeFileSync(releaseMarker, 'release')
  };
}
test('identity inspection errors cannot prove actor absence', () => {
  const live = roleFixture.captureIdentity(process.pid);
  assert.equal(live.kind, 'present');
  const replies = [
    { errorCode: 'ETIMEDOUT' },
    { status: 1, stdout: '' },
    { status: 0, stdout: '' },
    { status: 0, stdout: '{' },
    { status: 0, stdout: JSON.stringify({ kind: 'present', identity: { pid: process.pid } }) },
    { status: 0, stdout: JSON.stringify({ kind: 'unknown' }) }
  ];
  for (const reply of replies) {
    const observed = roleFixture.captureIdentity(process.pid, () => reply);
    assert.equal(observed.kind, 'unknown');
    assert.equal(roleFixture.identityGone(live, observed), false);
  }
  const absentForOtherPid = roleFixture.captureIdentity(process.pid + 1, () => ({
    status: 0, stdout: JSON.stringify({ kind: 'absent' })
  }));
  assert.equal(roleFixture.identityGone(live, absentForOtherPid), false);
  const changed = { ...live };
  if (changed.platform === 'darwin') changed.unique_id += 1;
  else changed.start = (BigInt(changed.start) + 1n).toString();
  assert.equal(roleFixture.identityGone(live, changed), true);
});

test('real process absence is known and a reused pid is never signaled', { timeout: 20000 }, async () => {
  const knownAbsent = roleFixture.captureIdentity(2147483647);
  assert.equal(knownAbsent.kind, 'absent');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 5000)'], { stdio: 'ignore' });
  const identity = roleFixture.captureIdentity(child.pid);
  assert.equal(identity.kind, 'present');
  assert.equal(roleFixture.signalOwned(identity, 'SIGTERM'), true);
  await new Promise(resolve => child.once('exit', resolve));

  const staleSignalScript = [
    'const roles=require(' + JSON.stringify(ROLE_FIXTURE) + ');',
    'const deadline=setTimeout(()=>process.exit(7),5000);',
    'const current=roles.captureIdentity(process.pid);',
    "if(current.kind!=='present')process.exit(2);",
    'const stale={...current};',
    "if(stale.platform==='darwin')stale.unique_id+=1;else stale.start=(BigInt(stale.start)+1n).toString();",
    "if(roles.signalOwned(stale,'SIGKILL'))process.exit(3);",
    'clearTimeout(deadline);',
    "process.stdout.write('stale identity was not signaled\\n');"
  ].join('');
  const staleSignal = spawnSync(process.execPath, ['-e', staleSignalScript], {
    encoding: 'utf8', timeout: 8000
  });
  assert.equal(staleSignal.status, 0, staleSignal.stderr);
  assert.match(staleSignal.stdout, /stale identity was not signaled/);
});

test('identity reader inventory and absence decisions stay at their owners', () => {
  const roots = [
    path.join(PROJECT, 'scripts', 'full-gate'),
    path.join(PROJECT, 'scripts', 'full-gate.js'),
    path.join(PROJECT, 'scripts', 'full-gate-watchdog.js'),
    path.join(PROJECT, 'test', 'successor-authority', 'process-identity.js')
  ];
  const files = roots.flatMap(root => {
    try { return fs.statSync(root).isDirectory() ? filesUnder(root) : [root]; }
    catch { return []; }
  }).filter(file => /\.(?:js|py)$/.test(file));
  const readers = files.filter(file => {
    const source = fs.readFileSync(file, 'utf8');
    return /proc_pidinfo|readProcessIdentities|pidfd_open|['"]\/proc\/['"]/.test(source);
  }).map(file => path.relative(PROJECT, file).split(path.sep).join('/')).sort();
  assert.deepEqual(readers, [
    'scripts/full-gate-watchdog.js',
    'scripts/full-gate/darwin.py',
    'scripts/full-gate/supervisor.py',
    'test/successor-authority/process-identity.js'
  ]);
  const tests = fs.readFileSync(path.join(PROJECT, 'test', 'full-gate-entry.test.js'), 'utf8');
  assert.doesNotMatch(tests, /process\.kill\([^,\n]+,\s*0\)/);
  assert.doesNotMatch(tests, /spawnSync\(\s*['"]ps['"][^\n]*lstart=/);
  assert.doesNotMatch(tests, /assert\.(?:notDeepEqual|notEqual)\([^\n]*(?:captureIdentity|inspectIdentity)/);
  const directAbsenceAssertions = tests.split('\n').filter(line =>
    /assert\.(?:equal|ok|throws)\(/.test(line)
    && /captureIdentity|inspectIdentity/.test(line)
    && !/(?:identityGone|sameProcessIdentity)\(/.test(line));
  assert.deepEqual(directAbsenceAssertions, []);
});

test('Darwin cleanup retains a bootstrapped service when readiness identity is missing', () => {
  const script = [
    'import importlib.util, sys, time',
    'spec=importlib.util.spec_from_file_location("full_gate_supervisor",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)',
    'module._bootout=lambda *args: True',
    'module._read_job_state=lambda path: None',
    'class Owner: pass',
    'result=module._darwin_cleanup(Owner(),"launchctl","gui/501/com.discordsurface.fullgate.fixture",None,time.monotonic()+1,sys.argv[2],False)',
    'print("retained" if result is False else "released")'
  ].join('\n');
  const result = spawnSync('python3', ['-I', '-B', '-c', script, SUPERVISOR_SCRIPT, path.join(os.tmpdir(), 'missing-gate-state.json')], {
    encoding: 'utf8', timeout: 5000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'retained');
});

test('Python supervisor verdict uses the channel separate from saturated stderr', { timeout: 10000 }, async () => {
  const script = [
    'import importlib.util, os, signal, sys',
    'signal.alarm(4)',
    'spec=importlib.util.spec_from_file_location("full_gate_supervisor",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)',
    'os.set_blocking(2,False)',
    'payload=b"x"*4096',
    'while True:',
    '    try: os.write(2,payload)',
    '    except BlockingIOError: break',
    'os._exit(module.no_verdict("timeout","bounded fixture"))'
  ].join('\n');
  const child = spawn('python3', ['-I', '-B', '-c', script, SUPERVISOR_SCRIPT], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const result = await new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stderr.destroy();
  assert.deepEqual(result, { code: 98, signal: null });
  assert.match(output, /APERTURE-GATE-INDETERMINATE reason=timeout: bounded fixture/);
});

test('both public full entries decline before starting work without admission', () => {
  const env = { ...process.env };
  env.NODE_OPTIONS = '';
  env.APERTURE_GATE_TIME_LEFT_S = '20';
  env.APERTURE_GATE_SLOWEST_RUN_S = '5';
  env.APERTURE_GATE_ADMISSION_COMMAND = path.join(os.tmpdir(), 'gate-admission-missing-' + process.pid);
  delete env.DISCORD_SURFACE_GATE_BODY;
  for (const file of ['scripts/test-gate.js', 'scripts/package-smoke.js']) {
    const registered = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf8')).scripts.test.split(/\s+/).slice(2);
    const args = file === 'scripts/test-gate.js' ? registered : [];
    const result = spawnSync('python3', ['-I', SUPERVISOR_SCRIPT, '--', process.execPath, path.join(PROJECT, file), ...args], {
      cwd: PROJECT, env, encoding: 'utf8', timeout: 120000
    });
    assert.equal(result.status, 98);
    const output = result.stdout + result.stderr;
    assert.match(output, /APERTURE-GATE-INDETERMINATE reason=queue-missing/);
    assert.match(output, /nothing ran/);
  }
});

test('registered test subprocess blocks caller Python startup hooks', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-python-startup-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const pythonPath = path.join(scratch, 'pythonpath');
  const userBase = path.join(scratch, 'userbase');
  const marker = path.join(scratch, 'startup-ran');
  fs.mkdirSync(pythonPath, { recursive: true });
  fs.copyFileSync(path.join(PROJECT, 'test/helpers/sitecustomize.py'), path.join(pythonPath, 'sitecustomize.py'));
  const userSiteResult = spawnSync('python3', ['-c', 'import site; print(site.getusersitepackages())'], {
    encoding: 'utf8', timeout: 1000,
    env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONPATH: '', PYTHONUSERBASE: userBase }
  });
  assert.equal(userSiteResult.status, 0, userSiteResult.stderr);
  const userSite = userSiteResult.stdout.trim();
  fs.mkdirSync(userSite, { recursive: true });
  fs.copyFileSync(path.join(PROJECT, 'test/helpers/sitecustomize.py'), path.join(userSite, 'usercustomize.py'));
  const env = pythonTestEnvironment({
    ...process.env,
    PYTHONPATH: pythonPath,
    PYTHONUSERBASE: userBase,
    PYTHONNOUSERSITE: '0',
    DISCORD_SURFACE_GATE_SCRATCH: scratch,
    FIXTURE_PYTHON_SITE_MARKER: marker
  });
  const result = spawnSync('python3', ['-c', 'import sys; print(sys.flags.no_user_site)'], {
    encoding: 'utf8', timeout: 1000, env
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1');
  assert.equal(fs.existsSync(marker), false, 'caller startup modules ran in the test subprocess');
  assert.equal(env.PYTHONPATH, undefined);
  assert.equal(env.PYTHONPYCACHEPREFIX, path.join(scratch, 'python-pycache'));
});

test('outer supervisor bounds source preflight by the caller deadline', { timeout: 15000 }, t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-preflight-bound-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin);
  const fakeNode = path.join(bin, 'node');
  fs.writeFileSync(fakeNode, '#!/usr/bin/env python3\nimport time\ntime.sleep(30)\n', { mode: 0o700 });
  const env = {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    NODE_OPTIONS: '',
    APERTURE_GATE_TIME_LEFT_S: '10'
  };
  const started = Date.now();
  const result = spawnSync('python3', ['-I', SUPERVISOR_SCRIPT, '--', '/usr/bin/true'], {
    cwd: PROJECT, env, encoding: 'utf8', timeout: 12000
  });
  assert.equal(result.status, 98, result.stderr);
  assert.match(result.stdout, /reason=timeout/);
  assert.ok(Date.now() - started < 8000, 'preflight exceeded its caller deadline');
});

test('outer no-verdict survives a full child stderr log pipe', { timeout: 30000 }, async t => {
  const f = fixture(t);
  const result = await f.launchSupervised({
    APERTURE_GATE_TIME_LEFT_S: '20',
    APERTURE_GATE_SLOWEST_RUN_S: '5',
    FIXTURE_STDERR_BYTES: '2000000',
    FIXTURE_HANG: '1',
    FIXTURE_NO_STDERR_DRAIN: '1'
  }).done;
  assert.equal(result.code, 98, result.output);
  assert.equal((result.output.match(/APERTURE-GATE-INDETERMINATE/g) || []).length, 1, result.output.slice(-200));
  assert.match(result.output, /reason=timeout/);
  assert.equal(fs.existsSync(f.marker), true, 'the admitted body did not run');
});

test('gate and artifact digests and bypass decisions stay at their owners', () => {
  const scripts = filesUnder(path.join(PROJECT, 'scripts')).filter(file => file.endsWith('.js'));
  const relative = files => files.map(file => path.relative(PROJECT, file).split(path.sep).join('/')).sort();
  const contents = new Map(scripts.map(file => [file, fs.readFileSync(file, 'utf8')]));
  const digestOwners = scripts.flatMap(file => [...contents.get(file).matchAll(/crypto\.createHash\(['"]sha256['"]\)/g)].map(() => file));
  const bypassOwners = scripts.filter(file => /\bBODY_LABEL\b/.test(contents.get(file)));
  const gateEntrypoints = scripts.filter(file => file !== path.join(PROJECT, 'scripts/full-gate.js') && /runFullGate\(root,/.test(contents.get(file)));
  const bodyDispatchers = scripts.filter(file => /body-runner\.js/.test(contents.get(file)));
  const nodeOptionOwners = scripts.filter(file => /\bNODE_OPTIONS\b/.test(contents.get(file)));
  assert.deepEqual(relative(digestOwners), ['scripts/full-gate.js', 'scripts/full-gate.js', 'scripts/package-smoke.js', 'scripts/package-smoke.js']);
  assert.deepEqual(relative(bypassOwners), []);
  assert.deepEqual(relative(gateEntrypoints), ['scripts/package-smoke.js', 'scripts/test-gate.js']);
  assert.deepEqual(relative(bodyDispatchers), ['scripts/full-gate-watchdog.js']);
  assert.deepEqual(relative(nodeOptionOwners), ['scripts/full-gate.js', 'scripts/package-smoke.js', 'scripts/test-gate.js']);
});

test('retained artifact arguments preserve default and reject malformed destinations', () => {
  const destination = path.join(os.tmpdir(), 'discord-surface-retained.tgz');
  assert.equal(parseRetainArtifactArgs([]), null);
  assert.equal(parseRetainArtifactArgs(['--retain-artifact', destination]), destination);
  for (const args of [
    ['--unknown', destination],
    ['--retain-artifact'],
    ['--retain-artifact', ''],
    ['--retain-artifact', 'relative.tgz'],
    ['--retain-artifact', destination, '--retain-artifact', destination]
  ]) assert.throws(() => parseRetainArtifactArgs(args), /retain-artifact/);
});

test('package smoke forwards retained artifact arguments through the existing gate entry', async () => {
  const destination = path.join(os.tmpdir(), 'discord-surface-forwarded.tgz');
  let forwarded;
  const result = await runPackageSmokeEntry(['--retain-artifact', destination], (...args) => {
    forwarded = args;
    return Promise.resolve(0);
  });
  assert.equal(result, 0);
  assert.deepEqual(forwarded, [PROJECT, 'package-smoke', path.join(PROJECT, 'scripts/package-smoke.js'), ['--retain-artifact', destination]]);
});

test('retained artifact destination containment follows parent symlinks', t => {
  const rawDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-destination-'));
  t.after(() => fs.rmSync(rawDirectory, { recursive: true, force: true }));
  const scratch = fs.realpathSync.native(rawDirectory);
  const checkout = path.join(scratch, 'checkout');
  const gateScratch = path.join(scratch, 'gate-scratch');
  const outside = path.join(scratch, 'outside');
  fs.mkdirSync(checkout);
  fs.mkdirSync(gateScratch);
  fs.mkdirSync(outside);
  fs.symlinkSync(checkout, path.join(outside, 'checkout-link'), 'dir');
  fs.symlinkSync(gateScratch, path.join(outside, 'scratch-link'), 'dir');
  assert.throws(() => validateRetainArtifactDestination(path.join(checkout, 'artifact.tgz'), checkout, gateScratch), /outside/);
  assert.throws(() => validateRetainArtifactDestination(path.join(outside, 'checkout-link', 'artifact.tgz'), checkout, gateScratch), /outside/);
  assert.throws(() => validateRetainArtifactDestination(path.join(outside, 'scratch-link', 'artifact.tgz'), checkout, gateScratch), /outside/);
  assert.throws(() => validateRetainArtifactDestination(path.join(outside, 'missing', 'artifact.tgz'), checkout, gateScratch), /parent must exist/);
  assert.equal(validateRetainArtifactDestination(path.join(outside, 'artifact.tgz'), checkout, gateScratch), path.join(outside, 'artifact.tgz'));
});

test('retained artifact uses canonical destination after alias retarget', t => {
  const rawDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-canonical-'));
  t.after(() => fs.rmSync(rawDirectory, { recursive: true, force: true }));
  const fixture = fs.realpathSync.native(rawDirectory);
  const checkout = path.join(fixture, 'checkout');
  const gateScratch = path.join(fixture, 'gate-scratch');
  const target = path.join(fixture, 'target');
  const replacement = path.join(fixture, 'replacement');
  const alias = path.join(fixture, 'alias');
  const source = path.join(fixture, 'source.tgz');
  fs.mkdirSync(checkout);
  fs.mkdirSync(gateScratch);
  fs.mkdirSync(target);
  fs.mkdirSync(replacement);
  fs.writeFileSync(source, 'canonical bytes');
  fs.symlinkSync(target, alias, 'dir');
  const requested = path.join(alias, 'candidate.tgz');
  const canonical = validateRetainArtifactDestination(requested, checkout, gateScratch);
  assert.equal(canonical, path.join(target, 'candidate.tgz'));
  fs.unlinkSync(alias);
  fs.symlinkSync(replacement, alias, 'dir');
  const retained = retainArtifact(source, canonical);
  assert.equal(retained.path, canonical);
  assert.deepEqual(fs.readFileSync(path.join(target, 'candidate.tgz')), Buffer.from('canonical bytes'));
  assert.equal(fs.existsSync(path.join(replacement, 'candidate.tgz')), false);
});

test('retained artifact preserves exact bytes, hash, mode and scratch independence', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-artifact-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const scratch = path.join(fixture, 'scratch');
  fs.mkdirSync(scratch);
  const source = path.join(scratch, 'package.tgz');
  const destination = path.join(fixture, 'retained-package.tgz');
  const bytes = Buffer.from('smoke-tested package bytes\n');
  fs.writeFileSync(source, bytes);
  const retained = retainArtifact(source, destination);
  const expectedHash = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(fs.readFileSync(destination), bytes);
  assert.deepEqual(retained, { path: destination, bytes: bytes.length, sha256: expectedHash, mode: 0o400, candidate: true });
  assert.equal(fs.statSync(destination).mode & 0o777, 0o400);
  assert.throws(() => retainArtifact(source, destination), /already exists/);
  assert.deepEqual(fs.readFileSync(destination), bytes);
  fs.rmSync(scratch, { recursive: true, force: true });
  assert.deepEqual(fs.readFileSync(destination), bytes);
});

test('retained artifact failure cleans only owned staging bytes', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-artifact-failure-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const scratch = path.join(fixture, 'scratch');
  const destination = path.join(fixture, 'candidate.tgz');
  const source = path.join(scratch, 'source.tgz');
  fs.mkdirSync(scratch);
  fs.writeFileSync(source, 'failure bytes');
  const stageFiles = () => fs.readdirSync(path.dirname(destination)).filter(file => file.startsWith(path.basename(destination) + '.partial-'));
  assert.throws(() => retainArtifact(source, destination, {
    afterWrite: ({ fd }) => fs.writeSync(fd, Buffer.from('x'), 0, 1, 0)
  }), /verification failed/);
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(stageFiles(), []);
  assert.throws(() => retainArtifact(source, destination, {
    publish: () => { throw new Error('injected publication failure'); }
  }), /injected publication failure/);
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(stageFiles(), []);
  assert.throws(() => retainArtifact(source, destination, {
    afterPublish: () => { throw new Error('injected post-link failure'); }
  }), /injected post-link failure/);
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(stageFiles(), []);
  const replacement = Buffer.from('foreign replacement');
  assert.throws(() => retainArtifact(source, destination, {
    afterPublish: ({ destination: publishedDestination }) => {
      fs.unlinkSync(publishedDestination);
      fs.writeFileSync(publishedDestination, replacement);
    }
  }), /verification failed/);
  assert.deepEqual(fs.readFileSync(destination), replacement);
  assert.deepEqual(stageFiles(), []);
  fs.unlinkSync(destination);
  const existing = Buffer.from('pre-existing bytes');
  fs.writeFileSync(destination, existing);
  assert.throws(() => retainArtifact(source, destination), /already exists/);
  assert.deepEqual(fs.readFileSync(destination), existing);
  assert.deepEqual(stageFiles(), []);
});

test('package body publishes after installed smoke and keeps candidate after scratch cleanup', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'package-body-retain-'));
  const gateScratch = path.join(fixture, 'gate-scratch');
  const destination = path.join(fixture, 'candidate.tgz');
  const previousScratch = process.env[SCRATCH_ROOT];
  fs.mkdirSync(gateScratch);
  process.env[SCRATCH_ROOT] = gateScratch;
  t.after(() => {
    if (previousScratch === undefined) delete process.env[SCRATCH_ROOT];
    else process.env[SCRATCH_ROOT] = previousScratch;
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  const bytes = Buffer.from('fake smoke-tested tarball');
  const files = [
    'package.json', 'src/topic.js', 'dist/topic.js', 'dist/topic.d.ts',
    'src/attachments.js', 'dist/attachments.js', 'dist/attachments.d.ts',
    'src/state/thread-enrollment.js', 'dist/state/thread-enrollment.js', 'dist/state/thread-enrollment.d.ts',
    'src/discord/thread-enrollment.js', 'dist/discord/thread-enrollment.js', 'dist/discord/thread-enrollment.d.ts'
  ].map(file => ({ path: file }));
  const calls = [];
  const sequence = [];
  const execute = (_command, args, options = {}) => {
    calls.push(args);
    sequence.push(args[0]);
    if (args[0] === 'pack') {
      const destinationIndex = args.indexOf('--pack-destination') + 1;
      const packDestination = args[destinationIndex];
      const filename = 'fixture-package.tgz';
      fs.mkdirSync(path.join(options.cwd, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(packDestination, filename), bytes);
      return JSON.stringify([{ filename, files }], null, 2);
    }
    assert.equal(args[0], 'install');
    return '';
  };
  const quiet = process.stdout.write;
  process.stdout.write = () => true;
  try {
    runBody(['--retain-artifact', destination], { run: execute, runInstalledSmoke: () => sequence.push('smoke') });
  } finally {
    process.stdout.write = quiet;
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(sequence, ['pack', 'install', 'smoke']);
  assert.deepEqual(fs.readFileSync(destination), bytes);
  assert.equal(fs.statSync(destination).mode & 0o777, 0o400);
  assert.deepEqual(fs.readdirSync(gateScratch), []);
  assert.throws(() => runBody(['--retain-artifact', destination], { run: execute, runInstalledSmoke: () => {} }), /already exists/);
  assert.equal(calls.length, 2);
  assert.deepEqual(fs.readFileSync(destination), bytes);
});

test('package body does not retain before installed smoke succeeds', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'package-body-failure-'));
  const gateScratch = path.join(fixture, 'gate-scratch');
  const destination = path.join(fixture, 'candidate.tgz');
  const previousScratch = process.env[SCRATCH_ROOT];
  fs.mkdirSync(gateScratch);
  process.env[SCRATCH_ROOT] = gateScratch;
  t.after(() => {
    if (previousScratch === undefined) delete process.env[SCRATCH_ROOT];
    else process.env[SCRATCH_ROOT] = previousScratch;
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  const files = [
    'package.json', 'src/topic.js', 'dist/topic.js', 'dist/topic.d.ts',
    'src/attachments.js', 'dist/attachments.js', 'dist/attachments.d.ts',
    'src/state/thread-enrollment.js', 'dist/state/thread-enrollment.js', 'dist/state/thread-enrollment.d.ts',
    'src/discord/thread-enrollment.js', 'dist/discord/thread-enrollment.js', 'dist/discord/thread-enrollment.d.ts'
  ].map(file => ({ path: file }));
  const execute = (_command, args, options = {}) => {
    if (args[0] === 'pack') {
      const packDestination = args[args.indexOf('--pack-destination') + 1];
      const filename = 'fixture-package.tgz';
      fs.mkdirSync(path.join(options.cwd, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(packDestination, filename), 'fake tarball');
      return JSON.stringify([{ filename, files }], null, 2);
    }
    assert.equal(args[0], 'install');
    return '';
  };
  const quiet = process.stdout.write;
  process.stdout.write = () => true;
  try {
    assert.throws(() => runBody(['--retain-artifact', destination], {
      run: execute,
      runInstalledSmoke: () => { throw new Error('injected smoke failure'); }
    }), /injected smoke failure/);
  } finally {
    process.stdout.write = quiet;
  }
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(fs.readdirSync(gateScratch), []);
});

test('package body does not retain when install fails', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'package-body-install-failure-'));
  const gateScratch = path.join(fixture, 'gate-scratch');
  const destination = path.join(fixture, 'candidate.tgz');
  const previousScratch = process.env[SCRATCH_ROOT];
  fs.mkdirSync(gateScratch);
  process.env[SCRATCH_ROOT] = gateScratch;
  t.after(() => {
    if (previousScratch === undefined) delete process.env[SCRATCH_ROOT];
    else process.env[SCRATCH_ROOT] = previousScratch;
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  const files = [
    'package.json', 'src/topic.js', 'dist/topic.js', 'dist/topic.d.ts',
    'src/attachments.js', 'dist/attachments.js', 'dist/attachments.d.ts',
    'src/state/thread-enrollment.js', 'dist/state/thread-enrollment.js', 'dist/state/thread-enrollment.d.ts',
    'src/discord/thread-enrollment.js', 'dist/discord/thread-enrollment.js', 'dist/discord/thread-enrollment.d.ts'
  ].map(file => ({ path: file }));
  const sequence = [];
  const execute = (_command, args, options = {}) => {
    sequence.push(args[0]);
    if (args[0] === 'pack') {
      const packDestination = args[args.indexOf('--pack-destination') + 1];
      const filename = 'fixture-package.tgz';
      fs.mkdirSync(path.join(options.cwd, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(packDestination, filename), 'fake tarball');
      return JSON.stringify([{ filename, files }], null, 2);
    }
    assert.equal(args[0], 'install');
    throw new Error('injected install failure');
  };
  const quiet = process.stdout.write;
  process.stdout.write = () => true;
  try {
    assert.throws(() => runBody(['--retain-artifact', destination], {
      run: execute,
      runInstalledSmoke: () => { throw new Error('smoke should not run'); }
    }), /injected install failure/);
  } finally {
    process.stdout.write = quiet;
  }
  assert.deepEqual(sequence, ['pack', 'install']);
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(fs.readdirSync(gateScratch), []);
});

test('retained artifact missing source leaves no destination', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-artifact-missing-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const destination = path.join(scratch, 'candidate.tgz');
  assert.throws(() => retainArtifact(path.join(scratch, 'missing.tgz'), destination));
  assert.equal(fs.existsSync(destination), false);
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
  test('caller-selected authorization data cannot bypass real admission for ' + file, { timeout: 30000 }, async t => {
    const run = publicEntry(t, file, 'silence');
    const started = Date.now();
    const result = await run.done;
    assert.equal(result.code, 98, result.output);
    assert.match(result.output, /reason=capacity/);
    assert.equal(fs.existsSync(run.admissionMarker), true, result.output);
    assert.equal(result.output.includes('FULL_GATE_SOURCE='), false, 'body dispatch preceded canonical admission');
    assert.ok(Date.now() - started < 40000, 'silent admission exceeded the caller budget');
  });

  test('interruption during admission does not restart the public gate budget for ' + file, { timeout: 30000 }, async t => {
    const run = publicEntry(t, file, 'interrupt');
    const started = Date.now();
    assert.equal(await run.ready, true, run.output() || 'canonical admission did not start');
    assert.equal(roleFixture.signalOwned(run.identity, 'SIGHUP'), true, 'public-entry identity changed before interruption');
    const result = await run.done;
    assert.equal(result.code, 98, result.output);
    assert.match(result.output, /reason=interrupted/);
    assert.equal(result.output.includes('FULL_GATE_SOURCE='), false, 'body dispatch followed interruption');
    assert.ok(Date.now() - started < 40000, 'interruption exceeded the caller budget');
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
  const result = await f.launch({ FIXTURE_FORGE_MARKER: '1', DISCORD_SURFACE_GATE_NO_VERDICT_SECRET: 'caller-secret' }).done;
  assert.equal(result.code, 98, result.output);
  assert.equal(fs.readFileSync(f.marker + '.fd4', 'utf8'), 'opened');
  const body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
  assert.equal(body.secretPresent, false);
  assert.equal(body.parentSecretPresent, false);
  assert.equal(result.output.includes('APERTURE-GATE-INDETERMINATE'), false);
});

test('sentinel secret stays out of admitted body environments', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const result = await f.launch({ DISCORD_SURFACE_GATE_NO_VERDICT_SECRET: 'caller-secret' }).done;
  assert.equal(result.code, 0, result.output);
  const body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
  assert.equal(body.secretPresent, false);
  assert.equal(body.parentSecretPresent, false);
});

test('no-verdict marker starts on a new line after body stderr fragment', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const result = await f.launch({ FIXTURE_STDERR_FRAGMENT: '1', FIXTURE_CHANGE_BODY: '1' }).done;
  assert.equal(result.code, 98, result.output);
  assert.match(result.output, /checking\nAPERTURE-GATE-INDETERMINATE reason=stale/);
  assert.equal(result.output.includes('checkingAPERTURE-GATE-INDETERMINATE'), false);
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
    const admittedRoles = JSON.parse(fs.readFileSync(f.protocol + '.roles', 'utf8'));
    assert.equal(holder, admittedRoles.worker.pid, 'the recorded worker is the admitted holder');
    assert.match(args[args.indexOf('--ticket') + 1], /^[A-Za-z0-9._:-]{1,128}$/);
    assert.equal(roleFixture.identityGone(admittedRoles.worker, roleFixture.captureIdentity(holder)), true, 'admission worker remained after cleanup');
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

test('a detached descendant cannot write source after gate completion', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const armed = path.join(f.scratch, 'detached-armed');
  const done = path.join(f.scratch, 'detached-done');
  const pidFile = path.join(f.scratch, 'detached-pid');
  let child;
  try {
    const result = await f.launch({
      FIXTURE_DETACHED_LATE_WRITE: '1',
      FIXTURE_DETACHED_ARMED: armed,
      FIXTURE_DETACHED_DONE: done,
      FIXTURE_DETACHED_PID: pidFile
    }).done;
    child = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(result.code, 98, result.output);
    assert.match(result.output, /APERTURE-GATE-INDETERMINATE reason=(?:interrupted|cleanup|stale)/);
    assert.equal(fs.existsSync(done), false);
    assert.equal(fs.readFileSync(path.join(f.root, 'input'), 'utf8'), 'source\n');
    assert.equal(roleFixture.identityGone(child.identity, roleFixture.captureIdentity(child.pid)), true, 'owned detached child remained after cleanup');
  } finally {
    if (!child && fs.existsSync(pidFile)) child = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    if (child) {
      const current = roleFixture.captureIdentity(child.pid);
      if (!roleFixture.identityGone(child.identity, current)) {
        if (!roleFixture.sameProcessIdentity(child.identity, current)
            || !roleFixture.signalOwned(child.identity, 'SIGTERM')) {
          throw new Error('detached child cleanup is unresolved; custody retained at ' + f.scratch);
        }
        if (!await waitForIdentityGone(child.identity, Date.now() + 5000)) {
          throw new Error('detached child did not drain; custody retained at ' + f.scratch);
        }
      }
    }
  }
});

test('interruption stops a body that ignores TERM before releasing its holder', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const run = f.launch({ FIXTURE_HANG: '1' });
  await Promise.race([run.ready, run.done.then(value => assert.fail(value.output))]);
  const body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
  assert.equal(roleFixture.signalOwned(run.identity, 'SIGTERM'), true, 'fixture identity changed before interruption');
  const result = await run.done;
  assert.equal(result.code, 98, result.output);
  assert.match(result.output, /APERTURE-GATE-INDETERMINATE reason=interrupted/);
  assert.equal((result.output.match(/APERTURE-GATE-INDETERMINATE/g) || []).length, 1);
  assert.equal(roleFixture.identityGone(body.identity, roleFixture.captureIdentity(body.pid)), true, 'body remained after interruption cleanup');
  const args = JSON.parse(fs.readFileSync(f.protocol, 'utf8'));
  const holder = Number(args[args.indexOf('--holder') + 1]);
  const admittedRoles = JSON.parse(fs.readFileSync(f.protocol + '.roles', 'utf8'));
  assert.equal(roleFixture.identityGone(admittedRoles.worker, roleFixture.captureIdentity(holder)), true, 'holder remained after interruption cleanup');
});

test('child marker text cannot manufacture the enclosing gate verdict', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk.toString(); });
  const drained = relay(input, output);
  input.write('APERTURE-GATE-');
  input.end('INDETERMINATE reason=capacity\n');
  await new Promise(resolve => input.once('end', resolve));
  assert.equal(await drained, true);
  assert.equal(text, 'CHILD-GATE-INDETERMINATE reason=capacity\n');
});

test('output relay pauses its source until the sink drains', async () => {
  const input = new PassThrough({ highWaterMark: 1 });
  const output = new PassThrough({ highWaterMark: 1 });
  let text = '';
  let settled = false;
  output.on('data', chunk => { text += chunk.toString(); });
  output.pause();
  const drained = relay(input, output).then(result => { settled = true; return result; });
  input.write('blocked output');
  input.end(' tail');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(input.isPaused(), true);
  assert.equal(settled, false);
  output.resume();
  assert.equal(await drained, true);
  assert.equal(text, 'blocked output tail');
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

test('explicitly empty caller budget is rejected before admission or the body', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const result = await f.launch({ APERTURE_GATE_TIME_LEFT_S: '' }).done;
  assert.equal(result.code, 4, result.output);
  assert.match(result.output, /APERTURE_GATE_TIME_LEFT_S must be a positive whole number/);
  assert.equal(fs.existsSync(f.protocol), false);
  assert.equal(fs.existsSync(f.marker), false);
});

test('full gate rejects callers without the pre-Node supervisor before admission', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const result = await f.launch({ [SUPERVISOR.ENVIRONMENT]: '' }).done;
  assert.equal(result.code, 98, result.output);
  assert.match(result.output, /reason=setup/);
  assert.equal(fs.existsSync(f.protocol), false);
  assert.equal(fs.existsSync(f.marker), false);
});

test('a caller-supplied supervisor mode cannot replace the launcher receipt', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const result = await f.launch({ [SUPERVISOR.RECEIPT]: '', [SUPERVISOR.TOKEN]: '' }).done;
  assert.equal(result.code, 98, result.output);
  assert.match(result.output, /full gate supervisor could not verify this launch/);
  assert.equal(fs.existsSync(f.protocol), false);
  assert.equal(fs.existsSync(f.marker), false);
});

test('pre-Node supervisor refuses NODE_OPTIONS before a preload can clear it', { timeout: 15000 }, t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-supervisor-preload-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const preload = path.join(scratch, 'preload.cjs');
  const preloadMarker = path.join(scratch, 'preload-ran');
  const bodyMarker = path.join(scratch, 'body-ran');
  fs.writeFileSync(preload, "delete process.env.NODE_OPTIONS; require('node:fs').writeFileSync(process.env.FIXTURE_PRELOAD_MARKER, 'ran');\n");
  const env = { ...process.env, NODE_OPTIONS: '--require=' + preload, FIXTURE_PRELOAD_MARKER: preloadMarker };
  const result = spawnSync('python3', [
    '-I', SUPERVISOR_SCRIPT, '--', process.execPath, '-e',
    "require('node:fs').writeFileSync(" + JSON.stringify(bodyMarker) + ", 'ran')"
  ], { cwd: PROJECT, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 98, result.stderr + result.stdout);
  assert.match(result.stdout, /APERTURE-GATE-INDETERMINATE reason=setup/);
  assert.equal(fs.existsSync(preloadMarker), false);
  assert.equal(fs.existsSync(bodyMarker), false);
});

test('supervisor fails closed before the body on an unsupported platform', { timeout: 15000 }, t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-supervisor-platform-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const bodyMarker = path.join(scratch, 'body-ran');
  const script = [
    'import importlib.util,sys',
    'spec=importlib.util.spec_from_file_location("gate_supervisor",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)',
    'module.sys.platform="unsupported-fixture"',
    'raise SystemExit(module.run(["--",*sys.argv[2:]]))'
  ].join('\n');
  const result = spawnSync('python3', [
    '-I', '-B', '-c', script, SUPERVISOR_SCRIPT, process.execPath, '-e',
    "require('node:fs').writeFileSync(" + JSON.stringify(bodyMarker) + ", 'ran')"
  ], { cwd: PROJECT, env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 98, result.stderr + result.stdout);
  assert.match(result.stdout, /APERTURE-GATE-INDETERMINATE reason=setup/);
  assert.match(result.stdout, /kernel-backed process ownership is unavailable on this host/);
  assert.equal(fs.existsSync(bodyMarker), false);
});

test('Linux supervisor waits for a detached descendant before final fingerprint', { skip: process.platform !== 'linux', timeout: 30000 }, t => {
  const f = fixture(t);
  const source = path.join(f.root, 'input');
  const grandchild = "setTimeout(() => require('node:fs').writeFileSync(" + JSON.stringify(source) + ", 'late'), 250)";
  const body = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e'," + JSON.stringify(grandchild) + "],{detached:true,stdio:'ignore'});child.unref();";
  const env = { ...process.env, NODE_OPTIONS: '', APERTURE_GATE_TIME_LEFT_S: '30', APERTURE_GATE_SLOWEST_RUN_S: '2' };
  const result = spawnSync('python3', [
    '-I', SUPERVISOR_SCRIPT, '--', process.execPath, '-e', body
  ], { cwd: f.root, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 98, result.stderr + result.stdout);
  assert.match(result.stdout, /reason=stale/);
  assert.equal(fs.readFileSync(source, 'utf8'), 'late');
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
  const run = f.launch({ FIXTURE_HANG: '1', FIXTURE_RECREATE_SCRATCH: '1' });
  await Promise.race([run.ready, run.done.then(value => assert.fail(value.output))]);
  const body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
  const roles = JSON.parse(fs.readFileSync(f.protocol + '.roles', 'utf8'));
  assert.equal(roleFixture.signalOwned(run.identity, 'SIGKILL'), true, 'fixture identity changed before worker-loss control');
  const result = await run.done;
  assert.equal(result.signal, 'SIGKILL');
  const drained = identity => roleFixture.identityGone(identity, roleFixture.captureIdentity(identity.pid));
  const bound = Date.now() + 30000;
  while ((!drained(body.identity) || !drained(roles.worker)) && Date.now() < bound) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(drained(body.identity), true, 'body remained after watchdog cleanup');
  assert.equal(drained(roles.worker), true, 'worker remained after watchdog cleanup');
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
  const supervisor = createSupervisorReceipt(scratch);
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
  env[SUPERVISOR.ENVIRONMENT] = SUPERVISOR.LINUX_SUBREAPER;
  env[SUPERVISOR.RECEIPT] = supervisor.receipt;
  env[SUPERVISOR.TOKEN] = supervisor.token;
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


test('caller disconnect during final source verification is a no-verdict', { skip: process.platform === 'win32', timeout: 180000 }, async t => {
  const f = fixture(t);
  const bin = path.join(f.scratch, 'git-wrapper');
  fs.mkdirSync(bin);
  const counter = path.join(f.scratch, 'revision-count');
  const signalMarker = path.join(f.scratch, 'final-snapshot-signal');
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
    FIXTURE_FINAL_RELEASE: f.emergencyRelease,
    FIXTURE_IPC: '1'
  });
  const signalDeadline = Date.now() + 10000;
  while (!fs.existsSync(signalMarker) && Date.now() < signalDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(signalMarker), true, 'final source verification did not start');
  const signal = JSON.parse(fs.readFileSync(signalMarker, 'utf8'));
  assert.equal(signal.manager, run.child.pid);
  assert.equal(run.child.connected, true);
  run.child.disconnect();
  run.child.ref();
  fs.writeFileSync(f.emergencyRelease, 'release');
  const result = await run.done;
  assert.equal(fs.readFileSync(counter, 'utf8'), '3');
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

for (const layout of ['git', 'archive']) test(`${layout} fingerprint includes ignored Python bytecode and source edits`, t => {
  const f = fixture(t);
  fs.copyFileSync(path.join(PROJECT, '.gitignore'), path.join(f.root, '.gitignore'));
  const source = path.join(f.root, 'helper.py');
  const cache = path.join(f.root, 'src', '__pycache__');
  fs.writeFileSync(source, 'value = 1\n');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'helper.cpython.pyc'), 'generated bytecode');
  if (layout === 'git') f.git(['add', '.gitignore', 'helper.py']);
  else fs.rmSync(path.join(f.root, '.git'), { recursive: true, force: true });
  const first = revision(f.root);
  fs.writeFileSync(path.join(cache, 'helper.cpython.pyc'), 'changed bytecode');
  assert.notEqual(revision(f.root), first);
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
  const run = f.launchSupervised({ FIXTURE_KILL_GUARD: '1', FIXTURE_HANG: '1' });
  const result = await run.done;
  assert.equal(result.code, 98, result.output);
  assert.equal((result.output.match(/APERTURE-GATE-INDETERMINATE/g) || []).length, 1);
  const body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
  assert.equal(roleFixture.identityGone(body.identity, roleFixture.captureIdentity(body.pid)), true, 'body remained after guardian cleanup');
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
  const first = f.launchSupervised(env);
  const waitDeadline = Date.now() + 10000;
  let stopped;
  while (Date.now() < waitDeadline) {
    try { stopped = JSON.parse(fs.readFileSync(workerKilled, 'utf8')); }
    catch {}
    if (stopped?.state === 'signaled' || stopped?.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(stopped, 'fixture did not persist role custody');
  assert.equal(stopped.state, 'signaled', JSON.stringify(stopped));
  const lease = JSON.parse(fs.readFileSync(f.leaseFile, 'utf8'));
  assert.equal(lease.holders.length, 2);
  assert.notEqual(lease.holders[0].pid, lease.holders[1].pid);

  const secondMarker = path.join(f.scratch, 'second-body.json');
  const second = f.launchSupervised({ ...env, FIXTURE_KILL_WORKER: '', FIXTURE_HANG: '', FIXTURE_MARKER: secondMarker });
  const secondResult = await second.done;
  assert.equal(secondResult.code, 98, secondResult.output);
  assert.match(secondResult.output, /reason=capacity/);
  assert.equal(fs.existsSync(secondMarker), false, 'a second body started before the first cleanup finished');

  const supervisors = stopped.extraHolders.length ? stopped.extraHolders : [stopped.manager];
  for (const holder of supervisors) assert.equal(roleFixture.signalOwned(holder, 'SIGCONT'), true, 'supervisor identity changed before resume');
  const firstResult = await first.done;
  assert.equal(firstResult.code, 98, firstResult.output);
  const body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
  assert.equal(roleFixture.identityGone(stopped.body, roleFixture.captureIdentity(body.pid)), true, 'body process remained after guardian cleanup');
  assert.equal(fs.existsSync(body.scratch), false);

  const resumedMarker = path.join(f.scratch, 'resumed-body.json');
  const resumed = await f.launchSupervised({ FIXTURE_LEASE_ENFORCE: '1', FIXTURE_MARKER: resumedMarker }).done;
  assert.equal(resumed.code, 0, resumed.output);
  assert.equal(fs.existsSync(resumedMarker), true, 'admission did not resume after cleanup finished');
});

test('launchd coalition drain catches a detached grandchild after its helper exits', { timeout: 30000 }, async t => {
  const unrelated = fixture(t);
  const unrelatedRun = unrelated.launchSupervised({ FIXTURE_HANG: '1' });
  await Promise.race([unrelatedRun.ready, unrelatedRun.done.then(result => assert.fail(result.output))]);
  const unrelatedRoles = JSON.parse(fs.readFileSync(unrelated.protocol + '.roles', 'utf8'));
  const unrelatedJob = unrelatedRoles.extraHolders[1];
  assert.ok(unrelatedJob, 'unrelated launchd job identity was not recorded');

  const f = fixture(t);
  const bodyReady = path.join(f.scratch, 'reparented-body-ready');
  const release = path.join(f.scratch, 'reparented-release');
  const childPath = path.join(f.scratch, 'reparented-child.json');
  const orphaned = path.join(f.scratch, 'reparented-helper-exited');
  const done = path.join(f.scratch, 'reparented-late-write');
  const run = f.launchSupervised({
    FIXTURE_REPARENTED_DESCENDANT: '1',
    FIXTURE_REPARENTED_BODY_READY: bodyReady,
    FIXTURE_REPARENTED_RELEASE: release,
    FIXTURE_REPARENTED_CHILD: childPath,
    FIXTURE_REPARENTED_ORPHANED: orphaned,
    FIXTURE_REPARENTED_DONE: done
  });
  const startupDeadline = Date.now() + 10000;
  while (!fs.existsSync(bodyReady) && Date.now() < startupDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(bodyReady), true, 'body did not reach the reparenting fixture');
  const roles = JSON.parse(fs.readFileSync(f.protocol + '.roles', 'utf8'));
  const targetJob = roles.extraHolders[1];
  assert.ok(targetJob, 'target launchd job identity was not recorded');
  assert.notEqual(targetJob.coalition_id, unrelatedJob.coalition_id, 'launchd allocated separate job coalitions');
  assert.equal(roleFixture.signalOwned(roles.guardian, 'SIGSTOP'), true, 'guardian identity changed before suspension');
  fs.writeFileSync(release, 'release');
  const orphanDeadline = Date.now() + 5000;
  while (!fs.existsSync(orphaned) && Date.now() < orphanDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(orphaned), true, 'short-lived helper did not exit after detaching its child');
  const child = JSON.parse(fs.readFileSync(childPath, 'utf8'));
  const childIdentity = roleFixture.captureIdentity(child.pid);
  assert.equal(childIdentity.kind, 'present', 'detached grandchild was not live after its helper exited');
  assert.equal(childIdentity.coalition_id, roles.guardian.coalition_id, 'launchd descendant did not inherit the job resource coalition');
  assert.equal(roleFixture.signalOwned(roles.guardian, 'SIGCONT'), true, 'guardian identity changed before resume');

  const result = await run.done;
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(roleFixture.captureIdentity(unrelatedJob.pid), unrelatedJob, 'target cleanup signaled an unrelated launchd job');
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.equal(fs.existsSync(done), false, 'grandchild wrote after the gate verdict');
  assert.equal(fs.readFileSync(path.join(f.root, 'input'), 'utf8'), 'source\n');
  assert.equal(roleFixture.identityGone(childIdentity, roleFixture.captureIdentity(child.pid)), true, 'detached grandchild survived the coalition drain');
  assert.equal(roleFixture.signalOwned(unrelatedJob, 'SIGHUP'), true, 'unrelated fixture identity changed before shutdown');
  const unrelatedResult = await unrelatedRun.done;
  assert.equal(unrelatedResult.code, 98, unrelatedResult.output);
  assert.match(unrelatedResult.output, /reason=interrupted/);
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

test('worker replaces watchdog fd 4 before starting the gate supervisor', () => {
  const { EventEmitter } = require('node:events');
  const vm = require('node:vm');
  const workerProcess = new EventEmitter();
  Object.assign(workerProcess, { argv: ['node', 'worker', '5000', 'entry'], pid: 23456, connected: true, send: () => {}, kill: () => {}, exit: () => {} });
  const guard = new EventEmitter();
  Object.assign(guard, { connected: true, pid: 23457, send: () => {} });
  let options;
  vm.runInNewContext(fs.readFileSync(path.join(PROJECT, 'scripts/full-gate-worker.js'), 'utf8'), {
    __dirname: path.join(PROJECT, 'scripts'),
    process: workerProcess,
    require: name => {
      if (name === 'node:path') return path;
      if (name === 'node:child_process') return { fork: (_file, _args, spawnOptions) => { options = spawnOptions; return guard; } };
      if (name === './full-gate') return { MESSAGES, NO_VERDICT, canFinish: () => true, noVerdict: () => NO_VERDICT, releaseScratch: () => true, REASONS: { INTERRUPTED: 'interrupted' }, SCRATCH_ROOT: 'scratch' };
      throw new Error('unexpected worker import ' + name);
    }
  }, { timeout: 1000 });
  assert.equal(options.stdio[3], 'ipc');
  assert.equal(options.stdio[4], 'ignore');
});

test('scratch cleanup subprocess is bounded by the gate deadline', () => {
  const vm = require('node:vm');
  const deadline = Date.now() + 5000;
  const cleanups = [];
  const moduleFixture = { exports: {} };
  vm.runInNewContext(fs.readFileSync(GATE, 'utf8'), {
    Buffer,
    __dirname: path.join(PROJECT, 'scripts'),
    process,
    module: moduleFixture,
    exports: moduleFixture.exports,
    require: name => {
      if (name === 'node:child_process') return { fork: () => {}, spawnSync: (command, args, options) => {
        cleanups.push({ command, args, options });
        return { status: 0 };
      } };
      return require(name);
    }
  }, { timeout: 1000 });
  assert.equal(moduleFixture.exports.releaseScratch('/tmp/gate-scratch', deadline), true);
  assert.equal(cleanups.length, 1);
  assert.equal(cleanups[0].command, process.execPath);
  assert.equal(cleanups[0].args[0], '-e');
  assert.ok(cleanups[0].options.timeout > 0 && cleanups[0].options.timeout <= 5000);
  assert.equal(cleanups[0].options.killSignal, 'SIGKILL');
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
        return { status: 0, stdout: '12345 1 12345 S\n23456 12345 12345 S\n', pid: 23457 };
      } };
      if (name === 'node:fs') return fs;
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
  assert.equal(roleFixture.signalOwned(run.identity, 'SIGKILL'), true, 'fixture identity changed before manager-loss control');
  const result = await run.done;
  assert.equal(result.signal, 'SIGKILL');
  const actors = [queued.admission, queued.holderIdentity, queued.guardianIdentity];
  const drained = identity => roleFixture.identityGone(identity, roleFixture.captureIdentity(identity.pid));
  const cleanupDeadline = Date.now() + 15000;
  while (actors.some(identity => !drained(identity)) && Date.now() < cleanupDeadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(actors.every(drained), 'admission actors remained after manager cleanup');
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
      assert.equal(fs.existsSync(marker), false, 'the launcher must reject preloads before Node starts');
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


test('gate cleanup terminates a detached descendant before accepting a verdict', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const run = f.launch({ FIXTURE_ESCAPE_PIPE: '1', FIXTURE_RECREATE_SCRATCH: '1', APERTURE_GATE_TIME_LEFT_S: '20', APERTURE_GATE_SLOWEST_RUN_S: '5' });
  let escaped;
  try {
    const result = await run.done;
    escaped = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
    assert.equal(result.code, 98, result.output);
    assert.equal((result.output.match(/APERTURE-GATE-INDETERMINATE/g) || []).length, 1);
    assert.match(result.output, /reason=(?:interrupted|cleanup)/);
    assert.equal(roleFixture.identityGone(escaped.escapeIdentity, roleFixture.captureIdentity(escaped.escapePid)), true, 'the owned detached child is terminated');
    assert.equal(fs.existsSync(f.marker + '.escape-signalled'), true);
    assert.equal(fs.existsSync(escaped.scratch), false);
  } finally {
    if (!escaped && fs.existsSync(f.marker)) escaped = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
    if (escaped?.escapePid) {
      const current = roleFixture.captureIdentity(escaped.escapePid);
      if (!roleFixture.identityGone(escaped.escapeIdentity, current)) {
        if (!roleFixture.sameProcessIdentity(escaped.escapeIdentity, current)
            || !roleFixture.signalOwned(escaped.escapeIdentity, 'SIGTERM')) {
          throw new Error('escaped fixture cleanup is unresolved; custody retained at ' + f.scratch);
        }
        if (!await waitForIdentityGone(escaped.escapeIdentity, Date.now() + 8000)) {
          throw new Error('escaped fixture did not drain; custody retained at ' + f.scratch);
        }
      }
    }
  }
});

test('blocked manager output stays within its deadline and releases scratch', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const run = f.launch({
    FIXTURE_STDERR_BYTES: '4194304',
    APERTURE_GATE_TIME_LEFT_S: '8',
    APERTURE_GATE_SLOWEST_RUN_S: '1'
  });
  const timeoutMarker = new Promise(resolve => run.child.stdout.on('data', chunk => {
    if (chunk.toString().includes('APERTURE-GATE-INDETERMINATE reason=timeout')) resolve(true);
  }));
  run.child.stderr.pause();
  const markerArrivedBeforeDrain = await Promise.race([
    timeoutMarker,
    new Promise(resolve => setTimeout(() => resolve(false), 10000))
  ]);
  run.child.stderr.resume();
  const result = await run.done;
  assert.ok(markerArrivedBeforeDrain, 'timeout marker is emitted before stderr drains');
  const body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
  assert.equal(result.code, 98, result.output);
  assert.match(result.output, /APERTURE-GATE-INDETERMINATE reason=timeout/);
  assert.equal(fs.existsSync(body.scratch), false);
});

test('full gate preserves ignored test bytecode in its source premise', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const cacheDirectory = path.join(f.root, 'src', '__pycache__');
  fs.mkdirSync(cacheDirectory, { recursive: true });
  fs.writeFileSync(path.join(f.root, '.gitignore'), '__pycache__/\n');
  const cache = path.join(cacheDirectory, 'conductor_worker_proof.cpython-314.pyc');
  fs.writeFileSync(cache, 'cached module');
  const result = await f.launch().done;
  assert.equal(result.code, 0, result.output);
  assert.equal(fs.readFileSync(cache, 'utf8'), 'cached module');
});

test('ignored bytecode created during the body makes the source stale', { timeout: 180000 }, async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, '.gitignore'), '__pycache__/\n');
  const result = await f.launch({ FIXTURE_BYTECODE_CACHE_MUTATION: '1' }).done;
  assert.equal(result.code, 98, result.output);
  assert.match(result.output, /reason=stale/);
  assert.equal(fs.existsSync(path.join(f.root, 'src', '__pycache__', 'conductor_worker_proof.cpython-314.pyc')), true);
});

test('admitted test body revalidates its registered suite list', async () => {
  const { runBody } = require('../scripts/test-gate');
  assert.equal(await runBody([]), 4);
});

test('watchdog has one identity-checked escaped PID signal site and a bounded host scan interval', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(PROJECT, 'scripts/full-gate-watchdog.js'), 'utf8');
  const pidSignalSites = source.match(/process\.kill\(pid, signal\)/g) || [];
  const ownerStart = source.indexOf('function signalEscapedDescendants');
  const ownerEnd = source.indexOf('\nfunction hasLiveEscapedDescendants', ownerStart);
  const signalOwner = source.slice(ownerStart, ownerEnd);
  const identitySource = source.match(/function sameProcessIdentity[\s\S]*?\n}/)?.[0];
  const sameProcessIdentity = vm.runInNewContext(identitySource + '\nsameProcessIdentity');
  assert.equal(pidSignalSites.length, 1, 'new PID signal sites must go through the identity owner');
  assert.match(signalOwner, /sameProcessIdentity\(expected, identities\.get\(pid\)\)/);
  assert.equal(sameProcessIdentity('darwin:1791712345:100001:900001:7', 'darwin:1791712345:900002:900001:7'), false);
  assert.equal(sameProcessIdentity('darwin:1791712345:100001:900001:7', 'darwin:1791712345:100001:900002:7'), false);
  assert.equal(sameProcessIdentity('darwin:1791712345:100001:900001:7', 'darwin:1791712345:100001:900001:7'), true);
  assert.equal(sameProcessIdentity('linux:78123456', 'linux:78123456'), true);
  assert.match(source, /const PROCESS_MONITOR_INTERVAL_MS = 1000/);
  assert.match(source, /setInterval\(monitorDescendants, PROCESS_MONITOR_INTERVAL_MS\)/);
});

for (const { escape, mode } of [
  { escape: false, mode: 'read-only-scratch' }
]) {
    test(mode + ' preserves one no-verdict with escaped output ' + escape, { timeout: 180000 }, async t => {
      const f = fixture(t);
      const extra = { APERTURE_GATE_TIME_LEFT_S: '20', APERTURE_GATE_SLOWEST_RUN_S: '5' };
      if (escape) extra.FIXTURE_ESCAPE_PIPE = '1';
      extra.FIXTURE_READ_ONLY_SCRATCH = '1';
      let body;
      try {
        const result = await f.launch(extra).done;
        body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
        assert.equal(result.code, 98, result.output);
        assert.equal((result.output.match(/APERTURE-GATE-INDETERMINATE/g) || []).length, 1, result.output);
        if (mode === 'read-only-scratch') assert.match(result.output, /GATE_SCRATCH_CLEANUP_FAILED/);
        if (escape) {
          assert.equal(roleFixture.sameProcessIdentity(body.escapeIdentity, roleFixture.captureIdentity(body.escapePid)), true, 'a group signal does not target a detached child');
          assert.equal(fs.existsSync(f.marker + '.escape-signalled'), false);
        }
      } finally {
        if (!body && fs.existsSync(f.marker)) body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
        if (body?.escapePid) {
          const current = roleFixture.captureIdentity(body.escapePid);
          if (!roleFixture.identityGone(body.escapeIdentity, current)) {
            if (!roleFixture.sameProcessIdentity(body.escapeIdentity, current)
                || !roleFixture.signalOwned(body.escapeIdentity, 'SIGTERM')) {
              throw new Error('escaped fixture cleanup is unresolved; custody retained at ' + body.scratch);
            }
            if (!await waitForIdentityGone(body.escapeIdentity, Date.now() + 8000)) {
              throw new Error('escaped fixture did not drain; custody retained at ' + body.scratch);
            }
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


test('generated fixture entry expires imported and direct bodies independently', async t => {
  const vm = require('node:vm');
  const f = fixture(t);
  const entry = path.join(f.scratch, 'entry.js');
  const source = fs.readFileSync(entry, 'utf8');
  for (const scenario of [
    { name: 'imported hanging body', env: { FIXTURE_HANG: '1' } },
    { name: 'imported killed-worker body', env: { FIXTURE_KILL_WORKER: '1' } },
    { name: 'direct main', env: {}, direct: true }
  ]) {
    const timers = [];
    const events = [];
    const exits = [];
    const handlers = new Map();
    const actors = { manager: { pid: 12340 }, worker: { pid: 12341 }, guardian: { pid: 12342 }, extraHolders: [] };
    let clock = 0;
    const processFixture = {
      pid: 12345, ppid: 12344, platform: 'darwin',
      env: { ...scenario.env, FIXTURE_ROOT: 'root', FIXTURE_MARKER: 'body.json', FIXTURE_ROLE_FILE: 'roles.json', FIXTURE_WORKER_KILLED: 'worker.json' },
      on: (event, handler) => handlers.set(event, handler),
      stdout: { write: value => events.push(value) },
      exit: code => exits.push(code)
    };
    const moduleFixture = { exports: {} };
    const requireFixture = name => {
      if (name === 'node:fs') return {
        readFileSync: file => { assert.equal(file, 'roles.json'); return JSON.stringify(actors); },
        writeFileSync: () => events.push('body write')
      };
      if (name === ROLE_FIXTURE) return {
        captureIdentity: pid => ({ kind: 'present', pid }),
        signalOwned: (identity, signal) => {
          assert.ok([12340, 12341, 12342].includes(identity.pid));
          events.push(signal);
          return true;
        }
      };
      if (name === GATE) return { runFullGate: () => { events.push('direct main'); return Promise.resolve(0); } };
      throw new Error('unexpected fixture import ' + name);
    };
    requireFixture.main = scenario.direct ? moduleFixture : {};
    vm.runInNewContext(source, {
      Buffer, __filename: entry, module: moduleFixture, require: requireFixture, process: processFixture,
      setTimeout: (callback, delay) => {
        const timer = { callback, at: clock + delay, delay, unrefed: false, fired: false, unref() { this.unrefed = true; return this; } };
        timers.push(timer);
        events.push('deadline armed');
        return timer;
      },
      setInterval: () => 1
    }, { timeout: 1000 });
    assert.equal(timers.length, 1, scenario.name);
    assert.equal(timers[0].delay, 120000, scenario.name);
    assert.equal(timers[0].unrefed, true, scenario.name);
    assert.equal(events[0], 'deadline armed', scenario.name);
    if (!scenario.direct) {
      const body = moduleFixture.exports.runBody();
      if (scenario.env.FIXTURE_HANG) assert.ok(events.includes('BODY_READY\n'));
      else {
        assert.equal(await body, 0);
        assert.ok(events.includes('SIGKILL'));
        handlers.get('SIGTERM')();
      }
    } else assert.ok(events.includes('direct main'));
    const advance = milliseconds => {
      clock += milliseconds;
      for (const timer of timers) if (!timer.fired && timer.at <= clock) {
        timer.fired = true;
        timer.callback();
      }
    };
    advance(119999);
    assert.deepEqual(exits, [], scenario.name);
    advance(1);
    assert.deepEqual(exits, [98], scenario.name);
  }
});


const darwinDisappearingPidProgram = String.raw`import ast,errno,io,json,struct,sys,types
import signal as fixture_signal
from pathlib import Path
fixture_signal.signal(fixture_signal.SIGALRM,fixture_signal.SIG_DFL)
fixture_signal.alarm(25)
SOURCE=Path(sys.argv[1]).read_text(encoding='utf-8')
RUNNER_SOURCE=Path(sys.argv[2]).read_text(encoding='utf-8')
MODE=sys.argv[3]
OWNER_NAMES={'CapabilityError','CoalitionGone','process_identity','process_start','coalition_id','joined_identity','identity_if_present','same_process','task_counts','_coalition_members','_signal','signal_identity','_signal_members','_drained','drain'}
results=[]

class FakeArrayType:
    def __mul__(self, count):
        return lambda: [0] * count

class FakeClock:
    def __init__(self): self.value = 0
    def monotonic(self):
        self.value += 0.01
        assert self.value < 100, 'unexpected unbounded mock loop'
        return self.value
    def sleep(self, delay): self.value += max(0, delay)

class FakeCtypes:
    c_uint64 = FakeArrayType()
    c_uint32 = FakeArrayType()
    def __init__(self): self.error = 0
    def set_errno(self, value): self.error = value
    def get_errno(self): return self.error
    def create_string_buffer(self, size): return types.SimpleNamespace(raw=bytes(size))
    def byref(self, value): return value

def ident(pid=101, coalition=700, unique=900):
    return dict(pid=pid, unique_id=unique, pid_version=20, start_sec=1000, start_usec=7, coalition_id=coalition)

def gone(): return ProcessLookupError(errno.ESRCH, 'mock disappeared')

def throw(error): raise error

def raises(call, expected):
    try: call()
    except expected: return
    raise AssertionError('expected ' + expected.__name__)

def extract(source, names, namespace):
    tree = ast.parse(source)
    nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names]
    assert {node.name for node in nodes} == names
    assert all(not node.decorator_list for node in nodes)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), '<allowlisted declarations>', 'exec'), namespace)
    return namespace

def owner(source):
    fake_ctypes = FakeCtypes()
    namespace = dict(errno=errno, struct=struct, ctypes=fake_ctypes,
        os=types.SimpleNamespace(getpid=lambda:500, strerror=lambda value:'mock errno '+str(value), environ={}),
        subprocess=types.SimpleNamespace(run=lambda *args,**kwargs:throw(AssertionError('unconfigured fake enumeration'))),
        signal=types.SimpleNamespace(SIGTERM=15,SIGKILL=9),time=FakeClock(),
        IDENTITY_SIZE=56,COALITION_SIZE=40,BSD_INFO_SIZE=136,PROC_PIDUNIQIDENTIFIERINFO=17,PROC_PIDTBSDINFO=3,PROC_PIDCOALITIONINFO=20,
        BSD_PID_OFFSET=12,BSD_START_SECONDS_OFFSET=120,BSD_START_MICROSECONDS_OFFSET=128,RESOURCE_COALITION_INDEX=0,RESOURCE_USAGE_SIZE=512,POLL_SECONDS=.025,TERM_SECONDS=1)
    namespace['_apis']=lambda:throw(AssertionError('unconfigured fake API'))
    names=OWNER_NAMES if 'def identity_if_present(' in source else OWNER_NAMES-{'identity_if_present'}
    return extract(source,names,namespace)

def fake_lookup(namespace, responses):
    responses=list(responses)
    def lookup(pid):
        assert responses, 'unexpected identity observation'
        value=responses.pop(0)
        if isinstance(value,BaseException):raise value
        return value
    namespace['joined_identity']=lookup

def fake_enum(namespace, pids):
    calls=[]
    def run(argv,**kwargs):
        calls.append((argv,kwargs))
        assert argv==['ps','-A','-o','pid='] and kwargs['timeout']>0
        return types.SimpleNamespace(returncode=0,stdout=' '.join(map(str,pids)))
    namespace['subprocess']=types.SimpleNamespace(run=run)
    return calls

def fake_signal_api(namespace, result):
    calls=[]
    def send(token,number):calls.append((list(token),number));return result
    namespace['_apis']=lambda:(None,None,send)
    return calls

def low_level(name, api_result, api_errno, expected):
    namespace=owner(SOURCE)
    def pidinfo(*args):
        assert namespace['ctypes'].get_errno()==0
        namespace['ctypes'].set_errno(api_errno)
        return api_result
    namespace['_apis']=lambda:(pidinfo,None,None)
    raises(lambda:namespace[name](101),namespace[expected] if isinstance(expected,str) else expected)

def inventory(source, runner):
    sites=[]
    for prefix,body in [('owner',source),('runner',runner)]:
        for fn in ast.parse(body).body:
            if not isinstance(fn,ast.FunctionDef):continue
            for node in ast.walk(fn):
                if not isinstance(node,ast.Call):continue
                name=node.func.id if isinstance(node.func,ast.Name) else node.func.attr if isinstance(node.func,ast.Attribute) else None
                if name in {'joined_identity','identity_if_present'}:sites.append((prefix,fn.name,name))
    expected=sorted([('owner','identity_if_present','joined_identity'),('owner','_coalition_members','identity_if_present'),('owner','_signal','identity_if_present'),('owner','_signal','identity_if_present'),('owner','_drained','identity_if_present'),('runner','controller_alive','identity_if_present'),('runner','run','joined_identity')])
    assert sorted(sites)==expected, sites

def case(name,call):
    try:call();results.append({'case':name,'pass':True})
    except BaseException as error:results.append({'case':name,'pass':False,'errorType':type(error).__name__,'error':str(error)[:300]})

def helper_unknown():
    namespace=owner(SOURCE);fake_lookup(namespace,[namespace['CapabilityError']('unknown')]);raises(lambda:namespace['identity_if_present'](101),namespace['CapabilityError'])

def helper_other_errno():
    namespace=owner(SOURCE);fake_lookup(namespace,[ProcessLookupError(errno.EPERM,'not ESRCH')]);raises(lambda:namespace['identity_if_present'](101),ProcessLookupError)

def signal_case(responses,result,expected,expected_calls,expect_error=False):
    namespace=owner(SOURCE);fake_lookup(namespace,responses);calls=fake_signal_api(namespace,result)
    if expect_error:raises(lambda:namespace['_signal'](ident(),15),namespace['CapabilityError'])
    else:assert namespace['_signal'](ident(),15) is expected
    assert len(calls)==expected_calls
    if calls:assert calls[0][0][5]==101 and calls[0][0][7]==20 and calls[0][1]==15

def signal_unknown():
    namespace=owner(SOURCE);fake_lookup(namespace,[namespace['CapabilityError']('unknown')]);calls=fake_signal_api(namespace,0);raises(lambda:namespace['_signal'](ident(),15),namespace['CapabilityError']);assert calls==[]

def drained_case(identity,counts,expected,preserve=True):
    namespace=owner(SOURCE);namespace['task_counts']=lambda coalition:counts
    if identity=='unknown':identity=namespace['CapabilityError']('unknown')
    fake_lookup(namespace,[identity]);assert namespace['_drained'](700,ident() if preserve else None,False) is expected

def reaped_case(allowed):
    namespace=owner(SOURCE);namespace['task_counts']=lambda coalition:throw(namespace['CoalitionGone']('mock reaped'))
    if allowed:assert namespace['_drained'](700,None,True) is True
    else:raises(lambda:namespace['_drained'](700,None,False),namespace['CoalitionGone'])

if MODE=='inventory':
    inventory(SOURCE,RUNNER_SOURCE)
    raises(lambda:inventory(SOURCE+'\ndef unclassified_new_consumer(pid):\n    return joined_identity(pid)\n',RUNNER_SOURCE),AssertionError)
    print('DARWIN_SOURCE_MOCK_RESULT='+json.dumps({'mode':MODE,'inventoryAccepted':True,'addedObserverRejected':True}))
    raise SystemExit(0)
assert MODE=='behavior'
namespace=owner(SOURCE);member=ident(102)
fake_enum(namespace,[101,102]);fake_lookup(namespace,[gone(),member])
try:
    observed=namespace['_coalition_members'](700,1)
except ProcessLookupError as error:
    observed={'escapedException':type(error).__name__,'errno':error.errno}
assert observed==[member], 'DARWIN_ENUMERATION_LOST_LATER_MEMBER: '+repr(observed)
results.append({'case':'enumeration preserves later owned member after ESRCH','pass':True})
def unknown_enumeration():
    namespace=owner(SOURCE);member=ident(102)
    fake_enum(namespace,[101,102]);fake_lookup(namespace,[namespace['CapabilityError']('unknown'),member])
    assert namespace['_coalition_members'](700,1)==[member]
case('unknown enumeration does not hide a later proved member',unknown_enumeration)
for name in ['process_identity','process_start','coalition_id']:
    case(name+' exact ESRCH',lambda name=name:low_level(name,0,errno.ESRCH,ProcessLookupError))
    case(name+' permission remains unknown',lambda name=name:low_level(name,0,errno.EPERM,'CapabilityError'))
    case(name+' short result remains unknown',lambda name=name:low_level(name,1,errno.ESRCH,'CapabilityError'))
case('coalition minus-one ESRCH',lambda:low_level('coalition_id',-1,errno.ESRCH,ProcessLookupError))
case('central classifier preserves capability error',helper_unknown)
case('central classifier rejects non-ESRCH lookup error',helper_other_errno)
case('pre-signal ESRCH sends nothing',lambda:signal_case([gone()],0,False,0))
case('reused PID sends nothing',lambda:signal_case([ident(unique=901)],0,False,0))
case('failed audited signal then ESRCH is false',lambda:signal_case([ident(),gone()],1,False,1))
case('failed audited signal with same identity remains error',lambda:signal_case([ident(),ident()],1,None,1,True))
case('successful signal uses audited PID-version token',lambda:signal_case([ident()],0,True,1))
case('unknown pre-signal identity sends nothing',signal_unknown)
case('gone preserve and active1 is not drained',lambda:drained_case(gone(),(1,0),False))
case('unknown preserve and active1 is not drained',lambda:drained_case('unknown',(1,0),False))
case('reused preserve and active1 is not drained',lambda:drained_case(ident(unique=901),(1,0),False))
case('exact preserve and active1 is drained',lambda:drained_case(ident(),(1,0),True))
case('active0 is drained',lambda:drained_case(None,(2,2),True,False))
case('active1 without preserve is not drained',lambda:drained_case(None,(1,0),False,False))
case('active2 is not drained',lambda:drained_case(None,(2,0),False,False))
case('authenticated reaping is accepted',lambda:reaped_case(True))
case('unverified reaping is not accepted',lambda:reaped_case(False))
def counters(values,result=0,error=0,expected=None):
    namespace=owner(SOURCE)
    def usage(resource,buffer,size):
        assert resource==700 and size==512
        namespace['ctypes'].set_errno(error)
        buffer.raw=struct.pack('=QQ',*values)+bytes(496)
        return result
    namespace['_apis']=lambda:(None,usage,None)
    if expected:raises(lambda:namespace['task_counts'](700),namespace[expected])
    else:assert namespace['task_counts'](700)==values
case('trusted counters preserve started and exited',lambda:counters((3,2)))
case('inconsistent counters are unknown',lambda:counters((1,2),expected='CapabilityError'))
case('counter ESRCH is coalition reaping',lambda:counters((0,0),-1,errno.ESRCH,'CoalitionGone'))
case('counter permission error is unknown',lambda:counters((0,0),-1,errno.EPERM,'CapabilityError'))
case('counter short result is unknown',lambda:counters((0,0),1,errno.ESRCH,'CapabilityError'))
def guardian(scenario):
    namespace=owner(SOURCE);states=[];spawns=[];drains=[];clock=FakeClock()
    controller=ident(301,300);guardian=ident(401,400)
    before=scenario in ['before-gone','before-unknown']
    response=namespace['CapabilityError']('unknown') if scenario=='before-unknown' else gone()
    fake_lookup(namespace,[guardian,response] if before else [guardian,controller,gone()])
    owner_api=types.SimpleNamespace(**{key:value for key,value in namespace.items() if key in ['joined_identity','identity_if_present','same_process','CapabilityError']})
    def drain(resource,deadline,preserve):
        drains.append((resource,deadline,preserve))
        assert resource==400 and deadline==10 and preserve==guardian
        if scenario=='drain-gone':raise gone()
        return scenario=='drain-true'
    owner_api.drain=drain
    spec={'state_path':'state','deadline':10,'run_deadline':5,'controller':controller,'ack_path':'ack','launch_token':'token','environment':{},'command':['fake-child'],'cwd':'fake-root'}
    def fake_open(path,*args,**kwargs):
        assert path in ['spec','ack']
        return io.StringIO(json.dumps(spec) if path=='spec' else 'token\n')
    polls=[]
    def popen(*args,**kwargs):
        spawns.append((args,kwargs))
        assert args==(['fake-child'],) and kwargs['start_new_session'] is False
        def poll():
            polls.append(None);assert len(polls)<=10,'unbounded fake guardian polling'
            return None
        return types.SimpleNamespace(pid=402,poll=poll)
    target=dict(json=json,open=fake_open,time=clock,os=types.SimpleNamespace(getpid=lambda:401),interrupted=False,receive_signal=lambda *args:None,
        signal=types.SimpleNamespace(SIGINT=2,SIGTERM=15,SIGHUP=1,signal=lambda *args:None),subprocess=types.SimpleNamespace(Popen=popen),
        write_state=lambda path,value:states.append(dict(value)),DARWIN=owner_api)
    extract(RUNNER_SOURCE,{'controller_alive','run'},target)
    assert target['run']('spec')==98
    if before:
        assert len(spawns)==0 and drains==[]
        assert states[-1]['state']=='interrupted' and states[-1]['reason']=='guardian-lost-before-dispatch'
    else:
        assert len(spawns)==1 and len(drains)==1 and len(states)==3
        assert states[-1]['reason']=='guardian-lost'
        assert states[-1]['state']==('interrupted' if scenario=='drain-true' else 'cleanup-failed')
case('controller gone prevents dispatch',lambda:guardian('before-gone'))
case('controller unknown prevents dispatch',lambda:guardian('before-unknown'))
case('guardian drain ESRCH records cleanup-failed98',lambda:guardian('drain-gone'))
case('guardian false drain stays cleanup-failed98',lambda:guardian('drain-false'))
case('guardian proved drain remains interrupted98',lambda:guardian('drain-true'))
def finite_deadline():
    namespace=owner(SOURCE);signals=[]
    namespace['task_counts']=lambda resource:(2,0)
    def signal_members(resource,number,deadline,excluded):
        signals.append(number)
        assert len(signals)<=100 and resource==700 and deadline==1.2 and excluded==(101,)
    namespace['_signal_members']=signal_members
    assert namespace['drain'](700,1.2,preserve=ident()) is False
    assert 15 in signals and 9 in signals
case('unchanged finite deadline escalates without accepting positive counts',finite_deadline)
print('DARWIN_SOURCE_MOCK_RESULT='+json.dumps({'mode':MODE,'results':results,'failed':sum(not row['pass'] for row in results),'nativeQueries':0,'realProcessStarts':0,'sourceFilesRead':2,'realStateFileWrites':0,'hostCausalityProved':False}))
raise SystemExit(0 if all(row['pass'] for row in results) else 1)
`;

function runDarwinDisappearingPidMock(mode) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name === 'NODE_OPTIONS' || name === 'NODE_PATH' || /(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY)$/.test(name)) delete env[name];
  }
  return spawnSync(process.env.DISCORD_SURFACE_PYTHON || 'python3', ['-I', '-c', darwinDisappearingPidProgram,
    path.join(PROJECT, 'scripts/full-gate/darwin.py'),
    path.join(PROJECT, 'scripts/full-gate/darwin-runner.py'), mode
  ], { cwd: PROJECT, env, encoding: 'utf8', timeout: 30000 });
}

test('Darwin disappearing PID behavior keeps cleanup bounded and unknown ownership closed', { timeout: 40000 }, () => {
  const result = runDarwinDisappearingPidMock('behavior');
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  const line = result.stdout.split('\n').find(value => value.startsWith('DARWIN_SOURCE_MOCK_RESULT='));
  assert.ok(line, result.stdout);
  const report = JSON.parse(line.slice('DARWIN_SOURCE_MOCK_RESULT='.length));
  assert.equal(report.failed, 0);
  assert.equal(report.hostCausalityProved, false);
});

test('Darwin disappearing PID observer inventory rejects unclassified sites', { timeout: 40000 }, () => {
  const result = runDarwinDisappearingPidMock('inventory');
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  const line = result.stdout.split('\n').find(value => value.startsWith('DARWIN_SOURCE_MOCK_RESULT='));
  assert.ok(line, result.stdout);
  const report = JSON.parse(line.slice('DARWIN_SOURCE_MOCK_RESULT='.length));
  assert.equal(report.inventoryAccepted, true);
  assert.equal(report.addedObserverRejected, true);
});


test('source-import fixtures disable bytecode at every named Python boundary', () => {
  const entrySource = fs.readFileSync(__filename, 'utf8');
  const identitySource = fs.readFileSync(ROLE_FIXTURE, 'utf8');
  const importMarker = 'spec.loader.' + 'exec_module(';
  const importTests = [
    'Darwin cleanup retains a bootstrapped service when readiness identity is missing',
    'Python supervisor verdict uses the channel separate from saturated stderr',
    'supervisor fails closed before the body on an unsupported platform'
  ];
  const verify = (entry, identity) => {
    assert.equal(entry.split(importMarker).length - 1, 3, 'unclassified supervisor source import');
    for (const name of importTests) {
      const begin = entry.indexOf("test('" + name + "',");
      assert.ok(begin >= 0, name);
      const next = entry.indexOf('\ntest(', begin + 1);
      const body = entry.slice(begin, next < 0 ? undefined : next);
      assert.equal(body.split(importMarker).length - 1, 1, name);
      assert.match(body, /spawn(?:Sync)?\('python3', \[\s*'-I', '-B', '-c', script, SUPERVISOR_SCRIPT/);
    }
    assert.equal(identity.split(importMarker).length - 1, 2, 'unclassified identity source import');
    assert.match(identity, /spawn\('python3', \['-I', '-B', '-c', program, DARWIN_OWNER,/);
  };
  verify(entrySource, identitySource);
  assert.throws(() => verify(entrySource + '\n' + importMarker + 'module)\n', identitySource));
  assert.throws(() => verify(entrySource, identitySource + '\n' + importMarker + 'owner)\n'));
  const withoutSupervisorFlag = entrySource.replace("['-I', '-B', '-c', script", "['-I', '-c', script");
  assert.notEqual(withoutSupervisorFlag, entrySource);
  assert.throws(() => verify(withoutSupervisorFlag, identitySource));
  const withoutIdentityFlag = identitySource.replace("['-I', '-B', '-c', program", "['-I', '-c', program");
  assert.notEqual(withoutIdentityFlag, identitySource);
  assert.throws(() => verify(entrySource, withoutIdentityFlag));
});
