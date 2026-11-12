'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const { PassThrough } = require('node:stream');
const { relay, revision, noVerdict, MESSAGES, NO_VERDICT, SUPERVISOR } = require('../scripts/full-gate');
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
    "  const args=process.argv.slice(2);const holders=[];for(let i=0;i<args.length-1;i++)if(args[i]==='--holder'){const pid=Number(args[++i]);if(!holders.includes(pid))holders.push(pid);}",
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
    "  const startEscapePipe = () => {",
    "    const cp=require('node:child_process');const marker=process.env.FIXTURE_MARKER+'.escape-signalled';",
    "    const legacyProgram=\"const fs=require('node:fs');const path=require('node:path');process.on('SIGTERM',()=>{fs.writeFileSync(process.env.FIXTURE_MARKER+'.escape-signalled','terminated');if(process.env.FIXTURE_RECREATE_SCRATCH){const scratch=process.env.DISCORD_SURFACE_GATE_SCRATCH;setInterval(()=>{fs.mkdirSync(scratch,{recursive:true});fs.writeFileSync(path.join(scratch,'writer'),'active');},5);}else process.exit(0);});setTimeout(()=>process.exit(0),90000);\";",
    "    const boundedProgram=\"const fs=require('node:fs');const path=require('node:path');const armed=process.env.FIXTURE_ESCAPE_ARMED;const release=process.env.FIXTURE_ESCAPE_RELEASE;const started=process.env.FIXTURE_ESCAPE_STARTED;const done=process.env.FIXTURE_ESCAPE_DONE;const removed=process.env.FIXTURE_SCRATCH_REMOVED;const scratch=process.env.DISCORD_SURFACE_GATE_SCRATCH;const absoluteEnd=Date.now()+12000;let observer;let ready;let finished=false;const stop=(reason,code)=>{if(finished)return;finished=true;clearInterval(observer);clearInterval(ready);fs.writeFileSync(done,reason);process.exit(code);};const observe=()=>{if(!fs.existsSync(scratch)){try{fs.writeFileSync(removed,'removed',{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}}fs.mkdirSync(scratch,{recursive:true});fs.writeFileSync(path.join(scratch,'writer'),'active');};const start=()=>{if(observer||finished)return;fs.writeFileSync(started,'started');observe();observer=setInterval(observe,5);};fs.writeFileSync(armed,'armed');ready=setInterval(()=>{if(fs.existsSync(release)){clearInterval(ready);start();}else if(Date.now()>=absoluteEnd)stop('reason=hard-timeout',9);},5);process.on('SIGTERM',()=>{if(finished)return;observe();stop('reason=supervisor-stop',0);});setTimeout(()=>stop('reason=hard-timeout',9),12000);\";",
    "    const program=process.env.FIXTURE_ESCAPE_READY ? boundedProgram : legacyProgram;",
    "    const escape=cp.spawn(process.execPath,['-e',program],{detached:true,stdio:'inherit'});escape.unref();",
    "    if (process.env.FIXTURE_ESCAPE_READY) { const until=Date.now()+10000;while(!fs.existsSync(process.env.FIXTURE_ESCAPE_ARMED)&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);if(!fs.existsSync(process.env.FIXTURE_ESCAPE_ARMED))throw new Error('escaped child did not arm'); }",
    "    const info=JSON.parse(fs.readFileSync(process.env.FIXTURE_MARKER,'utf8'));const escapeIdentity=roles.captureIdentity(escape.pid);if(escapeIdentity.kind!=='present')throw new Error('escaped child identity could not be established');info.escapePid=escape.pid;info.escapeIdentity=escapeIdentity;fs.writeFileSync(process.env.FIXTURE_MARKER+'.part',JSON.stringify(info));fs.renameSync(process.env.FIXTURE_MARKER+'.part',process.env.FIXTURE_MARKER);",
    "  };",
    "  if (process.env.FIXTURE_ESCAPE_PIPE && process.env.FIXTURE_ESCAPE_READY) startEscapePipe();",
    "  if (process.env.FIXTURE_KILL_GUARD) { const actors=JSON.parse(fs.readFileSync(process.env.FIXTURE_ROLE_FILE,'utf8'));const body=roles.captureIdentity(process.pid);if(body.kind!=='present')throw new Error('body identity could not be established');const custody={state:'prepared',guardian:actors.guardian,body};fs.writeFileSync(process.env.FIXTURE_MARKER+'.guard-custody',JSON.stringify(custody));if(!process.env.FIXTURE_ESCAPE_READY){if(!roles.signalOwned(actors.guardian,'SIGKILL'))throw new Error('guardian identity changed before termination');custody.state='signaled';fs.writeFileSync(process.env.FIXTURE_MARKER+'.guard-custody',JSON.stringify(custody));if(process.env.FIXTURE_ESCAPE_KILLED)fs.writeFileSync(process.env.FIXTURE_ESCAPE_KILLED,'guardian-signalled');if(process.env.FIXTURE_MONITOR_BARRIER)fs.writeFileSync(process.env.FIXTURE_MONITOR_BARRIER,'guardian-signalled');} }",
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
    "  if (process.env.FIXTURE_STDERR_BYTES) {",
    "    const bytes = Number(process.env.FIXTURE_STDERR_BYTES);",
    "    const accepted = process.stderr.write('x'.repeat(bytes));",
    "    if (process.env.FIXTURE_NO_STDERR_DRAIN) fs.writeFileSync(process.env.FIXTURE_MARKER + '.stderr-pressure', JSON.stringify({ bytes, backpressured: !accepted }));",
    "  }",
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
    "  if (process.env.FIXTURE_ESCAPE_PIPE && !process.env.FIXTURE_ESCAPE_READY) startEscapePipe();",
    "  if (process.env.FIXTURE_READ_ONLY_SCRATCH) { const ro=require('node:path').join(process.env.DISCORD_SURFACE_GATE_SCRATCH,'ro');fs.mkdirSync(ro);fs.writeFileSync(require('node:path').join(ro,'f'),'x');fs.chmodSync(ro,0o500); }",
    "  if (process.env.FIXTURE_LEFTOVER) require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),15000)'], { stdio: 'ignore' }).unref();",
    "  if (process.env.FIXTURE_HANG) { process.on('SIGTERM', () => { if (process.env.FIXTURE_RECREATE_SCRATCH && !process.env.FIXTURE_ESCAPE_READY) { const scratch=process.env.DISCORD_SURFACE_GATE_SCRATCH;setInterval(()=>{fs.mkdirSync(scratch,{recursive:true});fs.writeFileSync(require('node:path').join(scratch,'writer'),'active');},5); } }); setInterval(() => {}, 1000); process.stdout.write('BODY_READY\\n'); return new Promise(() => {}); }",
    "  return Number(process.env.FIXTURE_BODY_EXIT || 0);",
    "}",
    "setTimeout(() => process.exit(98), 120000).unref();",
    "module.exports = { runBody };",
    "if (require.main === module) {",
    "  runFullGate(process.env.FIXTURE_ROOT, 'fixture', __filename, []).then(code => { process.exitCode = code; });",
    "}"
  ].join('\n'));
  const processes = [];
  const boundedCustodies = [];
  t.after(async () => {
    const unresolved = [];
    const identities = new Map();
    const retainedGateScratch = new Set();
    const writerIdentities = [];
    const recordBoundedCustody = value => {
      if (!boundedCustodies.length) return;
      if (!value || typeof value !== 'object') {
        unresolved.push('bounded-custody-missing');
        return;
      }
      const gateScratch = value.scratch;
      const normalizedScratch = typeof gateScratch === 'string' ? path.normalize(gateScratch) : '';
      const resolvedScratch = typeof gateScratch === 'string' ? path.resolve(gateScratch) : '';
      const validScratch = typeof gateScratch === 'string'
        && gateScratch.length > 0
        && path.isAbsolute(gateScratch)
        && normalizedScratch === gateScratch
        && path.dirname(resolvedScratch) === path.resolve(os.tmpdir())
        && /^discord-gate-/.test(path.basename(resolvedScratch))
        && resolvedScratch !== path.resolve(scratch);
      if (!validScratch) unresolved.push('bounded-custody-scratch');
      else retainedGateScratch.add(resolvedScratch);
      const writer = value.escapeIdentity;
      if (!writer || writer.kind !== 'present' || !Number.isSafeInteger(writer.pid)
          || !Number.isSafeInteger(value.escapePid) || writer.pid !== value.escapePid) {
        unresolved.push('bounded-custody-unknown-writer');
      } else writerIdentities.push(writer);
      for (const selected of boundedCustodies) {
        for (const [name, file] of [
          ['armed', selected.armed], ['release', selected.release], ['killed', selected.killed],
          ['barrier', selected.barrier], ['started', selected.started], ['done', selected.done]
        ]) {
          if (typeof file !== 'string' || !fs.existsSync(file)) unresolved.push('bounded-custody-' + name);
        }
        if (typeof selected.done === 'string' && fs.existsSync(selected.done)) {
          try {
            if (fs.readFileSync(selected.done, 'utf8') !== 'reason=supervisor-stop') unresolved.push('bounded-custody-expired');
          } catch { unresolved.push('bounded-custody-done-read'); }
        }
      }
    };
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
      try {
        const custody = JSON.parse(fs.readFileSync(custodyPath, 'utf8'));
        if (custodyPath === marker) recordBoundedCustody(custody);
        remember(custody);
      } catch { unresolved.push('unreadable-custody:' + path.basename(custodyPath)); }
    }
    if (boundedCustodies.length && !fs.existsSync(marker)) unresolved.push('bounded-custody-missing-marker');
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
    for (const identity of writerIdentities) {
      if (!roleFixture.identityGone(identity, roleFixture.captureIdentity(identity.pid))) {
        unresolved.push('writer-drain:' + identity.pid);
      }
    }
    if (!unresolved.length) {
      const owner = typeof process.getuid === 'function' ? process.getuid() : null;
      for (const retained of retainedGateScratch) {
        if (retained === path.resolve(scratch)) continue;
        try {
          const retainedStat = fs.lstatSync(retained);
          if (owner === null || retainedStat.isSymbolicLink() || !retainedStat.isDirectory()
              || retainedStat.uid !== owner) {
            unresolved.push('retained-gate-scratch-identity:' + retained);
            continue;
          }
          fs.rmSync(retained, { recursive: true, force: true });
        } catch { unresolved.push('retained-gate-scratch-remove:' + retained); }
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
    if (extra.FIXTURE_ESCAPE_READY && extra.FIXTURE_KILL_GUARD
        && extra.FIXTURE_RECREATE_SCRATCH && extra.FIXTURE_HANG) {
      boundedCustodies.push({
        armed: extra.FIXTURE_ESCAPE_ARMED,
        release: extra.FIXTURE_ESCAPE_RELEASE,
        killed: extra.FIXTURE_ESCAPE_KILLED,
        barrier: extra.FIXTURE_MONITOR_BARRIER,
        started: extra.FIXTURE_ESCAPE_STARTED,
        done: extra.FIXTURE_ESCAPE_DONE,
        deletion: extra.FIXTURE_SCRATCH_REMOVED
      });
    }
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
      ...(supervised ? { cwd: root } : {}),
      stdio: ['ignore', 'pipe', 'pipe', ...(!supervised && extra.FIXTURE_IPC ? ['ipc'] : [])]
    };
    const command = supervised ? 'python3' : process.execPath;
    const args = supervised
      ? ['-I', extra.FIXTURE_SUPERVISOR_SCRIPT || SUPERVISOR_SCRIPT, '--', process.execPath, entry]
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
    const streams = extra.FIXTURE_NO_STDERR_DRAIN
      ? { stdout: '', stderr: '', stdoutClosed: false, stderrClosed: false, stderrHeldUntilExit: false, stderrRelease: null }
      : null;
    for (const name of ['stdout', 'stderr']) {
      const stream = child[name];
      const collect = chunk => {
        const text = chunk.toString();
        output += text;
        if (streams) streams[name] += text;
        if (output.includes('BODY_READY\n') || output.includes('ADMISSION_READY\n')) resolveReady();
      };
      if (streams) stream.once('close', () => { streams[name + 'Closed'] = true; });
      if (streams && name === 'stderr') {
        const release = reason => {
          if (streams.stderrRelease) return;
          streams.stderrRelease = reason;
          streams.stderrHeldUntilExit = reason === 'exit' && stream.readableFlowing !== true && stream.listenerCount('data') === 0;
          stream.on('data', collect);
          t.signal.removeEventListener('abort', onAbort);
        };
        const onAbort = () => release('test-abort');
        child.once('exit', () => release('exit'));
        child.once('error', () => release('child-error'));
        if (t.signal.aborted) onAbort();
        else t.signal.addEventListener('abort', onAbort, { once: true });
      } else {
        stream.on('data', collect);
      }
    }
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      if (extra.FIXTURE_IPC) {
        child.once('exit', (code, signal) => setImmediate(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          resolve({ code, signal, output });
        }));
      } else child.once('close', (code, signal) => {
        resolve({ code, signal, output, ...(streams ? { streams } : {}) });
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
    return /proc_pidinfo|readProcessIdentities|pidfd_open|signal_identity|['"]\/proc\/['"]/.test(source);
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
    "import importlib.util, json, sys, time",
    "spec=importlib.util.spec_from_file_location(\"full_gate_supervisor\",sys.argv[1])",
    "module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)",
    "reads=[];bootouts=[]",
    "class Owner:",
    "    CapabilityError=OSError",
    "fixture_owner=Owner()",
    "def read_state(path,owner,token,identity=None):",
    "    assert path==sys.argv[2] and owner is fixture_owner and token==\"fixture-run\" and identity is None",
    "    reads.append(path)",
    "    return None",
    "def bootout(*args):",
    "    bootouts.append(args)",
    "    return True",
    "module._read_job_state=read_state",
    "module._bootout=bootout",
    "result=module._darwin_cleanup(fixture_owner,\"launchctl\",\"gui/501/com.discordsurface.fullgate.fixture\",None,module.clock_now()+1,sys.argv[2],False,token=\"fixture-run\",sequence=0)",
    "assert result is False and reads and not bootouts",
    "print(json.dumps({\"retained\":result is False,\"reads\":len(reads),\"bootouts\":len(bootouts)}))",
  ].join('\n');
  const result = spawnSync('python3', ['-I', '-B', '-c', script, SUPERVISOR_SCRIPT, path.join(os.tmpdir(), 'missing-gate-state.json')], {
    encoding: 'utf8', timeout: 5000
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.retained, true);
  assert.ok(report.reads > 0, 'missing-readiness state reader was never reached');
  assert.equal(report.bootouts, 0);
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

test('Darwin final stdout relay preserves evidence and the source snapshot reserve', { timeout: 45000 }, () => {
  const script = [
    "import ast, copy, io, json, sys",
    "from pathlib import Path",
    "from types import SimpleNamespace",
    "tree = ast.parse(Path(sys.argv[1]).read_text(encoding=\"utf-8\"))",
    "relay = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == \"_stream_stdout\")",
    "writer = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == \"_write_job_output\")",
    "error_classes = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name in {\"SnapshotCleanupError\", \"InvalidGateBudget\", \"JobRequestCancelled\"}]",
    "assert len(error_classes) == 3 and {n.name for n in error_classes} == {\"SnapshotCleanupError\", \"InvalidGateBudget\", \"JobRequestCancelled\"}",
    "error_types = {}",
    "exec(compile(ast.Module(body=error_classes, type_ignores=[]), \"<relay-error-type>\", \"exec\"), error_types)",
    "darwin = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == \"run_darwin_supervised\")",
    "flushes = [n for n in ast.walk(darwin) if isinstance(n, ast.While) and any(",
    "    isinstance(a, ast.Assign) and isinstance(a.value, ast.Call) and isinstance(a.value.func, ast.Name)",
    "    and a.value.func.id == \"_stream_stdout\" and any(isinstance(t, ast.Name) and t.id == \"next_offset\" for t in a.targets)",
    "    for a in ast.walk(n))]",
    "assert len(flushes) == 2",
    "assert len([n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == \"_stream_stdout\"]) == 3",
    "outer = next(n for n in darwin.body if isinstance(n, ast.Try) and flushes[0] in n.body)",
    "final_body = outer.body[outer.body.index(flushes[0])-1:]",
    "assert isinstance(final_body[0],ast.Assign) and ast.unparse(final_body[0])==\"output_cursor[\\'retain_output\\'] = True\"",
    "assert isinstance(final_body[-1], ast.Return) and isinstance(final_body[-1].value, ast.IfExp)",
    "assert isinstance(final_body[-1].value.test, ast.Name) and final_body[-1].value.test.id == \"reason\"",
    "reserve = next(n.value.value for n in tree.body if isinstance(n, ast.Assign)",
    "               and any(isinstance(t, ast.Name) and t.id == \"CLEANUP_RESERVE_SECONDS\" for t in n.targets))",
    "poll = next(n.value.value for n in tree.body if isinstance(n, ast.Assign)",
    "            and any(isinstance(t, ast.Name) and t.id == \"POLL_SECONDS\" for t in n.targets))",
    "class Handle(io.BytesIO):",
    "    def __init__(self, owner):",
    "        super().__init__(owner.data)",
    "        self.owner = owner",
    "    def read(self, size=-1):",
    "        self.owner.reads += 1",
    "        assert self.owner.reads <= 8 and 0 < size <= 65536",
    "        if self.owner.read_error:",
    "            raise OSError(\"inert read failure\")",
    "        return super().read(size)",
    "class Fixture:",
    "    def __init__(self, data=b\"abcdefgh\", before=False, action=None, now=0, persistent=False, body_code=0):",
    "        self.data, self.mode, self.action, self.now = data, before, action, now",
    "        self.persistent, self.body_code = persistent, body_code",
    "        self.reads, self.writes, self.checks, self.snapshots, self.removals = 0, 0, 0, 0, 0",
    "        self.missing = self.read_error = self.interrupted = self.emitted = self.invalid_budget = False",
    "        self.accepted, self.sleeps, self.verdicts = bytearray(), [], []",
    "    def open(self, name, mode):",
    "        assert name == \"memory\" and mode == \"rb\"",
    "        if self.missing:",
    "            raise FileNotFoundError(\"inert missing output\")",
    "        return Handle(self)",
    "    def stat(self, name):",
    "        assert name == \"memory\"",
    "        if self.missing:",
    "            raise FileNotFoundError(\"inert missing output\")",
    "        return SimpleNamespace(st_size=len(self.data))",
    "    def get_blocking(self, fd):",
    "        assert fd == 73",
    "        return self.mode",
    "    def set_blocking(self, fd, value):",
    "        assert fd == 73",
    "        self.mode = value",
    "    def write(self, fd, data):",
    "        assert fd == 73 and self.mode is False",
    "        self.writes += 1",
    "        assert self.writes <= 8",
    "        self.now += 1",
    "        action = self.action",
    "        if not self.persistent:",
    "            self.action = None",
    "        if action == \"again\":",
    "            raise BlockingIOError(\"inert backpressure\")",
    "        if action == \"closed\":",
    "            raise BrokenPipeError(\"inert closed consumer\")",
    "        if action == \"interrupt\":",
    "            self.interrupted = True",
    "        count = min(3, len(data)) if action in (\"partial\", \"interrupt\") else len(data)",
    "        self.accepted.extend(data[:count])",
    "        return count",
    "    def monotonic(self):",
    "        self.checks += 1",
    "        assert self.checks <= 8",
    "        return self.now",
    "    def sleep(self, seconds):",
    "        assert 0 <= seconds <= poll",
    "        self.sleeps.append(seconds)",
    "    def snapshot(self, root, environment, phase, deadline, interrupted, *, stop_deadline):",
    "        assert str(root) == \"root\" and environment == {} and phase == \"after\"",
    "        assert deadline == stop_deadline == 100 and interrupted.is_set() == self.interrupted",
    "        self.snapshots += 1",
    "        if self.invalid_budget:",
    "            raise error_types[\"InvalidGateBudget\"](\"inert invalid budget\")",
    "        if self.interrupted:",
    "            raise InterruptedError(\"inert interrupted snapshot\")",
    "        if self.now >= 100:",
    "            raise TimeoutError(\"inert expired snapshot\")",
    "        return {\"snapshot\": \"fixed\"}",
    "    def no_verdict(self, reason, detail, **kwargs):",
    "        self.verdicts.append((reason, detail))",
    "        return 98",
    "    def emit(self, *args):",
    "        self.emitted = args[3]",
    "        return True",
    "    def remove(self, scratch, ignore_errors):",
    "        assert scratch == \"private\" and ignore_errors is True",
    "        self.removals += 1",
    "def context(fixture):",
    "    env = {\"__builtins__\": {\"len\": len, \"str\": str, \"min\": min, \"max\": max, \"isinstance\": isinstance, \"dict\": dict, \"int\": int,",
    "                           \"FileNotFoundError\": FileNotFoundError, \"BlockingIOError\": BlockingIOError,",
    "                           \"BrokenPipeError\": BrokenPipeError, \"OSError\": OSError,",
    "                           \"InterruptedError\": InterruptedError, \"TimeoutError\": TimeoutError,",
    "                           \"ValueError\": ValueError, \"KeyError\": KeyError, \"TypeError\": TypeError, \"Exception\": Exception},",
    "           \"open\": fixture.open, \"json\": json, \"SnapshotCleanupError\": error_types[\"SnapshotCleanupError\"],",
    "           \"InvalidGateBudget\": error_types[\"InvalidGateBudget\"], \"JobRequestCancelled\": error_types[\"JobRequestCancelled\"],",
    "           \"os\": SimpleNamespace(get_blocking=fixture.get_blocking, set_blocking=fixture.set_blocking, write=fixture.write, stat=fixture.stat),",
    "           \"sys\": SimpleNamespace(stdout=SimpleNamespace(fileno=lambda: 73))}",
    "    exec(compile(ast.Module(body=[writer, relay], type_ignores=[]), \"<relay-fixture>\", \"exec\"), env)",
    "    relay_owner=env[\"_stream_stdout\"]",
    "    cursor={\"offset\":0,\"source_line_start\":True,\"output_line_start\":True}",
    "    def call(path,value,final=False):",
    "        if isinstance(value,dict):return relay_owner(path,value,final)",
    "        cursor[\"offset\"]=value",
    "        return relay_owner(path,cursor,final)",
    "    env[\"_stream_stdout\"]=call",
    "    return env",
    "def flush(fixture):",
    "    env = context(fixture)",
    "    env.update(stdout_path=\"memory\", stderr_path=\"stderr\", deadline=100, run_deadline=100-reserve,",
    "               sequence=1, nonce=\"nonce\", ack_path=\"ack\", status_path=\"state\", identity=None, identity_verified=False, launchctl=\"launchctl\", service=\"service\", NO_VERDICT=98, SNAPSHOT_STOP_RESERVE_SECONDS=2,",
    "               clock_now=fixture.monotonic, time=SimpleNamespace(sleep=fixture.sleep), POLL_SECONDS=poll,",
    "               interrupted=SimpleNamespace(is_set=lambda: fixture.interrupted),",
    "               result_code=fixture.body_code, root=\"root\", environment={}, before={\"snapshot\": \"fixed\"},",
    "               scratch=\"private\", owner=None, capture_snapshot=fixture.snapshot, no_verdict=fixture.no_verdict,",
    "               _emit_job_stderr=fixture.emit, shutil=SimpleNamespace(rmtree=fixture.remove))",
    "    requested={}",
    "    def phase_write(path,token,owner,identity,sequence,phase,*args,**values):requested[phase]=values",
    "    def phase_wait(path,owner,identity,token,phases,sequence,deadline,interrupted,stdout_path,offset):",
    "        if phases==(\"retired\",):return {\"phase\":\"retired\",\"sequence\":sequence,\"sealed\":True,\"quiescent\":True,\"code\":requested[\"retire\"][\"result_code\"]},offset[\"offset\"]",
    "        assert phases==(\"normal-after-complete\",)",
    "        snap=next(n for n in ast.parse(Path(sys.argv[2]).read_text()).body if isinstance(n,ast.FunctionDef) and n.name==\"snapshot\")",
    "        scope=dict(Path=Path,SimpleNamespace=SimpleNamespace,interrupted=fixture.interrupted,controller_alive=lambda x:True,request=lambda *args,**kwargs:(_ for _ in ()).throw(InterruptedError('cancelled')) if kwargs.get('cancellation_observed') else None)",
    "        exec(compile(ast.Module(body=[snap],type_ignores=[]),\"<actual guardian snapshot>\",\"exec\"),scope)",
    "        capability=SimpleNamespace(capture_snapshot=fixture.snapshot,SnapshotCleanupError=error_types[\"SnapshotCleanupError\"],InvalidGateBudget=error_types[\"InvalidGateBudget\"])",
    "        after,failure,stop=scope[\"snapshot\"]({\"cwd\":\"root\",\"environment\":{},\"deadline\":100,\"controller\":{}},None,capability,sequence)",
    "        return {\"phase\":\"normal-after-complete\",\"after\":after,\"after_failure\":failure},offset[\"offset\"]",
    "    env.update(_write_job_request=phase_write,_wait_job_phase=phase_wait,_darwin_cleanup=lambda *args,**kwargs:True)",
    "    initial = ast.parse(\"output_offset = 0\\noutput_cursor = {'offset':0,'source_line_start':True,'output_line_start':True}\\nretirement = {}\\nreason = None\\ndetail = None\\nowned_service = False\\nsequence = 1\\nafter_failure = None\").body",
    "    final = ast.Try(body=final_body, handlers=outer.handlers, orelse=outer.orelse, finalbody=outer.finalbody)",
    "    function = ast.FunctionDef(name=\"finish\", args=ast.arguments(posonlyargs=[], args=[], vararg=None,",
    "                               kwonlyargs=[], kw_defaults=[], kwarg=None, defaults=[]),",
    "                               body=initial+[final], decorator_list=[])",
    "    module = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))",
    "    exec(compile(module, \"<final-return-fixture>\", \"exec\"), env)",
    "    return env[\"finish\"]()",
    "for before in (False, True):",
    "    f = Fixture(before=before, action=\"partial\")",
    "    call = context(f)[\"_stream_stdout\"]",
    "    offset = call(\"memory\", 0)",
    "    assert offset == 3 and bytes(f.accepted) == b\"abc\" and f.mode == before",
    "    assert call(\"memory\", offset) == 8 and bytes(f.accepted) == f.data and f.mode == before",
    "    f = Fixture(before=before, action=\"again\")",
    "    call = context(f)[\"_stream_stdout\"]",
    "    assert call(\"memory\", 0) == 0 and not f.accepted and f.mode == before",
    "    assert call(\"memory\", 0) == 8 and bytes(f.accepted) == f.data and f.mode == before",
    "    for action in (\"again\", \"partial\"):",
    "        f = Fixture(before=before, action=action)",
    "        assert flush(f) == 0 and bytes(f.accepted) == f.data and f.mode == before",
    "        assert not f.verdicts and f.emitted and f.snapshots == 1 and f.removals == 1",
    "f = Fixture(data=b\"x\" * (65536 + 7))",
    "call = context(f)[\"_stream_stdout\"]",
    "offset = call(\"memory\", 0)",
    "assert offset == 65536 and call(\"memory\", offset) == len(f.data) and bytes(f.accepted) == f.data",
    "f = Fixture(data=b\"x\" * (65536 + 7))",
    "assert flush(f) == 0 and bytes(f.accepted) == f.data",
    "f = Fixture(data=b\"x\" * (5 * 65536), now=100-reserve-2)",
    "assert flush(f) == 98 and len(f.accepted) == 2 * 65536 and f.now == 100-reserve and 100-f.now == reserve",
    "assert f.verdicts == [(\"timeout\", \"final stdout relay incomplete after body exit 0\")] and not f.emitted",
    "for now in (100-reserve, 101):",
    "    f = Fixture(now=now)",
    "    assert flush(f) == 98 and f.writes == 0 and f.now == now",
    "    assert f.verdicts[0][0] == \"timeout\" and not f.emitted and f.removals == 0",
    "for action in (\"again\", \"closed\"):",
    "    f = Fixture(action=action, persistent=True, now=100-reserve-2)",
    "    assert flush(f) == 98 and f.writes == 2 and not f.accepted and f.now == 100-reserve",
    "    assert f.verdicts == [(\"timeout\", \"final stdout relay incomplete after body exit 0\")] and not f.emitted",
    "    assert f.sleeps and f.snapshots == 1 and f.removals == 0",
    "for body_code in (0, 1):",
    "    f = Fixture(data=b\"\", body_code=body_code)",
    "    assert flush(f) == body_code and f.writes == 0 and not f.verdicts and f.emitted and f.removals == 1",
    "for failure in (\"missing\", \"read_error\"):",
    "    f = Fixture()",
    "    setattr(f, failure, True)",
    "    assert flush(f) == 98 and not f.emitted and f.snapshots == 0 and f.removals == 0",
    "    assert f.verdicts[0][0] == \"setup\" and \"source-after-unavailable\" in f.verdicts[0][1]",
    "f = Fixture(action=\"interrupt\")",
    "assert flush(f) == 98 and bytes(f.accepted) == b\"abc\" and f.writes == 1 and not f.emitted",
    "assert f.verdicts == [(\"interrupted\", \"final stdout relay incomplete after body exit 0\")] and f.removals == 0",
    "f = Fixture()",
    "f.invalid_budget = True",
    "assert flush(f) == 98 and f.snapshots == 1 and not f.emitted and f.removals == 1",
    "assert f.verdicts == [(\"setup\", \"inert invalid budget\")]",
    "marker=b\"APERTURE-GATE-INDETERMINATE reason=timeout: child\\n\"",
    "for before in (False,True):",
    "    for data in (b\"ordinary\\n\"+marker+b\"tail\",b\"x\"*65530+b\"\\n\"+marker+b\"end\",",
    "                 b\"before\\n\"+marker+b\"z\"*65536,b\"APERTURE-GATE-INDETERMINATE reas\",b\"ordinary\\n\"+marker*2+b\"tail\"):",
    "        f=Fixture(data=data,before=before)",
    "        call=context(f)[\"_stream_stdout\"]",
    "        cursor={\"offset\":0,\"source_line_start\":True,\"output_line_start\":True}",
    "        for step in range(8):",
    "            call(\"memory\",cursor,True)",
    "            if cursor[\"offset\"]==len(data) and cursor.get(\"pending_marker\") is None:break",
    "        else:raise AssertionError(\"bounded relay did not finish\")",
    "        assert bytes(f.accepted)==data.replace(marker,b\"\"),(len(data),bytes(f.accepted)[-100:])",
    "        assert bool(cursor.get(\"verdict\"))==(marker in data)",
    "        assert f.mode==before",
    "for length in (65536,70000):",
    "    data=b\"APERTURE-GATE-INDETERMINATE reason=timeout: \"",
    "    data+=b\"x\"*(length-len(data))",
    "    f=Fixture(data=data)",
    "    assert flush(f)==0 and bytes(f.accepted)==data and not f.verdicts",
    "f=Fixture(body_code=98,data=b\"raw\")",
    "assert flush(f)==98 and bytes(f.accepted)==b\"raw\" and not f.verdicts",
    "class OutputRetentionMismatch(AssertionError):pass",
    "def retained_output_oracle():",
    "    f=Fixture(action=\"again\",persistent=True,now=100-reserve-2)",
    "    assert flush(f)==98 and not f.accepted",
    "    if f.removals:raise OutputRetentionMismatch(\"undelivered ordinary stdout spool was deleted\")",
    "retained_output_oracle()",
    "saved_final_body=final_body",
    "try:",
    "    final_body=copy.deepcopy(final_body[1:])",
    "    try:retained_output_oracle()",
    "    except OutputRetentionMismatch:pass",
    "    else:raise AssertionError(\"removing normal incomplete-output retention escaped cleanup oracle\")",
    "finally:final_body=saved_final_body",
  ].join('\n');
  const result = spawnSync('python3', ['-I', '-B', '-c', script, SUPERVISOR_SCRIPT, path.join(PROJECT, 'scripts/full-gate/darwin-runner.py')], {
    encoding: 'utf8', timeout: 30000, env: pythonTestEnvironment()
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
});

test('both public full entries decline before starting work without admission', () => {
  const env = { ...process.env };
  env.NODE_OPTIONS = '';
  env.APERTURE_GATE_TIME_LEFT_S = '60';
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

function supervisePreflight(t, extraEnv, bin) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-preflight-class-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const bodyMarker = path.join(scratch, 'body-ran');
  const env = { ...process.env, NODE_OPTIONS: '', ...extraEnv };
  if (bin) env.PATH = bin(scratch) + path.delimiter + process.env.PATH;
  const result = spawnSync('python3', [
    '-I', SUPERVISOR_SCRIPT, '--', process.execPath, '-e',
    "require('node:fs').writeFileSync(" + JSON.stringify(bodyMarker) + ", 'ran')"
  ], { cwd: PROJECT, env, encoding: 'utf8', timeout: 12000 });
  return { result, bodyRan: fs.existsSync(bodyMarker) };
}

test('source preflight Git failure is a setup no-verdict, not invalid input', { timeout: 15000 }, t => {
  const { result, bodyRan } = supervisePreflight(t, {}, scratch => {
    const bin = path.join(scratch, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\necho "fatal: injected Git failure" >&2\nexit 128\n', { mode: 0o700 });
    return bin;
  });
  assert.equal(result.status, 98, result.stderr + result.stdout);
  assert.match(result.stdout, /APERTURE-GATE-INDETERMINATE reason=setup/);
  assert.equal((result.stdout.match(/APERTURE-GATE-INDETERMINATE/g) || []).length, 1);
  assert.equal(bodyRan, false);
});

for (const [key, value] of [['APERTURE_GATE_SLOWEST_RUN_S', 'abc'], ['APERTURE_GATE_TIME_LEFT_S', '0123']]) {
  test('source preflight refuses ' + key + '=' + value + ' as invalid input', { timeout: 15000 }, t => {
    const { result, bodyRan } = supervisePreflight(t, { [key]: value });
    assert.equal(result.status, 4, result.stderr + result.stdout);
    assert.match(result.stderr, new RegExp(key + ' must be a positive whole number'));
    assert.doesNotMatch(result.stdout, /APERTURE-GATE-INDETERMINATE/);
    assert.equal(bodyRan, false);
  });
}

test('outer no-verdict survives a full child stderr log pipe', { timeout: 30000 }, async t => {
  const f = fixture(t);
  const result = await f.launchSupervised({
    APERTURE_GATE_TIME_LEFT_S: '20',
    APERTURE_GATE_SLOWEST_RUN_S: '5',
    FIXTURE_STDERR_BYTES: '2000000',
    FIXTURE_HANG: '1',
    FIXTURE_NO_STDERR_DRAIN: '1'
  }).done;
  const { stdout, stderr, stdoutClosed, stderrClosed, stderrHeldUntilExit, stderrRelease } = result.streams;
  const body = fs.existsSync(f.marker) && JSON.parse(fs.readFileSync(f.marker, 'utf8'));
  const pressurePath = f.marker + '.stderr-pressure';
  const pressure = fs.existsSync(pressurePath) && JSON.parse(fs.readFileSync(pressurePath, 'utf8'));
  const bodyReady = stdout.split('\n').includes('BODY_READY');
  const diagnostics = JSON.stringify({
    code: result.code, signal: result.signal, admittedBody: Boolean(body), bodyReady, pressure,
    stdoutClosed, stderrClosed, stderrHeldUntilExit, stderrRelease, stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr), stdoutTail: stdout.slice(-300), stderrTail: stderr.slice(-300)
  });
  assert.equal(result.code, 98, diagnostics);
  assert.equal(body?.identity?.kind, 'present', diagnostics);
  assert.equal(bodyReady, true, diagnostics);
  assert.deepEqual(pressure, { bytes: 2000000, backpressured: true }, diagnostics);
  assert.equal(stderrHeldUntilExit, true, diagnostics);
  assert.equal(stdoutClosed && stderrClosed, true, diagnostics);
  const count = text => (text.match(/APERTURE-GATE-INDETERMINATE/g) || []).length;
  assert.equal(count(stdout) + count(stderr), 1, diagnostics);
  assert.match(stdout, /APERTURE-GATE-INDETERMINATE reason=timeout\b/, diagnostics);
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
  assert.deepEqual(relative(bodyDispatchers), ['scripts/full-gate-worker.js']);
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
  for (const file of ['body-runner.js', 'watchdog-collector.js']) fs.copyFileSync(path.join(PROJECT,'scripts','full-gate',file),path.join(root,'scripts','full-gate',file));
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


for (const scenario of [
  { name: 'caller disconnect during final source verification is a no-verdict', disconnect: true, expected: 98 },
  { name: 'caller disconnect during failed final source verification is a no-verdict', disconnect: true, brokenSource: true, expected: 98 },
  { name: 'closed IPC during final source verification does not need its disconnect event', disconnect: true, suppressEvent: true, expected: 98 },
  { name: 'healthy IPC during final source verification preserves the body result', expected: 0 },
  { name: 'closed IPC control exposes a missing final connectivity check', disconnect: true, suppressEvent: true, control: true, expected: 0 }
]) test(scenario.name, { skip: process.platform === 'win32', timeout: 180000 }, async t => {
  const f = fixture(t);
  const bin = path.join(f.scratch, 'git-wrapper');
  fs.mkdirSync(bin);
  const counter = path.join(f.scratch, 'revision-count');
  const signalMarker = path.join(f.scratch, 'final-snapshot-signal');
  const disconnectMarker = path.join(f.scratch, 'disconnect-observed');
  const entry = path.join(f.scratch, 'entry.js');
  let entrySource = fs.readFileSync(entry, 'utf8');
  if (scenario.suppressEvent) {
    entrySource = 'if(require.main===module){const emit=process.emit;process.emit=function(event,...args){'
      + 'if(event==="disconnect"){require("node:fs").writeFileSync(' + JSON.stringify(disconnectMarker)
      + ',"observed");return true;}return emit.call(this,event,...args);};}\n' + entrySource;
  }
  if (scenario.control) {
    const source = fs.readFileSync(GATE, 'utf8');
    const check = '    if (process.connected === false) onDisconnect();';
    assert.equal(source.split(check).length, 2, 'one final connectivity owner');
    const control = source.replace(check, '');
    const load = '(()=>{const Module=require("node:module");const owner=new Module(' + JSON.stringify(GATE)
      + ',module);owner.filename=' + JSON.stringify(GATE)
      + ';owner.paths=Module._nodeModulePaths(require("node:path").dirname(owner.filename));owner._compile('
      + JSON.stringify(control) + ',owner.filename);return owner.exports;})()';
    const ownerImport = 'require(' + JSON.stringify(GATE) + ')';
    assert.equal(entrySource.split(ownerImport).length, 2);
    entrySource = entrySource.replace(ownerImport, load);
  }
  fs.writeFileSync(entry, entrySource);
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
  if (scenario.disconnect) {
    const disconnected = new Promise(resolve => run.child.once('disconnect', resolve));
    run.child.disconnect();
    await disconnected;
  }
  run.child.ref();
  if (scenario.brokenSource) {
    fs.unlinkSync(path.join(f.root, 'input'));
    fs.symlinkSync('missing-final-source', path.join(f.root, 'input'));
  }
  fs.writeFileSync(f.emergencyRelease, 'release');
  const result = await run.done;
  assert.equal(fs.readFileSync(counter, 'utf8'), '3');
  assert.equal(result.code, scenario.expected, result.output);
  if (scenario.suppressEvent) assert.equal(fs.readFileSync(disconnectMarker, 'utf8'), 'observed');
  if (scenario.expected === 98) {
    assert.match(result.output, /APERTURE-GATE-INDETERMINATE reason=interrupted/);
    assert.equal((result.output.match(/APERTURE-GATE-INDETERMINATE/g) || []).length, 1);
  }
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

test('guardian loss retains scratch without positive cleanup completion', { timeout: 180000 }, async t => {
  const f = fixture(t);
  const escapeArmed = path.join(f.scratch, 'escape-armed');
  const escapeRelease = path.join(f.scratch, 'escape-release');
  const escapeKilled = path.join(f.scratch, 'escape-killed');
  const escapeStarted = path.join(f.scratch, 'escape-started');
  const escapeDone = path.join(f.scratch, 'escape-done');
  const scratchRemoved = path.join(f.scratch, 'scratch-removed');
  const monitorBarrier = path.join(f.scratch, 'monitor-barrier');
  const custodyPath = f.marker + '.guard-custody';
  const scripts = path.join(f.scratch, 'copied-gate', 'scripts');
  fs.mkdirSync(path.join(scripts, 'full-gate'), { recursive: true });
  for (const name of ['full-gate.js', 'full-gate-worker.js', 'full-gate-watchdog.js']) fs.copyFileSync(path.join(PROJECT, 'scripts', name), path.join(scripts, name));
  for (const name of ['body-runner.js', 'watchdog-collector.js']) fs.copyFileSync(path.join(PROJECT, 'scripts/full-gate', name), path.join(scripts, 'full-gate', name));
  const gate = path.join(scripts, 'full-gate.js');
  const guardian = path.join(scripts, 'full-gate-watchdog.js');
  const guardianSource = fs.readFileSync(guardian, 'utf8');
  const monitorPoint = 'async function monitorDescendants() {';
  assert.equal(guardianSource.split(monitorPoint).length, 2);
  fs.writeFileSync(guardian, guardianSource.replace(monitorPoint, monitorPoint + "\n  if (process.env.FIXTURE_MONITOR_BARRIER && !fs.existsSync(process.env.FIXTURE_MONITOR_BARRIER)) return;"));
  const entry = path.join(f.scratch, 'entry.js');
  fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8').replace(JSON.stringify(GATE), JSON.stringify(gate)));
  const run = f.launchSupervised({
    FIXTURE_KILL_GUARD: '1',
    FIXTURE_ESCAPE_PIPE: '1',
    FIXTURE_ESCAPE_READY: '1',
    FIXTURE_RECREATE_SCRATCH: '1',
    FIXTURE_HANG: '1',
    FIXTURE_ESCAPE_ARMED: escapeArmed,
    FIXTURE_ESCAPE_RELEASE: escapeRelease,
    FIXTURE_ESCAPE_KILLED: escapeKilled,
    FIXTURE_ESCAPE_STARTED: escapeStarted,
    FIXTURE_ESCAPE_DONE: escapeDone,
    FIXTURE_SCRATCH_REMOVED: scratchRemoved,
    FIXTURE_MONITOR_BARRIER: monitorBarrier
  });
  let custody;
  let result;
  const actionDeadline = Date.now() + 10000;
  const diagnostics = () => 'output=' + (result?.output || '') + '\nfixture scratch=' + f.scratch + '\ncustody=' + JSON.stringify(custody);
  while (Date.now() < actionDeadline) {
    try { custody = JSON.parse(fs.readFileSync(custodyPath, 'utf8')); } catch {}
    if (fs.existsSync(escapeArmed) && custody?.state === 'prepared') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(escapeArmed), true, diagnostics());
  assert.equal(custody?.state, 'prepared', diagnostics());
  assert.equal(custody?.guardian?.kind, 'present', diagnostics());
  fs.writeFileSync(escapeRelease, 'release');
  while (!fs.existsSync(escapeStarted) && Date.now() < actionDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(escapeStarted), true, diagnostics());
  assert.equal(roleFixture.signalOwned(custody.guardian, 'SIGKILL'), true, diagnostics());
  assert.equal(await waitForIdentityGone(custody.guardian, actionDeadline), true, diagnostics());
  custody.state = 'signaled';
  fs.writeFileSync(custodyPath, JSON.stringify(custody));
  fs.writeFileSync(escapeKilled, 'guardian-signalled');
  fs.writeFileSync(monitorBarrier, 'guardian-signalled');
  result = await run.done;
  assert.equal(result.code, 98, diagnostics());
  assert.equal((result.output.match(/APERTURE-GATE-INDETERMINATE/g) || []).length, 1, diagnostics());
  assert.equal(fs.existsSync(f.marker), true, diagnostics());
  const body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
  assert.equal(fs.existsSync(escapeKilled), true, diagnostics());
  assert.equal(fs.existsSync(monitorBarrier), true, diagnostics());
  assert.equal(fs.existsSync(escapeStarted), true, diagnostics());
  assert.equal(fs.existsSync(escapeDone), true, diagnostics());
  assert.equal(fs.readFileSync(escapeDone, 'utf8'), 'reason=supervisor-stop', diagnostics());
  assert.equal(await waitForIdentityGone(body.escapeIdentity, actionDeadline), true, diagnostics());
  assert.notEqual(body.scratch, f.scratch, diagnostics());
  assert.match(path.basename(body.scratch), /^discord-gate-/, diagnostics());
  assert.equal(fs.existsSync(body.scratch), true, diagnostics());
  assert.equal(fs.existsSync(scratchRemoved), false, diagnostics());
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
  let firstExit;
  let launchError;
  first.done.then(result => { firstExit = result; }, error => { launchError = error; });
  let stopped;
  for (;;) {
    t.signal.throwIfAborted();
    if (launchError) throw launchError;
    try { stopped = JSON.parse(fs.readFileSync(workerKilled, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    if (stopped?.failed) assert.fail('worker-loss fixture failed: ' + JSON.stringify(stopped));
    if (firstExit) assert.fail('first gate exited before the custody hold: ' + JSON.stringify(firstExit));
    if (stopped?.state === 'signaled') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const saved = JSON.parse(fs.readFileSync(f.protocol + '.roles', 'utf8'));
  assert.ok(roleFixture.sameProcessIdentity(stopped.worker, saved.worker));
  assert.ok(roleFixture.sameProcessIdentity(stopped.guardian, saved.guardian));
  const expected = [saved.worker, saved.guardian];
  if (process.platform === 'darwin') {
    assert.equal(saved.extraHolders.length, 2);
    assert.ok(roleFixture.sameProcessIdentity(first.identity, saved.extraHolders[0]), 'wrong public controller');
    assert.equal(saved.extraHolders[1].coalition_id, stopped.body.coalition_id, 'wrong launchd guardian coalition');
    assert.notEqual(saved.extraHolders[1].coalition_id, first.identity.coalition_id, 'controller and launchd guardian shared a coalition');
    expected.push(first.identity, saved.extraHolders[1]);
  } else {
    assert.equal(saved.extraHolders.length, 0);
  }
  const lease = JSON.parse(fs.readFileSync(f.leaseFile, 'utf8'));
  assert.equal(lease.holders.length, expected.length);
  assert.equal(new Set(lease.holders.map(holder => holder.pid)).size, expected.length);
  for (const [index, holder] of expected.entries()) {
    assert.ok(roleFixture.sameProcessIdentity(holder, lease.holders[index]), 'wrong saved holder at index ' + index);
    if (process.platform === 'darwin') assert.equal(lease.holders[index].coalition_id, holder.coalition_id);
  }

  const secondMarker = path.join(f.scratch, 'second-body.json');
  const second = f.launchSupervised({ ...env, FIXTURE_KILL_WORKER: '', FIXTURE_HANG: '', FIXTURE_MARKER: secondMarker });
  const secondResult = await second.done;
  assert.equal(secondResult.code, 98, secondResult.output);
  assert.match(secondResult.output, /reason=capacity/);
  assert.equal(fs.existsSync(secondMarker), false, 'a second body started before the first cleanup finished');

  const supervisors = stopped.extraHolders.length ? stopped.extraHolders : [stopped.manager];
  for (const holder of supervisors) assert.equal(roleFixture.signalOwned(holder, 'SIGCONT'), true, 'supervisor identity changed before resume');
  assert.equal(roleFixture.signalOwned(stopped.guardian, 'SIGCONT'), true, 'guardian identity changed before resume');
  const firstResult = await first.done;
  assert.equal(firstResult.code, 98, firstResult.output);
  const body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
  assert.equal(roleFixture.identityGone(stopped.body, roleFixture.captureIdentity(body.pid)), true, 'body process remained after guardian cleanup');
  assert.equal(fs.existsSync(body.scratch), false, firstResult.output);

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
  assert.ok(roleFixture.sameProcessIdentity(unrelatedRun.identity, unrelatedRoles.extraHolders[0]), 'wrong unrelated controller');
  const unrelatedBody = JSON.parse(fs.readFileSync(unrelated.marker, 'utf8')).identity;
  assert.equal(roleFixture.signalOwned(unrelatedRun.identity, 'SIGHUP'), true, 'unrelated controller identity changed before shutdown');
  const unrelatedResult = await unrelatedRun.done;
  assert.equal(unrelatedResult.code, 98, unrelatedResult.output);
  assert.match(unrelatedResult.output, /APERTURE-GATE-INDETERMINATE reason=interrupted\b/);
  for (const identity of [unrelatedRun.identity, unrelatedJob, unrelatedRoles.worker, unrelatedRoles.guardian, unrelatedBody]) {
    assert.equal(identity?.kind, 'present', 'unrelated fixture retirement identity was not captured');
    for (;;) {
      t.signal.throwIfAborted();
      if (roleFixture.identityGone(identity, roleFixture.captureIdentity(identity.pid))) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
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
      if (name === './full-gate/watchdog-collector') return require('../scripts/full-gate/watchdog-collector');
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

test('worker keeps body and admission in its group and excludes body control forgery', () => {
  const { EventEmitter } = require('node:events');
  const vm = require('node:vm');
  const gate = require('../scripts/full-gate');
  const workerProcess = new EventEmitter();
  const packets = [];
  Object.assign(workerProcess, { argv: ['node', 'worker', '5000', 'entry'], pid: 23456, connected: true, env: {}, send: packet => packets.push(packet), kill: () => {}, exit: () => {} });
  const admission = new EventEmitter();
  const body = new EventEmitter();
  Object.assign(body, { connected: true, send: () => {} });
  let bodyOptions;
  let admissionOptions;
  vm.runInNewContext(fs.readFileSync(path.join(PROJECT, 'scripts/full-gate-worker.js'), 'utf8'), {
    __dirname: path.join(PROJECT, 'scripts'), process: workerProcess, setTimeout: () => {},
    require: name => {
      if (name === 'node:path' || name === 'node:os') return require(name);
      if (name === 'node:child_process') return {
        spawn: (_file, _args, options) => { admissionOptions = options; return admission; },
        fork: (_file, _args, options) => { bodyOptions = options; return body; }
      };
      if (name === './full-gate') return gate;
      throw new Error('unexpected worker import ' + name);
    }
  }, { timeout: 1000 });
  workerProcess.emit('message', { kind: MESSAGES.ADMIT, command: 'admit', args: [] });
  admission.emit('exit', 0);
  workerProcess.emit('message', { kind: MESSAGES.START });
  assert.equal(admissionOptions.detached, undefined);
  assert.equal(bodyOptions.detached, undefined);
  assert.equal(bodyOptions.stdio[3], 'ipc');
  assert.equal(bodyOptions.stdio[4], 'ignore');
  const count = packets.length;
  body.emit('message', { kind: MESSAGES.CLEANUP_COMPLETE, code: 0 });
  body.emit('message', { kind: MESSAGES.BODY_EXIT, code: 0 });
  assert.equal(packets.length, count, 'body data cannot report exit or guardian completion');
  body.emit('message', { kind: MESSAGES.BODY_COMPLETE });
  body.emit('message', { kind: MESSAGES.BODY_COMPLETE });
  assert.equal(packets.filter(packet => packet.kind === MESSAGES.BODY_COMPLETE).length, 1);
  body.emit('close', 17, null);
  assert.equal(packets.find(packet => packet.kind === MESSAGES.BODY_EXIT).code, 17);
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
      if (name === './full-gate/watchdog-collector') return require('../scripts/full-gate/watchdog-collector');
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

test('manager joins real guardian completion before final scratch removal', { skip: process.platform === 'win32', timeout: 360000 }, async t => {
  for (const control of [true, false]) await t.test(control ? 'removed join is red' : 'restored join is green', async t => {
    const f = fixture(t);
    const scripts = path.join(f.scratch, 'copied-gate', 'scripts');
    fs.mkdirSync(path.join(scripts, 'full-gate'), { recursive: true });
    for (const name of ['full-gate.js', 'full-gate-worker.js', 'full-gate-watchdog.js']) fs.copyFileSync(path.join(PROJECT, 'scripts', name), path.join(scripts, name));
    for (const name of ['body-runner.js', 'watchdog-collector.js']) fs.copyFileSync(path.join(PROJECT, 'scripts/full-gate', name), path.join(scripts, 'full-gate', name));
    const gate = path.join(scripts, 'full-gate.js');
    const guardian = path.join(scripts, 'full-gate-watchdog.js');
    const barrier = path.join(f.scratch, 'verified-completion-waiting');
    const release = f.emergencyRelease;
    const guardSource = fs.readFileSync(guardian, 'utf8');
    const point = '  completionSent = true;';
    assert.equal(guardSource.split(point).length, 2);
    const wait = [
      "  fs.writeFileSync(process.env.FIXTURE_COMPLETION_BARRIER, 'verified');",
      "  while (!fs.existsSync(process.env.FIXTURE_COMPLETION_RELEASE) && Date.now() < Number(deadline)) await new Promise(resolve => setTimeout(resolve, 10));",
      "  if (!fs.existsSync(process.env.FIXTURE_COMPLETION_RELEASE)) return process.exit(NO_VERDICT);"
    ].join('\n');
    fs.writeFileSync(guardian, guardSource.replace(point, wait + '\n' + point));
    if (control) {
      const source = fs.readFileSync(gate, 'utf8');
      const join = 'const guardianClosed = guardianExit ? await untilCallerDeadline(guardianExit) : { code: 0 };';
      assert.equal(source.split(join).length, 2);
      fs.writeFileSync(gate, source.replace(join, 'const guardianClosed = { code: null };'));
    }
    const entry = path.join(f.scratch, 'entry.js');
    fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8').replace(JSON.stringify(GATE), JSON.stringify(gate)));
    const run = f.launch({ FIXTURE_ESCAPE_PIPE: '1', FIXTURE_RECREATE_SCRATCH: '1', FIXTURE_COMPLETION_BARRIER: barrier, FIXTURE_COMPLETION_RELEASE: release });
    let finished = false;
    run.done.then(() => { finished = true; });
    try {
      const end = Date.now() + 120000;
      while (!fs.existsSync(barrier) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(fs.existsSync(barrier), true, 'actual fresh cleanup completion was not reached');
      const body = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
      assert.equal(roleFixture.identityGone(body.escapeIdentity, roleFixture.captureIdentity(body.escapePid)), true);
      assert.equal(fs.existsSync(f.marker + '.escape-signalled'), true);
      if (control) {
        const result = await run.done;
        assert.equal(result.code, 98, result.output);
        assert.throws(() => assert.equal(fs.existsSync(body.scratch), false), assert.AssertionError, 'removing the join must violate final removal');
      } else {
        assert.equal(finished, false, 'manager finished before actual guardian completion');
        fs.writeFileSync(release, 'release');
        const result = await run.done;
        assert.equal(result.code, 98, result.output);
        assert.equal((result.output.match(/APERTURE-GATE-INDETERMINATE/g) || []).length, 1);
        assert.equal(fs.existsSync(body.scratch), false);
      }
    } finally { fs.writeFileSync(release, 'release'); }
  });
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
  assert.equal(fs.existsSync(body.scratch), false, result.output);
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
  const ownerEnd = source.indexOf('\nasync function hasLiveEscapedDescendants', ownerStart);
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
  test('stopping worker cannot close successfully or remove scratch, manager connected ' + connected, () => {
    const { EventEmitter } = require('node:events');
    const vm = require('node:vm');
    const gate = require('../scripts/full-gate');
    const processFixture = new EventEmitter();
    const exits = [];
    const signals = [];
    const timers = [];
    let declarations = 0;
    let releases = 0;
    Object.assign(processFixture, {
      pid: 12345, connected, argv: ['node', 'worker', '5000', 'entry'], env: { [gate.SCRATCH_ROOT]: 'owned-fixture' },
      send: () => {}, exit: code => exits.push(code), kill: (pid, signal) => signals.push([pid, signal])
    });
    vm.runInNewContext(fs.readFileSync(path.join(PROJECT, 'scripts/full-gate-worker.js'), 'utf8'), {
      process: processFixture, __dirname: path.join(PROJECT, 'scripts'), setTimeout: callback => { timers.push(callback); },
      require: name => {
        if (name === 'node:path' || name === 'node:os') return require(name);
        if (name === 'node:child_process') return {};
        if (name === './full-gate') return { ...gate, noVerdict: () => { declarations++; return gate.NO_VERDICT; }, releaseScratch: () => { releases++; return false; } };
        throw new Error('unexpected fixture import ' + name);
      }
    }, { timeout: 1000 });
    processFixture.emit('SIGTERM');
    processFixture.emit('message', { kind: MESSAGES.CLOSE });
    assert.deepEqual(exits, [], 'a stopping worker cannot finish0');
    assert.equal(declarations, 1);
    assert.equal(timers.length, 2, 'independent deadline and unchanged two-second KILL');
    timers[1]();
    assert.deepEqual(exits, [98]);
    assert.deepEqual(signals, [[-12345, 'SIGTERM'], [-12345, 'SIGKILL']]);
    assert.equal(releases, 0, 'only the guardian can establish escaped-writer completion');
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


const darwinDeadlineProgram = String.raw`import ast,copy,io,json,math,signal,sys,types
from pathlib import Path
signal.signal(signal.SIGALRM, signal.SIG_DFL)
signal.alarm(25)
sources=[Path(p).read_text() for p in sys.argv[1:4]]
supervisor,runner,owner=sources
results=[]
def declarations(source,names,namespace):
    nodes=[n for n in ast.parse(source).body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in names]
    assert {n.name for n in nodes}==names
    exec(compile(ast.Module(body=nodes,type_ignores=[]),'<deadline declarations>','exec'),namespace)
    return namespace
class FixtureOracle(BaseException):pass
oracle_failures=[]
def oracle(value,detail):
    if not value:
        oracle_failures.append(detail)
        raise FixtureOracle(detail)
contract=next(ast.literal_eval(n.value) for n in ast.parse(owner).body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='CLOCK_CONTRACT' for t in n.targets))
literal=lambda source,name:next(ast.literal_eval(n.value) for n in ast.parse(source).body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id==name for t in n.targets))
class Clock:
    CLOCK_MONOTONIC=1
    def __init__(self,local):self.value=1000;self.local=local;self.calls=0;self.fail=False
    def clock_gettime(self,kind):
        self.calls+=1;oracle(self.calls<1000,'unbounded fake clock')
        oracle(kind==self.CLOCK_MONOTONIC,'wrong clock primitive')
        if self.fail:raise OSError('fake unavailable clock')
        return self.value
    def monotonic(self):oracle(False,'process-local origin used: '+str(self.local))
    def sleep(self,seconds):self.value+=seconds
def clock_owner(clock):
    return declarations(owner,{'CapabilityError','clock_now','require_clock_contract'},dict(time=clock,math=math,CLOCK_CONTRACT=contract))
def case(name,action):
    action();results.append(name)
def run_case(cap='95',delay=15,change=None,ack_change=None,clock_failure=False,live=False,start_clock_failure=False,oracle_fault=None):
    clock=Clock(-7000);clock.fail=start_clock_failure;ns=clock_owner(clock);states=[];spawns=[];drains=[];sleep_count=[0];first=[True]
    controller={'pid':301,'coalition_id':300};identity={'pid':401,'coalition_id':400}
    api=types.SimpleNamespace(**ns)
    api.joined_identity=lambda pid:dict(identity)
    api.identity_if_present=lambda pid:dict(controller)
    api.same_process=lambda left,right:left==right
    api.task_counts=lambda rid:(2,0) if live and clock_failure and sleep_count[0]<2 else (1,0)
    api._drained=lambda *args:True
    def drain(resource,deadline,preserve):
        drains.append((resource,deadline,preserve));oracle(resource==400 and deadline==1100 and preserve==identity,'wrong owned drain target')
        if clock.fail:raise api.CapabilityError('fake cleanup clock unavailable')
        return True
    api.drain=drain
    env={'APERTURE_GATE_TIME_LEFT_S':cap,'DISCORD_SURFACE_GATE_SUPERVISOR':'darwin-launchd-v1','DISCORD_SURFACE_GATE_SUPERVISOR_RECEIPT':'receipt','DISCORD_SURFACE_GATE_SUPERVISOR_TOKEN':'token','UNCHANGED':'spaces and unicode é'}
    spec={'state_path':'state','clock_contract':contract,'deadline':1100,'run_deadline':1095,'controller':controller,'ack_path':'ack','launch_token':'nonce','environment':env,'command':['fake-child'],'cwd':'fake-root','snapshot_program':'pinned program'}
    if change:change(spec)
    def wire(record):return json.dumps(record,sort_keys=True,separators=(',',':'),allow_nan=True)
    before=wire(spec);phase=['command'];sequence=[1]
    class Cleanup(OSError):pass
    class Budget(Exception):pass
    capability=types.SimpleNamespace(SnapshotCleanupError=Cleanup,InvalidGateBudget=Budget,capture_snapshot=lambda *args,**kwargs:{'snapshot':'stable'})
    def published(record,value):
        if oracle_fault=='wrong-spec':record={**record,'cwd':'wrong-root'}
        oracle(wire(record)==before,'state writer changed immutable spec');states.append(dict(value))
        if value.get('phase')=='body-quiescent':phase[0]='normal-after';sequence[0]=2
        if value.get('phase')=='normal-after-complete':phase[0]='retire';sequence[0]=3
    def fake_open(path,*args,**kwargs):
        if path=='spec':return io.StringIO(before)
        oracle(path=='ack','unexpected fake file path')
        if first[0]:clock.value+=delay;first[0]=False
        ack={'launch_token':'nonce','clock_contract':contract,'identity':identity,'sequence':sequence[0],'phase':phase[0],'cancelled':False,'result_code':0}
        if ack_change:ack_change(ack)
        return io.StringIO(json.dumps(ack))
    def popen(argv,**kwargs):
        spawns.append((argv,kwargs));oracle(argv==['fake-child'] and kwargs['start_new_session'] is False,'wrong child launch')
        if clock_failure:clock.fail=True
        return types.SimpleNamespace(pid=402,poll=lambda:None if live else 0)
    def sleep(seconds):sleep_count[0]+=1;oracle(sleep_count[0]<16,'unbounded fake observer');clock.sleep(seconds)
    target=dict(json=json,math=math,open=fake_open,time=types.SimpleNamespace(sleep=sleep),Path=Path,SimpleNamespace=types.SimpleNamespace,__file__='/private/fixture/darwin-runner.py',
        os=types.SimpleNamespace(getpid=lambda:401),interrupted=False,receive_signal=lambda *args:None,
        signal=types.SimpleNamespace(SIGINT=2,SIGTERM=15,SIGHUP=1,signal=lambda *args:None),subprocess=types.SimpleNamespace(Popen=popen),write_state=published,DARWIN=api,
        importlib=types.SimpleNamespace(util=types.SimpleNamespace(spec_from_file_location=lambda *args:types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda module:None)),module_from_spec=lambda spec:capability)))
    declarations(runner,{'run','controller_alive','request','retirement_result','finish','quiescent','snapshot'},target)
    if oracle_fault and oracle_fault!='wrong-spec':
        def faulty_clock():
            if oracle_fault=='local':return clock.monotonic()
            if oracle_fault=='bound':clock.calls=1000;return clock.clock_gettime(clock.CLOCK_MONOTONIC)
            if oracle_fault=='primitive':return clock.clock_gettime(-1)
            if oracle_fault=='path':return fake_open('foreign-path')
            oracle(False,'unknown deliberate oracle fault')
        api.clock_now=faulty_clock
    baseline_faults=len(oracle_failures)
    code=target['run']('spec')
    oracle(len(oracle_failures)==baseline_faults,'target absorbed a fatal fixture oracle')
    assert wire(spec)==before,'original spec mutated'
    return types.SimpleNamespace(code=code,states=states,spawns=spawns,drains=drains,env=env)

def budget():
    r=run_case();assert r.code==0 and len(r.spawns)==1
    env=r.spawns[0][1]['env'];assert env['APERTURE_GATE_TIME_LEFT_S']=='80'
    for key in ('DISCORD_SURFACE_GATE_SUPERVISOR','DISCORD_SURFACE_GATE_SUPERVISOR_RECEIPT','DISCORD_SURFACE_GATE_SUPERVISOR_TOKEN','UNCHANGED'):assert env[key]==r.env[key]
    assert env['DISCORD_SURFACE_GATE_SUPERVISOR_PID']=='301' and env['DISCORD_SURFACE_GATE_JOB_PID']=='401'
    assert r.states[0]['clock_contract']==contract
case('readiness delay is debited with capabilities and original spec preserved',budget)
def lower_cap():
    r=run_case(cap='7');assert r.spawns[0][1]['env']['APERTURE_GATE_TIME_LEFT_S']=='7'
case('lower inherited cap survives',lower_cap)
def wrong_spec_control():
    try:run_case(change=lambda spec:spec.update(run_deadline=float('nan')),oracle_fault='wrong-spec')
    except FixtureOracle as error:
        assert str(error)=='state writer changed immutable spec'
        return
    raise FixtureOracle('changed writer spec escaped the immutability check')
case('a changed field is rejected even in a nonfinite deadline fixture',wrong_spec_control)
for fault in ('bound','primitive','local','path'):
    failed=False
    try:run_case(cap='',oracle_fault=fault)
    except FixtureOracle:failed=True
    assert failed,'negative guard case absorbed oracle fault '+fault
    results.append('fatal oracle escapes negative path '+fault)

for cap in ('','0','-1','nan',True,2,None):
    r=run_case(cap=cap);assert r.code==98 and not r.spawns and r.states[-1]['code']==98
    results.append('invalid inherited cap '+repr(cap))
r=run_case(change=lambda spec:spec['environment'].pop('APERTURE_GATE_TIME_LEFT_S'))
assert r.code==98 and not r.spawns
results.append('missing inherited cap refuses launch')
r=run_case(start_clock_failure=True)
assert r.code==98 and not r.spawns
results.append('clock API failure before launch has no child')
for value in (float('nan'),float('inf'),None):
    r=run_case(change=lambda spec,value=value:spec.update(run_deadline=value))
    assert r.code==98 and not r.spawns
    results.append('invalid shared deadline '+repr(value))
for delay in (95,94.5,96):
    r=run_case(delay=delay);assert r.code==98 and not r.spawns
    results.append('expired or subsecond launch '+str(delay))
for field in ('spec','ack'):
    for value in (None,'process-relative-v0'):
        mutate=lambda record,value=value:record.pop('clock_contract',None) if value is None else record.update(clock_contract=value)
        r=run_case(change=mutate if field=='spec' else None,ack_change=mutate if field=='ack' else None)
        assert r.code==98 and not r.spawns
        results.append(field+' rejects clock contract '+str(value))
r=run_case(clock_failure=True,live=True)
assert r.code==98 and len(r.spawns)==1 and len(r.drains)==1 and r.states[-1]['code']==98 and r.states[-1]['phase']=='retired'
results.append('live clock failure attempts owned cleanup without a false pass')
r=run_case(change=lambda spec:spec['controller'].update(coalition_id=400))
assert r.code==98 and not r.spawns
assert not r.drains,'shared controller coalition reached owned drain'
assert r.states and r.states[-1]['state']=='failed'
assert all(row.get('state')!='ready' and 'identity' not in row for row in r.states)
results.append('shared controller coalition refuses cleanup authority before launch')
def shared():
    clock=Clock(900000);ns=clock_owner(clock)
    parent=declarations(supervisor,{'clock_now'},dict(sys=types.SimpleNamespace(platform='darwin'),load_darwin_owner=lambda:types.SimpleNamespace(**ns),time=Clock(-12345)))
    assert parent['clock_now']()==ns['clock_now']()==1000
    clock.fail=True
    refused=False
    try:ns['clock_now']()
    except ns['CapabilityError']:refused=True
    assert refused
    for value in (float('nan'),float('inf'),-1,True):
        clock=Clock(123)
        clock.clock_gettime=lambda kind,value=value:value
        invalid=clock_owner(clock);refused=False
        try:invalid['clock_now']()
        except invalid['CapabilityError']:refused=True
        assert refused
case('distinct local origins use one shared clock and never fall back',shared)
def drain_clock():
    clock=Clock(-100000);ns=clock_owner(clock);sent=[]
    ns.update(TERM_SECONDS=1,POLL_SECONDS=.025,signal=types.SimpleNamespace(SIGTERM=15,SIGKILL=9))
    ns['_drained']=lambda *args:False
    ns['_signal_members']=lambda resource,number,deadline,excluded:sent.append((number,deadline))
    declarations(owner,{'drain'},ns)
    assert ns['drain'](400,1001.5) is False
    assert {number for number,deadline in sent}=={15,9} and all(deadline==1001.5 for number,deadline in sent)
case('TERM and KILL drain use the shared deadline',drain_clock)
def darwin_group_stop():
    # The verifier leader and its git child each die on any signal they do not ignore.
    # lag: polls an exited leader misses while XNU already skips it in killpg but cannot reap it yet.
    def stop(ignores={},reaped=False,deadline=1005,lingers=0,child=True,zombie=0,lag=0,clock_fails=False,sent=None):
        now=[1000.0];sent=[] if sent is None else sent;live={'leader':not reaped,'child':child};state={'reaped':reaped,'zombie':zombie,'lag':lag}
        class Leader:
            pid=701
            returncode=-15 if reaped else None
            def poll(self):
                oracle(not any(live.values()),'verifier leader reaped while its group was live')
                if not live['leader'] and self.returncode is None:
                    if state['lag']:state['lag']-=1
                    else:state['reaped']=True;self.returncode=-15
                return self.returncode
        def killpg(pgid,number):
            oracle(pgid==701 and len(sent)<1000,'verifier stop left its group or did not end')
            oracle(number==0 or not state['reaped'],'verifier group signaled after its leader was reaped')
            sent.append(number)
            members=[name for name in live if live[name]]
            if not members:
                if state['zombie'] or not state['reaped']:raise PermissionError(1,'only exited members')
                raise ProcessLookupError(3,'no group')
            for name in members:
                if number and number not in ignores.get(name,()):
                    live[name]=False
                    if name=='child':state['zombie']=lingers
        def sleep(seconds):
            now[0]+=max(seconds,.025)
            if state['zombie']:state['zombie']-=1
        def clock_now():
            if clock_fails:raise OSError('fake clock failure')
            return now[0]
        ns=dict(sys=types.SimpleNamespace(platform='darwin'),os=types.SimpleNamespace(killpg=killpg),signal=types.SimpleNamespace(SIGTERM=15,SIGKILL=9),clock_now=clock_now,time=types.SimpleNamespace(sleep=sleep),TERMINATION_GRACE_SECONDS=1,POLL_SECONDS=.025)
        declarations(supervisor,{'stop_owned_processes','signal_group','wait_for_group_exit'},ns)
        before=len(oracle_failures)
        try:result=ns['stop_owned_processes'](Leader(),deadline)
        finally:oracle(len(oracle_failures)==before,'Darwin stop absorbed a fixture oracle')
        return result,sent,state['reaped'],now[0]
    result,sent,reaped,ended=stop()
    assert result is True and reaped and sent[0]==15 and 9 not in sent and sent[-1]==0
    for member in ('leader','child'):
        result,sent,reaped,ended=stop(ignores={member:{15}})
        assert result is True and reaped and sent.index(9)>sent.index(15)
    result,sent,reaped,ended=stop(ignores={'child':{15,9}})
    assert result is False and not reaped and sent[-1]==9
    result,sent,reaped,ended=stop(ignores={'child':{15}},deadline=1000.5)
    assert result is False and 9 in sent
    result,sent,reaped,ended=stop(lingers=3)
    assert result is True and sent.count(0)>1
    result,sent,reaped,ended=stop(reaped=True)
    assert result is False and set(sent)=={0} and ended<=1001.05
    result,sent,reaped,ended=stop(reaped=True,child=False)
    assert result is True and sent==[0]
    result,sent,reaped,ended=stop(reaped=True,child=False,zombie=10**6)
    assert result is False and set(sent)=={0}
    result,sent,reaped,ended=stop(reaped=True,deadline=1000.5)
    assert result is False and set(sent)=={0} and ended<=1000.55
    result,sent,reaped,ended=stop(ignores={'child':{15}},deadline=1001.03)
    assert result is True and reaped
    for member in ('leader','child'):
        result,sent,reaped,ended=stop(ignores={member:{15}},lag=3)
        assert result is True and reaped and set(sent[sent.index(0):])=={0}
    failed=None;sent=[]
    try:stop(clock_fails=True,sent=sent)
    except OSError as error:failed=error
    assert failed is not None and sent==[15]
case('Darwin verifier stop proves its group drained before and after reaping the leader',darwin_group_stop)
def ready_contract(value):
    clock=Clock(99999);ns=clock_owner(clock);writes=[]
    api=types.SimpleNamespace(**ns,joined_identity=lambda pid:{'pid':401,'coalition_id':400},same_process=lambda a,b:a==b,task_counts=lambda rid:(1,0))
    function=next(n for n in ast.parse(supervisor).body if isinstance(n,ast.FunctionDef) and n.name=='run_darwin_supervised')
    outer=next(n for n in function.body if isinstance(n,ast.Try) and any(isinstance(x,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='spec_payload' for t in x.targets) for x in n.body))
    first=next(i for i,n in enumerate(outer.body) if isinstance(n,ast.Expr) and isinstance(n.value,ast.Call) and isinstance(n.value.func,ast.Attribute) and n.value.func.attr=='require_clock_contract')
    last=next(i for i in range(first,len(outer.body)) if isinstance(outer.body[i],ast.Expr) and isinstance(outer.body[i].value,ast.Call) and isinstance(outer.body[i].value.func,ast.Name) and outer.body[i].value.func.id=='_write_job_request')
    scope=dict(state={'phase':'ready','identity':{'pid':401,'coalition_id':400},'clock_contract':value},owner=api,controller={'coalition_id':300},launchctl='launchctl',service='service',deadline=1100,nonce='nonce',ack_path='ack',sequence=0,interrupted=types.SimpleNamespace(is_set=lambda:False),
        _service_state=lambda *args:{'present':True,'pid':401,'state':'running'},_write_job_request=lambda *args,**kwargs:writes.append(args))
    refused=False
    try:exec(compile(ast.Module(body=copy.deepcopy(outer.body[first:last+1]),type_ignores=[]),'<actual ready consumer>','exec'),scope)
    except ns['CapabilityError']:refused=True
    if value==contract:assert not refused and len(writes)==1 and writes[0][4:6]==(1,'command')
    else:assert refused and not writes

for value in (contract,None,'process-relative-v0'):ready_contract(value)
results.append('parent ready consumer rejects mixed or missing contracts before ack')
def snapshot_case(mode,cleanup='ok',platform='darwin',stop_deadline=1105,now_after=None):
    events=[];spawned=[];clock_calls=[];waits=[];seen=[1000];faults_before=len(oracle_failures)
    injected=OSError('fake post-spawn clock or communication failure')
    class Pipe:
        def __init__(self,name):self.name=name;self.closed=False
        def close(self):
            events.append('close-'+self.name);self.closed=True
            if cleanup=='close' and self.name=='stdout':raise OSError('fake close failure')
    process=types.SimpleNamespace(pid=501,returncode=None,stdout=Pipe('stdout'),stderr=Pipe('stderr'))
    def communicate(timeout):
        oracle(timeout>0,'snapshot communicate is not bounded')
        events.append('communicate')
        if mode=='communicate':raise injected
        process.returncode={'budget':4,'noverdict':target['NO_VERDICT'],'failed':1}.get(mode,0)
        return ('bad-json' if mode=='parse' else '{"snapshot":"stable"}','')
    def wait(timeout):
        oracle(timeout==0,'snapshot reap gained a fresh wait')
        events.append('reap')
        if cleanup=='reap':raise OSError('fake reap failure')
        oracle(process.returncode is not None,'reap before proved stop')
        return process.returncode
    process.communicate=communicate;process.wait=wait
    def clock_now():
        clock_calls.append(None);oracle(len(clock_calls)<1000,'unbounded snapshot clock loop')
        if spawned and mode=='clock':raise injected
        value=1000
        if spawned and mode=='expired':value=1100
        if spawned and now_after is not None:value=now_after
        seen[0]=value;return value
    def popen(argv,**kwargs):
        oracle(argv==['node','-e','snapshot-program','after'],'unexpected verifier command')
        oracle(kwargs['start_new_session'] is True,'verifier ownership lost')
        spawned.append(process);events.append('spawn');return process
    def stop(owned,deadline):
        oracle(owned is process and deadline==stop_deadline,'snapshot cleanup changed custody or deadline')
        events.append('stop')
        if cleanup=='throw':raise OSError('fake stop clock failure')
        if cleanup=='false' or seen[0]>=deadline:return False
        if process.returncode is None:process.returncode=-15
        return True
    target=dict(clock_now=clock_now,subprocess=types.SimpleNamespace(Popen=popen,PIPE=-1,TimeoutExpired=TimeoutError),SNAPSHOT_PROGRAM='snapshot-program',POLL_SECONDS=.025,CLEANUP_RESERVE_SECONDS=5,
        stop_owned_processes=stop,wait_for_owned_children=lambda deadline:oracle(platform=='linux','Linux child wait ran on Darwin') or waits.append(deadline) or mode!='descendants',
        wait_for_group_exit=lambda owned,deadline:oracle(platform=='darwin' and owned is process,'Darwin group wait ran on Linux or for another process') or waits.append(deadline) or mode!='descendants',sys=types.SimpleNamespace(platform=platform),json=json,
        NO_VERDICT=literal(supervisor,'NO_VERDICT'),SNAPSHOT_STOP_RESERVE_SECONDS=literal(supervisor,'SNAPSHOT_STOP_RESERVE_SECONDS'))
    declarations(supervisor,{'capture_snapshot','SnapshotCleanupError','InvalidGateBudget'},target)
    failure=None;result=None
    try:
        try:result=target['capture_snapshot']('fake-root',{},'after',1100,types.SimpleNamespace(is_set=lambda:mode=='interrupted' or (mode=='interrupted-late' and bool(spawned))),stop_deadline=stop_deadline)
        except BaseException as error:failure=error
    finally:oracle(len(oracle_failures)==faults_before,'snapshot target absorbed a fixture oracle')
    if mode=='interrupted':
        assert not spawned and not events and isinstance(failure,InterruptedError) and result is None
        return waits
    assert len(spawned)==1 and process.stdout.closed and process.stderr.closed
    assert events.count('close-stdout')==events.count('close-stderr')==1
    if cleanup in ('false','throw','reap','close'):
        assert isinstance(failure,target['SnapshotCleanupError']) and result is None
    elif mode=='normal':assert failure is None and result=={'snapshot':'stable'} and 'stop' not in events
    else:
        assert failure is not None and not isinstance(failure,target['SnapshotCleanupError']) and result is None
        assert events.count('stop')==1 and events.count('reap')==1
        if mode in ('clock','communicate'):assert failure is injected
        elif mode=='parse':assert isinstance(failure,json.JSONDecodeError)
        elif mode=='interrupted-late':assert isinstance(failure,InterruptedError)
        elif mode in ('expired','descendants'):assert isinstance(failure,TimeoutError)
        elif mode=='budget':assert isinstance(failure,target['InvalidGateBudget'])
        elif mode=='noverdict':assert isinstance(failure,TimeoutError)
        elif mode=='failed':assert type(failure) is OSError
    if cleanup!='close':assert events.index('stop')<events.index('close-stdout') if mode!='normal' else True
    return waits
for mode in ('normal','clock','communicate','parse','interrupted','interrupted-late','expired','budget','noverdict','failed'):
    snapshot_case(mode);results.append('snapshot custody '+mode)
snapshot_case('descendants',platform='linux');results.append('snapshot Linux descendant failure keeps custody')
snapshot_case('descendants');results.append('snapshot Darwin descendant failure keeps custody')
for cleanup in ('false','throw','reap','close'):
    snapshot_case('clock',cleanup);results.append('snapshot cleanup uncertainty '+cleanup)
snapshot_case('normal','close');results.append('completed snapshot close failure cannot pass')
snapshot_case('expired',stop_deadline=1100,now_after=1099);results.append('snapshot leaves its stop a reserve when both bounds are one deadline')
for platform in ('linux','darwin'):
    assert snapshot_case('normal',platform=platform,stop_deadline=1100,now_after=1097)==[1098]
    assert snapshot_case('normal',platform=platform)==[1005]
results.append('snapshot descendant wait stays inside the stop reserve')
def before_site(function,platform,make_error):
    written=[];calls=[];stderr=io.StringIO();faults_before=len(oracle_failures)
    def capture(root,environment,phase,deadline,interrupted,*,stop_deadline):
        oracle(phase=='before' and deadline==1115 and stop_deadline==1120,'before snapshot window changed')
        calls.append(phase);raise make_error(target)
    def write(fd,data):
        oracle(fd==1,'no-verdict marker left the verdict channel');written.append(data);return len(data)
    target=dict(os=types.SimpleNamespace(write=write,getpid=lambda:4242),sys=types.SimpleNamespace(platform=platform,stdout=types.SimpleNamespace(fileno=lambda:1),stderr=stderr),
        clock_now=lambda:1000,capture_snapshot=capture,json=json,
        **{name:literal(supervisor,name) for name in ('SUPERVISOR_ENVIRONMENT','LINUX_SUBREAPER','DARWIN_LAUNCHD','SUPERVISOR_RECEIPT_ENVIRONMENT','SUPERVISOR_TOKEN_ENVIRONMENT','NO_VERDICT','CLEANUP_RESERVE_SECONDS')})
    declarations(supervisor,{function,'no_verdict','caller_budget','InvalidGateBudget','SnapshotCleanupError'},target)
    try:code=target[function](Path('fake-root'),['true'],{'APERTURE_GATE_TIME_LEFT_S':'120'},1000,types.SimpleNamespace(path='/fake/receipt',token='fake-token'),types.SimpleNamespace(is_set=lambda:False))
    finally:oracle(len(oracle_failures)==faults_before,'before snapshot target absorbed a fixture oracle')
    assert calls==['before']
    return code,written,stderr.getvalue()
for function,platform in (('run_supervised','linux'),('run_darwin_supervised','darwin')):
    code,written,err=before_site(function,platform,lambda t:OSError('cannot read the gate repository: injected'))
    assert code==98 and len(written)==1 and written[0].startswith(b'APERTURE-GATE-INDETERMINATE reason=setup: cannot read the gate repository'),(platform,code,written)
    code,written,err=before_site(function,platform,lambda t:t['InvalidGateBudget']('APERTURE_GATE_SLOWEST_RUN_S must be a positive whole number'))
    assert code==4 and written==[] and 'APERTURE_GATE_SLOWEST_RUN_S must be a positive whole number' in err,(platform,code,written,err)
    for make,reason in ((lambda t:TimeoutError('late'),'timeout'),(lambda t:InterruptedError('stopped'),'interrupted'),(lambda t:t['SnapshotCleanupError']('unknown'),'cleanup'),(lambda t:ValueError('bad'),'setup')):
        code,written,err=before_site(function,platform,make)
        assert code==98 and len(written)==1 and written[0].startswith(('APERTURE-GATE-INDETERMINATE reason='+reason+':').encode()),(platform,reason,code,written)
    results.append('before snapshot separates infrastructure no-verdicts from invalid input on '+platform)
def snapshot_callers():
    tree=ast.parse(supervisor);parents={child:node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
    found=[]
    for node in ast.walk(tree):
        if not isinstance(node,ast.Call) or not isinstance(node.func,ast.Name) or node.func.id!='capture_snapshot':continue
        ancestor=parents[node];handler=None;function=None
        while ancestor in parents:
            if handler is None and isinstance(ancestor,ast.Try):
                try_node=ancestor
                handler=next((h for h in ancestor.handlers if isinstance(h.type,ast.Name) and h.type.id=='SnapshotCleanupError'),None)
                assert handler is not None,'snapshot caller has no cleanup priority'
            if isinstance(ancestor,ast.FunctionDef):function=ancestor.name;break
            ancestor=parents[ancestor]
        found.append(function)
        assert handler is not None
        assert len(node.args)>4 and isinstance(node.args[4],ast.Name) and node.args[4].id=='interrupted','snapshot caller drops interruption'
        handled={n.id for h in try_node.handlers for n in ([h.type] if isinstance(h.type,ast.Name) else getattr(h.type,'elts',[])) if isinstance(n,ast.Name)}
        assert handled&{'InvalidGateBudget','Exception'},'snapshot caller lets a verifier error escape'
        bound=[k.value for k in node.keywords if k.arg=='stop_deadline']
        assert len(bound)==1 and isinstance(bound[0],ast.Name) and bound[0].id=='deadline','snapshot stop is not bounded by the caller deadline'
        window=node.args[3];phase=node.args[2].value
        assert isinstance(window,ast.Name) and window.id==('preflight_deadline' if phase=='before' else 'deadline'),'snapshot window changed'
        for prior in (None,'interrupted','timeout','stale'):
            error=OSError('owned verifier cleanup unknown')
            namespace=dict(error=error,snapshot_error=error,reason=prior,detail='prior',no_verdict=lambda reason,detail:(98,reason,detail))
            body=copy.deepcopy(handler.body)
            returns=any(isinstance(n,ast.Return) for stmt in body for n in ast.walk(stmt))
            if not returns:body.append(ast.Return(value=ast.Tuple(elts=[ast.Name(id='reason',ctx=ast.Load()),ast.Name(id='detail',ctx=ast.Load())],ctx=ast.Load())))
            fn=ast.FunctionDef(name='classify',args=ast.arguments(posonlyargs=[],args=[],vararg=None,kwonlyargs=[],kw_defaults=[],kwarg=None,defaults=[]),body=body,decorator_list=[],returns=None,type_comment=None)
            program=ast.fix_missing_locations(ast.Module(body=[fn],type_ignores=[]))
            exec(compile(program,'<actual snapshot cleanup handler>','exec'),namespace)
            outcome=namespace['classify']()
            assert outcome[1 if returns else 0]=='cleanup'
    assert sorted(found)==['run_darwin_supervised']+['run_supervised']*3
    guardian_tree=ast.parse(runner);guardian_parents={child:node for node in ast.walk(guardian_tree) for child in ast.iter_child_nodes(node)}
    shared=[node for node in ast.walk(guardian_tree) if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and node.func.attr=='capture_snapshot']
    assert len(shared)==1,'new guardian snapshot consumer requires explicit coverage'
    node=shared[0];ancestor=guardian_parents[node]
    while not isinstance(ancestor,ast.FunctionDef):ancestor=guardian_parents[ancestor]
    assert ancestor.name=='snapshot' and isinstance(node.func.value,ast.Name) and node.func.value.id=='owner'
    assert any(k.arg=='stop_deadline' for k in node.keywords)
case('four direct callers and the shared guardian snapshot owner retain cleanup coverage',snapshot_callers)
def inventory(texts):
    raw=[];primitive=[]
    for name,source in zip(('supervisor','runner','owner'),texts):
        tree=ast.parse(source)
        aliases={'time'}
        for node in ast.walk(tree):
            if isinstance(node,ast.Import):aliases.update(alias.asname or alias.name for alias in node.names if alias.name=='time')
        class Sites(ast.NodeVisitor):
            def __init__(self):self.context=[]
            def scoped(self,node):
                self.context.append(node.name);self.generic_visit(node);self.context.pop()
            visit_FunctionDef=scoped
            visit_AsyncFunctionDef=scoped
            visit_ClassDef=scoped
            def visit_Lambda(self,node):
                self.context.append('<lambda>');self.generic_visit(node);self.context.pop()
            def record(self,kind):
                (raw if kind=='monotonic' else primitive).append((name,tuple(self.context)))
            def visit_Attribute(self,node):
                if isinstance(node.value,ast.Name) and node.value.id in aliases and node.attr in ('monotonic','clock_gettime'):self.record(node.attr)
                self.generic_visit(node)
            def visit_ImportFrom(self,node):
                if node.module=='time':
                    for alias in node.names:
                        if alias.name in ('monotonic','clock_gettime'):self.record(alias.name)
            def visit_Call(self,node):
                if isinstance(node.func,ast.Name) and node.func.id=='getattr' and len(node.args)>1 and isinstance(node.args[0],ast.Name) and node.args[0].id in aliases and isinstance(node.args[1],ast.Constant) and node.args[1].value in ('monotonic','clock_gettime'):self.record(node.args[1].value)
                self.generic_visit(node)
        Sites().visit(tree)
    assert raw==[('supervisor',('clock_now',))] and primitive==[('owner',('clock_now',))]
inventory(sources)
for addition in ('\ntime.monotonic()\n','\ndef accidental_local_deadline():\n return time.monotonic()\n','\nclass AccidentalDeadline:\n def remaining(self):\n  return time.monotonic()\n','\ndef outer():\n def inner():\n  return time.monotonic()\n return inner\n','\naccidental=lambda:time.monotonic()\n'):
    refused=False
    try:inventory([supervisor,runner+addition,owner])
    except AssertionError:refused=True
    assert refused
results.append('module, free, nested, class-method and lambda raw clock sites are rejected')
print('DARWIN_DEADLINE_RESULT='+json.dumps({'cases':results,'realProcessStarts':0,'nativeQueries':0}))
`;

test('Darwin gate shared deadline survives startup and rejects mixed clock participants', { timeout: 40000 }, () => {
  const result = spawnSync(process.env.DISCORD_SURFACE_PYTHON || 'python3', ['-I', '-B', '-c', darwinDeadlineProgram,
    path.join(PROJECT, 'scripts/full-gate/supervisor.py'),
    path.join(PROJECT, 'scripts/full-gate/darwin-runner.py'),
    path.join(PROJECT, 'scripts/full-gate/darwin.py')
  ], { cwd: PROJECT, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  const line = result.stdout.split('\n').find(value => value.startsWith('DARWIN_DEADLINE_RESULT='));
  assert.ok(line, result.stdout);
  const report = JSON.parse(line.slice('DARWIN_DEADLINE_RESULT='.length));
  assert.equal(report.realProcessStarts, 0);
  assert.equal(report.nativeQueries, 0);
});

const darwinDisappearingPidProgram = String.raw`import ast,errno,io,json,math,struct,sys,types
import signal as fixture_signal
from pathlib import Path
fixture_signal.signal(fixture_signal.SIGALRM,fixture_signal.SIG_DFL)
fixture_signal.alarm(25)
SOURCE=Path(sys.argv[1]).read_text(encoding='utf-8')
RUNNER_SOURCE=Path(sys.argv[2]).read_text(encoding='utf-8')
MODE=sys.argv[3]
OWNER_NAMES={'CapabilityError','CoalitionGone','clock_now','require_clock_contract','process_identity','process_start','coalition_id','joined_identity','identity_if_present','same_process','task_counts','_coalition_members','_signal','signal_identity','_signal_members','_drained','drain'}
results=[]

class FakeArrayType:
    def __mul__(self, count):
        return lambda: [0] * count

class FakeClock:
    CLOCK_MONOTONIC = 1
    def __init__(self): self.value = 0
    def clock_gettime(self, clock):
        assert clock == self.CLOCK_MONOTONIC
        return self.monotonic()
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
    namespace = dict(errno=errno, struct=struct, ctypes=fake_ctypes, math=math, CLOCK_CONTRACT="CLOCK_MONOTONIC_V1",
        os=types.SimpleNamespace(getpid=lambda:500, strerror=lambda value:'mock errno '+str(value), environ={}),
        subprocess=types.SimpleNamespace(run=lambda *args,**kwargs:throw(AssertionError('unconfigured fake enumeration')),TimeoutExpired=TimeoutError),
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
    namespace['subprocess']=types.SimpleNamespace(run=run,TimeoutExpired=TimeoutError)
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
    expected=sorted([('owner','identity_if_present','joined_identity'),('owner','_coalition_members','identity_if_present'),('owner','_signal','identity_if_present'),('owner','_signal','identity_if_present'),('owner','_drained','identity_if_present'),('runner','controller_alive','identity_if_present'),('runner','quiescent','joined_identity'),('runner','run','joined_identity')])
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
    if expect_error:raises(lambda:namespace['_signal'](ident(),15,1),namespace['CapabilityError'])
    else:assert namespace['_signal'](ident(),15,1) is expected
    assert len(calls)==expected_calls
    if calls:assert calls[0][0][5]==101 and calls[0][0][7]==20 and calls[0][1]==15

def signal_unknown():
    namespace=owner(SOURCE);fake_lookup(namespace,[namespace['CapabilityError']('unknown')]);calls=fake_signal_api(namespace,0);raises(lambda:namespace['_signal'](ident(),15,1),namespace['CapabilityError']);assert calls==[]

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
    namespace=owner(SOURCE);states=[];spawns=[];drains=[];clock=FakeClock();lookups=[0]
    controller=ident(301,300);guardian=ident(401,400);before=scenario in ['before-gone','before-unknown']
    def lookup(pid):
        if pid==401:return guardian
        assert pid==301;lookups[0]+=1
        if not before and lookups[0]<=2:return controller
        if scenario=='before-unknown':raise namespace['CapabilityError']('unknown')
        raise gone()
    namespace['joined_identity']=lookup
    api=types.SimpleNamespace(**{key:value for key,value in namespace.items() if key in ['joined_identity','identity_if_present','same_process','CapabilityError','require_clock_contract','CLOCK_CONTRACT']})
    def drain(resource,deadline,preserve):
        drains.append((resource,deadline,preserve));assert resource==400 and deadline==10 and preserve==guardian
        if scenario=='drain-gone':raise gone()
        return before or scenario=='drain-true'
    api.drain=drain;api.clock_now=clock.monotonic
    spec={'state_path':'state','deadline':10,'run_deadline':5,'controller':controller,'ack_path':'ack','launch_token':'token','clock_contract':'CLOCK_MONOTONIC_V1','environment':{'APERTURE_GATE_TIME_LEFT_S':'5'},'command':['fake-child'],'cwd':'fake-root','snapshot_program':'pinned'}
    def fake_open(path,*args,**kwargs):
        assert path in ['spec','ack']
        return io.StringIO(json.dumps(spec) if path=='spec' else json.dumps({'launch_token':'token','clock_contract':'CLOCK_MONOTONIC_V1','identity':guardian,'sequence':1,'phase':'command','cancelled':False}))
    polls=[]
    def popen(*args,**kwargs):
        spawns.append((args,kwargs));assert args==(['fake-child'],) and kwargs['start_new_session'] is False
        def poll():polls.append(None);assert len(polls)<=10;return None
        return types.SimpleNamespace(pid=402,poll=poll)
    capability=types.SimpleNamespace(SnapshotCleanupError=OSError,InvalidGateBudget=ValueError,capture_snapshot=lambda *args,**kwargs:throw(AssertionError('controller loss must not start verification')))
    target=dict(json=json,math=math,open=fake_open,time=clock,Path=Path,SimpleNamespace=types.SimpleNamespace,__file__='/private/fixture/darwin-runner.py',os=types.SimpleNamespace(getpid=lambda:401),interrupted=False,receive_signal=lambda *args:None,
        signal=types.SimpleNamespace(SIGINT=2,SIGTERM=15,SIGHUP=1,signal=lambda *args:None),subprocess=types.SimpleNamespace(Popen=popen),
        write_state=lambda spec,value:states.append(dict(value)),DARWIN=api,
        importlib=types.SimpleNamespace(util=types.SimpleNamespace(spec_from_file_location=lambda *args:types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda module:None)),module_from_spec=lambda spec:capability)))
    extract(RUNNER_SOURCE,{'controller_alive','run','request','retirement_result','finish','snapshot'},target)
    # Kernel observation behavior is covered by the owner cases and hold fixture, not fabricated here.
    target['quiescent']=lambda identity:True
    assert target['run']('spec')==98
    assert states[-1]['code']==98 and states[-1]['sealed'] is True and states[-1]['quiescent'] is True
    if before:assert not spawns
    else:assert len(spawns)==1 and drains
    assert not any(row.get('phase')=='normal-after-complete' for row in states)

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
def active_deadline(mode,source=SOURCE):
    ns=owner(source);now=[0];sent=[];enumerations=[]
    def clock():
        if mode=='clock':raise ns['CapabilityError']('clock unreadable')
        return now[0]
    ns['clock_now']=clock
    def enumerate_members(argv,**kwargs):
        enumerations.append(kwargs['timeout'])
        if mode=='ps-timeout':raise TimeoutError('ps exceeded original deadline')
        return types.SimpleNamespace(returncode=0,stdout='101 102')
    ns['subprocess']=types.SimpleNamespace(run=enumerate_members,TimeoutExpired=TimeoutError)
    def lookup(pid):
        if mode=='identity':now[0]=1
        return ident(pid)
    ns['identity_if_present']=lookup
    def send(token,number):
        sent.append(token[5])
        if mode=='between':now[0]=1
        return 0
    ns['_apis']=lambda:(None,None,send)
    if mode in ('expired','equal'):now[0]=1 if mode=='equal' else 2
    if mode in ('expired','equal','clock','ps-timeout'):
        raises(lambda:ns['_coalition_members'](700,1),ns['CapabilityError'])
        assert len(enumerations)==(1 if mode=='ps-timeout' else 0) and sent==[]
    elif mode=='identity':
        raises(lambda:ns['_signal'](ident(),15,1),ns['CapabilityError'])
        assert sent==[]
    elif mode=='between':
        raises(lambda:ns['_signal_members'](700,15,1),ns['CapabilityError'])
        assert sent==[101] and enumerations==[1]
    else:
        ns['_signal_members'](700,15,1)
        assert sent==[101,102] and enumerations==[1]
for mode in ('expired','equal','clock','ps-timeout','identity','between','valid'):
    case('active side effect retains original deadline '+mode,lambda mode=mode:active_deadline(mode))
def deadline_mutation():
    old='    if deadline is not None and not clock_now() < deadline:\n        raise CapabilityError("identity-safe signal exceeded the caller deadline")\n'
    assert SOURCE.count(old)==1
    try:active_deadline('identity',SOURCE.replace(old,''))
    except AssertionError:return
    raise AssertionError('removing final signal clock guard escaped oracle')
case('removing final token-signal deadline check is detected',deadline_mutation)
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
    assert.equal(entry.split(importMarker).length - 1, 4, 'unclassified supervisor source import');
    for (const name of importTests) {
      const begin = entry.indexOf("test('" + name + "',");
      assert.ok(begin >= 0, name);
      const next = entry.indexOf('\ntest(', begin + 1);
      const body = entry.slice(begin, next < 0 ? undefined : next);
      assert.equal(body.split(importMarker).length - 1, 1, name);
      assert.match(body, /spawn(?:Sync)?\('python3', \[\s*'-I', '-B', '-c', script, SUPERVISOR_SCRIPT/);
    }
    const guardianName = 'Darwin guardian retains an after verifier when its outer controller dies';
    const guardianBegin = entry.indexOf("test('" + guardianName + "',");
    assert.ok(guardianBegin >= 0, guardianName);
    const guardianNext = entry.indexOf('\ntest(', guardianBegin + 1);
    const guardianBody = entry.slice(guardianBegin, guardianNext < 0 ? undefined : guardianNext);
    assert.equal(guardianBody.split(importMarker).length - 1, 1, guardianName);
    const suppression = guardianBody.indexOf("'sys.dont_write_bytecode = True'");
    assert.ok(suppression >= 0 && suppression < guardianBody.indexOf(importMarker), 'guardian fixture must suppress bytecode before Source import');
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
  const withoutGuardianSuppression = entrySource.replace("    'sys.dont_write_bytecode = True',\n", '');
  assert.notEqual(withoutGuardianSuppression, entrySource);
  assert.throws(() => verify(withoutGuardianSuppression, identitySource));
});

function watchdogCollectorLifecycleTests({ test, assert, vm, EventEmitter, watchdogSource, collectorSource, evidenceInventory, gate }) {
  test('watchdog collection keeps cancellation live and phase evidence fresh', { timeout: 45000 }, async t => {
    const flush = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
    function harness(options = {}) {
      const selectedSource = options.source ?? watchdogSource;
      const source = options.psMonitor ? selectedSource.replace("process.platform === 'darwin' && phase.kind === 'monitor'", 'false') : selectedSource;
      const deadlines = [String(options.deadline ?? 10000)];
      if (source.includes('const [deadline, callerDeadline, leader, entry, ...args]')) deadlines.push(String(options.cleanupDeadline ?? (Number(options.deadline ?? 10000) + 5000)));
      let now = 0;
      let wallOffset = 0;
      let timerId = 0;
      let childId = 100;
      const timers = new Map();
      const children = [];
      const starts = {};
      const ends = [];
      const signals = [];
      const packets = [];
      const exits = [];
      let releases = 0;
      const schedule = (fn, delay, interval = false) => {
        const id = ++timerId;
        const duration = Number.isFinite(delay) && delay >= 0 ? delay : 1;
        timers.set(id, { id, fn, at: now + duration, interval: interval ? duration : 0 });
        return { id, unref() {} };
      };
      const clear = handle => timers.delete(handle?.id);
      class Child extends EventEmitter {
        constructor() {
          super();
          this.pid = ++childId;
          this.stdout = new EventEmitter();
          this.stderr = new EventEmitter();
          this.connected = true;
          this.closed = false;
          this.sent = [];
          this.signals = [];
        }
        kill(signal) {
          this.signals.push({ signal, at: now });
          if (options.childKillThrows) throw Object.assign(new Error('fixture'), { code: 'EPERM' });
          return true;
        }
        send(packet, callback) {
          this.sent.push(packet);
          if (options.bodySendThrows) throw Object.assign(new Error('fixture'), { code: 'EPIPE' });
          callback?.(options.bodyCallbackError ? { code: 'EPIPE' } : undefined);
        }
      }
      const admission = new Child();
      const body = new Child();
      const proc = new EventEmitter();
      Object.assign(proc, {
        argv: ['node', 'watchdog', ...deadlines, '20', 'body.js'],
        platform: options.platform ?? 'darwin', pid: 10, env: {}, connected: true,
        kill(pid, signal) {
          signals.push({ pid, signal, at: now });
          if (options.groupKillThrows) throw Object.assign(new Error('fixture'), { code: 'EPERM' });
        },
        exit(code) { exits.push(code); },
        send(packet, callback) {
          packets.push(packet);
          if (packet.kind === 'STOP' && options.diagnosticThrows) throw new Error('fixture');
          if (packet.kind === 'BODY_SCAN_COMPLETE') {
            body.sent.push(packet);
            if (options.bodySendThrows) throw Object.assign(new Error('fixture'), { code: 'EPIPE' });
            callback?.(options.bodyCallbackError ? { code: 'EPIPE' } : undefined);
          } else callback?.();
          if (packet.kind === 'CUSTODY' && packet.state === 'BEGIN' && !options.noCustodyAck) proc.emit('message', { kind: 'CUSTODY', state: 'ACK', phase: packet.phase });
        }
      });
      body.on('message', packet => proc.emit('message', packet));
      body.on('close', code => proc.emit('message', { kind: 'BODY_EXIT', code }));
      const spawn = (command, args, opts) => {
        assert.ok(children.length < 32, 'fixed mock child limit');
        assert.equal(opts.env.LC_ALL, 'C');
        assert.deepEqual(Array.from(opts.stdio), ['ignore', 'pipe', 'pipe']);
        if (options.spawnThrows) throw Object.assign(new Error('fixture'), { code: options.spawnErrorCode || 'EIO' });
        const child = new Child();
        Object.assign(child, { command, args, opts });
        children.push(child);
        return child;
      };
      const globals = {
        Buffer, Date: { now: () => now + wallOffset }, performance: { now: () => now },
        setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: clear,
        setInterval: (fn, delay) => schedule(fn, delay, true), clearInterval: clear
      };
      const module = { exports: {} };
      vm.runInNewContext(collectorSource, { ...globals, module }, { timeout: 1000 });
      const factory = module.exports.createWatchdogCollector;
      module.exports.createWatchdogCollector = options => {
        const owner = factory(options);
        const begin = owner.begin;
        owner.begin = end => { ends.push(end); return begin(end); };
        return owner;
      };
      const vocabulary = new Proxy({}, { get: (_, key) => key });
      const context = vm.createContext({
        ...globals, process: proc, __dirname: '/fixture/scripts',
        require(name) {
          if (name === 'node:child_process') return { spawn, fork() { assert.fail('guardian cannot spawn a body'); }, spawnSync() { assert.fail('synchronous collection'); } };
          if (name === 'node:fs') return { readFileSync() { assert.fail('unexpected filesystem access'); } };
          if (name === 'node:os') return { constants: { signals: { SIGTERM: 15, SIGKILL: 9 } } };
          if (name === 'node:path') return { join: (...parts) => parts.join('/') };
          if (name === './full-gate/watchdog-collector') return module.exports;
          if (name === './full-gate') return {
            MESSAGES: vocabulary, CUSTODY: vocabulary, WATCHDOG_STOP_EVENTS: vocabulary, NO_VERDICT: 98,
            NO_VERDICT_SECRET: 'secret', SCRATCH_ROOT: 'scratch', REASONS: {},
            canFinish: stopping => !stopping,
            gateSyscallObservation: value => ({ ...value }),
            watchdogStopObservation: value => ({ ...value, upstreamOrigin: 'UNKNOWN' }),
            releaseScratch() { releases++; return true; }
          };
          assert.fail('unexpected import ' + name);
        }
      });
      vm.runInContext(source, context, { timeout: 1000 });
      const inspect = expression => vm.runInContext(expression, context, { timeout: 1000 });
      Object.defineProperties(starts, { admission: { enumerable: true, get: () => inspect('Number(admission)') }, body: { enumerable: true, get: () => inspect('Number(body)') } });
      const respond = async (child, output, code = 0) => {
        assert.ok(child && !child.closed, 'one close per mock child');
        if (output) child.stdout.emit('data', Buffer.from(output));
        child.closed = true;
        child.emit('close', code, null);
        await flush();
      };
      const table = (child, extra = '') => '10 20 20 S\n20 1 20 S\n' + extra + child.pid + ' 10 20 S\n';
      const pending = () => children.find(child => !child.closed);
      return {
        children, starts, ends, signals, packets, exits, body, proc, inspect, respond, table, pending,
        owner: inspect('collector'), failureOrigins: module.exports.COLLECTOR_FAILURE_ORIGINS,
        elapseWithoutTimers(duration) { now += duration; },
        shiftWall(duration) { wallOffset += duration; },
        releases: () => releases,
        queue: (delay, callback) => schedule(callback, delay),
        async start() {
          proc.emit('message', { kind: 'ADMIT', command: 'admit', args: [] });
          proc.emit('message', { kind: 'ADMISSION_EXIT', code: 0 });
          proc.emit('message', { kind: 'START' });
          await flush();
        },
        async advance(duration) {
          const target = now + duration;
          let steps = 0;
          for (;;) {
            const next = [...timers.values()].filter(timer => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
            if (!next) break;
            assert.ok(++steps <= 256, 'fixed timer-step limit');
            now = next.at;
            if (next.interval) next.at += next.interval;
            else timers.delete(next.id);
            next.fn();
            await flush();
          }
          now = target;
          await flush();
        }
      };
    }
    const stopCount = h => h.signals.filter(value => value.pid === -20 && value.signal === 'SIGTERM').length;
    const ackCount = h => h.body.sent.filter(value => value.kind === 'BODY_SCAN_COMPLETE').length;
    const escape = '21 20 20 S\n30 21 30 S\n';

    await t.test('C19 native monitoring retains custody until fresh complete boundary scans', async () => {
      const h = harness(); await h.start(); await h.advance(1000);
      const monitor = h.pending();
      await h.respond(monitor, h.table(monitor));
      assert.equal(h.packets.filter(packet => packet.kind === 'CUSTODY' && packet.state === 'CLEAR').length, 0);
      assert.equal(monitor.command, 'python3');
      const codeIndex = monitor.args.indexOf('-c');
      assert.notEqual(codeIndex, -1);
      assert.deepEqual(Array.from(monitor.args.slice(0, codeIndex)), ['-I', '-S', '-B']);
      assert.deepEqual(Array.from(monitor.args.slice(codeIndex + 2)), ['--table', String(h.inspect('group')), String(h.inspect('process.pid'))]);
      assert.equal(h.packets.filter(packet => packet.kind === 'CLEANUP_COMPLETE').length, 0);
      h.body.emit('message', { kind: 'BODY_COMPLETE' }); await flush();
      const complete = h.pending();
      assert.equal(complete.command, 'ps');
      assert.equal(ackCount(h), 0);
      await h.respond(complete, h.table(complete));
      assert.equal(ackCount(h), 1);
      h.body.emit('close', 0, null); h.proc.emit('message', { kind: 'DRAIN' }); await flush();
      const drain = h.pending();
      assert.equal(drain.command, 'ps');
      assert.equal(h.exits.length, 0);
      await h.respond(drain, h.table(drain));
      assert.deepEqual(h.exits, [0]);
    });
    await t.test('C19 Linux monitoring retains the existing complete process-table path', async () => {
      const h = harness({ platform: 'linux' }); await h.start(); await h.advance(1000);
      const monitor = h.pending();
      assert.equal(monitor.command, 'ps');
      await h.respond(monitor, h.table(monitor));
      assert.equal(h.packets.filter(packet => packet.kind === 'CUSTODY' && packet.state === 'CLEAR').length, 1);
    });
    await t.test('C19 missing native rows never retire remembered escaped identities', async () => {
      const h = harness(); await h.start(); await h.advance(1000);
      const monitor = h.pending(); await h.respond(monitor, h.table(monitor, '21 20 20 S\n30 21 30 S darwin:1:1:30:1\n'));
      await h.advance(1000);
      const partial = h.pending(); await h.respond(partial, h.table(partial));
      assert.equal(h.inspect('escapedDescendants.get(30)'), 'darwin:1:1:30:1');
      assert.equal(h.packets.filter(packet => packet.kind === 'CUSTODY' && packet.state === 'CLEAR').length, 0);
      assert.deepEqual(h.exits, []);
    });
    await t.test('C24 reparented PID-only successors remain unresolved', async () => {
      const h = harness(); await h.start(); await h.advance(1000);
      const first = h.pending(); await h.respond(first, h.table(first, escape));
      assert.equal(h.inspect('escapedDescendants.get(30)'), null);
      await h.advance(1000);
      const next = h.pending();
      assert.equal(next.args.at(-1), '30');
      await h.respond(next, h.table(next, '30 1 30 S darwin:1:1:30:1\n'));
      assert.equal(h.pending(), undefined, 'reparented native adoption launches no identity successor');
      assert.equal(h.inspect('escapedDescendants.get(30)'), null);
      await h.advance(1000);
      const resolved = h.pending();
      assert.equal(resolved.args.includes('30'), true);
      await h.respond(resolved, h.table(resolved));
      assert.equal(h.inspect('escapedDescendants.get(30)'), null);
      assert.equal(h.packets.some(packet => packet.kind === 'CUSTODY' && packet.state === 'CLEAR'), false);
    });
    await t.test('unresolved group-only and generic PID successors never gain ownership', async () => {
      const run = async (source, native, pgid) => {
        const h = harness({ source }); await h.start();
        h.inspect("escapedDescendants.set(30,null); globalThis.fixturePhase=beginObservation('monitor');" +
          "fixturePhase.nativeMonitor=" + native + ";globalThis.fixtureRows=[" +
          "{pid:10,parent:1,pgid:10,state:'S'},{pid:20,parent:1,pgid:20,state:'S'}," +
          "{pid:30,parent:1,pgid:" + pgid + ",state:'S'}];" +
          "globalThis.fixtureToken=Object.freeze({phase:fixturePhase,generation:fixturePhase.generation,rows:fixtureRows,identities:new Map([[30,'darwin:1:1:30:9']])});" +
          "fixturePhase.monitorIdentities=fixtureToken;readProcessIdentities=async pids=>new Map(pids.map(pid=>[pid,'darwin:1:1:30:9']));");
        await h.inspect('rememberEscapedDescendants(fixtureRows,fixturePhase,fixtureToken)');
        assert.equal(h.inspect('escapedDescendants.get(30)'), null);
        await h.inspect("signalEscapedDescendants('SIGTERM',fixtureRows,fixturePhase)");
        assert.equal(h.signals.some(value => value.pid === 30), false);
        assert.equal(await h.inspect('hasLiveEscapedDescendants(fixtureRows,fixturePhase)'), true);
      };
      for (const native of [true,false]) {
        for (const pgid of [20,30]) await run(watchdogSource,native,pgid);
      }
      const guard='identity === null && descendants.has(pid)';
      assert.equal(watchdogSource.split(guard).length,2);
      for (const native of [true,false]) {
        await assert.rejects(run(watchdogSource.replace(guard,'identity === null'),native,30),assert.AssertionError);
      }
    });
    await t.test('each escaped-PID signal rechecks its original phase', async () => {
      const run=async source=>{
        const h=harness({source});await h.start();
        h.inspect("escapedDescendants.set(30,'birth30');escapedDescendants.set(31,'birth31');" +
          "globalThis.fixturePhase=beginObservation('monitor');globalThis.fixtureRows=[{pid:30,state:'S'},{pid:31,state:'S'}];" +
          "readProcessIdentities=async pids=>new Map(pids.map(pid=>[pid,'birth'+pid]));");
        const kill=h.proc.kill;
        h.proc.kill=(pid,signal)=>{kill(pid,signal);if(pid===30)h.elapseWithoutTimers(1000);};
        await h.inspect("signalEscapedDescendants('SIGTERM',fixtureRows,fixturePhase)");
        assert.deepEqual(h.signals.map(value=>value.pid),[30]);
      };
      await run(watchdogSource);
      const guard='for (const [pid, expected] of candidates) {\n    if (!currentObservation(phase)) return;';
      assert.equal(watchdogSource.split(guard).length,2);
      await assert.rejects(run(watchdogSource.replace(guard,'for (const [pid, expected] of candidates) {')),assert.AssertionError);
    });
    await t.test('C25 native adoption uses one subprocess and keeps cleanup identity fresh', async () => {
      const run = async source => {
        const h = harness({ source }); await h.start(); await h.advance(1000);
        const scan = h.pending(); await h.advance(595);
        await h.respond(scan, h.table(scan, '21 20 20 S\n30 21 30 S darwin:1:1:30:1\n'));
        assert.equal(h.children.length, 1, 'one monitor subprocess owns both row and identity');
        assert.equal(h.inspect('escapedDescendants.get(30)'), 'darwin:1:1:30:1');
        assert.equal(h.owner.owned(), false);
        assert.equal(h.packets.some(packet => packet.kind === 'CUSTODY' && packet.state === 'CLEAR'), false);
        h.proc.emit('SIGTERM'); await flush();
        const cleanup = h.pending(); assert.equal(cleanup.command, 'ps');
        await h.respond(cleanup, h.table(cleanup, '30 1 30 S\n'));
        const fresh = h.pending(); assert.equal(fresh.command, 'python3');
        assert.equal(fresh.args.includes('--table'), false);
        await h.respond(fresh, '{"30":"1:1:30:2"}');
        assert.equal(h.signals.some(value => value.pid === 30), false, 'stale adoption identity cannot authorize a signal');
        return fresh;
      };
      const identity = await run(watchdogSource);
      const codeIndex = identity.args.indexOf('-c');
      assert.notEqual(codeIndex, -1);
      const startup = spawnSync(process.env.DISCORD_SURFACE_PYTHON || identity.command, [
        ...identity.args.slice(0, codeIndex), '-c',
        'import signal, sys\nsignal.alarm(8)\nprint(sys.flags.isolated, sys.flags.no_site, sys.flags.dont_write_bytecode, int("site" in sys.modules), *sys.argv[1:])',
        ...identity.args.slice(codeIndex + 2)
      ], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
      assert.equal(startup.status, 0, startup.stderr || startup.error?.message);
      assert.equal(startup.stdout.trim(), '1 1 1 0 30');
      const site = 'if (phase.nativeMonitor) {';
      assert.equal(watchdogSource.split(site).length, 2);
      await assert.rejects(run(watchdogSource.replace(site, 'if (false) {')), error =>
        error instanceof assert.AssertionError && /one monitor subprocess/.test(error.message));
    });
    await t.test('C25 missing and malformed native identities stay unresolved without another process', async () => {
      for (const value of ['', ' darwin:0:1:30:1', ' darwin:1:1000000:30:1', ' invalid']) {
        const h = harness(); await h.start(); await h.advance(1000);
        const scan = h.pending();
        await h.respond(scan, h.table(scan, '21 20 20 S\n30 21 30 S' + value + '\n'));
        assert.equal(h.inspect('escapedDescendants.get(30)'), null);
        assert.equal(h.children.length, 1);
        assert.equal(h.owner.owned(), false);
        assert.equal(h.packets.some(packet => packet.kind === 'CUSTODY' && packet.state === 'CLEAR'), false);
        assert.equal(stopCount(h), 0);
      }
    });
    await t.test('C27 unresolved native identities still resolve after rejoining the original group', async () => {
      const h = harness(); await h.start(); await h.advance(1000);
      let scan = h.pending(); await h.respond(scan, h.table(scan, escape));
      assert.equal(h.inspect('escapedDescendants.get(30)'), null);
      assert.equal(h.children.length, 1);
      await h.advance(1000); scan = h.pending();
      assert.equal(scan.args.at(-1), '30');
      await h.respond(scan, h.table(scan, '21 20 20 S\n30 21 20 S darwin:1:1:30:1\n31 20 20 S darwin:1:1:31:1\n'));
      assert.equal(h.inspect('escapedDescendants.get(30)'), 'darwin:1:1:30:1');
      assert.equal(h.inspect('escapedDescendants.has(31)'), false, 'an unrequested in-group row cannot seed ownership');
      assert.equal(h.children.length, 2);
      assert.equal(h.packets.some(packet => packet.kind === 'CUSTODY' && packet.state === 'CLEAR'), false);
    });
    await t.test('C27 a new native monitor clears old identity diagnostics without inventing a query', async () => {
      const h = harness();
      h.inspect("identityObservation = {outcome:'command-failed',errorCode:'ETIMEDOUT',failureOrigin:'phase-timer'}");
      await h.start(); await h.advance(1000);
      assert.equal(h.inspect('identityObservation'), null, 'old phase identity evidence is cleared before the new table');
      const scan = h.pending(); await h.respond(scan, h.table(scan));
      assert.equal(h.inspect('identityObservation'), null, 'inline adoption is not reported as a separate subprocess');
      assert.equal(h.children.length, 1);
    });
    await t.test('C28 positive native ancestry without a coherent later identity stays held', async () => {
      const h = harness(); await h.start(); await h.advance(1000);
      const scan = h.pending();
      await h.respond(scan, h.table(scan, '60 20 60 ?\n'));
      assert.equal(h.inspect('escapedDescendants.get(60)'), null);
      assert.equal(h.inspect('escapedDescendants.has(60)'), true, 'the first positive row still discovers the escaped child');
      assert.equal(h.children.length, 1, 'mismatched identity never starts a successor query');
      assert.equal(h.packets.some(packet => packet.kind === 'CUSTODY' && packet.state === 'CLEAR'), false);
      assert.equal(h.packets.some(packet => packet.kind === 'CLEANUP_COMPLETE'), false);
      assert.deepEqual(h.exits, []);
    });
    await t.test('C26 monitor adoption rejects a missing or stale phase snapshot', async () => {
      for (const mode of ['missing', 'foreign', 'generation', 'rows']) {
        const h = harness();
        await h.inspect(`(async () => {
          globalThis.fixturePhase = beginObservation('monitor');
          fixturePhase.nativeMonitor = true;
          const rows = [{pid:30,parent:20,pgid:30,state:'S'}];
          const captured = {phase:fixturePhase,generation:fixturePhase.generation,rows,identities:new Map([[30,'darwin:1:1:30:1']])};
          fixturePhase.monitorIdentities = captured;
          const supplied = ${JSON.stringify(mode)} === 'missing' ? undefined
            : ${JSON.stringify(mode)} === 'foreign' ? {...captured}
            : captured;
          if (${JSON.stringify(mode)} === 'generation') captured.generation += 1;
          await rememberEscapedDescendants(${JSON.stringify(mode)} === 'rows' ? [...rows] : rows, fixturePhase, supplied);
        })()`);
        assert.equal(h.inspect('escapedDescendants.get(30)'), null, mode);
        assert.equal(h.children.length, 0, mode);
        h.inspect('finishObservation(fixturePhase)');
      }
    });
    await t.test('C21 a stalled PS query cannot stop monitoring but still blocks completion', async () => {
      const predicate = "process.platform === 'darwin' && phase.kind === 'monitor'";
      assert.equal(watchdogSource.split(predicate).length, 2, 'one monitor selection owner');
      const psControl = watchdogSource.replace(predicate, 'false');
      for (const scenario of [
        { source: watchdogSource, stoppedDuringMonitor: 0 },
        { source: psControl, stoppedDuringMonitor: 1 }
      ]) {
        const h = harness({ source: scenario.source });
        await h.start(); await h.advance(1000);
        const first = h.pending();
        if (first.command !== 'ps') await h.respond(first, h.table(first));
        await h.advance(1000);
        assert.equal(stopCount(h), scenario.stoppedDuringMonitor);
        assert.equal(h.packets.some(packet => packet.kind === 'CLEANUP_COMPLETE'), false);
        if (scenario.stoppedDuringMonitor) continue;
        const second = h.pending(); await h.respond(second, h.table(second));
        h.body.emit('message', { kind: 'BODY_COMPLETE' }); await flush();
        assert.equal(h.pending().command, 'ps');
        await h.advance(1000);
        assert.equal(stopCount(h), 1, 'the unchanged completion query still expires');
        assert.equal(ackCount(h), 0);
        assert.equal(h.packets.some(packet => packet.kind === 'CLEANUP_COMPLETE'), false);
      }
    });
    await t.test('C20 native metadata refuses query faults without treating unknown state as dead', async () => {
      const h = harness(); await h.start(); await h.advance(1000);
      const monitor = h.pending();
      const codeIndex = monitor.args.indexOf('-c');
      assert.notEqual(codeIndex, -1);
      const prefix = Array.from(monitor.args.slice(0, codeIndex));
      const script = monitor.args[codeIndex + 1];
      const program = String.raw`
import signal
signal.alarm(8)
import sys
startup = (sys.flags.isolated, sys.flags.no_site, sys.flags.dont_write_bytecode, 'site' in sys.modules)
if startup != (1, 1, 1, False):
    raise AssertionError('unexpected metadata startup ' + repr(startup))

import contextlib
import ctypes
import errno
import io
import json
import os
import struct

source = sys.argv[1]
original_loader = ctypes.CDLL
original_argv = sys.argv
original_parent = os.getppid

def run(mode, program=source):
    pids = [0, 10, 20, 30, 40, 50, 60, 70]
    looked_up = []
    unique_reads = {}
    def listing(buffer, length):
        assert ctypes.get_errno() == 0
        if buffer is None:
            return 0 if mode == 'zero-count' else -1 if mode == 'negative-count' else len(pids)
        if mode == 'zero-fill':
            return 0
        if mode == 'truncated':
            return len(buffer)
        values = [0, 10, 20] if mode == 'partial' else [-1] if mode == 'negative-pid' else pids
        for index, pid in enumerate(values):
            buffer[index] = pid
        return len(values)
    def children(kind, parent, buffer, length):
        assert kind == 6 and length == ctypes.sizeof(buffer)
        assert ctypes.get_errno() == 0
        if mode == 'child-error':
            ctypes.set_errno(errno.EPERM)
            return -1
        if mode == 'child-truncated':
            return length
        if mode == 'child-short':
            return 3
        values = {20: [10, 30], 30: [40]}.get(parent, [])
        if mode == 'child-negative':
            values = [-1]
        if mode == 'birth' and parent == 20:
            values = values + [80]
        if mode == 'cycle' and parent == 10:
            values = [20]
        for index, pid in enumerate(values):
            buffer[index] = pid
        return len(values) * ctypes.sizeof(ctypes.c_int)
    def metadata(pid, flavor, argument, buffer, length):
        if flavor == 17:
            assert argument == 0 and length == 56
            unique_reads[pid] = unique_reads.get(pid, 0) + 1
            if mode == 'identity-missing':
                return 0
            raw = bytearray(56)
            unique = pid * 100 + (unique_reads[pid] if mode == 'identity-changed' else 0)
            struct.pack_into('=Q', raw, 16, unique)
            struct.pack_into('=i', raw, 32, 1)
            ctypes.memmove(buffer, bytes(raw), 56)
            return 56
        if flavor == 3:
            info = buffer._obj
            assert argument == 0 and length == ctypes.sizeof(info)
            if mode == 'identity-short':
                return 0
            info.pbi_pid = pid + 1 if mode == 'identity-wrong-pid' else pid
            info.pbi_ppid = 1 if pid == 60 else 20
            info.pbi_pgid = 20 if mode == 'rejoined' and pid == 60 else pid
            info.pbi_status = 255 if mode == 'unknown' else 2
            if pid == 60:
                if mode in ['row-group', 'row-zombie', 'row-status']:
                    info.pbi_ppid = 20
                if mode == 'row-group':
                    info.pbi_pgid = 20
                if mode == 'row-zombie':
                    info.pbi_status = 5
                if mode == 'row-status':
                    info.pbi_status = 255
            info.pbi_start_tvsec = 0 if mode == 'identity-zero-start' else 100
            info.pbi_start_tvusec = 1000000 if mode == 'identity-bad-usec' else 1
            return length
        assert flavor == 13 and argument == 0 and length == 64
        assert ctypes.get_errno() == 0
        looked_up.append(pid)
        if pid in [50, 70]:
            raise OSError(errno.ETIMEDOUT, 'unrelated process transition')
        if pid == 40:
            ctypes.set_errno(errno.EPERM if mode == 'permission' else errno.ESRCH)
            return 32 if mode == 'short-esrch' else 0
        if mode == 'short':
            return 32
        parent, group, state = {10: (20, 20, 2), 20: (1, 20, 0), 30: (20, 30, 5), 60: (1, 60, 2)}[pid]
        if mode == 'rejoined' and pid == 60:
            group = 20
        if mode in ['row-reparent', 'row-group', 'row-zombie', 'row-status'] and pid == 60:
            parent = 20
        if mode == 'unknown':
            state = 255
        raw = struct.pack('=IIII', pid + 1 if mode == 'wrong-pid' else pid, parent, group, state) + bytes(48)
        ctypes.memmove(buffer, raw, 64)
        return 64
    class Library:
        pass
    library = Library()
    library.proc_listallpids = listing
    library.proc_listpids = children
    library.proc_pidinfo = metadata
    output = io.StringIO()
    failed = False
    ctypes.CDLL = lambda *args, **kwargs: library
    sys.argv = ['fixture', '--table', '20', '10', '60']
    os.getppid = lambda: 11 if mode == 'caller-changed' else 10
    try:
        with contextlib.redirect_stdout(output):
            try:
                exec(compile(program, '<actual native collector>', 'exec'), {})
            except SystemExit as error:
                assert error.code == 0
            except (OSError, ValueError):
                failed = True
    finally:
        ctypes.CDLL = original_loader
        sys.argv = original_argv
        os.getppid = original_parent
    return failed, output.getvalue(), looked_up

def output(mode, program=source):
    failed, text, looked_up = run(mode, program)
    lines = text.splitlines()
    return failed, [line for line in lines if not line.startswith('WQ')], [line for line in lines if line.startswith('WQ')], looked_up

complete = ['WQ1', 'WQ2', 'WQ3', 'WQ4']
normal_rows = ['10 20 20 ?', '20 1 20 ?', '30 20 30 Z', '60 1 60 ? darwin:100:1:6000:1']
assert output('normal') == (False, normal_rows, complete, [10, 20, 30, 40, 60])
assert output('partial') == (False, ['10 20 20 ?', '20 1 20 ?'], complete, [10, 20])
assert output('unknown') == (False, ['10 20 20 ?', '20 1 20 ?', '30 20 30 ? darwin:100:1:3000:1', '60 1 60 ? darwin:100:1:6000:1'], complete, [10, 20, 30, 40, 60])
assert output('rejoined') == (False, ['10 20 20 ?', '20 1 20 ?', '30 20 30 Z', '60 1 20 ? darwin:100:1:6000:1'], complete, [10, 20, 30, 40, 60])
assert output('birth') == output('normal'), 'new births outside the initial PID set remain partial'
assert output('cycle') == output('normal'), 'parent-list cycles must stay bounded'
site = 'for pid in sorted(candidates):'
assert source.count(site) == 1
control = source.replace(site, 'for pid in sorted(all_pids):')
assert output('normal', control)[0] is True
assert 50 in output('normal', control)[3], 'global lookup control must reach the unrelated blocked PID'
faults = ['zero-count', 'negative-count', 'zero-fill', 'truncated', 'negative-pid',
          'permission', 'short', 'short-esrch', 'wrong-pid',
          'child-error', 'child-truncated', 'child-short', 'child-negative', 'caller-changed']
for mode in faults:
    failed, rows, checkpoints, _ = output(mode)
    assert failed and rows == [], mode
    assert checkpoints == complete[:3 if mode in ['permission', 'short', 'short-esrch', 'wrong-pid'] else 2], mode
identity_faults = ['identity-missing', 'identity-short', 'identity-changed', 'identity-wrong-pid', 'identity-zero-start', 'identity-bad-usec']
for mode in identity_faults:
    assert output(mode) == (False, ['10 20 20 ?', '20 1 20 ?', '30 20 30 Z', '60 1 60 ?'], complete, [10, 20, 30, 40, 60]), mode
mismatch_modes = ['row-reparent', 'row-group', 'row-zombie', 'row-status']
positive_rows = ['10 20 20 ?', '20 1 20 ?', '30 20 30 Z', '60 20 60 ?']
for mode in mismatch_modes:
    assert output(mode) == (False, positive_rows, complete, [10, 20, 30, 40, 60]), mode
row_guard = '== (pid, parent, group, status)'
assert source.count(row_guard) == 1
row_control = source.replace(row_guard, '!= ()')
assert output('row-reparent', row_control)[1][-1] == '60 20 60 ? darwin:100:1:6000:1', 'guard removal must adopt the conflicting later identity'
identity_guard = 'before != after or info.pbi_pid != pid'
assert source.count(identity_guard) == 1
identity_control = source.replace(identity_guard, 'False or info.pbi_pid != pid')
assert output('identity-changed', identity_control)[1][-1].endswith('darwin:100:1:6001:1'), 'guard removal must admit the mismatched identity in the control'
print(json.dumps({'faults': len(faults), 'identityFaults': len(identity_faults), 'guardedNativeIdentity': True, 'liveUnknownAndZombie': True, 'partialIsPositiveOnly': True, 'unrelatedLookupControlRed': True, 'reparentedNullEscapePreserved': True, 'positiveRowMismatchCases': len(mismatch_modes), 'positiveRowGuardControlRed': True}))
`;
      const runWith = flags => spawnSync(process.env.DISCORD_SURFACE_PYTHON || monitor.command, [...flags, '-c', program, script], {
        encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL'
      });
      const result = runWith(prefix);
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.deepEqual(JSON.parse(result.stdout), { faults: 14, identityFaults: 6, guardedNativeIdentity: true, liveUnknownAndZombie: true, partialIsPositiveOnly: true, unrelatedLookupControlRed: true, reparentedNullEscapePreserved: true, positiveRowMismatchCases: 4, positiveRowGuardControlRed: true });
      const withSite = runWith(prefix.filter(flag => flag !== '-S'));
      assert.equal(withSite.status, 1, withSite.stderr || withSite.error?.message);
      assert.match(withSite.stderr, /AssertionError: unexpected metadata startup \(1, 0, 1, True\)/);
    });
    await t.test('C22 query checkpoints survive fragmented output without accepting partial results', async () => {
      const h = harness(); await h.start(); await h.advance(1000);
      const scan = h.pending();
      await h.advance(100); scan.stdout.emit('data', Buffer.from('W'));
      await h.advance(100); scan.stdout.emit('data', Buffer.from('Q1\nWQ2\nWQ'));
      await h.advance(100); scan.stdout.emit('data', Buffer.from('3\n'));
      await h.advance(700);
      const stopped = h.packets.find(packet => packet.kind === 'STOP').observation;
      assert.equal(stopped.lastTable.timing.checkpoint, 3);
      assert.equal(stopCount(h), 1);
      assert.equal(ackCount(h), 0);
      assert.equal(h.packets.some(packet => packet.kind === 'CLEANUP_COMPLETE'), false);
      scan.stdout.emit('data', Buffer.from('WQ4\n'));
      await h.respond(scan, h.table(scan));
      assert.equal(stopped.lastTable.timing.checkpoint, 3, 'late output cannot rewrite the first refusal');
      for (const bytes of [
        Buffer.from('WQ9\n'),
        Buffer.from('\xD7Q4\n', 'latin1'),
        Buffer.from('private-output-WQ4\n')
      ]) {
        const unknown = harness(); await unknown.start(); await unknown.advance(1000);
        const query = unknown.pending(); query.stdout.emit('data', bytes);
        await unknown.advance(1000);
        const observation = unknown.packets.find(packet => packet.kind === 'STOP').observation;
        assert.equal(observation.lastTable.timing.checkpoint, null);
        assert.equal(JSON.stringify(observation).includes('private-output'), false);
        await unknown.respond(query, '');
      }
    });

    await t.test('C1 invalid and expired budgets launch no collector', async () => {
      for (const deadline of [0, NaN, Infinity, 'missing']) {
        const h = harness({ deadline });
        await h.start();
        await h.advance(1);
        assert.equal(h.children.length, 0);
        assert.equal(stopCount(h), 1);
        assert.equal(ackCount(h), 0);
      }
    });
    await t.test('C1 drain clamps its observation to the remaining deadline', async () => {
      const h = harness({ deadline: 500 });
      h.proc.emit('message', { kind: 'DRAIN' }); await flush();
      assert.deepEqual(h.ends, [500]);
      const scan = h.pending(); await h.respond(scan, h.table(scan));
      assert.deepEqual(h.exits, [0]);
    });
    await t.test('C2 bounded output uses the existing table and identity guards', async () => {
      const h = harness(); await h.start(); await h.advance(1000);
      const scan = h.pending();
      assert.equal(scan.command, 'python3');
      const codeIndex = scan.args.indexOf('-c');
      assert.notEqual(codeIndex, -1);
      assert.equal(scan.args[codeIndex + 2], '--table');
      await h.respond(scan, h.table(scan, '21 20 20 S\n30 21 30 S darwin:1:1:30:1\n'));
      assert.equal(h.pending(), undefined, 'native identity is captured in the table invocation');
      assert.equal(h.children.length, 1);
      assert.equal(h.inspect('escapedDescendants.get(30)'), 'darwin:1:1:30:1');
      assert.equal(h.inspect('collector.owned()'), false);
      assert.equal(stopCount(h), 0);
      assert.equal(scan.stdout.listenerCount('data'), 0);
    });
    await t.test('C2 failure and bounded output never become table evidence', async () => {
      for (const mode of ['missing-self', 'nonzero', 'overflow', 'stream-error', 'spawn-error']) {
        const h = harness({ spawnThrows: mode === 'spawn-error' }); await h.start(); await h.advance(1000);
        const child = h.pending();
        if (mode === 'overflow') child.stdout.emit('data', Buffer.alloc(1024 * 1024 + 1));
        else if (mode === 'stream-error') child.stdout.emit('error', { code: 'EIO' });
        else if (child) await h.respond(child, mode === 'missing-self' ? '20 1 20 S\n' : h.table(child), mode === 'nonzero' ? 1 : 0);
        await flush();
        assert.equal(stopCount(h), 1, mode);
        assert.equal(ackCount(h), 0);
        assert.ok(!h.exits.includes(0));
        const origin = { 'missing-self': null, nonzero: h.failureOrigins.CHILD_EXIT, overflow: h.failureOrigins.STDOUT_LIMIT, 'stream-error': h.failureOrigins.STDOUT_ERROR, 'spawn-error': h.failureOrigins.SPAWN_THROW }[mode];
        const packet = h.packets.find(packet => packet.kind === 'STOP');
        const projected = gate.watchdogStopObservation({ ...packet.observation, event: gate.WATCHDOG_STOP_EVENTS.MONITOR_TABLE });
        assert.equal(projected.lastTable.failureOrigin, origin);
      }
    });
    await t.test('C3 delayed table and identity share one deadline without overlap', async () => {
      for (const identity of [false, true]) {
        const h = harness({ psMonitor: true }); await h.start(); await h.advance(1000);
        if (identity) { await h.advance(500); const scan = h.pending(); await h.respond(scan, h.table(scan, escape)); }
        const pendingIdentity = identity ? h.pending() : null;
        if (identity) {
          assert.equal(pendingIdentity.command, 'python3');
          assert.equal(h.ends[0], 2000, 'identity retains the table phase deadline');
        }
        const count = h.children.length;
        await h.advance(identity ? 500 : 1000);
        assert.equal(h.children.length, count);
        assert.equal(stopCount(h), 1);
        assert.equal(h.inspect('collector.owned()'), true);
        const observation = h.packets.find(packet => packet.kind === 'STOP')?.observation;
        const projected = gate.watchdogStopObservation({ ...observation, event: gate.WATCHDOG_STOP_EVENTS.MONITOR_TABLE });
        assert.equal((identity ? projected.lastIdentity : projected.lastTable).failureOrigin, h.failureOrigins.PHASE_TIMER);
        if (identity) {
          assert.equal(observation?.lastTable?.status, 0);
          assert.equal(observation?.lastIdentity?.errorCode, 'ETIMEDOUT');
          await h.respond(pendingIdentity, '{"30":"start-A"}');
          assert.equal(h.inspect('escapedDescendants.get(30)'), null, 'late identity cannot acquire PID custody');
          assert.equal(ackCount(h), 0);
          assert.equal(h.signals.some(value => value.pid === 30), false);
        }
      }
    });
    await t.test('C4 pending table or identity cannot block stop or two-second group KILL', async () => {
      for (const kind of ['STOP', 'disconnect', 'SIGTERM']) for (const identity of [false, true]) {
        const h = harness({ psMonitor: true }); await h.start(); await h.advance(1000);
        if (identity) { const scan = h.pending(); await h.respond(scan, h.table(scan, escape)); }
        if (kind === 'STOP') h.proc.emit('message', { kind }); else h.proc.emit(kind);
        assert.equal(stopCount(h), 1);
        assert.equal(h.signals.find(value => value.signal === 'SIGTERM').at, 1000);
        await h.advance(2000);
        assert.equal(h.signals.find(value => value.pid === -20 && value.signal === 'SIGKILL').at, 3000);
        assert.equal(h.inspect('collector.owned()'), true);
        const old = h.pending(); await h.respond(old, old.command === 'ps' || old.args.includes('--table') ? h.table(old) : '{"30":"late"}');
        assert.equal(ackCount(h), 0);
        assert.ok(!h.exits.includes(0));
      }
    });
    await t.test('C5 completion requires a scan begun after its boundary', async () => {
      const h = harness({ psMonitor: true }); await h.start(); await h.advance(1000);
      const old = h.pending();
      h.body.emit('message', { kind: 'BODY_COMPLETE' });
      h.body.emit('message', { kind: 'BODY_COMPLETE' });
      await flush(); assert.equal(h.children.length, 1);
      await h.respond(old, h.table(old, escape));
      assert.equal(h.pending().command, 'python3');
      await h.respond(h.pending(), '{"30":"start-A"}');
      assert.equal(h.inspect('escapedDescendants.get(30)'), 'darwin:start-A');
      assert.equal(ackCount(h), 0); assert.equal(h.children.length, 3);
      const fresh = h.pending(); assert.equal(fresh.command, 'ps'); await h.respond(fresh, h.table(fresh));
      assert.equal(ackCount(h), 1);
    });
    await t.test('C5 drain supersedes a pending completion scan', async () => {
      const h = harness(); await h.start();
      h.body.emit('message', { kind: 'BODY_COMPLETE' }); await flush();
      const old = h.pending(); h.body.emit('close', 0, null);
      h.proc.emit('message', { kind: 'DRAIN' }); h.proc.emit('message', { kind: 'DRAIN' }); await flush();
      assert.equal(h.children.length, 1);
      await h.respond(old, h.table(old));
      assert.equal(h.children.length, 2);
      const fresh = h.pending(); await h.respond(fresh, h.table(fresh));
      assert.equal(ackCount(h), 0); assert.deepEqual(h.exits, [0]);
    });
    await t.test('C5 drain and stop reject late admission and body starts', async () => {
      for (const kind of ['DRAIN', 'STOP']) {
        const h = harness(); h.proc.emit('message', { kind }); await flush();
        h.proc.emit('message', { kind: 'ADMIT', command: 'admit', args: [] });
        h.proc.emit('message', { kind: 'START' }); await flush();
        assert.deepEqual(h.starts, { admission: 0, body: 0 });
      }
    });
    await t.test('C6 escaped signals require an unchanged fresh identity', async () => {
      for (const actual of ['start-A', 'start-B', null]) {
        const h = harness({ psMonitor: true }); await h.start(); await h.advance(1000);
        let scan = h.pending(); await h.respond(scan, h.table(scan, escape));
        await h.respond(h.pending(), '{"30":"start-A"}');
        h.proc.emit('SIGTERM'); await flush();
        scan = h.pending(); await h.respond(scan, h.table(scan, '30 1 30 S\n'));
        await h.respond(h.pending(), JSON.stringify(actual ? { 30: actual } : {}));
        assert.equal(h.signals.filter(value => value.pid === 30).length, actual === 'start-A' ? 1 : 0);
      }
    });
    await t.test('C6 empty and malformed identities cannot prove escaped absence', async () => {
      for (const identity of ['{}', '{broken']) {
        const h = harness({ psMonitor: true }); await h.start(); await h.advance(1000);
        let scan = h.pending(); await h.respond(scan, h.table(scan, escape)); await h.respond(h.pending(), identity);
        h.body.emit('close', 0, null); h.proc.emit('message', { kind: 'DRAIN' }); await flush();
        scan = h.pending(); await h.respond(scan, h.table(scan, '30 1 30 S\n'));
        await h.respond(h.pending(), identity); await h.respond(h.pending(), identity);
        assert.equal(stopCount(h), 1); assert.ok(!h.exits.includes(0));
        assert.equal(h.signals.filter(value => value.pid === 30).length, 0);
      }
    });
    await t.test('C7 expiry does not launch an identity successor or accept late output', async () => {
      const h = harness({ deadline: 1500 }); await h.start(); await h.advance(1000);
      const scan = h.pending(); await h.advance(500); await h.respond(scan, h.table(scan, escape));
      assert.equal(h.children.filter(child => child.command === 'python3' && !child.args.includes('--table')).length, 0);
      assert.equal(stopCount(h), 1); assert.equal(ackCount(h), 0);
    });
    await t.test('C8 failed signals and missing close retain ownership without postponing KILL', async () => {
      const h = harness({ groupKillThrows: true, childKillThrows: true }); await h.start(); await h.advance(1000);
      h.proc.emit('SIGTERM'); await h.advance(2000);
      assert.equal(h.children.length, 1); assert.equal(h.inspect('collector.owned()'), true);
      assert.equal(h.exits.length, 0);
      assert.equal(h.signals.find(value => value.pid === -20 && value.signal === 'SIGKILL').at, 3000);
      assert.ok(h.pending().signals.some(value => value.signal === 'SIGKILL'));
    });
    await t.test('C9 simultaneous close, expiry and cancellation settle once', async () => {
      for (const order of ['completion-first', 'timeout-first']) {
        const h = harness(); await h.start();
        const completeAndCancel = () => {
          const child = h.pending(); h.respond(child, h.table(child)); h.proc.emit('SIGTERM');
        };
        if (order === 'completion-first') h.queue(2000, completeAndCancel);
        await h.advance(1000);
        const scan = h.pending();
        if (order === 'timeout-first') h.queue(1000, completeAndCancel);
        await h.advance(1000);
        assert.equal(stopCount(h), 1); assert.equal(ackCount(h), 0);
        assert.equal(h.packets.filter(value => value.kind === 'STOP').length, 1);
        assert.equal(scan.stdout.listenerCount('data'), 0);
      }
    });
    await t.test('C10 orphan release requires a fresh complete absence check', async () => {
      for (const failed of [false, true]) {
        const h = harness(); await h.start(); h.proc.emit('disconnect'); await flush();
        let scan = h.pending(); await h.respond(scan, h.table(scan));
        await h.advance(2000); scan = h.pending(); await h.respond(scan, h.table(scan));
        await h.advance(50); scan = h.pending(); await h.respond(scan, failed ? '' : h.table(scan), failed ? 1 : 0);
        assert.equal(h.releases(), failed ? 0 : 1); assert.deepEqual(h.exits, [98]);
      }
    });
    await t.test('C11 body and diagnostic send failures leave cleanup armed', async () => {
      for (const mode of ['bodySendThrows', 'bodyCallbackError']) {
        const h = harness({ [mode]: true, diagnosticThrows: true }); await h.start();
        h.body.emit('message', { kind: 'BODY_COMPLETE' }); await flush();
        const scan = h.pending(); await h.respond(scan, h.table(scan));
        assert.equal(stopCount(h), 1); await h.advance(2000);
        assert.ok(h.signals.some(value => value.pid === -20 && value.signal === 'SIGKILL'));
      }
    });
    await t.test('C13 collection waits for custody ACK and rejects a late ACK', async () => {
      const h = harness({ noCustodyAck: true }); await h.start(); await h.advance(1000);
      assert.equal(h.children.length, 0);
      const begin = h.packets.find(packet => packet.kind === 'CUSTODY' && packet.state === 'BEGIN');
      assert.ok(begin);
      await h.advance(1000);
      h.proc.emit('message', { kind: 'CUSTODY', state: 'ACK', phase: begin.phase }); await flush();
      assert.equal(h.children.length, 0);
      assert.equal(stopCount(h), 1);
      assert.ok(!h.exits.includes(0));
    });
    await t.test('C13 guardian ancestry remains covered after manager reparenting', async () => {
      const h = harness(); await h.start(); await h.advance(1000);
      const scan = h.pending(); await h.respond(scan, h.table(scan, '30 10 30 S darwin:1:1:30:1\n'));
      assert.equal(h.inspect('escapedDescendants.get(30)'), 'darwin:1:1:30:1');
      assert.equal(h.packets.filter(packet => packet.kind === 'CUSTODY' && packet.escaped).length, 1);
      assert.equal(h.packets.filter(packet => packet.kind === 'CUSTODY' && packet.state === 'CLEAR').length, 0);
    });
    await t.test('C13 live guardian completion follows fresh post-KILL absence', async () => {
      for (const failed of [false, true]) {
        const h = harness(); await h.start(); h.proc.emit('SIGTERM'); await flush();
        let scan = h.pending(); await h.respond(scan, h.table(scan));
        await h.advance(2000); scan = h.pending(); await h.respond(scan, h.table(scan));
        assert.equal(h.packets.filter(packet => packet.kind === 'CLEANUP_COMPLETE').length, 0);
        await h.advance(50); scan = h.pending(); await h.respond(scan, failed ? '' : h.table(scan), failed ? 1 : 0);
        assert.equal(h.packets.filter(packet => packet.kind === 'CLEANUP_COMPLETE').length, failed ? 0 : 1);
        assert.equal(h.releases(), 0, 'connected manager retains final removal');
        assert.deepEqual(h.exits, [98]);
      }
    });
    async function cleanupAtWorkDeadline(options = {}) {
      const h = harness({ deadline: 1000, cleanupDeadline: 6000, ...options });
      const answer = async (failed = false) => {
        for (let step = 0; h.pending(); step++) {
          assert.ok(step < 8, 'finite observation reply count');
          const child = h.pending();
          if (child.command === 'ps') await h.respond(child, failed ? '' : h.table(child, options.unknownIdentity ? '30 1 30 S\n' : ''), failed ? 1 : 0);
          else { assert.equal(child.command, 'python3'); await h.respond(child, '{}'); }
        }
      };
      await h.start();
      if (options.unknownIdentity) {
        h.body.emit('message', { kind: 'BODY_COMPLETE' }); await flush();
        const scan = h.pending(); await h.respond(scan, h.table(scan, escape));
        await h.respond(h.pending(), '{}');
      }
      await h.advance(1000);
      assert.equal(h.signals.find(value => value.pid === -20 && value.signal === 'SIGTERM').at, 1000);
      if (!options.pendingClose) await answer();
      await h.advance(2000);
      assert.equal(h.signals.find(value => value.pid === -20 && value.signal === 'SIGKILL').at, 3000);
      if (!options.pendingClose) await answer();
      assert.equal(h.packets.filter(packet => packet.kind === 'CLEANUP_COMPLETE').length, 0);
      await h.advance(50);
      if (!options.pendingClose) await answer(options.failedAbsence);
      return h;
    }
    const cleanupCount = h => h.packets.filter(packet => packet.kind === 'CLEANUP_COMPLETE' && packet.code === 98).length;
    await t.test('C15 expired work keeps the original reserve for fresh stopped cleanup', async () => {
      const oldRouting = "if (scope === 'cleanup' && stopping) return cleanupEnd;";
      const workOnly = watchdogSource.includes(oldRouting)
        ? watchdogSource.replace(oldRouting, "if (scope === 'cleanup' && stopping) return workEnd;")
        : watchdogSource;
      const red = await cleanupAtWorkDeadline({ source: workOnly });
      assert.throws(() => assert.equal(cleanupCount(red), 1, 'fresh post-KILL completion must remain possible after work expiry'), assert.AssertionError);
      const green = await cleanupAtWorkDeadline();
      assert.equal(cleanupCount(green), 1, 'fresh post-KILL completion must remain possible after work expiry');
      assert.deepEqual(green.ends, [2000, 4000, 4050]);
      assert.equal(green.children.length, 3);
      assert.equal(green.inspect('Date.now()'), 3050);
      assert.deepEqual(green.exits, [98]);
      assert.equal(green.releases(), 0, 'connected manager retains final scratch removal');
      assert.equal(green.inspect('beginObservation("monitor")'), null, 'cleanup cannot resume normal work');
      green.proc.emit('message', { kind: 'ADMIT' }); green.proc.emit('message', { kind: 'START' }); await flush();
      assert.deepEqual(green.starts, { admission: 1, body: 1 });
    });
    await t.test('C15 invalid or exhausted cleanup bounds never establish completion', async () => {
      for (const cleanupDeadline of [NaN, Infinity, 'missing', 0, 999, 1000, 1001, 2500, 3050]) {
        const h = await cleanupAtWorkDeadline({ cleanupDeadline });
        await h.advance(4000);
        assert.equal(cleanupCount(h), 0, String(cleanupDeadline));
        assert.equal(h.releases(), 0);
        assert.ok(!h.exits.includes(0));
      }
    });
    await t.test('C15 custody, observation and child-close failures remain closed after work expiry', async () => {
      for (const options of [{ noCustodyAck: true }, { unknownIdentity: true }, { failedAbsence: true }, { pendingClose: true }]) {
        const h = await cleanupAtWorkDeadline(options);
        await h.advance(4000);
        assert.equal(cleanupCount(h), 0, JSON.stringify(options));
        assert.equal(h.releases(), 0);
        assert.ok(!h.exits.includes(0));
        assert.equal(h.signals.some(value => value.pid === 30), false);
        if (options.pendingClose) assert.equal(h.owner.owned(), true);
      }
    });
    await t.test('C16 observation phases and callsites require explicit bound classification', () => {
      const expected = { monitor: 'work', drain: 'work', 'body-complete': 'work', SIGTERM: 'cleanup', SIGKILL: 'cleanup', orphan: 'cleanup' };
      const calls = [
        'observationDeadline:kind', 'beginObservation:kind,phaseDeadline', 'observationDeadline:kind',
        'freshObservation:kind', 'beginObservation:kind', "beginObservation:'monitor'",
        'stopObservation:signal,phaseDeadline', 'beginObservation:signal,phaseDeadline',
        "observationDeadline:code===0?'drain':'orphan'", "beginObservation:'orphan'", "observationDeadline:'orphan'",
        "stopObservation:'SIGKILL'", "stopObservation:'SIGTERM',killAt", "freshObservation:'drain'", "freshObservation:'body-complete'"
      ].sort();
      const verify = source => {
        const found = [...source.matchAll(/\b(observationDeadline|beginObservation|freshObservation|stopObservation)\(([^)]*)\)/g)]
          .map(value => value[1] + ':' + value[2].replace(/\s/g, '')).sort();
        assert.deepEqual(found, calls, 'new observation phase or callsite needs explicit review');
        assert.equal((source.match(/\bcollector\.begin\(/g) || []).length, 1, 'all observations use the bound owner');
        const h = harness({ source });
        assert.deepEqual(JSON.parse(JSON.stringify(h.inspect('OBSERVATION_PHASE_BOUNDS'))), expected);
        assert.equal(h.inspect('beginObservation("future-phase")'), null);
        assert.equal(h.inspect('beginObservation("SIGTERM")'), null, 'cleanup authority is unavailable before stop');
      };
      verify(watchdogSource);
      assert.throws(() => verify(watchdogSource + "\nbeginObservation('future-phase');\n"), assert.AssertionError);
      assert.throws(() => verify(watchdogSource + "\nbeginObservation('monitor');\n"), assert.AssertionError);
      assert.throws(() => verify(watchdogSource + '\ncollector.begin(10000);\n'), assert.AssertionError);
      const extraPhase = watchdogSource.replace("monitor: 'work',", "future: 'cleanup', monitor: 'work',");
      assert.notEqual(extraPhase, watchdogSource);
      assert.throws(() => verify(extraPhase), assert.AssertionError);
    });
    await t.test('C14 collector origins identify each existing failure branch', async () => {
      const cases = [
        ['expired', 'RUN_EXPIRED'], ['busy', 'RUN_BUSY'], ['timer', 'PHASE_TIMER'],
        ['cancel', 'CANCEL_REQUEST'], ['finish', 'FINISH_CANCEL'], ['spawn', 'SPAWN_THROW'],
        ['stdout-limit', 'STDOUT_LIMIT'], ['stderr-limit', 'STDERR_LIMIT'],
        ['stdout-error', 'STDOUT_ERROR'], ['stderr-error', 'STDERR_ERROR'],
        ['child-error', 'CHILD_ERROR'], ['close-invalid', 'CLOSE_INVALID'], ['exit', 'CHILD_EXIT']
      ];
      const origins = harness().failureOrigins;
      assert.equal(new Set(Object.values(origins)).size, 13);
      assert.deepEqual(cases.map(([, key]) => key).sort(), Object.keys(origins).sort());
      for (const [mode, key] of [...cases, ['success', null]]) {
        const h = harness({ spawnThrows: mode === 'spawn', spawnErrorCode: 'ETIMEDOUT' });
        const phase = h.owner.begin(1000);
        if (mode === 'expired') h.elapseWithoutTimers(1000);
        const pendingResult = h.owner.run(phase, 'ps', [], { LC_ALL: 'C' });
        let result;
        const child = h.pending();
        if (mode === 'expired' || mode === 'spawn') result = await pendingResult;
        else if (mode === 'busy') {
          result = await h.owner.run(phase, 'ps', [], { LC_ALL: 'C' });
          assert.equal(result.error.code, 'EBUSY');
          h.owner.cancel();
          assert.equal((await pendingResult).failureOrigin, origins.CANCEL_REQUEST);
        } else {
          if (mode === 'timer') await h.advance(1000);
          if (mode === 'cancel') h.owner.cancel();
          if (mode === 'finish') h.owner.finish(phase);
          if (mode.endsWith('-limit')) child[mode.startsWith('stdout') ? 'stdout' : 'stderr'].emit('data', Buffer.alloc(1024 * 1024 + 1));
          if (mode.endsWith('-error') && mode !== 'child-error') child[mode.startsWith('stdout') ? 'stdout' : 'stderr'].emit('error', { code: 'ETIMEDOUT' });
          if (mode === 'child-error') child.emit('error', { code: 'ETIMEDOUT' });
          if (mode === 'close-invalid') h.elapseWithoutTimers(1000);
          if (['child-error', 'close-invalid', 'exit', 'success'].includes(mode)) await h.respond(child, '', mode === 'exit' ? 1 : mode === 'child-error' ? null : 0);
          result = await pendingResult;
        }
        assert.equal(result.failureOrigin, key ? origins[key] : null, mode);
        if (['expired', 'timer', 'spawn', 'stdout-error', 'stderr-error', 'child-error'].includes(mode)) {
          assert.equal(result.status, null, mode);
          assert.equal(result.signal, null, mode);
          assert.equal(result.error.code, 'ETIMEDOUT', mode);
        }
        if (child && !child.closed) {
          assert.equal(h.owner.owned(), true, 'owned child remains until close');
          await h.respond(child, '', 0);
        }
        h.owner.finish(phase);
        await h.owner.whenClosed();
        assert.equal(h.owner.owned(), false, mode);
        assert.equal(h.children.length, mode === 'expired' || mode === 'spawn' ? 0 : 1, mode);
        if (mode === 'timer') assert.deepEqual(child.signals.map(value => value.signal), ['SIGTERM']);
      }
    });
    await t.test('C14 manager allowlists origins and rejects raw diagnostic data', () => {
      const origins = harness().failureOrigins;
      for (const failureOrigin of Object.values(origins)) {
        const observed = gate.watchdogStopObservation({ event: gate.WATCHDOG_STOP_EVENTS.MONITOR_TABLE, lastTable: { outcome: 'command-failed', status: null, signal: null, errorCode: 'ETIMEDOUT', failureOrigin } });
        assert.equal(observed.lastTable.failureOrigin, failureOrigin);
      }
      const privateMarker = 'private fixture detail';
      const observed = gate.gateSyscallObservation({ outcome: 'command-failed', errorCode: 'EIO', failureOrigin: privateMarker });
      assert.equal(observed.failureOrigin, null);
      assert.equal(JSON.stringify(observed).includes(privateMarker), false);
      assert.equal(gate.gateSyscallObservation({ outcome: 'subprocess-complete', status: 0 }).failureOrigin, null);
      for (const pid of [-1, 1, NaN, Infinity, '123', {}]) {
        assert.equal(gate.gateSyscallObservation({ outcome: 'command-failed', pid }).pid, null);
      }
      assert.equal(gate.gateSyscallObservation({ outcome: 'command-failed', childErrorCode: privateMarker }).childErrorCode, null);
    });
    await t.test('C18 refusal identifies its child and separates wall adjustment from elapsed time', async () => {
      const h = harness();
      const phase = h.owner.begin(1000);
      const pending = h.owner.run(phase, 'ps', [], { LC_ALL: 'C' });
      const child = h.pending();
      await h.advance(100);
      child.stderr.emit('data', Buffer.from('private stderr'));
      await h.advance(100);
      child.emit('error', { code: 'EAGAIN' });
      h.shiftWall(970);
      await h.advance(800);
      const failed = await pending;
      assert.equal(failed.error.code, 'ETIMEDOUT');
      assert.equal(failed.childErrorCode, 'EAGAIN');
      assert.equal(failed.timing.wallStarted, 0);
      assert.equal(failed.timing.elapsed, 1970);
      assert.equal(failed.timing.monoElapsed, 1000);
      assert.equal(failed.timing.stderr, 100);
      assert.equal(failed.timing.error, 200);
      const projected = gate.gateSyscallObservation({ ...failed, outcome: 'command-failed', errorCode: failed.error.code });
      assert.equal(projected.pid, child.pid);
      assert.equal(projected.childErrorCode, 'EAGAIN');
      assert.equal(JSON.stringify(projected).includes('private stderr'), false);
      await h.respond(child, '');
      assert.equal(failed.timing.close, null, 'late closure cannot rewrite the first refusal');
      assert.equal(h.owner.owned(), false);
    });
    await t.test('C17 timeout timing separates custody delay from collection time', async () => {
      const h = harness({ noCustodyAck: true }); await h.start(); await h.advance(1000);
      const begin = h.packets.find(packet => packet.kind === 'CUSTODY' && packet.state === 'BEGIN');
      await h.advance(750);
      h.proc.emit('message', { kind: 'CUSTODY', state: 'ACK', phase: begin.phase }); await flush();
      const scan = h.pending();
      await h.advance(250);
      const timing = h.packets.find(packet => packet.kind === 'STOP').observation.lastTable.timing;
      assert.ok(timing, 'refusal records the timing needed to separate custody and collection');
      assert.deepEqual(JSON.parse(JSON.stringify(timing)), {
        budget: 1000, custody: 750, run: 750, returned: 750, spawn: null, data: null, exit: null, close: null, elapsed: 1000,
        wallStarted: 1000, monoElapsed: 1000, stderr: null, error: null, checkpoint: null
      });
      assert.equal(stopCount(h), 1);
      await h.respond(scan, '');
      assert.equal(timing.close, null, 'late close cannot rewrite the refusal snapshot');
    });
    await t.test('C17 timeout retains observed exit while close is pending', async () => {
      const h = harness(); await h.start(); await h.advance(1000);
      const scan = h.pending();
      await h.advance(100); scan.emit('spawn');
      await h.advance(100); scan.stdout.emit('data', Buffer.from(h.table(scan)));
      await h.advance(100); scan.emit('exit', 0, null);
      await h.advance(700);
      const observation = h.packets.find(packet => packet.kind === 'STOP').observation;
      const projected = gate.watchdogStopObservation({ ...observation, event: gate.WATCHDOG_STOP_EVENTS.MONITOR_TABLE });
      assert.ok(projected.lastTable.timing, 'refusal retains observed exit and pending close');
      assert.deepEqual(JSON.parse(JSON.stringify(projected.lastTable.timing)), {
        budget: 1000, custody: 0, run: 0, returned: 0, spawn: 100, data: 200, exit: 300, close: null, elapsed: 1000,
        wallStarted: 1000, monoElapsed: 1000, stderr: null, error: null, checkpoint: null
      });
      assert.equal(projected.lastTable.failureOrigin, h.failureOrigins.PHASE_TIMER);
      assert.equal(stopCount(h), 1);
      await h.respond(scan, '');
      assert.equal(scan.listenerCount('spawn'), 0);
      assert.equal(scan.listenerCount('exit'), 0);
    });
    await t.test('C17 timing projection rejects unknown fields and non-numeric detail', () => {
      const timing = { budget: 1000, custody: 0, run: 0, returned: 0, spawn: 0, data: null, exit: null, close: null, elapsed: 1000,
        wallStarted: 0, monoElapsed: 1000, stderr: null, error: null, checkpoint: null };
      const input = { outcome: 'command-failed', errorCode: 'ETIMEDOUT', failureOrigin: harness().failureOrigins.PHASE_TIMER, timing };
      assert.deepEqual(gate.gateSyscallObservation(input).timing, timing);
      for (const invalid of [{ ...timing, command: 'private detail' }, { ...timing, run: 'private detail' }, { ...timing, elapsed: Infinity }, { ...timing, checkpoint: 9 }, Object.values(timing)]) {
        assert.equal(gate.gateSyscallObservation({ ...input, timing: invalid }).timing, undefined);
      }
      assert.equal(gate.gateSyscallObservation({ ...input, outcome: 'subprocess-complete', status: 0 }).timing, undefined);
      const packet = gate.watchdogStopObservation({ event: gate.WATCHDOG_STOP_EVENTS.MONITOR_TABLE, lastTable: input });
      const retained = { stage: 'cleanup', firstStop: null, workerError: false, workerErrorCode: null,
        workerExit: { code: null, signal: 'SIGKILL', stage: 'cleanup' }, bodyExit: { code: 143, stage: 'body' },
        watchdogStop: packet, workerStop: { event: 'SIGTERM', errorCode: null, guardCode: null, upstreamOrigin: 'UNKNOWN' },
        initialGroupProbe: { ok: true, count: 0, errorCode: null }, finalGroupProbe: null, upstreamOrigin: 'UNKNOWN' };
      assert.ok(Buffer.byteLength(' observed=' + JSON.stringify(retained), 'utf8') <= 1024, 'timing survives the existing terminal diagnostic bound');
      const identityFailure = gate.watchdogStopObservation({
        event: gate.WATCHDOG_STOP_EVENTS.MONITOR_TABLE,
        lastTable: { outcome: 'subprocess-complete', status: 0, pid: 123456 },
        lastIdentity: { ...input, pid: 123457, childErrorCode: 'E'.repeat(40),
          timing: { ...timing, wallStarted: 1793950556000, stderr: 100, error: 200 } }
      });
      assert.ok(Buffer.byteLength(' observed=' + JSON.stringify({ ...retained, watchdogStop: identityFailure }), 'utf8') <= 1024,
        'a completed table cannot crowd out the failed identity observation');
    });
    await t.test('C14 new collector producer sites require an explicit origin review', () => {
      const verify = source => {
        assert.equal((source.match(/\bfailure\(/g) || []).length, 5);
        assert.equal((source.match(/\bcancel\(/g) || []).length, 8);
      };
      verify(collectorSource);
      assert.throws(() => verify(collectorSource + "\nfailure(phase, 'ETIMEDOUT');\n"), assert.AssertionError);
      assert.throws(() => verify(collectorSource + "\ncancel('ETIMEDOUT');\n"), assert.AssertionError);
    });
    await t.test('C12 the complete evidence inventory rejects new collectors and PID signals', () => {
      const watchdog = 'scripts/full-gate-watchdog.js';
      const collector = 'scripts/full-gate/watchdog-collector.js';
      const manager = 'scripts/full-gate.js';
      const worker = 'scripts/full-gate-worker.js';
      const body = 'scripts/full-gate/body-runner.js';
      const expectedModules = [watchdog, collector, manager, worker, body].sort();
      const expectedFiles = [...expectedModules, 'scripts/full-gate/darwin.py', 'scripts/full-gate/darwin-runner.py', 'scripts/full-gate/supervisor.py'].sort();
      const expectedImports = {
        [watchdog]: ['./full-gate', './full-gate/watchdog-collector', 'node:child_process', 'node:fs'],
        [collector]: [],
        [manager]: ['./full-gate/watchdog-collector', 'node:child_process', 'node:crypto', 'node:fs', 'node:fs', 'node:os', 'node:path', 'node:stream/promises'],
        [worker]: ['./full-gate', 'node:child_process', 'node:os', 'node:path'],
        [body]: ['../full-gate', 'node:path']
      };
      const expectedCalls = { [watchdog]: [0, 0, 0], [collector]: [1, 0, 0], [manager]: [0, 4, 2], [worker]: [1, 0, 1], [body]: [0, 0, 0] };
      const expectedSignals = {
        [watchdog]: ["-group,'SIGKILL'", "-group,'SIGTERM'", 'pid,signal'].sort(),
        [manager]: ["-worker.pid,'SIGKILL'"],
        [worker]: ["-process.pid,'SIGKILL'", "-process.pid,'SIGTERM'"].sort(),
        [collector]: [], [body]: []
      };
      function assertEvidenceOwners(inventory) {
        assert.deepEqual([...inventory.files].sort(), expectedFiles, 'new evidence module needs explicit review');
        assert.deepEqual(Object.keys(inventory.sources).sort(), expectedModules, 'every scoped JavaScript module must be inspected');
        for (const [name, source] of Object.entries(inventory.sources)) {
          const imports = [...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map(value => value[1]).sort();
          assert.deepEqual(imports, [...expectedImports[name]].sort(), 'unapproved import in ' + name);
          assert.equal((source.match(/\brequire\s*\(/g) || []).length, imports.length + (name === body ? 1 : 0), 'unapproved dynamic require in ' + name);
          assert.doesNotMatch(source, /\bimport\s*\(/, 'unapproved dynamic import in ' + name);
          assert.deepEqual(['spawn', 'spawnSync', 'fork'].map(call => (source.match(new RegExp('\\b' + call + '\\(', 'g')) || []).length), expectedCalls[name], 'second subprocess owner in ' + name);
          const calls = [...source.matchAll(/\bprocess\s*(?:\.\s*kill|\[\s*['"]kill['"]\s*\])\s*\(([^)]*)\)/g)];
          const references = source.match(/\bprocess\s*(?:\.\s*kill|\[\s*['"]kill['"]\s*\])/g) || [];
          assert.equal(references.length, calls.length, 'aliased PID signal in ' + name);
          assert.deepEqual(calls.map(value => value[1].replace(/\s/g, '').replace(/"/g, "'")).sort(), expectedSignals[name], 'direct PID signal bypass in ' + name);
        }
        const owner = inventory.sources[watchdog].match(/async function signalEscapedDescendants[\s\S]*?\n}/)?.[0];
        assert.ok(owner);
        assert.equal((owner.match(/process\.kill\(pid, signal\)/g) || []).length, 1);
        assert.match(owner, /sameProcessIdentity\(expected, identities\.get\(pid\)\)/);
        assert.match(owner, /currentObservation\(phase\)/);
        assert.doesNotMatch(inventory.sources[watchdog], /spawnSync/);
        assert.match(inventory.sources[worker], /admission = spawn\(message\.command, message\.args, \{ stdio: 'inherit' \}\)/);
        assert.match(inventory.sources[watchdog], /const \{ spawn \} = require\('node:child_process'\)/);
        assert.match(inventory.sources[worker], /const \{ fork, spawn \} = require\('node:child_process'\)/);
        assert.match(inventory.sources[manager], /const \{ fork, spawnSync \} = require\('node:child_process'\)/);
        const peers = inventory.sources[manager].match(/function groupPeers\(group, deadline\) \{[\s\S]*?\n}/)?.[0];
        assert.ok(peers);
        assert.equal((inventory.sources[manager].match(/spawnSync\(['"]ps['"]/g) || []).length, 1, 'manager process evidence stays at groupPeers');
        assert.equal((peers.match(/spawnSync\(['"]ps['"]/g) || []).length, 1);
        assert.equal((inventory.sources[collector].match(/\.kill\(signal\)/g) || []).length, 1, 'only the owned child handle may be signaled');
        assert.match(inventory.sources[collector], /owner\?\.child\?\.kill\(signal\)/);
      }
      const inventory = { files: evidenceInventory.files, sources: { ...evidenceInventory.sources, [watchdog]: watchdogSource, [collector]: collectorSource } };
      assertEvidenceOwners(inventory);
      const append = (name, text) => ({ files: inventory.files, sources: { ...inventory.sources, [name]: inventory.sources[name] + text } });
      const sibling = 'scripts/full-gate/future-evidence.js';
      const mutants = [
        append(collector, '\nprocess.kill(pid, signal);\n'),
        append(body, '\nprocess.kill(pid, signal);\n'),
        append(collector, '\nspawn("ps", []);\n'),
        append(collector, '\nrequire("../future-evidence");\n'),
        { files: [...inventory.files, sibling], sources: { ...inventory.sources, [sibling]: 'process.kill(pid, signal);\nspawn("ps", []);\n' } }
      ];
      assert.equal(mutants.length, 5);
      for (const mutant of mutants) assert.throws(() => assertEvidenceOwners(mutant), assert.AssertionError);
    });
  });
}

{
  const inventoryRoots = ['scripts/full-gate.js', 'scripts/full-gate-worker.js', 'scripts/full-gate-watchdog.js'];
  const inventoryFiles = [...inventoryRoots, ...filesUnder(path.join(PROJECT, 'scripts/full-gate')).filter(file => /\.(?:js|cjs|mjs|py)$/.test(file)).map(file => path.relative(PROJECT, file).split(path.sep).join('/'))].sort();
  const evidenceInventory = {
    files: inventoryFiles,
    sources: Object.fromEntries(inventoryFiles.filter(file => /\.(?:js|cjs|mjs)$/.test(file)).map(file => [file, fs.readFileSync(path.join(PROJECT, file), 'utf8')]))
  };
  watchdogCollectorLifecycleTests({
    test, assert, vm: require('node:vm'), EventEmitter: require('node:events').EventEmitter, evidenceInventory, gate: require('../scripts/full-gate'),
    watchdogSource: evidenceInventory.sources['scripts/full-gate-watchdog.js'],
    collectorSource: evidenceInventory.sources['scripts/full-gate/watchdog-collector.js']
  });
}


const darwinPhaseProgram = String.raw`import ast,copy,io,json,math,signal,sys,types
from pathlib import Path
signal.signal(signal.SIGALRM,signal.SIG_DFL)
signal.alarm(20)
SUPERVISOR=Path(sys.argv[1]).read_text(encoding='utf-8')
RUNNER=Path(sys.argv[2]).read_text(encoding='utf-8')
NATIVE=Path(sys.argv[3]).read_text(encoding='utf-8')
results=[]
class FixtureOracle(BaseException):pass
def require(value,detail):
    if not value:raise FixtureOracle(detail)
def declarations(source,names,namespace):
    nodes=[n for n in ast.parse(source).body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in names]
    require({n.name for n in nodes}==names,'owning declaration missing')
    exec(compile(ast.Module(body=nodes,type_ignores=[]),'<actual phase owner>','exec'),namespace)
    return namespace
def case(name,action):
    action();results.append(name)
class Clock:
    def __init__(self,value=0):self.value=value;self.sleeps=0
    def now(self):return self.value
    def sleep(self,seconds):
        require(0<=seconds<=0.05,'fixture sleep changed')
        self.sleeps+=1;require(self.sleeps<=16,'fixture observer did not terminate')
        self.value+=1
identity={'pid':401,'coalition_id':400,'start_sec':17,'start_usec':1,'pid_version':3,'unique_id':9}
controller={'pid':301,'coalition_id':300,'start':11}
class CapabilityError(OSError):pass

def requests(values,sequence=0,allowed=('normal-after',),lost=False,interrupted=False,now=0,observe_only=False,body_code=98):
    clock=Clock(now);reads=[]
    def opened(name,*args,**kwargs):
        require(name=='ack','unexpected fixture file')
        index=min(len(reads),len(values)-1);reads.append(index)
        require(len(reads)<=8,'unbounded request reads')
        return io.StringIO(json.dumps(values[index]))
    api=types.SimpleNamespace(require_clock_contract=lambda x:require(x=='CLOCK_MONOTONIC_V1','mixed clock'),
        same_process=lambda a,b:a==b,clock_now=clock.now)
    ns=dict(DARWIN=api,open=opened,json=json,time=clock,interrupted=interrupted,controller_alive=lambda x:not lost)
    declarations(RUNNER,{'request','retirement_result'},ns)
    spec={'ack_path':'ack','deadline':10,'controller':controller,'launch_token':'nonce'}
    return ns['request'](spec,identity,sequence,allowed,10,observe_only=observe_only,body_code=body_code),reads

def ack(sequence=1,phase='normal-after',**changes):
    value={'clock_contract':'CLOCK_MONOTONIC_V1','launch_token':'nonce','identity':identity,'sequence':sequence,'phase':phase,'cancelled':False}
    value.update(changes);return value

def stale_request():
    value,reads=requests([ack(1,'normal-after'),ack(1,'normal-after'),ack(2,'retire')],1,('retire',))
    assert value['phase']=='retire' and len(reads)==3
case('consumed request is not executed again while awaiting retirement',stale_request)
for field,value in [('sequence',3),('sequence',True),('phase','command'),('identity',controller),('launch_token','foreign')]:
    def rejected(field=field,value=value):
        try:requests([ack(**{field:value})])
        except ValueError:return
        raise FixtureOracle('invalid request accepted '+field)
    case('request rejects '+field+' '+repr(value),rejected)
def lost_controller():
    try:requests([ack()],lost=True)
    except InterruptedError:return
    raise FixtureOracle('lost controller accepted work')
case('controller loss prevents the next phase',lost_controller)

for cause in ('interrupted','lost'):
    def stop_before_exit(cause=cause):
        value,reads=requests([ack(2,'stop',cancelled=True)],1,('stop',),lost=cause=='lost',interrupted=cause=='interrupted',observe_only=True)
        assert value['sequence']==2 and value['phase']=='stop' and len(reads)==1
    case('authenticated next stop is consumed before '+cause,stop_before_exit)
    for phase in ('command','normal-after','fallback','retire'):
        def productive_refused(cause=cause,phase=phase):
            try:requests([ack(2,phase)],1,(phase,),lost=cause=='lost',interrupted=cause=='interrupted',observe_only=True)
            except InterruptedError:return
            raise FixtureOracle('productive request survived '+cause+' '+phase)
        case('productive '+phase+' refused after '+cause,productive_refused)
    def old_ack_refused(cause=cause):
        try:requests([ack(1,'command')],1,('stop',),lost=cause=='lost',interrupted=cause=='interrupted',observe_only=True)
        except InterruptedError:return
        raise FixtureOracle('old acknowledgement postponed '+cause)
    case('old acknowledgement cannot postpone '+cause,old_ack_refused)
for change in ({'launch_token':'foreign'},{'identity':controller},{'sequence':3},{'sequence':True},{'cancelled':1},{'phase':'command'}):
    def invalid_stop(change=change):
        value=ack(2,'stop',cancelled=True);value.update(change)
        try:requests([value],1,('stop',),interrupted=True,observe_only=True)
        except (ValueError,InterruptedError):return
        raise FixtureOracle('invalid stop acknowledgement accepted '+repr(change))
    case('interruption does not waive stop validation '+repr(change),invalid_stop)
def expired_stop_refused():
    try:requests([ack(2,'stop',cancelled=True)],1,('stop',),interrupted=True,now=10,observe_only=True)
    except TimeoutError:return
    raise FixtureOracle('expired stop acknowledgement accepted')
case('authenticated stop cannot extend the original deadline',expired_stop_refused)

def finish_case(fault=None):
    clock=Clock(10);states=[];drains=[];observed=[];attempts=[]
    def joined(pid):
        require(pid==401,'observed foreign process')
        observed.append(clock.value)
        if fault=='identity' and clock.sleeps<2:raise CapabilityError('unreadable')
        return dict(identity)
    def counts(resource):
        require(resource==400,'observed foreign coalition')
        if fault=='counts' and clock.sleeps<2:raise CapabilityError('unknown')
        return (1,0) if fault in (None,'publication') or clock.sleeps>=2 else (2,0)
    def drain(*args,**kwargs):
        require(clock.value<11,'active drain after original deadline')
        drains.append(clock.value)
        return fault is None or fault=='publication'
    def write(path,value):
        require(path['state_path']=='state','new state store')
        attempts.append(copy.deepcopy(value))
        if fault=='publication' and len(attempts)<3:raise OSError('disk unavailable')
        states.append(copy.deepcopy(value))
    api=types.SimpleNamespace(joined_identity=joined,same_process=lambda a,b:a==b,task_counts=counts,
        _drained=lambda *args:True,clock_now=clock.now,drain=drain,CapabilityError=CapabilityError,
        require_clock_contract=lambda value:require(value=='CLOCK_MONOTONIC_V1','finish fixture mixed clock'))
    def opened(path,*args,**kwargs):
        require(path=='ack','finish fixture read another file')
        return io.StringIO(json.dumps(ack(3,'retire',result_code=0)))
    ns=dict(DARWIN=api,os=types.SimpleNamespace(getpid=lambda:401),time=clock,write_state=write,
        open=opened,json=json,interrupted=False,controller_alive=lambda value:True)
    declarations(RUNNER,{'request','retirement_result','quiescent','finish'},ns)
    code=ns['finish']({'deadline':11,'state_path':'state','ack_path':'ack','launch_token':'nonce',
        'controller':controller},identity,3,0,None,None)
    assert len(drains)==1 and all(value<11 for value in drains)
    assert states[-1]['sealed'] is True and states[-1]['quiescent'] is True
    assert states[-1]['phase']=='retired' and states[-1]['code']==code
    if fault is None:assert code==0 and clock.sleeps==0
    else:
        assert code==98 and states[-1]['code']==98
        assert clock.sleeps>=2
        assert all(row['code']==98 for row in states)
    return states,attempts
case('known quiescence can retire normally',lambda:finish_case())
for fault in ('descendant','identity','counts','publication'):
    case('cleanup hold and later quiescence preserve98 after '+fault,lambda fault=fault:finish_case(fault))

def terminal_results():
    for phase in ('stop','retire'):
        for invalid in (True,'98',7):
            try:requests([ack(2,phase,result_code=invalid)],1,(phase,),observe_only=True,body_code=0)
            except ValueError:pass
            else:raise FixtureOracle('malformed terminal result advanced request '+repr(invalid))
        for changes in ({},{'result_code':98},{'result_code':0}):
            value,reads=requests([ack(2,phase,**changes)],1,(phase,),observe_only=True,body_code=0)
            assert value['sequence']==2 and len(reads)==1
case('actual request validates terminal result before returning sequence',terminal_results)

def final_peek_case(mode):
    clock=Clock();reads=[];sleeps=[]
    old=ack(1,'command')
    fresh=ack(2,'stop',cancelled=True)
    if mode=='productive':fresh=ack(2,'command')
    elif mode=='foreign':fresh['launch_token']='foreign'
    elif mode=='malformed':fresh['result_code']=True
    elif mode=='old':fresh=old
    elif mode=='absent':fresh=None
    def opened(path,*args,**kwargs):
        require(path=='ack' and clock.value<10,'final peek read outside original bound')
        reads.append(path);require(len(reads)<=2,'more than one final fresh peek')
        if len(reads)==1:
            class OldDescriptor(io.StringIO):
                def read(self,*args,**kwargs):
                    payload=super().read(*args,**kwargs)
                    ns['interrupted']=True
                    if mode=='expired':clock.value=10
                    return payload
            return OldDescriptor(json.dumps(old))
        ns['interrupted']=False
        if mode=='absent':raise FileNotFoundError('no fresh ACK')
        return io.StringIO(json.dumps(fresh))
    def sleep(seconds):sleeps.append(seconds);raise FixtureOracle('final peek waited')
    api=types.SimpleNamespace(require_clock_contract=lambda x:require(x=='CLOCK_MONOTONIC_V1','mixed final-peek clock'),same_process=lambda a,b:a==b,clock_now=clock.now)
    ns=dict(DARWIN=api,open=opened,json=json,time=types.SimpleNamespace(sleep=sleep),interrupted=False,controller_alive=lambda x:True)
    declarations(RUNNER,{'request','retirement_result'},ns)
    spec={'ack_path':'ack','deadline':10,'controller':controller,'launch_token':'nonce'}
    current=1;value=None;failure=None
    try:
        value=ns['request'](spec,identity,current,('stop','command'),0,observe_only=True,body_code=0)
        current=value['sequence']
    except (InterruptedError,TimeoutError,ValueError) as error:failure=error
    assert not sleeps
    if mode=='valid':assert failure is None and current==2 and value['phase']=='stop' and len(reads)==2
    else:
        assert failure is not None and current==1
        assert len(reads)==(1 if mode=='expired' else 2)
for mode in ('valid','productive','foreign','malformed','old','absent','expired'):
    case('actual request final fresh peek remains latched and bounded '+mode,lambda mode=mode:final_peek_case(mode))

def finish_stop_case(mode):
    clock=Clock(10 if mode=='expired' else 0)
    states=[];reads=[];drains=[];drain_attempts=[];clock_calls=[];productive=[]
    current=2 if mode=='consumed' else 1
    value=ack(2,'stop',cancelled=True,result_code=98)
    if mode=='normal':value=ack(1,'retire',result_code=0)
    elif mode=='old':value=ack(1,'command')
    elif mode=='foreign':value['launch_token']='foreign'
    elif mode=='identity':value['identity']=controller
    elif mode=='skipped':value['sequence']=3
    elif mode=='boolean':value['sequence']=True
    elif mode=='productive':value['phase']='command'
    elif mode=='mixed-clock':value['clock_contract']='foreign'
    elif mode=='cancellation-type':value['cancelled']=1
    elif mode=='null':value=None
    elif mode=='result-bool':value['result_code']=True
    elif mode=='result-string':value['result_code']='98'
    elif mode=='result-foreign':value['result_code']=7
    elif mode=='result-default':del value['result_code']
    def opened(path,*args,**kwargs):
        require(path=='ack' and not states,'finish read an ACK after sealing or at another path')
        reads.append(path);require(len(reads)<=2,'finish exceeded one final cancellation peek')
        if mode=='absent':raise FileNotFoundError('no pending acknowledgement')
        return io.StringIO(json.dumps(value))
    def now():
        require(not states,'finish restarted work clock after sealing')
        clock_calls.append(clock.value);require(len(clock_calls)<=6,'finish clock ceiling')
        if mode=='clock':raise CapabilityError('clock unavailable')
        return clock.now()
    def contract(value):
        if value!='CLOCK_MONOTONIC_V1':raise ValueError('mixed clock')
    def drain(resource,until,preserve):
        require(not states and resource==identity['coalition_id'] and until==10 and preserve==identity,'finish lost original cleanup ownership')
        drain_attempts.append(clock.value);require(len(drain_attempts)==1,'finish repeated native cleanup handoff')
        if mode=='clock':raise CapabilityError('native cleanup clock unavailable before signals')
        drains.append(clock.value);require(len(drains)==1,'finish repeated active cleanup')
        return mode!='unknown'
    def counts(resource):
        require(resource==identity['coalition_id'],'finish inspected another resource')
        return (2,0) if mode=='unknown' and clock.sleeps<2 else (1,0)
    def write(spec,payload):
        require(spec['state_path']=='state' and payload['sealed'] is True,'finish did not seal before reporting')
        states.append(copy.deepcopy(payload));require(len(states)<=3,'finish publication ceiling')
    def forbidden(*args,**kwargs):
        productive.append((args,kwargs))
        raise FixtureOracle('finish dispatched productive work')
    api=types.SimpleNamespace(CapabilityError=CapabilityError,require_clock_contract=contract,
        same_process=lambda a,b:a==b,clock_now=now,drain=drain,
        joined_identity=lambda pid:dict(identity),task_counts=counts,_drained=lambda *args:True)
    ns=dict(DARWIN=api,open=opened,json=json,time=clock,
        os=types.SimpleNamespace(getpid=lambda:identity['pid']),write_state=write,
        interrupted=mode not in ('lost','normal'),controller_alive=lambda value:mode!='lost',
        subprocess=types.SimpleNamespace(Popen=forbidden),capture_snapshot=forbidden)
    declarations(RUNNER,{'request','retirement_result','quiescent','finish'},ns)
    spec={'deadline':10,'state_path':'state','ack_path':'ack','launch_token':'nonce','controller':controller}
    initial=98 if mode in ('old','consumed','absent','null','priority') else 0
    prior='cleanup' if mode=='priority' else 'interrupted' if initial==98 else None
    code=ns['finish'](spec,identity,current,initial,prior,None)
    require(not productive,'finish started a command or verifier')
    assert states[-1]['phase']=='retired' and states[-1]['sealed'] is True and states[-1]['quiescent'] is True
    if mode=='normal':
        assert code==0 and states[-1]['code']==0 and states[-1]['sequence']==1
    else:
        assert code==98 and all(row['code']==98 for row in states)
        expected=2 if mode in ('interrupted','lost','unknown','priority','consumed','result-default') else 1
        assert states[-1]['sequence']==expected
    if mode in ('interrupted','lost'):
        assert len(reads)==1 and states[-1]['reason']=='interrupted'
    if mode=='priority':assert states[-1]['reason']=='cleanup'
    if mode in ('expired','clock'):assert not reads and not drains
    if mode=='clock':assert len(drain_attempts)==1
    if mode=='expired':assert not drain_attempts
    if mode=='unknown':
        assert states[0]['phase']=='cleanup-hold' and states[-1]['sequence']==2
        assert clock.sleeps>=2 and states[-1]['reason']=='cleanup'
    return states

for mode in ('interrupted','lost','productive','foreign','identity','skipped','boolean',
             'mixed-clock','cancellation-type','absent','null','old','consumed','expired','clock',
             'unknown','priority','normal','result-bool','result-string','result-foreign','result-default'):
    case('actual finish and request preserve stop custody '+mode,lambda mode=mode:finish_stop_case(mode))

class CleanupClockVerdictMismatch(AssertionError):pass

def cleanup_clock_recovery(*,remove_demotion=False,prior_cleanup=False):
    clock_reads=[];ack_reads=[];handoffs=[];signals=[];enumerations=[];observations=[];states=[]
    def now():
        require(not states,'clock restarted after sealing')
        clock_reads.append(None);require(len(clock_reads)<=6,'cleanup-clock fixture exceeded fixed reads')
        if len(clock_reads)==3:raise CapabilityError('only outer cleanup clock refused')
        return 0 if len(clock_reads)<3 else 10
    def forbidden(*args,**kwargs):
        signals.append((args,kwargs))
        raise FixtureOracle('expired native cleanup attempted signal, enumeration or wait')
    def drained(resource,preserve,allow_reaped):
        require(resource==identity['coalition_id'] and preserve==identity and allow_reaped is False,'native observation changed ownership')
        observations.append(resource);require(len(observations)<=2,'native quiescence observation ceiling')
        return True
    native_ns=dict(clock_now=now,_drained=drained,_signal_members=forbidden,
        signal=types.SimpleNamespace(SIGTERM=15,SIGKILL=9),time=types.SimpleNamespace(sleep=forbidden))
    for name in ('TERM_SECONDS','POLL_SECONDS'):
        native_ns[name]=next(ast.literal_eval(n.value) for n in ast.parse(NATIVE).body if isinstance(n,ast.Assign) and any(isinstance(v,ast.Name) and v.id==name for v in n.targets))
    declarations(NATIVE,{'drain'},native_ns)
    def handoff(resource,deadline,*,preserve):
        handoffs.append((resource,deadline,preserve));require(len(handoffs)==1,'native cleanup handoff repeated')
        return native_ns['drain'](resource,deadline,preserve=preserve)
    def opened(path,*args,**kwargs):
        require(path=='ack','clock-recovery fixture read another file')
        ack_reads.append(path);require(len(ack_reads)==1,'clock-recovery fixture repeated ACK read')
        return io.StringIO(json.dumps(ack(3,'retire',result_code=0)))
    def write(spec,value):
        require(spec['state_path']=='state','clock-recovery fixture changed state path')
        states.append(copy.deepcopy(value));require(len(states)==1,'quiescent clock-recovery fixture failed to retire once')
    api=types.SimpleNamespace(CapabilityError=CapabilityError,clock_now=now,drain=handoff,
        require_clock_contract=lambda value:require(value=='CLOCK_MONOTONIC_V1','clock-recovery contract changed'),
        same_process=lambda a,b:a==b,joined_identity=lambda pid:dict(identity),task_counts=lambda resource:(1,0),_drained=drained)
    source=RUNNER
    if remove_demotion:
        tree=ast.parse(source)
        owner=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='finish')
        cleanup=next(n for n in owner.body if isinstance(n,ast.Try) and any(isinstance(v,ast.Assign) and any(isinstance(w,ast.Name) and w.id=='cleanup_now' for w in v.targets) for v in n.body))
        handler=cleanup.handlers[0]
        demotion=next(n for n in handler.body if isinstance(n,ast.Assign) and any(isinstance(v,ast.Tuple) and {x.id for x in v.elts if isinstance(x,ast.Name)}=={'code','reason'} for v in n.targets))
        handler.body.remove(demotion)
        source=ast.unparse(tree)
    ns=dict(DARWIN=api,open=opened,json=json,os=types.SimpleNamespace(getpid=lambda:identity['pid']),
        time=types.SimpleNamespace(sleep=forbidden),write_state=write,interrupted=False,controller_alive=lambda value:True)
    declarations(source,{'request','retirement_result','quiescent','finish'},ns)
    code=ns['finish']({'deadline':10,'ack_path':'ack','state_path':'state','launch_token':'nonce','controller':controller},
        identity,3,98 if prior_cleanup else 0,'cleanup' if prior_cleanup else None,'owned verifier cleanup detail' if prior_cleanup else None)
    assert len(clock_reads)==6 and len(ack_reads)==1 and len(handoffs)==1
    assert not signals and not enumerations and len(observations)==2
    assert states[-1]['phase']=='retired' and states[-1]['sealed'] is True and states[-1]['quiescent'] is True
    assert states[-1]['sequence']==3
    if code!=98 or states[-1]['code']!=98:
        raise CleanupClockVerdictMismatch('native quiescence after clock refusal restored ordinary success')
    assert states[-1]['reason']=='cleanup' and 'only outer cleanup clock refused' in states[-1]['detail']
    if prior_cleanup:assert states[-1]['detail'].startswith('owned verifier cleanup detail; ')
case('actual finish retains98 when native drain clock recovers at expiry',cleanup_clock_recovery)
case('cleanup-clock demotion preserves preceding cleanup detail',lambda:cleanup_clock_recovery(prior_cleanup=True))
def cleanup_clock_wrong_control():
    try:cleanup_clock_recovery(remove_demotion=True)
    except CleanupClockVerdictMismatch:return
    raise FixtureOracle('removing only cleanup-clock demotion escaped its behavioral oracle')
case('removing only clock demotion is detected by actual finish and native drain',cleanup_clock_wrong_control)

def cleanup_case(mode):
    clock=Clock();events=[]
    def state(path,*args):
        require(path=='state','foreign state path')
        if mode=='state-error':raise OSError('unreadable state')
        sealed=clock.value>=2 and mode!='never-seal'
        return {'identity':identity,'sealed':sealed,'quiescent':True,'phase':'retired' if sealed else 'body-quiescent','sequence':3}
    def drain(*args,**kwargs):
        require(clock.value>=2,'drain before irreversible seal')
        events.append('drain');return mode!='drain-unknown'
    def bootout(*args):
        require(clock.value>=2,'bootout accepted guardian-only count without seal')
        events.append('bootout');return True
    api=types.SimpleNamespace(CapabilityError=CapabilityError,same_process=lambda a,b:a==b,
        identity_if_present=lambda pid:identity,drain=drain,signal_identity=lambda *args:events.append('signal'))
    ns=dict(_read_job_state=state,clock_now=clock.now,time=clock,POLL_SECONDS=0.025,signal=types.SimpleNamespace(SIGTERM=15),
        _bootout=bootout,_service_state=lambda *args:{'present':False})
    declarations(SUPERVISOR,{'_darwin_cleanup'},ns)
    result=ns['_darwin_cleanup'](api,'launchctl','owned-service',identity,4,'state',True,token='nonce',sequence=3)
    if mode=='known':assert result is True and events==['signal','drain','bootout','drain']
    else:assert result is False and 'bootout' not in events
case('parent waits for seal before bootout even with guardian-only counts',lambda:cleanup_case('known'))
for mode in ('never-seal','state-error','drain-unknown'):
    case('parent retains unknown custodian/evidence on '+mode,lambda mode=mode:cleanup_case(mode))

def actual_function(name,body,namespace):
    assigned={n.id for stmt in body for n in ast.walk(stmt) if isinstance(n,ast.Name) and isinstance(n.ctx,ast.Store)}
    namespace['__fixture_initials']={name:namespace[name] for name in assigned if name in namespace}
    initial=[ast.Assign(targets=[ast.Name(id=name,ctx=ast.Store())],value=ast.Subscript(value=ast.Name(id='__fixture_initials',ctx=ast.Load()),slice=ast.Constant(name),ctx=ast.Load())) for name in sorted(namespace['__fixture_initials'])]
    node=ast.FunctionDef(name=name,args=ast.arguments(posonlyargs=[],args=[],kwonlyargs=[],kw_defaults=[],defaults=[]),body=initial+body,decorator_list=[])
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),'<actual coordinator branch>','exec'),namespace)
    return namespace[name]
outer=next(n for n in ast.parse(SUPERVISOR).body if isinstance(n,ast.FunctionDef) and n.name=='run_darwin_supervised')
main=next(n for n in outer.body if isinstance(n,ast.Try) and any(isinstance(x,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='spec_payload' for t in x.targets) for x in n.body))
select=next(i for i,n in enumerate(main.body) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='after_failure' for t in n.targets))
emit=next(i for i in range(select+1,len(main.body)) if isinstance(main.body[i],ast.AugAssign) and isinstance(main.body[i].target,ast.Name) and main.body[i].target.id=='sequence')
final=next(n for n in reversed(main.body) if isinstance(n,ast.Return))
def comparison(state,prior=None):
    verdicts=[]
    ns=dict(state=state,before={'snapshot':'old'},reason=prior,detail='prior',result_code=0,deadline=100,output_cursor={'output_line_start':True},
        no_verdict=lambda why,detail,**kwargs:verdicts.append((why,detail)) or 98)
    fn=actual_function('compare',copy.deepcopy(main.body[select:emit])+[copy.deepcopy(final)],ns)
    return fn(),verdicts
case('ordinary result requires real normal comparison data',lambda:require(comparison({})[0]==98,'missing comparison passed'))
case('Source change cannot return ordinary result',lambda:require(comparison({'after':{'snapshot':'new'}})[0]==98,'changed Source passed'))
case('real equal comparison can preserve body result',lambda:require(comparison({'after':{'snapshot':'old'}})==(0,[]),'equal Source refused'))
case('relay reason survives ordinary after failure',lambda:require(comparison({'after_failure':{'reason':'stale','detail':'unavailable'}},'timeout')[1][0][0]=='timeout','relay reason lost'))
case('actual cleanup failure overrides earlier relay reason',lambda:require(comparison({'after_failure':{'reason':'cleanup','detail':'owned verifier'}},'timeout')[1][0][0]=='cleanup','cleanup priority lost'))

flush=next(n for n in main.body if isinstance(n,ast.While) and any(isinstance(c,ast.Call) and isinstance(c.func,ast.Name) and c.func.id=='_stream_stdout' for c in ast.walk(n)))
flush_index=main.body.index(flush)
wait_index=next(i for i in range(flush_index+1,len(main.body)) if isinstance(main.body[i],ast.Assign) and isinstance(main.body[i].value,ast.Call) and isinstance(main.body[i].value.func,ast.Name) and main.body[i].value.func.id=='_wait_job_phase')
def relay_order(blocked=False):
    clock=Clock(93);events=[];offsets=[]
    def stream(path,cursor,final=False):
        offset=cursor['offset'];events.append('stream');offsets.append(offset);clock.value+=1
        require(len(offsets)<=3,'unbounded relay')
        cursor['offset']=offset if blocked else min(8,offset+4)
        return cursor['offset']
    def ack_write(*args,**kwargs):
        events.append('after-ack')
        if not blocked:require(offsets==[0,4],'after authorized before relay finished')
    def waited(*args):events.append('after-start');return {},8
    ns=dict(interrupted=types.SimpleNamespace(is_set=lambda:False),clock_now=clock.now,run_deadline=95,deadline=100,
        stdout_path='stdout',output_offset=0,output_cursor={'offset':0},_stream_stdout=stream,os=types.SimpleNamespace(stat=lambda p:types.SimpleNamespace(st_size=8)),
        time=clock,POLL_SECONDS=0.025,reason=None,detail=None,result_code=0,sequence=1,
        ack_path='ack',nonce='nonce',owner=None,identity=identity,_write_job_request=ack_write,
        _wait_job_phase=waited,status_path='state')
    summary=ast.parse('return reason, detail, output_offset').body
    decision=actual_function('relay_phase',copy.deepcopy(main.body[flush_index:wait_index+1])+summary,ns)()
    assert decision[0]==('timeout' if blocked else None)
    if not blocked:assert decision[2]==8
    assert events.index('after-ack')<events.index('after-start')
    assert all(x=='stream' for x in events[:events.index('after-ack')])
case('normal after starts only after relay decision ACK',lambda:relay_order())
case('blocked stdout reaches original D-5 decision before after ACK',lambda:relay_order(True))

handler=main.handlers[0]
unavailable=next(i for i,n in enumerate(handler.body) if isinstance(n,ast.If) and isinstance(n.test,ast.UnaryOp) and isinstance(n.test.operand,ast.Name) and n.test.operand.id=='fallback_available')
def unsafe_fallback():
    verdicts=[]
    ns=dict(fallback_available=False,detail='relay failed',reason='setup',owned_service=False,owner=None,retirement={},deadline=100,output_cursor={'output_line_start':True},
        no_verdict=lambda reason,detail,**kwargs:verdicts.append((reason,detail)) or 98)
    assert actual_function('declined',copy.deepcopy(handler.body[unavailable:]),ns)()==98
    assert verdicts[0][0]=='setup' and 'source-after-unavailable' in verdicts[0][1]
case('unavailable unsafe fallback stays98 without a fabricated snapshot',unsafe_fallback)

class CleanupProjectionMismatch(AssertionError):pass
def terminal_projection(body=98,prior=None,terminal_reason='cleanup',exceptional=False,source=SUPERVISOR,cleanup_reason=None):
    outer=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=='run_darwin_supervised')
    main=next(n for n in outer.body if isinstance(n,ast.Try) and any(isinstance(x,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='spec_payload' for t in x.targets) for x in n.body))
    retired={'phase':'retired','sequence':3,'sealed':True,'quiescent':True,'code':98,'reason':terminal_reason,'detail':'verified terminal'}
    verdicts=[];emits=[]
    def cleaned(*args,**kwargs):
        if cleanup_reason:kwargs['terminal_state'].update(retired,reason=cleanup_reason)
        return True
    def emitted(*args):
        emits.append(args[3]);return True
    ns=dict(reason=prior,detail='prior detail',result_code=body,NO_VERDICT=98,sequence=3,deadline=10,
        output_cursor={'offset':0,'source_line_start':True,'output_line_start':True},
        retirement={},owned_service=True,owner=object(),identity=identity,identity_verified=True,
        launchctl='launchctl',service='service',status_path='state',nonce='nonce',stdout_path='stdout',stderr_path='stderr',
        interrupted=types.SimpleNamespace(is_set=lambda:False),fallback_available=False,
        _wait_job_phase=lambda *args:(retired,0),_darwin_cleanup=cleaned,_emit_job_stderr=emitted,
        clock_now=lambda:0,_stream_stdout=lambda path,cursor,**kwargs:cursor['offset'],
        os=types.SimpleNamespace(stat=lambda path:types.SimpleNamespace(st_size=0)),time=Clock(),POLL_SECONDS=.025,
        no_verdict=lambda why,detail,**kwargs:verdicts.append((why,detail)) or 98)
    if exceptional:
        handler=main.handlers[0]
        index=next(i for i,n in enumerate(handler.body) if isinstance(n,ast.If) and isinstance(n.test,ast.UnaryOp) and isinstance(n.test.operand,ast.Name) and n.test.operand.id=='fallback_available')
        body_nodes=copy.deepcopy(handler.body[index:])
    else:
        index=next(i for i,n in enumerate(main.body) if isinstance(n,ast.Assign) and isinstance(n.value,ast.Call) and isinstance(n.value.func,ast.Name) and n.value.func.id=='_wait_job_phase' and any(isinstance(a,ast.Tuple) and any(isinstance(v,ast.Constant) and v.value=='retired' for v in a.elts) for a in n.value.args))
        body_nodes=copy.deepcopy(main.body[index:])
    code=actual_function('actual_terminal',body_nodes,ns)()
    expected='cleanup' if terminal_reason=='cleanup' or cleanup_reason=='cleanup' else prior or terminal_reason
    if expected:
        if code!=98 or len(verdicts)!=1 or verdicts[0][0]!=expected:
            raise CleanupProjectionMismatch('verified terminal reason lost: '+repr((body,prior,terminal_reason,exceptional,code,verdicts)))
        assert emits in ([],[False])
    else:
        assert code==body and verdicts==[] and emits==[True]
    return code,verdicts
for prior in (None,'stale','timeout'):
    for body in (0,98):
        case('actual normal terminal cleanup overrides '+repr((body,prior)),lambda body=body,prior=prior:terminal_projection(body,prior))
case('raw98 without authenticated reason remains marker-free',lambda:terminal_projection(98,None,None))
case('authenticated interrupted98 cannot restore body0',lambda:terminal_projection(0,None,'interrupted'))
case('exception cleanup owner exposes verified terminal refusal',lambda:terminal_projection(98,'setup',None,True,cleanup_reason='cleanup'))
def old_terminal_control():
    guard='state.get("code") == NO_VERDICT and state.get("reason") and (state["reason"] == "cleanup" or reason is None)'
    require(SUPERVISOR.count(guard)==1,'terminal predicate no longer unique')
    legacy='int(state.get("code", NO_VERDICT)) == NO_VERDICT and result_code != NO_VERDICT and reason is None'
    try:terminal_projection(98,None,'cleanup',source=SUPERVISOR.replace(guard,legacy))
    except CleanupProjectionMismatch:return
    raise FixtureOracle('restoring raw98 mask escaped public projection oracle')
case('restoring original raw98 terminal mask is detected',old_terminal_control)

def cleanup_identity_expiry(mode):
    clock=Clock();events=[];terminal={}
    def now():
        if mode=='clock':raise OSError('clock unavailable')
        return clock.value
    def present(pid):
        clock.value=4;return identity
    api=types.SimpleNamespace(CapabilityError=CapabilityError,same_process=lambda a,b:a==b,
        identity_if_present=present,drain=lambda *args,**kwargs:events.append('drain') or True,
        signal_identity=lambda *args:events.append('signal'))
    state={'identity':identity,'sealed':False,'quiescent':True,'phase':'body-quiescent','sequence':3}
    ns=dict(_read_job_state=lambda *args:state,clock_now=now,time=clock,POLL_SECONDS=.025,
        signal=types.SimpleNamespace(SIGTERM=15),_bootout=lambda *args:events.append('bootout') or True,
        _service_state=lambda *args:{'present':False})
    declarations(SUPERVISOR,{'_darwin_cleanup'},ns)
    assert ns['_darwin_cleanup'](api,'launchctl','owned',identity,4,'state',True,token='nonce',sequence=3,terminal_state=terminal) is False
    assert events==[] and terminal=={}
for mode in ('identity','clock'):
    case('controller refuses active cleanup after '+mode,lambda mode=mode:cleanup_identity_expiry(mode))

def output_boundary(mode):
    clock=Clock();calls=[];accepted={11:bytearray(),12:bytearray()};blocking={11:True,12:True}
    marker=b'APERTURE-GATE-INDETERMINATE reason=timeout: inner\n'
    cursor={'offset':0,'source_line_start':True,'output_line_start':False,'verdict':(0,len(marker))}
    def write(fd,payload):
        require(blocking[fd] is False,'public write used blocking descriptor')
        calls.append((fd,len(payload)));require(len(calls)<=12,'public write exceeded bounded attempts')
        if mode=='partial' and len(calls)<=2:raise BlockingIOError('temporary full')
        if mode in ('blocked','expired','clock'):raise BlockingIOError('full')
        count=min(3,len(payload)) if mode=='partial' and len(calls)==3 else len(payload)
        accepted[fd].extend(payload[:count]);return count
    def now():
        if mode=='clock':raise OSError('unreadable output clock')
        return clock.value
    if mode=='expired':clock.value=4
    ns=dict(os=types.SimpleNamespace(get_blocking=lambda fd:blocking[fd],set_blocking=lambda fd,value:blocking.__setitem__(fd,value),write=write),
        sys=types.SimpleNamespace(stdout=types.SimpleNamespace(fileno=lambda:11),stderr=types.SimpleNamespace(fileno=lambda:12)),
        clock_now=now,time=clock,POLL_SECONDS=.025,NO_VERDICT=98,
        Path=lambda path:types.SimpleNamespace(read_bytes=lambda:b'x'*(2*1024*1024)),
        open=lambda path,*args:io.BytesIO(marker))
    declarations(SUPERVISOR,{'_write_job_output','_emit_job_stderr','no_verdict'},ns)
    if mode=='ordinary':
        mode='blocked'
        assert ns['_emit_job_stderr']('stderr','stdout',0,True,cursor,4) is False
        assert all(fd==12 for fd,size in calls) and clock.value==4
    elif mode=='outer':
        assert ns['no_verdict']('cleanup','verified',stdout_cursor=cursor,stdout_deadline=4)==98
        assert bytes(accepted[11])==b'\nAPERTURE-GATE-INDETERMINATE reason=cleanup: verified\n'
        assert cursor['verdict_delivery_complete'] is True
    else:
        assert ns['_emit_job_stderr']('stderr','stdout',98,True,cursor,4) is True
        assert all(fd==11 for fd,size in calls),'raw98 marker must bypass bulk stderr'
        if mode=='partial':
            assert bytes(accepted[11])==b'\n'+marker and cursor['verdict_delivery_complete'] is True
            assert clock.value==2 and len(calls)==4
        else:
            assert accepted[11]==b'' and cursor['verdict_delivery_complete'] is False
            if mode in ('expired','clock'):assert len(calls)==1 and clock.sleeps==0
            else:assert clock.value==4
    assert blocking=={11:True,12:True}
for mode in ('partial','blocked','expired','clock','ordinary','outer'):
    case('actual terminal output original-clock boundary '+mode,lambda mode=mode:output_boundary(mode))


def gate_signal_inventory(native=NATIVE,supervisor=SUPERVISOR,runner=RUNNER):
    sites=[]
    for label,source in (('native',native),('supervisor',supervisor),('runner',runner)):
        for owner in ast.parse(source).body:
            if not isinstance(owner,ast.FunctionDef):continue
            for node in ast.walk(owner):
                if not isinstance(node,ast.Call):continue
                name=node.func.id if isinstance(node.func,ast.Name) else node.func.attr if isinstance(node.func,ast.Attribute) else None
                if name not in ('signal_identity','_signal'):continue
                require(len(node.args)==3 and isinstance(node.args[2],ast.Name) and node.args[2].id=='deadline',
                    'gate-owned signal omitted its original deadline')
                sites.append((label,owner.name,name))
    require(sorted(sites)==sorted([('native','signal_identity','_signal'),('native','_signal_members','_signal'),('supervisor','_darwin_cleanup','signal_identity')]),
        'signal consumer inventory changed')
case('all gate-owned identity-safe signals carry originalD',gate_signal_inventory)
def signal_inventory_mutation():
    future='\ndef unbudgeted_new_signal(identity):\n    return signal_identity(identity,15)\n'
    try:gate_signal_inventory(native=NATIVE+future)
    except FixtureOracle:return
    raise FixtureOracle('new unbudgeted production consumer escaped inventory')
case('new unbudgeted signal consumer is rejected',signal_inventory_mutation)
def standalone_signal_compatibility():
    calls=[]
    ns={'_signal':lambda identity,number,deadline:calls.append((identity,number,deadline)) or True}
    declarations(NATIVE,{'signal_identity'},ns)
    assert ns['signal_identity'](identity,15) is True
    assert calls==[(identity,15,None)]
    assert ns['signal_identity'](identity,15,4) is True and calls[-1]==(identity,15,4)
case('standalone two-argument API preserves external-bound contract only',standalone_signal_compatibility)

class TailReplayMismatch(AssertionError):pass
def cancelled_tail(mode='partial',remove_replay=False):
    clock=Clock();data=b'APERTURE-';accepted=bytearray();writes=[];blocking=[True];cursor={'offset':0,'source_line_start':True,'output_line_start':True};verdicts=[]
    def write(fd,payload):
        require(fd==11 and blocking[0] is False,'tail relay used blocking or foreign output')
        writes.append(len(payload));require(len(writes)<=8,'tail relay exceeded fixed attempts')
        if mode=='blocked':raise BlockingIOError('consumer full')
        count=min(3,len(payload)) if len(writes)==1 else len(payload)
        accepted.extend(payload[:count]);return count
    def now():
        if mode=='clock' and retired[0]:raise OSError('clock unavailable after release')
        return clock.value
    retired=[False]
    def cleanup(*args,**kwargs):
        require(args[5]=='state' and kwargs['token']=='nonce' and kwargs['sequence']==3,'tail cleanup lost exact proof binding')
        kwargs['terminal_state'].update(phase='retired',sequence=3,sealed=True,quiescent=True,code=98,reason='interrupted')
        retired[0]=True
        if mode=='expired':clock.value=4
        return True
    ns=dict(clock_now=now,time=clock,POLL_SECONDS=.025,NO_VERDICT=98,
        os=types.SimpleNamespace(get_blocking=lambda fd:blocking[0],set_blocking=lambda fd,value:blocking.__setitem__(0,value),
            write=write,stat=lambda path:types.SimpleNamespace(st_size=len(data))),
        sys=types.SimpleNamespace(stdout=types.SimpleNamespace(fileno=lambda:11)),
        open=lambda *args:io.BytesIO(data),fallback_available=False,detail='caller cancelled',reason='interrupted',
        owner=object(),owned_service=True,identity=identity,identity_verified=True,deadline=4,sequence=3,
        retirement={},output_cursor=cursor,stdout_path='stdout',launchctl='launchctl',service='owned',
        _darwin_cleanup=cleanup,no_verdict=lambda why,detail,**kwargs:verdicts.append((why,detail)) or 98)
    declarations(SUPERVISOR,{'_write_job_output','_stream_stdout'},ns)
    assert ns['_stream_stdout']('stdout',cursor)==0 and accepted==b''
    nodes=copy.deepcopy(handler.body[unavailable:])
    if remove_replay:
        matches=[n for n in nodes if isinstance(n,ast.If) and any(isinstance(c,ast.Call) and isinstance(c.func,ast.Name) and c.func.id=='_stream_stdout' for c in ast.walk(n))]
        require(len(matches)==1,'exception final replay no longer unique');nodes.remove(matches[0])
    setup=ast.parse('status_path="state"\nnonce="nonce"').body
    assert actual_function('cancelled_tail_actual',setup+nodes,ns)()==98
    assert len(verdicts)==1 and verdicts[0][0]=='interrupted' and blocking[0] is True
    if mode=='partial':
        if bytes(accepted)!=data:raise TailReplayMismatch('known retired cancellation lost withheld ordinary prefix')
        assert not cursor.get('retain_output')
    else:
        assert accepted==b'' and cursor.get('retain_output') is True
        assert ns['open']('stdout').read()==data
        if mode in ('expired','clock'):assert writes==[] and clock.sleeps==0
    assert clock.value<=4
for mode in ('partial','blocked','expired','clock'):
    case('retired cancellation preserves withheld tail '+mode,lambda mode=mode:cancelled_tail(mode))
def tail_mutation():
    try:cancelled_tail(remove_replay=True)
    except TailReplayMismatch:return
    raise FixtureOracle('removing exceptional final replay escaped byte-preservation oracle')
case('removing exceptional final replay is detected',tail_mutation)

def authenticated_cleanup_exposure(expired=False):
    terminal={};events=[]
    state={'identity':identity,'phase':'retired','sequence':3,'sealed':True,'quiescent':True,'code':98,'reason':'cleanup','detail':'verified cleanup refusal'}
    api=types.SimpleNamespace(CapabilityError=CapabilityError,drain=lambda *args,**kwargs:events.append('drain') or True)
    ns=dict(_read_job_state=lambda *args:state,clock_now=lambda:4 if expired else 0,
        _bootout=lambda *args:events.append('bootout') or True,_service_state=lambda *args:{'present':False})
    declarations(SUPERVISOR,{'_darwin_cleanup'},ns)
    assert ns['_darwin_cleanup'](api,'launchctl','service',identity,4,'state',True,token='nonce',sequence=3,terminal_state=terminal) is (not expired)
    assert terminal==state and events==([] if expired else ['drain','bootout','drain'])
case('cleanup owner exposes authenticated terminal reason on release',authenticated_cleanup_exposure)
case('cleanup owner preserves terminal reason when deadline refuses release',lambda:authenticated_cleanup_exposure(True))
def evidence(owned,retain=False):
    removed=[];ns=dict(scratch='private',owned_service=owned,output_cursor={'retain_output':retain},shutil=types.SimpleNamespace(rmtree=lambda *a,**k:removed.append(a)))
    actual_function('finalize',copy.deepcopy(main.finalbody),ns)()
    assert bool(removed) is (not owned and not retain)
case('live owned allocation retains private evidence',lambda:evidence(True))
case('released allocation can remove private evidence',lambda:evidence(False))
case('released allocation retains incomplete output evidence',lambda:evidence(False,True))

def snapshot_mapping(mode):
    calls=[]
    class Cleanup(OSError):pass
    class Budget(Exception):pass
    def capture(root,environment,phase,deadline,stop,*,stop_deadline):
        calls.append((root,phase,deadline,stop_deadline))
        if stop.is_set():raise InterruptedError('controller gone')
        if mode=='cleanup':raise Cleanup('owned verifier')
        if mode=='budget':raise Budget('invalid')
        if mode=='timeout':raise TimeoutError('deadline')
        if mode=='infrastructure':raise OSError('source unavailable')
        return {'snapshot':'stable'}
    owner=types.SimpleNamespace(capture_snapshot=capture,SnapshotCleanupError=Cleanup,InvalidGateBudget=Budget)
    ns=dict(Path=Path,SimpleNamespace=types.SimpleNamespace,interrupted=False,controller_alive=lambda x:mode!='lost',request=lambda *args,**kwargs:(_ for _ in ()).throw(InterruptedError('cancelled')) if kwargs.get('cancellation_observed') else None)
    declarations(RUNNER,{'snapshot'},ns)
    result,failure,stop=ns['snapshot']({'cwd':'fixture','environment':{},'deadline':100,'controller':controller},identity,owner,1)
    assert calls==[(Path('fixture'),'after',100,100)]
    if mode=='normal':assert result=={'snapshot':'stable'} and failure is None
    else:
        assert result is None and failure is not None
        assert failure['reason']=={'cleanup':'cleanup','budget':'setup','timeout':'timeout','infrastructure':'stale','lost':'interrupted'}[mode]
for mode in ('normal','cleanup','budget','timeout','infrastructure','lost'):
    case('shared guardian snapshot actual failure projection '+mode,lambda mode=mode:snapshot_mapping(mode))

def consumed_guard(phase):
    run=next(n for n in ast.parse(RUNNER).body if isinstance(n,ast.FunctionDef) and n.name=='run')
    branch=next(n for n in ast.walk(run) if isinstance(n,ast.If) and isinstance(n.test,ast.Compare) and isinstance(n.test.left,ast.Name) and n.test.left.id=='phase' and isinstance(n.test.comparators[0],ast.Tuple) and {getattr(x,'value',None) for x in n.test.comparators[0].elts}=={'normal-after','fallback'})
    guard=copy.deepcopy(branch.body[0])
    ns=dict(phase=phase,normal_done=phase=='normal-after',fallback_done=phase=='fallback')
    try:actual_function('consumed',[guard],ns)()
    except ValueError:return
    raise FixtureOracle('completed phase could be dispatched twice')
for phase in ('normal-after','fallback'):
    case('actual dispatch guard refuses repeated '+phase,lambda phase=phase:consumed_guard(phase))


def cancelled_publication():
    writes=[];replaced=[]
    ns=dict(json=json,NO_VERDICT=98,os=types.SimpleNamespace(replace=lambda *args:replaced.append(args)),_write_private_file=lambda path,data:writes.append(json.loads(data)))
    declarations(SUPERVISOR,{'JobRequestCancelled','_write_job_request'},ns)
    for phase in ('command','normal-after','fallback'):
        try:ns['_write_job_request']('ack','nonce',types.SimpleNamespace(CLOCK_CONTRACT='CLOCK_MONOTONIC_V1'),identity,2,phase,types.SimpleNamespace(is_set=lambda:True))
        except ns['JobRequestCancelled']:pass
        else:raise FixtureOracle('cancelled producer authorized '+phase)
    assert len(replaced)==3 and all(v['phase']=='stop' and v['cancelled'] is True and v['result_code']==98 for v in writes)
case('cancelled producer publishes only stop98 for every productive phase',cancelled_publication)
def cancelled_consumer():
    try:requests([ack(cancelled=True)])
    except InterruptedError:return
    raise FixtureOracle('cancelled consumer accepted productive work')
case('consumer refuses productive cancelled acknowledgement',cancelled_consumer)
def typed_state(changes=None):
    value={'launch_token':'nonce','clock_contract':'CLOCK_MONOTONIC_V1','state':'finished','phase':'retired','identity':identity,'sequence':3,'sealed':True,'quiescent':True,'body_quiescent':False,'code':98}
    if changes:value.update(changes)
    api=types.SimpleNamespace(require_clock_contract=lambda x:require(x=='CLOCK_MONOTONIC_V1','wrong clock'),same_process=lambda a,b:a==b)
    ns=dict(json=json,NO_VERDICT=98,open=lambda *args,**kwargs:io.StringIO(json.dumps(value)))
    declarations(SUPERVISOR,{'_read_job_state'},ns)
    return ns['_read_job_state']('state',api,'nonce',identity)
case('exact typed retired proof is accepted',lambda:typed_state())
for changes in ({'sealed':1},{'quiescent':'true'},{'body_quiescent':0},{'sequence':True},{'launch_token':'old'},{'phase':'ready'}):
    def refused(changes=changes):
        try:typed_state(changes)
        except ValueError:return
        raise FixtureOracle('coerced or stale proof accepted')
    case('strict proof rejects '+repr(changes),refused)
def negative_poll(result):
    run=next(n for n in ast.parse(RUNNER).body if isinstance(n,ast.FunctionDef) and n.name=='run')
    guard=next(n for n in ast.walk(run) if isinstance(n,ast.If) and ast.unparse(n.test)=='result is not None')
    loop=ast.While(test=ast.Constant(True),body=[copy.deepcopy(guard),ast.Break()],orelse=[])
    ns=dict(result=result,code=98,body_reason=None,body_detail=None)
    outcome=actual_function('polled',[loop]+ast.parse('return code, body_reason, body_detail').body,ns)()
    if result<0:assert outcome[0]==98 and outcome[1]=='interrupted' and str(-result) in outcome[2]
    else:assert outcome==(result,None,None)
for result in (-15,0,7):case('body poll retains signal versus ordinary result '+str(result),lambda result=result:negative_poll(result))


def active_stop(mode):
    clock=Clock();states=[];reads=[];spawns=[];polls=[];drains=[];captures=[]
    active={'body':False,'capture':False,'stop_published':False,'race_armed':False,'old_reads':0,'late_checks':0}
    spec={'state_path':'state','ack_path':'ack','launch_token':'nonce','clock_contract':'CLOCK_MONOTONIC_V1',
        'controller':controller,'deadline':10,'run_deadline':9,'environment':{'APERTURE_GATE_TIME_LEFT_S':'9'},
        'command':['fixture-body'],'cwd':'fixture','snapshot_program':'pinned fixture program'}
    class Cleanup(OSError):pass
    class Budget(Exception):pass
    def opened(path,*args,**kwargs):
        if path=='spec':return io.StringIO(json.dumps(spec))
        require(path=='ack','unexpected active-stop file')
        require(clock.value<10,'active stop read ACK after original deadline')
        reads.append(path);require(len(reads)<=12,'active-stop request ceiling')
        phase=states[-1]['phase']
        if active['stop_published']:
            value=ack(2 if mode=='poll-race' else 3,'stop',cancelled=True,result_code=98,reason='interrupted',detail='active published stop')
        elif active['capture']:
            value=ack(2,'normal-after')
        elif phase=='ready':value=ack(1,'command')
        elif phase=='command':value=ack(2,'stop',cancelled=True,result_code=98,reason='interrupted',detail='active body stop') if mode=='body' or active['stop_published'] else ack(1,'command')
        elif phase=='body-quiescent':value=ack(2,'normal-after')
        elif phase=='normal-after-complete':value=ack(3,'retire',result_code=0)
        else:raise FixtureOracle('unexpected active-stop phase '+phase)
        if mode=='capture-oldfd' and active['race_armed'] and not active['stop_published']:
            class OldDescriptor(io.StringIO):
                def read(self,*args,**kwargs):
                    payload=super().read(*args,**kwargs)
                    active['old_reads']+=1;require(active['old_reads']==1,'old descriptor replayed')
                    active['stop_published']=True;ns['interrupted']=True
                    return payload
            return OldDescriptor(json.dumps(value))
        return io.StringIO(json.dumps(value))
    def published(record,value):
        require(record==spec,'active stop changed immutable spec')
        states.append(copy.deepcopy(value))
    def capture(root,environment,phase,deadline,stop,*,stop_deadline):
        captures.append((phase,deadline,stop_deadline))
        require(len(captures)==1,'active stop started another verifier')
        active['capture']=True
        try:
            require(stop.is_set() is False,'capture was already stopped before next ACK')
            if mode in ('capture-oldfd','capture-latepredicate'):
                active['race_armed']=True
            else:
                active['stop_published']=True
            if mode=='capture-cleanup-stop':
                ns['interrupted']=True
                raise Cleanup('owned verifier cleanup failed before fresh stop observation')
            if mode=='capture-interrupted':ns['interrupted']=True
            if stop.is_set():
                if mode in ('capture-interrupted','capture-lost','capture-oldfd','capture-latepredicate'):
                    clock.value=10;active['body']=False
                raise InterruptedError('valid next-sequence stop interrupted active capture')
            return {'snapshot':'stable'}
        finally:active['capture']=False
    capability=types.SimpleNamespace(capture_snapshot=capture,SnapshotCleanupError=Cleanup,InvalidGateBudget=Budget)
    def popen(argv,**kwargs):
        require(argv==['fixture-body'] and kwargs['start_new_session'] is False,'wrong active body launch')
        spawns.append(argv);require(len(spawns)==1,'active stop restarted body')
        active['body']=True
        def poll():
            polls.append(None);require(len(polls)<=3,'active body poll ceiling')
            if mode=='poll-race':
                active['stop_published']=True;ns['interrupted']=True
            return 0
        return types.SimpleNamespace(pid=402,poll=poll)
    def drain(resource,deadline,preserve):
        require(resource==identity['coalition_id'] and deadline==10 and preserve==identity,'active stop lost owned cleanup')
        drains.append(resource);require(len(drains)<=3,'active stop cleanup ceiling')
        active['body']=False
        if mode=='poll-race':clock.value=10
        return True
    def controller_identity(pid):
        require(pid==controller['pid'],'active model inspected unrelated controller')
        if mode=='capture-latepredicate' and active['race_armed']:
            active['late_checks']+=1
            if active['late_checks']==2:
                active['stop_published']=True;ns['interrupted']=True
                return None
        return None if mode=='capture-lost' and active['stop_published'] else dict(controller)
    api=types.SimpleNamespace(CapabilityError=CapabilityError,CLOCK_CONTRACT='CLOCK_MONOTONIC_V1',
        require_clock_contract=lambda value:require(value=='CLOCK_MONOTONIC_V1','active stop mixed clock'),
        joined_identity=lambda pid:dict(identity),identity_if_present=controller_identity,
        same_process=lambda a,b:a==b,clock_now=clock.now,drain=drain,
        task_counts=lambda resource:(1,0) if not active['body'] and not active['capture'] else (2,0),
        _drained=lambda *args:not active['body'] and not active['capture'])
    ns=dict(json=json,math=math,open=opened,time=clock,Path=Path,SimpleNamespace=types.SimpleNamespace,
        __file__='/private/fixture/darwin-runner.py',os=types.SimpleNamespace(getpid=lambda:401),
        interrupted=False,receive_signal=lambda *args:None,
        signal=types.SimpleNamespace(SIGINT=2,SIGTERM=15,SIGHUP=1,signal=lambda *args:None),
        subprocess=types.SimpleNamespace(Popen=popen),write_state=published,DARWIN=api,
        importlib=types.SimpleNamespace(util=types.SimpleNamespace(
            spec_from_file_location=lambda *args:types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda module:None)),
            module_from_spec=lambda value:capability)))
    declarations(RUNNER,{'run','controller_alive','request','retirement_result','finish','quiescent','snapshot'},ns)
    assert ns['run']('spec')==98
    assert len(spawns)==1 and states[-1]['phase']=='retired' and states[-1]['code']==98
    assert states[-1]['sealed'] is True and states[-1]['quiescent'] is True
    assert not any(row.get('phase') in ('normal-after-complete','fallback-complete') for row in states)
    if mode in ('body','poll-race'):
        if mode=='poll-race':assert len(polls)==1 and clock.value==10 and len(drains)==1
        else:assert not polls
        assert not captures and states[-1]['sequence']==2
        assert not any(row.get('phase')=='body-quiescent' for row in states)
    else:
        assert len(polls)==1 and captures==[('after',10,10)] and states[-1]['sequence']==3
        assert active['stop_published'] is True
        if mode in ('capture-interrupted','capture-lost','capture-oldfd','capture-latepredicate'):assert clock.value==10 and len(drains)==1
        if mode=='capture-oldfd':assert active['old_reads']==1
        if mode=='capture-latepredicate':assert active['late_checks']==2
        if mode=='capture-cleanup-stop':
            assert states[-1]['reason']=='cleanup'
            assert 'owned verifier cleanup failed' in states[-1]['detail']
case('valid next stop seals active body before another poll or verifier',lambda:active_stop('body'))
case('valid next stop reaches shared capture and seals without another phase',lambda:active_stop('capture'))
case('stop published during body poll is consumed before cleanup exhausts deadline',lambda:active_stop('poll-race'))
case('shared snapshot consumes stop before interruption and cleanup exhausts deadline',lambda:active_stop('capture-interrupted'))
case('shared snapshot consumes stop before controller loss and cleanup exhausts deadline',lambda:active_stop('capture-lost'))
case('old open ACK descriptor cannot hide published stop and signal from snapshot',lambda:active_stop('capture-oldfd'))
case('late raw snapshot cancellation invokes one final authenticated peek',lambda:active_stop('capture-latepredicate'))
case('fresh stop after snapshot cleanup failure preserves cleanup priority',lambda:active_stop('capture-cleanup-stop'))

def persistent_outer_clock_failure():
    clocks=[];productive=[];cleanups=[];verdicts=[];removed=[]
    def broken_clock():
        clocks.append(None);require(len(clocks)<=3,'persistent clock failure looped')
        raise OSError('persistent fixture clock unavailable')
    def forbidden(*args,**kwargs):
        productive.append((args,kwargs))
        raise FixtureOracle('persistent clock failure authorized productive fallback')
    def cleanup(*args,**kwargs):
        cleanups.append((args,kwargs))
        require(args[5]=='state' and kwargs['token']=='nonce' and kwargs['sequence']==3,'outer handler lost current custody binding')
        return False
    ns=dict(error=OSError('outer phase failed'),reason=None,detail=None,sequence=3,identity_verified=True,
        identity=identity,owner=types.SimpleNamespace(),owned_service=True,retirement={},output_cursor={'output_line_start':True},
        interrupted=types.SimpleNamespace(is_set=lambda:False),deadline=100,SNAPSHOT_STOP_RESERVE_SECONDS=2,NO_VERDICT=98,
        clock_now=broken_clock,_write_job_request=forbidden,_read_job_state=forbidden,_wait_job_phase=forbidden,
        _darwin_cleanup=cleanup,launchctl='launchctl',service='owned-service',scratch='private',
        no_verdict=lambda why,detail,**kwargs:verdicts.append((why,detail)) or 98,
        shutil=types.SimpleNamespace(rmtree=lambda *args,**kwargs:removed.append(args)))
    declarations(SUPERVISOR,{'JobRequestCancelled'},ns)
    setup=ast.parse('status_path="state"\nnonce="nonce"').body
    guarded=ast.Try(body=copy.deepcopy(main.handlers[0].body),handlers=[],orelse=[],finalbody=copy.deepcopy(main.finalbody))
    assert actual_function('outer_clock_fault',setup+[guarded],ns)()==98
    assert clocks and not productive and len(cleanups)==1 and not removed
    assert len(verdicts)==1 and verdicts[0][0]=='cleanup'
    assert 'persistent fixture clock unavailable' in verdicts[0][1] and 'custody retained' in verdicts[0][1]
case('persistent outer clock failure publishes no fallback and retains custody98',persistent_outer_clock_failure)

print('DARWIN_PHASE_RESULT='+json.dumps({'cases':results,'realProcessStarts':0,'nativeQueries':0,'realStateFileWrites':0,'canonicalAdmissionProved':False,'hostKernelCustodyProved':False}))
`;

test('Darwin phase ownership keeps relay, retirement and failed verdicts ordered', { timeout: 30000 }, () => {
  const result = spawnSync(process.env.DISCORD_SURFACE_PYTHON || 'python3', ['-I', '-B', '-c', darwinPhaseProgram,
    SUPERVISOR_SCRIPT, path.join(PROJECT, 'scripts/full-gate/darwin-runner.py'), path.join(PROJECT, 'scripts/full-gate/darwin.py')
  ], { cwd: PROJECT, encoding: 'utf8', timeout: 25000, env: pythonTestEnvironment() });
  assert.equal(result.status, 0, result.error?.message || result.stdout + '\n' + result.stderr);
  const line = result.stdout.split('\n').find(value => value.startsWith('DARWIN_PHASE_RESULT='));
  assert.ok(line, result.stdout);
  const report = JSON.parse(line.slice('DARWIN_PHASE_RESULT='.length));
  assert.equal(report.realProcessStarts, 0);
  assert.equal(report.nativeQueries, 0);
  assert.equal(report.realStateFileWrites, 0);
});


test('Darwin guardian retains an after verifier when its outer controller dies', { skip: process.platform !== 'darwin', timeout: 120000 }, async t => {
  const f = fixture(t);
  const directory = path.join(f.scratch, 'private-owner', 'scripts', 'full-gate');
  fs.mkdirSync(directory, { recursive: true });
  const alarmMarker = path.join(f.scratch, 'fixture-self-destruct');
  const verifierAlarm = path.join(f.scratch, 'verifier-self-destruct');
  const afterMarker = path.join(f.scratch, 'after-verifier');
  const termMarker = path.join(f.scratch, 'verifier-term');
  const alarm = [
    'import os, signal',
    'def fixture_alarm(*args):',
    '    try: open(' + JSON.stringify(alarmMarker) + ', "w").write("expired")',
    '    finally: os._exit(94)',
    'signal.signal(signal.SIGALRM, fixture_alarm)',
    'signal.alarm(70)', ''
  ].join('\n');
  for (const file of ['supervisor.py', 'darwin-runner.py', 'darwin.py']) {
    const source = fs.readFileSync(path.join(PROJECT, 'scripts/full-gate', file), 'utf8');
    fs.writeFileSync(path.join(directory, file), (file === 'darwin.py' ? '' : alarm) + source);
  }
  fs.symlinkSync(GATE, path.join(directory, '..', 'full-gate.js'));
  const bin = path.join(f.scratch, 'after-bin');
  fs.mkdirSync(bin);
  const nodeWrapper = [
    '#!/usr/bin/env python3',
    'import importlib.util,json,os,signal,sys,time',
    'sys.dont_write_bytecode = True',
    'def expired(*args):',
    '    try: open(' + JSON.stringify(verifierAlarm) + ',"w").write("expired")',
    '    finally: os._exit(95)',
    'signal.signal(signal.SIGALRM,expired)',
    'signal.alarm(45)',
    'if sys.argv[-1] != "after": os.execv(' + JSON.stringify(process.execPath) + ',[' + JSON.stringify(process.execPath) + ']+sys.argv[1:])',
    'spec=importlib.util.spec_from_file_location("fixture_owner",' + JSON.stringify(path.join(PROJECT, 'scripts/full-gate/darwin.py')) + ')',
    'owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(owner)',
    'def captured(pid):',
    '    try: return {"kind":"present","platform":"darwin",**owner.joined_identity(pid)}',
    '    except OSError: return {"kind":"unknown","pid":pid}',
    'parent_pid=os.getppid()',
    'record={"verifier":captured(os.getpid()),"guardian":captured(parent_pid),"parent_pid":parent_pid}',
    'def term(*args): open(' + JSON.stringify(termMarker) + ',"w").write("term")',
    'signal.signal(signal.SIGTERM,term)',
    'open(' + JSON.stringify(afterMarker + '.tmp') + ',"w").write(json.dumps(record))',
    'os.replace(' + JSON.stringify(afterMarker + '.tmp') + ',' + JSON.stringify(afterMarker) + ')',
    'while True: time.sleep(0.025)', ''
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'node'), nodeWrapper, { mode: 0o700 });
  const run = f.launchSupervised({
    FIXTURE_SUPERVISOR_SCRIPT: path.join(directory, 'supervisor.py'),
    FIXTURE_LEASE_ENFORCE: '1', PATH: bin + path.delimiter + process.env.PATH,
    APERTURE_GATE_TIME_LEFT_S: '50', APERTURE_GATE_SLOWEST_RUN_S: '1'
  });
  let record;
  try {
    const eventDeadline = Date.now() + 55000;
    while (!fs.existsSync(afterMarker) && Date.now() < eventDeadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(fs.existsSync(afterMarker), true, 'after verifier never published its start event');
    record = JSON.parse(fs.readFileSync(afterMarker, 'utf8'));
    assert.equal(roleFixture.sameProcessIdentity(record.verifier, roleFixture.captureIdentity(record.verifier.pid)), true);
    assert.equal(record.guardian.pid, record.parent_pid, 'native guardian record did not match verifier parent');
    assert.equal(roleFixture.sameProcessIdentity(record.guardian, roleFixture.captureIdentity(record.guardian.pid)), true, 'after verifier has no live guardian');
    const held = JSON.parse(fs.readFileSync(f.leaseFile, 'utf8')).holders;
    assert.equal(held.some(identity => roleFixture.sameProcessIdentity(record.guardian, identity)), true, 'private fixture lost guardian holder');
    assert.equal(roleFixture.signalOwned(run.identity, 'SIGKILL'), true);
    const result = await run.done;
    assert.equal(result.signal, 'SIGKILL');
    const stopDeadline = Date.now() + 55000;
    while (!roleFixture.identityGone(record.verifier, roleFixture.captureIdentity(record.verifier.pid)) && Date.now() < stopDeadline) {
      assert.equal(roleFixture.identityGone(record.guardian, roleFixture.captureIdentity(record.guardian.pid)), false, 'guardian retired while verifier still lived');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(roleFixture.identityGone(record.verifier, roleFixture.captureIdentity(record.verifier.pid)), true);
    assert.equal(fs.existsSync(verifierAlarm), false, 'verifier merely reached its independent self-destruct');
    assert.equal(fs.existsSync(termMarker), true, 'owned verifier stop was never attempted');
    assert.equal(await waitForIdentityGone(record.guardian, Date.now() + 15000), true);
    assert.equal(fs.existsSync(alarmMarker), false, 'custodian merely reached its independent self-destruct');
  } finally {
    if (record) for (const identity of [record.verifier, record.guardian]) {
      const observed = roleFixture.captureIdentity(identity.pid);
      if (roleFixture.sameProcessIdentity(identity, observed)) roleFixture.signalOwned(identity, 'SIGKILL');
      assert.equal(await waitForIdentityGone(identity, Date.now() + 15000), true, 'bounded fixture cleanup remains unresolved');
    }
  }
});
