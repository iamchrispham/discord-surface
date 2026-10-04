'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const {
  TOWN_HALL_ROOM_MARKER,
  validateTownHallRoomIdentity
} = require('../dist/peer/town-hall-room-identity');

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
  assert.equal(tokens.filter(entry => entry === TEST_RELATIVE).length, 1,
    'the new suite must be registered exactly once');

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
    for (const value of ['', 7, null, undefined, 'abc', '1'.repeat(21), '1\n', '1\r', '1\u2028', '1\u2029']) {
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

test('room identifier length boundaries preserve valid matches', () => {
  const { planTownHallBroadcast } = require('../dist/peer/town-hall-plan');
  for (const id of ['0', '1'.repeat(20)]) {
    assert.equal(validateTownHallRoomIdentity(response({ id, guild_id: id }), room({ channelId: id, guildId: id })), true);
    assert.doesNotThrow(() => planTownHallBroadcast({ broadcastId: 'valid_room', townHall: room({ guildId: id, channelId: id }), source: { guildId: id, channelId: OTHER_CHANNEL, provider: 'codex', nativeId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', generation: 1 }, recipients: [{ guildId: id, channelId: OTHER_CHANNEL, provider: 'codex', nativeId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', generation: 1 }], text: 'fixture' }));
  }
});


function isRoomField(node) {
  if (!ts.isPropertyAccessExpression(node) || !['guildId', 'channelId'].includes(node.name.text)) {
    return false;
  }
  return ts.isIdentifier(node.expression) && /^(?:room|townHall|townHallRoom)$/i.test(node.expression.text);
}

function regexInput(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name.text === 'test' && parent.expression === current &&
        ts.isCallExpression(parent.parent)) {
      return parent.parent.arguments[0] || null;
    }
    current = parent;
  }
  return null;
}

function enclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return null;
}

function hasRoomFieldAlias(scope, subject, sourceFile) {
  if (!ts.isIdentifier(subject)) return false;
  let found = false;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === subject.text &&
        node.initializer && isRoomField(node.initializer)) {
      found = true;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) && node.left.text === subject.text && isRoomField(node.right)) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope || sourceFile);
  return found;
}

function hasSplitRoomLengthBound(scope, subject, sourceFile) {
  const subjectText = subject.getText(sourceFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\W)${subjectText}\\s*\\.\\s*length\\s*(?:<=\\s*20|<\\s*21)(?:\\W|$)`).test(
    (scope || sourceFile).getText(sourceFile)
  );
}

function hasRoomFieldCall(scope, sourceFile) {
  const name = scope?.name && ts.isIdentifier(scope.name) ? scope.name.text : null;
  if (!name) return false;
  let found = false;
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name &&
        node.arguments.length === 1 && isRoomField(node.arguments[0])) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function isSplitRoomDigitPolicy(node, sourceFile, pattern) {
  if (!/(?:\\[dD]|\[0-9\])(?:\+|\{1,\})/.test(pattern)) return false;
  const subject = regexInput(node);
  if (!subject) return false;
  const scope = enclosingFunction(node) || sourceFile;
  const roomSubject = isRoomField(subject) || hasRoomFieldAlias(scope, subject, sourceFile) || hasRoomFieldCall(scope, sourceFile);
  return roomSubject && hasSplitRoomLengthBound(scope, subject, sourceFile);
}

function roomDigitPolicies(records) {
  const sites = {};
  for (const { file, text } of records) {
    const roomContext = /TownHallRoom|\b(?:validate|copy|is)\w*Room\w*\b/.test(text) || /town-hall/.test(file);
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const numeric = /\\[dD]|\[(?:\^)?0-9\]/;
    const boundedId = /(?:\\d|\[0-9\])\{1,20\}/;
    const visit = node => {
      let pattern = null;
      if (ts.isRegularExpressionLiteral(node)) pattern = node.text;
      else if ((ts.isNewExpression(node) || ts.isCallExpression(node)) &&
          ts.isIdentifier(node.expression) && node.expression.text === 'RegExp' &&
          node.arguments?.length && ts.isStringLiteralLike(node.arguments[0])) {
        pattern = node.arguments[0].text;
      }
      if (pattern !== null && numeric.test(pattern) &&
          (roomContext || boundedId.test(pattern) || isSplitRoomDigitPolicy(node, ast, pattern))) {
        sites[file] = (sites[file] || 0) + 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return sites;
}

test('room ID policy has exactly two consumers and the response uses the shared owner', () => {
  const src = path.join(PROJECT_ROOT, 'src');
  const references = {};
  const records = [];
  for (const relative of fs.readdirSync(src, { recursive: true })) {
    if (!/\.(?:ts|js)$/.test(relative)) continue;
    const text = fs.readFileSync(path.join(src, relative), 'utf8');
    records.push({ file: relative.split(path.sep).join('/'), text });
    const count = (text.match(/\bisTownHallRoom\b/g) || []).length;
    if (count) references[relative.split(path.sep).join('/')] = count;
  }
  assert.deepEqual(references, { 'peer/town-hall-plan.ts': 2, 'peer/town-hall-room-identity.ts': 2 });
  const expectedPolicies = { 'agent-attachment.ts': 2, 'agent-message.ts': 3, 'reply-context.ts': 1, 'peer/town-hall-plan.ts': 2 };
  assert.deepEqual(roomDigitPolicies(records), expectedPolicies);
  const inline = { file: 'peer/future-room.ts', text: String.raw`function validateRoom(room) { return /^\d{1,20}$/.test(room.guildId); }` };
  assert.notDeepEqual(roomDigitPolicies([...records, inline]), expectedPolicies);
  const constructor = { file: 'peer/future-room.ts', text: String.raw`function validateRoom(room) { return new RegExp('^[0-9]{1,21}$').test(room.guildId); }` };
  assert.notDeepEqual(roomDigitPolicies([...records, constructor]), expectedPolicies);
  const directCall = { file: 'peer/future-room.ts', text: String.raw`function validateRoom(room) { return RegExp('^[0-9]{1,21}$').test(room.channelId); }` };
  assert.notDeepEqual(roomDigitPolicies([...records, directCall]), expectedPolicies);
  const splitNeutral = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(room) {
    return /^\d+$/.test(room.guildId) && room.guildId.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, splitNeutral]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1
  });
  const splitAlias = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(room) {
    const value = room.channelId;
    return /^\d+$/.test(value) && value.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, splitAlias]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1
  });
  const splitCall = { file: 'peer/snowflake.ts', text: String.raw`function isSnowflake(value) {
    return /^\d+$/.test(value) && value.length <= 20;
  }
  function inspect(room) { return isSnowflake(room.guildId); }` };
  assert.deepEqual(roomDigitPolicies([...records, splitCall]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1
  });
  const emptySplit = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(room) {
    return /^\d*$/.test(room.guildId) && room.guildId.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, emptySplit]), expectedPolicies);
  const ordinarySplit = { file: 'peer/snowflake.ts', text: String.raw`function validateSnowflake(value) {
    return /^\d+$/.test(value) && value.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, ordinarySplit]), expectedPolicies);
  const ordinaryFieldSplit = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(user) {
    return /^\d+$/.test(user.guildId) && user.guildId.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, ordinaryFieldSplit]), expectedPolicies);
  const ordinaryCall = { file: 'peer/snowflake.ts', text: String.raw`function isSnowflake(value) {
    return /^\d+$/.test(value) && value.length <= 20;
  }
  function inspect(user) { return isSnowflake(user.guildId); }` };
  assert.deepEqual(roomDigitPolicies([...records, ordinaryCall]), expectedPolicies);
  const copied = records.map(record => record.file === 'peer/town-hall-room-identity.ts'
    ? { ...record, text: record.text + inline.text } : record);
  assert.notDeepEqual(roomDigitPolicies(copied), expectedPolicies);

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
