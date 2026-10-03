'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  encodeTownHallChild,
  decodeTownHallChild,
  validateTownHallChild,
  TOWN_HALL_CHILD_CONTRACT
} = require('../src/town-hall-child.js');
const { planTownHallBroadcast } = require('../dist/peer/town-hall-plan');
const {
  AGENT_MESSAGE_MAX_ENCODED_LENGTH,
  encodeAgentMessage,
  decodeAgentMessage
} = require('../src/agent-message');

const TOKEN = 'town-hall-child-disposable-credential';
const ORDINARY_DOMAIN = 'discord-tether/agent-message/v1';

const PACKET_ERROR = 'invalid town-hall child packet';
const CREDENTIAL_ERROR = 'town-hall child credential unavailable';
const LIMIT_ERROR = 'town-hall child exceeds attachment limit';
const ENCODING_ERROR = 'invalid town-hall child encoding';
const SIGNATURE_ERROR = 'invalid town-hall child signature';
const TARGET_ERROR = 'town-hall child target is stale or mismatched';

const ROOT = path.resolve(__dirname, '..');

const SOURCE_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const THIRD_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const SOURCE = Object.freeze({
  guildId: '100', channelId: '200', provider: 'claude', nativeId: SOURCE_UUID, generation: 3
});
const TARGET = Object.freeze({
  guildId: '100', channelId: '300', provider: 'claude', nativeId: TARGET_UUID, generation: 4
});
const ROOM = Object.freeze({ guildId: '100', channelId: '900' });
const JOURNAL_KEY = 'b'.repeat(64);
const PLAN_FINGERPRINT = 'c'.repeat(64);
const ROOM_MESSAGE_ID = '12345678901234567890';

function address(overrides = {}) {
  return { ...SOURCE, ...overrides };
}

function validPacket(overrides = {}) {
  return {
    id: `townhall_${'a'.repeat(64)}`,
    kind: 'request',
    source: { ...SOURCE },
    target: { ...TARGET },
    replyTo: null,
    routingVersion: 2,
    text: 'child instruction text',
    purpose: 'town-hall-child/v1',
    broadcastId: 'broadcast-1',
    journalKey: JOURNAL_KEY,
    planFingerprint: PLAN_FINGERPRINT,
    room: { ...ROOM },
    roomMessageId: ROOM_MESSAGE_ID,
    ...overrides
  };
}

function planInput(overrides = {}) {
  return {
    broadcastId: 'broadcast-1',
    townHall: { ...ROOM },
    source: { ...SOURCE },
    recipients: [{ ...TARGET }],
    text: 'child instruction text',
    ...overrides
  };
}

function childFromPlan(plan, index = 0, overrides = {}) {
  const recipient = plan.recipients[index];
  return {
    id: recipient.packetId,
    kind: 'request',
    source: { ...plan.source },
    target: { ...recipient.target },
    replyTo: null,
    routingVersion: 2,
    text: plan.text,
    purpose: 'town-hall-child/v1',
    broadcastId: plan.broadcastId,
    journalKey: JOURNAL_KEY,
    planFingerprint: plan.fingerprint,
    room: { ...plan.townHall },
    roomMessageId: ROOM_MESSAGE_ID,
    ...overrides
  };
}

function decodeTarget(packet) {
  return { ...packet.target };
}

function childSigningKey(token = TOKEN) {
  return crypto.createHmac('sha256', token).update(TOWN_HALL_CHILD_CONTRACT.DOMAIN).digest();
}

function signBody(body, token = TOKEN) {
  return crypto.createHmac('sha256', childSigningKey(token)).update(body).digest('base64url');
}

function wireOf(body, mac) {
  return `${TOWN_HALL_CHILD_CONTRACT.PREFIX}${body}.${mac}`;
}

function signJson(value, token = TOKEN) {
  const body = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return wireOf(body, signBody(body, token));
}

function wireParts(wire) {
  const rest = wire.slice(TOWN_HALL_CHILD_CONTRACT.PREFIX.length);
  const dot = rest.indexOf('.');
  return { body: rest.slice(0, dot), mac: rest.slice(dot + 1) };
}

function expectError(run, message) {
  assert.throws(run, error => {
    assert.equal(error.message, message, `expected ${JSON.stringify(message)}, received ${JSON.stringify(error.message)}`);
    return true;
  });
}

function expectOneOfErrors(run, messages) {
  assert.throws(run, error => {
    assert.ok(messages.includes(error.message), `unexpected error ${JSON.stringify(error.message)}`);
    return true;
  });
}

function replacedWithAccessor(base, key, mode) {
  let calls = 0;
  const copy = {};
  for (const name of Object.keys(base)) {
    if (name !== key) copy[name] = base[name];
  }
  Object.defineProperty(copy, key, {
    enumerable: true,
    configurable: true,
    get() {
      calls += 1;
      if (mode === 'throwing') throw new Error(`unexpected read of ${key}`);
      return calls === 1 ? base[key] : null;
    }
  });
  return { value: copy, calls: () => calls };
}

function nestedWithAccessor(rootName, key, mode) {
  const packet = validPacket();
  const base = packet[rootName];
  let calls = 0;
  const copy = {};
  for (const name of Object.keys(base)) {
    if (name !== key) copy[name] = base[name];
  }
  Object.defineProperty(copy, key, {
    enumerable: true,
    configurable: true,
    get() {
      calls += 1;
      if (mode === 'throwing') throw new Error(`unexpected read of ${rootName}.${key}`);
      return calls === 1 ? base[key] : null;
    }
  });
  packet[rootName] = copy;
  return { packet, calls: () => calls };
}

test('planner-derived child round trips every signed field', () => {
  assert.deepEqual(Object.keys(TOWN_HALL_CHILD_CONTRACT).sort(), [
    'DOMAIN', 'MAX_ENCODED_LENGTH', 'MAX_TEXT_BYTES', 'PREFIX', 'PURPOSE', 'ROOT_FIELDS', 'ROUTING_VERSION'
  ]);
  assert.equal(TOWN_HALL_CHILD_CONTRACT.PREFIX, 'discord-tether:town-hall:v1:');
  assert.equal(TOWN_HALL_CHILD_CONTRACT.DOMAIN, 'discord-tether/town-hall-child/v1');
  assert.equal(TOWN_HALL_CHILD_CONTRACT.PURPOSE, 'town-hall-child/v1');
  assert.equal(TOWN_HALL_CHILD_CONTRACT.ROUTING_VERSION, 2);
  assert.equal(TOWN_HALL_CHILD_CONTRACT.MAX_TEXT_BYTES, 10000);
  assert.equal(TOWN_HALL_CHILD_CONTRACT.MAX_ENCODED_LENGTH, 81350);
  assert.ok(Object.isFrozen(TOWN_HALL_CHILD_CONTRACT));
  assert.ok(Object.isFrozen(TOWN_HALL_CHILD_CONTRACT.ROOT_FIELDS));
  assert.deepEqual([...TOWN_HALL_CHILD_CONTRACT.ROOT_FIELDS], [
    'id', 'kind', 'source', 'target', 'replyTo', 'routingVersion', 'text', 'purpose',
    'broadcastId', 'journalKey', 'planFingerprint', 'room', 'roomMessageId'
  ]);

  const plan = planTownHallBroadcast(planInput());
  assert.equal(plan.recipients.length, 1);
  const packet = childFromPlan(plan);

  assert.doesNotThrow(() => validateTownHallChild(packet));
  expectError(() => validateTownHallChild({ ...packet, text: ' ' }), PACKET_ERROR);
  expectError(() => validateTownHallChild(null), PACKET_ERROR);

  const wire = encodeTownHallChild(packet, TOKEN);
  assert.ok(wire.startsWith(TOWN_HALL_CHILD_CONTRACT.PREFIX));

  const decoded = decodeTownHallChild(wire, TOKEN, decodeTarget(packet));
  assert.ok(decoded !== null);
  assert.equal(decoded.id, plan.recipients[0].packetId);
  assert.equal(decoded.id, packet.id);
  assert.equal(decoded.kind, 'request');
  assert.deepEqual(decoded.source, { ...plan.source });
  assert.deepEqual(decoded.target, { ...plan.recipients[0].target });
  assert.equal(decoded.replyTo, null);
  assert.equal(decoded.routingVersion, 2);
  assert.equal(decoded.text, plan.text);
  assert.equal(decoded.purpose, 'town-hall-child/v1');
  assert.equal(decoded.broadcastId, plan.broadcastId);
  assert.equal(decoded.journalKey, JOURNAL_KEY);
  assert.equal(decoded.planFingerprint, plan.fingerprint);
  assert.deepEqual(decoded.room, { ...plan.townHall });
  assert.equal(decoded.roomMessageId, ROOM_MESSAGE_ID);
  assert.deepEqual(Object.keys(decoded), [...TOWN_HALL_CHILD_CONTRACT.ROOT_FIELDS]);

  assert.notEqual(decoded, packet);
  assert.notEqual(decoded.source, packet.source);
  assert.notEqual(decoded.target, packet.target);
  assert.notEqual(decoded.room, packet.room);
  packet.target.channelId = '999';
  packet.text = 'mutated caller text';
  assert.equal(decoded.target.channelId, TARGET.channelId);
  assert.equal(decoded.text, 'child instruction text');
});

test('canonical encoder ignores caller property order', () => {
  const canonical = validPacket();
  const shuffled = {
    roomMessageId: canonical.roomMessageId,
    room: { channelId: canonical.room.channelId, guildId: canonical.room.guildId },
    planFingerprint: canonical.planFingerprint,
    journalKey: canonical.journalKey,
    broadcastId: canonical.broadcastId,
    purpose: canonical.purpose,
    text: canonical.text,
    routingVersion: canonical.routingVersion,
    replyTo: canonical.replyTo,
    target: {
      generation: canonical.target.generation,
      nativeId: canonical.target.nativeId,
      provider: canonical.target.provider,
      channelId: canonical.target.channelId,
      guildId: canonical.target.guildId
    },
    source: {
      generation: canonical.source.generation,
      nativeId: canonical.source.nativeId,
      provider: canonical.source.provider,
      channelId: canonical.source.channelId,
      guildId: canonical.source.guildId
    },
    kind: canonical.kind,
    id: canonical.id
  };

  const canonicalWire = encodeTownHallChild(canonical, TOKEN);
  const shuffledWire = encodeTownHallChild(shuffled, TOKEN);
  assert.equal(shuffledWire, canonicalWire);

  const decoded = decodeTownHallChild(shuffledWire, TOKEN, { ...TARGET });
  assert.deepEqual(decoded, {
    id: canonical.id,
    kind: 'request',
    source: { ...SOURCE },
    target: { ...TARGET },
    replyTo: null,
    routingVersion: 2,
    text: canonical.text,
    purpose: 'town-hall-child/v1',
    broadcastId: canonical.broadcastId,
    journalKey: JOURNAL_KEY,
    planFingerprint: PLAN_FINGERPRINT,
    room: { ...ROOM },
    roomMessageId: ROOM_MESSAGE_ID
  });
  assert.deepEqual(Object.keys(decoded), [...TOWN_HALL_CHILD_CONTRACT.ROOT_FIELDS]);
  assert.deepEqual(Object.keys(decoded.source), ['guildId', 'channelId', 'provider', 'nativeId', 'generation']);
  assert.deepEqual(Object.keys(decoded.room), ['guildId', 'channelId']);

  const body = wireParts(canonicalWire).body;
  const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(parsed), [...TOWN_HALL_CHILD_CONTRACT.ROOT_FIELDS]);
});

test('every signed field mutation fails authentication', () => {
  const wire = encodeTownHallChild(validPacket(), TOKEN);
  const { body: originalBody, mac } = wireParts(wire);
  assert.equal(signBody(originalBody), mac);

  const mutations = [
    ['id', value => { value.id = `townhall_${'d'.repeat(64)}`; }],
    ['kind', value => { value.kind = 'result'; }],
    ['source', value => { value.source.channelId = '201'; }],
    ['target', value => { value.target.channelId = '301'; }],
    ['replyTo', value => { value.replyTo = 'reply-1'; }],
    ['routingVersion', value => { value.routingVersion = 1; }],
    ['text', value => { value.text = `${value.text} changed`; }],
    ['purpose', value => { value.purpose = 'town-hall-child/v2'; }],
    ['broadcastId', value => { value.broadcastId = `${value.broadcastId}x`; }],
    ['journalKey', value => { value.journalKey = 'd'.repeat(64); }],
    ['planFingerprint', value => { value.planFingerprint = 'e'.repeat(64); }],
    ['room', value => { value.room.channelId = '901'; }],
    ['roomMessageId', value => { value.roomMessageId = '9'.repeat(20); }]
  ];
  assert.equal(mutations.length, 13);

  for (const [field, mutate] of mutations) {
    const value = JSON.parse(Buffer.from(originalBody, 'base64url').toString('utf8'));
    mutate(value);
    const mutatedBody = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    assert.notEqual(mutatedBody, originalBody, `mutation of ${field} must change the wire body`);
    expectError(() => decodeTownHallChild(wireOf(mutatedBody, mac), TOKEN, { ...TARGET }), SIGNATURE_ERROR);
  }
});

test('child signing domain rejects ordinary agent signatures', () => {
  const wire = encodeTownHallChild(validPacket(), TOKEN);
  const { body, mac } = wireParts(wire);

  const ordinaryKey = crypto.createHmac('sha256', TOKEN).update(ORDINARY_DOMAIN).digest();
  const ordinaryMac = crypto.createHmac('sha256', ordinaryKey).update(body).digest('base64url');

  assert.notEqual(ordinaryMac, mac);
  expectError(() => decodeTownHallChild(wireOf(body, ordinaryMac), TOKEN, { ...TARGET }), SIGNATURE_ERROR);
  assert.equal(typeof encodeAgentMessage, 'function');
  assert.ok(wire.startsWith('discord-tether:town-hall:v1:'));
  assert.ok(!wire.startsWith('discord-tether:agent:v1:'));
});

test('generic agent message limit remains unchanged', () => {
  assert.equal(AGENT_MESSAGE_MAX_ENCODED_LENGTH, 2000);
  assert.equal(TOWN_HALL_CHILD_CONTRACT.MAX_ENCODED_LENGTH, 81350);

  const ordinary = {
    id: 'ordinary-1',
    kind: 'request',
    source: { guildId: '100', channelId: '101', provider: 'codex', nativeId: SOURCE_UUID, generation: 1 },
    target: { guildId: '100', channelId: '102', provider: 'claude', nativeId: TARGET_UUID, generation: 2 },
    replyTo: null,
    text: 'ordinary instruction'
  };
  const ordinaryWire = encodeAgentMessage(ordinary, TOKEN);
  assert.deepEqual(decodeAgentMessage(ordinaryWire, TOKEN, { ...ordinary.target }), ordinary);
  assert.throws(() => encodeAgentMessage({ ...ordinary, text: 'x'.repeat(2000) }, TOKEN),
    /encoded size \d+ characters, maximum 2000 characters/);

  const child = validPacket({ text: 'a'.repeat(1600) });
  const childWire = encodeTownHallChild(child, TOKEN);
  assert.ok(childWire.length > AGENT_MESSAGE_MAX_ENCODED_LENGTH);
  assert.equal(decodeTownHallChild(childWire, TOKEN, { ...TARGET }).id, child.id);
});

test('maximum NUL instruction fits exact attachment bound', () => {
  const maxGeneration = Number.MAX_SAFE_INTEGER;
  const guild = '9'.repeat(20);
  const roomChannel = '7'.repeat(20);
  const sourceChannel = '8'.repeat(20);
  const targetChannel = `${'8'.repeat(19)}6`;
  const text = '\u0000'.repeat(10000);
  const packet = {
    id: `townhall_${'a'.repeat(64)}`,
    kind: 'request',
    source: {
      guildId: guild, channelId: sourceChannel, provider: 'claude',
      nativeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', generation: maxGeneration
    },
    target: {
      guildId: guild, channelId: targetChannel, provider: 'claude',
      nativeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', generation: maxGeneration
    },
    replyTo: null,
    routingVersion: 2,
    text,
    purpose: 'town-hall-child/v1',
    broadcastId: 'x'.repeat(128),
    journalKey: 'b'.repeat(64),
    planFingerprint: 'c'.repeat(64),
    room: { guildId: guild, channelId: roomChannel },
    roomMessageId: '1'.repeat(20)
  };

  assert.equal(Buffer.byteLength(text, 'utf8'), 10000);
  assert.equal(Buffer.byteLength(JSON.stringify(packet), 'utf8'), 60958);

  const wire = encodeTownHallChild(packet, TOKEN);
  assert.equal(wire.length, 81350);
  assert.equal(wire.length, TOWN_HALL_CHILD_CONTRACT.MAX_ENCODED_LENGTH);

  const decoded = decodeTownHallChild(wire, TOKEN, { ...packet.target });
  assert.ok(decoded !== null);
  assert.equal(decoded.text.length, 10000);
  assert.equal(decoded.text, text);
  assert.equal(Buffer.compare(Buffer.from(decoded.text, 'utf8'), Buffer.from(text, 'utf8')), 0);
  assert.equal(decoded.id, packet.id);
  assert.equal(decoded.broadcastId, 'x'.repeat(128));
  assert.deepEqual(decoded.source, packet.source);
  assert.deepEqual(decoded.target, packet.target);
  assert.deepEqual(decoded.room, packet.room);
});

test('UTF-8 byte budget preserves multibyte text and rejects overflow', () => {
  const fill = (value, bytes) => {
    const count = bytes / Buffer.byteLength(value, 'utf8');
    assert.ok(Number.isInteger(count));
    return value.repeat(count);
  };

  for (const [unit, boundary] of [['é', 4000], ['é', 10000], ['😀', 10000]]) {
    const text = fill(unit, boundary);
    assert.equal(Buffer.byteLength(text, 'utf8'), boundary);
    const wire = encodeTownHallChild(validPacket({ text }), TOKEN);
    const decoded = decodeTownHallChild(wire, TOKEN, { ...TARGET });
    assert.equal(decoded.text, text);
    assert.equal(Buffer.compare(Buffer.from(decoded.text, 'utf8'), Buffer.from(text, 'utf8')), 0);
  }

  const asciiBoundary = 'a'.repeat(10000);
  assert.equal(Buffer.byteLength(asciiBoundary, 'utf8'), 10000);
  assert.equal(decodeTownHallChild(encodeTownHallChild(validPacket({ text: asciiBoundary }), TOKEN), TOKEN, { ...TARGET }).text, asciiBoundary);

  for (const overflow of ['a'.repeat(10001), `${fill('é', 10000)}a`, `${'😀'.repeat(2500)}a`]) {
    assert.ok(Buffer.byteLength(overflow, 'utf8') > 10000);
    expectError(() => encodeTownHallChild(validPacket({ text: overflow }), TOKEN), PACKET_ERROR);
  }
});

test('blank and noncanonical Unicode text refuse', () => {
  for (const text of ['', ' ', '\t\n', '\uD800', 'a\uDC00', '\uD800\uD800']) {
    expectError(() => encodeTownHallChild(validPacket({ text }), TOKEN), PACKET_ERROR);
  }
  for (const text of [42, null, undefined, true, {}, [], new String('boxed')]) {
    expectError(() => encodeTownHallChild(validPacket({ text }), TOKEN), PACKET_ERROR);
  }

  let coercions = 0;
  const coercible = {
    get [Symbol.toPrimitive]() { coercions += 1; throw new Error('unexpected text coercion'); },
    toString() { coercions += 1; return 'text'; },
    valueOf() { coercions += 1; return 'text'; }
  };
  expectError(() => encodeTownHallChild(validPacket({ text: coercible }), TOKEN), PACKET_ERROR);
  assert.equal(coercions, 0);

  const boxed = new String('boxed text');
  let boxedReads = 0;
  boxed.toString = () => { boxedReads += 1; return 'boxed text'; };
  expectError(() => encodeTownHallChild(validPacket({ text: boxed }), TOKEN), PACKET_ERROR);
  assert.equal(boxedReads, 0);

  const preserved = '  padded\n\ttext  ';
  const wire = encodeTownHallChild(validPacket({ text: preserved }), TOKEN);
  assert.equal(decodeTownHallChild(wire, TOKEN, { ...TARGET }).text, preserved);
});

test('required packet accessors refuse without reads', () => {
  for (const field of [...TOWN_HALL_CHILD_CONTRACT.ROOT_FIELDS]) {
    for (const mode of ['throwing', 'changing']) {
      const holder = replacedWithAccessor(validPacket(), field, mode);
      expectError(() => encodeTownHallChild(holder.value, TOKEN), PACKET_ERROR);
      assert.equal(holder.calls(), 0, `${mode} getter on ${field} must not be read`);
    }
  }

  let toJsonCalls = 0;
  const withToJson = validPacket();
  Object.defineProperty(withToJson, 'toJSON', {
    enumerable: false,
    configurable: true,
    get() { toJsonCalls += 1; throw new Error('unexpected toJSON read'); }
  });
  expectError(() => encodeTownHallChild(withToJson, TOKEN), PACKET_ERROR);
  assert.equal(toJsonCalls, 0);

  const withNonEnumerableExtra = validPacket();
  Object.defineProperty(withNonEnumerableExtra, 'extra', { value: true, enumerable: false, configurable: true });
  expectError(() => encodeTownHallChild(withNonEnumerableExtra, TOKEN), PACKET_ERROR);

  const withEnumerableExtra = { ...validPacket(), extra: true };
  expectError(() => encodeTownHallChild(withEnumerableExtra, TOKEN), PACKET_ERROR);

  const withSymbol = validPacket();
  withSymbol[Symbol('extra')] = true;
  expectError(() => encodeTownHallChild(withSymbol, TOKEN), PACKET_ERROR);

  const withHiddenSymbol = validPacket();
  Object.defineProperty(withHiddenSymbol, Symbol('hidden'), { value: true, enumerable: false, configurable: true });
  expectError(() => encodeTownHallChild(withHiddenSymbol, TOKEN), PACKET_ERROR);

  for (const value of [null, undefined, 42, 'text', [], new Date(0)]) {
    expectError(() => encodeTownHallChild(value, TOKEN), PACKET_ERROR);
  }
});

test('nested address and room accessors refuse without reads', () => {
  for (const [rootName, fields] of [
    ['source', ['guildId', 'channelId', 'provider', 'nativeId', 'generation']],
    ['target', ['guildId', 'channelId', 'provider', 'nativeId', 'generation']],
    ['room', ['guildId', 'channelId']]
  ]) {
    for (const field of fields) {
      for (const mode of ['throwing', 'changing']) {
        const holder = nestedWithAccessor(rootName, field, mode);
        expectError(() => encodeTownHallChild(holder.packet, TOKEN), PACKET_ERROR);
        assert.equal(holder.calls(), 0, `${mode} getter on ${rootName}.${field} must not be read`);
      }
    }
  }

  const arrayAddress = validPacket();
  arrayAddress.source = [SOURCE.guildId, SOURCE.channelId, SOURCE.provider, SOURCE.nativeId, SOURCE.generation];
  expectError(() => encodeTownHallChild(arrayAddress, TOKEN), PACKET_ERROR);

  const extraNested = validPacket();
  extraNested.target = { ...TARGET, extra: true };
  expectError(() => encodeTownHallChild(extraNested, TOKEN), PACKET_ERROR);

  const symbolNested = validPacket();
  symbolNested.room = { ...ROOM };
  symbolNested.room[Symbol('extra')] = true;
  expectError(() => encodeTownHallChild(symbolNested, TOKEN), PACKET_ERROR);

  for (const [rootName, value] of [['source', null], ['target', 42], ['room', 'text'], ['room', []]]) {
    const packet = validPacket();
    packet[rootName] = value;
    expectError(() => encodeTownHallChild(packet, TOKEN), PACKET_ERROR);
  }
});

test('extra inherited and malformed identity fields refuse', () => {
  const cases = [
    ['root array', () => []],
    ['root null', () => null],
    ['root missing id', () => { const value = validPacket(); delete value.id; return value; }],
    ['root inherited id', () => {
      const value = validPacket();
      const proto = { id: value.id };
      delete value.id;
      return Object.setPrototypeOf(value, proto);
    }],
    ['128-character generic id', () => validPacket({ id: 'a'.repeat(128) })],
    ['uppercase hex id', () => validPacket({ id: `townhall_${'A'.repeat(64)}` })],
    ['short id', () => validPacket({ id: `townhall_${'a'.repeat(63)}` })],
    ['extra id character', () => validPacket({ id: `townhall_${'a'.repeat(64)}a` })],
    ['kind result', () => validPacket({ kind: 'result' })],
    ['replyTo set', () => validPacket({ replyTo: 'reply-1' })],
    ['routingVersion 1', () => validPacket({ routingVersion: 1 })],
    ['routingVersion string', () => validPacket({ routingVersion: '2' })],
    ['purpose mismatch', () => validPacket({ purpose: 'other/v1' })],
    ['broadcast overbound', () => validPacket({ broadcastId: 'x'.repeat(129) })],
    ['broadcast blank', () => validPacket({ broadcastId: '' })],
    ['broadcast space', () => validPacket({ broadcastId: 'has space' })],
    ['journalKey overbound', () => validPacket({ journalKey: 'a'.repeat(65) })],
    ['journalKey short', () => validPacket({ journalKey: 'a'.repeat(63) })],
    ['journalKey uppercase', () => validPacket({ journalKey: 'A'.repeat(64) })],
    ['planFingerprint overbound', () => validPacket({ planFingerprint: 'a'.repeat(65) })],
    ['planFingerprint short', () => validPacket({ planFingerprint: 'a'.repeat(63) })],
    ['planFingerprint nonhex', () => validPacket({ planFingerprint: 'z'.repeat(64) })],
    ['roomMessageId overbound', () => validPacket({ roomMessageId: '1'.repeat(21) })],
    ['roomMessageId nonnumeric', () => validPacket({ roomMessageId: '1234567890123456789a' })],
    ['generation zero', () => validPacket({ target: { ...TARGET, generation: 0 } })],
    ['generation negative', () => validPacket({ source: { ...SOURCE, generation: -1 } })],
    ['generation fractional', () => validPacket({ target: { ...TARGET, generation: 1.5 } })],
    ['generation string', () => validPacket({ target: { ...TARGET, generation: '4' } })],
    ['generation unsafe', () => validPacket({ target: { ...TARGET, generation: Number.MAX_SAFE_INTEGER + 1 } })],
    ['self target exact', () => validPacket({ target: { ...SOURCE } })],
    ['self target uppercase nativeId', () => {
      assert.notEqual(SOURCE_UUID, SOURCE_UUID.toUpperCase(), 'fixture UUID must contain lowercase hex letters');
      assert.notEqual(TARGET_UUID, TARGET_UUID.toUpperCase(), 'fixture UUID must contain lowercase hex letters');
      return validPacket({ target: { ...TARGET, provider: SOURCE.provider, nativeId: SOURCE_UUID.toUpperCase() } });
    }],
    ['self target uppercase source nativeId', () => validPacket({ source: { ...SOURCE, nativeId: SOURCE_UUID.toUpperCase() }, target: { ...TARGET, provider: SOURCE.provider, nativeId: SOURCE_UUID } })],
    ['cross guild target', () => validPacket({ target: { ...TARGET, guildId: '101' } })],
    ['cross guild room', () => validPacket({ room: { ...ROOM, guildId: '101' } })],
    ['room hits source channel', () => validPacket({ room: { ...ROOM, channelId: SOURCE.channelId } })],
    ['room hits target channel', () => validPacket({ room: { ...ROOM, channelId: TARGET.channelId } })],
    ['room channel overbound', () => validPacket({ room: { ...ROOM, channelId: '1'.repeat(21) } })],
    ['room guild overbound', () => validPacket({ room: { ...ROOM, guildId: '1'.repeat(21) } })],
    ['room channel blank', () => validPacket({ room: { ...ROOM, channelId: '' } })],
    ['address extra field', () => validPacket({ source: { ...SOURCE, extra: true } })],
    ['address missing field', () => { const source = { ...SOURCE }; delete source.nativeId; return validPacket({ source }); }],
    ['address inherited required field', () => {
      const source = { channelId: SOURCE.channelId, provider: SOURCE.provider, nativeId: SOURCE.nativeId, generation: SOURCE.generation };
      return validPacket({ source: Object.setPrototypeOf(source, { guildId: SOURCE.guildId }) });
    }],
    ['address invalid provider', () => validPacket({ target: { ...TARGET, provider: 'other' } })],
    ['address non-uuid nativeId', () => validPacket({ target: { ...TARGET, nativeId: 'not-a-uuid' } })],
    ['address guild overbound', () => validPacket({ source: { ...SOURCE, guildId: '1'.repeat(21) } })],
    ['address channel overbound', () => validPacket({ source: { ...SOURCE, channelId: '1'.repeat(21) } })],
    ['room array', () => validPacket({ room: [] })],
    ['address array', () => validPacket({ target: [] })]
  ];

  for (const [label, build] of cases) {
    expectError(() => encodeTownHallChild(build(), TOKEN), PACKET_ERROR);
  }

  const valid = validPacket();
  assert.doesNotThrow(() => validateTownHallChild(valid));
});

test('malformed framing and noncanonical base64url refuse', () => {
  const wire = encodeTownHallChild(validPacket(), TOKEN);
  const { body, mac } = wireParts(wire);

  assert.equal(decodeTownHallChild(null, TOKEN, { ...TARGET }), null);
  assert.equal(decodeTownHallChild(undefined, TOKEN, { ...TARGET }), null);
  assert.equal(decodeTownHallChild(42, TOKEN, { ...TARGET }), null);
  assert.equal(decodeTownHallChild({}, TOKEN, { ...TARGET }), null);
  assert.equal(decodeTownHallChild('', TOKEN, { ...TARGET }), null);
  assert.equal(decodeTownHallChild('discord-tether:agent:v1:anything', TOKEN, { ...TARGET }), null);
  assert.equal(decodeTownHallChild('ordinary text without a prefix', TOKEN, { ...TARGET }), null);

  const header = TOWN_HALL_CHILD_CONTRACT.PREFIX;
  for (const malformed of [
    `${header}${body}${mac}`,
    `${header}${body}.${mac}.`,
    `${header}${body}.`,
    `${header}${body}.${mac.slice(0, 42)}`,
    `${header}${body}.${mac}A`,
    `${header}${body}=.${mac}`,
    `${header}${body}.${mac.slice(0, 42)}+`,
    `${header}${body}.${mac.slice(0, 42)}${mac[42] === '=' ? '_' : '='}`,
    `${header}`
  ]) {
    expectError(() => decodeTownHallChild(malformed, TOKEN, { ...TARGET }), ENCODING_ERROR);
  }

  expectOneOfErrors(() => decodeTownHallChild(`${header}${body}AA.${mac}`, TOKEN, { ...TARGET }), [ENCODING_ERROR, SIGNATURE_ERROR]);

  for (const noncanonicalBody of ['A', 'AAAAA', 'AB']) {
    const candidate = Buffer.from(noncanonicalBody, 'base64url').toString('base64url');
    assert.notEqual(candidate, noncanonicalBody, `${noncanonicalBody} must not be canonical base64url`);
    expectError(() => decodeTownHallChild(wireOf(noncanonicalBody, signBody(noncanonicalBody)), TOKEN, { ...TARGET }), ENCODING_ERROR);
  }

  let noncanonicalMac = null;
  for (const char of 'BCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_') {
    const candidate = mac.slice(0, 42) + char;
    if (Buffer.from(candidate, 'base64url').toString('base64url') !== candidate) {
      noncanonicalMac = candidate;
      break;
    }
  }
  assert.ok(noncanonicalMac, 'test requires a noncanonical 43-character signature candidate');
  expectOneOfErrors(() => decodeTownHallChild(wireOf(body, noncanonicalMac), TOKEN, { ...TARGET }), [ENCODING_ERROR, SIGNATURE_ERROR]);

  const base64url = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const sameBytesAlternative = encoded => {
    const bytes = Buffer.from(encoded, 'base64url');
    const index = base64url.indexOf(encoded[encoded.length - 1]);
    for (let offset = 1; offset < 16; offset += 1) {
      const candidate = encoded.slice(0, -1) + base64url[(index + offset) % 64];
      if (candidate !== encoded && Buffer.from(candidate, 'base64url').equals(bytes)) return candidate;
    }
    return null;
  };

  const noncanonicalBody = sameBytesAlternative(body);
  assert.ok(noncanonicalBody, 'test requires a noncanonical body spelling with identical bytes');
  assert.notEqual(noncanonicalBody, body);
  assert.ok(Buffer.from(noncanonicalBody, 'base64url').equals(Buffer.from(body, 'base64url')));
  assert.equal(signBody(body), mac);
  assert.notEqual(signBody(noncanonicalBody), mac);
  expectError(() => decodeTownHallChild(wireOf(noncanonicalBody, signBody(noncanonicalBody)), TOKEN, { ...TARGET }), ENCODING_ERROR);

  const noncanonicalSignature = sameBytesAlternative(mac);
  assert.ok(noncanonicalSignature, 'test requires a noncanonical signature spelling with identical bytes');
  assert.notEqual(noncanonicalSignature, mac);
  assert.ok(Buffer.from(noncanonicalSignature, 'base64url').equals(Buffer.from(mac, 'base64url')));
  expectOneOfErrors(() => decodeTownHallChild(wireOf(body, noncanonicalSignature), TOKEN, { ...TARGET }), [ENCODING_ERROR, SIGNATURE_ERROR]);

  expectError(() => encodeTownHallChild(validPacket(), ''), CREDENTIAL_ERROR);
  expectError(() => encodeTownHallChild(validPacket(), null), CREDENTIAL_ERROR);
  expectError(() => decodeTownHallChild(wire, '', { ...TARGET }), CREDENTIAL_ERROR);
  expectError(() => decodeTownHallChild(wire, null, { ...TARGET }), CREDENTIAL_ERROR);

  assert.equal(decodeTownHallChild('discord-tether:agent:v1:anything', '', { ...TARGET }), null);
  assert.equal(decodeTownHallChild('ordinary text', '', { ...TARGET }), null);

  const decoded = decodeTownHallChild(wire, TOKEN, { ...TARGET });
  assert.equal(decoded.id, validPacket().id);
});

test('signed invalid UTF-8 JSON and oversized wires refuse', () => {
  const malformedJson = Buffer.from('{"id":', 'utf8').toString('base64url');
  expectError(() => decodeTownHallChild(wireOf(malformedJson, signBody(malformedJson)), TOKEN, { ...TARGET }), ENCODING_ERROR);

  const validBodyBytes = Buffer.from(JSON.stringify(validPacket()), 'utf8');
  const corruptAt = validBodyBytes.indexOf(Buffer.from('child instruction', 'utf8'));
  assert.ok(corruptAt >= 0, 'test requires the packet text bytes in the signed body');
  const invalidUtf8Bytes = Buffer.concat([
    validBodyBytes.subarray(0, corruptAt),
    Buffer.from([0xff]),
    validBodyBytes.subarray(corruptAt + 1)
  ]);
  const invalidUtf8 = invalidUtf8Bytes.toString('base64url');
  const lossy = invalidUtf8Bytes.toString('utf8');
  assert.doesNotThrow(() => JSON.parse(lossy), 'lossy UTF-8 decode must still parse as JSON');
  assert.equal(JSON.parse(lossy).text.includes('\uFFFD'), true);
  assert.notEqual(Buffer.from(lossy, 'utf8').toString('base64url'), invalidUtf8,
    'signed body must fail a UTF-8 round trip');
  expectError(() => decodeTownHallChild(wireOf(invalidUtf8, signBody(invalidUtf8)), TOKEN, { ...TARGET }), ENCODING_ERROR);

  const wrongShape = Buffer.from('{"id":"x","kind":"request"}', 'utf8').toString('base64url');
  expectError(() => decodeTownHallChild(wireOf(wrongShape, signBody(wrongShape)), TOKEN, { ...TARGET }), PACKET_ERROR);

  const reorderedPacket = {};
  for (const key of [...TOWN_HALL_CHILD_CONTRACT.ROOT_FIELDS].reverse()) {
    reorderedPacket[key] = validPacket()[key];
  }
  assert.deepEqual(Object.keys(reorderedPacket), [...TOWN_HALL_CHILD_CONTRACT.ROOT_FIELDS].reverse());
  const reorderedWire = signJson(reorderedPacket);
  const reorderedDecoded = decodeTownHallChild(reorderedWire, TOKEN, { ...TARGET });
  assert.equal(reorderedDecoded.id, validPacket().id);
  assert.equal(reorderedDecoded.text, validPacket().text);

  const header = TOWN_HALL_CHILD_CONTRACT.PREFIX;
  const max = TOWN_HALL_CHILD_CONTRACT.MAX_ENCODED_LENGTH;
  const oversized = header + 'x'.repeat(max - header.length + 1);
  assert.equal(oversized.length, max + 1);
  expectError(() => decodeTownHallChild(oversized, TOKEN, { ...TARGET }), LIMIT_ERROR);
  expectError(() => decodeTownHallChild(oversized, '', { ...TARGET }), LIMIT_ERROR);

  const atBoundNoSeparator = header + 'x'.repeat(max - header.length);
  assert.equal(atBoundNoSeparator.length, max);
  expectError(() => decodeTownHallChild(atBoundNoSeparator, TOKEN, { ...TARGET }), ENCODING_ERROR);

  const atBoundBodyFirst = header + 'A'.repeat(max - header.length);
  expectError(() => decodeTownHallChild(atBoundBodyFirst, TOKEN, { ...TARGET }), ENCODING_ERROR);
});

test('stale target addresses refuse without returning a packet', () => {
  const packet = validPacket();
  const target = { ...TARGET };

  const variants = [
    ['channelId', validPacket({ target: { ...TARGET, channelId: '301' } })],
    ['provider', validPacket({ target: { ...TARGET, provider: 'codex' } })],
    ['nativeId', validPacket({ target: { ...TARGET, nativeId: THIRD_UUID } })],
    ['generation', validPacket({ target: { ...TARGET, generation: TARGET.generation + 1 } })],
    ['guildId', validPacket({
      source: { ...SOURCE, guildId: '101' },
      target: { ...TARGET, guildId: '101' },
      room: { ...ROOM, guildId: '101' }
    })]
  ];

  for (const [field, variant] of variants) {
    const wire = encodeTownHallChild(variant, TOKEN);
    let result;
    assert.throws(() => {
      result = decodeTownHallChild(wire, TOKEN, target);
    }, error => {
      assert.equal(error.message, TARGET_ERROR, `changed target.${field} must be stale`);
      return true;
    });
    assert.equal(result, undefined);
    assert.equal(decodeTownHallChild(wire, TOKEN, { ...variant.target }).id, packet.id, `variant ${field} must itself decode`);
  }

  const control = decodeTownHallChild(encodeTownHallChild(packet, TOKEN), TOKEN, target);
  assert.deepEqual(control.target, { ...TARGET });

  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const testTokens = String(packageJson.scripts.test).split(/\s+/);
  assert.equal(testTokens.filter(token => token === 'test/town-hall-child.test.js').length, 1,
    'test/town-hall-child.test.js must be registered exactly once in npm test');

  const tsconfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8'));
  assert.equal(tsconfig.include.filter(entry => entry === 'src/town-hall-child.ts').length, 1);
  assert.equal(tsconfig.include.filter(entry => entry === 'test/types/town-hall-child-types.ts').length, 0);

  const tsconfigTypecheck = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.typecheck.json'), 'utf8'));
  assert.equal(tsconfigTypecheck.include.filter(entry => entry === 'src/town-hall-child.ts').length, 1);
  assert.equal(tsconfigTypecheck.include.filter(entry => entry === 'test/types/town-hall-child-types.ts').length, 1);

  const fixture = fs.readFileSync(path.join(ROOT, 'test/types/town-hall-child-types.ts'), 'utf8');
  const markers = fixture.match(/@ts-expect-error/g) || [];
  assert.equal(markers.length, 6, 'type fixture must contain exactly six @ts-expect-error markers');
});
