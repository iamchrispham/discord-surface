const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const {
  decodeWatcherNotice,
  encodeWatcherNotice,
  watcherNoticeId
} = require('../src/watcher-notice');
const { SurfaceState, MESSAGE_STATES, READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { runWatcherNoticePost } = require('../src/direct-post');
const { ClaudeProvider, watcherNoticeCompletionCommand } = require('../src/native');
const { createMonitorMcp } = require('../src/claude-monitor');
const { createSurfaceConsumer } = require('../src/discord');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const {
  NATIVE_REPLY_FILE_JOURNAL,
  NATIVE_REPLY_FILE_PHASES,
  NATIVE_REPLY_FILE_PREPARATION
} = require('../src/state/native-reply-file');
const { GATEWAY_CAPABILITIES, watcherArm, watcherSend } = require('../src/cli');

const token = 'watcher-notice-fixture-token';
const owner = {
  guildId: '100',
  channelId: '101',
  provider: 'claude',
  nativeId: '22222222-2222-2222-2222-222222222222',
  generation: 1
};
const child = { ...owner, channelId: '102' };

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-notice-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: '900', guildId: owner.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...owner, workspace: dir, endpoint: path.join(dir, 'claude.sock'), conductorId: 'watcher-conductor', repoKey: 'repo:watcher' });
  let binding = state.getBinding(owner.channelId);
  binding = state.setBindingReadiness(owner.channelId, READINESS.READY, 'watcher fixture ready', binding);
  state.enrollThread({ threadId: child.channelId, parentChannelId: owner.channelId, guildId: owner.guildId }, binding);
  state.setThreadBaseline(child.channelId, '1000', binding);
  state.markThreadBoundary(child.channelId, THREAD_STATES.READY, 'watcher fixture adopted', null, null, binding);
  return { dir, db, state, binding, armKey: 'watcher-arm-fixture' };
}

function caller(nativeId = owner.nativeId) {
  return { harness: 'claude-code', sessionId: nativeId, threadId: nativeId };
}

function armFixture(state, armKey = 'watcher-arm-fixture', nativeId = owner.nativeId, generation = owner.generation) {
  return state.armWatcherNotice({
    armKey,
    parentChannelId: owner.channelId,
    childChannelId: child.channelId,
    provider: 'claude',
    nativeId,
    generation,
    caller: caller(nativeId)
  });
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function submittedWatcherMessage(f, messageId, triggerKey = 'file-custody-trigger') {
  const textFile = path.join(f.dir, `${messageId}.txt`);
  fs.writeFileSync(textFile, 'Watcher file custody test.');
  armFixture(f.state, f.armKey);
  let postedBody;
  await runWatcherNoticePost({
    state: f.state,
    token,
    armKey: f.armKey,
    triggerKey,
    textFile,
    fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return response(200, { id: child.channelId, guild_id: child.guildId });
      postedBody = JSON.parse(options.body);
      return response(200, { id: messageId });
    }
  });
  const accepted = f.state.acceptDiscordMessage({
    id: messageId, guildId: child.guildId, channelId: child.channelId, authorId: '901', isBot: true,
    attachments: [], content: postedBody.content
  }, { agentToken: token });
  assert.equal(accepted.accepted, true);
  assert.equal(f.state.claimDispatch(messageId).claimed, true);
  f.state.markSubmitted(messageId);
  recordNativeAcknowledgment(f.state, {
    provider: owner.provider, messageId, nativeId: owner.nativeId, generation: owner.generation
  });
  return { textFile, message: f.state.getMessage(messageId) };
}

test('watcher notice travels from arm through child custody, native Claude, Monitor, ACK, and idempotent consume', async () => {
  const f = fixture();
  const textFile = path.join(f.dir, 'notice.txt');
  fs.writeFileSync(textFile, 'PR 51 watcher result: review is complete.');
  const requests = [];
  let postedBody;
  try {
    const armed = armFixture(f.state, f.armKey);
    assert.equal(armed.armed, true);
    assert.equal(armed.arm.authority, 'notice-only');
    assert.deepEqual(armed.arm.target, child);

    const sent = await runWatcherNoticePost({
      state: f.state,
      token,
      armKey: f.armKey,
      triggerKey: 'verdict-watch-51-abc',
      textFile,
      fetchImpl: async (url, options) => {
        requests.push({ url, method: options.method });
        if (options.method === 'GET') return response(200, { id: child.channelId, guild_id: child.guildId });
        postedBody = JSON.parse(options.body);
        return response(200, { id: '2001' });
      }
    });
    assert.equal(sent.status, 'sent');
    assert.equal(sent.requestId, watcherNoticeId(f.armKey, 'verdict-watch-51-abc'));
    assert.deepEqual(requests.map(request => request.method), ['GET', 'POST']);
    const packet = decodeWatcherNotice(postedBody.content, token, child);
    assert.equal(packet.text, 'PR 51 watcher result: review is complete.');
    assert.equal(packet.source.channelId, owner.channelId);
    assert.equal(packet.target.channelId, child.channelId);

    const accepted = f.state.acceptDiscordMessage({
      id: '2001', guildId: child.guildId, channelId: child.channelId, authorId: '901', isBot: true,
      attachments: [], content: postedBody.content
    }, { agentToken: token });
    assert.equal(accepted.accepted, true);
    const hydrated = f.state.getMessage('2001');
    assert.deepEqual(hydrated.watcherNotice, packet);
    assert.equal(hydrated.watcherNoticeProvenance.authorId, '901');
    assert.equal(f.state.currentMessageBinding(hydrated).current, true);

    let nativeEvent;
    const provider = new ClaudeProvider({
      post: async (_endpoint, body) => {
        nativeEvent = body;
        return { statusCode: 202, body: '', wrote: true };
      },
      waitForReply: async () => ({ stopped: true })
    });
    const consumer = createSurfaceConsumer({
      state: f.state,
      providers: { claude: provider },
      agentCredential: () => token,
      sendTransportReceipt: async () => ({ id: 'transport-receipt-2001' })
    });
    const dispatched = await consumer.handleStoredMessage(hydrated, null, { continueUntilFinal: false });
    assert.equal(dispatched.message.state, MESSAGE_STATES.SUBMITTED);
    assert.equal(nativeEvent.messageId, '2001');
    assert.equal(nativeEvent.watcherNotice.id, packet.id);
    assert.match(nativeEvent.content, /Do not use the reply tool/);
    assert.match(nativeEvent.content, /watcher notice/);

    const stdout = new EventEmitter();
    const pointers = [];
    stdout.write = (chunk, callback) => {
      pointers.push(JSON.parse(String(chunk)));
      callback?.();
      return true;
    };
    const monitor = createMonitorMcp({ state: f.state, stateDir: f.dir, dbPath: f.db, stdout });
    try {
      await monitor.notification({
        method: 'notifications/claude/channel',
        params: {
          content: 'forged monitor content',
          meta: { messageId: '2001', nativeId: owner.nativeId, generation: String(owner.generation) }
        }
      });
      assert.equal(pointers.length, 1);
      const payload = JSON.parse(fs.readFileSync(pointers[0].payloadPath, 'utf8'));
      assert.deepEqual(payload.watcherNotice, {
        id: packet.id, armKey: packet.armKey, triggerKey: packet.triggerKey,
        source: packet.source, target: packet.target
      });
      assert.match(payload.content, /PR 51 watcher result/);
      assert.doesNotMatch(payload.content, /forged monitor content/);
      assert.match(payload.instructions, /do not use reply\.command/);
      assert.equal(payload.reply, undefined);
      assert.equal(payload.completion.command[2], 'watcher-consume');
      assert.equal(payload.completion.command[payload.completion.command.indexOf('--message-id') + 1], '2001');
    } finally {
      await monitor.close();
    }

    assert.throws(() => f.state.consumeWatcherNotice({
      messageId: '2001', provider: 'claude', nativeId: owner.nativeId, generation: owner.generation,
      channelId: child.channelId
    }), /native acknowledgment/);
    recordNativeAcknowledgment(f.state, {
      provider: 'claude', messageId: '2001', nativeId: owner.nativeId, generation: owner.generation
    });
    const consumed = f.state.consumeWatcherNotice({
      messageId: '2001', provider: 'claude', nativeId: owner.nativeId, generation: owner.generation,
      channelId: child.channelId
    });
    assert.equal(consumed.consumed, true);
    assert.equal(consumed.message.state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
    const duplicate = f.state.consumeWatcherNotice({
      messageId: '2001', provider: 'claude', nativeId: owner.nativeId, generation: owner.generation,
      channelId: child.channelId
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(f.state.listReceipts().filter(row => row.kind === 'watcher-notice-consumed').length, 1);
  } finally {
    f.state.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('watcher consume shares native file preparation custody with agent completion', async t => {
  const scenarios = [
    {
      name: 'preparing',
      prepare: ({ f, message, textFile }) => {
        const spool = path.join(f.dir, '.direct-post-files');
        fs.writeFileSync(spool, 'occupied by a bounded fixture');
        assert.throws(() => f.state.prepareNativeReplyFile({
          provider: owner.provider, messageId: message.id, nativeId: owner.nativeId, generation: owner.generation,
          stateDir: f.dir, sourcePath: textFile, caption: 'preparing file'
        }), /not admitted/);
        assert.equal(f.state.nativeReplyFilePreparation(message.id).phase, NATIVE_REPLY_FILE_PHASES.PREPARING);
      },
      expected: /native reply file custody/
    },
    {
      name: 'admitted',
      prepare: ({ f, message, textFile }) => {
        const manifest = f.state.prepareNativeReplyFile({
          provider: owner.provider, messageId: message.id, nativeId: owner.nativeId, generation: owner.generation,
          stateDir: f.dir, sourcePath: textFile, caption: 'admitted file'
        });
        assert.equal(manifest.phase, NATIVE_REPLY_FILE_PHASES.ADMITTED);
        assert.equal(f.state.nativeReplyFilePreparation(message.id).phase, NATIVE_REPLY_FILE_PHASES.ADMITTED);
      },
      expected: /native reply file custody/
    },
    {
      name: 'released',
      prepare: ({ f, message }) => {
        f.state.receipt(message.id, NATIVE_REPLY_FILE_PREPARATION, {
          journal: NATIVE_REPLY_FILE_JOURNAL,
          phase: NATIVE_REPLY_FILE_PHASES.RELEASED,
          preparationId: '77777777-7777-4777-8777-777777777777'
        });
        assert.equal(f.state.nativeReplyFilePreparation(message.id).phase, NATIVE_REPLY_FILE_PHASES.RELEASED);
      },
      expected: null
    },
    {
      name: 'empty',
      prepare: ({ f, message }) => assert.equal(f.state.nativeReplyFilePreparation(message.id), null),
      expected: null
    }
  ];

  for (const [index, scenario] of scenarios.entries()) {
    await t.test(scenario.name, async t2 => {
      const f = fixture();
      try {
        const { textFile, message } = await submittedWatcherMessage(f, `210${index}`, `file-custody-${scenario.name}`);
        scenario.prepare({ f, message, textFile });
        if (scenario.expected) {
          assert.throws(() => f.state.consumeWatcherNotice({
            messageId: message.id, provider: owner.provider, nativeId: owner.nativeId, generation: owner.generation,
            channelId: child.channelId
          }), scenario.expected);
        } else {
          const consumed = f.state.consumeWatcherNotice({
            messageId: message.id, provider: owner.provider, nativeId: owner.nativeId, generation: owner.generation,
            channelId: child.channelId
          });
          assert.equal(consumed.consumed, true);
          assert.equal(consumed.message.state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
        }
      } finally {
        f.state.close();
        fs.rmSync(f.dir, { recursive: true, force: true });
      }
    });
  }
});

test('watcher arm and trigger custody survive restart and refuse changed content', async () => {
  const f = fixture();
  const textFile = path.join(f.dir, 'notice.txt');
  fs.writeFileSync(textFile, 'Stable watcher notice.');
  let state = f.state;
  let posts = 0;
  const fetchImpl = async (_url, options) => {
    if (options.method === 'POST') posts += 1;
    return options.method === 'GET'
      ? response(200, { id: child.channelId, guild_id: child.guildId })
      : response(500, { message: 'fixture unknown after publication attempt' });
  };
  try {
    armFixture(state, f.armKey);
    const first = await runWatcherNoticePost({ state, token, armKey: f.armKey, triggerKey: 'stable-trigger', textFile, fetchImpl });
    assert.equal(first.status, 'unknown');
    assert.equal(posts, 1);
    const armBeforeRestart = state.getWatcherNoticeArm(f.armKey);
    state.close();
    state = new SurfaceState(f.db);
    assert.deepEqual(state.getWatcherNoticeArm(f.armKey), armBeforeRestart);

    const marker = path.join(f.dir, 'changed-pid-post.marker');
    const childResult = path.join(f.dir, 'changed-pid-result.json');
    const childProcess = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs');
      const { SurfaceState } = require('./src/state');
      const { runWatcherNoticePost } = require('./src/direct-post');
      const [db, textFile, marker, resultFile, token, childChannelId, childGuildId] = process.argv.slice(1);
      const deadline = setTimeout(() => {
        fs.writeFileSync(resultFile, JSON.stringify({ error: 'child deadline exceeded' }));
        process.exit(124);
      }, 4500);
      deadline.unref();
      let state;
      (async () => {
        try {
          state = new SurfaceState(db);
          const result = await runWatcherNoticePost({
            state, token, armKey: 'watcher-arm-fixture', triggerKey: 'stable-trigger', textFile,
            fetchImpl: async (_url, options) => {
              if (options.method === 'POST') fs.writeFileSync(marker, 'posted');
              return options.method === 'GET'
                ? { ok: true, status: 200, json: async () => ({ id: childChannelId, guild_id: childGuildId }) }
                : { ok: false, status: 500, json: async () => ({ message: 'child must not publish again' }) };
            }
          });
          fs.writeFileSync(resultFile, JSON.stringify({ status: result.status, recorded: result.recorded }));
        } finally {
          state?.close();
          clearTimeout(deadline);
        }
      })().catch(error => {
        fs.writeFileSync(resultFile, JSON.stringify({ error: String(error) }));
        process.exitCode = 1;
      });
    `, f.db, textFile, marker, childResult, token, child.channelId, child.guildId], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 5000
    });
    assert.equal(childProcess.status, 0, childProcess.stderr);
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(childResult, 'utf8')), { status: 'unknown', recorded: false });

    const retry = await runWatcherNoticePost({ state, token, armKey: f.armKey, triggerKey: 'stable-trigger', textFile, fetchImpl });
    assert.equal(retry.status, 'unknown');
    assert.equal(retry.recorded, false);
    assert.equal(posts, 1);

    fs.writeFileSync(textFile, 'Changed after durable custody.');
    await assert.rejects(runWatcherNoticePost({ state, token, armKey: f.armKey, triggerKey: 'stable-trigger', textFile, fetchImpl }), /content changed|identity conflicts|frozen content/);
    assert.equal(posts, 1);

  } finally {
    state.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('watcher encoding refusal freezes trigger content across restart', async () => {
  const f = fixture();
  const textFile = path.join(f.dir, 'oversized.txt');
  const oversized = 'x'.repeat(2000);
  fs.writeFileSync(textFile, oversized);
  let state = f.state;
  let networkCalls = 0;
  const send = () => runWatcherNoticePost({
    state, token, armKey: f.armKey, triggerKey: 'oversized-trigger', textFile,
    fetchImpl: async () => { networkCalls += 1; throw new Error('unexpected network call'); }
  });
  try {
    armFixture(state, f.armKey);
    await assert.rejects(send(), /encoded size.*maximum 2000/);
    state.close();
    state = new SurfaceState(f.db);
    await assert.rejects(send(), /encoded size.*maximum 2000/);
    fs.writeFileSync(textFile, 'Shorter changed body.');
    await assert.rejects(send(), /trigger key conflicts with frozen content/);
    assert.equal(networkCalls, 0);
  } finally {
    state.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('watcher arm requires the current Claude caller and never trusts a different native identity', async () => {
  const f = fixture();
  const printed = [];
  try {
    await assert.rejects(watcherArm({
      'state-dir': f.dir, db: f.db, 'arm-key': f.armKey, provider: 'claude',
      'channel-id': owner.channelId, 'agent-thread-id': child.channelId,
      'native-id': owner.nativeId, generation: String(owner.generation)
    }, { resolveClaudeCaller: async () => caller('33333333-3333-3333-3333-333333333333'), print: value => printed.push(value) }), /current Claude caller identity/);
    assert.equal(printed.length, 0);
    const armed = await watcherArm({
      'state-dir': f.dir, db: f.db, 'arm-key': f.armKey, provider: 'claude',
      'channel-id': owner.channelId, 'agent-thread-id': child.channelId,
      'native-id': owner.nativeId, generation: String(owner.generation)
    }, { resolveClaudeCaller: async () => caller(), print: value => printed.push(value) });
    assert.equal(armed.armed, true);
    assert.equal(printed.length, 1);
    await assert.rejects(watcherSend({
      'state-dir': f.dir, db: f.db, 'arm-key': f.armKey,
      'trigger-key': 'blocked-on-old-gateway', 'text-file': path.join(f.dir, 'unused.txt')
    }, {
      gatewayProcessStatus: () => ({ state: 'running', pid: 7101, capabilities: [GATEWAY_CAPABILITIES.agentHandledWithoutPost] }),
      print: value => printed.push(value)
    }), /watcher notice ingress/);
  } finally {
    f.state.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('watcher codec binds stable identity and exact target', () => {
  const packet = {
    id: watcherNoticeId('arm', 'trigger'), kind: 'notice', armKey: 'arm', triggerKey: 'trigger',
    source: owner, target: child, text: 'notice body'
  };
  const encoded = encodeWatcherNotice(packet, token);
  assert.deepEqual(decodeWatcherNotice(encoded, token, child), packet);
  assert.throws(() => decodeWatcherNotice(encoded, token, { ...child, generation: 2 }), /stale|mismatched/);
  assert.throws(() => encodeWatcherNotice({ ...packet, id: 'different' }, token), /watcher notice identity is not stable/);
});
