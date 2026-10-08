'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const {
  TOWN_HALL_ROOM_MARKER,
  validateTownHallRoomIdentity
} = require('../dist/peer/town-hall-room-identity');
const { isTownHallRoom } = require('../dist/peer/town-hall-plan');

const PROJECT_ROOT = path.join(__dirname, '..');
const OWNER_RELATIVE = 'src/peer/town-hall-room-identity.ts';
const TYPE_FIXTURE_RELATIVE = 'test/types/town-hall-room-identity-types.ts';
const TEST_RELATIVE = 'test/town-hall-room-identity.test.js';
const POLICY_TEST_RELATIVE = 'test/town-hall-room-identity/policy-inventory.test.js';
const OWNER_BUILT = path.join(PROJECT_ROOT, 'dist/peer/town-hall-room-identity.js');
const AGENT_MESSAGE_BUILT = path.join(PROJECT_ROOT, 'dist/agent-message.js');

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const OTHER_GUILD = '333333333333333333';
const OTHER_CHANNEL = '444444444444444444';

// Synthetic Discord-shaped responses only; no observed Discord identifiers.
function room(overrides = {}) {
  return { guildId: GUILD, channelId: CHANNEL, ...overrides };
}

function response(overrides = {}) {
  return { id: CHANNEL, guild_id: GUILD, type: 0, topic: TOWN_HALL_ROOM_MARKER, ...overrides };
}

function ownerRequire() {
  return require(OWNER_BUILT).validateTownHallRoomIdentity;
}

test('1 valid marker alone is accepted', () => {
  assert.equal(TOWN_HALL_ROOM_MARKER, '[discord-surface:town-hall:v1]');
  assert.equal(validateTownHallRoomIdentity(response(), room()), true);
  assert.equal(validateTownHallRoomIdentity(response({ topic: TOWN_HALL_ROOM_MARKER }), room()), true);
});

test('revoked room proxies are refused without throwing', () => {
  const { proxy, revoke } = Proxy.revocable(room(), {});
  revoke();
  assert.doesNotThrow(() => isTownHallRoom(proxy));
  assert.equal(isTownHallRoom(proxy), false);
});

test('2 marker followed by whitespace and an explanation is accepted', () => {
  for (const suffix of [' ', '   ', '\n', '\n\nexplanation', '\t', '\twhy this room', ' \n\t']) {
    const topic = TOWN_HALL_ROOM_MARKER + suffix;
    assert.equal(validateTownHallRoomIdentity(response({ topic }), room()), true,
      `topic ${JSON.stringify(topic)} must be accepted`);
  }
});

test('3 extra Discord response fields are accepted and never read', () => {
  let extraReads = 0;
  const withExtras = response({ name: 'town-hall', parent_id: null, position: 3 });
  for (const key of ['last_message_id', 'permission_overwrites', 'nsfw']) {
    Object.defineProperty(withExtras, key, {
      get() { extraReads += 1; return 'unrelated'; },
      enumerable: true,
      configurable: true
    });
  }
  assert.deepEqual(Object.keys(withExtras).sort(), [
    'guild_id', 'id', 'last_message_id', 'name', 'nsfw', 'parent_id',
    'permission_overwrites', 'position', 'topic', 'type'
  ]);
  assert.equal(validateTownHallRoomIdentity(withExtras, room()), true);
  assert.equal(extraReads, 0, 'unrelated response getters must not run');
});

test('4 a response for the wrong channel is refused', () => {
  assert.equal(validateTownHallRoomIdentity(response({ id: OTHER_CHANNEL }), room()), false);
  assert.equal(validateTownHallRoomIdentity(response({ id: CHANNEL + '0' }), room()), false);
});

test('5 a response for the wrong guild is refused', () => {
  assert.equal(validateTownHallRoomIdentity(response({ guild_id: OTHER_GUILD }), room()), false);
  assert.equal(validateTownHallRoomIdentity(response({ guild_id: GUILD + '0' }), room()), false);
});

test('6 nonzero and string channel types are refused', () => {
  for (const type of [1, 2, 5, -1, '0', '1', null, true]) {
    assert.equal(validateTownHallRoomIdentity(response({ type }), room()), false,
      `type ${JSON.stringify(type)} must be refused`);
  }
});

test('7 a marker later in the topic or a leading-space topic is refused', () => {
  for (const topic of [
    'hello ' + TOWN_HALL_ROOM_MARKER,
    'Town hall ' + TOWN_HALL_ROOM_MARKER,
    'x' + TOWN_HALL_ROOM_MARKER + ' suffix',
    ' ' + TOWN_HALL_ROOM_MARKER,
    '\n' + TOWN_HALL_ROOM_MARKER,
    '[' + TOWN_HALL_ROOM_MARKER + ']'
  ]) {
    assert.equal(validateTownHallRoomIdentity(response({ topic }), room()), false,
      `topic ${JSON.stringify(topic)} must be refused`);
  }
});

test('8 a marker immediately followed by a non-whitespace suffix is refused', () => {
  for (const suffix of ['x', '[x', ']', '-extra', '\u200b', '0']) {
    assert.equal(validateTownHallRoomIdentity(response({ topic: TOWN_HALL_ROOM_MARKER + suffix }), room()), false,
      `suffix ${JSON.stringify(suffix)} must be refused`);
  }
});

test('9 missing, null and non-string topics are refused', () => {
  const missing = response();
  delete missing.topic;
  for (const topic of [undefined, null, 0, 42, true, {}, [], Symbol('topic')]) {
    assert.equal(validateTownHallRoomIdentity(response({ topic }), room()), false,
      `topic ${String(topic)} must be refused`);
  }
  assert.equal(validateTownHallRoomIdentity(missing, room()), false);
});

test('10 null, array and primitive responses are refused', () => {
  for (const value of [null, undefined, [], [response()], 'topic', 42, true, Symbol('response')]) {
    assert.equal(validateTownHallRoomIdentity(value, room()), false,
      `response ${String(value)} must be refused`);
  }
});

test('11 missing and inherited required response properties are refused', () => {
  for (const key of ['id', 'guild_id', 'type', 'topic']) {
    const missing = response();
    delete missing[key];
    assert.equal(validateTownHallRoomIdentity(missing, room()), false, `missing ${key} must be refused`);
  }

  const prototype = response();
  const inherited = Object.create(prototype);
  assert.equal(validateTownHallRoomIdentity(inherited, room()), false,
    'every required response property inherited from a prototype must be refused');
  for (const key of ['id', 'guild_id', 'type', 'topic']) {
    assert.equal(Object.hasOwn(inherited, key), false);
  }
});

test('12 an accessor in each required response field is refused without invoking it', () => {
  for (const key of ['id', 'guild_id', 'type', 'topic']) {
    let reads = 0;
    const accessor = response();
    delete accessor[key];
    Object.defineProperty(accessor, key, {
      get() { reads += 1; return response()[key]; },
      enumerable: true,
      configurable: true
    });
    assert.equal(validateTownHallRoomIdentity(accessor, room()), false,
      `accessor response.${key} must be refused`);
    assert.equal(reads, 0, `accessor response.${key} must not run`);
  }
});

test('13 accessor or absent expected fields are refused without getter calls, and frozen inputs stay unchanged', () => {
  for (const key of ['guildId', 'channelId']) {
    let reads = 0;
    const accessor = room();
    delete accessor[key];
    Object.defineProperty(accessor, key, {
      get() { reads += 1; return key === 'guildId' ? GUILD : CHANNEL; },
      enumerable: true,
      configurable: true
    });
    assert.equal(validateTownHallRoomIdentity(response(), accessor), false,
      `accessor expected.${key} must be refused`);
    assert.equal(reads, 0, `accessor expected.${key} must not run`);
  }

  for (const value of [{}, { guildId: GUILD }, { channelId: CHANNEL }, null, undefined, [], 'room']) {
    assert.equal(validateTownHallRoomIdentity(response(), value), false,
      `expected ${JSON.stringify(value)} must be refused`);
  }

  const frozenResponse = Object.freeze(response({ name: 'town-hall' }));
  const frozenRoom = Object.freeze(room());
  const responseBefore = JSON.stringify(frozenResponse);
  const roomBefore = JSON.stringify(frozenRoom);
  assert.equal(validateTownHallRoomIdentity(frozenResponse, frozenRoom), true);
  assert.ok(Object.isFrozen(frozenResponse));
  assert.ok(Object.isFrozen(frozenRoom));
  assert.equal(JSON.stringify(frozenResponse), responseBefore);
  assert.equal(JSON.stringify(frozenRoom), roomBefore);
});

test('expected proxy getters cannot replace validated descriptor values', () => {
  const expected = new Proxy(room(), {
    get(target, key) {
      if (key === 'guildId') return OTHER_GUILD;
      if (key === 'channelId') return OTHER_CHANNEL;
      return Reflect.get(target, key);
    }
  });
  assert.equal(validateTownHallRoomIdentity(response({
    guild_id: OTHER_GUILD,
    id: OTHER_CHANNEL
  }), expected), false);
});

test('expected proxy reads must match the validated descriptors', () => {
  const expected = new Proxy(room(), {
    get(target, key, receiver) {
      if (key === 'guildId') return OTHER_GUILD;
      if (key === 'channelId') return OTHER_CHANNEL;
      return Reflect.get(target, key, receiver);
    }
  });
  assert.equal(validateTownHallRoomIdentity(response(), expected), false);
});

test('response proxy getters cannot replace validated descriptor values', () => {
  const actual = new Proxy(response({ id: OTHER_CHANNEL, guild_id: OTHER_GUILD }), {
    get(target, key) {
      if (key === 'id') return CHANNEL;
      if (key === 'guild_id') return GUILD;
      return Reflect.get(target, key);
    }
  });
  assert.equal(validateTownHallRoomIdentity(actual, room()), false);
});

test('response proxy reads that diverge from data descriptors are refused', () => {
  const mismatches = {
    id: OTHER_CHANNEL,
    guild_id: OTHER_GUILD,
    type: 1,
    topic: 'not a town-hall marker',
  };
  for (const [key, value] of Object.entries(mismatches)) {
    const actual = new Proxy(response(), {
      get(target, property, receiver) {
        return property === key ? value : Reflect.get(target, property, receiver);
      },
    });
    assert.equal(validateTownHallRoomIdentity(actual, room()), false,
      `observable response.${key} must match its data descriptor`);
  }
});

test('expected proxy descriptors are snapshotted before room validation', () => {
  const calls = { guildId: 0, channelId: 0 };
  const expected = new Proxy(room(), {
    getOwnPropertyDescriptor(target, key) {
      if (key !== 'guildId' && key !== 'channelId') return Reflect.getOwnPropertyDescriptor(target, key);
      calls[key] += 1;
      const valid = key === 'guildId' ? GUILD : CHANNEL;
      const malformed = key === 'guildId' ? 'not-a-guild' : 'not-a-channel';
      return {
        value: calls[key] >= 3 ? valid : malformed,
        writable: true,
        enumerable: true,
        configurable: true
      };
    }
  });
  assert.equal(validateTownHallRoomIdentity(response({ id: 'not-a-channel', guild_id: 'not-a-guild' }), expected), false);
});

test('identity validation reads each required proxy descriptor once', () => {
  const forgeAfterFirstRead = (target, replacements, calls) => new Proxy(target, {
    getOwnPropertyDescriptor(actual, key) {
      if (!Object.hasOwn(replacements, key)) return Reflect.getOwnPropertyDescriptor(actual, key);
      calls[key] = (calls[key] || 0) + 1;
      const descriptor = Reflect.getOwnPropertyDescriptor(actual, key);
      return calls[key] === 1 ? descriptor : { ...descriptor, value: replacements[key] };
    }
  });

  const expectedCalls = {};
  const expected = forgeAfterFirstRead(
    room({ guildId: OTHER_GUILD, channelId: OTHER_CHANNEL }),
    { guildId: GUILD, channelId: CHANNEL },
    expectedCalls
  );
  assert.equal(validateTownHallRoomIdentity(response(), expected), false);
  assert.deepEqual(expectedCalls, { channelId: 1, guildId: 1 });

  const responseCalls = {};
  const actual = forgeAfterFirstRead(
    response({ id: OTHER_CHANNEL, guild_id: OTHER_GUILD, type: 1, topic: 'other room' }),
    { id: CHANNEL, guild_id: GUILD, type: 0, topic: TOWN_HALL_ROOM_MARKER },
    responseCalls
  );
  assert.equal(validateTownHallRoomIdentity(actual, room()), false);
  assert.deepEqual(responseCalls, { id: 1, guild_id: 1, type: 1, topic: 1 });
});

test('14 identity owner and test registration assertions', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const tokens = pkg.scripts.test.trim().split(/\s+/);
  assert.equal(tokens.filter(entry => entry === TEST_RELATIVE).length, 1,
    'the new suite must be registered exactly once');
  assert.equal(tokens.filter(entry => entry === POLICY_TEST_RELATIVE).length, 1,
    'the policy inventory companion must be registered exactly once');
  assert.equal(pkg.scripts['test:town-hall-room-policy'],
    'node --test --test-concurrency=1 test/town-hall-room-identity/policy-inventory.test.js test/town-hall-room-identity/policy-reference-analysis.test.js test/town-hall-room-identity/policy-inventory-regressions.test.js test/town-hall-room-identity/policy-reference-analysis-order.test.js');

  const tsconfig = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'tsconfig.json'), 'utf8'));
  assert.equal(tsconfig.include.filter(entry => entry === OWNER_RELATIVE).length, 1,
    'tsconfig must list the TypeScript owner once');
  assert.equal(tsconfig.include.filter(entry => entry === TYPE_FIXTURE_RELATIVE).length, 0,
    'tsconfig must not list the type-test fixture');

  const typecheck = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'tsconfig.typecheck.json'), 'utf8'));
  assert.equal(typecheck.include.filter(entry => entry === OWNER_RELATIVE).length, 1,
    'typecheck must list the TypeScript owner once');
  assert.equal(typecheck.include.filter(entry => entry === TYPE_FIXTURE_RELATIVE).length, 1,
    'typecheck must list the type-test fixture once');

  const fixture = fs.readFileSync(path.join(PROJECT_ROOT, TYPE_FIXTURE_RELATIVE), 'utf8');
  assert.ok((fixture.match(/@ts-expect-error/g) || []).length >= 1,
    'the type fixture must pin at least one expected error');
  assert.equal(/\bany\b|@ts-ignore|@ts-nocheck/.test(fixture), false,
    'the type fixture must not use an escape hatch');
});


test('matching malformed room identifiers are refused at both boundaries', () => {
  const { planTownHallBroadcast } = require('../dist/peer/town-hall-plan');
  for (const key of ['guildId', 'channelId']) {
    for (const value of ['', 7, null, undefined, 'abc', '1'.repeat(21), '99999999999999999999', '1\n', '1\r', '1\u2028', '1\u2029']) {
      const expected = room({ [key]: value });
      assert.equal(require('../dist/peer/town-hall-plan').isTownHallRoom(expected), false);
      const actual = response({ [key === 'guildId' ? 'guild_id' : 'id']: value });
      assert.equal(validateTownHallRoomIdentity(actual, expected), false);
      assert.throws(() => planTownHallBroadcast({
        broadcastId: 'invalid_room', townHall: expected,
        source: { guildId: expected.guildId, channelId: OTHER_CHANNEL, provider: 'codex', nativeId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', generation: 1 },
        recipients: [{ guildId: expected.guildId, channelId: OTHER_CHANNEL, provider: 'codex', nativeId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', generation: 1 }], text: 'fixture'
      }));
    }
  }
});

test('room guard rejects accessor descriptors with inherited value fields', () => {
  const { isTownHallRoom } = require('../dist/peer/town-hall-plan');
  const accessorRoom = {};
  for (const [key, value] of [['guildId', GUILD], ['channelId', CHANNEL]]) {
    Object.defineProperty(accessorRoom, key, {
      get() { return { value }; },
      configurable: true,
      enumerable: true
    });
  }
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'value');
  Object.defineProperty(Object.prototype, 'value', {
    value: GUILD,
    configurable: true,
    enumerable: false,
    writable: true
  });
  try {
    assert.equal(isTownHallRoom(accessorRoom), false);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'value', previous);
    else delete Object.prototype.value;
  }
});

test('room guard rejects proxy reads that diverge from valid descriptors', () => {
  const { isTownHallRoom } = require('../dist/peer/town-hall-plan');
  const proxy = new Proxy(room(), {
    get(target, key, receiver) {
      if (key === 'guildId') return 7;
      if (key === 'channelId') return OTHER_CHANNEL;
      return Reflect.get(target, key, receiver);
    }
  });
  assert.equal(isTownHallRoom(proxy), false);
});

test('room identifier length boundaries preserve valid matches', () => {
  const { planTownHallBroadcast } = require('../dist/peer/town-hall-plan');
  for (const id of ['0', '1'.repeat(20), '18446744073709551615']) {
    assert.equal(validateTownHallRoomIdentity(response({ id, guild_id: id }), room({ channelId: id, guildId: id })), true);
    assert.doesNotThrow(() => planTownHallBroadcast({ broadcastId: 'valid_room', townHall: room({ guildId: id, channelId: id }), source: { guildId: id, channelId: OTHER_CHANNEL, provider: 'codex', nativeId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', generation: 1 }, recipients: [{ guildId: id, channelId: OTHER_CHANNEL, provider: 'codex', nativeId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', generation: 1 }], text: 'fixture' }));
  }
});

test('response validator uses the shared room identity owner', () => {
  const planBuilt = path.join(PROJECT_ROOT, 'dist/peer/town-hall-plan.js');
  const real = require(planBuilt);
  const originalLoad = Module._load;
  const savedOwner = require.cache[OWNER_BUILT];
  delete require.cache[OWNER_BUILT];
  let calls = 0;
  Module._load = function(request, parent, isMain) {
    if (parent?.filename === OWNER_BUILT && Module._resolveFilename(request, parent, isMain) === planBuilt) {
      return { ...real, isTownHallRoom() { calls += 1; return false; } };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    assert.equal(ownerRequire()(response(), room()), false);
    assert.equal(calls, 1);
  } finally {
    Module._load = originalLoad;
    delete require.cache[OWNER_BUILT];
    if (savedOwner) require.cache[OWNER_BUILT] = savedOwner;
  }
  assert.equal(ownerRequire()(response(), room()), true);
});
