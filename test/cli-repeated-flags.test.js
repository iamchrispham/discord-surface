const {
  assert,
  fs,
  path,
  spawnSync,
  test,
  MESSAGE_STATES,
  fixture,
  submitted
} = require('./native-reply-file-fixture');
const os = require('node:os');
const Module = require('node:module');
const { main, parseArgs } = require('../src/cli');
const { runDirectPost } = require('../src/direct-post');
const { allowedFlags, COMMON_FLAGS } = require('../src/cli/flag-policy');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const REPEATED = /--attachment-file was given more than once/;

function frames(dir) {
  return ['A', 'B', 'C', 'D'].map(name => {
    const file = path.join(dir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(`frame ${name}`));
    return file;
  });
}

test('parseArgs keeps single flags and refuses any repeated flag by name', () => {
  assert.deepEqual(parseArgs(['claude-post', '--text-file', 'a.txt', '--attachment-file=x=y.png', '--resume']), {
    command: 'claude-post',
    subcommand: undefined,
    args: { 'text-file': 'a.txt', 'attachment-file': 'x=y.png', resume: true }
  });
  assert.throws(() => parseArgs(['post', '--attachment-file', 'a', '--attachment-file', 'b']), REPEATED);
  assert.throws(() => parseArgs(['post', '--attachment-file=a', '--attachment-file', 'b']), REPEATED);
  assert.throws(() => parseArgs(['post', '--resume', '--resume']), /--resume was given more than once/);
  assert.throws(() => parseArgs(['start', '--state-dir', 'a', '--db', 'b', '--state-dir', 'c']), /--state-dir was given more than once/);
});

test('claude-post refuses several attachment files before custody or network', async t => {
  const f = fixture(t, 'claude');
  const caption = path.join(f.dir, 'caption.txt');
  fs.writeFileSync(caption, 'four frames');
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalArgv = process.argv;
  globalThis.fetch = async () => {
    calls.push(true);
    return { ok: true, status: 200, body: { cancel() {} }, json: async () => ({ id: `file-${calls.length}` }) };
  };
  process.argv = ['node', 'src/cli.js', 'claude-post', '--state-dir', f.dir, '--native-id', f.nativeId, '--generation', '1',
    '--text-file', caption, '--dedupe-key', 'four-frames', ...frames(f.dir).flatMap(file => ['--attachment-file', file])];
  try {
    await assert.rejects(main(), REPEATED);
  } finally {
    globalThis.fetch = originalFetch;
    process.argv = originalArgv;
  }
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(f.dir, '.direct-post-files')), false);
});

test('claude-reply refuses several attachment files before recording the reply', t => {
  const f = fixture(t, 'claude');
  const id = 'repeated-attachment-reply';
  const caption = path.join(f.dir, 'caption.txt');
  fs.writeFileSync(caption, 'four frames');
  submitted(f, id);
  const result = spawnSync(process.execPath, [CLI, 'claude-reply', '--state-dir', f.dir, '--message-id', id,
    '--native-id', f.nativeId, '--generation', '1', '--text-file', caption,
    ...frames(f.dir).flatMap(file => ['--attachment-file', file])], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, REPEATED);
  assert.equal(f.state.nativeReplyFilePreparation(id), null);
  assert.equal(f.state.getMessage(id).state, MESSAGE_STATES.SUBMITTED);
});

test('claude-post rejects a flag that is valid for other commands', () => {
  assert.throws(() => parseArgs(['claude-post', '--message-id', 'x']), error => {
    assert.equal(error.command, 'claude-post');
    assert.equal(error.message, 'unknown --message-id for claude-post');
    return true;
  });
});

test('claude-post rejects an unrecognized flag without inventing a suggestion', () => {
  assert.throws(() => parseArgs(['claude-post', '--frobnicate', 'x']), error => {
    assert.equal(error.command, 'claude-post');
    assert.match(error.message, /^unknown --frobnicate for claude-post$/);
    assert.doesNotMatch(error.message, /did you mean/);
    return true;
  });
});

test('help is read-only only when bare', () => {
  assert.doesNotThrow(() => parseArgs(['claude-post', '--help']));
  assert.throws(() => parseArgs(['claude-post', '--help=false']), /--help takes no value/);
});

test('prototype-named flags are rejected rather than lost while parsing', () => {
  for (const flag of ['--__proto__', '--__proto__=x']) {
    const argv = flag.includes('=') ? ['claude-post', flag] : ['claude-post', flag, 'x'];
    assert.throws(() => parseArgs(argv), /unknown --__proto__ for claude-post/);
  }
});

test('ordinary-bind refuses an ignored guild override before opening state', async t => {
  for (const command of ['ordinary-bind', 'ordinary-bind-run']) {
    assert.throws(() => parseArgs([command, '--guild-id', 'other']), new RegExp(`unknown --guild-id for ${command}`));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-ordinary-unknown-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oldArgv = process.argv;
  process.argv = ['node', CLI, 'ordinary-bind', '--state-dir', dir, '--guild-id', 'other'];
  try {
    await assert.rejects(main(), /unknown --guild-id for ordinary-bind/);
  } finally {
    process.argv = oldArgv;
  }
  assert.equal(fs.existsSync(path.join(dir, 'surface.sqlite')), false);
});

test('handoff modes refuse options consumed only by another mode', () => {
  const invalid = [
    [['handoff', '--ordinary'], '--endpoint'],
    [['handoff-run', '--ordinary'], '--category-id'],
    [['handoff', '--from-lock'], '--reuse'],
    [['handoff-run', '--from-lock'], '--session-root'],
    [['handoff'], '--session-root'],
    [['handoff-local'], '--repo'],
    [['handoff-local'], '--session-file']
  ];
  for (const [command, flag] of invalid) {
    assert.throws(() => parseArgs([...command, flag, 'wrong']), error => {
      assert.match(error.message, new RegExp(`unknown ${flag} for ${command[0]}`));
      return true;
    });
  }
  for (const command of [
    ['handoff', '--ordinary=false'],
    ['handoff', '--from-lock=false'],
    ['handoff-run', '--ordinary=false'],
    ['handoff-run', '--from-lock=false'],
    ['handoff', '--ordinary', '--session-root', '/tmp/root'],
    ['handoff', '--from-lock', '--session-file', '/tmp/session'],
    ['handoff', '--endpoint', '/tmp/socket'],
    ['handoff-local', '--intake-cutoff', '100']
  ]) assert.doesNotThrow(() => parseArgs(command));
});

test('recover refuses flags consumed only by another recovery mode', () => {
  const invalid = [
    [['--board-attempt-id', 'A'], ['--direct-post-request-id', 'R']],
    [['--topic-channel-id', 'C'], ['--board-resolution', 'applied']],
    [['--intake-channel-id', 'C'], ['--topic-readback', 'old']],
    [['--message-id', 'M', '--resolution', 'reply_sent'], ['--direct-post-request-id', 'R']],
    [['--direct-post-request-id', 'R'], ['--message-id', 'M']],
    [[], ['--part-index', '1']]
  ];
  for (const [mode, extra] of invalid) {
    assert.throws(() => parseArgs(['recover', ...mode, ...extra]), /unknown --.+ for recover/);
  }
  for (const mode of [
    ['--board-attempt-id', 'A'], ['--topic-channel-id', 'C'], ['--intake-channel-id', 'C'],
    ['--message-id', 'M', '--resolution', 'reply_sent', '--part-index', '1'],
    ['--direct-post-request-id', 'R', '--direct-post-attempt-id', 'A'],
    ['--message-id', 'M', '--resolution', 'submitted']
  ]) assert.doesNotThrow(() => parseArgs(['recover', ...mode]));
});

test('ordinary handoff rejects an ignored endpoint before creating state', t => {
  const dir = path.join(os.tmpdir(), `cli-handoff-unknown-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [CLI, 'handoff', '--state-dir', dir,
    '--ordinary', '--endpoint', '/tmp/wrong'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /unknown --endpoint for handoff/);
  assert.equal(fs.existsSync(dir), false);
});

test('claude-reply rejects a provider override before opening state', t => {
  const dir = path.join(os.tmpdir(), `cli-reply-unknown-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [CLI, 'claude-reply', '--state-dir', dir,
    '--provider', 'codex'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /unknown --provider for claude-reply/);
  assert.equal(fs.existsSync(dir), false);
});

test('claude-post suggests the exact nearest same-command flag for --attachment', () => {
  assert.throws(() => parseArgs(['claude-post', '--attachment', 'x']), error => {
    assert.equal(error.command, 'claude-post');
    assert.equal(error.message, 'unknown --attachment for claude-post; did you mean --attachment-file?');
    return true;
  });
});

test('misspelled attachment refuses before claude-post touches state or network', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-post-unknown-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oldArgv = process.argv;
  const oldFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; throw new Error('network reached'); };
  process.argv = ['node', CLI, 'claude-post', '--state-dir', dir, '--attachment', 'frame.png'];
  try {
    await assert.rejects(main(), /unknown --attachment for claude-post; did you mean --attachment-file\?/);
  } finally {
    globalThis.fetch = oldFetch;
    process.argv = oldArgv;
  }
  assert.equal(fetches, 0);
  assert.equal(fs.existsSync(path.join(dir, 'surface.sqlite')), false);
});

test('valued help cannot bypass an unknown attachment on a configured post', async t => {
  const f = fixture(t, 'claude');
  const caption = path.join(f.dir, 'caption.txt');
  const image = path.join(f.dir, 'frame.png');
  fs.writeFileSync(caption, 'milestone');
  fs.writeFileSync(image, 'frame');
  const before = f.state.listReceipts();
  const oldArgv = process.argv;
  const oldFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return { ok: true, status: 200, body: { cancel() {} }, json: async () => ({ id: 'posted' }) };
  };
  try {
    for (const help of ['--help=', '--help=false']) {
      process.argv = ['node', CLI, 'claude-post', '--db', path.join(f.dir, 'surface.sqlite'),
        '--native-id', f.nativeId, '--generation', '1', '--text-file', caption, '--dedupe-key', 'valued-help',
        '--attachment', image, help];
      await assert.rejects(main(), /unknown --attachment for claude-post; did you mean --attachment-file\?/);
    }
  } finally {
    globalThis.fetch = oldFetch;
    process.argv = oldArgv;
  }
  assert.equal(fetches, 0);
  assert.deepEqual(f.state.listReceipts(), before);
});

test('explicit false resume cannot send an admitted snapshot', async t => {
  const f = fixture(t);
  const caption = path.join(f.dir, 'caption.txt');
  const attachment = path.join(f.dir, 'source.bin');
  fs.writeFileSync(caption, 'held caption');
  fs.writeFileSync(attachment, 'held file');
  const stopped = new AbortController();
  stopped.abort();
  await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    textFile: caption, attachmentFile: attachment, dedupeKey: 'false-resume', signal: stopped.signal,
    fetchImpl: async () => { throw new Error('network reached'); } });
  const before = f.state.listReceipts();
  const oldArgv = process.argv;
  const oldFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; throw new Error('network reached'); };
  process.argv = ['node', CLI, 'post', '--state-dir', f.dir, '--native-id', f.nativeId,
    '--generation', '1', '--dedupe-key', 'false-resume', '--resume=false'];
  try { await assert.rejects(main(), /text-file must be a non-empty string/); }
  finally { process.argv = oldArgv; globalThis.fetch = oldFetch; }
  assert.equal(fetches, 0);
  assert.deepEqual(f.state.listReceipts(), before);
});

test('courier-guard rejects an unknown flag with the deny hook JSON before state exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-unknown-flag-'));
  try {
    for (const help of [[], ['--help='], ['--help=false']]) {
      const result = spawnSync(process.execPath, [CLI, 'courier-guard', '--state-dir', dir,
        '--courier-route-id', 'guard-route', '--surprise', 'y', ...help], { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 2, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /unknown --surprise for courier-guard/);
    }
    assert.equal(fs.existsSync(path.join(dir, 'surface.sqlite')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('degraded courier-guard fallback matches its allowed flags and denies extras', () => {
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === './cli/flag-policy' && parent?.filename === CLI) {
      const error = new Error('flag policy missing');
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    return load.call(this, request, parent, isMain);
  };
  try {
    for (const key of [...COMMON_FLAGS, ...allowedFlags('courier-guard')].filter(key => key !== 'help')) {
      assert.doesNotThrow(() => parseArgs(['courier-guard', `--${key}`, 'x']), `fallback rejected --${key}`);
    }
    assert.doesNotThrow(() => parseArgs(['courier-guard', '--help']));
    for (const value of ['', 'true', 'false']) {
      assert.throws(() => parseArgs(['courier-guard', `--help=${value}`]), /--help takes no value/);
    }
    assert.throws(() => parseArgs(['courier-guard', '--message-id', 'x']), /unknown --message-id for courier-guard/);
    assert.throws(() => parseArgs(['courier-guard', '--message-id', 'x', '--help=false']), /unknown --message-id for courier-guard/);
    assert.throws(() => parseArgs(['courier-guard', '--__proto__', 'x']), /unknown --__proto__ for courier-guard/);
  } finally {
    Module._load = load;
  }
});

test('every main dispatch case has a flag policy entry', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
  const mainBody = source.slice(source.indexOf('async function main()'));
  const cases = [...mainBody.matchAll(/case\s+['"]([^'"]+)['"]\s*:/g)].map(match => match[1]);
  assert.ok(cases.length > 0);
  for (const command of cases) {
    assert.notEqual(allowedFlags(command), null, `no flag policy for main dispatch case ${command}`);
    assert.doesNotThrow(() => parseArgs([command]), `parseArgs(${command}) threw under the flag policy`);
    assert.throws(() => parseArgs([command, '--frobnicate', 'x']), new RegExp(`unknown --frobnicate for ${command}`));
  }
});

test('parseArgs rejects a single-dash token that looks like a long flag', () => {
  assert.throws(() => parseArgs(['claude-post', '--attachment-file', 'a.png', '-attachment-file', 'b.png']));
  assert.throws(() => parseArgs(['stop', '-h']));
});

test('parseArgs rejects a value-bearing boolean flag', () => {
  assert.throws(() => parseArgs(['claude-post', '--resume', '/tmp/a.png']));
  assert.throws(() => parseArgs(['claude-post', '--resume=TRUE']));
});
