'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isTownHallRoom, planTownHallBroadcast } = require('../dist/peer/town-hall-plan');
const { validateTownHallRoomIdentity, TOWN_HALL_ROOM_MARKER } = require('../dist/peer/town-hall-room-identity');

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const ROOM_CHANNEL = '333333333333333333';
const TARGET_CHANNEL = '444444444444444444';
const OTHER_GUILD = '555555555555555555';
const OTHER_CHANNEL = '666666666666666666';

function room(overrides = {}) {
  return { guildId: GUILD, channelId: CHANNEL, ...overrides };
}

function response(overrides = {}) {
  return {
    id: CHANNEL,
    guild_id: GUILD,
    type: 0,
    topic: TOWN_HALL_ROOM_MARKER,
    ...overrides
  };
}

function address(nativeId, channelId) {
  return {
    guildId: GUILD,
    channelId,
    provider: 'codex',
    nativeId,
    generation: 1
  };
}

function broadcastInput(overrides = {}) {
  return {
    broadcastId: 'guard_fixture',
    townHall: { guildId: GUILD, channelId: ROOM_CHANNEL },
    source: address('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CHANNEL),
    recipients: [address('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', TARGET_CHANNEL)],
    text: 'fixture',
    ...overrides
  };
}

function withInheritedValue(value, action) {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'value');
  try {
    Object.defineProperty(Object.prototype, 'value', {
      value,
      configurable: true,
      enumerable: false,
      writable: true
    });
    return action();
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'value', previous);
    else delete Object.prototype.value;
  }
}

function accessor(record, key, value) {
  let calls = 0;
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    get() {
      calls += 1;
      return value;
    }
  });
  return () => calls;
}

function descriptorMismatch(record, key, descriptorValue, observedValue) {
  return new Proxy(record, {
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (property !== key || !descriptor) return descriptor;
      return { ...descriptor, value: descriptorValue };
    },
    get(target, property, receiver) {
      if (property === key) return observedValue;
      return Reflect.get(target, property, receiver);
    }
  });
}

test('room identity consistency guards cover every observable field', () => {
  for (const [key, wrong, observed] of [
    ['guildId', OTHER_GUILD, GUILD],
    ['channelId', OTHER_CHANNEL, CHANNEL]
  ]) {
    assert.equal(isTownHallRoom(descriptorMismatch(room(), key, wrong, observed)), false, key);
  }

  for (const [key, wrong, observed, responseKey] of [
    ['channelId', OTHER_CHANNEL, CHANNEL, 'id'],
    ['guildId', OTHER_GUILD, GUILD, 'guild_id']
  ]) {
    const expected = descriptorMismatch(room(), key, wrong, observed);
    assert.equal(validateTownHallRoomIdentity(response({ [responseKey]: wrong }), expected), false, `expected.${key}`);
  }

  for (const [key, wrong, observed] of [
    ['id', OTHER_CHANNEL, CHANNEL],
    ['guild_id', OTHER_GUILD, GUILD],
    ['type', 1, 0],
    ['topic', 'unmarked', TOWN_HALL_ROOM_MARKER]
  ]) {
    assert.equal(
      validateTownHallRoomIdentity(descriptorMismatch(response(), key, wrong, observed), room()),
      false,
      `response.${key}`
    );
  }
});

test('room and identity validators reject inherited descriptor values for each field', () => {
  for (const [key, value] of [['guildId', GUILD], ['channelId', CHANNEL]]) {
    const candidate = room();
    const calls = accessor(candidate, key, value);
    withInheritedValue(value, () => {
      assert.equal(isTownHallRoom(candidate), false, `room.${key}`);
      assert.equal(calls(), 0, `room.${key} getter ran`);
    });
  }

  for (const [key, value] of [['channelId', CHANNEL], ['guildId', GUILD]]) {
    const expected = room();
    const calls = accessor(expected, key, value);
    withInheritedValue(value, () => {
      assert.equal(validateTownHallRoomIdentity(response(), expected), false, `expected.${key}`);
      assert.equal(calls(), 0, `expected.${key} getter ran`);
    });
  }

  for (const [key, value] of [
    ['id', CHANNEL],
    ['guild_id', GUILD],
    ['type', 0],
    ['topic', TOWN_HALL_ROOM_MARKER]
  ]) {
    const actual = response();
    const calls = accessor(actual, key, value);
    withInheritedValue(value, () => {
      assert.equal(validateTownHallRoomIdentity(actual, room()), false, `response.${key}`);
      assert.equal(calls(), 0, `response.${key} getter ran`);
    });
  }
});

test('planner requires own descriptor values for address fields and recipient elements', () => {
  const source = address('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CHANNEL);
  const sourceCalls = accessor(source, 'guildId', GUILD);
  withInheritedValue(GUILD, () => {
    assert.throws(() => planTownHallBroadcast(broadcastInput({ source })), /invalid town-hall broadcast plan/);
    assert.equal(sourceCalls(), 0);
  });

  const recipient = address('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', TARGET_CHANNEL);
  const recipients = [];
  let recipientGetterCalls = 0;
  Object.defineProperty(recipients, '0', {
    configurable: true,
    enumerable: true,
    get() {
      recipientGetterCalls += 1;
      return recipient;
    }
  });
  withInheritedValue(recipient, () => {
    assert.throws(() => planTownHallBroadcast(broadcastInput({ recipients })), /invalid town-hall broadcast plan/);
    assert.equal(recipientGetterCalls, 0);
  });
});
