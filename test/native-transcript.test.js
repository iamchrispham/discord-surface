const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findCodexSessionFile, observeCodexReply, readInitialCursor } = require('../src/native');

const ID = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const MARKER = '[[discord-surface:bounded-read]]';
const BLOCK = 64 * 1024;
const MIB = 1024 * 1024;
const META = `${JSON.stringify({ type: 'session_meta', payload: { session_id: ID } })}\n`;

function fixture(t, size = 256) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-transcript-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, `${ID}.jsonl`);
  fs.writeFileSync(file, META);
  // Real JSONL history, generated in bounded chunks; never inspect real sessions.
  let remaining = size - Buffer.byteLength(META);
  const overhead = Buffer.byteLength('{"padding":""}\n');
  while (remaining > 0) {
    const length = Math.min(BLOCK, remaining);
    fs.appendFileSync(file, length < overhead ? '\n'.repeat(length) : `{"padding":"${'x'.repeat(length - overhead)}"}\n`);
    remaining -= length;
  }
  return { root, file };
}

function cursorAt(file, offset = fs.statSync(file).size) {
  return { file, offset, since: 1, tail: '', tailBytes: '' };
}

function finalRow(text, { marker = MARKER, timestamp = new Date(Date.now() + 60000).toISOString() } = {}) {
  return `${JSON.stringify({ type: 'response_item', timestamp,
    payload: { type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: `${marker}\n${text}` }] } })}\n`;
}

// Instrument the actual fs operations on this fixture, including the old
// readFileSync path (which may bypass the exported readSync implementation).
function probe(t, file, options = {}) {
  const real = Object.fromEntries(['openSync', 'closeSync', 'fstatSync', 'readSync', 'readFileSync'].map(key => [key, fs[key]]));
  const io = { options, live: new Set(), opens: 0, closes: 0, attempts: 0, reads: [], wholeReads: 0, wholeBytes: 0, injected: 0 };
  const fail = () => { io.injected += 1; throw Object.assign(new Error('injected transcript I/O failure'), { code: 'EIO' }); };
  t.mock.method(fs, 'openSync', (name, flags, ...args) => {
    const fd = real.openSync(name, flags, ...args);
    if (name === file && flags === 'r') { io.live.add(fd); io.opens += 1; }
    return fd;
  });
  t.mock.method(fs, 'closeSync', fd => {
    const result = real.closeSync(fd);
    if (io.live.delete(fd)) io.closes += 1;
    return result;
  });
  t.mock.method(fs, 'fstatSync', (fd, ...args) => {
    if (io.live.has(fd) && options.failStatOpen === io.opens) fail();
    return real.fstatSync(fd, ...args);
  });
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    if (!io.live.has(fd)) return real.readSync(fd, buffer, offset, length, position);
    io.attempts += 1;
    if (options.failRead === io.attempts) fail();
    if (options.zeroRead === io.attempts) { io.injected += 1; return 0; }
    const bytes = real.readSync(fd, buffer, offset, Math.min(length, options.shortRead || length), position);
    io.reads.push({ position, requested: length, bytes });
    options.afterRead?.(io);
    return bytes;
  });
  t.mock.method(fs, 'readFileSync', (name, ...args) => {
    const output = real.readFileSync(name, ...args);
    if (name === file || io.live.has(name)) { io.wholeReads += 1; io.wholeBytes += Buffer.byteLength(output); }
    return output;
  });
  io.bytes = () => io.reads.reduce((sum, read) => sum + read.bytes, 0);
  io.closed = () => { assert.equal(io.live.size, 0); assert.equal(io.closes, io.opens); };
  t.after(() => { for (const fd of io.live) real.closeSync(fd); });
  return io;
}

async function observe(file, cursor, options = {}) {
  return observeCodexReply(ID, cursor, { marker: MARKER, root: path.dirname(file), timeoutMs: 2000, pollMs: 1, ...options });
}

async function polls(file, cursor, count = 1) {
  const controller = new AbortController();
  let seen = 0;
  const result = await observe(file, cursor, { signal: controller.signal,
    onCursor: () => { if (++seen === count) controller.abort(); } });
  assert.equal(seen, count);
  assert.equal(result.stopped, true);
  return result.cursor;
}

test('header lookup and initial EOF cursor read only boundary blocks', t => {
  const { file, root } = fixture(t, 32 * MIB);
  const io = probe(t, file);
  assert.equal(findCodexSessionFile(ID, root), file);
  assert.ok(io.bytes() <= BLOCK);
  const before = io.bytes();
  const cursor = readInitialCursor(ID, root);
  assert.equal(cursor.offset, 32 * MIB);
  assert.equal(cursor.tailBytes, '');
  assert.equal(cursor.tail, '');
  assert.ok(io.bytes() - before <= 2 * BLOCK);
  assert.equal(io.wholeReads, 0);
  io.closed();
});

test('three unchanged EOF observations read zero transcript bytes', async t => {
  const { file } = fixture(t, 32 * MIB);
  const cursor = cursorAt(file);
  const io = probe(t, file);
  assert.deepEqual(await polls(file, cursor, 3), cursor);
  assert.equal(io.wholeBytes, 0); // The old implementation rereads 96 MiB here.
  assert.equal(io.bytes(), 0);
  assert.equal(io.opens, 3);
  io.closed();
});

test('appends cost only new bytes regardless of historical prefix size', async t => {
  const text = `reply ${'x'.repeat(2 * BLOCK)} 🙂`;
  const suffix = Buffer.from(finalRow(text) + '{"unfinished":');
  const totals = [];
  for (const size of [4 * MIB, 32 * MIB]) {
    await t.test(`${size / MIB} MiB prefix`, async t => {
      const { file } = fixture(t, size);
      const cursor = cursorAt(file);
      fs.appendFileSync(file, suffix);
      const io = probe(t, file);
      const result = await observe(file, cursor);
      assert.equal(result.text, text);
      assert.equal(result.cursor.offset, size + suffix.length);
      assert.equal(result.cursor.tail, '{"unfinished":');
      assert.equal(result.cursor.tailBytes, Buffer.from('{"unfinished":').toString('base64'));
      assert.equal(io.wholeReads, 0);
      assert.equal(io.bytes(), suffix.length);
      assert.ok(io.reads.every(read => read.position >= size && read.requested <= BLOCK));
      totals.push(io.bytes());
      io.closed();
    });
  }
  assert.equal(totals[0], totals[1]);
});

test('UTF-8 split across blocks and serialized cursor restart is byte-exact', async t => {
  const { file } = fixture(t);
  const cursor = cursorAt(file);
  const emoji = Buffer.from('🙂');
  const prefix = Buffer.from(finalRow('🙂')).indexOf(emoji);
  const text = `${'x'.repeat(BLOCK - prefix - 1)}🙂${'y'.repeat(BLOCK + 7)}`;
  const row = Buffer.from(finalRow(text));
  const split = row.indexOf(emoji) + 2;
  assert.equal(split, BLOCK + 1); // Emoji also crosses a bounded read boundary.
  fs.appendFileSync(file, row.subarray(0, split));
  const io = probe(t, file, { shortRead: 127 });
  const saved = JSON.parse(JSON.stringify(await polls(file, cursor)));
  assert.deepEqual(Buffer.from(saved.tailBytes, 'base64'), row.subarray(0, split));
  assert.equal(saved.offset, cursor.offset + split);
  io.closed();
  saved.tail = 'lossy legacy text must not override tailBytes';
  fs.appendFileSync(file, row.subarray(split));
  const result = await observe(file, saved);
  assert.equal(result.text, text);
  assert.equal(result.cursor.offset, cursor.offset + row.length);
  assert.equal(result.cursor.tailBytes, '');
  assert.equal(io.bytes(), row.length);
  assert.equal(io.wholeReads, 0);
  io.closed();
});

test('legacy text-only cursor tails still resume a partial JSON record', async t => {
  const { file } = fixture(t);
  const cursor = cursorAt(file);
  const row = finalRow('legacy answer');
  const split = row.indexOf('legacy') + 3;
  fs.appendFileSync(file, row.slice(0, split));
  const saved = await polls(file, cursor);
  delete saved.tailBytes;
  fs.appendFileSync(file, row.slice(split));
  assert.equal((await observe(file, JSON.parse(JSON.stringify(saved)))).text, 'legacy answer');
});

test('initial cursor preserves a large partial tail including split UTF-8', async t => {
  const { file, root } = fixture(t, 4 * MIB);
  const row = Buffer.from(finalRow(`${'x'.repeat(2 * BLOCK)}🙂done`));
  const split = row.indexOf(Buffer.from('🙂')) + 2;
  fs.appendFileSync(file, row.subarray(0, split));
  const io = probe(t, file);
  const cursor = readInitialCursor(ID, root);
  assert.equal(cursor.offset, 4 * MIB + split);
  assert.deepEqual(Buffer.from(cursor.tailBytes, 'base64'), row.subarray(0, split));
  assert.ok(io.bytes() <= split + 2 * BLOCK);
  assert.equal(io.wholeReads, 0);
  io.closed();
  fs.appendFileSync(file, row.subarray(split));
  assert.equal((await observe(file, JSON.parse(JSON.stringify(cursor)))).text, `${'x'.repeat(2 * BLOCK)}🙂done`);
  io.closed();
});

test('a valid large header without LF is not silently capped', t => {
  const { file, root } = fixture(t);
  const header = JSON.stringify({ type: 'session_meta', payload: { id: ID }, padding: 'x'.repeat(2 * BLOCK) });
  fs.writeFileSync(file, header);
  const io = probe(t, file);
  assert.equal(findCodexSessionFile(ID, root), file);
  const cursor = readInitialCursor(ID, root);
  assert.equal(cursor.offset, Buffer.byteLength(header));
  assert.equal(cursor.tail, header);
  assert.equal(cursor.tailBytes, Buffer.from(header).toString('base64'));
  assert.ok(io.reads.every(read => read.requested <= BLOCK));
  assert.equal(io.wholeReads, 0);
  io.closed();
});

test('truncation resets offset, partial bytes and timestamp cutoff', async t => {
  const { file } = fixture(t, 4 * MIB);
  const cursor = { ...cursorAt(file), tail: 'stale partial', tailBytes: Buffer.from('stale partial').toString('base64') };
  const content = finalRow('old answer', { timestamp: '1970-01-01T00:00:01Z' }) + finalRow('new answer');
  fs.writeFileSync(file, content);
  const io = probe(t, file);
  const before = Date.now();
  const result = await observe(file, cursor);
  assert.equal(result.text, 'new answer');
  assert.equal(result.cursor.offset, Buffer.byteLength(content));
  assert.equal(result.cursor.tailBytes, '');
  assert.ok(result.cursor.since >= before && result.cursor.since <= Date.now());
  assert.equal(io.bytes(), Buffer.byteLength(content));
  assert.equal(io.wholeReads, 0);
  io.closed();
});

test('marker, phase and timestamp filtering remain exact', async t => {
  const { file } = fixture(t);
  const cursor = { ...cursorAt(file), since: Date.now() };
  fs.appendFileSync(file, 'not json\n\n' +
    finalRow('wrong marker', { marker: `${MARKER}-other` }) +
    finalRow('old', { timestamp: '1970-01-01T00:00:01Z' }) +
    finalRow('not first line', { marker: `preface\n${MARKER}` }) +
    finalRow('wrong phase').replace('final_answer', 'commentary') +
    `${JSON.stringify({ type: 'event_msg', timestamp: new Date(Date.now() + 60000).toISOString(),
      payload: { type: 'item_completed', item: { phase: 'final_answer', content: [{ type: 'Text', text: `${MARKER}\nright answer` }] } } })}\n`);
  assert.equal((await observe(file, cursor)).text, 'right answer');
});

test('header and tail descriptors close on read/stat failures', async t => {
  for (const [name, options, initial] of [
    ['header read', { failRead: 1 }, false],
    ['header stat', { failStatOpen: 1 }, false],
    ['tail read', { failRead: 2 }, true],
    ['tail stat', { failStatOpen: 2 }, true]
  ]) {
    await t.test(name, t => {
      const { file, root } = fixture(t);
      const io = probe(t, file, options);
      if (initial) {
        const cursor = readInitialCursor(ID, root);
        assert.equal(cursor.file, file);
        assert.equal(cursor.offset, 0);
        assert.equal(cursor.tailBytes, '');
      } else assert.equal(findCodexSessionFile(ID, root), null);
      assert.equal(io.injected, 1);
      io.closed();
    });
  }
});

test('observer failures close descriptors and do not advance past unread bytes', async t => {
  for (const [name, options] of [
    ['stat', { failStatOpen: 1 }], ['read after one block', { failRead: 2 }], ['shortened during read', { zeroRead: 2 }]
  ]) {
    await t.test(name, async t => {
      const { file } = fixture(t);
      const cursor = cursorAt(file);
      const text = 'x'.repeat(2 * BLOCK);
      fs.appendFileSync(file, finalRow(text));
      const io = probe(t, file, options);
      assert.deepEqual(await polls(file, cursor), cursor);
      assert.equal(io.injected, 1);
      io.closed();
      for (const key of Object.keys(options)) delete options[key];
      assert.equal((await observe(file, cursor)).text, text);
      io.closed();
    });
  }
});

test('abort and generation invalidation stop before reads and close mid-read descriptors', async t => {
  for (const midRead of [false, true]) for (const reason of ['abort', 'generation']) {
    await t.test(`${reason}, ${midRead ? 'during' : 'before'} read`, async t => {
      const { file } = fixture(t);
      const cursor = cursorAt(file);
      fs.appendFileSync(file, finalRow('x'.repeat(2 * BLOCK)));
      const controller = new AbortController();
      let current = true;
      const stop = () => { if (reason === 'abort') controller.abort(); else current = false; };
      if (!midRead) stop();
      const io = probe(t, file, { afterRead: midRead ? stop : null });
      const result = await observe(file, cursor, { signal: controller.signal, isCurrent: () => current });
      assert.equal(result.stopped, true);
      assert.equal(result.text, undefined);
      assert.deepEqual(result.cursor, cursor);
      assert.equal(io.bytes(), midRead ? BLOCK : 0);
      assert.equal(io.wholeReads, 0);
      io.closed();
    });
  }
});


test('missing cursor file retains cutoff while reading a replacement transcript', async t => {
  const { root, file } = fixture(t);
  const since = Date.now() - 10000;
  const cursor = { file: path.join(root, 'missing.jsonl'), offset: 500, since, tail: '' };
  fs.appendFileSync(file, finalRow('too old', { timestamp: new Date(since - 1000).toISOString() }));
  fs.appendFileSync(file, finalRow('recovered', { timestamp: new Date(since + 1000).toISOString() }));
  const result = await observe(file, cursor, { timeoutMs: 100 });
  assert.equal(result.text, 'recovered');
  assert.equal(result.cursor.since, since);
});
