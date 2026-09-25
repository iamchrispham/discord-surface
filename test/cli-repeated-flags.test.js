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
const { main, parseArgs } = require('../src/cli');
const { allowedFlags } = require('../src/cli/flag-policy');

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

test('claude-post suggests the exact nearest same-command flag for --attachment', () => {
  assert.throws(() => parseArgs(['claude-post', '--attachment', 'x']), error => {
    assert.equal(error.command, 'claude-post');
    assert.equal(error.message, 'unknown --attachment for claude-post; did you mean --attachment-file?');
    return true;
  });
});

test('courier-guard rejects an unknown flag with the deny hook JSON before state exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-unknown-flag-'));
  try {
    const result = spawnSync(process.execPath, [CLI, 'courier-guard', '--state-dir', dir,
      '--courier-route-id', 'guard-route', '--surprise', 'y'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /unknown --surprise for courier-guard/);
    assert.equal(fs.existsSync(path.join(dir, 'surface.sqlite')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
  }
});
