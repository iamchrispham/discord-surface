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
const { main, parseArgs } = require('../src/cli');

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
