'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

const {
  TOWN_HALL_ROOM_MARKER,
  validateTownHallRoomIdentity
} = require('../dist/peer/town-hall-room-identity');

const BASELINE = 'b377aa8a018cb7b4d7365d1e1e030c7bb3ac54b5';
const PROJECT_ROOT = path.join(__dirname, '..');
const OWNER_RELATIVE = 'src/peer/town-hall-room-identity.ts';
const TYPE_FIXTURE_RELATIVE = 'test/types/town-hall-room-identity-types.ts';
const TEST_RELATIVE = 'test/town-hall-room-identity.test.js';
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

function baselineJson(relative) {
  const raw = execFileSync('git', ['show', `${BASELINE}:${relative}`], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8'
  });
  return JSON.parse(raw);
}

function isSubsequence(short, long) {
  let index = 0;
  for (const entry of long) {
    if (index < short.length && entry === short[index]) index += 1;
  }
  return index === short.length;
}

// Runs `load` while every require of '../agent-message' made from the built owner
// resolves to a fake module whose ownDataProperty is replaced. This isolates the
// shared-owner sentinel without touching the shipped source.
function withStubbedOwnDataProperty(stub, load) {
  const real = require(AGENT_MESSAGE_BUILT);
  const originalLoad = Module._load;
  const savedOwner = require.cache[OWNER_BUILT];
  delete require.cache[OWNER_BUILT];
  Module._load = function mockedLoad(request, parent, isMain) {
    if (parent && parent.filename === OWNER_BUILT) {
      let resolved = null;
      try { resolved = Module._resolveFilename(request, parent, isMain); } catch { resolved = null; }
      if (resolved === AGENT_MESSAGE_BUILT) return { ...real, ownDataProperty: stub };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return load();
  } finally {
    Module._load = originalLoad;
    delete require.cache[OWNER_BUILT];
    if (savedOwner) require.cache[OWNER_BUILT] = savedOwner;
  }
}

test('1 valid marker alone is accepted', () => {
  assert.equal(TOWN_HALL_ROOM_MARKER, '[discord-surface:town-hall:v1]');
  assert.equal(validateTownHallRoomIdentity(response(), room()), true);
  assert.equal(validateTownHallRoomIdentity(response({ topic: TOWN_HALL_ROOM_MARKER }), room()), true);
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

test('14 isolated shared-owner sentinel plus registration assertions', () => {
  const validResponse = response();
  const validRoom = room();

  const forcedFalse = withStubbedOwnDataProperty(() => false, () => {
    return ownerRequire()(validResponse, validRoom);
  });
  assert.equal(forcedFalse, false,
    'stubbing the shared ownDataProperty owner to false must refuse an otherwise valid room');

  // The real ownDataProperty rejects inherited required fields; a stub that
  // always returns true lets the same response through, proving the owner
  // consults the shared helper rather than a private classifier.
  const inherited = Object.create(response());
  assert.equal(ownerRequire()(inherited, validRoom), false,
    'the real shared owner must refuse inherited required fields');
  const forcedTrue = withStubbedOwnDataProperty(() => true, () => {
    return ownerRequire()(inherited, validRoom);
  });
  assert.equal(forcedTrue, true,
    'the stubbed true owner must accept the inherited response, proving the stub is wired');

  assert.equal(ownerRequire()(validResponse, validRoom), true,
    'restoring the shared owner must accept the valid room again');

  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const tokens = pkg.scripts.test.trim().split(/\s+/);
  const baselineTokens = baselineJson('package.json').scripts.test.trim().split(/\s+/);
  assert.equal(baselineTokens.length, 180, 'baseline npm test token count must be 180');
  assert.equal(tokens.length, 181, 'npm test must gain exactly one token');
  assert.deepEqual(tokens.slice(0, baselineTokens.length), baselineTokens,
    'every baseline npm test token and its relative order must be preserved');
  assert.equal(tokens[tokens.length - 1], TEST_RELATIVE, 'the new suite must be appended last');
  assert.equal(tokens.filter(entry => entry === TEST_RELATIVE).length, 1,
    'the new suite must be registered exactly once');

  const tsconfig = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'tsconfig.json'), 'utf8'));
  const baselineTsconfig = baselineJson('tsconfig.json');
  assert.equal(baselineTsconfig.include.length, 112, 'baseline tsconfig include must have 112 entries');
  assert.equal(tsconfig.include.length, 113, 'tsconfig include must gain exactly one entry');
  assert.equal(new Set(tsconfig.include).size, tsconfig.include.length, 'tsconfig include must have no duplicates');
  assert.ok(isSubsequence(baselineTsconfig.include, tsconfig.include),
    'every baseline tsconfig include entry must be preserved in order');
  assert.equal(tsconfig.include.filter(entry => entry === OWNER_RELATIVE).length, 1,
    'tsconfig must list the TypeScript owner once');
  assert.equal(tsconfig.include.filter(entry => entry === TYPE_FIXTURE_RELATIVE).length, 0,
    'tsconfig must not list the type-test fixture');

  const typecheck = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'tsconfig.typecheck.json'), 'utf8'));
  const baselineTypecheck = baselineJson('tsconfig.typecheck.json');
  assert.equal(baselineTypecheck.include.length, 151, 'baseline typecheck include must have 151 entries');
  assert.equal(typecheck.include.length, 153, 'typecheck include must gain exactly two entries');
  assert.equal(new Set(typecheck.include).size, typecheck.include.length, 'typecheck include must have no duplicates');
  assert.ok(isSubsequence(baselineTypecheck.include, typecheck.include),
    'every baseline typecheck include entry must be preserved in order');
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
