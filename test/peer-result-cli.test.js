'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { fixture, addRecipient } = require('./fixtures/peer-fixture');
const { SurfaceState } = require('../src/state');
const { encodeAgentMessage, KINDS } = require('../src/agent-message');
const { createPeerResultCommand } = require('../src/cli/peer-result');

const CLI = path.resolve(__dirname, '../src/cli.js');
const NATIVE = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

function prepared(t, provider = 'codex') {
  const f = fixture(t);
  f.state.db.prepare("UPDATE bindings SET provider=? WHERE channel_id='101'").run(provider);
  f.enroll('102');
  const target = addRecipient(f);
  const caller = f.state.getBinding('101');
  const request = { id: 'cli-inspection', kind: KINDS.REQUEST,
    source: { guildId: '100', channelId: '102', provider, nativeId: NATIVE, generation: caller.generation },
    target: { guildId: '100', channelId: '202', provider: 'codex', nativeId: target.nativeId, generation: target.generation },
    routingVersion: 2, replyTo: null, text: 'inspect the result' };
  const detail = { journal: 'direct-post-v1', requestId: request.id, guildId: caller.guildId,
    channelId: caller.channelId, provider: caller.provider, nativeId: caller.nativeId, generation: caller.generation,
    partIndex: 0, partCount: 1, attemptId: 'cli-attempt', agentPacket: request };
  f.state.receipt(null, 'direct-post-attempt', detail);
  f.state.receipt(null, 'direct-post-outcome', { ...detail, outcome: 'sent', messageId: '10001' });
  const packet = { id: 'cli-result', kind: KINDS.RESULT, source: request.target, target: request.source,
    routingVersion: 2, sourceParentChannelId: '201', replyTo: request.id, text: 'correlated reply' };
  const accepted = f.state.acceptDiscordMessage({ id: '10002', guildId: '100', channelId: '102',
    authorId: '901', isBot: true, content: encodeAgentMessage(packet, 'fixture') }, { agentToken: 'fixture' });
  assert.equal(accepted.accepted, true, JSON.stringify(accepted));
  return { ...f, packet, request, db: path.join(caller.workspace, 'surface.sqlite') };
}

function runCli(f, argv, environment = {}) {
  const deadline = path.join(path.dirname(f.db), 'cli-deadline.cjs');
  fs.writeFileSync(deadline, 'setTimeout(() => process.exit(124), 4000).unref();\n');
  return spawnSync(process.execPath, ['--require', deadline, CLI, ...argv], {
    env: { ...process.env, ...environment },
    encoding: 'utf8', timeout: 6000, maxBuffer: 65536
  });
}

function invoke(f, flags = [], identity = NATIVE) {
  return runCli(f, ['peer-result', '--provider', 'codex', '--db', f.db,
    '--correlation-id', f.request.id, ...flags], { CODEX_THREAD_ID: identity, CODEX_SESSION_ID: identity });
}

function createNetworkTrap(f) {
  const dir = path.dirname(f.db);
  const preload = path.join(dir, 'cli-network-trap.cjs');
  const marker = path.join(dir, 'network-trap-hit');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const preload = ${JSON.stringify(preload)};
    const marker = ${JSON.stringify(marker)};
    const probeLabels = {
      fetch: 'fetch',
      'http.get': 'node:http.get',
      'socket.connect': 'node:net.Socket.connect',
      'dns.lookup': 'node:dns.lookup',
      'http2.connect': 'node:http2.connect'
    };
    const blocked = fallback => (...args) => {
      const probe = process.env.PEER_RESULT_TEST_NETWORK_PROBE;
      const name = probeLabels[probe] || fallback;
      fs.writeFileSync(marker, name);
      throw new Error('NETWORK_BLOCKED:' + name);
    };
    const patchBindingMethod = (bindingName, ownerName, methodName, label) => {
      const owner = process.binding(bindingName)[ownerName];
      if (!owner || typeof owner.prototype?.[methodName] !== 'function') {
        throw new Error('NETWORK_TRAP_UNSUPPORTED:' + bindingName + '.' + ownerName + '.' + methodName);
      }
      owner.prototype[methodName] = blocked(label);
    };
    patchBindingMethod('tcp_wrap', 'TCP', 'connect', 'tcp_wrap.TCP.connect');
    patchBindingMethod('tcp_wrap', 'TCP', 'connect6', 'tcp_wrap.TCP.connect6');
    const udpPrototype = process.binding('udp_wrap').UDP.prototype;
    for (const methodName of Object.getOwnPropertyNames(udpPrototype)) {
      if (/^(bind|connect|send)/.test(methodName) && typeof udpPrototype[methodName] === 'function') {
        udpPrototype[methodName] = blocked('udp_wrap.UDP.' + methodName);
      }
    }
    const caresWrap = process.binding('cares_wrap');
    caresWrap.getaddrinfo = blocked('cares_wrap.getaddrinfo');
    caresWrap.getnameinfo = blocked('cares_wrap.getnameinfo');
    const channelPrototype = caresWrap.ChannelWrap.prototype;
    const channelConfigurationMethods = new Set([
      'constructor', 'getServers', 'setServers', 'setLocalAddress', 'cancel'
    ]);
    for (const methodName of Object.getOwnPropertyNames(channelPrototype)) {
      if (!channelConfigurationMethods.has(methodName) && typeof channelPrototype[methodName] === 'function') {
        channelPrototype[methodName] = blocked('cares_wrap.ChannelWrap.' + methodName);
      }
    }

    const dns = require('node:dns');

    const processWrap = process.binding('process_wrap');
    const addPreload = existingOptions => existingOptions.includes(preload)
      ? existingOptions
      : [existingOptions, '--require=' + JSON.stringify(preload)].filter(Boolean).join(' ');
    const addNetworkTrap = options => {
      const childOptions = options || {};
      const envPairs = Array.isArray(childOptions.envPairs) ? childOptions.envPairs : [];
      const existing = envPairs.find(pair => pair.startsWith('NODE_OPTIONS='));
      const existingOptions = existing ? existing.slice('NODE_OPTIONS='.length) : '';
      const nextOptions = addPreload(existingOptions);
      return { ...childOptions,
        envPairs: [...envPairs.filter(pair => !pair.startsWith('NODE_OPTIONS=')), 'NODE_OPTIONS=' + nextOptions] };
    };
    const addNetworkEnvironment = environment => {
      const nextEnvironment = { ...(environment === undefined ? process.env : environment) };
      nextEnvironment.NODE_OPTIONS = addPreload(nextEnvironment.NODE_OPTIONS || '');
      return nextEnvironment;
    };
    const workerThreads = require('node:worker_threads');
    const OriginalWorker = workerThreads.Worker;
    const GuardedWorker = new Proxy(OriginalWorker, {
      construct(target, args, newTarget) {
        const [filename, options = {}] = args;
        const inheritedEnv = options.env === undefined ? process.env : options.env;
        const workerOptions = { ...options };
        if (inheritedEnv !== workerThreads.SHARE_ENV) {
          workerOptions.env = addNetworkEnvironment(inheritedEnv);
        }
        return Reflect.construct(target, [filename, workerOptions], newTarget);
      },
      getPrototypeOf() {
        return Function.prototype;
      }
    });
    Object.defineProperty(OriginalWorker.prototype, 'constructor', {
      value: GuardedWorker,
      configurable: true,
      writable: true
    });
    workerThreads.Worker = GuardedWorker;
    if (typeof process.execve === 'function') {
      const processExecve = process.execve;
      process.execve = function(file, args, environment) {
        return processExecve.call(process, file, args, addNetworkEnvironment(environment));
      };
    }
    const processSpawn = processWrap.Process.prototype.spawn;
    processWrap.Process.prototype.spawn = function(options) {
      return processSpawn.call(this, addNetworkTrap(options));
    };
    const spawnSyncBinding = process.binding('spawn_sync');
    const spawnSync = spawnSyncBinding.spawn;
    spawnSyncBinding.spawn = function(options) {
      return spawnSync.call(this, addNetworkTrap(options));
    };

    globalThis.__peerResultInspectorTargets = {
      worker: workerThreads.Worker,
      execve: process.execve,
      spawn: processWrap.Process.prototype.spawn,
      spawnSync: spawnSyncBinding.spawn
    };
    const originalProcessBinding = process.binding;
    const inspectorCoverage = { node: process.versions.node, modules: [], binding: { status: 'unsupported', constructors: [] } };
    try {
      const binding = originalProcessBinding.call(process, 'inspector');
      inspectorCoverage.binding = {
        status: 'available',
        constructors: ['Connection', 'MainThreadConnection'].map(name => ({
          name, available: typeof binding[name] === 'function'
        }))
      };
    } catch (error) {
      inspectorCoverage.binding = { status: 'unsupported', reason: error.code || error.name, constructors: [] };
    }
    const disableInspectorGuard = process.env.PEER_RESULT_TEST_DISABLE_INSPECTOR_GUARD === '1';
    const rejectInspectorAccess = blocked('node:inspector');
    const inspectorModuleNames = ['inspector', 'node:inspector', 'inspector/promises', 'node:inspector/promises'];
    for (const moduleName of inspectorModuleNames) {
      let inspectorApi;
      try {
        inspectorApi = require(moduleName);
      } catch (error) {
        inspectorCoverage.modules.push({ module: moduleName, status: 'unsupported', reason: error.code || error.name, methods: [] });
        continue;
      }
      const Session = inspectorApi.Session;
      if (typeof Session !== 'function' || !Session.prototype) {
        inspectorCoverage.modules.push({ module: moduleName, status: 'unsupported', reason: 'Session export missing', methods: [] });
        continue;
      }
      const methodOwners = new Map();
      for (let prototype = Session.prototype; prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
        for (const name of Object.getOwnPropertyNames(prototype)) {
          if (name.startsWith('connect') && typeof prototype[name] === 'function') methodOwners.set(name, prototype);
        }
      }
      const methods = [...methodOwners.keys()];
      const unsupportedMethods = ['connect', 'connectToMainThread'].filter(name => !methodOwners.has(name));
      const guardedMethods = [];
      if (!disableInspectorGuard) {
        for (const [method, owner] of methodOwners) {
          owner[method] = rejectInspectorAccess;
          guardedMethods.push(method);
        }
        inspectorApi.Session = new Proxy(Session, {
          construct() { return rejectInspectorAccess(); },
          apply() { return rejectInspectorAccess(); }
        });
      }
      inspectorCoverage.modules.push({
        module: moduleName,
        status: 'available',
        methods,
        unsupportedMethods,
        guardedMethods
      });
    }
    if (!disableInspectorGuard) {
      process.binding = function(name, ...args) {
        if (name === 'inspector') return rejectInspectorAccess();
        return Reflect.apply(originalProcessBinding, this, [name, ...args]);
      };
    }
    if (process.env.PEER_RESULT_TEST_INSPECTOR_CENSUS_FILE) {
      fs.writeFileSync(process.env.PEER_RESULT_TEST_INSPECTOR_CENSUS_FILE, JSON.stringify(inspectorCoverage));
    }

    const runInspectorControl = async () => {
      const inspector = require('node:inspector/promises');
      const session = new inspector.Session();
      const receipt = process.env.PEER_RESULT_TEST_INSPECTOR_RECEIPT;
      const workerMarker = process.env.PEER_RESULT_TEST_INSPECTOR_WORKER_MARKER;
      const attemptMarker = process.env.PEER_RESULT_TEST_INSPECTOR_ATTEMPT_MARKER;
      const stageMarker = attemptMarker + '.release';
      const findings = [];
      const evaluate = async expression => {
        const response = await session.post('Runtime.evaluate', { expression });
        if (response.exceptionDetails) throw new Error('inspector evaluate failed');
        return response.result;
      };
      const properties = async objectId => session.post('Runtime.getProperties', { objectId, ownProperties: true });
      const wrapperHasScope = async (name, bindingName) => {
        const wrapper = await evaluate('globalThis.__peerResultInspectorTargets.' + name);
        if (!wrapper.objectId) return false;
        const details = await properties(wrapper.objectId);
        const scopes = (details.internalProperties || []).find(item => item.name === '[[Scopes]]');
        if (!scopes || !scopes.value.objectId) return false;
        const scopeList = await properties(scopes.value.objectId);
        for (const scope of scopeList.result.filter(item => /^\\d+$/.test(item.name))) {
          if (!scope.value.objectId) continue;
          const bindings = await properties(scope.value.objectId);
          if (bindings.result.some(item => item.name === bindingName)) return true;
        }
        return false;
      };
      session.connect();
      try {
        const worker = await evaluate('globalThis.__peerResultInspectorTargets.worker');
        const workerDetails = await properties(worker.objectId);
        const originalWorker = (workerDetails.internalProperties || []).find(item => item.name === '[[Target]]');
        findings.push({ site: 'Worker', reachable: Boolean(originalWorker && originalWorker.value.objectId) });
        findings.push({ site: 'execve', reachable: await wrapperHasScope('execve', 'processExecve'), supported: typeof process.execve === 'function' });
        findings.push({ site: 'spawn', reachable: await wrapperHasScope('spawn', 'processSpawn'), supported: true });
        findings.push({ site: 'spawn_sync', reachable: await wrapperHasScope('spawnSync', 'spawnSync'), supported: true });
        if (!originalWorker || !originalWorker.value.objectId) throw new Error('Worker [[Target]] was not reachable');
        if (!(await wrapperHasScope('spawn', 'processSpawn'))) throw new Error('spawn [[Scopes]] did not expose processSpawn');
        if (!(await wrapperHasScope('spawnSync', 'spawnSync'))) throw new Error('spawn_sync [[Scopes]] did not expose spawnSync');
        if (typeof process.execve === 'function' && !(await wrapperHasScope('execve', 'processExecve'))) {
          throw new Error('execve [[Scopes]] did not expose processExecve');
        }
        const workerData = { transport: 'simulated', workerMarker, attemptMarker, stageMarker };
        const workerOptions = { eval: true, env: {}, workerData };
        const workerSource = [
          "const fs=require('node:fs');",
          "const {workerData}=require('node:worker_threads');",
          "const stageWait=new Int32Array(new SharedArrayBuffer(4));",
          "const workerDeadline=Date.now()+1200;",
          "const trapLoaded=Boolean(/(?:--require|--import).*trap/i.test(process.env.NODE_OPTIONS||'')||process.execArgv.some(arg=>/--(?:require|import).*trap/i.test(arg))||Object.keys(require.cache).some(path=>/trap/i.test(path)));",
          "const attempt={transport:workerData.transport,operation:'connect',port:9,host:'127.0.0.1',trapLoaded};",
          "let terminal=false;",
          "const finish=(state,details={})=>{if(terminal)return false;terminal=true;fs.writeFileSync(workerData.attemptMarker,JSON.stringify({...attempt,state,...details}));return true};",
          "const expire=()=>{if(Date.now()<workerDeadline||terminal)return false;finish('deadline');process.exit(124);return true};",
          "fs.writeFileSync(workerData.workerMarker,JSON.stringify({executed:true,trapLoaded}));",
          "const deadline=setTimeout(()=>{if(finish('deadline'))process.exit(124)},Math.max(0,workerDeadline-Date.now()));",
          "const simulatedTransport={connect(port,host){if(workerData.transport!=='simulated')throw new Error('simulated transport required');fs.writeFileSync(workerData.attemptMarker,JSON.stringify({...attempt,state:'attempted'}));while(!fs.existsSync(workerData.stageMarker)){if(expire())return{on(){return this},destroy(){}};Atomics.wait(stageWait,0,0,Math.max(1,Math.min(10,workerDeadline-Date.now())))}if(expire())return{on(){return this},destroy(){}};return{on(event,callback){if(event==='error'){queueMicrotask(()=>{const error=Object.assign(new Error('simulated transport error'),{code:'SIMULATED'});if(expire())return;if(finish('error',{code:error.code}))callback(error)})}return this},destroy(){}}}};",
          "try{const socket=simulatedTransport.connect(9,'127.0.0.1');",
          "socket.on('connect',()=>{if(finish('connected')){clearTimeout(deadline);socket.destroy();process.exit(0)}});",
          "socket.on('error',error=>{if(!terminal)finish('error',{code:error.code});clearTimeout(deadline);process.exit(error.code==='SIMULATED'?0:1)})}",
          "catch(error){clearTimeout(deadline);process.exit(terminal?124:1)}"
        ].join('');
        const started = await session.post('Runtime.callFunctionOn', {
          objectId: originalWorker.value.objectId,
          functionDeclaration: 'function(){ return new this(' + JSON.stringify(workerSource) + ', ' + JSON.stringify(workerOptions) + '); }',
          returnByValue: false
        });
        if (started.exceptionDetails) throw new Error('Worker construction failed');
      } finally {
        session.disconnect();
      }
      fs.writeFileSync(receipt, JSON.stringify(findings));
      const wait = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 1800;
      let terminalAttempt = null;
      let workerReleased = false;
      while (!terminalAttempt && Date.now() < deadline) {
        let attempt;
        try {
          attempt = JSON.parse(fs.readFileSync(attemptMarker, 'utf8'));
        } catch {}
        if (attempt && attempt.state === 'attempted' && !workerReleased && process.env.PEER_RESULT_TEST_INSPECTOR_HOLD_STAGE !== '1') {
          fs.writeFileSync(stageMarker, 'released');
          workerReleased = true;
        }
        if (attempt && attempt.state === 'deadline') throw new Error('inspector worker reached its deadline before the simulated error');
        if (attempt && attempt.state === 'error' && attempt.code === 'SIMULATED') terminalAttempt = attempt;
        if (!terminalAttempt) Atomics.wait(wait, 0, 0, 10);
      }
      if (!terminalAttempt) throw new Error('inspector worker did not publish a terminal simulated connect error');
    };

    const runProbe = probe => {
      const net = require('node:net');
      const probeActions = {
        'inspector.session': () => new (require('node:inspector').Session)().connect(),
        'inspector.promises.session': () => new (require('node:inspector/promises').Session)().connect(),
        'inspector.connectToMainThread': () => require('node:inspector').Session.prototype.connectToMainThread.call({}),
        'inspector.promises.connectToMainThread': () => require('node:inspector/promises').Session.prototype.connectToMainThread.call({}),
        'inspector.binding': () => process.binding('inspector'),
        'inspector.method': () => {
          const moduleName = process.env.PEER_RESULT_TEST_INSPECTOR_MODULE;
          const methodName = process.env.PEER_RESULT_TEST_INSPECTOR_METHOD;
          const method = require(moduleName).Session.prototype[methodName];
          if (typeof method !== 'function') throw new Error('inspector method disappeared: ' + moduleName + '.' + methodName);
          return method.call({});
        },
        'inspector.control': () => {
          runInspectorControl().then(
            () => process.exit(0),
            error => { console.error(error.stack || error.message); process.exit(1); }
          );
        },
        fetch: () => globalThis.fetch('http://127.0.0.1:8080/'),
        'http.get': () => require('node:http').get('http://127.0.0.1:9/'),
        'socket.connect': () => new net.Socket().connect(9, '127.0.0.1'),
        'socket.prototype.connect': () => {
          const socket = new net.Socket();
          Object.getPrototypeOf(socket).connect.call(socket, 9, '127.0.0.1');
        },
        'socket.connect6': () => net.connect(9, '::1'),
        'dns.lookup': () => dns.lookup('localhost', () => {}),
        'dns.promises.lookup': () => dns.promises.lookup('localhost'),
        'dns.reverse': () => {
          dns.setServers(['127.0.0.1:9']);
          dns.reverse('192.0.2.1', () => {});
        },
        'dns.lookupService': () => dns.lookupService('192.0.2.1', 80, () => {}),
        'http2.connect': () => require('node:http2').connect('http://127.0.0.1:9'),
        'dns.resolver': () => {
          const resolver = new dns.Resolver();
          resolver.setServers(['127.0.0.1:9']);
          resolver.resolve4('trap.invalid', () => {});
        },
        'dns.promises.resolver': () => {
          const resolver = new dns.promises.Resolver();
          resolver.setServers(['127.0.0.1:9']);
          resolver.resolve4('trap.invalid').catch(() => {});
        },
        'dns.resolveCaa': () => {
          dns.setServers(['127.0.0.1:9']);
          dns.resolveCaa('trap.invalid', () => {});
        },
        'dns.resolve4': () => {
          dns.setServers(['127.0.0.1:9']);
          dns.resolve4('trap.invalid', () => {});
        },
        'dns.setServers': () => {
          dns.setServers(['127.0.0.1:9']);
          dns.resolve4('trap.invalid', () => {});
        },
        'dns.promises.setServers': () => {
          const resolver = new dns.promises.Resolver();
          resolver.setServers(['127.0.0.1:9']);
          resolver.resolve4('trap.invalid').catch(() => {});
        },
        'datagram.send': () => {
          const socket = require('node:dgram').createSocket({ type: 'udp4',
            lookup: (_host, _options, callback) => callback(null, '127.0.0.1', 4) });
          socket.send(Buffer.from('probe'), 9, 'trap.invalid', () => {});
        },
        'tcp.raw': () => {
          const binding = process.binding('tcp_wrap');
          new binding.TCP(binding.constants.SOCKET).connect({}, '127.0.0.1', 9, 4);
        },
        'child_process.spawn': () => {
          const child = require('node:child_process').spawn(process.execPath,
            ['-e', "require('node:net').connect(9, '127.0.0.1')"], { env: {}, stdio: 'ignore' });
          child.on('error', () => {});
          child.on('exit', () => {});
        },
        'child_process.spawnSync': () => require('node:child_process').spawnSync(process.execPath,
          ['-e', "require('node:net').connect(9, '127.0.0.1')"], { env: {} }),
        'worker.env.empty': () => {
          const worker = new workerThreads.Worker(
            "require('node:net').connect(9, '127.0.0.1')", { eval: true, env: {} });
          worker.on('error', () => {});
          worker.on('exit', () => {});
        },
        'worker.constructor.chain': () => {
          const exposedConstructor = Object.getPrototypeOf(workerThreads.Worker);
          const code = "require('node:net').connect(9, '127.0.0.1')";
          if (exposedConstructor === Function.prototype) {
            let constructionError;
            try {
              Reflect.construct(exposedConstructor, [code, { eval: true, env: {} }]);
            } catch (error) {
              constructionError = error;
            }
            if (!(constructionError instanceof TypeError)) {
              throw new Error('WORKER_CONSTRUCTOR_PATH_CONSTRUCTABLE');
            }
            return;
          }
          const candidate = Reflect.construct(exposedConstructor, [code, { eval: true, env: {} }]);
          if (candidate && typeof candidate.on === 'function') {
            candidate.on('error', () => {});
            candidate.on('exit', () => {});
            if (typeof candidate.terminate === 'function') candidate.terminate();
          }
          throw new Error('WORKER_CONSTRUCTOR_CHAIN_EXPOSED');
        },
        'worker.prototype.constructor': () => {
          const worker = new workerThreads.Worker.prototype.constructor(
            "require('node:net').connect(9, '127.0.0.1')", { eval: true, env: {} });
          worker.on('error', () => {});
          worker.on('exit', () => {});
        }
      };
      if (typeof process.execve === 'function') {
        probeActions['process.execve.empty'] = () => process.execve(process.execPath,
          [process.execPath, '-e', "require('node:net').connect(9, '127.0.0.1')"], {});
      }
      const action = probeActions[probe];
      if (!action) throw new Error('NETWORK_TRAP_UNKNOWN_PROBE:' + probe);
      action();
    };

    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      const loaded = originalLoad.call(this, request, parent, isMain);
      if (request !== 'node:sqlite') return loaded;
      const DatabaseSync = function(...args) {
        const probe = process.env.PEER_RESULT_TEST_NETWORK_PROBE;
        if (probe) runProbe(probe);
        return new loaded.DatabaseSync(...args);
      };
      DatabaseSync.prototype = loaded.DatabaseSync.prototype;
      return { ...loaded, DatabaseSync };
    };
  `);
  return { marker, preload };
}

test('public CLI reads the current caller result without credentials or custody changes', t => {
  const f = prepared(t);
  const dir = path.dirname(f.db);
  fs.chmodSync(dir, 0o755);
  fs.chmodSync(f.db, 0o644);
  const before = f.state.listReceipts();
  assert.equal(fs.existsSync(f.state.requireConfig().secretFile), false);
  const result = invoke(f);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.correlationId, f.request.id);
  assert.equal(output.sendOutcome, 'sent');
  assert.equal(output.results.length, 1);
  assert.equal(output.results[0].text, f.packet.text);
  assert.equal(output.results[0].state, 'accepted');
  assert.equal(output.results[0].nativeAcknowledged, false);
  assert.equal(output.results[0].completed, false);
  assert.deepEqual(f.state.listReceipts(), before);
  assert.equal(f.state.getMessage('10002').state, 'accepted');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o755, 'inspection changed directory permissions');
  assert.equal(fs.statSync(f.db).mode & 0o777, 0o644, 'inspection changed database permissions');
});

test('public CLI projects native acknowledgment separately from send and completion', t => {
  const f = prepared(t);
  const message = f.state.getMessage('10002');
  f.state.claimDispatch(message.id);
  f.state.markSubmitted(message.id);
  require('../src/acknowledgment').recordNativeAcknowledgment(f.state, {
    provider: message.provider, nativeId: message.nativeId, generation: message.generation, messageId: message.id
  });
  const submitted = f.state.getMessage(message.id);
  assert.equal(submitted.state, 'submitted');
  assert.equal(f.state.hasNativeAcknowledgment(submitted), true);
  const before = f.state.listReceipts();
  const result = invoke(f);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.sendOutcome, 'sent');
  assert.equal(output.results[0].state, 'submitted');
  assert.equal(output.results[0].nativeAcknowledged, true);
  assert.equal(output.results[0].completed, false);
  assert.deepEqual(f.state.listReceipts(), before);
  assert.equal(f.state.getMessage(message.id).state, 'submitted');
});

test('public inspection is network-free and its trap catches an injected request', t => {
  const f = prepared(t);
  const trap = createNetworkTrap(f);
  const args = ['peer-result', '--provider', 'codex', '--db', f.db,
    '--correlation-id', f.request.id];
  const environment = { NODE_OPTIONS: `--require ${JSON.stringify(trap.preload)}`,
    CODEX_THREAD_ID: NATIVE, CODEX_SESSION_ID: NATIVE };
  const result = runCli(f, args, environment);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(trap.marker), false, 'inspection attempted network access');

  for (const [probeName, expected] of [
    ['fetch', 'fetch'],
    ['http.get', 'node:http.get'],
    ['socket.connect', 'node:net.Socket.connect'],
    ['dns.lookup', 'node:dns.lookup'],
    ['http2.connect', 'node:http2.connect']
  ]) {
    fs.rmSync(trap.marker, { force: true });
    const probe = runCli(f, args, { ...environment, PEER_RESULT_TEST_NETWORK_PROBE: probeName });
    assert.equal(probe.status, 1, probeName);
    assert.ok(probe.stderr.includes(`NETWORK_BLOCKED:${expected}`), probeName);
    assert.equal(fs.readFileSync(trap.marker, 'utf8'), expected, probeName);
  }
});

test('public CLI denies inspector access before closure guards and preserves ordinary reads', async t => {
  const f = prepared(t);
  const trap = createNetworkTrap(f);
  const args = ['peer-result', '--provider', 'codex', '--db', f.db,
    '--correlation-id', f.request.id];
  const censusFile = path.join(path.dirname(f.db), 'inspector-census.json');
  const attackReceipt = path.join(path.dirname(f.db), 'inspector-reachability.json');
  const workerMarker = path.join(path.dirname(f.db), 'inspector-worker.txt');
  const attemptMarker = path.join(path.dirname(f.db), 'inspector-connect-attempt.txt');
  const nodeOptions = `--require=${JSON.stringify(trap.preload)}`;
  const baseEnvironment = {
    CODEX_THREAD_ID: NATIVE,
    CODEX_SESSION_ID: NATIVE,
    NODE_OPTIONS: nodeOptions,
    PEER_RESULT_TEST_INSPECTOR_CENSUS_FILE: censusFile
  };
  const censusRun = runCli(f, args, baseEnvironment);
  assert.equal(censusRun.status, 0, censusRun.stderr);
  const census = JSON.parse(fs.readFileSync(censusFile, 'utf8'));
  assert.equal(census.node, process.versions.node);
  assert.deepEqual(census.modules.map(item => item.module), [
    'inspector', 'node:inspector', 'inspector/promises', 'node:inspector/promises'
  ]);
  for (const module of census.modules) {
    assert.equal(module.status, 'available', `${module.module} availability was not recorded`);
    assert.ok(module.methods.includes('connect'), `${module.module} connect was not censused`);
    assert.deepEqual(module.unsupportedMethods, [], `${module.module} is missing a supported connect entrypoint`);
    assert.deepEqual(module.guardedMethods, module.methods, `${module.module} has an unguarded connect entrypoint`);
  }
  assert.ok(census.modules.every(module => module.methods.includes('connectToMainThread')),
    'connectToMainThread must be present in the supported inspector facades');
  assert.deepEqual(census.binding.constructors, [
    { name: 'Connection', available: true },
    { name: 'MainThreadConnection', available: true }
  ]);

  const reject = (probe, extra = {}) => {
    fs.rmSync(trap.marker, { force: true });
    const result = runCli(f, args, {
      ...baseEnvironment,
      PEER_RESULT_TEST_NETWORK_PROBE: probe,
      ...extra
    });
    assert.equal(result.status, 1, `${probe}: ${result.stderr}`);
    assert.ok(result.stderr.includes('NETWORK_BLOCKED:node:inspector'), `${probe}: ${result.stderr}`);
    assert.equal(fs.readFileSync(trap.marker, 'utf8'), 'node:inspector', probe);
    assert.equal(fs.existsSync(workerMarker), false, `${probe} executed an unguarded Worker`);
    assert.equal(fs.existsSync(attemptMarker), false, `${probe} reached a private-loopback connect call`);
  };
  reject('inspector.session');
  reject('inspector.promises.session');
  reject('inspector.binding');
  for (const module of census.modules) {
    for (const method of module.methods) {
      reject('inspector.method', {
        PEER_RESULT_TEST_INSPECTOR_MODULE: module.module,
        PEER_RESULT_TEST_INSPECTOR_METHOD: method
      });
    }
  }

  fs.rmSync(trap.marker, { force: true });
  const deadlineWorkerMarker = `${workerMarker}.deadline`;
  const deadlineAttemptMarker = `${attemptMarker}.deadline`;
  const deadlineReceipt = `${attackReceipt}.deadline`;
  const deadlineControl = runCli(f, args, {
    ...baseEnvironment,
    PEER_RESULT_TEST_DISABLE_INSPECTOR_GUARD: '1',
    PEER_RESULT_TEST_NETWORK_PROBE: 'inspector.control',
    PEER_RESULT_TEST_INSPECTOR_RECEIPT: deadlineReceipt,
    PEER_RESULT_TEST_INSPECTOR_WORKER_MARKER: deadlineWorkerMarker,
    PEER_RESULT_TEST_INSPECTOR_ATTEMPT_MARKER: deadlineAttemptMarker,
    PEER_RESULT_TEST_INSPECTOR_HOLD_STAGE: '1'
  });
  assert.notEqual(deadlineControl.status, 0, deadlineControl.stderr);
  assert.equal(fs.existsSync(trap.marker), false, 'deadline control unexpectedly triggered the network trap');
  assert.ok(fs.existsSync(deadlineWorkerMarker), deadlineControl.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(deadlineWorkerMarker, 'utf8')), { executed: true, trapLoaded: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(deadlineAttemptMarker, 'utf8')), {
    transport: 'simulated',
    operation: 'connect',
    port: 9,
    host: '127.0.0.1',
    trapLoaded: false,
    state: 'deadline'
  });
  const deadlineReachability = JSON.parse(fs.readFileSync(deadlineReceipt, 'utf8'));
  assert.ok(deadlineReachability.filter(site => site.supported !== false).every(site => site.reachable));

  const causalControl = runCli(f, args, {
    ...baseEnvironment,
    PEER_RESULT_TEST_DISABLE_INSPECTOR_GUARD: '1',
    PEER_RESULT_TEST_NETWORK_PROBE: 'inspector.control',
    PEER_RESULT_TEST_INSPECTOR_RECEIPT: attackReceipt,
    PEER_RESULT_TEST_INSPECTOR_WORKER_MARKER: workerMarker,
    PEER_RESULT_TEST_INSPECTOR_ATTEMPT_MARKER: attemptMarker,
    PEER_RESULT_TEST_INSPECTOR_HOLD_STAGE: '0'
  });
  assert.equal(causalControl.status, 0, causalControl.stderr);
  assert.equal(fs.existsSync(trap.marker), false, 'disabled-guard control unexpectedly refused');
  assert.deepEqual(JSON.parse(fs.readFileSync(workerMarker, 'utf8')), { executed: true, trapLoaded: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(attemptMarker, 'utf8')), {
    transport: 'simulated',
    operation: 'connect',
    port: 9,
    host: '127.0.0.1',
    state: 'error',
    trapLoaded: false,
    code: 'SIMULATED'
  });
  const reachability = JSON.parse(fs.readFileSync(attackReceipt, 'utf8'));
  assert.ok(reachability.filter(site => site.supported !== false).every(site => site.reachable));
  assert.equal(reachability[0].site, 'Worker');
  assert.equal(reachability[1].site, 'execve');
  assert.equal(reachability[2].site, 'spawn');
  assert.equal(reachability[3].site, 'spawn_sync');

  fs.rmSync(trap.marker, { force: true });
  const ordinaryRead = runCli(f, args, baseEnvironment);
  assert.equal(ordinaryRead.status, 0, ordinaryRead.stderr);
  const output = JSON.parse(ordinaryRead.stdout);
  assert.equal(output.results[0].text, f.packet.text);
  assert.equal(fs.existsSync(trap.marker), false);
});

test('public CLI refuses another caller correlation and cannot select a native UUID', t => {
  const f = prepared(t);
  const before = f.state.listReceipts();
  const other = invoke(f, [], OTHER);
  assert.equal(other.status, 1);
  assert.equal(other.stdout, '');
  const override = invoke(f, ['--native-id', OTHER]);
  assert.equal(override.status, 1);
  assert.equal(override.stdout, '');
  assert.deepEqual(f.state.listReceipts(), before);
});

test('public CLI refuses absent or conflicting native invocation identity', t => {
  const f = prepared(t);
  const missing = invoke(f, [], '');
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  const result = runCli(f, ['peer-result', '--provider', 'codex', '--db', f.db,
    '--correlation-id', f.request.id], { CODEX_THREAD_ID: OTHER, CODEX_SESSION_ID: NATIVE });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
});

test('unknown-command usage matches the public help command list', t => {
  const f = prepared(t);
  const help = runCli(f, ['--help']);
  assert.equal(help.status, 0, help.stderr);
  const unknown = runCli(f, ['__unknown_command_for_test__']);
  assert.equal(unknown.status, 1);
  const helpStart = help.stdout.indexOf('Commands:');
  assert.notEqual(helpStart, -1, 'public help did not expose its command list');
  const helpList = help.stdout.slice(helpStart + 'Commands:'.length).split('\n\n', 1)[0];
  const helpCommands = helpList.split(',').map(command => command.replace(/\s+/g, ' ').trim());
  for (const command of ['peer-result', 'watcher-arm', 'watcher-send', 'watcher-consume']) {
    assert.ok(helpCommands.includes(command), `public help omitted ${command}`);
  }
  const usageLine = unknown.stderr.split('\n').find(line => line.includes('usage:'));
  assert.ok(usageLine, 'unknown command did not print usage');
  const usage = usageLine.slice(usageLine.indexOf('usage:') + 'usage:'.length);
  const usageCommands = usage.split(',').map(command => command.replace(/\s+/g, ' ').trim());
  assert.deepEqual(usageCommands, helpCommands);
});

test('public CLI rejects unknown and repeated flags before opening a database', t => {
  const f = prepared(t);
  const untouched = path.join(path.dirname(f.db), 'unopened.sqlite');
  const marker = path.join(path.dirname(f.db), 'state-opened');
  const preload = path.join(path.dirname(f.db), 'track-state-open.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const state = require(${JSON.stringify(require.resolve('../src/state'))});
    const Original = state.SurfaceState;
    state.SurfaceState = class extends Original {
      constructor(...args) {
        fs.writeFileSync(${JSON.stringify(marker)}, 'opened');
        super(...args);
      }
    };
  `);
  const environment = { NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
    CODEX_THREAD_ID: NATIVE, CODEX_SESSION_ID: NATIVE };
  const valid = runCli(f, ['peer-result', '--provider', 'codex', '--db', f.db,
    '--correlation-id', f.request.id], environment);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).results[0].text, f.packet.text);
  assert.equal(fs.existsSync(marker), true, 'constructor marker is not active');
  for (const flags of [['--typo', 'value'], ['--provider', 'claude'], ['--native-id', NATIVE]]) {
    fs.rmSync(marker, { force: true });
    const result = runCli(f, ['peer-result', '--provider', 'codex', '--db', untouched,
      '--correlation-id', f.request.id, ...flags], environment);
    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(marker), false, 'invalid flags reached state open');
    assert.equal(fs.existsSync(untouched), false);
  }
});

test('public CLI refuses missing state without creating a directory or database', t => {
  const f = prepared(t);
  const untouched = path.join(path.dirname(f.db), 'missing-state');
  for (const input of [
    { provider: 'wrong', correlation: f.request.id, identity: NATIVE },
    { provider: 'codex', correlation: 'bad id!', identity: NATIVE },
    { provider: 'codex', correlation: f.request.id, identity: '' },
    { provider: 'codex', correlation: f.request.id, identity: NATIVE }
  ]) {
    const result = runCli(f, ['peer-result', '--provider', input.provider,
      '--state-dir', untouched, '--correlation-id', input.correlation],
      { CODEX_THREAD_ID: input.identity, CODEX_SESSION_ID: input.identity });
    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(untouched), false);
  }
});

test('public CLI refuses older state without migrating it', t => {
  const f = prepared(t);
  f.state.db.prepare("UPDATE meta SET value='1.7' WHERE key='schema'").run();
  f.state.close();
  const before = fs.readFileSync(f.db);
  const result = invoke(f);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(fs.readFileSync(f.db), before);
  const inspection = new DatabaseSync(f.db, { readOnly: true });
  try {
    assert.equal(inspection.prepare("SELECT value FROM meta WHERE key='schema'").get().value, '1.7');
  } finally {
    inspection.close();
  }
});

function commandHarness(f, extras = {}) {
  let opened;
  const printed = [];
  const command = createPeerResultCommand({
    required(args, key) {
      if (typeof args[key] !== 'string' || !args[key]) throw new Error('missing argument');
      return args[key];
    },
    openState(_args, options) { opened = new SurfaceState(f.db, options); return { state: opened }; },
    print(value) { printed.push(value); },
    ...extras
  });
  return { command, printed, opened: () => opened };
}

const args = { provider: 'codex', 'correlation-id': 'cli-inspection' };
const dependencies = { callerDependencies: { environment: { CODEX_THREAD_ID: NATIVE, CODEX_SESSION_ID: NATIVE } } };

test('command closes its database after success and rejected input', async t => {
  const f = prepared(t);
  for (const input of [args, { ...args, 'correlation-id': 'unknown' }, { ...args, provider: 'wrong' }]) {
    const h = commandHarness(f);
    if (input === args) assert.equal((await h.command(input, dependencies)).results[0].text, f.packet.text);
    else await assert.rejects(h.command(input, dependencies));
    assert.throws(() => h.opened().getConfig());
  }
});

test('command reuses the Claude caller resolver', async t => {
  const f = prepared(t, 'claude');
  const h = commandHarness(f, { resolveCurrentClaudeCaller: async () => ({ harness: 'claude-code', sessionId: NATIVE }) });
  assert.equal((await h.command({ ...args, provider: 'claude' })).results[0].text, f.packet.text);
  assert.throws(() => h.opened().getConfig());
});

test('command refuses a caller generation change before printing and closes state', async t => {
  const f = prepared(t);
  const h = commandHarness(f);
  let calls = 0;
  await assert.rejects(h.command(args, { callerDependencies: {
    async resolveCodexCaller() {
      if (++calls === 2) f.state.db.prepare("UPDATE bindings SET generation=generation+1 WHERE channel_id='101'").run();
      return { sessionId: NATIVE, threadId: NATIVE, turnId: 'fixture-turn' };
    }
  } }), /caller changed/);
  assert.equal(h.printed.length, 0);
  assert.throws(() => h.opened().getConfig());
});

test('output failure still closes the database', async t => {
  const f = prepared(t);
  const failure = new Error('output closed');
  const h = commandHarness(f, { print() { throw failure; } });
  await assert.rejects(h.command(args, dependencies), error => error === failure);
  assert.throws(() => h.opened().getConfig());
});

test('network trap covers shared transport boundaries and control probes', t => {
  const f = prepared(t);
  const trap = createNetworkTrap(f);
  const argv = ['peer-result', '--provider', 'codex', '--db', f.db,
    '--correlation-id', f.request.id];
  const nodeOptions = `--require=${JSON.stringify(trap.preload)}`;
  const environment = {
    CODEX_THREAD_ID: NATIVE,
    CODEX_SESSION_ID: NATIVE,
    NODE_OPTIONS: nodeOptions
  };
  const controls = [];
  const run = probe => runCli(f, argv, {
    ...environment,
    ...(probe ? { PEER_RESULT_TEST_NETWORK_PROBE: probe } : {})
  });
  const record = (probe, result) => {
    const marker = fs.existsSync(trap.marker) ? fs.readFileSync(trap.marker, 'utf8') : null;
    controls.push({ probe, status: result.status, signal: result.signal, marker });
    return marker;
  };

  try {
    const publicRead = run();
    assert.equal(record('public-read', publicRead), null);
    assert.equal(publicRead.status, 0, publicRead.stderr);
    const publicResult = JSON.parse(publicRead.stdout);
    assert.equal(publicResult.sendOutcome, 'sent');
    assert.equal(publicResult.results[0].state, 'accepted');
    assert.equal(publicResult.results[0].nativeAcknowledged, false);
    assert.equal(publicResult.results[0].completed, false);

    const probes = [
      'fetch', 'http.get', 'socket.connect', 'socket.prototype.connect',
      'dns.lookup', 'dns.promises.lookup', 'http2.connect', 'dns.resolver',
      'dns.promises.resolver', 'dns.resolveCaa', 'dns.resolve4',
      'dns.setServers', 'dns.promises.setServers', 'datagram.send', 'tcp.raw',
      'child_process.spawn', 'child_process.spawnSync', 'socket.connect6',
      'dns.reverse', 'dns.lookupService', 'worker.env.empty',
      'worker.constructor.chain', 'worker.prototype.constructor',
      ...(typeof process.execve === 'function' ? ['process.execve.empty'] : [])
    ];
    for (const probe of probes) {
      fs.rmSync(trap.marker, { force: true });
      const result = run(probe);
      const marker = record(probe, result);
      if (probe === 'worker.constructor.chain') {
        assert.equal(marker, null, `${probe} attempted network access`);
        assert.equal(result.status, 0, result.stderr);
        const readResult = JSON.parse(result.stdout);
        assert.equal(readResult.sendOutcome, 'sent');
        assert.equal(readResult.results[0].state, 'accepted');
        assert.equal(readResult.results[0].nativeAcknowledged, false);
        assert.equal(readResult.results[0].completed, false);
        continue;
      }
      assert.ok(marker, `${probe} bypassed the network trap; status=${result.status}\n${result.stderr}`);
      if (probe === 'process.execve.empty') assert.equal(result.status, 1, result.stderr);
    }
  } finally {
    process.stdout.write(`PEER_RESULT_NETWORK_CONTROL_LOG ${JSON.stringify(controls)}\n`);
  }
});
