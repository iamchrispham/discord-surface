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
    const udpPrototype = process.binding('udp_wrap').UDP.prototype;
    for (const methodName of Object.getOwnPropertyNames(udpPrototype)) {
      if (/^(bind|connect|send)/.test(methodName) && typeof udpPrototype[methodName] === 'function') {
        udpPrototype[methodName] = blocked('udp_wrap.UDP.' + methodName);
      }
    }
    const channelPrototype = process.binding('cares_wrap').ChannelWrap.prototype;
    for (const methodName of Object.getOwnPropertyNames(channelPrototype)) {
      if (methodName.startsWith('query') && typeof channelPrototype[methodName] === 'function') {
        channelPrototype[methodName] = blocked('cares_wrap.ChannelWrap.' + methodName);
      }
    }

    const dns = require('node:dns');
    dns.lookup = blocked('node:dns.lookup');
    dns.promises.lookup = blocked('node:dns.promises.lookup');

    const processWrap = process.binding('process_wrap');
    const addNetworkTrap = options => {
      const childOptions = options || {};
      const envPairs = Array.isArray(childOptions.envPairs) ? childOptions.envPairs : [];
      const existing = envPairs.find(pair => pair.startsWith('NODE_OPTIONS='));
      const existingOptions = existing ? existing.slice('NODE_OPTIONS='.length) : '';
      const nextOptions = existingOptions.includes(preload)
        ? existingOptions
        : [existingOptions, '--require=' + JSON.stringify(preload)].filter(Boolean).join(' ');
      return { ...childOptions,
        envPairs: [...envPairs.filter(pair => !pair.startsWith('NODE_OPTIONS=')), 'NODE_OPTIONS=' + nextOptions] };
    };
    const processSpawn = processWrap.Process.prototype.spawn;
    processWrap.Process.prototype.spawn = function(options) {
      return processSpawn.call(this, addNetworkTrap(options));
    };
    const spawnSyncBinding = process.binding('spawn_sync');
    const spawnSync = spawnSyncBinding.spawn;
    spawnSyncBinding.spawn = function(options) {
      return spawnSync.call(this, addNetworkTrap(options));
    };

    const runProbe = probe => {
      const net = require('node:net');
      const probeActions = {
        fetch: () => globalThis.fetch('http://127.0.0.1:8080/'),
        'http.get': () => require('node:http').get('http://127.0.0.1:9/'),
        'socket.connect': () => new net.Socket().connect(9, '127.0.0.1'),
        'socket.prototype.connect': () => {
          const socket = new net.Socket();
          Object.getPrototypeOf(socket).connect.call(socket, 9, '127.0.0.1');
        },
        'dns.lookup': () => dns.lookup('localhost', () => {}),
        'dns.promises.lookup': () => dns.promises.lookup('localhost'),
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
          ['-e', "require('node:net').connect(9, '127.0.0.1')"], { env: {} })
      };
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

    const probes = [
      'fetch', 'http.get', 'socket.connect', 'socket.prototype.connect',
      'dns.lookup', 'dns.promises.lookup', 'http2.connect', 'dns.resolver',
      'dns.promises.resolver', 'dns.resolveCaa', 'dns.resolve4',
      'dns.setServers', 'dns.promises.setServers', 'datagram.send', 'tcp.raw',
      'child_process.spawn', 'child_process.spawnSync'
    ];
    for (const probe of probes) {
      fs.rmSync(trap.marker, { force: true });
      const result = run(probe);
      const marker = record(probe, result);
      assert.ok(marker, `${probe} bypassed the network trap; status=${result.status}\n${result.stderr}`);
    }
  } finally {
    process.stdout.write(`PEER_RESULT_NETWORK_CONTROL_LOG ${JSON.stringify(controls)}\n`);
  }
});
