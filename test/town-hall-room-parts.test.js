'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { planTownHallRoomParts, TOWN_HALL_ROOM_PARTS } = require('../dist/peer/town-hall-room-parts');
const { planTownHallBroadcast } = require('../dist/peer/town-hall-plan');

const ROOM_DOMAIN = 'discord-surface/town-hall-room-part/v1';
const ID_PREFIX = 'townhall_room_';
const CONTENT_LIMIT = 2000;
const INSTRUCTION = 'JSON segment, concatenate in index order:';
const OPEN_FENCE = '\n```json\n';
const CLOSE_FENCE = '\n```';

const OWNER_RELATIVE = 'src/peer/town-hall-room-parts.ts';
const TYPE_FIXTURE_RELATIVE = 'test/types/town-hall-room-parts-types.ts';
const TEST_RELATIVE = 'test/town-hall-room-parts.test.js';
const PROJECT_ROOT = path.join(__dirname, '..');

const SOURCE_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CODEX_UUID = '11111111-1111-4111-8111-aabbccddeeff';
const CLAUDE_UUID = '22222222-2222-4222-8222-222222222222';
const EXTRA_UUID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function address(overrides = {}) {
  return {
    guildId: '100',
    channelId: '300',
    provider: 'codex',
    nativeId: CODEX_UUID,
    generation: 1,
    ...overrides
  };
}

function input(overrides = {}) {
  return {
    broadcastId: 'b1',
    townHall: { guildId: '100', channelId: '900' },
    source: address({ channelId: '200', nativeId: SOURCE_UUID }),
    recipients: [address({ channelId: '300' })],
    text: 'hello',
    ...overrides
  };
}

function nativeIdFor(index) {
  const body = index.toString(16).padStart(8, '0');
  const tail = index.toString(16).padStart(12, '0');
  return `${body}-1111-4111-8111-${tail}`;
}

function roster(count) {
  const recipients = [];
  for (let index = 0; index < count; index += 1) {
    recipients.push(address({
      channelId: String(300 + (index % 50)),
      provider: index % 2 === 0 ? 'codex' : 'claude',
      nativeId: nativeIdFor(index),
      generation: 1 + (index % 3)
    }));
  }
  return recipients;
}

function sha256hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function expectedPartId(fingerprint, index, total, content) {
  return ID_PREFIX + sha256hex(JSON.stringify([ROOM_DOMAIN, fingerprint, index, total, content]));
}

function segmentOf(content) {
  assert.ok(content.startsWith('Town hall '), 'part content must start with the town hall header');
  assert.ok(content.endsWith(CLOSE_FENCE), 'part content must end with the closing fence');
  const start = content.indexOf(OPEN_FENCE);
  assert.notEqual(start, -1, 'part content must contain the opening fence');
  return content.slice(start + OPEN_FENCE.length, content.length - CLOSE_FENCE.length);
}

function segmentsOf(result) {
  return result.parts.map(part => segmentOf(part.content));
}

function rebuiltDocument(result) {
  return segmentsOf(result).join('');
}

function tokenBoundaries(text) {
  const bounds = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === '\\') {
      const length = text[index + 1] === 'u' ? 6 : 2;
      if (index + length > text.length) throw new Error('incomplete escape token at ' + index);
      index += length;
    } else {
      index += String.fromCodePoint(text.codePointAt(index)).length;
    }
    bounds.push(index);
  }
  return bounds;
}

function firstToken(text) {
  const bounds = tokenBoundaries(text);
  return bounds.length === 0 ? '' : text.slice(0, bounds[0]);
}

function lastToken(text) {
  const bounds = tokenBoundaries(text);
  if (bounds.length === 0) return '';
  const start = bounds.length >= 2 ? bounds[bounds.length - 2] : 0;
  return text.slice(start);
}

const HIGH_SURROGATE_ESCAPE = /^\\u[dD][89abAB][0-9a-fA-F]{2}$/;
const LOW_SURROGATE_ESCAPE = /^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/;

function assertNoLoneSurrogates(segment) {
  for (let index = 0; index < segment.length; index += 1) {
    const code = segment.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = segment.charCodeAt(index + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, 'lone high surrogate at ' + index);
      index += 1;
    } else {
      assert.ok(code < 0xdc00 || code > 0xdfff, 'lone low surrogate at ' + index);
    }
  }
}

function assertPartShape(plan, result) {
  assert.ok(Array.isArray(result.parts));
  assert.ok(result.parts.length > 0, 'room parts must contain at least one part');
  const total = result.parts.length;
  for (let offset = 0; offset < total; offset += 1) {
    const part = result.parts[offset];
    assert.equal(part.index, offset + 1, 'part index must be contiguous and one-based');
    assert.equal(part.total, total, 'part total must equal the parts length');
    assert.equal(typeof part.content, 'string');
    assert.ok(part.content.length <= CONTENT_LIMIT,
      'part ' + part.index + ' content is ' + part.content.length + ' UTF-16 units, over ' + CONTENT_LIMIT);
    const header = 'Town hall ' + plan.broadcastId + ' ' + part.index + '/' + part.total +
      '\nFingerprint ' + plan.fingerprint +
      '\n' + INSTRUCTION + '\n';
    assert.ok(part.content.startsWith(header + '```json\n'), 'part ' + part.index + ' must carry the exact header and opening fence');
    const segment = segmentOf(part.content);
    assert.equal(segment.includes('`'), false, 'payload segment must not contain a raw backtick');
    assert.ok(part.partId.startsWith(ID_PREFIX), 'part id must carry the room-parts prefix');
    assert.match(part.partId, /^townhall_room_[a-f0-9]{64}$/);
    assert.equal(part.partId, expectedPartId(plan.fingerprint, part.index, part.total, part.content),
      'part id must bind the plan fingerprint, index, total and content');
  }
}

function assertRoundTrip(plan, result) {
  const segments = segmentsOf(result);
  const rebuilt = segments.join('');
  assert.deepEqual(JSON.parse(rebuilt), plan, 'JSON.parse of the rebuilt document must equal the plan');
  tokenBoundaries(rebuilt);
  for (const segment of segments) assertNoLoneSurrogates(segment);
  for (let index = 1; index < segments.length; index += 1) {
    const left = segments[index - 1];
    const right = segments[index];
    const boundary = left.length;
    assert.ok(tokenBoundaries(left + right).includes(boundary),
      'a serialization token is split at segment boundary ' + index);
    if (HIGH_SURROGATE_ESCAPE.test(lastToken(left)) && LOW_SURROGATE_ESCAPE.test(firstToken(right))) {
      assert.fail('a surrogate pair of unicode escapes is split at segment boundary ' + index);
    }
  }
}

function plannedRoomParts(source) {
  const plan = planTownHallBroadcast(source);
  const result = planTownHallRoomParts(source);
  assert.deepEqual(result.plan, plan, 'room parts must expose the canonical planner plan');
  assert.equal(result.version, 1);
  return { plan, result };
}

function assertFrozenResult(plan, result) {
  assert.ok(Object.isFrozen(result), 'result must be frozen');
  assert.ok(Object.isFrozen(result.parts), 'parts array must be frozen');
  for (const part of result.parts) assert.ok(Object.isFrozen(part), 'each part must be frozen');
  assert.ok(Object.isFrozen(result.plan), 'result plan must be frozen');
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.townHall));
  assert.ok(Object.isFrozen(plan.source));
  assert.ok(Object.isFrozen(plan.recipients));
  for (const recipient of plan.recipients) {
    assert.ok(Object.isFrozen(recipient));
    assert.ok(Object.isFrozen(recipient.target));
  }
}

function thrownError(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

function assertSameRejection(makeInvalid) {
  const direct = thrownError(() => planTownHallBroadcast(makeInvalid()));
  const projection = thrownError(() => planTownHallRoomParts(makeInvalid()));
  assert.ok(direct, 'the canonical planner must reject the invalid input');
  assert.ok(projection, 'room parts must reject the invalid input');
  assert.equal(projection.message, direct.message, 'room parts must surface the canonical planner error');
  assert.equal(projection.constructor, direct.constructor);
  assert.equal(projection.name, direct.name);
}

function accessorAddress(base) {
  const result = {};
  for (const [key, value] of Object.entries(base)) {
    Object.defineProperty(result, key, {
      get() {
        accessorCalls += 1;
        return value;
      },
      enumerable: true,
      configurable: true
    });
  }
  return result;
}

let accessorCalls = 0;

function assertOwnerSourcePinned(sourceText) {
  const ts = require('typescript');
  const source = ts.createSourceFile(OWNER_RELATIVE, sourceText, ts.ScriptTarget.Latest, true);
  let calls = 0;
  function visit(node) {
    if (ts.isIdentifier(node) && node.text === 'arguments') {
      throw new Error('raw input read bypasses the canonical planner');
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'planTownHallBroadcast') {
      calls += 1;
      assert.equal(node.arguments.length, 1, 'the canonical planner must be called with one argument');
      assert.equal(node.arguments[0].getText(source), 'input', 'the canonical planner must receive the bare input identifier');
    }
    if (ts.isIdentifier(node) && node.text === 'input') {
      const parent = node.parent;
      const parameter = ts.isParameter(parent) && parent.name === node &&
        ts.isFunctionDeclaration(parent.parent) && parent.parent.name?.text === 'planTownHallRoomParts';
      const plannerArgument = ts.isCallExpression(parent) &&
        parent.expression.getText(source) === 'planTownHallBroadcast' &&
        parent.arguments.length === 1 && parent.arguments[0] === node;
      if (!parameter && !plannerArgument) {
        throw new Error('raw input read bypasses the canonical planner');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(calls, 1, 'the owner must call the canonical planner exactly once');
  assert.equal(
    /Object\.getOwnPropertyDescriptor|validAddress|MAX_TEXT_BYTES|invalid town-hall broadcast plan/.test(sourceText),
    false,
    'the owner must not carry planner validation constants or labels'
  );
}

function ownerSource() {
  return fs.readFileSync(path.join(PROJECT_ROOT, OWNER_RELATIVE), 'utf8');
}

test('room parts preserve the complete canonical plan', () => {
  const source = input({
    recipients: [
      address({ channelId: '300' }),
      address({ channelId: '301', provider: 'claude', nativeId: CLAUDE_UUID, generation: 2 })
    ]
  });
  const { plan, result } = plannedRoomParts(source);

  assertPartShape(plan, result);
  assertRoundTrip(plan, result);
  assertFrozenResult(plan, result);

  const parsed = JSON.parse(rebuiltDocument(result));
  assert.equal(parsed.broadcastId, 'b1');
  assert.deepEqual(parsed.townHall, { guildId: '100', channelId: '900' });
  assert.deepEqual(parsed.source, plan.source);
  assert.equal(parsed.text, 'hello');
  assert.equal(parsed.fingerprint, plan.fingerprint);
  assert.equal(parsed.recipients.length, 2);
  for (const recipient of plan.recipients) {
    const match = parsed.recipients.find(candidate => candidate.target.nativeId === recipient.target.nativeId);
    assert.ok(match, 'every recipient target must survive the round trip');
    assert.deepEqual(match, recipient);
    assert.equal(match.packetId, recipient.packetId);
  }
});

test('room parts preserve control text and literal escapes', () => {
  const text = 'controls:\u0000\u0001\u0007\u0008\u000b\u000c\u001f\u007f' +
    '\u200b\u2028\u2029' +
    ' literal-backslash-u: A\\u0041 emit \\n and \\t' +
    ' windows C:\\\\share\\\\name' +
    ' quote \\" double quote';
  const source = input({ text });
  const { plan, result } = plannedRoomParts(source);

  assert.equal(plan.text, text);
  assertPartShape(plan, result);
  assertRoundTrip(plan, result);

  const rebuilt = rebuiltDocument(result);
  const parsed = JSON.parse(rebuilt);
  assert.equal(parsed.text, text, 'escaped controls and literal backslashes must survive JSON.parse exactly');
  assert.equal(parsed.text.length, text.length);
  assert.equal(parsed.text.charCodeAt(parsed.text.indexOf('controls:') + 'controls:'.length), 0);
  assert.ok(rebuilt.includes('\\u0000'), 'NUL must be written as a JSON unicode escape');
  assert.ok(rebuilt.includes('\\u2028') && rebuilt.includes('\\u2029'), 'line and paragraph separators must be escaped');
  assert.ok(rebuilt.includes('\\u200b'), 'zero-width space must be escaped');
  assert.ok(rebuilt.includes('A\\\\u0041'), 'the literal backslash-u text must be double escaped, not decoded');
  assert.notEqual(parsed.text, 'controls:\u0000 literal-backslash-u: AA emit');
});

test('room parts preserve visible Unicode and surrogate boundaries', () => {
  const emoji = '\u{1F600}';
  const supplementaryCf = '\u{E0001}';
  const cjk = '\u6f22\u5b57\u304b\u306a\u7b80\u4f53';
  const text = 'emoji:' + emoji + '\u{1F389}\u{1F680} CJK:' + cjk +
    ' cf:' + supplementaryCf.repeat(400) +
    ' accents:\u00e9\u00e8\u4e2d' +
    ' raw:' + emoji.repeat(200) +
    ' tail';
  const source = input({ text });
  const { plan, result } = plannedRoomParts(source);

  assertPartShape(plan, result);
  assertRoundTrip(plan, result);

  const segments = segmentsOf(result);
  const rebuilt = segments.join('');
  for (const segment of segments) {
    assertNoLoneSurrogates(segment);
    assert.equal(segment.includes(supplementaryCf), false, 'supplementary Cf must be escaped');
  }
  assert.ok(rebuilt.includes(cjk), 'BMP letters must remain visible');
  assert.ok(rebuilt.includes('\u00e9'), 'Latin accent must remain visible');
  assert.ok(rebuilt.includes('\\udb40\\udc01'), 'supplementary Cf must round-trip as a kept-together surrogate escape pair');
  const parsed = JSON.parse(rebuilt);
  assert.equal(parsed.text, text, 'BMP and supplementary text must survive exactly');
  assert.ok(parsed.text.includes(emoji), 'emoji must survive exactly');
  assert.ok(parsed.text.includes(supplementaryCf), 'supplementary Cf must survive exactly');

  // A boundary-aligned fixture so the per-boundary surrogate-pair check in
  // assertRoundTrip is exercised rather than vacuous: the real owner keeps the
  // high/low escapes of one U+E0001 as a single token, so no boundary can fall
  // between them even here.
  const alignedText = 'A'.repeat(1601) + supplementaryCf.repeat(3) + 'B'.repeat(300);
  const aligned = plannedRoomParts(input({ text: alignedText }));
  assertPartShape(aligned.plan, aligned.result);
  assert.ok(aligned.result.parts.length >= 2, 'the aligned fixture must carry a segment boundary');
  assertRoundTrip(aligned.plan, aligned.result);
  const alignedSegments = segmentsOf(aligned.result);
  for (const segment of alignedSegments) assertNoLoneSurrogates(segment);
  assert.equal(alignedSegments.some(segment => segment.includes(supplementaryCf)), false,
    'supplementary Cf must be escaped in the aligned fixture');
  const alignedRebuilt = alignedSegments.join('');
  assert.ok(alignedRebuilt.includes('\\udb40\\udc01'),
    'the aligned fixture must contain the kept-together surrogate escape pair');
  assert.equal(JSON.parse(alignedRebuilt).text, alignedText, 'the aligned fixture must round-trip exactly');
});

test('room parts prevent payload code-fence breaks', () => {
  const text = 'fence ``` inside\n```json\n{"fake":true}\n```\n' +
    'inline `tick` and ````` and ' + '`'.repeat(50) + '\n';
  const source = input({ text });
  const { plan, result } = plannedRoomParts(source);

  assertPartShape(plan, result);
  assertRoundTrip(plan, result);

  for (const part of result.parts) {
    const segment = segmentOf(part.content);
    assert.equal(segment.includes('`'), false, 'no payload segment may contain a raw backtick');
    assert.equal(segment.includes('```'), false, 'no payload segment may contain a raw fence');
    assert.equal(part.content.split('```json\n').length - 1, 1, 'each part must carry exactly one opening fence');
    assert.ok(part.content.endsWith(CLOSE_FENCE), 'each part must carry exactly one closing fence');
  }
  const parsed = JSON.parse(rebuiltDocument(result));
  assert.equal(parsed.text, text, 'backtick payload text must survive exactly inside the code block');
  assert.ok(parsed.text.includes('```json'), 'the payload fence-like text must survive as data');
});

test('room parts obey the complete content budget', () => {
  const ascii = 'a'.repeat(10000);
  assert.equal(Buffer.byteLength(ascii, 'utf8'), 10000);
  const asciiFixture = input({ text: ascii });
  const asciiResult = plannedRoomParts(asciiFixture);
  assertPartShape(asciiResult.plan, asciiResult.result);
  assertRoundTrip(asciiResult.plan, asciiResult.result);
  assert.equal(JSON.parse(rebuiltDocument(asciiResult.result)).text, ascii);

  const multibyte = '\u00e9'.repeat(5000);
  assert.equal(Buffer.byteLength(multibyte, 'utf8'), 10000);
  const multibyteFixture = input({ text: multibyte });
  const multibyteResult = plannedRoomParts(multibyteFixture);
  assertPartShape(multibyteResult.plan, multibyteResult.result);
  assertRoundTrip(multibyteResult.plan, multibyteResult.result);

  const maxId = input({ broadcastId: 'B'.repeat(128), recipients: roster(3) });
  const maxIdResult = plannedRoomParts(maxId);
  assert.equal(maxIdResult.plan.broadcastId.length, 128);
  assertPartShape(maxIdResult.plan, maxIdResult.result);
  assertRoundTrip(maxIdResult.plan, maxIdResult.result);

  const pool = roster(700);
  for (const count of [1, 2, 5, 9, 17, 33, 64, 128, 256, 512, 700]) {
    const fixture = input({ recipients: pool.slice(0, count) });
    const { plan, result } = plannedRoomParts(fixture);
    assertPartShape(plan, result);
    assertRoundTrip(plan, result);
  }
});

test('room parts stabilize numbering across digit boundaries', () => {
  const pool = roster(1200);
  let underTen = 0;
  let underHundred = 0;
  let atTen = null;
  let atHundred = null;
  for (let count = 1; count <= pool.length; count += 1) {
    const fixture = input({ recipients: pool.slice(0, count) });
    const result = planTownHallRoomParts(fixture);
    const total = result.parts.length;
    if (atTen === null) {
      if (total >= 10) atTen = { count, total, under: underTen };
      else underTen = total;
    }
    if (atHundred === null) {
      if (total >= 100) {
        atHundred = { count, total, under: underHundred };
        break;
      }
      underHundred = total;
    }
  }
  assert.ok(atTen, 'a recipient count must reach at least ten parts');
  assert.ok(atHundred, 'a recipient count must reach at least one hundred parts');
  assert.equal(atTen.under, 9, 'numbering must pass through a nine-part total before ten');
  assert.equal(atHundred.under, 99, 'numbering must pass through a ninety-nine-part total before one hundred');

  for (const crossing of [atTen, atHundred]) {
    const fixture = input({ recipients: pool.slice(0, crossing.count) });
    const { plan, result } = plannedRoomParts(fixture);
    assert.equal(result.parts.length, crossing.total);
    assertPartShape(plan, result);
    assertRoundTrip(plan, result);
    assert.equal(result.parts[0].index, 1);
    assert.equal(result.parts[result.parts.length - 1].index, crossing.total);
    assert.equal(result.parts[result.parts.length - 1].total, crossing.total);
  }
});

test('room parts retain every recipient in a large finite roster', () => {
  const pool = roster(600);
  const source = input({ recipients: pool });
  const { plan, result } = plannedRoomParts(source);

  assert.equal(plan.recipients.length, 600);
  assertPartShape(plan, result);
  assertRoundTrip(plan, result);

  const parsed = JSON.parse(rebuiltDocument(result));
  assert.equal(parsed.recipients.length, 600);
  const expected = new Set(pool.map(entry => entry.nativeId));
  assert.equal(expected.size, 600);
  const seen = new Set();
  for (const recipient of plan.recipients) {
    assert.ok(expected.has(recipient.target.nativeId), 'no recipient may be dropped');
    seen.add(recipient.target.nativeId);
    const reconstructed = parsed.recipients.find(candidate => candidate.packetId === recipient.packetId);
    assert.ok(reconstructed, 'every packet id must survive the round trip');
    assert.deepEqual(reconstructed, recipient);
  }
  assert.equal(seen.size, 600);
  for (const entry of pool) {
    const match = plan.recipients.find(candidate => candidate.target.nativeId === entry.nativeId);
    assert.ok(match, 'every roster entry must be retained');
    assert.equal(match.target.provider, entry.provider);
    assert.equal(match.target.channelId, entry.channelId);
    assert.equal(match.target.generation, entry.generation);
  }
});

test('room parts are deterministic for canonical recipient order', () => {
  const pool = roster(300);
  const forward = plannedRoomParts(input({ recipients: pool }));
  const backward = plannedRoomParts(input({ recipients: [...pool].reverse() }));
  const rotated = plannedRoomParts(input({ recipients: [...pool.slice(100), ...pool.slice(0, 100)] }));

  assert.deepEqual(forward.result, backward.result);
  assert.deepEqual(forward.result, rotated.result);
  assert.deepEqual(forward.result.parts.map(part => part.content), backward.result.parts.map(part => part.content));
  assert.deepEqual(forward.result.parts.map(part => part.partId), rotated.result.parts.map(part => part.partId));
  assertPartShape(forward.plan, forward.result);
  assertRoundTrip(forward.plan, forward.result);
});

test('room part identities bind content and index', () => {
  const source = input({ recipients: roster(200) });
  const { plan, result } = plannedRoomParts(source);

  assert.equal(TOWN_HALL_ROOM_PARTS.VERSION, 1);
  assert.equal(TOWN_HALL_ROOM_PARTS.CONTENT_LIMIT, CONTENT_LIMIT);
  assert.equal(TOWN_HALL_ROOM_PARTS.ID_PREFIX, ID_PREFIX);
  assert.ok(Object.isFrozen(TOWN_HALL_ROOM_PARTS));

  const identities = new Set();
  for (const part of result.parts) {
    assert.equal(part.partId, expectedPartId(plan.fingerprint, part.index, part.total, part.content));
    identities.add(part.partId);
    const otherIndex = part.index === part.total ? part.index - 1 : part.index + 1;
    assert.notEqual(part.partId, expectedPartId(plan.fingerprint, otherIndex, part.total, part.content),
      'the part id must bind the one-based index');
    assert.notEqual(part.partId, expectedPartId(plan.fingerprint, part.index, part.total, part.content + 'x'),
      'the part id must bind the exact content');
  }
  assert.equal(identities.size, result.parts.length);
});

test('room part identities change with plan identity', () => {
  const base = input({ recipients: roster(50) });
  const baseParts = plannedRoomParts(base);
  const otherText = plannedRoomParts(input({ recipients: roster(50), text: 'different text' }));
  const otherBroadcast = plannedRoomParts(input({ recipients: roster(50), broadcastId: 'other-id' }));
  const otherRecipient = plannedRoomParts(input({
    recipients: roster(49).concat([address({ channelId: '399', nativeId: EXTRA_UUID })])
  }));

  assert.notEqual(baseParts.plan.fingerprint, otherText.plan.fingerprint);
  assert.notEqual(baseParts.plan.fingerprint, otherBroadcast.plan.fingerprint);
  assert.notEqual(baseParts.plan.fingerprint, otherRecipient.plan.fingerprint);

  for (const other of [otherText, otherBroadcast, otherRecipient]) {
    assertPartShape(other.plan, other.result);
    assertRoundTrip(other.plan, other.result);
    const baseIds = new Set(baseParts.result.parts.map(part => part.partId));
    for (const part of other.result.parts) {
      assert.equal(baseIds.has(part.partId), false,
        'a changed plan identity must flow into every part id');
      assert.equal(part.partId, expectedPartId(other.plan.fingerprint, part.index, part.total, part.content));
    }
  }
});

test('room parts freeze the plan array and records', () => {
  const source = input({
    recipients: [
      address({ channelId: '300' }),
      address({ channelId: '301', provider: 'claude', nativeId: CLAUDE_UUID, generation: 2 })
    ]
  });
  const { plan, result } = plannedRoomParts(source);

  assertFrozenResult(plan, result);
  assert.throws(() => { result.parts[0].content = 'tampered'; }, TypeError);
  assert.throws(() => { result.parts.push(result.parts[0]); }, TypeError);
  assert.throws(() => { plan.recipients[0].packetId = 'tampered'; }, TypeError);
  assert.throws(() => { plan.recipients[0].target.nativeId = EXTRA_UUID; }, TypeError);
  assert.equal(result.parts[0].content.length <= CONTENT_LIMIT, true);
});

test('room parts reuse planner rejection without reading accessors', () => {
  for (const root of [null, undefined, 'text', 42, []]) {
    assertSameRejection(() => root);
  }

  accessorCalls = 0;
  const rootAccessor = input();
  Object.defineProperty(rootAccessor, 'text', {
    get() {
      accessorCalls += 1;
      return 'hello';
    },
    enumerable: true,
    configurable: true
  });
  assertSameRejection(() => rootAccessor);
  assert.equal(accessorCalls, 0, 'root accessors must not run');

  accessorCalls = 0;
  const sourceAccessor = accessorAddress(address({ channelId: '200', nativeId: SOURCE_UUID }));
  assertSameRejection(() => input({ source: sourceAccessor }));
  assert.equal(accessorCalls, 0, 'source address accessors must not run');

  accessorCalls = 0;
  const recipientAccessor = accessorAddress(address({ channelId: '300' }));
  assertSameRejection(() => input({ recipients: [recipientAccessor] }));
  assert.equal(accessorCalls, 0, 'recipient address accessors must not run');

  accessorCalls = 0;
  const arrayAccessor = [];
  Object.defineProperty(arrayAccessor, '0', {
    get() {
      accessorCalls += 1;
      return address({ channelId: '300' });
    },
    enumerable: true,
    configurable: true
  });
  assert.equal(arrayAccessor.length, 1);
  assertSameRejection(() => input({ recipients: arrayAccessor }));
  assert.equal(accessorCalls, 0, 'audience array accessors must not run');

  const nested = input({ recipients: [address({ channelId: '300' })] });
  Object.defineProperty(nested, 'townHall', {
    get() {
      accessorCalls += 1;
      return { guildId: '100', channelId: '900' };
    },
    enumerable: true,
    configurable: true
  });
  accessorCalls = 0;
  assertSameRejection(() => nested);
  assert.equal(accessorCalls, 0, 'nested room accessors must not run');
});

test('room parts owner delegates validation to the canonical planner', () => {
  const source = ownerSource();
  assertOwnerSourcePinned(source);

  const callPattern = /planTownHallBroadcast\s*\(\s*input\s*\)/;
  assert.ok(callPattern.test(source), 'the owner must call the canonical planner with the bare input');

  function rejection(sourceText) {
    try {
      assertOwnerSourcePinned(sourceText);
    } catch (error) {
      return error;
    }
    return null;
  }

  const localValidator = source +
    '\nfunction localRoomValidator(input: unknown): boolean {\n' +
    '  return typeof input === "object" && input !== null && input["text"] !== undefined;\n' +
    '}\n';
  const validatorError = rejection(localValidator);
  assert.ok(validatorError, 'a newly added local validator must be rejected');
  assert.match(validatorError.message, /raw input read/);

  const rawRead = source.replace(callPattern, match => match + ';\nconst rawText = input.text');
  assert.notEqual(rawRead, source);
  const rawReadError = rejection(rawRead);
  assert.ok(rawReadError, 'a raw input.text read must be rejected');
  assert.match(rawReadError.message, /raw input read/);

  for (const read of [
    'const rawText = (input as { text: string }).text',
    'const { text } = input',
    'const keys = Object.keys(input)',
    'const alias = input; const rawText = alias.text',
    'const rawText = arguments[0].text'
  ]) {
    const mutant = source.replace(callPattern, match => match + ';\n' + read);
    assert.notEqual(mutant, source);
    const error = rejection(mutant);
    assert.ok(error, 'every alternate raw-input read must be rejected');
    assert.match(error.message, /raw input read/);
  }

  const secondCall = source.replace(callPattern, match => match + ';\nconst extraPlan = planTownHallBroadcast(input)');
  assert.notEqual(secondCall, source);
  const secondCallError = rejection(secondCall);
  assert.ok(secondCallError, 'a second planner call must be rejected');

  const bannedLabel = source + '\nconst validAddress = (value: unknown): boolean => true;\n';
  const labelError = rejection(bannedLabel);
  assert.ok(labelError, 'a copied planner validation label must be rejected');
  assert.match(labelError.message, /planner validation constants/);
});

test('room parts suite and type contracts are registered once', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const tokens = pkg.scripts.test.trim().split(/\s+/);
  assert.equal(tokens.filter(entry => entry === TEST_RELATIVE).length, 1, 'the suite must be registered exactly once');

  const base = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'tsconfig.json'), 'utf8'));
  assert.equal(base.include.filter(entry => entry === OWNER_RELATIVE).length, 1, 'tsconfig include must list the owner once');
  assert.equal(base.include.filter(entry => entry === TYPE_FIXTURE_RELATIVE).length, 0, 'tsconfig include must not list the type fixture');

  const types = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'tsconfig.typecheck.json'), 'utf8'));
  assert.equal(types.include.filter(entry => entry === OWNER_RELATIVE).length, 1, 'typecheck include must list the owner once');
  assert.equal(types.include.filter(entry => entry === TYPE_FIXTURE_RELATIVE).length, 1, 'typecheck include must list the fixture once');

  const fixture = fs.readFileSync(path.join(PROJECT_ROOT, TYPE_FIXTURE_RELATIVE), 'utf8');
  assert.equal((fixture.match(/@ts-expect-error/g) || []).length, 7, 'the type fixture must pin exactly seven errors');
  assert.equal(/\bany\b|@ts-ignore|@ts-nocheck/.test(fixture), false, 'the type fixture must not use an escape hatch');
});
